"""Turn a Drive-tab trip into the same telemetry and event files a full day uses."""

from __future__ import annotations

import json
import random
import uuid
from datetime import datetime, timedelta, timezone

from app.simulator import State, build_document
from app.store import LOGS, get_run, save_driver, save_run
from app.ueba import analyze

WINDOW_NAMES = ("fd", "fp", "rd", "rp")
DOOR_NAMES = ("df", "dr", "pf", "pr")


def record_drive(driver: dict, body) -> dict | None:
    samples = list(body.samples or [])
    events = list(body.events or [])
    if not samples and not events and not body.run_id:
        return None
    run = get_run(body.run_id) if body.run_id else None
    if run and run.get("driver_id") != driver["id"]:
        run = None
    if run is None and not samples and not events:
        return None
    now = datetime.now(timezone(timedelta(minutes=int(driver.get("utc_offset_min") or 0))))
    if run is None:
        run_id = uuid.uuid4().hex[:12]
        run = _new_run(driver, run_id, body.mode, body.path, now)
    files = run["files"]
    telemetry = LOGS / files["telemetry_file"].split("/")[-1]
    events_path = LOGS / files["events_file"].split("/")[-1]
    series_path = LOGS / files["series_file"].split("/")[-1]
    LOGS.mkdir(parents=True, exist_ok=True)
    stats = run.setdefault("drive_stats", _blank_stats(driver))
    cursor = run.get("drive_cursor")
    docs = []
    for sample in samples:
        moment = now - timedelta(milliseconds=max(0, min(int(sample.age_ms), 180_000)))
        state = _state(driver, sample, moment, run["id"], stats)
        if cursor:
            _absorb(stats, cursor, sample, state)
        else:
            stats["max_speed_kmh"] = max(stats["max_speed_kmh"], abs(float(sample.speed_kmh)))
            stats["distance_km"] = max(stats["distance_km"], float(sample.meters) / 1000)
        doc = build_document(state)
        cursor = _cursor(sample, state)
        docs.append(doc)
        if run.get("example") is None and state.speed_kmh > 8:
            run["example"] = doc
    if docs:
        with telemetry.open("a", encoding="utf-8") as handle:
            for doc in docs:
                handle.write(json.dumps(doc, separators=(",", ":")) + "\n")
        stats["samples"] += len(docs)
    event_docs = []
    for item in events:
        moment = now - timedelta(milliseconds=max(0, min(int(item.age_ms), 180_000)))
        event_docs.append(
            {
                "@timestamp": moment.isoformat(timespec="milliseconds"),
                "log_type": "event",
                "simulator": "autograph",
                "event": item.kind[:40],
                "severity": item.severity if item.severity in ("info", "watch", "alert") else "info",
                "phase": "driving" if abs(item.speed_kmh) > 2 else "access",
                "trip_id": run["id"],
                "entity": {
                    "type": "vehicle",
                    "vin": driver["vin"],
                    "driver_id": driver["id"],
                    "driver_name": driver["name"],
                    "vehicle_name": driver["vehicle_name"],
                    "model": driver.get("model", "Model 3"),
                },
                "detail": {"text": item.text[:240]},
                "context": {
                    "speed_kmh": round(abs(item.speed_kmh), 2),
                    "gear": item.gear if item.gear in ("P", "R", "N", "D") else "P",
                    "soc": round(stats["end_soc"], 2),
                    "limit_kmh": round(cursor["limit_kmh"], 1) if cursor else 0,
                },
            }
        )
    if event_docs:
        with events_path.open("a", encoding="utf-8") as handle:
            for doc in event_docs:
                handle.write(json.dumps(doc, separators=(",", ":")) + "\n")
        stats["events"] += len(event_docs)
        stats["alert_events"] += sum(1 for doc in event_docs if doc["severity"] == "alert")
    if cursor:
        run["drive_cursor"] = cursor
    if samples:
        run["route"] = samples[-1].path[:40]
    run["samples"] = stats["samples"]
    run["event_count"] = stats["events"]
    run["ended"] = now.isoformat(timespec="seconds")
    run["metrics"] = _metrics(stats)
    run["ueba"] = analyze(driver["name"], run["metrics"], {})
    _write_series(series_path, docs, stats)
    if body.finished:
        _credit_vehicle(driver, run, stats)
    save_run(run)
    public = dict(run)
    public.pop("drive_stats", None)
    public.pop("drive_cursor", None)
    public.pop("example", None)
    return public


