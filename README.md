# Everesting on Foot

A shareable web page for a single-push everesting attempt on the Squamish evac
trails: 9,000 m of climbing over 10 laps, live position and progress from my
phone, and a comment wall for photos and encouragement.

**Target 9,000 m · 10 laps · 8,628 m from laps · 33.8 km of climbing · first lap 7:45 a.m.**

## The lap plan

Every variation climbs the same hill, from the valley floor at ~42 m to the
top at ~885 m (Variation 6 continues to 940 m). Ascent only counts.

| Lap | Variation | Distance | Gain | Running total |
|---|---|---|---|---|
| 1 | V6 | 4.30 km | +920 m | 920 m |
| 2 | V5 | 4.33 km | +844 m | 1,764 m |
| 3 | V3 | 3.84 km | +857 m | 2,621 m |
| 4 | V7 | 3.41 km | +862 m | 3,483 m |
| 5 | V2 | 3.43 km | +857 m | 4,340 m |
| 6 | V4 | 3.19 km | +859 m | 5,199 m |
| 7 | V8 | 2.95 km | +858 m | 6,057 m |
| 8 | V1 | 2.78 km | +857 m | 6,914 m |
| 9 | V1 | 2.78 km | +857 m | 7,771 m |
| 10 | V1 | 2.78 km | +857 m | **8,628 m** |

The laps bank 8,628 m; the remaining ~372 m of the 9,000 gets picked up as
extra vertical between laps. The site's progress bar runs off the phone
tracker's cumulative ascent, so it counts everything.

## Layout

```
gpx/        the Strava GPX exports (source of truth, never edited)
build.py    GPX -> docs/challenge.json + docs/gpx/
docs/       the published site (GitHub Pages serves this folder)
specs/      design doc
```

## Live tracking

Two ways to feed the tracker; both write the same `location.json` on the
`live` branch, so the site doesn't care which is used.

**Screen-off (recommended): Overland + /api/ping.** The Overland iOS app
records GPS in the background and POSTs batches to
`https://everesting-wall.vercel.app/api/ping?key=<PING_KEY>`. The endpoint
(`wall/api/ping.js`) accumulates ascent (3 m threshold), climbing-only time
(gaps capped at 2 min) and breadcrumbs. Completed climbs are never guessed
from GPS: tap **Finish this climb** on `tracker.html` when loading the gondola.
Requires two Vercel env vars on `everesting-wall`: `PING_KEY` (set) and
`GITHUB_TOKEN` (a fine-grained PAT, Contents read/write on this repo only).

**Screen-on (backup): the web tracker.** `docs/tracker.html` can also watch GPS
in the browser and send it through `/api/ping` about once a minute. The main page
polls the contents API for that file every 75 s (uncached and fresh; the
unauthenticated limit is 60 requests/hour per viewer IP) and falls back to
`raw.githubusercontent.com` for rate-limited viewers, which Fastly caches for
up to 5 minutes regardless of query string. Fresh data shows a pulsing marker,
the manually completed climb count, and progress through all ten climbs.

One-time setup, before challenge day:

1. On your phone, open `https://pkudzia.github.io/everesting/tracker.html`.
2. Paste the `PING_KEY` (it stays in the phone's localStorage).
3. If Overland is not running, tap **Start sharing location**.
3. Keep the screen on. Browsers pause GPS in background tabs; a battery pack
   and minimum brightness beat a dead tracker. The page grabs a screen wake
   lock where the browser supports it.

At each gondola ride, tap **Finished climb — on gondola**. The public page will
show the gondola state. At the bottom, tap **Start next climb**. An undo button
is available for accidental taps. Enter the watch's total ascent in **Total
metres climbed** and tap **Update**; this manual number drives the public
9,000 m progress bar and is not overwritten by GPS. Enter the watch's cumulative
kilometres in **Total distance** and update that separately; it is also preserved
across GPS updates.

## Comments and photos (the cheer wall)

Anonymous, no sign-in. A tiny Vercel function (`wall/api/wall.js`, project
`everesting-wall`, account pkudzia-1128) stores posts and photos in Vercel
Blob. The page posts JSON (photos downscaled client-side to 1600 px JPEG)
and polls the API once a minute. Guardrails: 500-char messages, 4 MB photos,
a honeypot field, and a soft 5-posts/minute per-IP limit. Delete anything
from the Vercel dashboard (Storage -> everesting-wall-store), or with
`vercel blob del <pathname>` from `wall/`.

## Rebuilding

After editing anything in `gpx/`, the variation notes, or `LAP_ORDER` in
`build.py`:

```sh
python3 build.py
```

Stock Python 3, no dependencies. Commit the regenerated `docs/challenge.json`.

## Previewing locally

```sh
cd docs && python3 -m http.server 8765
```

A local server is required because the page fetches `challenge.json`; opening
`index.html` from disk fails on CORS.

## How the numbers are computed

Elevation gain is summed over a **9-point moving average**, not the raw GPX
stream — raw DEM elevation jitters a metre or two between points and a raw
sum overstates the climbing. This matches how Strava computes gain, so the
numbers here agree with the routes as drawn.

"Steepest" is the worst sustained **200 m** grade. Widening the window to 300
and 500 m decays the figure slowly (V1: 76.6 → 69.6 → 61.2 %), the signature
of real terrain rather than DEM noise. Yes, the upper headwall really is that
steep.

Third-party code: Leaflet 1.9.4 from unpkg, basemap tiles from OpenTopoMap
and CARTO, map data © OpenStreetMap contributors.
