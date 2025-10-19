/* ==== Константы геймплея ==== */
const SPAWN_RADIUS_M   = 200;   // где спавним вокруг игрока
const DESPAWN_RADIUS_M = 300;   // где удаляем
const BUY_RADIUS_M     = 15;    // покупка только в 15 м
const BASE_RADIUS_M    = 50;    // радиус базы
const MAX_ALIVE        = 10;    // максимум существ рядом
const BASE_MOVE_COOLDOWN_MS = 60 * 60 * 1000; // 1 час

/* ==== Глобальное состояние ==== */
let map, playerMarker = null, avatarType = 'dot', avatarCustomUrl = null;
let baseCircle = null, basePos = null, lastBaseMoveAt = 0;
let money = 0, pending = 0, slotsMax = 8, owned = [];
let species = [];       // из manifest.json
let assets = {};        // {relPath: objectURL}
let creatures = [];     // спавн на карте

/* ==== Утилиты ==== */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
const now = () => Date.now();

function toast(msg, ms=2000){
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#toaster').appendChild(t);
  setTimeout(()=>{ t.remove(); }, ms);
}

function distanceMeters(aLat, aLon, bLat, bLon){
  const R=6371000, dLat=toRad(bLat-aLat), dLon=toRad(bLon-aLon);
  const la1=toRad(aLat), la2=toRad(bLat);
  const h=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.min(1, Math.sqrt(h)));
}
function moveByMeters(lat,lon,meters,headingDeg){
  const R=6371000, ang=meters/R, br=toRad(headingDeg), la1=toRad(lat), lo1=toRad(lon);
  const la2=Math.asin(Math.sin(la1)*cos(ang)+Math.cos(la1)*sin(ang)*Math.cos(br));
  const lo2=lo1+Math.atan2(Math.sin(br)*Math.sin(ang)*Math.cos(la1), Math.cos(ang)-Math.sin(la1)*Math.sin(la2));
  return [toDeg(la2), ((toDeg(lo2)+540)%360)-180];
}
function bearingTo(aLat,aLon,bLat,bLon){
  const la1=toRad(aLat), la2=toRad(bLat), dLon=toRad(bLon-aLon);
  const y=Math.sin(dLon)*Math.cos(la2);
  const x=Math.cos(la1)*Math.sin(la2)-Math.sin(la1)*Math.cos(la2)*Math.cos(dLon);
  let br=toDeg(Math.atan2(y,x)); if(br<0) br+=360; return br;
}
function clamp(v,min,max){ return v<min?min:v>max?max:v; }

function fmtMoney(v){ return '₽ ' + (v|0).toLocaleString('ru-RU'); }

/* ==== Карта ==== */
function initMap(){
  map = L.map('map', { zoomControl: false });
  L.control.zoom({ position:'bottomright' }).addTo(map);
  // Dark basemap
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap, © CARTO'
  }).addTo(map);
  map.setView([0,0], 17);
}

