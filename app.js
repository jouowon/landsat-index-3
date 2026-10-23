'use strict';
/* =====================================================================
 * Landsat 8·9 다중분광지수 분석 플랫폼
 *  1. 폴더 선택 → 2. 지수 선택 → 3. 밴드 불러오기 → 4. 분석 실행
 *  → 5. 임계값 분류 → 6. 폴리곤 영역 면적 통계
 * 모든 처리는 브라우저 안에서 이루어지며 파일은 외부로 전송되지 않습니다.
 * ===================================================================== */

// ─────────────────────────── 상수 ───────────────────────────
const BAND_INFO = {
  1: 'Coastal (연안/에어로졸)',
  2: 'Blue (청색)',
  3: 'Green (녹색)',
  4: 'Red (적색)',
  5: 'NIR (근적외)',
  6: 'SWIR1 (단파적외 1)',
  7: 'SWIR2 (단파적외 2)',
};

const ND = (a, b) => (a - b) / (a + b);

// bands: [밴드 A, 밴드 B] — 뷰어 왼쪽 위/아래에 표시
const INDICES = {
  NDVI:  { name: '정규식생지수',      bands: [5, 4], formula: '(NIR − Red) / (NIR + Red)',             thr: 0.3, hint: '식생 활력' },
  GNDVI: { name: '녹색 정규식생지수', bands: [5, 3], formula: '(NIR − Green) / (NIR + Green)',         thr: 0.3, hint: '엽록소 함량' },
  SAVI:  { name: '토양보정 식생지수', bands: [5, 4], formula: '1.5 × (NIR − Red) / (NIR + Red + 0.5)', thr: 0.2, hint: '저밀도 식생',
           fn: (a, b) => 1.5 * (a - b) / (a + b + 0.5) },
  NBR:   { name: '정규탄화지수',      bands: [5, 7], formula: '(NIR − SWIR2) / (NIR + SWIR2)',         thr: 0.1, hint: '산불 피해' },
  NDMI:  { name: '정규수분함량지수',  bands: [5, 6], formula: '(NIR − SWIR1) / (NIR + SWIR1)',         thr: 0.1, hint: '식생 수분' },
  NDWI:  { name: '정규수체지수',      bands: [3, 5], formula: '(Green − NIR) / (Green + NIR)',         thr: 0.0, hint: '수체' },
  MNDWI: { name: '수정 정규수체지수', bands: [3, 6], formula: '(Green − SWIR1) / (Green + SWIR1)',     thr: 0.0, hint: '수체 (도시 인접)' },
  NDBI:  { name: '정규시가화지수',    bands: [6, 5], formula: '(SWIR1 − NIR) / (SWIR1 + NIR)',         thr: 0.0, hint: '시가지 · 나지' },
};

// 임계값 확정 후 분류 영역 표시 색 (나머지 지역은 흰색)
const CLASS_COLOR = {
  NDVI: [26, 150, 65], GNDVI: [26, 150, 65], SAVI: [26, 150, 65],   // 녹색 — 식생
  NBR: [215, 25, 28],                                                // 적색 — 산불
  NDWI: [33, 102, 172], MNDWI: [33, 102, 172],                       // 파랑 — 수체
  NDBI: [245, 130, 32],                                              // 오렌지 — 시가지
  NDMI: [0, 150, 160],                                               // 청록 — 식생 수분
};
const rgb = c => `rgb(${c.join(',')})`;
// 확정값 그대로일 때만 분류 결과로 표시 (슬라이더를 다시 움직이면 연속색 미리보기)
const isClassView = r => !!(r && r.confirmed && r.confirmed.thr === r.thr && r.confirmed.dir === r.dir);

// Collection 2 Level-2 지표면 반사율 환산 계수
const L2_SCALE = { mult: 0.0000275, add: -0.2, unit: '지표면 반사율 (L2 SR)' };
// QA_PIXEL: bit0 fill, bit1 dilated cloud, bit2 cirrus, bit3 cloud, bit4 cloud shadow
const QA_MASK = 0b11111;

const KOREA = [36.1, 127.8];
const HIST_BINS = 200;
const DISPLAY_MAX = 2048;       // 화면 표시용 캔버스 최대 크기(px)

// 빨강 → 노랑 → 녹색 (RdYlGn)
const RAMP = [
  [165, 0, 38], [215, 48, 39], [244, 109, 67], [253, 174, 97], [254, 224, 139], [255, 255, 191],
  [217, 239, 139], [166, 217, 106], [102, 189, 99], [26, 152, 80], [0, 104, 55],
];
const LUT = (() => {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255 * (RAMP.length - 1), k = Math.min(Math.floor(t), RAMP.length - 2), f = t - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = Math.round(RAMP[k][c] + (RAMP[k + 1][c] - RAMP[k][c]) * f);
  }
  return lut;
})();
const RAMP_CSS = `linear-gradient(90deg, ${RAMP.map(c => `rgb(${c})`).join(',')})`;

// ─────────────────────────── 상태 ───────────────────────────
const S = {
  scenes: {},          // id → { id, sensor, level, date, pathrow, bands:{n:File}, qa, mtl, sr }
  sceneId: null,
  selected: new Set(['NDVI']),
  grid: null,          // 분석 격자 { W, H, x0, y0, rx, ry, epsg, def, pixA, disp }
  bands: {},           // n → { dn:Uint16Array, mult, add, lo, hi }
  qa: null,
  scaleUnit: '',
  results: {},         // key → { data, hist, valid, mean, vmin, vmax, thr, dir, confirmed }
  active: null,
  polyCount: 0,
};

// ─────────────────────────── 유틸 ───────────────────────────
const $ = s => document.querySelector(s);
const fmt = (v, d = 2) => Number(v).toLocaleString('ko-KR', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtInt = v => Number(v).toLocaleString('ko-KR');
const tick = () => new Promise(r => setTimeout(r, 0));
const fmtArea = m2 => `${fmt(m2 / 1e6, 3)} km² <span class="muted">(${fmt(m2 / 1e4, 1)} ha)</span>`;
const dirSym = d => (d === 'ge' ? '≥' : '≤');

function busy(msg, pct) {
  const el = $('#busy');
  if (msg === false) { el.hidden = true; return; }
  el.hidden = false;
  $('#busyMsg').textContent = msg;
  $('#busyBar').style.width = (pct ?? 0) + '%';
}

// 화면 오른쪽 아래 알림 — 안내 문구는 띄우지 않고 오류만 표시
function toast(msg, type = 'info', ms = 4500) {
  if (type !== 'error') return;
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function setStep(n, { locked, done } = {}) {
  const el = $('#step' + n);
  if (locked !== undefined) el.classList.toggle('locked', locked);
  if (done !== undefined) el.classList.toggle('done', done);
}

// ─────────────────────────── 지도 ───────────────────────────
const tiles = {
  // OSM 공식 타일은 file:// 등 Referer 없는 요청을 "Access blocked" 이미지로 막으므로 API 키가 필요 없는 Esri 일반 지도 사용
  osm: () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri World Street Map' }),
  light: () => L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, attribution: '© OpenStreetMap © CARTO' }),
  sat: () => L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: 'Esri World Imagery' }),
};

// <canvas>를 그대로 지도에 올리는 오버레이 (슬라이더 조작 시 즉시 다시 그리기 위함)
const CanvasOverlay = L.ImageOverlay.extend({
  _initImage() {
    const c = this._image = this._url;
    L.DomUtil.addClass(c, 'leaflet-image-layer');
    if (this._zoomAnimated) L.DomUtil.addClass(c, 'leaflet-zoom-animated');
    if (this.options.className) L.DomUtil.addClass(c, this.options.className);
    c.onselectstart = L.Util.falseFn;
    c.onmousemove = L.Util.falseFn;
    if (this.options.zIndex != null) this._updateZIndex();
  },
});

// 범례는 오른쪽 분석 패널(5단계 탭)에 표시
const legend = { set: html => { $('#legendBox').innerHTML = html || '<span class="muted">분석 후 표시됩니다.</span>'; } };

const M = {};      // maps: top, bottom, main
const O = {};      // overlays: { canvas, layer }
let drawGroup;

