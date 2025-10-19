/* ==== Константы геймплея ==== */
const SPAWN_RADIUS_M   = 150;   // радиус спавна вокруг игрока
const DESPAWN_RADIUS_M = 150;   // удаляем далеко ушедших
const BUY_RADIUS_M     = 75;    // покупка только ≤ 75 м
const BASE_RADIUS_M    = 50;    // радиус базы
const MAX_ALIVE        = 5;    // максимум «диких» рядом
const BASE_MOVE_COOLDOWN_MS = 60 * 60 * 1000; // перенос базы: 1 час

/* ==== Глобальное состояние ==== */
let map, playerMarker = null, avatarType = 'dot', avatarCustomUrl = null;
let baseCircle = null, basePos = null, lastBaseMoveAt = 0;
let money = 0, pending = 0, slotsMax = 8, owned = [];
let species = [];   // виды из manifest.json
let assets = {};    // { путь_в_zip : objectURL }
let creatures = []; // текущие «дикие»

/* ==== Ивент ==== */
// первые 15 минут каждого часа
function isEventActive(nowMs = Date.now()){
  const m = new Date(nowMs).getMinutes();
  return m < 15;
}
let lastEventState = null;
function applyEventVisuals(active){
  document.body.classList.toggle('event-active', !!active);
  for (const c of creatures){
    const el = c.marker && c.marker._icon;
    if (!el) continue;
    el.classList.toggle('event-roaming', !!active);
  }
}

/* ==== Утилиты ==== */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const toRad = d => d * Math.PI / 180, toDeg = r => r * 180 / Math.PI;
const now = () => Date.now();
function clamp(v,min,max){ return v<min?min:v>max?max:v; }
function fmtMoney(v){ return '₽ ' + (v|0).toLocaleString('ru-RU'); }
function toast(msg, ms=2000){
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  $('#toaster').appendChild(t); setTimeout(()=>t.remove(), ms);
}

function distanceMeters(aLat, aLon, bLat, bLon){
  const R=6371000, dLat=toRad(bLat-aLat), dLon=toRad(bLon-aLon);
  const la1=toRad(aLat), la2=toRad(bLat);
  const h=Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.min(1, Math.sqrt(h)));
}
function moveByMeters(lat,lon,meters,headingDeg){
  const R = 6371000, ang = meters / R, br = toRad(headingDeg);
  const la1 = toRad(lat), lo1 = toRad(lon);
  const la2 = Math.asin(Math.sin(la1)*Math.cos(ang) + Math.cos(la1)*Math.sin(ang)*Math.cos(br));
  const lo2 = lo1 + Math.atan2(Math.sin(br)*Math.sin(ang)*Math.cos(la1), Math.cos(ang)-Math.sin(la1)*Math.sin(la2));
  return [toDeg(la2), ((toDeg(lo2)+540)%360)-180];
}
function bearingTo(aLat,aLon,bLat,bLon){
  const la1=toRad(aLat), la2=toRad(bLat), dLon=toRad(bLon-aLon);
  const y=Math.sin(dLon)*Math.cos(la2);
  const x=Math.cos(la1)*Math.sin(la2)-Math.sin(la1)*Math.cos(la2)*Math.cos(dLon);
  let br=toDeg(Math.atan2(y,x)); if(br<0) br+=360; return br;
}

/* ==== Карта ==== */
function initMap(){
  map = L.map('map', { zoomControl: false });
  L.control.zoom({ position:'bottomright' }).addTo(map);

  // Тёмный слой + фолбэк на OSM FR
  const carto = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap, © CARTO'
  }).addTo(map);

  carto.on('tileerror', ()=>{
    L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
  });

  map.setView([0,0], 17);
}

/* ==== Игрок/аватар ==== */
let playerPos = null;
function playerIcon(){
  if (avatarCustomUrl) return L.icon({ iconUrl: avatarCustomUrl, iconSize:[42,42], iconAnchor:[21,21] });
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
  if (!playerMarker) playerMarker = L.marker([playerPos.lat, playerPos.lon], { icon: playerIcon(), zIndexOffset: 1000 }).addTo(map);
  else { playerMarker.setIcon(playerIcon()); playerMarker.setLatLng([playerPos.lat, playerPos.lon]); }
}
function recenter(){ if (playerPos) map.setView([playerPos.lat, playerPos.lon], clamp(map.getZoom(), 16, 18)); }