/* ==== Игрок/аватар ==== */
let playerPos = null;
function playerIcon(){
  if (avatarCustomUrl) {
    return L.icon({ iconUrl: avatarCustomUrl, iconSize:[42,42], iconAnchor:[21,21] });
  }
  // простые SVG-иконки для тёмной темы
  const svgByType = {
    dot:   `<circle cx="21" cy="21" r="9" fill="#19c37d"/>`,
    ring:  `<circle cx="21" cy="21" r="12" fill="none" stroke="#19c37d" stroke-width="3"/>`,
    arrow: `<path d="M21 6 L30 24 L21 20 L12 24 Z" fill="#19c37d"/>`
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="42" height="42">${svgByType[avatarType]||svgByType.dot}</svg>`;
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  return L.icon({ iconUrl:url, iconSize:[42,42], iconAnchor:[21,21] });
}
function updatePlayerMarker(){
  if (!playerPos) return;
  if (!playerMarker) {
    playerMarker = L.marker([playerPos.lat, playerPos.lon], { icon: playerIcon(), zIndexOffset: 1000 }).addTo(map);
  } else {
    playerMarker.setIcon(playerIcon());
    playerMarker.setLatLng([playerPos.lat, playerPos.lon]);
  }
}
function recenter(){ if (playerPos) map.setView([playerPos.lat, playerPos.lon], clamp(map.getZoom(), 16, 18)); }

/* ==== База ==== */
function redrawBase(){
  if (baseCircle) map.removeLayer(baseCircle);
  if (!basePos) return;
  baseCircle = L.circle([basePos.lat, basePos.lon], {
    radius: BASE_RADIUS_M, color: '#19c37d', weight: 2, fillColor: '#19c37d', fillOpacity: 0.12
  }).addTo(map);
}
function canMoveBase(){
  if (!basePos) return true;
  return (now() - lastBaseMoveAt) >= BASE_MOVE_COOLDOWN_MS;
}
function moveBaseHere(){
  if (!playerPos) { toast('Нет GPS'); return; }
  if (!canMoveBase()) {
    const left = BASE_MOVE_COOLDOWN_MS - (now() - lastBaseMoveAt);
    const mins = Math.ceil(left / 60000);
    toast(`Перенос базы через ~${mins} мин`);
    return;
  }
  basePos = { ...playerPos };
  lastBaseMoveAt = now();
  redrawBase(); saveState();
  toast('База установлена/перенесена');
}

/* ==== Контент ==== */
async function importZip(file){
  const buf = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);

  assets = {}; species = [];
  const entries = Object.values(zip.files);

  for (const f of entries) {
    if (f.dir) continue;
    const lower = f.name.toLowerCase();
    if (/\.(png|jpg|jpeg|webp|gif|mp3|ogg|wav)$/.test(lower)) {
      const blob = await f.async('blob');
      assets[f.name.replace(/\\/g,'/')] = URL.createObjectURL(blob);
    }
  }
  const mf = zip.files['manifest.json'];
  if (!mf) { toast('В ZIP нет manifest.json'); return; }
  const text = await mf.async('text');
  const data = JSON.parse(text);
  species = data.species || [];
  toast(`Импортировано видов: ${species.length}`);
  saveState();
}

/* ==== Иконки существ (единый размер) ==== */
function iconFor(sp){
  const url = sp.image && assets[sp.image] ? assets[sp.image] : null;
  if (url) return L.icon({ iconUrl: url, iconSize:[56,56], iconAnchor:[28,28], popupAnchor:[0,-28] });
  // дефолтная плашка, 56×56
  const svg = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><rect x="8" y="8" width="40" height="40" rx="10" fill="#9b5cff"/></svg>`);
  return L.icon({ iconUrl:`data:image/svg+xml;utf8,${svg}`, iconSize:[56,56], iconAnchor:[28,28] });
}

/* ==== Спавн/движение ==== */
function pickSpecies(){
  const tot = species.reduce((s,sp)=> s + (sp.spawn_chance || 0), 0);
  if (tot <= 0) return null;
  let r = Math.random() * tot;
  for (const sp of species) {
    r -= (sp.spawn_chance || 0);
    if (r <= 0) return sp;
  }
  return species[species.length - 1];
}
function randomAround(lat,lon,R){
  const rr = Math.sqrt(Math.random()) * R;
  const ang = Math.random() * 360;
  return moveByMeters(lat,lon,rr,ang);
}
function addCreature(lat,lon, sp){
  const id = crypto.randomUUID();
  const marker = L.marker([lat,lon], { icon: iconFor(sp) }).addTo(map);
  const c = { id, lat, lon, heading: Math.random()*360, speed: sp.speed_mps || 1.5, species: sp, ownedInTransit:false, marker };
  marker.on('click', ()=> onCreatureTap(c));
  creatures.push(c);
}
function removeCreature(id){
  const i = creatures.findIndex(c=>c.id===id);
  if (i>=0){ creatures[i].marker.remove(); creatures.splice(i,1); }
}

function onCreatureTap(c){
  if (c.ownedInTransit) return;
  if (!playerPos) { toast('Нет GPS'); return; }

  // Покупка только ≤ 15 м
  const d = distanceMeters(c.lat,c.lon, playerPos.lat, playerPos.lon);
  if (d > BUY_RADIUS_M) { toast('Подойди ближе (≤ 15 м)'); return; }

  const canBuy = basePos && owned.length < slotsMax && money >= (c.species.price || 0);
  const msg = [
    `Имя: ${c.species.name}`,
    `Цена: ${c.species.price||0}`,
    `Доход/сек: ${c.species.income_per_sec||0}`,
    `Скорость: ${(c.speed).toFixed(1)} м/с`,
    basePos ? '' : '(Сначала поставь базу)',
    owned.length>=slotsMax ? '(Нет свободных слотов)' : '',
    money < (c.species.price||0) ? '(Недостаточно денег)' : ''
  ].filter(Boolean).join('\n');

  if (confirm(`Купить?\n\n${msg}`)) {
    if (!canBuy) return;
    money -= (c.species.price || 0);
    c.ownedInTransit = true;
    // звук покупки (если есть)
    const snd = c.species.sound && assets[c.species.sound];
    if (snd) { new Audio(snd).play().catch(()=>{}); }
    saveState(); updateHUD();
    toast(`Куплен: ${c.species.name}`);
  }
}