function initMaps() {
  // 왼쪽 지도는 크기가 달라도 오른쪽과 같은 범위를 보이도록 소수 줌 허용
  M.top = L.map('mapTop', { zoomSnap: 0, zoomDelta: 0.5 }).setView(KOREA, 6);
  M.bottom = L.map('mapBottom', { zoomSnap: 0, zoomDelta: 0.5 }).setView(KOREA, 6);
  M.main = L.map('mapMain', { zoomSnap: 0.25, zoomDelta: 0.5 }).setView(KOREA, 7);

  // 세 지도 모두 같은 배경지도 구성 (일반/위성/회색 전환, 축척)
  for (const m of [M.top, M.bottom, M.main]) {
    const osm = tiles.osm().addTo(m);
    const lc = L.control.layers({ '일반 지도': osm, '위성 영상': tiles.sat(), '회색 지도': tiles.light() }, null, { position: 'topright' }).addTo(m);
    if (m === M.main) M.layersCtl = lc;
    L.control.scale({ imperial: false }).addTo(m);
  }
  // 그리기 순서: 분석 결과 이미지(400) < 행정구역(450) < 사용자가 그린 영역(460)
  M.main.createPane('adminPane').style.zIndex = 450;
  M.main.createPane('drawPane').style.zIndex = 460;
  legend.set('');

  // 세 지도 위치 동기화 — 지도 크기 비율만큼 줌을 보정해 같은 지역 범위를 보여줌
  const all = [M.top, M.bottom, M.main];
  const zoomOffset = m => {
    const a = m.getSize(), b = M.main.getSize();
    if (!a.x || !a.y || !b.x || !b.y) return 0;
    return Math.log2(Math.min(a.x / b.x, a.y / b.y));
  };
  let lock = false;
  const syncFrom = m => {
    if (lock) return;
    lock = true;
    const z = m.getZoom() - zoomOffset(m);
    all.forEach(o => { if (o !== m) o.setView(m.getCenter(), z + zoomOffset(o), { animate: false }); });
    lock = false;
  };
  all.forEach(m => m.on('move zoomend', () => syncFrom(m)));
  window.addEventListener('resize', () => setTimeout(() => {
    all.forEach(m => m.invalidateSize());
    syncFrom(M.main);
  }, 100));
  setTimeout(() => syncFrom(M.main), 0);

  initDraw();
}

function ensureOverlay(key) {
  const d = S.grid.disp;
  let o = O[key];
  if (!o) {
    const canvas = document.createElement('canvas');
    o = O[key] = { canvas, layer: new CanvasOverlay(canvas, d.bounds, { className: 'pix', interactive: false }) };
    if (key === 'main') o.layer.setOpacity(1 - $('#opacity').value / 100);
    o.layer.addTo(M[key]);
  } else {
    o.layer.setBounds(d.bounds);
  }
  if (o.canvas.width !== d.DW) o.canvas.width = d.DW;
  if (o.canvas.height !== d.DH) o.canvas.height = d.DH;
  return o;
}

function clearOverlay(key) {
  const o = O[key];
  if (o) o.canvas.getContext('2d').clearRect(0, 0, o.canvas.width, o.canvas.height);
}

// ─────────────────────── 1단계: 폴더 선택 ───────────────────────
const PRODUCT_RE = /^(L[COTE]0\d_[A-Z0-9]{4}_\d{6}_\d{8}_\d{8}_\d{2}_[A-Z0-9]{2})_(.+)$/i;

function parseFolder(files) {
  const scenes = {};
  for (const f of files) {
    const m = f.name.match(PRODUCT_RE);
    const folder = (f.webkitRelativePath || '').split('/').slice(-2, -1)[0] || '영상';
    const id = m ? m[1].toUpperCase() : folder;
    const suffix = m ? m[2] : f.name;
    const sc = scenes[id] ||= { id, bands: {}, qa: null, mtl: null, sr: false };

    const bm = suffix.match(/(?:^|_)(SR_)?B([1-7])\.TIFF?$/i);
    if (bm) {
      sc.bands[+bm[2]] = f;
      if (bm[1]) sc.sr = true;
    } else if (/QA_PIXEL\.TIFF?$/i.test(suffix)) sc.qa = f;
    else if (/MTL\.txt$/i.test(suffix)) sc.mtl = f;
  }

  for (const id of Object.keys(scenes)) {
    const sc = scenes[id];
    if (!Object.keys(sc.bands).length) { delete scenes[id]; continue; }
    const p = id.split('_');
    if (p.length >= 7) {
      sc.sensor = { LC08: 'Landsat 8', LC09: 'Landsat 9' }[p[0]] || p[0];
      sc.level = p[1];
      sc.pathrow = `${p[2].slice(0, 3)}/${p[2].slice(3)}`;
      sc.date = `${p[3].slice(0, 4)}-${p[3].slice(4, 6)}-${p[3].slice(6)}`;
      if (/^L2/.test(sc.level)) sc.sr = true;
    } else {
      sc.sensor = 'Landsat (파일명 미확인)';
      sc.level = sc.sr ? 'L2' : '—';
    }
  }
  return scenes;
}

