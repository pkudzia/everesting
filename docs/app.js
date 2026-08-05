/* Everesting on Foot — bare-bones page: live position, cheer wall, lap
   sign-ups, map. challenge.json is precomputed by build.py. */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const num = (n) => n.toLocaleString('en-CA');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

/* The tracker page commits location.json to the `live` branch, which GitHub
   Pages never builds. The API endpoint is never CDN-cached (60 unauth
   requests/hour per viewer IP; 75 s polling stays under); raw.githubusercontent
   is the fallback — its CDN ignores query strings, so it can lag ~5 min. */
const LIVE_API_URL = 'https://api.github.com/repos/pkudzia/everesting/contents/location.json?ref=live';
const LIVE_RAW_URL = 'https://raw.githubusercontent.com/pkudzia/everesting/live/location.json';
const LIVE_POLL_MS = 75_000;
const LIVE_FRESH_MS = 10 * 60_000;

/* Cheer wall + lap sign-ups: one Vercel function, storage in Vercel Blob. */
const WALL_API = 'https://everesting-wall.vercel.app/api/wall';
const WALL_POLL_MS = 60_000;

let map;
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
    $('#laps').prepend(
      el('p', 'note', `Could not load route data (${err.message}). If you are opening this file from disk, run: python3 -m http.server`)
    );
    return;
  }

  renderHeroFigure(challenge);
  renderMap(challenge);
  renderLegend(challenge);
  renderSchedule(challenge);
  wireWall();

  pollLive();
  setInterval(pollLive, LIVE_POLL_MS);
}

/* ---------------- hero figure ---------------- */

function countUp(node, target) {
  if (reducedMotion) { node.textContent = num(target); return; }
  const dur = 1200;
  let start;
  const step = (t) => {
    if (start === undefined) start = t;
    const p = Math.min(1, (t - start) / dur);
    node.textContent = num(Math.round(target * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderHeroFigure(c) {
  const fig = $('#hero-figure');
  const value = document.createTextNode('0');
  const unit = el('span', 'unit', ' m');
  fig.replaceChildren(value, unit);
  countUp({ set textContent(v) { value.textContent = v; } }, c.target_m);
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
      status.textContent = 'Not live right now. This lights up on the day.';
    }
    if (liveMarker && map.hasLayer(liveMarker)) map.removeLayer(liveMarker);
    return;
  }

  dot.classList.add('on');
  when.textContent = `updated ${agoText(age)}`;

  const bits = [];
  if (loc.lap) bits.push(`lap ${loc.lap} of ${challenge.totals.laps}`);
  if (loc.alt != null) bits.push(`${num(Math.round(loc.alt))} m elevation`);
  status.textContent = bits.length ? `On the mountain — ${bits.join(' · ')}.` : 'On the mountain.';
  if (loc.msg) status.textContent += ` “${loc.msg}”`;

  if (loc.gained_m != null) {
    progress.hidden = false;
    const gained = Math.round(loc.gained_m);
    const left = Math.max(0, challenge.target_m - gained);
    const pct = Math.min(100, (gained / challenge.target_m) * 100);
    $('#progress-bar').style.width = `${pct.toFixed(1)}%`;
    $('#progress-label').textContent = left
      ? `${num(gained)} m climbed · ${num(left)} m to go`
      : `${num(gained)} m — done. DONE!`;
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
  map = L.map('map', { scrollWheelZoom: false, zoomSnap: 0, zoomDelta: 0.5 });

  const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: `${osmAttr}, <a href="https://viewfinderpanoramas.org">SRTM</a> | &copy; <a href="https://opentopomap.org">OpenTopoMap</a>`,
    maxZoom: 17,
  }).addTo(map);

  for (const v of c.variations) {
    const casing = L.polyline(v.track, {
      color: '#fff', weight: 6, opacity: 0.8, lineJoin: 'round',
    }).addTo(map);
    const line = L.polyline(v.track, {
      color: v.color, weight: 3, opacity: 1, lineJoin: 'round',
    }).addTo(map);
    line.bindTooltip(`${v.title} — ${v.distance_km} km, +${v.gain_m} m`, { sticky: true });
    varLayers.set(v.num, { casing, line, v });
  }

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
        casing.bringToFront();
        line.bringToFront();
        map.fitBounds(v.bounds, { padding: [30, 30] });
      }
    }
    if (numSel === 'all') map.fitBounds(c.bounds, { padding: [30, 30] });
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

  mk('All trails', null, 'all');
  c.variations.forEach((v) => mk(`V${v.num}`, v.color, v.num));
}

/* ---------------- lap schedule + anonymous joins ---------------- */