def _new_run(driver, run_id, mode, path, now):
    scenario = "self-drive" if mode == "self-drive" else "manual"
    return {
        "id": run_id,
        "driver_id": driver["id"],
        "driver_name": driver["name"],
        "scenario": scenario,
        "route": (path or "Street")[:40],
        "source": "drive",
        "seed": 0,
        "inject_anomalies": False,
        "interval_ms": 500,
        "day": now.date().isoformat(),
        "started": now.isoformat(timespec="seconds"),
        "ended": now.isoformat(timespec="seconds"),
        "samples": 0,
        "event_count": 0,
        "metrics": _metrics(_blank_stats(driver)),
        "example": None,
        "files": {
            "telemetry_file": f"data/logs/{run_id}-telemetry.jsonl",
            "events_file": f"data/logs/{run_id}-events.jsonl",
            "series_file": f"data/logs/{run_id}-series.json",
        },
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "drive_stats": _blank_stats(driver),
    }


def _blank_stats(driver):
    soc = float(driver.get("soc") or 70)
    return {
        "samples": 0,
        "events": 0,
        "alert_events": 0,
        "distance_km": 0.0,
        "drive_s": 0.0,
        "max_speed_kmh": 0.0,
        "speeding_s": 0.0,
        "hard_brake_count": 0,
        "hard_accel_count": 0,
        "seatbelt_off_s": 0.0,
        "door_open_while_moving_s": 0.0,
        "door_open_while_moving": 0,
        "wiper_s": 0.0,
        "autopilot_s": 0.0,
        "night_s": 0.0,
        "gear_shifts": 0,
        "door_cycles": 0,
        "window_changes": 0,
        "mirror_events": 0,
        "start_soc": soc,
        "end_soc": soc,
        "credited_km": 0.0,
        "series": [],
    }