// .tar 안의 파일을 압축 해제 없이 File 조각으로 꺼낸다 (USGS 다운로드 형식)
async function untar(tar) {
  const out = [];
  const dec = new TextDecoder();
  const str = (u8, a, b) => dec.decode(u8.subarray(a, b)).replace(/\0[\s\S]*$/, '').trim();
  let off = 0, longName = null;
  while (off + 512 <= tar.size) {
    const h = new Uint8Array(await tar.slice(off, off + 512).arrayBuffer());
    if (h.every(v => v === 0)) break;                         // 끝 블록
    let name = str(h, 0, 100);
    const size = parseInt(str(h, 124, 136) || '0', 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    if (str(h, 257, 262) === 'ustar') {
      const prefix = str(h, 345, 500);
      if (prefix) name = prefix + '/' + name;
    }
    const data = off + 512;
    if (type === 'L') {                                        // GNU 긴 파일명
      longName = dec.decode(await tar.slice(data, data + size).arrayBuffer()).replace(/\0[\s\S]*$/, '');
    } else if (type === 'x') {                                 // PAX 헤더
      const m = dec.decode(await tar.slice(data, data + size).arrayBuffer()).match(/\d+ path=([^\n]+)\n/);
      if (m) longName = m[1];
    } else {
      if (longName) { name = longName; longName = null; }
      if (type === '0' || type === '\0') {
        const base = name.split('/').pop();
        out.push(new File([tar.slice(data, data + size)], base));
      }
    }
    off = data + Math.ceil(size / 512) * 512;
  }
  return out;
}

async function ingest(files) {
  const flat = [];
  const tars = files.filter(f => /\.tar$/i.test(f.name));
  const unsupported = files.filter(f => /\.(tar\.gz|tgz|zip|7z|gz)$/i.test(f.name));
  try {
    for (let i = 0; i < tars.length; i++) {
      busy(`${tars[i].name} 목록 읽는 중… (${i + 1}/${tars.length})`, 100 * i / tars.length);
      await tick();
      flat.push(...await untar(tars[i]));
    }
  } catch (err) {
    console.error(err);
    toast('TAR 파일을 읽지 못했습니다: ' + err.message, 'error');
  }
  busy(false);
  flat.push(...files.filter(f => !/\.tar$/i.test(f.name)));
  if (unsupported.length) {
    toast(`${unsupported.map(f => f.name).join(', ')}<br>압축(zip/gz)은 먼저 풀어서 폴더나 TIF로 불러오세요. (.tar 는 바로 가능)`, 'error', 8000);
  }
  onFolder(flat);
}

function onFolder(files) {
  const scenes = parseFolder(files);
  const ids = Object.keys(scenes);
  if (!ids.length) {
    const sample = files.slice(0, 6).map(f => f.name).join('<br>');
    toast(`Landsat 밴드 파일(*_SR_B4.TIF, *_B4.TIF 등)을 찾지 못했습니다.<br>불러온 파일 ${files.length}개${sample ? ':<br>' + sample : ''}`, 'error', 9000);
    return;
  }
  S.scenes = scenes;
  const sel = $('#sceneSel');
  sel.innerHTML = ids.map(id => `<option value="${id}">${id}</option>`).join('');
  sel.hidden = ids.length < 2;
  selectScene(ids[0]);
  if (ids.length > 1) toast(`${ids.length}개 장면이 발견되었습니다. 목록에서 선택하세요.`);
}

function selectScene(id) {
  S.sceneId = id;
  const sc = S.scenes[id];
  resetLoaded();

  $('#sceneBadge').textContent = `${sc.sensor} · ${sc.level} · ${sc.date || id} · 밴드 ${Object.keys(sc.bands).map(n => 'B' + n).join(' ')}`;
  $('#sceneBadge').title = id;
  $('#cloudMask').disabled = !sc.qa;
  $('#cloudMask').checked = !!sc.qa;

  setStep(1, { done: true });
  setStep(2, { locked: false });
  renderIndexList();
  openStep(2);
}

// ─────────────────────── 단계 드롭다운 ───────────────────────
function openStep(n) {
  document.querySelectorAll('.step.open').forEach(s => s.classList.remove('open'));
  if (n === 5) { showSideTab('cls'); return; }
  if (n === 6) { showSideTab('stat'); return; }
  const el = $('#step' + n);
  if (!el || el.classList.contains('locked') || !el.querySelector('.step-body')) return;
  el.classList.add('open');
}

// 오른쪽 분석 패널 탭 전환 (cls: 5단계 결과물 분류, stat: 6단계 통계 분석)
function showSideTab(tab) {
  document.querySelectorAll('.side-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $('#tab-cls').hidden = tab !== 'cls';
  $('#tab-stat').hidden = tab !== 'stat';
  if (tab === 'cls') drawHist();    // 숨겨져 있던 캔버스 크기 갱신
}

function closeSteps() {
  document.querySelectorAll('.step.open').forEach(s => s.classList.remove('open'));
}

// ─────────────────────── 2단계: 지수 선택 ───────────────────────
function renderIndexList() {
  const sc = S.scenes[S.sceneId];
  $('#indexList').innerHTML = Object.entries(INDICES).map(([k, d]) => {
    const ok = !sc || d.bands.every(b => sc.bands[b]);
    if (!ok) S.selected.delete(k);
    return `<label class="idx ${ok ? '' : 'disabled'}" title="${d.formula}">
      <input type="radio" name="indexPick" value="${k}" ${S.selected.has(k) ? 'checked' : ''} ${ok ? '' : 'disabled'}>
      <span><b>${k}</b> <small>${d.name} · B${d.bands[0]}, B${d.bands[1]}${ok ? '' : ' (밴드 없음)'}</small></span>
    </label>`;
  }).join('');
  updateNeeds();
}

function requiredBands() {
  const set = new Set();
  S.selected.forEach(k => INDICES[k].bands.forEach(b => set.add(b)));
  return [...set].sort((a, b) => a - b);
}

function orderedSelection() {
  return Object.keys(INDICES).filter(k => S.selected.has(k));
}

function updateNeeds() {
  const need = requiredBands();
  const sel = orderedSelection();
  $('#sum2').textContent = sel.length ? sel.join(', ') : '지수 선택';
  $('#needBands').innerHTML = need.length
    ? need.map(b => `<span class="chip ${S.bands[b] ? 'on' : ''}" title="${BAND_INFO[b]}">B${b} ${BAND_INFO[b].split(' ')[0]}</span>`).join('')
    : '<span class="muted">지수를 하나 이상 선택하세요.</span>';
  setStep(2, { done: need.length > 0 });
  setStep(3, { locked: !need.length });
  $('#btnLoad').disabled = !need.length;

  const loaded = need.length > 0 && need.every(b => S.bands[b]);
  if (S.grid && !loaded) {
    $('#loadInfo').innerHTML = '<span style="color:var(--warn)">선택이 바뀌었습니다. 영상을 다시 불러오세요.</span>';
    setStep(3, { done: false });
  }
  $('#btnRun').disabled = !loaded;
  setStep(4, { locked: !loaded });
  renderTabs();
}

// ─────────────────────── 3단계: 영상 불러오기 ───────────────────────
function projDef(epsg) {
  if (epsg >= 32601 && epsg <= 32660) return `+proj=utm +zone=${epsg - 32600} +datum=WGS84 +units=m +no_defs`;
  if (epsg >= 32701 && epsg <= 32760) return `+proj=utm +zone=${epsg - 32700} +south +datum=WGS84 +units=m +no_defs`;
  throw new Error(`지원하지 않는 좌표계입니다 (EPSG:${epsg}). Landsat UTM(WGS84) 영상이 필요합니다.`);
}

async function parseMTL(file) {
  const txt = await file.text();
  const out = {};
  for (const m of txt.matchAll(/REFLECTANCE_(MULT|ADD)_BAND_(\d+)\s*=\s*([-+\d.Ee]+)/g)) {
    (out[m[2]] ||= {})[m[1].toLowerCase()] = parseFloat(m[3]);
  }
  return out;
}

async function readRaster(file, W, H) {
  const tiff = await GeoTIFF.fromBlob(file);
  const arr = await tiff.readRasters({ width: W, height: H, samples: [0], interleave: true, resampleMethod: 'nearest' });
  if (arr.length !== W * H) throw new Error(`${file.name}: 영상 크기가 다른 밴드와 다릅니다.`);
  return arr;
}

function bandStretch(dn) {
  const hist = new Uint32Array(65536);
  let n = 0;
  for (let i = 0; i < dn.length; i++) { const v = dn[i]; if (v) { hist[v]++; n++; } }
  const pick = p => {
    const target = p * n;
    let c = 0;
    for (let v = 1; v < 65536; v++) { c += hist[v]; if (c >= target) return v; }
    return 65535;
  };
  const lo = pick(0.02), hi = pick(0.98);
  return { lo, hi: Math.max(hi, lo + 1) };
}

function resetLoaded() {
  S.grid = null; S.bands = {}; S.qa = null; S.results = {}; S.active = null;
  ['top', 'bottom', 'main'].forEach(clearOverlay);
  legend.set('');
  $('#loadInfo').textContent = '';
  $('#runInfo').textContent = '선택한 지수를 밴드 연산으로 계산합니다.';
  $('#headTop').textContent = '—';
  $('#headBottom').textContent = '—';
  $('#headMain').textContent = '대한민국 기본 지도';
  [3, 4, 5, 6].forEach(n => setStep(n, { done: false }));
  [5, 6].forEach(n => setStep(n, { locked: true }));
  $('#confirmBadge').textContent = '';
  $('#clsWrap').hidden = true;
  $('#clsEmpty').hidden = false;
  ['#btnPoly', '#btnRect', '#btnClear'].forEach(s => ($(s).disabled = true));
  updateNeeds();
  refreshStats();
}

async function loadImages() {
  const sc = S.scenes[S.sceneId];
  const need = requiredBands();
  const target = +$('#resSel').value;
  const useQA = $('#cloudMask').checked && sc.qa;

  try {
    busy('영상 정보 읽는 중…', 2);
    await tick();

    // 좌표 정보: 첫 밴드의 원본 해상도 이미지
    const tiff0 = await GeoTIFF.fromBlob(sc.bands[need[0]]);
    const img = await tiff0.getImage();
    const w = img.getWidth(), h = img.getHeight();
    const [x0, y0] = img.getOrigin();
    const [rx, ry] = img.getResolution();
    const gk = img.getGeoKeys() || {};
    const epsg = gk.ProjectedCSTypeGeoKey;
    const def = projDef(epsg);

    const f = Math.max(1, target / Math.abs(rx));
    const W = Math.round(w / f), H = Math.round(h / f);
    if (W * H > 40e6 && !confirm(`분석 격자가 ${fmtInt(W)}×${fmtInt(H)} 픽셀로 큽니다. 메모리를 많이 사용할 수 있습니다. 계속할까요?`)) {
      busy(false); return;
    }

    // 반사율 환산 계수
    let scale = {};
    if (sc.sr) {
      need.forEach(b => (scale[b] = L2_SCALE));
      S.scaleUnit = L2_SCALE.unit;
    } else if (sc.mtl) {
      const mtl = await parseMTL(sc.mtl);
      need.forEach(b => (scale[b] = mtl[b] && mtl[b].mult != null
        ? { mult: mtl[b].mult, add: mtl[b].add || 0 } : { mult: 1, add: 0 }));
      S.scaleUnit = '대기상단 반사율 (L1 TOA, MTL)';
    } else {
      need.forEach(b => (scale[b] = { mult: 1, add: 0 }));
      S.scaleUnit = 'DN 원시값 (MTL 없음)';
    }

    const newBands = {};
    const total = need.length + (useQA ? 1 : 0);
    for (let i = 0; i < need.length; i++) {
      const b = need[i];
      busy(`밴드 ${b} · ${BAND_INFO[b]} 읽는 중… (${i + 1}/${total})`, 5 + 90 * i / total);
      await tick();
      const dn = await readRaster(sc.bands[b], W, H);
      newBands[b] = { dn, mult: scale[b].mult, add: scale[b].add, ...bandStretch(dn) };
    }
    let qa = null;
    if (useQA) {
      busy(`QA_PIXEL 읽는 중… (${total}/${total})`, 5 + 90 * need.length / total);
      await tick();
      qa = await readRaster(sc.qa, W, H);
    }

    busy('지도 좌표로 재투영 준비 중…', 97);
    await tick();

    resetLoaded();
    S.bands = newBands;
    S.qa = qa;
    S.grid = { W, H, x0, y0, rx: rx * w / W, ry: ry * h / H, epsg, def };
    S.grid.pixA = Math.abs(S.grid.rx * S.grid.ry);
    buildDisplay(S.grid);

    $('#loadInfo').classList.remove('muted');
    $('#loadInfo').innerHTML = `<b>${fmt(Math.abs(S.grid.rx), 0)} m</b> 격자 · ${fmtInt(W)} × ${fmtInt(H)} px · EPSG:${epsg}<br>${S.scaleUnit}${qa ? ' · 구름 마스킹 적용' : ''}`;
    setStep(3, { done: true });
    updateNeeds();

    M.main.fitBounds(S.grid.disp.bounds);
    setActive(orderedSelection()[0]);
    refreshPolygons();
    busy(false);
    toast('영상을 불러왔습니다. 4단계 <b>분석 실행</b>을 눌러주세요.');
    openStep(4);
  } catch (err) {
    console.error(err);
    busy(false);
    toast('영상을 불러오지 못했습니다: ' + err.message, 'error', 8000);
  }
}

/**
 * UTM 분석 격자 → Web Mercator 표시 캔버스 매핑표를 만든다.
 * disp.map[k] = 캔버스 픽셀 k 가 참조하는 분석 격자 인덱스 (-1: 영상 밖)
 */
function buildDisplay(g) {
  const P = proj4(g.def);
  const R = 6378137, D = Math.PI / 180;
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  const N = 50, ex = g.W * g.rx, ey = g.H * g.ry;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    for (const [x, y] of [[g.x0 + t * ex, g.y0], [g.x0 + t * ex, g.y0 + ey], [g.x0, g.y0 + t * ey], [g.x0 + ex, g.y0 + t * ey]]) {
      const [lon, lat] = P.inverse([x, y]);
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    }
  }
  const mx = lon => R * lon * D;
  const my = lat => R * Math.log(Math.tan(Math.PI / 4 + lat * D / 2));
  const MX0 = mx(minLon), MX1 = mx(maxLon), MY0 = my(minLat), MY1 = my(maxLat);

  const side = Math.min(DISPLAY_MAX, Math.max(g.W, g.H) * 1.1);
  const ar = (MX1 - MX0) / (MY1 - MY0);
  const DW = Math.round(ar >= 1 ? side : side * ar);
  const DH = Math.round(ar >= 1 ? side / ar : side);

  // 8px 간격 격자점에서만 정확히 투영하고 사이는 쌍선형 보간
  const step = 8, nx = Math.ceil(DW / step) + 1, ny = Math.ceil(DH / step) + 1;
  const gc = new Float64Array(nx * ny), gr = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const Y = MY1 - (j * step + 0.5) / DH * (MY1 - MY0);
    const lat = (2 * Math.atan(Math.exp(Y / R)) - Math.PI / 2) / D;
    for (let i = 0; i < nx; i++) {
      const X = MX0 + (i * step + 0.5) / DW * (MX1 - MX0);
      const [ux, uy] = P.forward([X / R / D, lat]);
      gc[j * nx + i] = (ux - g.x0) / g.rx;
      gr[j * nx + i] = (uy - g.y0) / g.ry;
    }
  }
  const map = new Int32Array(DW * DH);
  for (let py = 0; py < DH; py++) {
    const j = Math.floor(py / step), fy = (py - j * step) / step;
    for (let px = 0; px < DW; px++) {
      const i = Math.floor(px / step), fx = (px - i * step) / step;
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      const col = (gc[a] * (1 - fx) + gc[b] * fx) * (1 - fy) + (gc[c] * (1 - fx) + gc[d] * fx) * fy;
      const row = (gr[a] * (1 - fx) + gr[b] * fx) * (1 - fy) + (gr[c] * (1 - fx) + gr[d] * fx) * fy;
      const cc = Math.floor(col), rr = Math.floor(row);
      map[py * DW + px] = (cc >= 0 && cc < g.W && rr >= 0 && rr < g.H) ? rr * g.W + cc : -1;
    }
  }
  g.disp = { DW, DH, map, bounds: L.latLngBounds([minLat, minLon], [maxLat, maxLon]) };
}