/* ==== База ==== */
function redrawBase(){
  if (baseCircle) map.removeLayer(baseCircle);
  if (!basePos) return;
  baseCircle = L.circle([basePos.lat, basePos.lon], { radius: BASE_RADIUS_M, color:'#19c37d', weight:2, fillColor:'#19c37d', fillOpacity:.12 }).addTo(map);
}
function canMoveBase(){ return !basePos || (now()-lastBaseMoveAt) >= BASE_MOVE_COOLDOWN_MS; }
function moveBaseHere(){
  if (!playerPos) return toast('Нет GPS');
  if (!canMoveBase()){
    const left = BASE_MOVE_COOLDOWN_MS-(now()-lastBaseMoveAt);
    return toast(`Перенос базы через ~${Math.ceil(left/60000)} мин`);
  }
  basePos = { ...playerPos }; lastBaseMoveAt = now();
  redrawBase(); saveState(); toast('База установлена/перенесена');
}

/* ==== Квадратные 56×56 иконки без искажений ==== */
async function makeSquare56(url){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    img.onload = ()=>{
      const size = 56;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d'); ctx.clearRect(0,0,size,size);
      const scale = Math.min(size/img.width, size/img.height);
      const w = Math.round(img.width*scale), h = Math.round(img.height*scale);
      const x = Math.floor((size-w)/2), y = Math.floor((size-h)/2);
      ctx.drawImage(img, x, y, w, h);
      canvas.toBlob(b=> resolve(URL.createObjectURL(b)), 'image/png');
    };
    img.onerror = ()=> reject(new Error('image load error'));
    img.crossOrigin = 'anonymous';
    img.src = url;
  });
}

/* ==== Контент (импорт ZIP) ==== */
async function importZip(file){
  try{
    const buf = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);

    assets = {}; species = [];

    for (const f of Object.values(zip.files)) {
      if (f.dir) continue;
      const lower = f.name.toLowerCase();

      // изображения — привели к квадрату 56×56
      if (/\.(png|jpg|jpeg|webp|gif)$/.test(lower)) {
        const blob = await f.async('blob');
        const rawUrl = URL.createObjectURL(blob);
        try {
          const squared = await makeSquare56(rawUrl);
          assets[f.name.replace(/\\/g,'/')] = squared;
        } finally {
          URL.revokeObjectURL(rawUrl);
        }
        continue;
      }

      // звуки
      if (/\.(mp3|ogg|wav)$/.test(lower)) {
        const blob = await f.async('blob');
        assets[f.name.replace(/\\/g,'/')] = URL.createObjectURL(blob);
        continue;
      }
    }

    const mf = zip.files['manifest.json'];
    if (!mf) return toast('В ZIP нет manifest.json');
    const data = JSON.parse(await mf.async('text'));
    species = data.species || [];
    toast(`Импортировано видов: ${species.length}`);
    saveState();
  }catch(e){
    console.error(e); toast('Ошибка импорта ZIP');
  }
}

