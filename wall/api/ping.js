/* GPS ingest and manual lap control for the live tracker.

   Location apps POST coordinates throughout the day. At the gondola, Pawel
   sends {action:"finish_lap"}; that deliberate tap is the only thing that
   changes the public completed-lap count. */

const OWNER = 'pkudzia';
const REPO = 'everesting';
const BRANCH = 'live';
const PATH = 'location.json';
const TOTAL_LAPS = 10;
const GAIN_THRESHOLD_M = 3;
const CLIMB_GAP_CAP_S = 120;
const CRUMB_MIN_M = 25;
const TRAIL_CAP = 1500;
const ALLOWED_ORIGINS = ['https://pkudzia.github.io', 'http://localhost:8765', 'http://localhost:8801'];

export default async function handler(req, res) {
  const origin = req.headers.origin;
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  if (!process.env.PING_KEY || (req.query.key || '') !== process.env.PING_KEY) {
    return res.status(401).json({ error: 'bad key' });
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });

  const body = req.body || {};
  if (body.action === 'status') {
    const current = await readLocation(token);
    if (!current.ok) return res.status(502).json({ error: `GitHub read ${current.status}` });
    return res.status(200).json({
      result: 'ok',
      completed_laps: completedLaps(current.location),
      state: trackerState(current.location),
      gained_m: manualGain(current.location),
      distance_km: manualDistance(current.location),
    });
  }
  if (['finish_lap', 'start_climb', 'set_gain', 'set_distance', 'undo_lap', 'offline'].includes(body.action)) {
    return handleAction(body, token, res);
  }

  const points = parsePoints(body);
  if (!points.length) return res.status(200).json({ result: 'ok' });
  points.sort((a, b) => a.t - b.t);

  const current = await readLocation(token);
  if (!current.ok) return res.status(502).json({ error: `GitHub read ${current.status}` });
  const { file, location: previous } = current;
  const state = {
    gained: previous.gained_m || 0,
    climbS: previous.climb_s || 0,
    trail: Array.isArray(previous.trail) ? previous.trail : [],
    completed: completedLaps(previous),
    lastAlt: numOrNull(previous.lastAlt),
    lastGainT: numOrNull(previous.lastGainT),
  };
  const lastSeen = previous.time ? Date.parse(previous.time) : 0;
  const freshPoints = points.filter((point) => point.t > lastSeen);
  if (!freshPoints.length) return res.status(200).json({ result: 'ok' });
  // After an event-day reset, Overland may resend a large buffered batch with
  // fresh timestamps. Seed the new trail from only its newest point once.
  const pointsToProcess = previous.reset_pending ? freshPoints.slice(-1) : freshPoints;

  for (const point of pointsToProcess) {
    if (point.alt != null) {
      if (state.lastAlt != null) {
        const change = point.alt - state.lastAlt;
        if (Math.abs(change) >= GAIN_THRESHOLD_M) {
          if (change > 0) {
            state.gained += change;
            if (state.lastGainT) {
              state.climbS += Math.min(CLIMB_GAP_CAP_S, (point.t - state.lastGainT) / 1000);
            }
            state.lastGainT = point.t;
          }
          state.lastAlt = point.alt;
        }
      } else {
        state.lastAlt = point.alt;
      }
    }
    const last = state.trail[state.trail.length - 1];
    if (!last || crumbDist(last, [point.lat, point.lon]) > CRUMB_MIN_M) {
      state.trail.push([+point.lat.toFixed(5), +point.lon.toFixed(5)]);
      if (state.trail.length > TRAIL_CAP) state.trail.splice(0, state.trail.length - TRAIL_CAP);
    }
  }

  const newest = freshPoints[freshPoints.length - 1];
  const payload = {
    active: true,
    lat: +newest.lat.toFixed(5),
    lon: +newest.lon.toFixed(5),
    alt: newest.alt == null ? null : Math.round(newest.alt),
    gained_m: Math.round(state.gained),
    climb_s: Math.round(state.climbS),
    trail: state.trail,
    completed_laps: state.completed,
    lap: Math.min(TOTAL_LAPS, state.completed + 1),
    state: previous.state === 'gondola' ? 'gondola' : 'climbing',
    manual_gain_m: manualGain(previous),
    manual_distance_km: manualDistance(previous),
    msg: previous.msg || '',
    time: new Date(newest.t).toISOString(),
    lastAlt: state.lastAlt,
    lastGainT: state.lastGainT,
    reset_pending: false,
  };

  const put = await writeLocation(token, file.sha, payload, 'live: location');
  if (!put.ok) return res.status(502).json({ error: `GitHub write ${put.status}` });
  return res.status(200).json({ result: 'ok', completed_laps: state.completed });
}

