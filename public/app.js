const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
if (params.has('film')) document.body.classList.add('film');

const CYAN = '#3fd8ff';
const MINT = '#5dffb0';
const RED = '#ff3b52';

const state = {meta: null, home: null, hosts: new Map(), totals: {connections: 0, blocked: 0, up: 0, down: 0}};
const rows = new Map();
const labels = new Map();
let arcs = [];
let rings = [];

const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const place = (g) => (g ? [g.city, g.country].filter(Boolean).join(', ') : 'unknown location');

// Globe
const el = $('globe');
const world = Globe({animateIn: false})(el)
  .backgroundColor('rgba(0,0,0,0)')
  .showAtmosphere(true)
  .atmosphereColor('#3d7bff')
  .atmosphereAltitude(0.17)
  .hexPolygonResolution(3)
  .hexPolygonMargin(0.42)
  .hexPolygonUseDots(true)
  .hexPolygonColor(() => 'rgba(96, 136, 230, 0.62)')
  .arcColor('color')
  .arcStroke('stroke')
  .arcDashLength('dashLen')
  .arcDashGap('dashGap')
  .arcDashInitialGap('dashInit')
  .arcDashAnimateTime('animTime')
  .arcAltitudeAutoScale(0.42)
  .arcsTransitionDuration(0)
  .ringColor('color')
  .ringMaxRadius('maxR')
  .ringPropagationSpeed('speed')
  .ringRepeatPeriod('period')
  .htmlElement((d) => d.el)
  .htmlAltitude(0.015);

const mat = world.globeMaterial();
mat.color.set('#0a1330');
mat.emissive.set('#060c22');
mat.emissiveIntensity = 0.9;
mat.shininess = 4;
const controls = world.controls();
controls.autoRotate = true;
controls.autoRotateSpeed = 0.35;

fetch('vendor/countries.geojson')
  .then((r) => r.json())
  .then((g) => world.hexPolygonsData(g.features.filter((f) => f.properties.ISO_A2 !== 'AQ')));

function resize() {
  world.width(el.clientWidth).height(el.clientHeight);
}
addEventListener('resize', resize);
resize();

// Great-circle midpoint, so the camera frames the whole arc.
function midpoint(a, b) {
  const rad = Math.PI / 180;
  const v = (p) => [Math.cos(p.lat * rad) * Math.cos(p.lng * rad), Math.cos(p.lat * rad) * Math.sin(p.lng * rad), Math.sin(p.lat * rad)];
  const [x1, y1, z1] = v(a);
  const [x2, y2, z2] = v(b);
  const [x, y, z] = [x1 + x2, y1 + y2, z1 + z2];
  return {lat: Math.atan2(z, Math.hypot(x, y)) / rad, lng: Math.atan2(y, x) / rad};
}

let focusUntil = 0;
let lastMove = 0;
let resumeTimer = null;
function flyTo(geo, blocked) {
  const now = Date.now();
  if (!blocked && (now < focusUntil || now - lastMove < 2600)) return;
  const mid = midpoint(state.home, geo);
  controls.autoRotate = false;
  world.pointOfView({lat: mid.lat, lng: mid.lng, altitude: blocked ? 1.85 : 2.25}, blocked ? 1500 : 1300);
  lastMove = now;
  if (blocked) focusUntil = now + 5000;
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => (controls.autoRotate = true), blocked ? 5000 : 2800);
}

function syncArcs() {
  world.arcsData(arcs);
}
function syncRings() {
  world.ringsData(rings);
}
function syncLabels() {
  world.htmlElementsData([...labels.values()]);
}

function persistentArc(h) {
  const blocked = h.kind === 'block';
  return {
    key: `p:${h.host}`,
    startLat: state.home.lat, startLng: state.home.lng, endLat: h.geo.lat, endLng: h.geo.lng,
    // Flowing dashes keep every frame looking live.
    color: blocked ? ['rgba(255,59,82,0.95)', 'rgba(255,90,110,0.95)'] : ['rgba(63,216,255,0.75)', 'rgba(93,255,176,0.75)'],
    stroke: blocked ? 0.9 : 0.55, dashLen: blocked ? 0.12 : 0.3, dashGap: blocked ? 0.06 : 0.12, dashInit: 0, animTime: blocked ? 900 : 3200,
  };
}

function flight(h) {
  const blocked = h.kind === 'block';
  const arc = {
    key: `f:${h.host}:${Math.random()}`,
    startLat: state.home.lat, startLng: state.home.lng, endLat: h.geo.lat, endLng: h.geo.lng,
    color: blocked ? [RED, RED] : [CYAN, MINT],
    stroke: blocked ? 1.5 : 1, dashLen: 0.45, dashGap: 4, dashInit: 1, animTime: blocked ? 1100 : 1400,
  };
  arcs.push(arc);
  syncArcs();
  setTimeout(() => {
    arcs = arcs.filter((a) => a !== arc);
    syncArcs();
  }, arc.animTime * 1.5);
  const ring = {lat: h.geo.lat, lng: h.geo.lng, maxR: blocked ? 7 : 4, speed: blocked ? 5 : 3, period: blocked ? 450 : 800,
    color: blocked ? (t) => `rgba(255,59,82,${1 - t})` : (t) => `rgba(63,216,255,${1 - t})`};
  setTimeout(() => {
    rings.push(ring);
    syncRings();
    setTimeout(() => {
      rings = rings.filter((r) => r !== ring);
      syncRings();
    }, blocked ? 3200 : 1800);
  }, arc.animTime * 0.8);
}