function tick(dt){
  // спавн
  if (playerPos && species.length){
    const nearby = creatures.filter(c => distanceMeters(c.lat,c.lon, playerPos.lat, playerPos.lon) <= SPAWN_RADIUS_M).length;
    if (nearby < MAX_ALIVE){
      const need = MAX_ALIVE - nearby;
      for (let i=0;i<need;i++){
        const sp = pickSpecies(); if (!sp) break;
        const [la,lo] = randomAround(playerPos.lat, playerPos.lon, SPAWN_RADIUS_M*0.9);
        addCreature(la,lo,sp);
      }
    }
  }
  // движение
  const remove = [];
  for (const c of creatures){
    if (c.ownedInTransit && basePos) c.heading = bearingTo(c.lat,c.lon, basePos.lat, basePos.lon);
    const [nla,nlo] = moveByMeters(c.lat,c.lon, c.speed*dt, c.heading);
    c.lat = nla; c.lon = nlo; c.marker.setLatLng([nla,nlo]);

    // деспавн
    if (playerPos && !c.ownedInTransit && distanceMeters(nla,nlo, playerPos.lat, playerPos.lon) > DESPAWN_RADIUS_M)
      remove.push(c.id);

    // прибытие в базу
    if (c.ownedInTransit && basePos && distanceMeters(nla,nlo, basePos.lat, basePos.lon) <= BASE_RADIUS_M){
      if (owned.length < slotsMax){
        owned.push({ speciesId: c.species.id, name: c.species.name, incomePerSec: c.species.income_per_sec || 0 });
        remove.push(c.id);
        toast(`Прибыл: ${c.species.name}`);
        saveState();
      } else {
        c.ownedInTransit = false; // нет места — перестаём идти
      }
    }
  }
  remove.forEach(id => removeCreature(id));

  // доход
  let inc=0; for (const o of owned) inc += (o.incomePerSec||0) * dt;
  pending += Math.floor(inc);

  updateHUD();
}

/* ==== HUD / UI ==== */
function updateHUD(){
  $('#hudMoney').textContent = fmtMoney(money);
  $('#hudPending').textContent = '+' + (pending|0);
  $('#hudSlots').textContent = `${owned.length}/${slotsMax}`;

  // обновим базовую шторку
  $('#baseSlots').textContent = `${owned.length}/${slotsMax}`;
  $('#basePending').textContent = pending|0;

  // кулдаун базы
  if (!basePos) { $('#cooldownInfo').textContent = 'База не установлена'; }
  else {
    const left = BASE_MOVE_COOLDOWN_MS - (now()-lastBaseMoveAt);
    $('#cooldownInfo').textContent = left>0 ? `Перенос доступен через ~${Math.ceil(left/60000)} мин` : 'Можно переносить';
  }
}

function openSheet(id){ $(id).classList.add('open'); }
function closeSheet(id){ $(id).classList.remove('open'); }

/* ==== База: действия ==== */
function collect(){
  if (!playerPos || !basePos) { toast('Нужна база'); return; }
  const d = distanceMeters(playerPos.lat,playerPos.lon, basePos.lat,basePos.lon);
  if (d > BASE_RADIUS_M) { toast('Подойди к базе'); return; }
  money += (pending|0); pending = 0; saveState(); updateHUD(); toast('Собрано');
}
function sellOne(){
  if (!playerPos || !basePos) { toast('Нужна база'); return; }
  const d = distanceMeters(playerPos.lat,playerPos.lon, basePos.lat,basePos.lon);
  if (d > BASE_RADIUS_M) { toast('Подойди к базе'); return; }
  if (!owned.length){ toast('Некого продавать'); return; }

  // простой выбор через prompt с индексом
  const list = owned.map((o,i)=> `${i}: ${o.name}`).join('\n');
  const raw = prompt(`Кого продать?\n${list}\n(введи индекс)`, '0');
  if (raw === null) return;
  const idx = parseInt(raw,10);
  if (Number.isNaN(idx) || idx<0 || idx>=owned.length){ toast('Неверный индекс'); return; }
  const sold = owned.splice(idx,1)[0];
  const sp = species.find(s => s.id === sold.speciesId);
  const price = sp ? (sp.price || 0) : 0;
  money += price; saveState(); updateHUD(); toast(`Продан за ${price}`);
}

