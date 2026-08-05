# Everesting on Foot — site design

Date: 2026-08-05

## Goal

A single-page site for a one-day everesting attempt (9,000 m of climbing) on
the eight "evac" trail variations in Squamish, plus live position sharing from
a phone so friends can come join a lap, plus a comment wall with photos.
Framework copied from the `boys-gravel-trip` repo.

## Constraints

- GitHub-only stack. GitHub Pages hosting, no paid services, no backend.
- Phone-side tracking must work in a plain mobile browser.
- The lap plan must reach 9,000 m of ascent with a safety buffer.

## Lap plan

All eight variations climb the same hill (~42 m → ~885 m; V6 tops at 940 m).
Smoothed per-lap gain runs 844–920 m. Ten laps of typical variations falls
short (~8,570 m), so the plan is 11 laps: V6, V5, V3, V7, V2, V4, V8, V1,
then V1 ×3. Total 9,485 m over 36.6 km of climbing; 9,000 m falls on lap 11.
Ordering puts long/gentle laps first and the shortest trail last.
`LAP_ORDER` in `build.py` is the single source of truth.

## Architecture

Same shape as boys-gravel-trip:

- `gpx/` — Strava exports, source of truth.
- `build.py` — stdlib-only Python. Parses GPX, smooths elevation (9-point
  moving average), computes per-variation stats and the lap plan, writes
  `docs/challenge.json`, copies GPX files to `docs/gpx/` under slug names.
- `docs/` — the published site. `index.html` + `app.js` + `style.css` render
  the JSON: hero totals, live section, Leaflet map (terrain default) with all
  eight variations, lap plan table, per-variation cards with SVG elevation
  profiles and GPX downloads, giscus comments.

## Live tracking

- `docs/tracker.html` (phone): `watchPosition` + screen wake lock. Every 60 s
  it PUTs `location.json` to the **`live` branch** via the GitHub contents
  API using a fine-grained PAT (Contents read/write on this repo only),
  pasted once and kept in localStorage. Payload: lat/lon/alt, cumulative
  ascent (3 m threshold on GPS altitude), manual lap counter, free-text
  status, timestamp, active flag. Handles sha conflicts with one refetch.
- The `live` branch exists so commits never touch the Pages source branch,
  which would queue a site rebuild per push and hit the ~10 builds/hour soft
  limit within minutes.
- Viewer side (`app.js`): polls
  `raw.githubusercontent.com/pkudzia/everesting/live/location.json` with a
  cache-busting query every 60 s. A payload older than 10 minutes or with
  `active: false` renders as "not live". Fresh payloads show a pulsing map
  marker, lap/altitude/message line, and a progress bar toward 9,000 m.
- Known limitation: mobile browsers stop GPS when the tab is backgrounded or
  the screen locks. Mitigations documented (wake lock, battery pack). This is
  accepted for a supported, low-stakes event.

## Comments and photos

giscus over GitHub Discussions (`Announcements` category, mapped by
`pathname`). Photo uploads work natively by dragging images into the comment
box. Requires the giscus GitHub App installed on the repo — a one-click
manual step.

## Testing

`python3 build.py` prints per-variation stats for eyeballing against Strava.
Local preview via `python3 -m http.server` in `docs/`. Grade figures verified
by sweeping the rolling-window size (real terrain decays slowly; noise
collapses).