// ─────────────────────── 렌더링 ───────────────────────
function paintBand(key, bandNo) {
  const B = S.bands[bandNo];
  if (!S.grid || !B) { clearOverlay(key); return; }
  const { DW, DH, map } = S.grid.disp;
  const o = ensureOverlay(key);
  const ctx = o.canvas.getContext('2d');
  const im = ctx.createImageData(DW, DH), px = im.data;
  const dn = B.dn, lo = B.lo, k = 255 / (B.hi - B.lo);
  for (let i = 0, j = 0; i < map.length; i++, j += 4) {
    const s = map[i];
    if (s < 0) continue;
    const v = dn[s];
    if (v === 0) continue;
    const t = (v - lo) * k;
    px[j] = px[j + 1] = px[j + 2] = t;   // Uint8ClampedArray 가 0~255로 자동 절단
    px[j + 3] = 255;
  }
  ctx.putImageData(im, 0, 0);
}

function paintIndex() {
  const r = S.results[S.active];
  if (!S.grid || !r) { clearOverlay('main'); return; }
  const { DW, DH, map } = S.grid.disp;
  const o = ensureOverlay('main');
  const ctx = o.canvas.getContext('2d');
  const im = ctx.createImageData(DW, DH), px = im.data;
  const data = r.data, lo = r.vmin, sc = 255 / (r.vmax - r.vmin);
  const thr = r.thr, ge = r.dir === 'ge', showBelow = $('#showBelow').checked;

  if (isClassView(r)) {                             // 확정 결과: 분류 영역 = 지수별 색, 나머지 = 흰색
    const [cr, cg, cb] = CLASS_COLOR[S.active];
    for (let i = 0, j = 0; i < map.length; i++, j += 4) {
      const s = map[i];
      if (s < 0) continue;
      const v = data[s];
      if (v !== v) continue;                         // 구름·결측은 투명
      if (ge ? v >= thr : v <= thr) { px[j] = cr; px[j + 1] = cg; px[j + 2] = cb; }
      else { px[j] = px[j + 1] = px[j + 2] = 255; }
      px[j + 3] = 255;
    }
    ctx.putImageData(im, 0, 0);
    return;
  }

  for (let i = 0, j = 0; i < map.length; i++, j += 4) {
    const s = map[i];
    if (s < 0) continue;
    const v = data[s];
    if (v !== v) continue;                           // NaN (무효/구름)
    if (ge ? v >= thr : v <= thr) {
      let t = ((v - lo) * sc) | 0;
      t = t < 0 ? 0 : t > 255 ? 255 : t;
      px[j] = LUT[t * 3]; px[j + 1] = LUT[t * 3 + 1]; px[j + 2] = LUT[t * 3 + 2]; px[j + 3] = 255;
    } else if (showBelow) {
      px[j] = px[j + 1] = px[j + 2] = 128; px[j + 3] = 90;
    }
  }
  ctx.putImageData(im, 0, 0);
}

