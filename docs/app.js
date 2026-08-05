/* Everesting on Foot — renders challenge.json into a map, lap plan, stats and
   elevation profiles, and polls the live branch for my phone's position.
   No build step, no framework. challenge.json is precomputed by build.py. */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const num = (n) => n.toLocaleString('en-CA');

/* The tracker page commits location.json to the `live` branch, which GitHub
   Pages never builds, so updates land without triggering site rebuilds.

   Freshness: the API endpoint is never CDN-cached, so it is the primary
   source (60 unauthenticated requests/hour per viewer IP; polling at 75 s
   stays under that). raw.githubusercontent is the fallback for rate-limited
   viewers — Fastly ignores query strings there, so it can lag up to 5 min. */
const LIVE_API_URL = 'https://api.github.com/repos/pkudzia/everesting/contents/location.json?ref=live';
const LIVE_RAW_URL = 'https://raw.githubusercontent.com/pkudzia/everesting/live/location.json';
const LIVE_POLL_MS = 75_000;
const LIVE_FRESH_MS = 10 * 60_000; // older than this counts as "not live"

let map;
let hoverMarker;
let liveMarker;
let challenge;
const varLayers = new Map();

init();

async function init() {
  try {
    const res = await fetch('challenge.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    challenge = await res.json();
  } catch (err) {
    $('#variations').append(
      el('p', 'note', `Could not load route data (${err.message}). If you are opening this file directly from disk, run a local server instead: python3 -m http.server`)
    );
    return;
  }

  $('#challenge-sub').textContent = challenge.subtitle;

  renderHeroFigure(challenge);
  renderTotals(challenge);
  renderMarquee(challenge);
  renderMap(challenge);
  renderLegend(challenge);
  renderPlan(challenge);
  challenge.variations.forEach((v) => $('#variations').append(renderVariation(v)));
  wireStarBurst();

  pollLive();
  setInterval(pollLive, LIVE_POLL_MS);
}

/* ---------------- hero figure + celebrations ---------------- */

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Tick a numeral from 0 to target on first view. Reduced motion renders instantly. */
function countUp(node, target, format = (n) => num(n)) {
  if (reducedMotion) { node.textContent = format(target); return; }
  const dur = 1200;
  const decimals = Number.isInteger(target) ? 0 : 1;
  let start;
  const step = (t) => {
    if (start === undefined) start = t;
    const p = Math.min(1, (t - start) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    const v = target * eased;
    node.textContent = format(decimals ? +v.toFixed(decimals) : Math.round(v));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderHeroFigure(c) {
  const fig = $('#hero-figure');
  const target = c.target_m;
  const value = document.createTextNode('0');
  const unit = el('span', 'unit', ' m');
  fig.replaceChildren(value, unit);
  countUp({ set textContent(v) { value.textContent = v; } }, target);
}

function renderMarquee(c) {
  const track = $('#marquee-track');
  const bits = [
    `${num(c.target_m)} metres`,
    `${c.totals.laps} laps`,
    'one day',
    'come walk a lap',
    `${num(c.totals.distance_km)} km uphill`,
    'bring snacks',
  ];
  const run = bits.map((b) => `${b}<span class="sep">▲</span>`).join('');
  track.innerHTML = run + run; // doubled so the -50% loop is seamless
}

function wireStarBurst() {
  $('#cta-live').addEventListener('click', (e) => {
    if (reducedMotion) return;
    const star = el('span', 'star-burst');
    star.style.left = `${e.offsetX - 12}px`;
    star.style.top = `${e.offsetY - 12}px`;
    e.currentTarget.append(star);
    setTimeout(() => star.remove(), 450);
  });
}

/* ---------------- totals ---------------- */

function renderTotals(c) {
  const items = [
    ['Planned climbing', c.totals.gain_m, 'm'],
    ['Laps', c.totals.laps, ''],
    ['Uphill distance', c.totals.distance_km, 'km'],
    ['Steepest pitch', Math.max(...c.variations.map((v) => v.max_grade_pct)), '%'],
  ];
  const dl = $('#totals');
  for (const [k, v, unit] of items) {
    const box = el('div');
    box.append(el('dt', null, k));
    const dd = el('dd', null, '0');
    if (unit) {
      const val = el('span', null, '0');
      dd.textContent = '';
      dd.append(val, el('small', null, ` ${unit}`));
      countUp(val, v);
    } else {
      countUp(dd, v);
    }
    box.append(dd);
    dl.append(box);
  }
}

/* ---------------- live tracker ---------------- */

async function pollLive() {
  let loc;
  try {
    const res = await fetch(LIVE_API_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github.raw+json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    loc = await res.json();
  } catch {
    try {
      const res = await fetch(LIVE_RAW_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      loc = await res.json();
    } catch {
      setLive(null);
      return;
    }
  }
  setLive(loc);
}

function setLive(loc) {
  const dot = $('#live-dot');
  const status = $('#live-status');
  const when = $('#live-when');
  const progress = $('#progress');

  const age = loc && loc.time ? Date.now() - Date.parse(loc.time) : Infinity;
  const fresh = loc && loc.active && age < LIVE_FRESH_MS;

  if (!fresh) {
    dot.classList.remove('on');
    when.textContent = '';
    progress.hidden = true;
    if (loc && loc.time && !loc.active) {
      status.textContent = `Not live right now. Last signal ${agoText(age)}.`;
    } else {
      status.textContent = 'Not live right now. This lights up on challenge day.';
    }
    if (liveMarker && map.hasLayer(liveMarker)) map.removeLayer(liveMarker);
    return;
  }

  dot.classList.add('on');
  when.textContent = `updated ${agoText(age)}`;

  const bits = [];
  if (loc.lap) bits.push(`lap ${loc.lap} of ${challenge.totals.laps}`);
  if (loc.alt != null) bits.push(`${num(Math.round(loc.alt))} m elevation`);
  if (loc.gained_m != null) bits.push(`${num(Math.round(loc.gained_m))} m climbed`);
  status.textContent = bits.length ? `On the mountain — ${bits.join(' · ')}.` : 'On the mountain.';
  if (loc.msg) status.textContent += ` “${loc.msg}”`;

  if (loc.gained_m != null) {
    progress.hidden = false;
    const pct = Math.min(100, (loc.gained_m / challenge.target_m) * 100);
    $('#progress-bar').style.width = `${pct.toFixed(1)}%`;
    $('#progress-label').textContent =
      `${num(Math.round(loc.gained_m))} / ${num(challenge.target_m)} m (${pct.toFixed(0)}%)`;
  }

  if (!liveMarker) {
    liveMarker = L.marker([loc.lat, loc.lon], { icon: liveIcon(), zIndexOffset: 900 });
    liveMarker.bindTooltip('Pawel is here', { direction: 'top', offset: [0, -14] });
  }
  liveMarker.setLatLng([loc.lat, loc.lon]);
  if (!map.hasLayer(liveMarker)) liveMarker.addTo(map);
}

function agoText(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min === 1) return '1 minute ago';
  if (min < 60) return `${min} minutes ago`;
  const h = Math.round(min / 60);
  return h === 1 ? '1 hour ago' : `${h} hours ago`;
}

function liveIcon() {
  return L.divIcon({
    className: 'map-pin live-pin',
    html:
      '<span class="pulse"></span>' +
      '<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="10" fill="#f76707" stroke="#fff" stroke-width="2.5"/>' +
      '<circle cx="12" cy="12" r="3.4" fill="#fff"/></svg>',
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

/* ---------------- map ---------------- */

function renderMap(c) {
  // zoomSnap 0 lets fitBounds use fractional zoom, so the hill fills the
  // container instead of rounding down to a half-empty whole zoom level.
  map = L.map('map', { scrollWheelZoom: false, zoomSnap: 0, zoomDelta: 0.5 });

  const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

  const colour = L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: `${osmAttr} &copy; <a href="https://carto.com/attributions">CARTO</a>`,
    maxZoom: 19,
  });

  // Terrain is the default here: eight lines up the same hillside only make
  // sense with contours behind them.
  const terrain = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: `${osmAttr}, <a href="https://viewfinderpanoramas.org">SRTM</a> | &copy; <a href="https://opentopomap.org">OpenTopoMap</a>`,
    maxZoom: 17,
  }).addTo(map);

  L.control.layers({ Terrain: terrain, Colour: colour }, null, { position: 'topright' }).addTo(map);

  for (const v of c.variations) {
    const casing = L.polyline(v.track, {
      color: '#fff', weight: 6, opacity: 0.8, lineJoin: 'round',
    }).addTo(map);
    const line = L.polyline(v.track, {
      color: v.color, weight: 3, opacity: 1, lineJoin: 'round',
    }).addTo(map);
    line.bindTooltip(`${v.title} — ${v.distance_km} km, +${v.gain_m} m`, { sticky: true });
    line.on('click', () => {
      document.getElementById(`variation-${v.num}`).scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    varLayers.set(v.num, { casing, line, v });
  }

  hoverMarker = L.circleMarker([0, 0], {
    radius: 6, color: '#fff', weight: 2, fillColor: '#f76707', fillOpacity: 1,
  });

  map.fitBounds(c.bounds, { padding: [30, 30] });
}

function renderLegend(c) {
  const legend = $('#legend');
  const buttons = [];

  const setFocus = (numSel) => {
    buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(numSel))));
    for (const [n, { casing, line, v }] of varLayers) {
      const on = numSel === 'all' || n === numSel;
      line.setStyle({ opacity: on ? 1 : 0.15, weight: on ? 3.5 : 2 });
      casing.setStyle({ opacity: on ? 0.8 : 0.08 });
      if (n === numSel) {
        // The variations share long stretches of trail; raising the focused
        // one keeps it visible along everything they have in common.
        casing.bringToFront();
        line.bringToFront();
        map.fitBounds(v.bounds, { padding: [30, 30] });
      }
    }
    if (numSel === 'all') map.fitBounds(c.bounds, { padding: [30, 30] });
    // The live marker must stay on top of whatever was raised.
    if (liveMarker && map.hasLayer(liveMarker)) liveMarker.setZIndexOffset(900);
  };

  const mk = (label, color, value) => {
    const b = el('button', 'legend-btn');
    b.type = 'button';
    b.dataset.v = String(value);
    b.setAttribute('aria-pressed', String(value === 'all'));
    if (color) {
      const dot = el('span', 'dot');
      dot.style.background = color;
      b.append(dot);
    }
    b.append(document.createTextNode(label));
    b.addEventListener('click', () => setFocus(value));
    legend.append(b);
    buttons.push(b);
  };

  mk('All eight', null, 'all');
  c.variations.forEach((v) => mk(`V${v.num}`, v.color, v.num));

  const hint = el('p', 'legend-hint',
    'The variations share stretches of the same hillside. Pick one to bring it to the front.');
  legend.after(hint);
}

/* ---------------- lap plan ---------------- */

function renderPlan(c) {
  $('#plan-note').textContent =
    `The running total crosses ${num(c.target_m)} m partway up lap ${c.totals.crossed_on_lap}. ` +
    `Finishing that lap banks ${num(c.totals.gain_m)} m, a ${num(c.totals.gain_m - c.target_m)} m ` +
    `buffer for when my watch and the map inevitably disagree.`;

  const byNum = new Map(c.variations.map((v) => [v.num, v]));
  const tbody = $('#plan-table tbody');
  for (const row of c.plan) {
    const v = byNum.get(row.variation);
    const tr = el('tr');
    if (row.cum_gain_m >= c.target_m) tr.className = 'past-target';
    tr.append(el('td', 'mono', String(row.lap)));

    const vd = el('td');
    const chip = el('span', 'v-chip', `V${row.variation}`);
    chip.style.background = v.color;
    vd.append(chip);
    tr.append(vd);

    tr.append(el('td', 'mono', `${row.distance_km} km`));
    tr.append(el('td', 'mono', `+${num(row.gain_m)} m`));
    tr.append(el('td', 'mono', `${num(row.cum_gain_m)} m`));
    tbody.append(tr);
  }
}

/* ---------------- variation cards ---------------- */

function renderVariation(v) {
  const card = el('section', 'day');
  card.id = `variation-${v.num}`;
  card.style.setProperty('--tint', v.color);

  const head = el('div', 'day-head');
  const badge = el('span', 'day-num', `V${v.num}`);
  badge.style.background = v.color;
  head.append(badge, el('h2', null, v.title));
  card.append(head);

  card.append(
    stats([
      ['Distance', String(v.distance_km), 'km'],
      ['Climbing', num(v.gain_m), 'm'],
      ['Top', num(v.max_ele_m), 'm'],
      ['Avg grade', v.avg_grade_pct.toFixed(1), '%'],
      ['Steepest', v.max_grade_pct.toFixed(1), '%'],
    ])
  );

  card.append(el('p', 'note', v.note));
  card.append(profile(v));
  card.append(downloadLink(v));
  return card;
}

function stats(rows) {
  const grid = el('div', 'stats');
  for (const [k, v, unit] of rows) {
    const cell = el('div', 'stat');
    cell.append(el('div', 'k', k));
    const val = el('div', 'v', v);
    if (unit) val.append(el('small', null, ` ${unit}`));
    cell.append(val);
    grid.append(cell);
  }
  return grid;
}

function downloadLink(v) {
  const a = el('a', 'dl');
  a.href = `gpx/${v.file}`;
  a.setAttribute('download', v.file);
  a.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  a.append(document.createTextNode(`Download V${v.num} GPX`));
  if (v.file_kb) a.append(el('span', 'dl-size', `${v.file_kb} KB`));
  return a;
}

/* ---------------- elevation profile ---------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD = { top: 12, right: 14, bottom: 20, left: 38 };

const node = (tag, attrs) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

/** Pick a round tick step so labels never crowd at the current width. */
function tickStep(maxKm, usableWidth) {
  const maxTicks = Math.max(2, Math.floor(usableWidth / 62));
  for (const step of [0.5, 1, 2, 5]) {
    if (maxKm / step <= maxTicks) return step;
  }
  return 5;
}

function profile(v) {
  const box = el('div', 'profile');
  const pts = v.profile; // [km, ele, lat, lon]
  const maxKm = pts[pts.length - 1][0];

  const eles = pts.map((p) => p[1]);
  const lo = Math.min(...eles);
  const hi = Math.max(...eles);
  const span = Math.max(hi - lo, 100);
  const yLo = Math.max(0, lo - span * 0.12);
  const yHi = hi + span * 0.12;

  const svg = node('svg', { role: 'img' });
  svg.setAttribute(
    'aria-label',
    `${v.title} elevation profile: ${v.distance_km} km, ${v.gain_m} metres of climbing, top ${v.max_ele_m} metres.`
  );

  const readout = el('div', 'readout');
  box.append(svg, readout);
  box.append(el('p', 'profile-hint', 'Hover or drag across the profile to trace your position on the map.'));

  let W = 0;
  let H = 0;
  let x = () => 0;
  let y = () => 0;
  let cursor = null;
  let dot = null;

  function draw() {
    // viewBox sized in real pixels, 1 unit = 1 px, so labels stay true at
    // any width instead of scaling with the container.
    W = Math.max(240, Math.round(box.clientWidth - 20));
    H = W < 520 ? 150 : 190;

    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.replaceChildren();

    const plotW = W - PAD.left - PAD.right;
    x = (km) => PAD.left + (km / maxKm) * plotW;
    y = (m) => PAD.top + (1 - (m - yLo) / (yHi - yLo)) * (H - PAD.top - PAD.bottom);

    const gradId = `grad-${v.num}`;
    const defs = node('defs', {});
    const grad = node('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' });
    grad.append(
      node('stop', { offset: '0%', 'stop-color': v.color, 'stop-opacity': '0.45' }),
      node('stop', { offset: '100%', 'stop-color': v.color, 'stop-opacity': '0.03' })
    );
    defs.append(grad);
    svg.append(defs);

    for (let i = 0; i <= 3; i++) {
      const m = yLo + ((yHi - yLo) * i) / 3;
      const yy = y(m);
      svg.append(node('line', { class: 'grid-line', x1: PAD.left, x2: W - PAD.right, y1: yy, y2: yy }));
      const t = node('text', { class: 'axis-label', x: PAD.left - 6, y: yy + 3.5, 'text-anchor': 'end' });
      t.textContent = Math.round(m);
      svg.append(t);
    }

    const step = tickStep(maxKm, plotW);
    const unitX = W - PAD.right;
    for (let km = 0; km <= maxKm; km += step) {
      if (unitX - x(km) < 44) continue;
      const t = node('text', { class: 'axis-label', x: x(km), y: H - 6, 'text-anchor': 'middle' });
      t.textContent = `${km}`;
      svg.append(t);
    }
    const unit = node('text', { class: 'axis-label', x: unitX, y: H - 6, 'text-anchor': 'end' });
    unit.textContent = `${maxKm.toFixed(1)} km`;
    svg.append(unit);

    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join('');
    svg.append(node('path', {
      d: `${line}L${x(maxKm).toFixed(1)} ${y(yLo)}L${x(0).toFixed(1)} ${y(yLo)}Z`,
      fill: `url(#${gradId})`, stroke: 'none',
    }));
    svg.append(node('path', {
      d: line, fill: 'none', stroke: v.color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));

    cursor = node('line', {
      x1: 0, x2: 0, y1: PAD.top, y2: H - PAD.bottom,
      stroke: 'currentColor', 'stroke-width': 1, opacity: 0,
    });
    dot = node('circle', { r: 3.5, fill: 'currentColor', opacity: 0, cx: 0, cy: 0 });
    svg.append(cursor, dot);
  }

  /* --- scrub interaction --- */

  const show = (clientX) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const vbX = ((clientX - rect.left) / rect.width) * W;
    const frac = Math.min(1, Math.max(0, (vbX - PAD.left) / (W - PAD.left - PAD.right)));
    const p = pts[Math.round(frac * (pts.length - 1))];

    cursor.setAttribute('x1', x(p[0]));
    cursor.setAttribute('x2', x(p[0]));
    cursor.setAttribute('opacity', 0.5);
    dot.setAttribute('cx', x(p[0]));
    dot.setAttribute('cy', y(p[1]));
    dot.setAttribute('opacity', 1);

    readout.textContent = `${p[0].toFixed(2)} km · ${Math.round(p[1])} m`;
    readout.classList.add('on');

    hoverMarker.setLatLng([p[2], p[3]]);
    hoverMarker.setStyle({ fillColor: v.color });
    if (!map.hasLayer(hoverMarker)) hoverMarker.addTo(map);
  };

  const hide = () => {
    cursor.setAttribute('opacity', 0);
    dot.setAttribute('opacity', 0);
    readout.classList.remove('on');
    if (map.hasLayer(hoverMarker)) map.removeLayer(hoverMarker);
  };

  box.addEventListener('pointermove', (e) => show(e.clientX));
  box.addEventListener('pointerdown', (e) => show(e.clientX));
  box.addEventListener('pointerleave', hide);
  box.addEventListener('pointercancel', hide);

  // Redraw on width change only; drawing itself resizes the box.
  let lastW = -1;
  const ro = new ResizeObserver(() => {
    const w = Math.round(box.clientWidth);
    if (w !== lastW) {
      lastW = w;
      draw();
    }
  });
  requestAnimationFrame(() => ro.observe(box));

  draw();
  return box;
}