def _state(driver, sample, moment, trip_id, stats):
    speed = max(-30.0, min(180.0, float(sample.speed_kmh)))
    gear = sample.gear if sample.gear in ("P", "R", "N", "D") else "P"
    abs_speed = abs(speed)
    doors = {name: bool(sample.doors.get(name)) for name in DOOR_NAMES}
    window = max(0.0, min(100.0, float(sample.window_pct)))
    if sample.rain and sample.wiper:
        wiper = "FAST"
    elif sample.wiper:
        wiper = "INTERVAL"
    else:
        wiper = "OFF"
    if abs_speed > 2 and gear in ("D", "R"):
        phase = "driving"
    elif gear == "R" or (abs_speed <= 2 and gear == "D"):
        phase = "maneuver"
    elif any(doors.values()) or sample.frunk or sample.trunk:
        phase = "access"
    else:
        phase = "parked"
    home = driver["home"]
    work = driver["work"]
    frac = max(0.0, min(1.0, float(sample.meters) / 1000))
    lat = home["lat"] + (work["lat"] - home["lat"]) * frac
    lon = home["lon"] + (work["lon"] - home["lon"]) * frac
    limit = max(5.0, min(160.0, float(sample.limit_kmh)))
    soc = max(5.0, stats["start_soc"] - (float(sample.meters) / 1000) * 0.45)
    stats["end_soc"] = soc
    moving = abs_speed > 1 and gear in ("D", "R")
    kw = 0.012 * abs_speed ** 2 if moving else 0.4
    state = State(
        t=moment,
        driver=driver,
        params=driver["params"],
        dt=0.5,
        rng=random.Random(0),
        lat=lat,
        lon=lon,
        heading=float(sample.heading or 0),
        speed_kmh=abs_speed,
        gear=gear,
        pedal=max(0.0, min(100.0, float(sample.pedal))),
        brake_pct=max(0.0, min(100.0, float(sample.brake_pct))),
        long_accel=max(-8.0, min(6.0, float(sample.long_accel))),
        odometer_km=float(driver.get("odometer_km") or 0) + float(sample.meters) / 1000,
        soc=soc,
        pack_voltage=390 - (100 - soc) * 0.45,
        pack_current=(kw * 1000 / 390) if moving else -0.4,
        lifetime_kwh=float(driver.get("lifetime_energy_kwh") or 0) + (float(sample.meters) / 1000) * 0.16,
        phase=phase,
        trip_id=trip_id,
        trip_name=f"{sample.path} {'self-drive' if sample.mode == 'self-drive' else 'manual'}",
        route_name=sample.path,
        along_m=max(0.0, min(1000.0, float(sample.meters))),
        planned_m=1000.0,
        road="highway" if limit >= 80 else ("urban" if limit <= 45 else "arterial"),
        limit_kmh=limit,
        weather="rain" if sample.rain else "clear",
        outside_c=float(driver.get("climate_c") or 22),
        inside_c=float(driver["params"].get("hvac_c") or 22),
        hvac_on=True,
        locked=bool(sample.locked),
        occupied=True,
        belted=bool(sample.belt),
        drive_rail=gear in ("D", "R"),
        autopilot=bool(sample.autopilot),
        cruise_kmh=float(driver["params"].get("cruise_kmh") or 0) if sample.autopilot else 0,
        sentry="SentryModeStateOff",
        doors=doors,
        trunk=bool(sample.trunk),
        frunk=bool(sample.frunk),
        windows={name: window for name in WINDOW_NAMES},
        window_cmd={name: window for name in WINDOW_NAMES},
        wiper=wiper,
        mirror_folded=bool(sample.mirrors_folded),
        mirror_pan=8 + (6 if sample.mirror_nudge else 0),
        mirror_tilt=4,
        mirror_pan_cmd=8 + (6 if sample.mirror_nudge else 0),
        mirror_tilt_cmd=4,
        high_beam=bool(sample.high),
        hazard=bool(sample.hazard),
        display="DisplayStateDriving" if moving else "DisplayStateParked",
        night=moment.hour >= 21 or moment.hour < 5,
    )
    return state


def _cursor(sample, state):
    return {
        "speed_kmh": state.speed_kmh,
        "gear": state.gear,
        "meters": float(sample.meters),
        "doors": {name: bool(sample.doors.get(name)) for name in DOOR_NAMES},
        "window": float(sample.window_pct),
        "mirrors_folded": bool(sample.mirrors_folded),
        "mirror_nudge": bool(sample.mirror_nudge),
        "limit_kmh": state.limit_kmh,
        "accel": state.long_accel,
        "t": state.t.isoformat(),
    }


def _absorb(stats, prev, sample, state):
    try:
        prev_t = datetime.fromisoformat(prev["t"])
        dt = max(0.05, min(5.0, (state.t - prev_t).total_seconds()))
    except (TypeError, ValueError):
        dt = 0.5
    speed = state.speed_kmh
    stats["distance_km"] = max(stats["distance_km"], float(sample.meters) / 1000)
    stats["max_speed_kmh"] = max(stats["max_speed_kmh"], speed)
    if speed > 1 and state.gear in ("D", "R"):
        stats["drive_s"] += dt
    if speed > state.limit_kmh + 1 and speed > 8:
        stats["speeding_s"] += dt
    if not state.belted and speed > 10:
        stats["seatbelt_off_s"] += dt
    if state.wiper != "OFF" and speed > 1:
        stats["wiper_s"] += dt
    open_now = any(state.doors.values()) or state.trunk or state.frunk
    if open_now and speed > 5:
        stats["door_open_while_moving_s"] += dt
        if not any(prev["doors"].values()):
            stats["door_open_while_moving"] += 1
    if state.autopilot and speed > 1:
        stats["autopilot_s"] += dt
    if state.night and speed > 1:
        stats["night_s"] += dt
    prev_speed = float(prev["speed_kmh"])
    accel = ((speed - prev_speed) / 3.6) / dt
    state.long_accel = round(max(-8.0, min(6.0, accel)), 3)
    if accel <= -3.5 and prev_speed > 20 and float(prev.get("accel") or 0) > -3.5:
        stats["hard_brake_count"] += 1
    if accel >= 2.8 and prev_speed < 25 and float(prev.get("accel") or 0) < 2.8:
        stats["hard_accel_count"] += 1
    if prev["gear"] != state.gear:
        stats["gear_shifts"] += 1
    for name in DOOR_NAMES:
        if state.doors[name] and not prev["doors"].get(name):
            stats["door_cycles"] += 1
    if abs(float(sample.window_pct) - float(prev["window"])) >= 20:
        stats["window_changes"] += 1
    if bool(sample.mirrors_folded) != bool(prev["mirrors_folded"]):
        stats["mirror_events"] += 1
    if sample.mirror_nudge and not prev.get("mirror_nudge"):
        stats["mirror_events"] += 1