function updateLegend() {
  const r = S.results[S.active];
  if (!r) { legend.set(''); return; }
  const toggle = '';
  if (isClassView(r)) {
    legend.set(`<div class="ttl">${S.active} 분류 결과${toggle}</div>
      <div class="ramp cls">
        <div class="sw" style="background:${rgb(CLASS_COLOR[S.active])}"></div><span>${S.active} ${dirSym(r.dir)} ${fmt(r.thr)} (분류 영역)</span>
        <div class="sw white"></div><span>나머지 지역</span>
      </div>`);
    return;
  }
  const pos = Math.min(100, Math.max(0, (r.thr - r.vmin) / (r.vmax - r.vmin) * 100));
  legend.set(`<div class="ttl">${S.active} · ${INDICES[S.active].name}${toggle}</div>
    <div class="ramp" style="background:${RAMP_CSS}"><div class="mark" style="left:calc(${pos}% - 1px)"></div></div>
    <div class="lbl"><span>${fmt(r.vmin)} 낮음</span><span>임계값 ${dirSym(r.dir)} ${fmt(r.thr)}</span><span>높음 ${fmt(r.vmax)}</span></div>`);
}

// ─────────────────────── 뷰어 탭 ───────────────────────
function renderTabs() {
  const keys = S.grid ? orderedSelection().filter(k => INDICES[k].bands.every(b => S.bands[b])) : [];
  if (!keys.length) {
    $('#tabs').innerHTML = '<span class="muted">지수를 선택하고 영상을 불러오면 여기에 표시됩니다.</span>';
    return;
  }
  $('#tabs').innerHTML = keys.map(k => {
    const r = S.results[k];
    const dot = r ? (r.confirmed ? 'ok' : 'ready') : '';
    return `<button class="tab ${k === S.active ? 'active' : ''}" data-k="${k}" title="${INDICES[k].formula}">${k}<span class="dot ${dot}"></span></button>`;
  }).join('');
  const sel = $('#clsIndex');
  const rk = keys.filter(k => S.results[k]);
  sel.innerHTML = rk.map(k => `<option value="${k}">${k} · ${INDICES[k].name}</option>`).join('');
  if (S.results[S.active]) sel.value = S.active;
}

function setActive(key) {
  if (!key) return;
  S.active = key;
  const d = INDICES[key];
  const [a, b] = d.bands;
  $('#headTop').textContent = `${key} · B${a} ${BAND_INFO[a]}`;
  $('#headBottom').textContent = `${key} · B${b} ${BAND_INFO[b]}`;
  $('#headMain').textContent = S.results[key]
    ? `${key} ${d.name} = ${d.formula}`
    : `${key} — 4단계 ‘분석 실행’을 누르면 결과가 표시됩니다`;
  paintBand('top', a);
  paintBand('bottom', b);
  paintIndex();
  renderTabs();
  syncClsUI();
  refreshStats();
}

// ─────────────────────── 4단계: 분석 실행 ───────────────────────
function computeIndex(key) {
  const def = INDICES[key], g = S.grid, n = g.W * g.H;
  const A = S.bands[def.bands[0]], B = S.bands[def.bands[1]];
  const fn = def.fn || ND, qa = S.qa;
  const ad = A.dn, bd = B.dn, am = A.mult, aa = A.add, bm = B.mult, ba = B.add;
  const out = new Float32Array(n), hist = new Uint32Array(HIST_BINS);
  let valid = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const x = ad[i], y = bd[i];
    if (x === 0 || y === 0 || (qa && (qa[i] & QA_MASK))) { out[i] = NaN; continue; }
    let v = fn(x * am + aa, y * bm + ba);
    if (!Number.isFinite(v)) { out[i] = NaN; continue; }
    if (v < -1) v = -1; else if (v > 1) v = 1;
    out[i] = v; valid++; sum += v;
    let h = ((v + 1) * 0.5 * HIST_BINS) | 0;
    if (h >= HIST_BINS) h = HIST_BINS - 1;
    hist[h]++;
  }
  const pct = p => {
    const target = p * valid;
    let c = 0;
    for (let i = 0; i < HIST_BINS; i++) { c += hist[i]; if (c >= target) return -1 + (i + 0.5) * 2 / HIST_BINS; }
    return 1;
  };
  let vmin = pct(0.02), vmax = pct(0.98);
  if (vmax - vmin < 0.1) { const m = (vmin + vmax) / 2; vmin = m - 0.05; vmax = m + 0.05; }
  return { data: out, hist, valid, mean: valid ? sum / valid : NaN, vmin, vmax, thr: def.thr, dir: 'ge', confirmed: null };
}

async function runAnalysis() {
  const keys = orderedSelection().filter(k => INDICES[k].bands.every(b => S.bands[b]));
  // 분석을 다시 실행하면 6단계 통계(선택한 시·군, 직접 그린 영역)를 초기화
  adminSel.forEach(l => markRegion(l, false));
  adminSel.clear();
  drawGroup.clearLayers();
  S.polyCount = 0;
  refreshStats();
  try {
    const todo = keys.filter(k => !S.results[k]);   // 이미 계산·확정한 지수는 유지
    for (let i = 0; i < todo.length; i++) {
      busy(`${todo[i]} 계산 중… (${i + 1}/${todo.length})`, 100 * i / todo.length);
      await tick();
      S.results[todo[i]] = computeIndex(todo[i]);
    }
    busy(false);
  } catch (err) {
    busy(false);
    toast('분석 중 오류: ' + err.message, 'error');
    return;
  }
  $('#runInfo').classList.remove('muted');
  $('#runInfo').innerHTML = keys.map(k => {
    const r = S.results[k];
    return `<b>${k}</b> 평균 ${fmt(r.mean, 3)} <span class="muted">(${fmt(r.vmin)} ~ ${fmt(r.vmax)})</span>`;
  }).join('<br>');
  setStep(4, { done: true });
  setStep(5, { locked: false });
  $('#clsEmpty').hidden = true;
  $('#clsWrap').hidden = false;
  setActive(keys.includes(S.active) ? S.active : keys[0]);
  toast('분석이 완료되었습니다. 5단계에서 임계값을 조정하고 확정하세요.');
  openStep(5);
}

// ─────────────────────── 5단계: 분류 ───────────────────────
function classCount(r, thr = r.thr, dir = r.dir) {
  const d = r.data;
  let c = 0;
  if (dir === 'ge') { for (let i = 0; i < d.length; i++) if (d[i] >= thr) c++; }
  else { for (let i = 0; i < d.length; i++) if (d[i] <= thr) c++; }
  return c;
}

function syncClsUI() {
  const r = S.results[S.active];
  const on = !!r;
  $('#thr').disabled = !on;
  $('#btnConfirm').disabled = !on;
  if (!on) { $('#clsInfo').textContent = ''; $('#confirmBadge').textContent = ''; drawHist(); updateLegend(); return; }
  $('#clsIndex').value = S.active;
  $('#clsDir').value = r.dir;
  $('#thr').value = r.thr;
  $('#thrVal').textContent = fmt(r.thr);
  updateClsInfo();
  drawHist();
  updateLegend();
}

function updateClsInfo() {
  const r = S.results[S.active];
  if (!r) return;
  const c = classCount(r);
  $('#clsInfo').innerHTML = `분류 면적 (장면 전체): <b>${fmtArea(c * S.grid.pixA)}</b> · 유효 영역의 <b>${fmt(100 * c / r.valid, 1)}%</b>`;
  const b = $('#confirmBadge');
  if (!r.confirmed) { b.className = 'badge'; b.textContent = '미확정'; }
  else if (r.confirmed.thr === r.thr && r.confirmed.dir === r.dir) { b.className = 'badge ok'; b.textContent = `확정 ${dirSym(r.dir)} ${fmt(r.thr)}`; }
  else { b.className = 'badge warn'; b.textContent = `변경됨 · 확정값 ${dirSym(r.confirmed.dir)} ${fmt(r.confirmed.thr)}`; }
}