function renderSchedule(c) {
  const byNum = new Map(c.variations.map((v) => [v.num, v]));
  const tbody = $('#plan-table tbody');
  for (const row of c.plan) {
    const v = byNum.get(row.variation);
    const tr = el('tr');
    tr.append(el('td', 'mono', String(row.lap)));
    tr.append(el('td', 'mono', row.start));

    const vd = el('td');
    const chip = el('span', 'v-chip', `V${row.variation}`);
    chip.style.background = v.color;
    chip.title = `${v.distance_km} km, +${v.gain_m} m`;
    vd.append(chip);
    tr.append(vd);

    const names = el('td', 'crew-names');
    names.dataset.lap = String(row.lap);
    tr.append(names);

    const joinTd = el('td');
    const join = el('button', 'join-link', 'Join');
    join.type = 'button';
    join.addEventListener('click', () => joinLap(row.lap, join));
    joinTd.append(join);
    tr.append(joinTd);

    tbody.append(tr);
  }
}

async function joinLap(lap, btn) {
  const feedback = $('#join-feedback');
  btn.disabled = true;
  feedback.textContent = '';
  try {
    const res = await fetch(WALL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: $('#join-name').value, lap, website: $('#wall-website').value }),
    });
    const join = await res.json();
    if (!res.ok) throw new Error(join.error || `HTTP ${res.status}`);
    const span = document.querySelector(`.crew-names[data-lap="${lap}"]`);
    span.textContent = span.textContent ? `${span.textContent}, ${join.name}` : join.name;
    feedback.textContent = `See you on lap ${lap}, ${join.name}!`;
  } catch (err) {
    feedback.textContent = `That didn't work (${err.message}). Try again?`;
  }
  btn.disabled = false;
}

function renderJoins(joins) {
  const byLap = new Map();
  for (const j of joins) {
    if (!byLap.has(j.lap)) byLap.set(j.lap, []);
    byLap.get(j.lap).push(j.name);
  }
  document.querySelectorAll('.crew-names').forEach((span) => {
    const crew = byLap.get(+span.dataset.lap) || [];
    span.textContent = crew.join(', ');
  });
}

/* ---------------- cheer wall ---------------- */

function wireWall() {
  const form = $('#wall-form');
  const photoInput = $('#wall-photo');
  const photoLabel = $('#wall-photo-label');
  const feedback = $('#wall-feedback');
  let photoData = null;

  photoInput.addEventListener('change', async () => {
    const file = photoInput.files[0];
    if (!file) { photoData = null; photoLabel.textContent = 'Add a photo'; return; }
    photoLabel.textContent = 'Squishing…';
    try {
      photoData = await shrinkImage(file);
      photoLabel.textContent = 'Photo ready ✓';
    } catch {
      photoData = null;
      photoLabel.textContent = 'Add a photo';
      feedback.textContent = 'Could not read that image — try another one.';
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const message = $('#wall-message').value.trim();
    if (!message && !photoData) { feedback.textContent = 'Say something or show something.'; return; }
    const btn = $('#wall-post');
    btn.disabled = true;
    feedback.textContent = 'Posting…';
    try {
      const res = await fetch(WALL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('#wall-name').value,
          message,
          photo: photoData,
          website: $('#wall-website').value, // honeypot, stays empty for humans
        }),
      });
      const post = await res.json();
      if (!res.ok) throw new Error(post.error || `HTTP ${res.status}`);
      feedback.textContent = '';
      $('#wall-message').value = '';
      photoInput.value = '';
      photoData = null;
      photoLabel.textContent = 'Add a photo';
      $('#wall-posts').prepend(wallCard(post));
    } catch (err) {
      feedback.textContent = `That didn't post (${err.message}). Try again?`;
    }
    btn.disabled = false;
  });

  loadWall();
  setInterval(loadWall, WALL_POLL_MS);
}

/** Downscale to ≤1600px JPEG so posts stay small on trail LTE. */
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}

async function loadWall() {
  let data;
  try {
    const res = await fetch(`${WALL_API}?t=${Date.now()}`);
    if (!res.ok) return;
    data = await res.json();
  } catch { return; }
  $('#wall-posts').replaceChildren(...data.posts.map(wallCard));
  renderJoins(data.joins);
}

function wallCard(post) {
  const card = el('article', 'wall-card');
  if (post.photo) {
    const img = el('img', 'wall-img');
    img.src = post.photo;
    img.alt = `Photo from ${post.name}`;
    img.loading = 'lazy';
    card.append(img);
  }
  if (post.message) card.append(el('p', 'wall-msg', post.message));
  const meta = el('p', 'wall-meta');
  meta.append(el('strong', null, post.name));
  const age = Date.now() - Date.parse(post.time);
  if (Number.isFinite(age)) meta.append(document.createTextNode(` · ${agoText(age)}`));
  card.append(meta);
  return card;
}
