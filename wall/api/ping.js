/* Background-GPS ingest for the live tracker.
   The Overland iOS app (or anything that POSTs {lat,lon,alt}) hits this URL
   while the phone is locked in a pocket. The endpoint accumulates ascent,
   climbing time, breadcrumbs, and an inferred lap count, then writes
   location.json to the repo's `live` branch — the site is unchanged.

   Auth: ?key=<PING_KEY env>. GitHub write: GITHUB_TOKEN env (fine-grained PAT,
   Contents read/write on pkudzia/everesting only). */

const OWNER = 'pkudzia';
const REPO = 'everesting';
const BRANCH = 'live';
const PATH = 'location.json';

const GAIN_THRESHOLD_M = 3;
const CLIMB_GAP_CAP_S = 120;   // rests/gondola never add climbing time
const SUMMIT_ALT = 750;        // above this = topped out
const BASE_ALT = 150;          // back below this after topping = next lap
const CRUMB_MIN_M = 25;
const TRAIL_CAP = 1500;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (!process.env.PING_KEY || (req.query.key || '') !== process.env.PING_KEY) {
    return res.status(401).json({ error: 'bad key' });
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ error: 'GITHUB_TOKEN not configured' });

  // Accept an Overland batch ({locations:[GeoJSON,...]}) or a bare {lat,lon,alt}.
  const body = req.body || {};
  let pts = [];
  if (Array.isArray(body.locations)) {
    pts = body.locations
      .map((l) => ({
        lat: l.geometry?.coordinates?.[1],
        lon: l.geometry?.coordinates?.[0],
        alt: numOrNull(l.properties?.altitude),
        t: Date.parse(l.properties?.timestamp) || Date.now(),
      }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon));
  } else if (Number.isFinite(body.lat) && Number.isFinite(body.lon)) {
    pts = [{ lat: body.lat, lon: body.lon, alt: numOrNull(body.alt), t: Date.now() }];
  }
  if (!pts.length) return res.status(200).json({ result: 'ok' });
  pts.sort((a, b) => a.t - b.t);

  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;
  const head = await fetch(`${url}?ref=${BRANCH}`, { headers: auth(token) });
  if (!head.ok) return res.status(502).json({ error: `GitHub read ${head.status}` });
  const file = await head.json();
  let prev = {};
  try { prev = JSON.parse(Buffer.from(file.content, 'base64').toString()); } catch {}

  const s = {
    gained: prev.gained_m || 0,
    climbS: prev.climb_s || 0,
    trail: Array.isArray(prev.trail) ? prev.trail : [],
    lap: prev.lap || 1,
    topped: !!prev.topped,
    lastAlt: numOrNull(prev.lastAlt),
    lastGainT: numOrNull(prev.lastGainT),
  };
  const lastSeen = prev.time ? Date.parse(prev.time) : 0;

  for (const p of pts) {
    if (p.t <= lastSeen) continue; // already processed (Overland re-sends until acked)
    if (p.alt != null) {
      if (s.lastAlt != null) {
        const d = p.alt - s.lastAlt;
        if (Math.abs(d) >= GAIN_THRESHOLD_M) {
          if (d > 0) {
            s.gained += d;
            if (s.lastGainT) s.climbS += Math.min(CLIMB_GAP_CAP_S, (p.t - s.lastGainT) / 1000);
            s.lastGainT = p.t;
          }
          s.lastAlt = p.alt;
        }
      } else {
        s.lastAlt = p.alt;
      }
      if (p.alt > SUMMIT_ALT) s.topped = true;
      if (s.topped && p.alt < BASE_ALT) { s.lap += 1; s.topped = false; }
    }
    const last = s.trail[s.trail.length - 1];
    if (!last || crumbDist(last, [p.lat, p.lon]) > CRUMB_MIN_M) {
      s.trail.push([+p.lat.toFixed(5), +p.lon.toFixed(5)]);
      if (s.trail.length > TRAIL_CAP) s.trail.splice(0, s.trail.length - TRAIL_CAP);
    }
  }

  const newest = pts[pts.length - 1];
  const payload = {
    active: true,
    lat: +newest.lat.toFixed(5),
    lon: +newest.lon.toFixed(5),
    alt: newest.alt == null ? null : Math.round(newest.alt),
    gained_m: Math.round(s.gained),
    climb_s: Math.round(s.climbS),
    trail: s.trail,
    lap: s.lap,
    msg: prev.msg || '',
    time: new Date(newest.t).toISOString(),
    // accumulator state, carried inside the same file
    topped: s.topped,
    lastAlt: s.lastAlt,
    lastGainT: s.lastGainT,
  };

  const put = await fetch(url, {
    method: 'PUT',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'live: ping',
      branch: BRANCH,
      sha: file.sha,
      content: Buffer.from(JSON.stringify(payload)).toString('base64'),
    }),
  });
  if (!put.ok) return res.status(502).json({ error: `GitHub write ${put.status}` });

  // Overland clears its queue when it sees {"result": "ok"}.
  return res.status(200).json({ result: 'ok' });
}

function numOrNull(v) { return Number.isFinite(v) ? v : null; }

function crumbDist(a, b) {
  const x = (b[1] - a[1]) * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
  const y = b[0] - a[0];
  return Math.sqrt(x * x + y * y) * 111320;
}

function auth(token) {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };
}