/* ==== Иконка существа ==== */
function iconFor(sp){
  const url = sp.image && assets[sp.image] ? assets[sp.image] : null;
  if (url) return L.icon({ iconUrl: url, iconSize:[56,56], iconAnchor:[28,28], popupAnchor:[0,-28] });
  const svg = encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><rect x="8" y="8" width="40" height="40" rx="10" fill="#9b5cff"/></svg>`);
  return L.icon({ iconUrl:`data:image/svg+xml;utf8,${svg}`, iconSize:[56,56], iconAnchor:[28,28] });
}

/* ==== Спавн/движение ==== */
function pickSpecies(){
  const tot = species.reduce((s,sp)=> s + (sp.spawn_chance || 0), 0);
  if (tot <= 0) return null;
  let r = Math.random()*tot;
  for (const sp of species){ r -= (sp.spawn_chance||0); if (r<=0) return sp; }
  return species[species.length-1];
}
function randomAround(lat,lon,R){
  const rr = Math.sqrt(Math.random()) * R, ang = Math.random()*360;
  return moveByMeters(lat,lon,rr,ang);
}
function addCreature(lat,lon, sp){
  const id = crypto.randomUUID();
  const marker = L.marker([lat,lon], { icon: iconFor(sp) }).addTo(map);
  const c = { id, lat, lon, heading: Math.random()*360, speed: sp.speed_mps||1.5, species: sp, ownedInTransit:false, marker, boughtBoosted:false };
  marker.on('click', ()=> onCreatureTap(c));
  if (isEventActive()){ const el = marker._icon; if (el) el.classList.add('event-roaming'); }
  creatures.push(c);
}
function removeCreature(id){
  const i = creatures.findIndex(c=>c.id===id);
  if (i>=0){ creatures[i].marker.remove(); creatures.splice(i,1); }
}

function onCreatureTap(c){
  if (c.ownedInTransit) return;
  if (!playerPos) return toast('Нет GPS');

  const d = distanceMeters(c.lat,c.lon, playerPos.lat, playerPos.lon);
  if (d > BUY_RADIUS_M) return toast('Подойди ближе (≤ 15 м)');

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

  if (!confirm(`Купить?\n\n${msg}`)) return;
  if (!canBuy) return;

  money -= (c.species.price || 0);
  c.ownedInTransit = true;

  // покупка в ивент — ×2 навсегда и фиолетовый до прибытия
  if (isEventActive()){
    c.boughtBoosted = true;
    const el = c.marker && c.marker._icon; if (el) el.classList.add('event-roaming');
  }

  const snd = c.species.sound && assets[c.species.sound];
  if (snd) new Audio(snd).play().catch(()=>{});
  saveState(); updateHUD(); toast(`Куплен: ${c.species.name}`);
}

function tick(dt){
  // переключение визуала ивента
  const active = isEventActive();
  if (active !== lastEventState){ lastEventState = active; applyEventVisuals(active); }

  // спавним до MAX_ALIVE вокруг игрока
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

  // движение и проверки
  const remove = [];
  for (const c of creatures){
    if (c.ownedInTransit && basePos) c.heading = bearingTo(c.lat,c.lon, basePos.lat, basePos.lon);
    const [nla,nlo] = moveByMeters(c.lat,c.lon, c.speed*dt, c.heading);
    c.lat=nla; c.lon=nlo; c.marker.setLatLng([nla,nlo]);

    if (playerPos && !c.ownedInTransit && distanceMeters(nla,nlo, playerPos.lat, playerPos.lon) > DESPAWN_RADIUS_M)
      remove.push(c.id);

    if (c.ownedInTransit && basePos && distanceMeters(nla,nlo, basePos.lat, basePos.lon) <= BASE_RADIUS_M){
      if (owned.length < slotsMax){
        const baseIncome = c.species.income_per_sec || 0;
        const boosted = !!c.boughtBoosted;
        owned.push({ speciesId:c.species.id, name:c.species.name, incomePerSec: boosted? baseIncome*2 : baseIncome, boosted });
        remove.push(c.id);
        toast(`Прибыл: ${c.species.name}${boosted?' (×2)':''}`);
        saveState();
      } else {
        c.ownedInTransit = false;
      }
    }
  }
  remove.forEach(id=>removeCreature(id));

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
  $('#baseSlots').textContent = `${owned.length}/${slotsMax}`;
  $('#basePending').textContent = pending|0;

  if (!basePos) $('#cooldownInfo').textContent = 'База не установлена';
  else{
    const left = BASE_MOVE_COOLDOWN_MS - (now()-lastBaseMoveAt);
    $('#cooldownInfo').textContent = left>0 ? `Перенос через ~${Math.ceil(left/60000)} мин` : 'Можно переносить';
  }
}
function openSheet(id){ closeSheet('#sheetBase'); closeSheet('#sheetSettings'); document.querySelector(id).classList.add('open'); }
function closeSheet(id){ document.querySelector(id).classList.remove('open'); }

/* ==== База: действия ==== */
function collect(){
  if (!playerPos || !basePos) return toast('Нужна база');
  if (distanceMeters(playerPos.lat,playerPos.lon, basePos.lat,basePos.lon) > BASE_RADIUS_M) return toast('Подойди к базе');
  money += (pending|0); pending = 0; saveState(); updateHUD(); toast('Собрано');
}
function sellOne(){
  if (!playerPos || !basePos) return toast('Нужна база');
  if (distanceMeters(playerPos.lat,playerPos.lon, basePos.lat,basePos.lon) > BASE_RADIUS_M) return toast('Подойди к базе');
  if (!owned.length) return toast('Некого продавать');

  const list = owned.map((o,i)=> `${i}: ${o.name}${o.boosted?' (×2)':''}`).join('\n');
  const raw = prompt(`Кого продать?\n${list}\n(введи индекс)`, '0');
  if (raw === null) return;
  const idx = parseInt(raw,10);
  if (Number.isNaN(idx) || idx<0 || idx>=owned.length) return toast('Неверный индекс');
  const sold = owned.splice(idx,1)[0];
  const sp = species.find(s=>s.id===sold.speciesId);
  money += sp ? (sp.price||0) : 0;
  saveState(); updateHUD(); toast('Продан');
}
function refreshOwnedList(){
  const root = $('#ownedList'); root.innerHTML = '';
  owned.forEach((o,i)=>{
    const div = document.createElement('div');
    div.className = 'list-item';
    const badge = `<span class="badge ${o.boosted?'boost':''}">${o.boosted?'×2 • ':''}+${o.incomePerSec||0}/c</span>`;
    div.innerHTML = `<div><b>${o.name}</b></div><div>${badge}</div>`;
    root.appendChild(div);
  });
}

/* ==== Сохранение ==== */
function saveState(){
  const st = { v:4, money, pending, slotsMax, owned, basePos, lastBaseMoveAt, avatarType, avatarCustomUrl };
  localStorage.setItem('brainrot_state', JSON.stringify(st));
}
function loadState(){
  const raw = localStorage.getItem('brainrot_state');
  if (!raw){
    money=1000; pending=0; slotsMax=8; owned=[];
    basePos=null; lastBaseMoveAt=0; avatarType='dot'; avatarCustomUrl=null;
    saveState(); return;
  }
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
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = 'brainrot_save.json'; a.click(); URL.revokeObjectURL(url);
}
async function importSave(file){
  const txt = await file.text();
  localStorage.setItem('brainrot_state', txt);
  loadState(); redrawBase(); updatePlayerMarker(); updateHUD(); refreshOwnedList();
  toast('Сохранение импортировано');
}

/* ==== Геолокация ==== */
function startGeolocation(){
  if (!navigator.geolocation) return toast('Геолокация не поддерживается');
  navigator.geolocation.watchPosition(p=>{
    const { latitude:la, longitude:lo } = p.coords;
    playerPos = {lat:la, lon:lo}; updatePlayerMarker();
  }, e=>{ console.warn(e); toast('Разреши доступ к геолокации'); },
  { enableHighAccuracy:true, maximumAge:1000, timeout:10000 });
}

/* ==== Главный цикл ==== */
let lastTs = performance.now();
function loop(ts){
  const dt = Math.min(1, (ts-lastTs)/1000); lastTs = ts;
  tick(dt); requestAnimationFrame(loop);
}

/* ==== Инициализация ==== */
function bindUI(){
  $('#btnCenter').onclick = recenter;
  $('#btnSettings').onclick = ()=>{ updateHUD(); openSheet('#sheetSettings'); };
  $('#btnBaseMenu').onclick = ()=>{ refreshOwnedList(); openSheet('#sheetBase'); };
  $('#btnCloseBase').onclick = ()=> closeSheet('#sheetBase');
  $('#btnCloseSettings').onclick = ()=> closeSheet('#sheetSettings');

  $('#btnCollect').onclick = collect;
  $('#btnSell').onclick = sellOne;
  $('#btnMoveBase').onclick = moveBaseHere;

  // аватар
  $$('#sheetSettings .avatar-row .chip[data-avatar]').forEach(btn=>{
    btn.onclick = ()=>{ avatarType=btn.dataset.avatar; avatarCustomUrl=null; saveState(); updatePlayerMarker(); toast('Аватар изменён'); };
  });
  $('#btnAvatarUpload').onclick = ()=> $('#inputAvatar').click();
  $('#inputAvatar').onchange = e=>{
    const f = e.target.files[0]; if (!f) return;
    avatarCustomUrl = URL.createObjectURL(f); avatarType='custom';
    saveState(); updatePlayerMarker(); toast('Аватар загружен'); e.target.value='';
  };

  // ZIP
  $('#btnImportZip').onclick = ()=> $('#inputZip').click();
  $('#inputZip').onchange = e=>{ const f=e.target.files[0]; if (f) importZip(f).then(()=>toast('Контент обновлён')); e.target.value=''; };

  // сейвы
  $('#btnExportSave').onclick = exportSave;
  $('#btnImportSave').onclick = ()=> $('#inputSave').click();
  $('#inputSave').onchange = e=>{ const f=e.target.files[0]; if (f) importSave(f); e.target.value=''; };
}

window.addEventListener('load', ()=>{
  initMap(); loadState(); if (basePos) redrawBase();
  startGeolocation(); bindUI(); updateHUD(); recenter();
  lastEventState = isEventActive(); applyEventVisuals(lastEventState);
  requestAnimationFrame(loop);
});
