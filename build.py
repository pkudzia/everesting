#!/usr/bin/env python3
"""Turn the Strava GPX exports in gpx/ into docs/challenge.json + docs/gpx/.

Run:  python3 build.py

Everything expensive happens here, once. The web page only ever loads the
resulting JSON, so phones at the trailhead never parse 1 MB of XML.
"""

import json
import math
import shutil
from pathlib import Path

try:
    # Hardened against XXE / entity-expansion tricks if installed. The GPX
    # files here are our own Strava exports, so the stdlib fallback is fine.
    import defusedxml.ElementTree as ET
except ImportError:
    import xml.etree.ElementTree as ET

ROOT = Path(__file__).parent
GPX_DIR = ROOT / "gpx"
DOCS = ROOT / "docs"
NS = "{http://www.topografix.com/GPX/1/1}"

TARGET_M = 9000

# Raw DEM elevation jitters +/- 1-2 m point to point. Summing every positive
# delta on raw points inflates the real climbing. A 9-point moving average is
# about what Strava and RideWithGPS do before reporting gain.
SMOOTH_WINDOW = 9

# Points kept in each map polyline. The variations are short, so this keeps
# essentially full shape.
TRACK_POINTS = 300

# Samples in each elevation profile.
PROFILE_POINTS = 200

VARIATIONS = [
    {
        "file": "Evac Variation 1 2.7 km Trail Running Route.gpx",
        "slug": "variation-1.gpx",
        "num": 1,
        "title": "Variation 1",
        "color": "#f76707",
        "note": (
            "The direct line. Shortest of the eight and the steepest average "
            "grade, which makes it the most efficient climb per kilometre. "
            "The go-to lap once the legs stop caring about scenery."
        ),
    },
    {
        "file": "Evac Variation 2 Trail Running Route.gpx",
        "slug": "variation-2.gpx",
        "num": 2,
        "title": "Variation 2",
        "color": "#d6336c",
        "note": (
            "A touch longer than the direct line for the same height, which "
            "shaves the average grade and gives the calves a different angle."
        ),
    },
    {
        "file": "Evac Variation 3 3.8 km.gpx",
        "slug": "variation-3.gpx",
        "num": 3,
        "title": "Variation 3",
        "color": "#1c7ed6",
        "note": (
            "Mid-length option. Spreads the same climb over 3.8 km, trading "
            "steepness for distance."
        ),
    },
    {
        "file": "Evac Variation 4 Trail Route.gpx",
        "slug": "variation-4.gpx",
        "num": 4,
        "title": "Variation 4",
        "color": "#37b24d",
        "note": (
            "Sits between the direct line and the long ways round. A good "
            "middle gear when the steep laps start to bite."
        ),
    },
    {
        "file": "Evac Variation 5 Trail Running Route.gpx",
        "slug": "variation-5.gpx",
        "num": 5,
        "title": "Variation 5",
        "color": "#fab005",
        "note": (
            "The longest way up and the gentlest average grade of the eight. "
            "A recovery-pace lap that still banks the full climb."
        ),
    },
    {
        "file": "Evac Variation 6 Trail Running Route.gpx",
        "slug": "variation-6.gpx",
        "num": 6,
        "title": "Variation 6",
        "color": "#7048e8",
        "note": (
            "The big one. Tops out higher than every other variation and "
            "banks the most climbing per lap, at the cost of some descent "
            "along the way."
        ),
    },
    {
        "file": "Evac Variation 7 Trail Running Route.gpx",
        "slug": "variation-7.gpx",
        "num": 7,
        "title": "Variation 7",
        "color": "#0ca678",
        "note": (
            "Similar length to Variation 2 with its own line through the "
            "middle of the hill. Variety for the mid-challenge laps."
        ),
    },
    {
        "file": "Evac Variation 8 Trail Running Route (1).gpx",
        "slug": "variation-8.gpx",
        "num": 8,
        "title": "Variation 8",
        "color": "#22b8cf",
        "note": (
            "Nearly as direct as Variation 1. A second short-and-steep option "
            "so the final laps do not all have to be the same trail."
        ),
    },
]

# The lap order for the day. Longer, gentler variations while fresh, the two
# short steep lines saved for the end when every extra horizontal metre hurts.
# Laps 9-11 repeat Variation 1 because by then the shortest lap wins.
LAP_ORDER = [6, 5, 3, 7, 2, 4, 8, 1, 1, 1, 1]


def haversine(a, b):
    """Metres between two (lat, lon) pairs."""
    radius = 6371000.0
    lat1, lat2 = math.radians(a[0]), math.radians(b[0])
    dlat = lat2 - lat1
    dlon = math.radians(b[1] - a[1])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(h))


def read_gpx(path):
    """(lat, lon, ele) for every track point in the file."""
    root = ET.parse(path).getroot()
    pts = []
    for p in root.iter(NS + "trkpt"):
        ele = p.find(NS + "ele")
        pts.append((float(p.get("lat")), float(p.get("lon")), float(ele.text)))
    return pts


def smooth(values, window=SMOOTH_WINDOW):
    """Centred moving average, shrinking the window at the ends."""
    half = window // 2
    out = []
    for i in range(len(values)):
        chunk = values[max(0, i - half) : i + half + 1]
        out.append(sum(chunk) / len(chunk))
    return out


def cumulative_distance(pts):
    """Running distance in metres, same length as pts, starting at 0."""
    cum = [0.0]
    for a, b in zip(pts, pts[1:]):
        cum.append(cum[-1] + haversine(a, b))
    return cum


