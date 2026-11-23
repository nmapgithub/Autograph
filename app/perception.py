"""What the cameras would hand the planner at one instant.

Tesla's public fleet-telemetry stream does not publish the occupancy network.
These tracks are the simulated vision stack: eight exterior cameras plus the
cabin camera, with range, lateral offset, and confidence. Positions on the
three Drive-tab roads match the cars, people, and obstacles drawn on screen.
A full-day run uses the same camera model on a commute laid out from the trip.
"""

from __future__ import annotations

import math

# Fixed actors on the 1 km Drive-tab roads. drive.js draws these same meters.
ROADS = {
    "Street": {
        "limit": 40,
        "parked": [(45, 2.6), (620, -2.5)],
        "pedestrian": [(130, True), (740, True)],
        "lead": (80, 0.72, 32),
        "oncoming": None,
        "bays": [968, 986],
        "obstacles": [(150, "speed_bump"), (340, "speed_bump"), (500, "obstacle"), (690, "speed_bump"), (860, "speed_bump")],
    },
    "Avenue": {
        "limit": 60,
        "parked": [(160, 2.7), (640, -2.6)],
        "pedestrian": [(390, True)],
        "lead": (120, 0.78, 48),
        "oncoming": (940, 1.05),
        "bays": [972],
        "obstacles": [(220, "speed_bump"), (470, "obstacle"), (710, "speed_bump"), (900, "obstacle")],
    },
    "Ring road": {
        "limit": 90,
        "parked": [],
        "pedestrian": [(200, False)],
        "lead": (140, 0.82, 78),
        "oncoming": None,
        "bays": [984],
        "obstacles": [(260, "obstacle"), (620, "speed_bump")],
    },
}

CAMERAS = (
    "FrontMain",
    "FrontNarrow",
    "FrontFisheye",
    "LeftRepeater",
    "RightRepeater",
    "LeftPillar",
    "RightPillar",
    "Rear",
    "Cabin",
)


def perceive(state) -> dict:
    along = float(state.along_m or 0)
    road = ROADS.get(state.route_name or "")
    if road:
        raw = _road_actors(road, along, state.speed_kmh)
        curbs = _curbs(road["limit"], state)
        spaces = _bays(road["bays"], along, state)
    else:
        raw = _commute_actors(state, along)
        limit = float(state.limit_kmh or 40)
        curbs = _curbs(limit, state) if state.phase in ("driving", "maneuver") else {"left_m": None, "right_m": None, "confidence": 0}
        spaces = _commute_bays(state, along)
    tracks = [_track(item, state) for item in raw]
    tracks = [item for item in tracks if item and item["confidence"] >= 0.42 and _in_view(item)]
    tracks.sort(key=lambda item: abs(item["range_m"]))
    tracks = tracks[:8]
    cabin = _cabin(state)
    counts = _counts(tracks)
    return {
        "stack": "TeslaVision-occupancy",
        "note": "Simulated vision tracks. Fleet telemetry does not publish the raw occupancy network; this is what the camera stack would hand the planner.",
        "cameras": _cameras(state, cabin),
        "cabin": cabin,
        "curbs": curbs,
        "parking_spaces": spaces,
        "tracks": tracks,
        "counts": counts,
        "summary": _summary(counts, cabin, spaces, curbs),
    }


def _road_actors(road, along, speed_kmh):
    actors = []
    for index, (meter, lateral) in enumerate(road["parked"]):
        actors.append(_fixed("vehicle", f"parked-{index}", meter, along, lateral, 0, parked=True))
    for index, (meter, crosses) in enumerate(road["pedestrian"]):
        close = abs(along - meter) < 16
        lateral = 0.35 if crosses and close else (-2.4 if index % 2 == 0 else 2.5)
        actors.append(_fixed("pedestrian", f"ped-{index}", meter, along, lateral, 4 if close and crosses else 1.2))
    anchor, factor, pace = road["lead"]
    lead_m = anchor + along * factor
    actors.append(_fixed("vehicle", "lead", lead_m, along, 0.15, pace))
    if road["oncoming"]:
        start, gain = road["oncoming"]
        actors.append(_fixed("vehicle", "oncoming", start - along * gain, along, 3.5, -42))
    for index, (meter, kind) in enumerate(road["obstacles"]):
        actors.append(_fixed(kind, f"{kind}-{index}", meter, along, 0.0, 0))
    return actors