function upsertLabel(h) {
  if (!h.geo) return;
  let item = labels.get(h.host);
  if (!item) {
    const outer = document.createElement('div');
    const inner = document.createElement('div');
    inner.className = 'in';
    outer.appendChild(inner);
    item = {el: outer, lat: h.geo.lat, lng: h.geo.lng};
    labels.set(h.host, item);
  }
  item.el.className = `glabel ${h.kind}`;
  item.el.firstChild.textContent = h.kind === 'block' ? `✕ BLOCKED  ${h.host}` : h.host;
  // Stack labels that share a city so they don't overlap.
  const same = [...state.hosts.values()].filter((o) => o.geo && Math.abs(o.geo.lat - h.geo.lat) < 6 && Math.abs(o.geo.lng - h.geo.lng) < 9);
  same.forEach((o, i) => {
    const l = labels.get(o.host);
    if (l) l.el.firstChild.style.marginTop = `${-i * 24}px`;
  });
  syncLabels();
}

function renderRow(h, isNew) {
  const list = $('hosts');
  let li = rows.get(h.host);
  if (!li) {
    li = document.createElement('li');
    li.innerHTML = '<span class="d"></span><div><div class="h"></div><div class="sub"></div></div><span class="r"></span>';
    rows.set(h.host, li);
    li.className = 'row enter';
    list.prepend(li);
    requestAnimationFrame(() => requestAnimationFrame(() => li.classList.remove('enter')));
  } else if (isNew !== false) {
    list.prepend(li);
  }
  li.classList.toggle('block', h.kind === 'block');
  li.querySelector('.h').textContent = h.host;
  li.querySelector('.sub').textContent = [place(h.geo), h.procs && h.procs[0]].filter(Boolean).join(' · ');
  li.querySelector('.r').textContent = h.kind === 'block' ? 'BLOCKED' : `×${h.count}  ${fmtBytes(h.up + h.down)}`;
  if (h.kind !== 'block') {
    li.classList.add('flash');
    setTimeout(() => li.classList.remove('flash'), 500);
  }
}

function renderTotals() {
  $('s-servers').textContent = state.hosts.size;
  $('s-conns').textContent = state.totals.connections;
  $('s-sent').textContent = fmtBytes(state.totals.up);
  $('s-blocked').textContent = state.totals.blocked;
  $('s-blocked-box').classList.toggle('on', state.totals.blocked > 0);
}

let toastTimer = null;
function toast(ev) {
  $('toast-host').textContent = ev.host;
  $('toast-sub').textContent = [ev.proc && `← ${ev.proc.cmd}`, ev.rule].filter(Boolean).join('  ·  ');
  const t = $('toast');
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 4500);
}

function setHome(home) {
  state.home = home;
  world.pointOfView({lat: home.lat + 12, lng: home.lng - 25, altitude: 2.3}, 0);
  rings.push({lat: home.lat, lng: home.lng, maxR: 3, speed: 1.4, period: 1600, color: (t) => `rgba(93,255,176,${0.9 - t * 0.9})`});
  syncRings();
  const outer = document.createElement('div');
  outer.className = 'glabel home';
  const inner = document.createElement('div');
  inner.className = 'in';
  inner.textContent = `you · ${home.label}`;
  outer.appendChild(inner);
  labels.set('__home', {el: outer, lat: home.lat, lng: home.lng});
  syncLabels();
}

function applyHost(h, isNew) {
  const prev = state.hosts.get(h.host);
  state.hosts.set(h.host, h);
  if (h.geo && (!prev || !prev.geo || prev.kind !== h.kind)) {
    arcs = arcs.filter((a) => a.key !== `p:${h.host}`);
    arcs.push(persistentArc(h));
    syncArcs();
  }
  upsertLabel(h);
  renderRow(h, isNew);
  return !prev;
}

function onMessage(msg) {
  if (msg.type === 'snapshot') {
    state.meta = msg.meta;
    state.totals = msg.totals;
    if (!state.home) setHome(msg.home);
    $('cmd').textContent = msg.meta.command.split('\n')[0];
    $('mode').textContent = `${msg.meta.mode} · ${msg.meta.allowCount} allow rules`;
    [...msg.hosts].sort((a, b) => a.last - b.last).forEach((h) => applyHost(h, true));
    if (msg.meta.endedAt) finish(msg.meta);
    renderTotals();
  } else if (msg.type === 'event') {
    state.totals = msg.totals;
    const firstTime = applyHost(msg.host, true);
    renderTotals();
    if (msg.host.geo) {
      flight(msg.host);
      if (msg.event.kind === 'block') flyTo(msg.host.geo, true);
      else if (firstTime) flyTo(msg.host.geo, false);
    }
    if (msg.event.kind === 'block') toast(msg.event);
  } else if (msg.type === 'bytes') {
    state.totals = msg.totals;
    const h = state.hosts.get(msg.host);
    if (h) {
      h.up = msg.up;
      h.down = msg.down;
      renderRow(h, false);
    }
    renderTotals();
  } else if (msg.type === 'exit') {
    finish(msg.meta);
  }
}

function finish(meta) {
  state.meta = meta;
  $('live-dot').className = 'dot done';
  $('status-text').textContent = `finished · exit ${meta.exitCode}`;
}

setInterval(() => {
  if (!state.meta) return;
  const end = state.meta.endedAt || Date.now();
  const s = Math.max(0, Math.floor((end - state.meta.startedAt) / 1000));
  $('elapsed').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}, 500);

const es = new EventSource(`events?t=${encodeURIComponent(params.get('t') || '')}`);
es.onmessage = (m) => onMessage(JSON.parse(m.data));