function drawHist() {
  const cv = $('#hist'), dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;             // 창이 접혀 있으면 펼칠 때 다시 그림
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const r = S.results[S.active];
  if (!r) {
    ctx.fillStyle = '#8a94a3'; ctx.font = '12px Pretendard, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('분석 후 지수 분포가 표시됩니다', w / 2, h / 2 + 4);
    return;
  }
  const pad = 14, bw = w / HIST_BINS;
  const clsColor = isClassView(r) ? rgb(CLASS_COLOR[S.active]) : null;
  let max = 0;
  for (const v of r.hist) max = Math.max(max, v);
  for (let i = 0; i < HIST_BINS; i++) {
    const v = -1 + (i + 0.5) * 2 / HIST_BINS;
    const pass = r.dir === 'ge' ? v >= r.thr : v <= r.thr;
    let t = ((v - r.vmin) / (r.vmax - r.vmin) * 255) | 0;
    t = t < 0 ? 0 : t > 255 ? 255 : t;
    ctx.fillStyle = !pass ? '#cfd6df' : clsColor || `rgb(${LUT[t * 3]},${LUT[t * 3 + 1]},${LUT[t * 3 + 2]})`;
    const bh = Math.sqrt(r.hist[i] / max) * (h - pad - 4);
    ctx.fillRect(i * bw, h - pad - bh, Math.max(1, bw - 0.3), bh);
  }
  const tx = (r.thr + 1) / 2 * w;
  ctx.fillStyle = '#111'; ctx.fillRect(tx - 1, 2, 2, h - pad - 2);
  ctx.fillStyle = '#6b7686'; ctx.font = '10px Pretendard, sans-serif';
  ctx.textAlign = 'left'; ctx.fillText('-1', 2, h - 3);
  ctx.textAlign = 'center'; ctx.fillText('0', w / 2, h - 3);
  ctx.textAlign = 'right'; ctx.fillText('1', w - 2, h - 3);
}

let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    paintIndex();
    drawHist();
    updateClsInfo();
    updateLegend();
  });
}

function confirmThreshold() {
  const r = S.results[S.active];
  if (!r) return;
  r.confirmed = { thr: r.thr, dir: r.dir };
  scheduleRender();                 // 분류 결과(지수별 색 / 흰색)로 다시 그림
  renderTabs();
  setStep(5, { done: true });
  setStep(6, { locked: false });
  ['#btnPoly', '#btnRect', '#btnClear'].forEach(s => ($(s).disabled = false));
  refreshPolygons();
  refreshStats();
  toast(`${S.active} 임계값 ${dirSym(r.dir)} ${fmt(r.thr)} 로 확정했습니다. 6단계에서 시·군을 클릭하거나 영역을 그려보세요.`);
  openStep(6);
}

// ─────────────────────── 6단계: 영역 통계 ───────────────────────
const drawOpts = {
  polygon: { allowIntersection: false, showArea: false, shapeOptions: { color: '#1f5fbf', weight: 2, fillOpacity: 0.06, pane: 'drawPane' } },
  rectangle: { showArea: false, shapeOptions: { color: '#1f5fbf', weight: 2, fillOpacity: 0.06, pane: 'drawPane' } },
};

function initDraw() {
  if (L.drawLocal) {
    const t = L.drawLocal.draw.handlers;
    t.polygon.tooltip = { start: '클릭하여 영역 그리기를 시작하세요.', cont: '클릭하여 계속 그리세요.', end: '첫 점을 클릭하면 완료됩니다.' };
    t.rectangle.tooltip.start = '드래그하여 사각형을 그리세요.';
    L.drawLocal.draw.toolbar.buttons.polygon = '폴리곤 그리기';
    L.drawLocal.draw.toolbar.buttons.rectangle = '사각형 그리기';
    L.drawLocal.draw.toolbar.actions.text = '취소';
    L.drawLocal.draw.toolbar.finish.text = '완료';
    L.drawLocal.draw.toolbar.undo.text = '마지막 점 삭제';
    L.drawLocal.edit.toolbar.buttons.edit = '영역 편집';
    L.drawLocal.edit.toolbar.buttons.remove = '영역 삭제';
  }
  // 지도 안 그리기 도구 모음은 두지 않고, 오른쪽 패널 버튼으로만 그림
  drawGroup = L.featureGroup().addTo(M.main);

  M.main.on(L.Draw.Event.CREATED, e => {
    const layer = e.layer;
    layer._sid = ++S.polyCount;
    drawGroup.addLayer(layer);
    layer.bindTooltip(`영역 ${layer._sid}`, { permanent: true, direction: 'center', className: 'poly-label' });
    updatePopup(layer);               // 팝업은 영역을 클릭할 때만 열림
    showSideTab('stat');
    updateStatInfo();
  });
}

function updateStatInfo() {
  refreshDrawTable();
}

function refreshPolygons() {
  drawGroup && drawGroup.eachLayer(updatePopup);
  refreshDrawTable();
}

// 6단계 통계 표 두 개(행정구역 · 직접 그린 영역)를 함께 갱신
function refreshStats() {
  refreshAdminTable();
  refreshDrawTable();
}

const km2 = v => (v == null ? '–' : fmt(v, 2));
const pctOf = (a, b) => (a == null || !b ? '–' : fmt(100 * a / b, 1));

function refreshDrawTable() {
  if (!drawGroup) return;
  const layers = drawGroup.getLayers();
  const r = S.results[S.active], conf = r && r.confirmed;
  const head = '<tr><th>영역</th><th>면적<br>(km²)</th><th>분석 면적<br>(km²)</th><th>비율<br>(%)</th><th></th></tr>';
  if (!layers.length) {
    $('#drawTable').innerHTML = head + '<tr class="empty-row"><td colspan="5">⬠ 폴리곤 또는 ▭ 사각형으로 영역을 그려 보세요.</td></tr>';
    $('#statInfo').textContent = '';
    return;
  }
  const A = S.grid ? S.grid.pixA : 0;
  $('#drawTable').innerHTML = head + layers.map(layer => {
    let area = null, cls = null;
    if (S.grid) {
      const st = polygonStats(layer);
      area = st.area / 1e6;
      const m = st.list.find(x => x.k === S.active);
      if (m && conf) cls = m.pass * A / 1e6;
    }
    return `<tr data-sid="${layer._sid}" class="clickable" title="클릭하면 지도에서 영역으로 이동">
      <td>영역 ${layer._sid}</td><td>${km2(area)}</td><td class="big">${km2(cls)}</td><td>${pctOf(cls, area)}</td>
      <td><button class="row-del" data-del="${layer._sid}" title="이 영역 삭제">✕</button></td></tr>`;
  }).join('');
  $('#statInfo').textContent = conf ? `${S.active} ${dirSym(conf.dir)} ${fmt(conf.thr)} 기준 · 행을 클릭하면 해당 영역으로 이동합니다.` : '5단계에서 임계값을 확정하면 분석 면적이 계산됩니다.';
}

function polygonStats(layer) {
  let ll = layer.getLatLngs();
  while (Array.isArray(ll[0])) ll = ll[0];

  const g = S.grid;
  const P = proj4(g.def);
  const pts = ll.map(p => {
    const [x, y] = P.forward([p.lng, p.lat]);
    return { x, y, c: (x - g.x0) / g.rx, r: (y - g.y0) / g.ry };
  });
  let a2 = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a2 += p.x * q.y - q.x * p.y;
  }
  const area = Math.abs(a2) / 2;

  const list = Object.keys(INDICES).filter(k => S.results[k] && S.results[k].confirmed)
    .map(k => ({ k, r: S.results[k], valid: 0, pass: 0, sum: 0 }));
  let inside = 0;
  scanRings([pts], idx => {
    inside++;
    for (const m of list) {
      const v = m.r.data[idx];
      if (v !== v) continue;
      m.valid++; m.sum += v;
      if (m.r.confirmed.dir === 'ge' ? v >= m.r.confirmed.thr : v <= m.r.confirmed.thr) m.pass++;
    }
  });
  return { area, inside, list };
}