def simplify(pts, cum, target):
    """Distance-even subsample that always keeps first and last point."""
    if len(pts) <= target:
        return list(range(len(pts)))
    total = cum[-1]
    step = total / (target - 1)
    idx = [0]
    want = step
    for i, d in enumerate(cum):
        if d >= want and i != 0:
            idx.append(i)
            want += step
    if idx[-1] != len(pts) - 1:
        idx.append(len(pts) - 1)
    return idx


def resample_profile(pts, cum, eles, count):
    """[km, ele, lat, lon] sampled at even distance, for the chart + map link."""
    total = cum[-1]
    out = []
    j = 0
    for i in range(count):
        target = total * i / (count - 1)
        while j < len(cum) - 2 and cum[j + 1] < target:
            j += 1
        out.append(
            [
                round(target / 1000, 3),
                round(eles[j], 1),
                round(pts[j][0], 5),
                round(pts[j][1], 5),
            ]
        )
    return out


GRADE_WINDOW = 200.0


def max_grade(cum, eles, window_m=GRADE_WINDOW):
    """Steepest sustained grade over a rolling window, as a percentage.

    These laps are only 2.7-4.3 km, so the 500 m window used for the gravel
    trip would smear the crux pitches; 200 m matches how a hiker experiences
    a sustained steep section on trails this short.
    """
    steepest = 0.0
    j = 0
    for i in range(len(cum)):
        while j < len(cum) - 1 and cum[j] - cum[i] < window_m:
            j += 1
        run = cum[j] - cum[i]
        if run < window_m * 0.8:
            break
        steepest = max(steepest, (eles[j] - eles[i]) / run * 100)
    return steepest


def build_variation(spec):
    pts = read_gpx(GPX_DIR / spec["file"])
    cum = cumulative_distance(pts)
    eles = smooth([p[2] for p in pts])

    gain = sum(max(0.0, b - a) for a, b in zip(eles, eles[1:]))
    loss = sum(max(0.0, a - b) for a, b in zip(eles, eles[1:]))

    keep = simplify(pts, cum, TRACK_POINTS)
    track = [[round(pts[i][0], 5), round(pts[i][1], 5)] for i in keep]

    lats = [p[0] for p in pts]
    lons = [p[1] for p in pts]

    return {
        "num": spec["num"],
        "title": spec["title"],
        "color": spec["color"],
        "note": spec["note"],
        "file": spec["slug"],
        "distance_km": round(cum[-1] / 1000, 2),
        "gain_m": round(gain),
        "loss_m": round(loss),
        "min_ele_m": round(min(eles)),
        "max_ele_m": round(max(eles)),
        "avg_grade_pct": round((eles[-1] - eles[0]) / cum[-1] * 100, 1),
        "max_grade_pct": round(max_grade(cum, eles), 1),
        "bounds": [[min(lats), min(lons)], [max(lats), max(lons)]],
        "track": track,
        "profile": resample_profile(pts, cum, eles, PROFILE_POINTS),
    }


def build_plan(variations):
    """Expand LAP_ORDER into the lap table with running totals."""
    by_num = {v["num"]: v for v in variations}
    plan = []
    total_gain = 0.0
    total_km = 0.0
    crossed = None
    for lap, num in enumerate(LAP_ORDER, start=1):
        v = by_num[num]
        total_gain += v["gain_m"]
        total_km += v["distance_km"]
        if crossed is None and total_gain >= TARGET_M:
            crossed = lap
        plan.append(
            {
                "lap": lap,
                "variation": num,
                "gain_m": v["gain_m"],
                "distance_km": v["distance_km"],
                "cum_gain_m": round(total_gain),
                "cum_km": round(total_km, 1),
            }
        )
    return plan, round(total_gain), round(total_km, 1), crossed


def main():
    gpx_out = DOCS / "gpx"
    gpx_out.mkdir(parents=True, exist_ok=True)

    variations = []
    for spec in VARIATIONS:
        v = build_variation(spec)
        dest = gpx_out / spec["slug"]
        shutil.copy(GPX_DIR / spec["file"], dest)
        v["file_kb"] = round(dest.stat().st_size / 1024)
        variations.append(v)
        print(
            f"Variation {v['num']}: {v['distance_km']:>5.2f} km  "
            f"+{v['gain_m']:>4} m  top {v['max_ele_m']:>4} m  "
            f"avg {v['avg_grade_pct']:>4.1f}%  steepest {v['max_grade_pct']:.1f}%"
        )

    plan, total_gain, total_km, crossed = build_plan(variations)

    lats = [c for v in variations for c in (v["bounds"][0][0], v["bounds"][1][0])]
    lons = [c for v in variations for c in (v["bounds"][0][1], v["bounds"][1][1])]

    challenge = {
        "name": "Everesting on Foot",
        "subtitle": (
            "Eleven laps up the Squamish evac trails, eight different ways, "
            "until the watch says 9,000 metres of climbing."
        ),
        "target_m": TARGET_M,
        "totals": {
            "laps": len(plan),
            "gain_m": total_gain,
            "distance_km": total_km,
            "crossed_on_lap": crossed,
        },
        "bounds": [[min(lats), min(lons)], [max(lats), max(lons)]],
        "variations": variations,
        "plan": plan,
    }

    out = DOCS / "challenge.json"
    out.write_text(json.dumps(challenge, separators=(",", ":")))
    print(f"\nPlan: {len(plan)} laps, {total_gain} m over {total_km} km of climbing")
    print(f"Crosses {TARGET_M} m on lap {crossed}")
    print(f"Wrote {out} ({out.stat().st_size / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
