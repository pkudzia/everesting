/* Event page: live position, manually completed climbs, map, and comments. */

const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const num = (value) => value.toLocaleString('en-CA');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const LIVE_API_URL = 'https://api.github.com/repos/pkudzia/everesting/contents/location.json?ref=live';
const LIVE_RAW_URL = 'https://raw.githubusercontent.com/pkudzia/everesting/live/location.json';
const LIVE_POLL_MS = 75_000;
const LIVE_FRESH_MS = 10 * 60_000;
const WALL_API = 'https://everesting-wall.vercel.app/api/wall';
const WALL_POLL_MS = 60_000;

let map;
let liveMarker;
let liveTrail;
let challenge;

init();

async function init() {
  try {
    const response = await fetch('challenge.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    challenge = await response.json();
  } catch {
    $('#live-status').textContent = 'The tracker could not load. Please refresh the page.';
    return;
  }

  renderHeroFigure(challenge.target_m);
  renderMap(challenge);
  wireWall();
  pollLive();
  setInterval(pollLive, LIVE_POLL_MS);
}

function countUp(node, target) {
  if (reducedMotion) {
    node.textContent = num(target);
    return;
  }
  const duration = 1000;
  let start;
  const step = (time) => {
    if (start === undefined) start = time;
    const progress = Math.min(1, (time - start) / duration);
    node.textContent = num(Math.round(target * (1 - Math.pow(1 - progress, 3))));
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderHeroFigure(target) {
  const figure = $('#hero-figure');
  const value = document.createTextNode('0');
  figure.replaceChildren(value, el('span', 'unit', ' m'));
  countUp({ set textContent(text) { value.textContent = text; } }, target);
}

async function pollLive() {
  let location;
  try {
    const response = await fetch(LIVE_API_URL, {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github.raw+json' },
    });
    if (!response.ok) throw new Error();
    location = await response.json();
  } catch {
    try {
      const response = await fetch(LIVE_RAW_URL, { cache: 'no-store' });
      if (!response.ok) throw new Error();
      location = await response.json();
    } catch {
      setLive(null);
      return;
    }
  }
  setLive(location);
}

function setLive(location) {
  const dot = $('#live-dot');
  const status = $('#live-status');
  const when = $('#live-when');
  const progress = $('#progress');
  const summary = $('#lap-summary');

  if (!location) {
    dot.classList.remove('on');
    when.textContent = '';
    status.textContent = 'No update yet. Check back when the event starts.';
    progress.hidden = true;
    summary.hidden = true;
    return;
  }

  const age = location.time ? Date.now() - Date.parse(location.time) : Infinity;
  const fresh = location.active && age < LIVE_FRESH_MS;
  const oldCurrentLap = Number.isFinite(Number(location.lap)) ? Number(location.lap) : 1;
  const rawCompleted = location.completed_laps ?? Math.max(0, oldCurrentLap - 1);
  const completed = Math.max(0, Math.min(challenge.totals.laps, Math.round(Number(rawCompleted) || 0)));
  const total = challenge.totals.laps;

  dot.classList.toggle('on', fresh);
  when.textContent = Number.isFinite(age) ? `updated ${agoText(age)}` : '';
  summary.hidden = false;
  $('#laps-completed').textContent = completed;
  progress.hidden = false;
  $('#progress-bar').style.width = `${(completed / total) * 100}%`;
  $('#progress-label').textContent = `${completed} of ${total} climbs finished`;

  if (completed >= total) {
    status.textContent = 'All ten climbs are finished!';
  } else if (fresh) {
    status.textContent = `Pawel is on climb ${completed + 1}.`;
  } else if (location.active) {
    status.textContent = 'The signal is quiet. The map shows his last position.';
  } else {
    status.textContent = completed ? 'Tracking is paused.' : 'The event has not started yet.';
  }
  if (location.msg) status.textContent += ` ${location.msg}`;

  renderTrail(location.trail);
  renderMarker(location, fresh);
}

function agoText(milliseconds) {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}

function renderTrail(points) {
  if (!Array.isArray(points) || points.length < 2) return;
  if (!liveTrail) {
    liveTrail = L.polyline(points, {
      color: '#22262e', weight: 4, opacity: 0.9,
      dashArray: '0.1 9', lineCap: 'round', lineJoin: 'round',
    }).addTo(map);
  } else {
    liveTrail.setLatLngs(points);
    if (!map.hasLayer(liveTrail)) liveTrail.addTo(map);
  }
  liveTrail.bringToFront();
}

function renderMarker(location, fresh) {
  if (!Number.isFinite(location.lat) || !Number.isFinite(location.lon)) return;
  if (!liveMarker) {
    liveMarker = L.marker([location.lat, location.lon], {
      icon: liveIcon(), zIndexOffset: 900,
    }).addTo(map);
  }
  liveMarker.setLatLng([location.lat, location.lon]);
  if (!map.hasLayer(liveMarker)) liveMarker.addTo(map);
  liveMarker.unbindTooltip().bindTooltip(
    fresh ? 'Pawel is here' : 'Last known position',
    { direction: 'top', offset: [0, -18] },
  );
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

function renderMap(data) {
  map = L.map('map', { scrollWheelZoom: false, zoomSnap: 0, zoomDelta: 0.5 });
  const osm = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: `${osm}, <a href="https://viewfinderpanoramas.org">SRTM</a>`,
    maxZoom: 17,
  }).addTo(map);

  for (const route of data.variations) {
    L.polyline(route.track, {
      color: '#fff', weight: 6, opacity: 0.72, lineJoin: 'round',
    }).addTo(map);
    L.polyline(route.track, {
      color: route.color, weight: 3, opacity: 0.78, lineJoin: 'round',
    }).addTo(map);
  }
  map.fitBounds(data.bounds, { padding: [30, 30] });
}

function wireWall() {
  const form = $('#wall-form');
  const photoInput = $('#wall-photo');
  const photoLabel = $('#wall-photo-label');
  const feedback = $('#wall-feedback');
  let photoData = null;

  photoInput.addEventListener('change', async () => {
    const file = photoInput.files[0];
    if (!file) {
      photoData = null;
      photoLabel.textContent = 'Add a photo';
      return;
    }
    photoLabel.textContent = 'Preparing…';
    try {
      photoData = await shrinkImage(file);
      photoLabel.textContent = 'Photo ready ✓';
    } catch {
      photoData = null;
      photoLabel.textContent = 'Add a photo';
      feedback.textContent = 'Could not read that photo. Try another one.';
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = $('#wall-message').value.trim();
    if (!message && !photoData) {
      feedback.textContent = 'Write something or add a photo.';
      return;
    }
    const button = $('#wall-post');
    button.disabled = true;
    feedback.textContent = 'Posting…';
    try {
      const response = await fetch(WALL_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('#wall-name').value,
          message,
          photo: photoData,
          website: $('#wall-website').value,
        }),
      });
      const post = await response.json();
      if (!response.ok) throw new Error(post.error || `HTTP ${response.status}`);
      feedback.textContent = '';
      $('#wall-message').value = '';
      photoInput.value = '';
      photoData = null;
      photoLabel.textContent = 'Add a photo';
      $('#wall-posts').prepend(wallCard(post));
    } catch (error) {
      feedback.textContent = `That did not post (${error.message}). Try again.`;
    }
    button.disabled = false;
  });

  loadWall();
  setInterval(loadWall, WALL_POLL_MS);
}

function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('bad image'));
    };
    image.src = url;
  });
}

async function loadWall() {
  try {
    const response = await fetch(`${WALL_API}?t=${Date.now()}`);
    if (!response.ok) return;
    const data = await response.json();
    $('#wall-posts').replaceChildren(...data.posts.map(wallCard));
  } catch {
    // Keep any comments already on screen and try again next minute.
  }
}

function wallCard(post) {
  const card = el('article', 'wall-card');
  if (post.photo) {
    const image = el('img', 'wall-img');
    image.src = post.photo;
    image.alt = `Photo from ${post.name}`;
    image.loading = 'lazy';
    card.append(image);
  }
  if (post.message) card.append(el('p', 'wall-msg', post.message));
  const meta = el('p', 'wall-meta');
  meta.append(el('strong', null, post.name));
  const age = Date.now() - Date.parse(post.time);
  if (Number.isFinite(age)) meta.append(document.createTextNode(` · ${agoText(age)}`));
  card.append(meta);
  return card;
}