def _fixed(kind, name, meter, along, lateral, speed_kmh, parked=False):
    return {
        "id": name,
        "class": kind,
        "range_m": meter - along,
        "lateral_m": lateral,
        "speed_kmh": speed_kmh,
        "parked": parked,
    }


def _commute_actors(state, along):
    actors = []
    if state.phase not in ("driving", "maneuver", "access"):
        if state.sentry == "SentryModeStateArmed":
            actors.append({"id": "sentry-ped", "class": "pedestrian", "range_m": 14, "lateral_m": -3.2, "speed_kmh": 4, "parked": False})
        return actors
    gap = 22 + 8 * (0.5 + 0.5 * math.sin(along / 37))
    actors.append({"id": "lead", "class": "vehicle", "range_m": gap, "lateral_m": 0.2, "speed_kmh": max(0, state.speed_kmh - 6), "parked": False})
    if int(along // 180) % 2 == 0:
        actors.append({"id": f"parked-{int(along // 180)}", "class": "vehicle", "range_m": 28, "lateral_m": 2.6, "speed_kmh": 0, "parked": True})
    cross = along % 420
    if cross > 360:
        actors.append({"id": f"ped-{int(along // 420)}", "class": "pedestrian", "range_m": 420 - cross, "lateral_m": 0.4 if cross > 390 else -2.3, "speed_kmh": 5, "parked": False})
    if int(along // 900) % 3 == 1 and (along % 900) > 820:
        actors.append({"id": f"cone-{int(along // 900)}", "class": "obstacle", "range_m": 900 - (along % 900), "lateral_m": 0.2, "speed_kmh": 0, "parked": False})
    if state.road == "urban" and int(along // 260) % 2 == 1:
        actors.append({"id": f"oncoming-{int(along // 260)}", "class": "vehicle", "range_m": 40, "lateral_m": 3.4, "speed_kmh": -36, "parked": False})
    return actors


def _commute_bays(state, along):
    planned = float(state.planned_m or 0)
    near_end = planned > 50 and along > planned - 35
    near_start = along < 30 and state.phase in ("access", "maneuver", "parked", "driving")
    if not (near_end or near_start or state.phase in ("parked", "access")):
        return []
    if state.phase == "charging":
        return []
    origin = 8 if near_start or state.phase == "parked" else max(4, planned - along)
    return [
        {"id": "bay-1", "side": "right", "range_m": round(origin, 1), "length_m": 5.4, "width_m": 2.4, "free": True, "confidence": 0.86},
        {"id": "bay-2", "side": "right", "range_m": round(origin + 6.2, 1), "length_m": 5.2, "width_m": 2.4, "free": state.phase != "parked", "confidence": 0.81},
    ]


def _bays(meters, along, state):
    spaces = []
    for index, meter in enumerate(meters):
        gap = meter - along
        if gap < -8 or gap > 40:
            continue
        spaces.append(
            {
                "id": f"bay-{index + 1}",
                "side": "right",
                "range_m": round(gap, 1),
                "length_m": 5.4,
                "width_m": 2.4,
                "free": True,
                "confidence": _confidence(abs(gap), state, 0.84),
            }
        )
    return spaces


def _curbs(limit, state):
    if limit >= 80:
        left, right = 3.4, 1.6
    elif limit >= 55:
        left, right = 2.2, 2.4
    else:
        left, right = 1.8, 2.2
    return {"left_m": left, "right_m": right, "confidence": _confidence(8, state, 0.9)}


def _track(item, state):
    rng_m = float(item["range_m"])
    lateral = float(item["lateral_m"])
    speed = float(item["speed_kmh"])
    rel = (speed - float(state.speed_kmh)) / 3.6
    kind = item["class"]
    in_path = (not item.get("parked")) and abs(lateral) < 1.15 and 0 < rng_m < 30 and kind in ("pedestrian", "vehicle", "obstacle", "speed_bump")
    return {
        "id": item["id"],
        "class": kind,
        "camera": _camera(rng_m, lateral),
        "range_m": round(rng_m, 1),
        "lateral_m": round(lateral, 2),
        "rel_speed_mps": round(rel, 2),
        "confidence": _confidence(abs(rng_m), state, 0.93 if kind == "vehicle" else 0.88),
        "in_path": in_path,
        "parked": bool(item.get("parked")),
        "moving": abs(speed) > 1 and not item.get("parked"),
    }


def _camera(range_m, lateral):
    if range_m < -1:
        return "Rear"
    if abs(lateral) >= 1.6 and -4 <= range_m < 20:
        return "LeftRepeater" if lateral < 0 else "RightRepeater"
    if abs(lateral) >= 3.2 and range_m < 40:
        return "LeftPillar" if lateral < 0 else "RightPillar"
    if range_m < 14:
        return "FrontFisheye"
    if range_m > 55 and abs(lateral) < 2.5:
        return "FrontNarrow"
    return "FrontMain"


def _in_view(track):
    rng_m = track["range_m"]
    lateral = abs(track["lateral_m"])
    camera = track["camera"]
    if camera == "Rear":
        return -40 <= rng_m <= 1 and lateral < 6
    if "Repeater" in camera or "Pillar" in camera:
        return -8 <= rng_m <= 42 and lateral < 8
    return -2 <= rng_m <= 85 and lateral < 8


def _confidence(range_m, state, base):
    fade = max(0, range_m) / 90
    score = base - 0.35 * fade
    if state.weather == "rain":
        score -= 0.12
    if state.night:
        score -= 0.08
    return round(max(0.35, min(0.98, score)), 2)


def _cabin(state):
    doors = state.doors or {}
    cycles = int((state.params or {}).get("door_cycles_per_trip") or 0)
    moving = state.phase in ("driving", "maneuver")
    driver = bool(state.occupied) or moving or state.gear in ("D", "R")
    passenger = bool(state.passenger) or bool(doors.get("pf")) or (moving and cycles >= 4)
    rear_left = bool(doors.get("dr")) or (moving and cycles >= 6)
    rear_right = bool(doors.get("pr")) or (moving and cycles >= 8)
    if state.phase == "parked" and state.locked and not state.occupied and not doors.get("pf"):
        driver = passenger = rear_left = rear_right = False
    if not any((driver, passenger, rear_left, rear_right)):
        camera = "empty"
    elif driver and (not state.belted) and state.speed_kmh > 8:
        camera = "driver_unbelted"
    elif state.autopilot and state.speed_kmh > 25:
        camera = "driver_hands_off"
    elif driver and passenger:
        camera = "driver_and_passenger"
    elif driver:
        camera = "driver_attending"
    else:
        camera = "passenger_only"
    return {
        "driver": driver,
        "passenger": passenger,
        "rear_left": rear_left,
        "rear_right": rear_right,
        "cabin_camera": camera,
        "hands_on": camera not in ("driver_hands_off", "empty"),
        "confidence": 0.93 if camera != "empty" else 0.97,
    }


def _cameras(state, cabin):
    awake = state.phase != "parked" or state.sentry == "SentryModeStateArmed" or state.occupied
    cabin_on = cabin["cabin_camera"] != "empty"
    rows = []
    for name in CAMERAS:
        if name == "Cabin":
            status = "streaming" if cabin_on else "off"
        else:
            status = "streaming" if awake else "asleep"
        rows.append({"name": name, "status": status})
    return rows


def _counts(tracks):
    counts = {"vehicle": 0, "pedestrian": 0, "obstacle": 0, "speed_bump": 0}
    for track in tracks:
        if track["class"] in counts:
            counts[track["class"]] += 1
    return counts


def _summary(counts, cabin, spaces, curbs):
    parts = []
    if counts["vehicle"]:
        parts.append(f"{counts['vehicle']} vehicle" + ("s" if counts["vehicle"] != 1 else ""))
    if counts["pedestrian"]:
        parts.append(f"{counts['pedestrian']} pedestrian" + ("s" if counts["pedestrian"] != 1 else ""))
    if counts["obstacle"]:
        parts.append(f"{counts['obstacle']} obstacle" + ("s" if counts["obstacle"] != 1 else ""))
    if counts["speed_bump"]:
        parts.append(f"{counts['speed_bump']} speed bump" + ("s" if counts["speed_bump"] != 1 else ""))
    if spaces:
        free = sum(1 for space in spaces if space["free"])
        parts.append(f"{free} open parking")
    if curbs.get("left_m") is not None:
        parts.append("curbs")
    seat = "driver" if cabin["driver"] else "cabin empty"
    if cabin["passenger"]:
        seat += " + passenger"
    parts.append(seat)
    return " · ".join(parts)

