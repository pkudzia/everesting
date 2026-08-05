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
let liveTrail;
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
  wireFacts();

  pollLive();
  setInterval(pollLive, LIVE_POLL_MS);
  pollWeather();
  setInterval(pollWeather, WEATHER_POLL_MS);
}

/* ---------------- calories, calibrated to the weather ----------------
   Vertical metabolic cost of steep uphill walking is ~45 J per kg per vertical
   metre (Minetti et al. 2002, J Appl Physiol). At 86 kg (190 lb) that is
   0.93 kcal per metre climbed. Weather nudges the bill: thermoregulation in
   heat or cold, wet trail, wind. Descent is by gondola, so it's free. */

const MASS_KG = 86.2; // 190 lb
const KCAL_PER_VM = (MASS_KG * 45) / 4184; // ≈ 0.93
const KCAL_PER_PIEROGI = 80;
const WEATHER_POLL_MS = 15 * 60_000;
const WEATHER_URL =
  'https://api.open-meteo.com/v1/forecast?latitude=49.675&longitude=-123.156' +
  '&current=temperature_2m,precipitation,wind_speed_10m';

let weather = null; // { tempC, precip, windKmh }
let lastGained = null;

async function pollWeather() {
  try {
    const res = await fetch(WEATHER_URL);
    if (!res.ok) return;
    const j = await res.json();
    weather = {
      tempC: j.current.temperature_2m,
      precip: j.current.precipitation,
      windKmh: j.current.wind_speed_10m,
    };
    if (lastGained != null) renderCalories(lastGained);
  } catch { /* keep the last reading */ }
}

/** Multiplier ≥ 1 plus a short human-readable reason. */
function weatherFactor() {
  if (!weather) return { f: 1, why: '' };
  let f = 1;
  const why = [];
  if (weather.tempC >= 30) { f += 0.10; why.push(`+10% for ${Math.round(weather.tempC)}°C heat`); }
  else if (weather.tempC >= 25) { f += 0.05; why.push(`+5% for ${Math.round(weather.tempC)}°C heat`); }
  else if (weather.tempC <= 5) { f += 0.05; why.push(`+5% for ${Math.round(weather.tempC)}°C cold`); }
  if (weather.precip > 0) { f += 0.03; why.push('+3% for a wet trail'); }
  if (weather.windKmh > 25) { f += 0.02; why.push('+2% for wind'); }
  if (!why.length) why.push(`no surcharge at ${Math.round(weather.tempC)}°C`);
  return { f, why: why.join(', ') };
}

function renderCalories(gained) {
  lastGained = gained;
  const box = $('#live-cal');
  const { f, why } = weatherFactor();
  const kcal = Math.round(gained * KCAL_PER_VM * f);
  const pierogi = Math.round(kcal / KCAL_PER_PIEROGI);
  box.hidden = false;
  box.textContent =
    `≈ ${num(kcal)} kcal of climbing so far — about ${num(pierogi)} pierogi. ` +
    `(45 J per kg per vertical metre at 86 kg${weather ? `, ${why}` : ''}. Gondola descents are free.)`;
}

/* ---------------- biomechanics facts ---------------- */

const FACTS = [
  'Muscles turn only about a quarter of their fuel into climbing. The other 75% becomes heat, which is why everesting is also a cooling problem.',
  'Going down damages muscle more than going up. Lowering the body loads muscles while they lengthen (eccentric contractions), which tears more fibres than climbing does. Taking the gondola down is not lazy — it is peer-reviewed.',
  'Above roughly a 30% grade it costs less energy to walk than to run, and everyone converges to nearly the same speed. On the 76% headwall, sprinting is not on the menu for anyone.',
  'As calf muscles fatigue, the body quietly shifts work uphill to the hips — a distal-to-proximal redistribution. If my stride looks weirder every lap, that is the nervous system renegotiating the contract.',
  'The Achilles tendon returns roughly a third of the elastic energy stored each stride, for free, like a spring. Tendons do not fatigue the way muscles do — they are the most reliable teammate on this hill.',
  'A kilogram on your feet costs several times more energy than a kilogram on your back, which is why light shoes matter more than a light pack.',
  'The body stores only ~2,000 kcal of ready carbohydrate, and this day costs over 8,000. The difference has to be eaten while climbing — roughly a snack every 20 minutes, all day.',
  'The energetically optimal grade for gaining elevation is about 25%. These trails average 20–30%, which means they are, by accident, near-perfect climbing machines.',
  'Fatigue is not just in the muscles: the brain reduces its drive to them to protect the system, which is why encouragement at the trailhead measurably helps. This is your formal invitation.',
];

function wireFacts() {
  const text = $('#fact-text');
  let i = Math.floor(Math.random() * FACTS.length);
  const show = () => { text.textContent = FACTS[i % FACTS.length]; };
  $('#fact-next').addEventListener('click', () => { i += 1; show(); });
  show();
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
    $('#live-pace').hidden = true;
    if (liveMarker && map.hasLayer(liveMarker)) map.removeLayer(liveMarker);
    if (liveTrail && map.hasLayer(liveTrail)) map.removeLayer(liveTrail);
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
    renderCalories(gained);
  }

  renderPace(loc);

  // Connected breadcrumb trail — where Pawel has actually been today.
  if (Array.isArray(loc.trail) && loc.trail.length > 1) {
    if (!liveTrail) {
      liveTrail = L.polyline(loc.trail, {
        color: '#f76707', weight: 4, opacity: 0.85,
        dashArray: '1 8', lineCap: 'round', lineJoin: 'round',
      });
    } else {
      liveTrail.setLatLngs(loc.trail);
    }
    if (!map.hasLayer(liveTrail)) liveTrail.addTo(map);
    liveTrail.bringToFront();
  }

  if (!liveMarker) {
    liveMarker = L.marker([loc.lat, loc.lon], { icon: liveIcon(), zIndexOffset: 900 });
    liveMarker.bindTooltip('Pawel is HERE', { direction: 'top', offset: [0, -18] });
  }
  liveMarker.setLatLng([loc.lat, loc.lon]);
  if (!map.hasLayer(liveMarker)) liveMarker.addTo(map);
}

/** Climbing pace from ascent-only time — gondola rides and rests don't count. */
function renderPace(loc) {
  const box = $('#live-pace');
  if (!loc.climb_s || loc.climb_s < 300 || !loc.gained_m || loc.gained_m < 100) {
    box.hidden = true;
    return;
  }
  const paceMh = loc.gained_m / (loc.climb_s / 3600);
  const avgLapGain = challenge.totals.gain_m / challenge.totals.laps; // ~863 m
  const minPerLap = (avgLapGain / paceMh) * 60;
  const pct = Math.min(100, (loc.gained_m / challenge.target_m) * 100);
  const lapsEquiv = (loc.gained_m / avgLapGain).toFixed(1);
  box.hidden = false;
  box.textContent =
    `${pct.toFixed(0)}% done — the climbing of ${lapsEquiv} laps. ` +
    `Pace ${num(Math.round(paceMh))} m/h of ascent, about ${Math.round(minPerLap)} min ` +
    `of climbing per lap (gondola rides and snack breaks not counted).`;
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
      '<svg width="36" height="36" viewBox="0 0 24 24" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="10" fill="#f76707" stroke="#fff" stroke-width="3"/>' +
      '<circle cx="12" cy="12" r="3.6" fill="#fff"/></svg>',
    iconSize: [36, 36],
    iconAnchor: [18, 18],
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