/**
 * 링 목록(픽셀 좌표 {c, r})으로 둘러싸인 분석 격자 픽셀마다 fn(index) 호출.
 * 짝홀 규칙이라 멀티폴리곤·구멍(hole)도 그대로 처리됨.
 */
function scanRings(rings, fn) {
  const g = S.grid;
  let rMin = Infinity, rMax = -Infinity;
  for (const ring of rings) for (const p of ring) { if (p.r < rMin) rMin = p.r; if (p.r > rMax) rMax = p.r; }
  rMin = Math.max(0, Math.floor(rMin));
  rMax = Math.min(g.H - 1, Math.ceil(rMax));
  const xs = [];
  for (let row = rMin; row <= rMax; row++) {
    const yc = row + 0.5;
    xs.length = 0;
    for (const ring of rings) {
      for (let i = 0, n = ring.length; i < n; i++) {
        const p = ring[i], q = ring[(i + 1) % n];
        if ((p.r > yc) !== (q.r > yc)) xs.push(p.c + (yc - p.r) * (q.c - p.c) / (q.r - p.r));
      }
    }
    xs.sort((u, v) => u - v);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const c0 = Math.max(0, Math.ceil(xs[s] - 0.5));
      const c1 = Math.min(g.W - 1, Math.ceil(xs[s + 1] - 0.5) - 1);
      for (let col = c0; col <= c1; col++) fn(row * g.W + col);
    }
  }
}

function updatePopup(layer) {
  let html;
  if (!S.grid) {
    html = '<div class="stat-pop"><h3>영역 ' + layer._sid + '</h3>영상을 먼저 불러오세요.</div>';
  } else {
    const st = polygonStats(layer);
    const A = S.grid.pixA;
    const rows = st.list.map(m => `<tr>
        <td><b>${m.k}</b></td>
        <td>${dirSym(m.r.confirmed.dir)} ${fmt(m.r.confirmed.thr)}</td>
        <td class="big">${fmt(m.pass * A / 1e6, 3)}</td>
        <td>${fmt(m.pass * A / 1e4, 1)}</td>
        <td>${m.valid ? fmt(100 * m.pass / m.valid, 1) : '–'}%</td>
        <td>${m.valid ? fmt(m.sum / m.valid, 3) : '–'}</td></tr>`).join('');
    const validMax = st.list.length ? Math.max(...st.list.map(m => m.valid)) : 0;
    html = `<div class="stat-pop${layer._min ? ' min' : ''}">
      <div class="pop-head"><h3>영역 ${layer._sid} · 통계 분석 결과</h3>
        <button class="pop-toggle" data-sid="${layer._sid}" title="최소화/펼치기">${layer._min ? '+' : '–'}</button></div>
      <div class="pop-body">
      <p class="sum">
        영역 면적: <b>${fmtArea(st.area)}</b><br>
        영상 내 포함 면적: ${fmtArea(st.inside * A)}${st.list.length ? `<br>유효 픽셀 면적 (구름·결측 제외): ${fmtArea(validMax * A)}` : ''}
      </p>
      ${st.list.length ? `<table>
        <tr><th>지수</th><th>조건</th><th>분류 면적 (km²)</th><th>(ha)</th><th>비율</th><th>평균값</th></tr>
        ${rows}</table>` : '<p class="note">5단계에서 임계값을 확정하면 분류 면적이 계산됩니다.</p>'}
      <div class="note">픽셀 ${fmt(Math.abs(S.grid.rx), 0)} m 격자 · EPSG:${S.grid.epsg} 평면 기준 · 비율 = 분류 면적 / 유효 면적</div>
      </div>
    </div>`;
  }
  if (layer.getPopup()) layer.setPopupContent(html);
  else layer.bindPopup(html, { maxWidth: 440, minWidth: 0, className: 'compact-pop', autoPanPadding: [10, 10] });
}

// ─────────────────── 6단계: 행정구역(시·군) 통계 ───────────────────
// data/sigungu.geojson — 통계청 2018 시군구 경계, 일반구는 시로 통합, area_km2 는 원본 경계 기준 면적
const ADMIN_BASE = { color: '#222', weight: 1.2, opacity: 0.9, fill: true, fillColor: '#e53935', fillOpacity: 0 };
const ADMIN_SEL = { color: '#b71c1c', weight: 2.5, opacity: 1, fillColor: '#e53935', fillOpacity: 0.35 };   // 선택: 반투명 적색 (뒤의 분석 결과가 비침)
let adminLayer = null;
const adminSel = new Map();         // key → layer (선택 순서 유지)

async function loadAdmin() {
  try {
    // data/sigungu.js 가 있으면 그대로 사용 (file:// 로 열어도 동작), 없으면 서버에서 geojson 요청
    let gj = window.SIGUNGU_GEOJSON;
    if (!gj) {
      const res = await fetch('data/sigungu.geojson');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      gj = await res.json();
    }
    adminLayer = L.geoJSON(gj, {
      pane: 'adminPane',
      style: () => ({ ...ADMIN_BASE }),
      onEachFeature: (f, layer) => {
        hoverName(layer);
        layer.on('click', e => { L.DomEvent.stopPropagation(e); toggleRegion(layer); });
      },
    }).addTo(M.main);
    M.layersCtl.addOverlay(adminLayer, '행정구역 (시·군)');
  } catch (err) {
    console.warn(err);
    toast('행정구역 경계(data/sigungu.geojson)를 불러오지 못했습니다. start-server.bat 로 서버를 켜서 접속했는지 확인하세요.', 'error', 8000);
  }
}

// 선택된 시·군은 적색으로 칠하고 지도에 이름표 표시
function markRegion(layer, on) {
  layer.setStyle(on ? ADMIN_SEL : ADMIN_BASE);
  layer.unbindTooltip();
  if (on) layer.bindTooltip(layer.feature.properties.key, { permanent: true, direction: 'center', className: 'admin-label' }).openTooltip();
  else hoverName(layer);
}

// 선택 전에는 마우스를 올리면 시·군 이름 표시
function hoverName(layer) {
  layer.bindTooltip(layer.feature.properties.key, { sticky: true, direction: 'top', className: 'admin-tip' });
}

function toggleRegion(layer) {
  const key = layer.feature.properties.key;
  if (adminSel.has(key)) {
    adminSel.delete(key);
    markRegion(layer, false);
  } else {
    adminSel.set(key, layer);
    markRegion(layer, true);
  }
  refreshAdminTable();
}

function clearRegions() {
  adminSel.forEach(l => markRegion(l, false));
  adminSel.clear();
  refreshAdminTable();
}

function regionStats(layer) {
  const p = layer.feature.properties;
  const r = S.results[S.active];
  const conf = r && r.confirmed;
  const out = { key: p.key, area: p.area_km2 * 1e6, inside: 0, valid: 0, pass: 0, hasData: !!(S.grid && r), conf };
  if (!S.grid) return out;
  const g = S.grid, P = proj4(g.def);
  const geom = layer.feature.geometry;
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  const rings = polys.flat().map(ring => ring.map(([lng, lat]) => {
    const [x, y] = P.forward([lng, lat]);
    return { c: (x - g.x0) / g.rx, r: (y - g.y0) / g.ry };
  }));
  const data = r && r.data;
  scanRings(rings, idx => {
    out.inside++;
    if (!data) return;
    const v = data[idx];
    if (v !== v) return;
    out.valid++;
    if (conf && (conf.dir === 'ge' ? v >= conf.thr : v <= conf.thr)) out.pass++;
  });
  return out;
}