def _metrics(stats):
    drive_s = stats["drive_s"]
    distance = stats["distance_km"]
    avg = (distance / drive_s * 3600) if drive_s > 1 else stats["max_speed_kmh"]
    return {
        "distance_km": round(distance, 3),
        "drive_s": round(drive_s, 1),
        "avg_speed_kmh": round(avg, 2),
        "max_speed_kmh": round(stats["max_speed_kmh"], 2),
        "speeding_s": round(stats["speeding_s"], 1),
        "hard_brake_count": int(stats["hard_brake_count"]),
        "hard_accel_count": int(stats["hard_accel_count"]),
        "gear_shifts": int(stats["gear_shifts"]),
        "reverse_shifts": 0,
        "door_cycles": int(stats["door_cycles"]),
        "door_open_while_moving": int(stats["door_open_while_moving"]),
        "door_open_while_moving_s": round(stats["door_open_while_moving_s"], 1),
        "window_changes": int(stats["window_changes"]),
        "mirror_events": int(stats["mirror_events"]),
        "wiper_s": round(stats["wiper_s"], 1),
        "seatbelt_off_s": round(stats["seatbelt_off_s"], 1),
        "unlocked_away_s": 0.0,
        "autopilot_s": round(stats["autopilot_s"], 1),
        "night_s": round(stats["night_s"], 1),
        "energy_kwh": round(distance * 0.16, 3),
        "charge_s": 0.0,
        "start_soc": round(stats["start_soc"], 2),
        "end_soc": round(stats["end_soc"], 2),
        "tpms_soft": 0,
        "samples": int(stats["samples"]),
        "events": int(stats["events"]),
        "alert_events": int(stats["alert_events"]),
        "trips": 1,
    }


def _write_series(path, docs, stats):
    for doc in docs:
        stats["series"].append(
            {
                "t": int(datetime.fromisoformat(doc["@timestamp"]).timestamp() * 1000),
                "speed": doc["reading"]["speed_kmh"],
                "limit": doc["road"]["limit_kmh"],
                "soc": doc["reading"]["soc"],
                "gear": doc["reading"]["gear"],
                "phase": doc["phase"],
            }
        )
    if len(stats["series"]) > 1600:
        stats["series"] = stats["series"][-1600:]
    path.write_text(json.dumps(stats["series"]), encoding="utf-8")


def _credit_vehicle(driver, run, stats):
    gained = max(0.0, stats["distance_km"] - float(stats.get("credited_km") or 0))
    if gained <= 0:
        return
    stats["credited_km"] = stats["distance_km"]
    driver["odometer_km"] = round(float(driver.get("odometer_km") or 0) + gained, 3)
    driver["soc"] = round(stats["end_soc"], 2)
    driver["lifetime_energy_kwh"] = round(float(driver.get("lifetime_energy_kwh") or 0) + gained * 0.16, 3)
    save_driver(driver)
    run["vehicle_after"] = {
        "odometer_km": driver["odometer_km"],
        "soc": driver["soc"],
        "lifetime_energy_kwh": driver["lifetime_energy_kwh"],
    }