function refreshOwnedList(){
  const root = $('#ownedList'); root.innerHTML = '';
  owned.forEach((o,i)=>{
    const div = document.createElement('div');
    div.className = 'list-item';
    div.innerHTML = `<div><b>${o.name}</b></div><div class="badge">#${i} • +${o.incomePerSec||0}/c</div>`;
    root.appendChild(div);
  });
}

/* ==== Сохранение ==== */
function saveState(){
  const st = {
    v:2, money, pending, slotsMax, owned, basePos, lastBaseMoveAt, avatarType, avatarCustomUrl
  };
  localStorage.setItem('brainrot_state', JSON.stringify(st));
}
function loadState(){
  const raw = localStorage.getItem('brainrot_state'); if (!raw) return;
  try{
    const st = JSON.parse(raw);
    money=st.money||0; pending=st.pending||0; slotsMax=st.slotsMax||8; owned=st.owned||[];
    basePos=st.basePos||null; lastBaseMoveAt=st.lastBaseMoveAt||0;
    avatarType=st.avatarType||'dot'; avatarCustomUrl=st.avatarCustomUrl||null;
  }catch(e){}
}

/* ==== Экспорт/импорт прогресса ==== */
function exportSave(){
  const blob = new Blob([localStorage.getItem('brainrot_state')||'{}'], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'brainrot_save.json'; a.click();
  URL.revokeObjectURL(url);
}
async function importSave(file){
  const txt = await file.text();
  localStorage.setItem('brainrot_state', txt);
  loadState(); redrawBase(); updatePlayerMarker(); updateHUD(); refreshOwnedList();
  toast('Сохранение импортировано');
}

/* ==== Геолокация ==== */
function startGeolocation(){
  if (!navigator.geolocation){ toast('Геолокация не поддерживается'); return; }
  navigator.geolocation.watchPosition(pos=>{
    const { latitude:la, longitude:lo } = pos.coords;
    playerPos = {lat: la, lon: lo};
    updatePlayerMarker();
  }, err=>{
    console.warn(err);
    toast('Разреши доступ к геолокации в браузере');
  }, { enableHighAccuracy:true, maximumAge:1000, timeout:10000 });
}

/* ==== Главный цикл ==== */
let lastTs = performance.now();
function loop(ts){
  const dt = Math.min(1, (ts - lastTs)/1000); lastTs = ts;
  tick(dt);
  requestAnimationFrame(loop);
}

/* ==== Инициализация UI ==== */
function bindUI(){
  $('#btnCenter').onclick = recenter;
  $('#btnSettings').onclick = ()=> { updateHUD(); openSheet('#sheetSettings'); };
  $('#btnBaseMenu').onclick = ()=> { refreshOwnedList(); openSheet('#sheetBase'); };
  $('#btnCloseBase').onclick = ()=> closeSheet('#sheetBase');
  $('#btnCloseSettings').onclick = ()=> closeSheet('#sheetSettings');

  $('#btnCollect').onclick = collect;
  $('#btnSell').onclick = sellOne;

  $('#btnMoveBase').onclick = moveBaseHere;

  // аватар
  $$('#sheetSettings .avatar-row .chip[data-avatar]').forEach(btn=>{
    btn.onclick = ()=> { avatarType = btn.dataset.avatar; avatarCustomUrl=null; saveState(); updatePlayerMarker(); toast('Аватар изменён'); };
  });
  $('#btnAvatarUpload').onclick = ()=> $('#inputAvatar').click();
  $('#inputAvatar').onchange = e=>{
    const f = e.target.files[0]; if (!f) return;
    const url = URL.createObjectURL(f);
    avatarCustomUrl = url; avatarType = 'custom'; saveState(); updatePlayerMarker(); toast('Аватар загружен');
    e.target.value = '';
  };

  // импорт ZIP
  $('#btnImportZip').onclick = ()=> $('#inputZip').click();
  $('#inputZip').onchange = e=>{
    const f = e.target.files[0]; if (f) importZip(f).then(()=>toast('Контент обновлён'));
    e.target.value = '';
  };

  // экспорт/импорт сохранения
  $('#btnExportSave').onclick = exportSave;
  $('#btnImportSave').onclick = ()=> $('#inputSave').click();
  $('#inputSave').onchange = e=>{
    const f = e.target.files[0]; if (f) importSave(f);
    e.target.value = '';
  };
}

/* ==== Старт ==== */
window.addEventListener('load', ()=>{
  initMap();
  loadState();
  if (basePos) redrawBase();
  startGeolocation();
  bindUI();
  updateHUD();
  recenter();
  requestAnimationFrame(loop);
});