async function handleAction(body, token, res) {
  // Retry once if a GPS update lands at the same moment as the button tap.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readLocation(token);
    if (!current.ok) return res.status(502).json({ error: `GitHub read ${current.status}` });
    const completedBefore = completedLaps(current.location);
    let completed = completedBefore;
    let gain = manualGain(current.location);
    let distance = manualDistance(current.location);
    if (body.action === 'finish_lap') completed = Math.min(TOTAL_LAPS, completed + 1);
    if (body.action === 'undo_lap') completed = Math.max(0, completed - 1);
    if (body.action === 'set_gain') {
      const entered = Math.round(Number(body.gained_m));
      if (!Number.isFinite(entered) || entered < 0 || entered > 20_000) {
        return res.status(400).json({ error: 'Enter metres between 0 and 20,000.' });
      }
      gain = entered;
    }
    if (body.action === 'set_distance') {
      const entered = Number(body.distance_km);
      if (!Number.isFinite(entered) || entered < 0 || entered > 200) {
        return res.status(400).json({ error: 'Enter distance between 0 and 200 km.' });
      }
      distance = Math.round(entered * 100) / 100;
    }

    let state = trackerState(current.location);
    if (body.action === 'finish_lap') state = 'gondola';
    if (body.action === 'start_climb' || body.action === 'undo_lap') state = 'climbing';
    if (body.action === 'offline') state = 'offline';

    const payload = {
      ...current.location,
      active: body.action === 'offline' ? false : true,
      completed_laps: completed,
      lap: Math.min(TOTAL_LAPS, completed + 1),
      state,
      manual_gain_m: gain,
      manual_distance_km: distance,
      time: new Date().toISOString(),
    };
    if (typeof body.msg === 'string') payload.msg = body.msg.trim().slice(0, 140);

    const put = await writeLocation(token, current.file.sha, payload, `live: ${body.action}`);
    if (put.ok) {
      return res.status(200).json({
        result: 'ok', completed_laps: completed, state,
        gained_m: gain, distance_km: distance,
      });
    }
    if (put.status !== 409 && put.status !== 422) {
      return res.status(502).json({ error: `GitHub write ${put.status}` });
    }
  }
  return res.status(409).json({ error: 'Update collided with GPS. Tap once more.' });
}

function parsePoints(body) {
  if (Array.isArray(body.locations)) {
    return body.locations
      .map((location) => ({
        lat: location.geometry?.coordinates?.[1],
        lon: location.geometry?.coordinates?.[0],
        alt: numOrNull(location.properties?.altitude),
        t: Date.parse(location.properties?.timestamp) || Date.now(),
      }))
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon));
  }
  if (Number.isFinite(body.lat) && Number.isFinite(body.lon)) {
    return [{ lat: body.lat, lon: body.lon, alt: numOrNull(body.alt), t: Date.now() }];
  }
  return [];
}

async function readLocation(token) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}?ref=${BRANCH}`;
  const response = await fetch(url, { headers: auth(token) });
  if (!response.ok) return { ok: false, status: response.status };
  const file = await response.json();
  let location = {};
  try { location = JSON.parse(Buffer.from(file.content, 'base64').toString()); } catch {}
  return { ok: true, file, location };
}

function writeLocation(token, sha, payload, message) {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;
  return fetch(url, {
    method: 'PUT',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      branch: BRANCH,
      sha,
      content: Buffer.from(JSON.stringify(payload)).toString('base64'),
    }),
  });
}

function completedLaps(location) {
  const fallback = Math.max(0, (Number(location.lap) || 1) - 1);
  const value = Number(location.completed_laps ?? fallback) || 0;
  return Math.max(0, Math.min(TOTAL_LAPS, Math.round(value)));
}

function trackerState(location) {
  if (location.state === 'gondola' || location.state === 'climbing' || location.state === 'offline') {
    return location.state;
  }
  return location.active ? 'climbing' : 'offline';
}

function manualGain(location) {
  const value = Math.round(Number(location.manual_gain_m) || 0);
  return Math.max(0, Math.min(20_000, value));
}

function manualDistance(location) {
  const value = Number(location.manual_distance_km) || 0;
  return Math.max(0, Math.min(200, Math.round(value * 100) / 100));
}

function numOrNull(value) { return Number.isFinite(value) ? value : null; }

function crumbDist(a, b) {
  const x = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
  const y = b[0] - a[0];
  return Math.sqrt(x * x + y * y) * 111320;
}

function auth(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
}