function refreshAdminTable() {
  const r = S.results[S.active], conf = r && r.confirmed;
  $('#adminIdx').textContent = conf ? `${S.active} ${dirSym(conf.dir)} ${fmt(conf.thr)}` : (r ? `${S.active} 미확정` : '분석 전');
  const head = `<tr><th>행정구역</th><th>행정구역<br>면적</th><th>영상<br>유효</th><th>분석<br>면적</th><th>비율<br>(%)</th></tr>`;
  $('#adminClear').disabled = $('#adminCsv').disabled = !adminSel.size;
  if (!adminSel.size) {
    S.adminRows = [];
    $('#adminTable').innerHTML = head + '<tr class="empty-row"><td colspan="5">선택된 시·군이 없습니다.</td></tr>';
    $('#adminNote').textContent = '면적 단위: km²';
    return;
  }

  const A = S.grid ? S.grid.pixA : 0;
  const rows = S.adminRows = [...adminSel.values()].map(regionStats).map(s => ({
    name: s.key,
    area: s.area / 1e6,
    valid: s.hasData ? s.valid * A / 1e6 : null,
    cls: s.conf ? s.pass * A / 1e6 : null,
  }));
  const nameCell = key => {
    const i = key.lastIndexOf(' ');
    return `<td title="${key}"><b>${key.slice(i + 1)}</b><small>${key.slice(0, i)}</small></td>`;
  };
  let body = rows.map(x => `<tr>${nameCell(x.name)}<td>${km2(x.area)}</td><td>${km2(x.valid)}</td>
      <td class="big">${km2(x.cls)}</td><td>${pctOf(x.cls, x.area)}</td></tr>`).join('');
  if (rows.length > 1) {
    const sum = f => (rows.some(x => x[f] == null) ? null : rows.reduce((a, x) => a + x[f], 0));
    const t = { area: sum('area'), valid: sum('valid'), cls: sum('cls') };
    body += `<tr class="total"><td>합계 ${rows.length}개</td><td>${km2(t.area)}</td><td>${km2(t.valid)}</td>
      <td class="big">${km2(t.cls)}</td><td>${pctOf(t.cls, t.area)}</td></tr>`;
  }
  $('#adminTable').innerHTML = head + body;
  $('#adminNote').textContent = conf
    ? '면적 단위: km² · 비율 = 분석 면적 ÷ 행정구역 면적 · 영상 밖·구름 영역은 분석 면적에서 제외'
    : '면적 단위: km² · 5단계에서 임계값을 확정하면 분석 면적이 계산됩니다.';
}

function downloadAdminCsv() {
  const rows = S.adminRows || [];
  if (!rows.length) return;
  const r = S.results[S.active], conf = r && r.confirmed;
  const cond = conf ? `${S.active} ${conf.dir === 'ge' ? '>=' : '<='} ${conf.thr}` : '';
  const n = v => (v == null ? '' : v.toFixed(4));
  const lines = [['행정구역', '행정구역 면적(km2)', '영상 유효 면적(km2)', '분석 면적(km2)', '비율(%)', '분석 조건'].join(',')];
  rows.forEach(x => lines.push([x.name, n(x.area), n(x.valid), n(x.cls), x.cls == null ? '' : (100 * x.cls / x.area).toFixed(2), cond].join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  a.download = `행정구역_통계_${S.active || '결과'}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ─────────────────────── 이벤트 연결 ───────────────────────
function bindUI() {
  $('#folderInput').addEventListener('change', e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) ingest(files);
  });

  // 단계 제목(또는 선택 상자)을 누르면 아래로 창이 열리고, 바깥을 누르면 닫힘
  document.querySelectorAll('.step-toggle').forEach(t => t.addEventListener('click', () => {
    const n = +t.dataset.step;
    if (n === 5 || n === 6) { closeSteps(); openStep(n); return; }   // 오른쪽 분석 패널 탭으로 이동
    $('#step' + n).classList.contains('open') ? closeSteps() : openStep(n);
  }));
  document.addEventListener('click', e => { if (!e.target.closest('.step')) closeSteps(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSteps(); });

  // 폴더를 화면에 끌어다 놓아도 불러옴
  const readEntry = async entry => {
    if (entry.isFile) return [await new Promise((res, rej) => entry.file(res, rej))];
    if (!entry.isDirectory) return [];
    const reader = entry.createReader(), out = [];
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) out.push(...await readEntry(e));
    }
    return out;
  };
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', async e => {
    e.preventDefault();
    const entries = [...e.dataTransfer.items].map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    let files = [];
    if (entries.length) for (const en of entries) files.push(...await readEntry(en));
    else files = [...e.dataTransfer.files];
    if (files.length) ingest(files);
  });
  $('#sceneSel').addEventListener('change', e => selectScene(e.target.value));

  $('#indexList').addEventListener('change', e => {
    if (e.target.type !== 'radio') return;
    const key = e.target.value;
    S.selected = new Set([key]);                    // 지수는 하나만 선택
    updateNeeds();
    closeSteps();
    // 필요한 밴드가 이미 불러와져 있으면 바로 그 지수로 전환
    if (S.grid && INDICES[key].bands.every(b => S.bands[b])) {
      setActive(key);
      if (!S.results[key]) openStep(4);             // 아직 계산 안 된 지수면 분석 실행 안내
    } else if (S.grid) openStep(3);                 // 새 밴드가 필요하면 영상 다시 불러오기
  });

  $('#btnLoad').addEventListener('click', loadImages);
  $('#btnRun').addEventListener('click', runAnalysis);

  $('#tabs').addEventListener('click', e => {
    const t = e.target.closest('.tab');
    if (t) setActive(t.dataset.k);
  });
  $('#clsIndex').addEventListener('change', e => setActive(e.target.value));
  $('#clsDir').addEventListener('change', e => {
    const r = S.results[S.active];
    if (r) { r.dir = e.target.value; scheduleRender(); }
  });
  $('#thr').addEventListener('input', e => {
    const r = S.results[S.active];
    if (!r) return;
    r.thr = +e.target.value;
    $('#thrVal').textContent = fmt(r.thr);
    scheduleRender();
  });
  $('#showBelow').addEventListener('change', scheduleRender);
  $('#btnConfirm').addEventListener('click', confirmThreshold);

  // 결과 투명도
  document.querySelectorAll('.op-slider').forEach(sl => sl.addEventListener('input', e => {
    const pct = +e.target.value;
    document.querySelectorAll('.op-slider').forEach(o => (o.value = pct));
    document.querySelectorAll('.op-val').forEach(o => (o.textContent = pct + '%'));
    if (O.main) O.main.layer.setOpacity(1 - pct / 100);
  }));

  document.querySelectorAll('.side-tab').forEach(b => b.addEventListener('click', () => showSideTab(b.dataset.tab)));
  $('#adminClear').addEventListener('click', clearRegions);
  $('#adminCsv').addEventListener('click', downloadAdminCsv);
  $('#btnPoly').addEventListener('click', () => { closeSteps(); new L.Draw.Polygon(M.main, drawOpts.polygon).enable(); });
  $('#btnRect').addEventListener('click', () => { closeSteps(); new L.Draw.Rectangle(M.main, drawOpts.rectangle).enable(); });
  $('#btnClear').addEventListener('click', () => { drawGroup.clearLayers(); S.polyCount = 0; updateStatInfo(); });

  // 직접 그린 영역 표: 행 클릭 → 지도에서 해당 영역으로 이동, ✕ → 삭제
  $('#drawTable').addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    const row = e.target.closest('tr[data-sid]');
    const layer = row && drawGroup.getLayers().find(l => String(l._sid) === row.dataset.sid);
    if (!layer) return;
    if (del) { drawGroup.removeLayer(layer); updateStatInfo(); return; }
    M.main.fitBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 13 });
    layer.openPopup();
  });

  window.addEventListener('resize', () => drawHist());

  // 팝업·범례 최소화 토글 (내용은 그대로 두고 접기만 함)
  document.addEventListener('click', e => {
    const btn = e.target.closest('.pop-toggle');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const layer = drawGroup.getLayers().find(l => String(l._sid) === btn.dataset.sid);
    if (!layer) return;
    layer._min = !layer._min;
    btn.closest('.stat-pop').classList.toggle('min', layer._min);
    btn.textContent = layer._min ? '+' : '–';
    layer.getPopup().update();
  }, true);
}

initMaps();
bindUI();
renderIndexList();
drawHist();
refreshStats();
loadAdmin();
