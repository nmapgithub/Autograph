"""Driver-and-vehicle day simulator.

Each driving sample is one fleet-style snapshot plus the VSS tree plus CAN
frames. Parked and charging time is coarser on purpose: a real gateway still
streams while awake, but a full-rate parked day is almost duplicate rows.
"""

from __future__ import annotations

import json
import math
import random
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from app.catalog import DI_GEAR, FRAMES
from app.perception import perceive

PACK_KWH = 75.0
KM_TO_MI = 0.621371
WINDOW_NAMES = ("fd", "fp", "rd", "rp")
DOOR_NAMES = ("df", "dr", "pf", "pr")
TRACKS = (
    ("City Loop", "Night Grid", "Autograph FM"),
    ("Service Road", "North Yard", "Autograph FM"),
    ("Glass Tower", "Harbour Line", "Autograph FM"),
    ("Late Platform", "Amber Signal", "Autograph FM"),
)

VSS_WINDOW = {
    "fd": "Vehicle.Cabin.Door.Row1.DriverSide.Window.Position",
    "fp": "Vehicle.Cabin.Door.Row1.PassengerSide.Window.Position",
    "rd": "Vehicle.Cabin.Door.Row2.DriverSide.Window.Position",
    "rp": "Vehicle.Cabin.Door.Row2.PassengerSide.Window.Position",
}
VSS_DOOR = {
    "df": "Vehicle.Cabin.Door.Row1.DriverSide.IsOpen",
    "pf": "Vehicle.Cabin.Door.Row1.PassengerSide.IsOpen",
    "dr": "Vehicle.Cabin.Door.Row2.DriverSide.IsOpen",
    "pr": "Vehicle.Cabin.Door.Row2.PassengerSide.IsOpen",
}
VSS_LOCK = {
    "df": "Vehicle.Cabin.Door.Row1.DriverSide.IsLocked",
    "pf": "Vehicle.Cabin.Door.Row1.PassengerSide.IsLocked",
    "dr": "Vehicle.Cabin.Door.Row2.DriverSide.IsLocked",
    "pr": "Vehicle.Cabin.Door.Row2.PassengerSide.IsLocked",
}


def _num(value, places=3):
    return round(float(value), places)


def _clamp(value, low, high):
    return max(low, min(high, value))


def _bearing(a, b):
    lat1, lon1 = math.radians(a[0]), math.radians(a[1])
    lat2, lon2 = math.radians(b[0]), math.radians(b[1])
    dlon = lon2 - lon1
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _lerp_point(origin, dest, fraction, wobble):
    fraction = _clamp(fraction, 0, 1)
    lat = origin[0] + (dest[0] - origin[0]) * fraction + math.sin(fraction * 14) * wobble
    lon = origin[1] + (dest[1] - origin[1]) * fraction + math.cos(fraction * 11) * wobble
    return lat, lon


def _at(day: date, hour: float, offset_min: int) -> datetime:
    extra_days = int(math.floor(hour / 24))
    hour = hour - extra_days * 24
    h = int(hour)
    m = int(round((hour - h) * 60))
    if m >= 60:
        h += 1
        m -= 60
    if h >= 24:
        h = 0
        extra_days += 1
    tz = timezone(timedelta(minutes=offset_min))
    return datetime(day.year, day.month, day.day, h, m, 0, tzinfo=tz) + timedelta(days=extra_days)


def _window_enum(pct):
    if pct < 3:
        return "WindowStateClosed"
    if pct > 85:
        return "WindowStateOpened"
    return "WindowStatePartiallyOpen"


def _approach(speed_kmh, target_kmh, accel, brake, dt):
    v = speed_kmh / 3.6
    target = max(0.0, target_kmh) / 3.6
    if target >= v:
        used = accel
        v = min(target, v + accel * dt)
        pedal = 0 if accel <= 0 else _clamp(used / 3.2 * 100, 0, 100)
        brake_pct = 0.0
    else:
        used = brake
        v = max(target, v - brake * dt)
        pedal = 0.0
        brake_pct = _clamp(used / 6.5 * 100, 0, 100)
    return v * 3.6, pedal, brake_pct, (v - speed_kmh / 3.6) / dt if dt else 0.0


@dataclass
class State:
    t: datetime
    driver: dict
    params: dict
    dt: float
    rng: random.Random
    lat: float
    lon: float
    heading: float = 0.0
    speed_kmh: float = 0.0
    gear: str = "P"
    pedal: float = 0.0
    brake_pct: float = 0.0
    long_accel: float = 0.0
    lat_accel: float = 0.0
    odometer_km: float = 0.0
    soc: float = 70.0
    pack_voltage: float = 390.0
    pack_current: float = 0.0
    lifetime_kwh: float = 0.0
    trip_kwh: float = 0.0
    phase: str = "parked"
    trip_id: str = ""
    trip_name: str = ""
    road: str = "urban"
    limit_kmh: float = 0.0
    weather: str = "clear"
    outside_c: float = 22.0
    inside_c: float = 22.0
    hvac_on: bool = False
    locked: bool = True
    occupied: bool = False
    belted: bool = False
    belt_due: datetime | None = None
    belt_forced_off_until: datetime | None = None
    passenger: bool = False
    drive_rail: bool = False
    autopilot: bool = False
    cruise_kmh: float = 0.0
    sentry: str = "SentryModeStateArmed"
    charge_state: str = "DetailedChargeStateDisconnected"
    ac_power_kw: float = 0.0
    charge_port: bool = False
    doors: dict = field(default_factory=lambda: {name: False for name in DOOR_NAMES})
    trunk: bool = False
    frunk: bool = False
    windows: dict = field(default_factory=lambda: {name: 0.0 for name in WINDOW_NAMES})
    window_cmd: dict = field(default_factory=lambda: {name: 0.0 for name in WINDOW_NAMES})
    wiper: str = "OFF"
    washer: bool = False
    washer_until: datetime | None = None
    washer_used: bool = False
    mirror_folded: bool = True
    mirror_pan: float = 8.0
    mirror_tilt: float = 4.0
    mirror_pan_cmd: float = 8.0
    mirror_tilt_cmd: float = 4.0
    turn: str = "TurnSignalStateOff"
    turn_until: datetime | None = None
    high_beam: bool = False
    hazard: bool = False
    grade: float = 0.0
    stator_c: float = 28.0
    module_c: float = 26.0
    heading_bias: float = 0.0
    aeb: bool = False
    origin: tuple = (0.0, 0.0)
    dest: tuple = (0.0, 0.0)
    planned_m: float = 1.0
    along_m: float = 0.0
    drive_m: float = 0.0
    track_i: int = 0
    track_elapsed_s: float = 0.0
    brake_override: float | None = None
    accel_override: float | None = None
    accel_override_until: datetime | None = None
    burst_until: datetime | None = None
    force_door_until: datetime | None = None
    night: bool = False
    display: str = "DisplayStateSentry"
    route_name: str = ""

    def copy_flags(self):
        return {
            "gear": self.gear,
            "doors": dict(self.doors),
            "trunk": self.trunk,
            "frunk": self.frunk,
            "charge_port": self.charge_port,
            "locked": self.locked,
            "windows": {k: round(self.window_cmd[k], 1) for k in WINDOW_NAMES},
            "wiper": self.wiper,
            "washer": self.washer,
            "mirror_folded": self.mirror_folded,
            "mirror_pan": round(self.mirror_pan_cmd, 1),
            "belted": self.belted,
            "autopilot": self.autopilot,
            "high_beam": self.high_beam,
            "hazard": self.hazard,
            "turn": self.turn,
            "charge_state": self.charge_state,
            "drive_rail": self.drive_rail,
            "sentry": self.sentry,
            "phase": self.phase,
            "occupied": self.occupied,
        }


class Emitter:
    def __init__(self, state: State, telemetry_path: Path, events_path: Path):
        self.state = state
        self.telemetry_path = telemetry_path
        self.events_path = events_path
        self.telemetry = telemetry_path.open("w", encoding="utf-8")
        self.events_file = events_path.open("w", encoding="utf-8")
        self.prev = None
        self.series = []
        self.events = []
        self.samples = 0
        self.example = None
        self.edges = {
            "speeding": False,
            "seatbelt": False,
            "door": False,
            "unlocked": False,
        }
        self.stats = {
            "distance_km": 0.0,
            "drive_s": 0.0,
            "speed_sum": 0.0,
            "speed_n": 0,
            "max_speed_kmh": 0.0,
            "speeding_s": 0.0,
            "hard_brake_count": 0,
            "hard_accel_count": 0,
            "gear_shifts": 0,
            "reverse_count": 0,
            "door_cycles": 0,
            "door_open_while_moving": 0,
            "door_open_while_moving_s": 0.0,
            "window_changes": 0,
            "mirror_events": 0,
            "wiper_s": 0.0,
            "seatbelt_off_s": 0.0,
            "unlocked_away_s": 0.0,
            "autopilot_s": 0.0,
            "night_s": 0.0,
            "energy_kwh": 0.0,
            "charge_s": 0.0,
            "alert_events": 0,
        }

    def close(self):
        self.telemetry.close()
        self.events_file.close()

    def event(self, kind, severity, detail):
        state = self.state
        doc = {
            "@timestamp": state.t.isoformat(timespec="milliseconds"),
            "log_type": "event",
            "simulator": "autograph",
            "event": kind,
            "severity": severity,
            "phase": state.phase,
            "trip_id": state.trip_id,
            "entity": _entity(state),
            "detail": detail,
            "context": {
                "speed_kmh": _num(state.speed_kmh, 2),
                "gear": state.gear,
                "soc": _num(state.soc, 2),
                "limit_kmh": _num(state.limit_kmh, 1),
            },
        }
        self.events.append(doc)
        self.events_file.write(json.dumps(doc, separators=(",", ":")) + "\n")
        if severity == "alert":
            self.stats["alert_events"] += 1
        if kind == "gear_shift":
            self.stats["gear_shifts"] += 1
            if detail.get("to") == "R":
                self.stats["reverse_count"] += 1
        elif kind in ("door_open", "door_open_while_moving", "trunk_open", "frunk_open"):
            self.stats["door_cycles"] += 1
            if kind == "door_open_while_moving":
                self.stats["door_open_while_moving"] += 1
        elif kind == "window":
            self.stats["window_changes"] += 1
        elif kind in ("mirror_adjust", "mirror_fold"):
            self.stats["mirror_events"] += 1
        elif kind == "hard_brake":
            self.stats["hard_brake_count"] += 1
        elif kind == "hard_accel":
            self.stats["hard_accel_count"] += 1

    def sample(self, dt):
        state = self.state
        flags = state.copy_flags()
        if self.prev is not None:
            self._diff(self.prev, flags)
        self._durations(dt)
        self._edges()
        doc = build_document(state)
        self._vision(doc)
        self.telemetry.write(json.dumps(doc, separators=(",", ":")) + "\n")
        self.samples += 1
        self.series.append(
            {
                "t": int(state.t.timestamp() * 1000),
                "speed": _num(state.speed_kmh, 2),
                "limit": _num(state.limit_kmh, 1),
                "soc": _num(state.soc, 2),
                "gear": state.gear,
                "phase": state.phase,
            }
        )
        if self.example is None and state.phase == "driving" and state.speed_kmh > 15:
            self.example = doc
        self.prev = flags

    def _vision(self, doc):
        tracks = (doc.get("perception") or {}).get("tracks") or []
        spaces = (doc.get("perception") or {}).get("parking_spaces") or []
        current = {track["id"] for track in tracks}
        current.update(space["id"] for space in spaces)
        seen = getattr(self, "_seen_vision", set())
        for track in tracks:
            if track["id"] in seen:
                continue
            if track["class"] not in ("pedestrian", "vehicle", "obstacle", "speed_bump"):
                continue
            close = track.get("in_path") and track["range_m"] < 8 and track["class"] == "pedestrian"
            self.event(
                "vision_detect",
                "alert" if close else "info",
                {
                    "id": track["id"],
                    "class": track["class"],
                    "camera": track["camera"],
                    "range_m": track["range_m"],
                    "lateral_m": track["lateral_m"],
                    "confidence": track["confidence"],
                    "in_path": track["in_path"],
                },
            )
        for space in spaces:
            if space["id"] in seen:
                continue
            self.event(
                "parking_space",
                "info",
                {"id": space["id"], "side": space["side"], "range_m": space["range_m"], "free": space["free"]},
            )
        self._seen_vision = current

    def _diff(self, prev, cur):
        state = self.state
        if prev["gear"] != cur["gear"]:
            self.event(
                "gear_shift",
                "info",
                {"from": prev["gear"], "to": cur["gear"], "speed_kmh": _num(state.speed_kmh, 2)},
            )
        for name in DOOR_NAMES:
            if prev["doors"][name] != cur["doors"][name]:
                opened = cur["doors"][name]
                moving = opened and state.speed_kmh > 5
                self.event(
                    "door_open_while_moving" if moving else ("door_open" if opened else "door_close"),
                    "alert" if moving else "info",
                    {"door": name, "open": opened},
                )
        for label, key in (("trunk", "trunk"), ("frunk", "frunk"), ("charge_port", "charge_port")):
            if prev[key] != cur[key]:
                self.event(
                    f"{label}_{'open' if cur[key] else 'close'}",
                    "info",
                    {label: cur[key]},
                )
        if prev["locked"] != cur["locked"]:
            self.event("unlock" if not cur["locked"] else "lock", "info", {"locked": cur["locked"]})
        for name in WINDOW_NAMES:
            if prev["windows"][name] != cur["windows"][name]:
                self.event(
                    "window",
                    "info",
                    {
                        "window": name,
                        "command_pct": cur["windows"][name],
                        "position_pct": _num(state.windows[name], 1),
                    },
                )
        if prev["wiper"] != cur["wiper"]:
            self.event("wiper", "info", {"from": prev["wiper"], "to": cur["wiper"]})
        if prev["washer"] != cur["washer"] and cur["washer"]:
            self.event("washer", "info", {"active": True})
        if prev["mirror_folded"] != cur["mirror_folded"]:
            self.event("mirror_fold", "info", {"folded": cur["mirror_folded"]})
        if abs(prev["mirror_pan"] - cur["mirror_pan"]) >= 1.5:
            self.event(
                "mirror_adjust",
                "info",
                {"pan_deg": cur["mirror_pan"], "tilt_deg": _num(state.mirror_tilt, 1)},
            )
        if prev["belted"] != cur["belted"]:
            self.event("seatbelt", "info" if cur["belted"] else "watch", {"fastened": cur["belted"]})
        if prev["autopilot"] != cur["autopilot"]:
            self.event("autopilot", "info", {"active": cur["autopilot"]})
        if prev["turn"] != cur["turn"]:
            self.event("turn_signal", "info", {"state": cur["turn"]})
        if prev["high_beam"] != cur["high_beam"]:
            self.event("high_beam", "info", {"on": cur["high_beam"]})
        if prev["charge_state"] != cur["charge_state"]:
            self.event("charge_state", "info", {"from": prev["charge_state"], "to": cur["charge_state"]})
        if prev["drive_rail"] != cur["drive_rail"]:
            self.event("drive_rail", "info", {"on": cur["drive_rail"]})
        if prev["phase"] != cur["phase"]:
            self.event("phase", "info", {"from": prev["phase"], "to": cur["phase"]})
        if prev["occupied"] != cur["occupied"]:
            self.event("occupancy", "info", {"occupied": cur["occupied"]})

    def _durations(self, dt):
        state = self.state
        stats = self.stats
        moving = state.speed_kmh > 1 and state.phase in ("driving", "maneuver")
        dist = state.speed_kmh * dt / 3600
        stats["distance_km"] += dist
        if moving:
            stats["drive_s"] += dt
            stats["speed_sum"] += state.speed_kmh * dt
            stats["speed_n"] += dt
            stats["max_speed_kmh"] = max(stats["max_speed_kmh"], state.speed_kmh)
            if state.night:
                stats["night_s"] += dt
            if state.autopilot:
                stats["autopilot_s"] += dt
        if state.limit_kmh >= 40 and state.speed_kmh > state.limit_kmh * 1.05:
            stats["speeding_s"] += dt
        if state.wiper != "OFF":
            stats["wiper_s"] += dt
        if (not state.belted) and state.speed_kmh > 10:
            stats["seatbelt_off_s"] += dt
        door_open = any(state.doors.values()) or state.trunk or state.frunk
        if door_open and state.speed_kmh > 5:
            stats["door_open_while_moving_s"] += dt
        if state.phase == "parked" and (not state.locked) and (not state.occupied) and state.speed_kmh < 1:
            stats["unlocked_away_s"] += dt
        if state.phase == "charging":
            stats["charge_s"] += dt
        if state.phase in ("driving", "maneuver") and dist > 0:
            stats["energy_kwh"] += max(0.0, state.pack_current) * state.pack_voltage * dt / 3_600_000

    def _edges(self):
        state = self.state
        speeding = state.limit_kmh >= 40 and state.speed_kmh > state.limit_kmh * 1.05
        if speeding and not self.edges["speeding"]:
            self.event(
                "speeding_start",
                "alert",
                {"speed_kmh": _num(state.speed_kmh, 1), "limit_kmh": _num(state.limit_kmh, 1)},
            )
        if self.edges["speeding"] and not speeding:
            self.event("speeding_end", "info", {"speed_kmh": _num(state.speed_kmh, 1)})
        self.edges["speeding"] = speeding

        belt_bad = (not state.belted) and state.speed_kmh > 10
        if belt_bad and not self.edges["seatbelt"]:
            self.event("seatbelt_off_moving", "alert", {"speed_kmh": _num(state.speed_kmh, 1)})
        if self.edges["seatbelt"] and not belt_bad and state.belted:
            self.event("seatbelt_on_moving", "info", {})
        self.edges["seatbelt"] = belt_bad

        door_bad = (any(state.doors.values()) or state.trunk) and state.speed_kmh > 5
        self.edges["door"] = door_bad

        # Hard accel / brake edges are detected from the step that produced them.
        # sample() is called after physics, so compare against a stored accel.
        prev_accel = getattr(self, "_prev_accel", 0.0)
        if state.long_accel <= -3.5 and prev_accel > -3.5 and state.speed_kmh > 8:
            self.event("hard_brake", "alert", {"accel_mps2": _num(state.long_accel, 2)})
        if state.long_accel >= 2.8 and prev_accel < 2.8:
            self.event("hard_accel", "alert", {"accel_mps2": _num(state.long_accel, 2)})
        self._prev_accel = state.long_accel

    def metrics(self, start_soc):
        stats = self.stats
        drive_s = max(stats["drive_s"], 0.0)
        avg = stats["speed_sum"] / stats["speed_n"] if stats["speed_n"] else 0.0
        tires = self.state.driver.get("tires_bar") or [2.9, 2.9, 2.9, 2.9]
        return {
            "distance_km": round(stats["distance_km"], 3),
            "drive_s": round(drive_s, 1),
            "avg_speed_kmh": round(avg, 2),
            "max_speed_kmh": round(stats["max_speed_kmh"], 2),
            "speeding_s": round(stats["speeding_s"], 1),
            "speeding_ratio": round(stats["speeding_s"] / drive_s, 4) if drive_s else 0,
            "hard_brake_count": stats["hard_brake_count"],
            "hard_accel_count": stats["hard_accel_count"],
            "gear_shifts": stats["gear_shifts"],
            "reverse_count": stats["reverse_count"],
            "door_cycles": stats["door_cycles"],
            "door_open_while_moving": stats["door_open_while_moving"],
            "door_open_while_moving_s": round(stats["door_open_while_moving_s"], 1),
            "window_changes": stats["window_changes"],
            "mirror_events": stats["mirror_events"],
            "wiper_s": round(stats["wiper_s"], 1),
            "seatbelt_off_s": round(stats["seatbelt_off_s"], 1),
            "unlocked_away_s": round(stats["unlocked_away_s"], 1),
            "autopilot_s": round(stats["autopilot_s"], 1),
            "night_s": round(stats["night_s"], 1),
            "energy_kwh": round(stats["energy_kwh"], 3),
            "charge_s": round(stats["charge_s"], 1),
            "start_soc": round(start_soc, 2),
            "end_soc": round(self.state.soc, 2),
            "tpms_soft": int(any(p < 2.6 for p in tires)),
            "samples": self.samples,
            "events": len(self.events),
            "alert_events": stats["alert_events"],
            "trips": 0,
        }


def _entity(state: State):
    driver = state.driver
    return {
        "type": "vehicle",
        "vin": driver["vin"],
        "driver_id": driver["id"],
        "driver_name": driver["name"],
        "vehicle_name": driver["vehicle_name"],
        "model": driver["model"],
    }


def _pack(values):
    raw = bytearray(8)
    for index, value in enumerate(values[:8]):
        raw[index] = int(_clamp(value, 0, 255))
    raw[7] = 0
    raw[7] = sum(raw[:7]) & 0xFF
    return raw.hex()


def _frame(key, signals, payload):
    spec = FRAMES[key]
    return {
        "id": spec["id"],
        "id_hex": spec["id_hex"],
        "bus": spec["bus"],
        "ecu": spec["ecu"],
        "name": key,
        "dlc": spec["dlc"],
        "layout": "simplified",
        "data_hex": _pack(payload),
        "signals": signals,
    }


def build_document(state: State):
    driver = state.driver
    p = state.params
    speed_mph = state.speed_kmh * KM_TO_MI
    gear_name = {"P": "ShiftStateP", "R": "ShiftStateR", "N": "ShiftStateN", "D": "ShiftStateD"}[state.gear]
    rated = float(driver.get("rated_range_km", 520))
    range_km = rated * (state.soc / 100) * 0.94
    motor_rpm = (state.speed_kmh / 3.6) / 0.335 * 60 / (2 * math.pi) * 9.0
    axle_torque = 1800 * state.long_accel * 0.335
    if state.speed_kmh > 5:
        axle_torque += (0.0016 * state.speed_kmh ** 2) * 1000 / max(state.speed_kmh / 3.6, 0.5) * 0.335
    hvac_power = "HvacPowerStateOn" if state.hvac_on else "HvacPowerStateOff"
    bms = {
        "driving": "BMSStateDrive",
        "maneuver": "BMSStateDrive",
        "charging": "BMSStateCharge",
        "access": "BMSStateSupport",
        "parked": "BMSStateStandby",
    }[state.phase]
    inverter = "DriveInverterStateEnable" if state.drive_rail and state.gear in ("D", "R") else "DriveInverterStateStandby"
    home = driver["home"]
    work = driver["work"]
    here = (state.lat, state.lon)

    def near(place):
        return _haversine(here, (place["lat"], place["lon"])) < 0.25

    tires = list(driver.get("tires_bar") or [2.9, 2.9, 2.9, 2.9])
    fl, fr, rl, rr = tires
    soft = {
        "front_left": fl < 2.6,
        "front_right": fr < 2.6,
        "rear_left": rl < 2.6,
        "rear_right": rr < 2.6,
    }
    hard = {k: tires[i] < 2.2 for i, k in enumerate(("front_left", "front_right", "rear_left", "rear_right"))}
    track = TRACKS[state.track_i % len(TRACKS)]
    volume = float(p["media_volume"])
    playing = state.phase in ("driving", "maneuver", "access")
    tesla = {
        "VehicleSpeed": _num(speed_mph, 2),
        "Gear": gear_name,
        "PedalPosition": _num(state.pedal, 1),
        "BrakePedal": state.brake_pct > 8,
        "BrakePedalPos": _num(state.brake_pct * 0.4, 2),
        "LongitudinalAcceleration": _num(state.long_accel, 3),
        "LateralAcceleration": _num(state.lat_accel, 3),
        "Odometer": _num(state.odometer_km * KM_TO_MI, 3),
        "CruiseSetSpeed": _num(state.cruise_kmh * KM_TO_MI, 1) if state.autopilot else 0,
        "GradeEstimatePercent": _num(state.grade, 2),
        "Soc": _num(state.soc, 2),
        "BatteryLevel": _num(state.soc, 2),
        "PackVoltage": _num(state.pack_voltage, 2),
        "PackCurrent": _num(state.pack_current, 2),
        "EstBatteryRange": _num(range_km * KM_TO_MI, 2),
        "EnergyRemaining": _num(PACK_KWH * state.soc / 100, 2),
        "LifetimeEnergyUsed": _num(state.lifetime_kwh, 3),
        "DiStateR": inverter,
        "DiStateF": inverter,
        "DiAxleSpeedR": _num(motor_rpm, 1),
        "DiAxleSpeedF": _num(motor_rpm * 0.98, 1),
        "DiTorqueActualR": _num(axle_torque, 1),
        "DiTorqueActualF": _num(axle_torque * 0.35, 1),
        "DiStatorTempR": _num(state.stator_c, 2),
        "DiStatorTempF": _num(state.stator_c - 3, 2),
        "BMSState": bms,
        "Hvil": "HvilStatusOK",
        "DetailedChargeState": state.charge_state,
        "ChargeState": {
            "DetailedChargeStateDisconnected": "Disconnected",
            "DetailedChargeStateCharging": "Charging",
            "DetailedChargeStateComplete": "Complete",
        }.get(state.charge_state, "Disconnected"),
        "ACChargingPower": _num(state.ac_power_kw, 2),
        "ChargeAmps": 16 if state.phase == "charging" and state.ac_power_kw > 0 else 0,
        "ChargerPhases": 3 if state.ac_power_kw > 0 else 0,
        "ChargerVoltage": 230 if state.phase == "charging" else _num(state.pack_voltage * 0.05 + 220, 1),
        "ChargingCableType": "CableTypeIEC" if state.charge_port else "CableTypeUnknown",
        "ChargePortDoorOpen": state.charge_port,
        "ChargePortLatch": "ChargePortLatchEngaged" if state.phase == "charging" else "ChargePortLatchDisengaged",
        "ChargeLimitSoc": int(p["charge_target_soc"]),
        "FastChargerPresent": False,
        "DoorState": {
            "DriverFront": state.doors["df"],
            "DriverRear": state.doors["dr"],
            "PassengerFront": state.doors["pf"],
            "PassengerRear": state.doors["pr"],
            "TrunkFront": state.frunk,
            "TrunkRear": state.trunk,
        },
        "Locked": state.locked,
        "FdWindow": _window_enum(state.windows["fd"]),
        "FpWindow": _window_enum(state.windows["fp"]),
        "RdWindow": _window_enum(state.windows["rd"]),
        "RpWindow": _window_enum(state.windows["rp"]),
        "WiperHeatEnabled": state.wiper != "OFF" and state.outside_c < 8,
        "LightsTurnSignal": state.turn,
        "LightsHighBeams": state.high_beam,
        "LightsHazardsActive": state.hazard,
        "InsideTemp": _num(state.inside_c, 2),
        "OutsideTemp": _num(state.outside_c, 2),
        "HvacPower": hvac_power,
        "HvacAutoMode": "HvacAutoModeStateOn" if state.hvac_on else "HvacAutoModeStateUnknown",
        "HvacLeftTemperatureRequest": p["hvac_c"],
        "HvacRightTemperatureRequest": p["hvac_c"],
        "HvacFanSpeed": 3 if state.hvac_on and abs(state.inside_c - p["hvac_c"]) > 1.5 else (1 if state.hvac_on else 0),
        "SeatHeaterLeft": 2 if state.hvac_on and state.outside_c < 12 else 0,
        "DriverSeatBelt": not state.belted,
        "DriverSeatOccupied": state.occupied,
        "PassengerSeatBelt": "BuckleStatusLatched" if state.passenger and state.belted else "BuckleStatusUnlatched",
        "SentryMode": state.sentry,
        "DriveRail": state.drive_rail,
        "Location": {"latitude": _num(state.lat, 6), "longitude": _num(state.lon, 6)},
        "GpsHeading": _num(state.heading, 2),
        "GpsState": True,
        "LocatedAtHome": near(home),
        "LocatedAtWork": near(work),
        "TpmsPressureFl": _num(fl, 3),
        "TpmsPressureFr": _num(fr, 3),
        "TpmsPressureRl": _num(rl, 3),
        "TpmsPressureRr": _num(rr, 3),
        "TpmsSoftWarnings": soft,
        "TpmsHardWarnings": hard,
        "ModuleTempMax": _num(state.module_c + 1.4, 2),
        "ModuleTempMin": _num(state.module_c - 0.8, 2),
        "MediaAudioVolume": volume if playing else 0,
        "MediaPlaybackStatus": "MediaStatusPlaying" if playing else "MediaStatusStopped",
        "MediaNowPlayingTitle": track[0] if playing else "",
        "MediaNowPlayingArtist": track[1] if playing else "",
        "MediaNowPlayingStation": track[2] if playing else "",
        "CenterDisplay": state.display,
        "CarType": driver["car_type"],
        "Version": driver["firmware"],
        "Trim": driver["trim"],
        "ExteriorColor": driver["exterior_color"],
        "VehicleName": driver["vehicle_name"],
        "ChargePort": driver["charge_port"],
        "RightHandDrive": driver["right_hand_drive"],
        "SettingDistanceUnit": driver["distance_unit"],
        "SettingTemperatureUnit": driver["temperature_unit"],
        "AutomaticEmergencyBrakingOff": False,
        "AutopilotActive": state.autopilot,
    }
    vss = {
        "Vehicle.Speed": _num(state.speed_kmh, 2),
        "Vehicle.Powertrain.Transmission.SelectedGear": state.gear,
        "Vehicle.Powertrain.Transmission.CurrentGear": {"P": 0, "R": -1, "N": 0, "D": 1}[state.gear],
        "Vehicle.Chassis.ParkingBrake.IsEngaged": state.gear == "P",
        "Vehicle.Chassis.Accelerator.PedalPosition": _num(state.pedal, 1),
        "Vehicle.Chassis.Brake.PedalPosition": _num(state.brake_pct, 1),
        "Vehicle.Acceleration.Longitudinal": _num(state.long_accel, 3),
        "Vehicle.Acceleration.Lateral": _num(state.lat_accel, 3),
        "Vehicle.TraveledDistance": int(state.odometer_km * 1000),
        "Vehicle.ADAS.CruiseControl.SpeedSet": _num(state.cruise_kmh, 1) if state.autopilot else 0,
        "Vehicle.ADAS.CruiseControl.IsActive": state.autopilot,
        "Vehicle.ADAS.ABS.IsEngaged": bool(state.aeb or state.brake_pct >= 70),
        "Vehicle.ADAS.ESC.IsEngaged": bool(state.aeb or abs(state.lat_accel) >= 2.2),
        "Vehicle.Powertrain.TractionBattery.StateOfCharge.Current": _num(state.soc, 2),
        "Vehicle.Powertrain.TractionBattery.CurrentVoltage": _num(state.pack_voltage, 2),
        "Vehicle.Powertrain.TractionBattery.CurrentCurrent": _num(state.pack_current, 2),
        "Vehicle.Powertrain.TractionBattery.Range": _num(range_km, 2),
        "Vehicle.Powertrain.TractionBattery.StateOfCharge.CurrentEnergy": _num(PACK_KWH * state.soc / 100, 2),
        "Vehicle.Powertrain.TractionBattery.IsPowerConnected": state.drive_rail or state.phase == "charging",
        "Vehicle.Powertrain.TractionBattery.Charging.IsCharging": state.phase == "charging" and state.ac_power_kw > 0,
        "Vehicle.Powertrain.ElectricMotor.Rear.Speed": _num(motor_rpm, 1),
        "Vehicle.Powertrain.ElectricMotor.Rear.Torque": _num(axle_torque, 1),
        "Vehicle.Powertrain.ElectricMotor.Rear.Temperature": _num(state.stator_c, 2),
        "Vehicle.Body.Hood.IsOpen": state.frunk,
        "Vehicle.Body.Trunk.Rear.IsOpen": state.trunk,
        "Vehicle.Body.ChargePort.IsOpen": state.charge_port,
        "Vehicle.Body.Windshield.Front.Wiping.Mode": state.wiper,
        "Vehicle.Body.Windshield.Front.Washer.IsActive": state.washer,
        "Vehicle.Body.Mirrors.DriverSide.IsFolded": state.mirror_folded,
        "Vehicle.Body.Mirrors.DriverSide.Pan": _num(state.mirror_pan, 1),
        "Vehicle.Body.Mirrors.DriverSide.Tilt": _num(state.mirror_tilt, 1),
        "Vehicle.Body.Lights.DirectionIndicator.Left.IsSignaling": state.turn == "TurnSignalStateLeft",
        "Vehicle.Body.Lights.DirectionIndicator.Right.IsSignaling": state.turn == "TurnSignalStateRight",
        "Vehicle.Body.Lights.Beam.High.IsOn": state.high_beam,
        "Vehicle.Body.Lights.Hazard.IsSignaling": state.hazard,
        "Vehicle.Cabin.Temperature": _num(state.inside_c, 2),
        "Vehicle.Exterior.AirTemperature": _num(state.outside_c, 2),
        "Vehicle.Cabin.HVAC.IsAirConditioningActive": state.hvac_on,
        "Vehicle.Cabin.HVAC.Station.Row1.Driver.Temperature": p["hvac_c"],
        "Vehicle.Cabin.Seat.Row1.DriverSide.IsBelted": state.belted,
        "Vehicle.Cabin.Seat.Row1.DriverSide.IsOccupied": state.occupied,
        "Vehicle.CurrentLocation.Latitude": _num(state.lat, 6),
        "Vehicle.CurrentLocation.Longitude": _num(state.lon, 6),
        "Vehicle.CurrentLocation.Heading": _num(state.heading, 2),
        "Vehicle.Cabin.Infotainment.Media.Volume": _num(volume / 11 * 100, 1) if playing else 0,
        "Vehicle.Chassis.Axle.Row1.Wheel.Left.Tire.Pressure": _num(fl * 100, 1),
        "Vehicle.Chassis.Axle.Row1.Wheel.Right.Tire.Pressure": _num(fr * 100, 1),
        "Vehicle.Chassis.Axle.Row2.Wheel.Left.Tire.Pressure": _num(rl * 100, 1),
        "Vehicle.Chassis.Axle.Row2.Wheel.Right.Tire.Pressure": _num(rr * 100, 1),
    }
    for name, path in VSS_DOOR.items():
        vss[path] = state.doors[name]
    for name, path in VSS_LOCK.items():
        vss[path] = state.locked
    for name, path in VSS_WINDOW.items():
        vss[path] = _num(state.windows[name], 1)

    gear_code = DI_GEAR[state.gear]
    wiper_code = {"OFF": 0, "INTERVAL": 1, "SLOW": 2, "MEDIUM": 3, "FAST": 4}[state.wiper]
    turn_code = {
        "TurnSignalStateOff": 0,
        "TurnSignalStateLeft": 1,
        "TurnSignalStateRight": 2,
        "TurnSignalStateBoth": 3,
    }[state.turn]
    frames = [
        _frame(
            "DI_systemStatus",
            {
                "DI_gear": gear_code,
                "DI_gear_name": state.gear,
                "DI_accelPedalPos": _num(state.pedal, 1),
                "DI_brakePedal": 1 if state.brake_pct > 8 else 0,
                "DI_vehicleSpeed_kmh": _num(state.speed_kmh, 2),
            },
            [int(state.speed_kmh) & 0xFF, gear_code, int(state.pedal), int(state.brake_pct), 0, 0, 0],
        ),
        _frame(
            "DI_speed",
            {"DI_uiSpeed_mph": _num(speed_mph, 2), "DI_vehicleSpeed_kmh": _num(state.speed_kmh, 2)},
            [int(speed_mph) & 0xFF, int(state.speed_kmh) & 0xFF, 0, 0, 0, 0, 0],
        ),
        _frame(
            "VCLEFT_doorStatus",
            {
                "VCLEFT_frontDoorOpen": int(state.doors["df"]),
                "VCLEFT_rearDoorOpen": int(state.doors["dr"]),
                "VCLEFT_mirrorFolded": int(state.mirror_folded),
                "locked": int(state.locked),
            },
            [int(state.doors["df"]), int(state.doors["dr"]), int(state.mirror_folded), int(state.locked), int(state.frunk), 0, 0],
        ),
        _frame(
            "VCRIGHT_doorStatus",
            {
                "VCRIGHT_frontDoorOpen": int(state.doors["pf"]),
                "VCRIGHT_rearDoorOpen": int(state.doors["pr"]),
                "VCRIGHT_trunkOpen": int(state.trunk),
            },
            [int(state.doors["pf"]), int(state.doors["pr"]), int(state.trunk), int(state.charge_port), 0, 0, 0],
        ),
        _frame(
            "DAS_bodyControls",
            {
                "DAS_wiperSpeed": wiper_code,
                "DAS_wiperMode": state.wiper,
                "DAS_turnIndicator": turn_code,
                "DAS_highBeam": int(state.high_beam),
                "DAS_hazard": int(state.hazard),
            },
            [wiper_code, turn_code, int(state.high_beam), int(state.hazard), int(state.washer), 0, 0],
        ),
        _frame(
            "SIM_bmsStatus",
            {
                "packVoltage_V": _num(state.pack_voltage, 1),
                "packCurrent_A": _num(state.pack_current, 1),
                "soc_pct": _num(state.soc, 1),
                "bms": bms,
            },
            [int(state.pack_voltage / 2), int(_clamp(state.pack_current + 128, 0, 255)), int(state.soc), 1 if state.phase == "charging" else 0, 0, 0, 0],
        ),
        _frame(
            "SIM_thermalTpms",
            {
                "moduleTemp_C": _num(state.module_c, 1),
                "statorTemp_C": _num(state.stator_c, 1),
                "tpms_bar": [_num(fl, 2), _num(fr, 2), _num(rl, 2), _num(rr, 2)],
            },
            [int(state.module_c + 40), int(state.stator_c + 40), int(fl * 20), int(fr * 20), int(rl * 20), int(rr * 20), 0],
        ),
        _frame(
            "SIM_openings",
            {
                "window_pct": {name: _num(state.windows[name], 1) for name in WINDOW_NAMES},
                "mirror_pan_deg": _num(state.mirror_pan, 1),
                "mirror_tilt_deg": _num(state.mirror_tilt, 1),
                "chargePortOpen": state.charge_port,
            },
            [int(state.windows["fd"]), int(state.windows["fp"]), int(state.windows["rd"]), int(state.windows["rp"]), int(state.mirror_pan + 40), int(state.mirror_tilt + 40), int(state.charge_port)],
        ),
    ]
    perception = perceive(state)
    cabin = perception["cabin"]
    vss["Vehicle.Cabin.Seat.Row1.DriverSide.IsOccupied"] = cabin["driver"]
    vss["Vehicle.Cabin.Seat.Row1.PassengerSide.IsOccupied"] = cabin["passenger"]
    vss["Vehicle.Cabin.Seat.Row2.DriverSide.IsOccupied"] = cabin["rear_left"]
    vss["Vehicle.Cabin.Seat.Row2.PassengerSide.IsOccupied"] = cabin["rear_right"]
    counts = perception["counts"]
    nearest = perception["tracks"][0]["range_m"] if perception["tracks"] else 0
    frames.append(
        _frame(
            "SIM_vision",
            {
                "vehicles": counts["vehicle"],
                "pedestrians": counts["pedestrian"],
                "obstacles": counts["obstacle"] + counts["speed_bump"],
                "nearest_m": nearest,
                "driverOccupied": int(cabin["driver"]),
                "passengerOccupied": int(cabin["passenger"]),
            },
            [
                counts["vehicle"],
                counts["pedestrian"],
                counts["obstacle"] + counts["speed_bump"],
                int(max(0, min(255, nearest))),
                int(cabin["driver"]),
                int(cabin["passenger"]),
                int(cabin["rear_left"]) + 2 * int(cabin["rear_right"]),
            ],
        )
    )
    open_doors = [name for name, opened in state.doors.items() if opened]
    if state.trunk:
        open_doors.append("trunk")
    if state.frunk:
        open_doors.append("frunk")
    return {
        "@timestamp": state.t.isoformat(timespec="milliseconds"),
        "log_type": "telemetry",
        "simulator": "autograph",
        "standards": ["COVESA-VSS", "Tesla-Fleet-Telemetry", "ISO-11898"],
        "phase": state.phase,
        "trip_id": state.trip_id,
        "trip_name": state.trip_name,
        "interval_ms": int(state.dt * 1000),
        "entity": _entity(state),
        "road": {"kind": state.road, "limit_kmh": _num(state.limit_kmh, 1), "weather": state.weather},
        "reading": {
            "speed_kmh": _num(state.speed_kmh, 2),
            "gear": state.gear,
            "soc": _num(state.soc, 2),
            "doors_open": open_doors,
            "windows_pct": {name: _num(state.windows[name], 1) for name in WINDOW_NAMES},
            "wiper": state.wiper,
            "locked": state.locked,
            "belted": state.belted,
            "lat": _num(state.lat, 6),
            "lon": _num(state.lon, 6),
            "seen": perception["summary"],
        },
        "tesla": tesla,
        "vss": vss,
        "perception": perception,
        "can": {"standard": "ISO-11898-1", "bitrate": 500000, "frames": frames},
    }


def _haversine(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6371 * 2 * math.asin(min(1, math.sqrt(h)))


def _sync_derived(state: State):
    p = state.params
    hour = state.t.hour
    state.night = hour >= 21 or hour < 5
    if state.belt_forced_off_until and state.t < state.belt_forced_off_until:
        state.belted = False
    elif state.belt_forced_off_until and state.t >= state.belt_forced_off_until:
        state.belted = True
        state.belt_forced_off_until = None
    elif state.belt_due and state.t >= state.belt_due:
        state.belted = True
        state.belt_due = None
    if state.force_door_until and state.t < state.force_door_until:
        state.doors["df"] = True
    elif state.force_door_until and state.t >= state.force_door_until:
        state.doors["df"] = False
        state.force_door_until = None
    if state.turn_until and state.t >= state.turn_until:
        state.turn = "TurnSignalStateOff"
        state.turn_until = None
    if state.washer_until and state.t >= state.washer_until:
        state.washer = False
        state.washer_until = None
    state.heading_bias *= max(0.0, 1 - 0.8 * min(state.dt, 2))
    target_inside = p["hvac_c"] if state.hvac_on else state.outside_c
    tau = 500 if state.hvac_on else 1400
    state.inside_c += (target_inside - state.inside_c) * (1 - math.exp(-state.dt / tau))
    target_stator = 30 + state.speed_kmh * 0.22 + abs(state.long_accel) * 4
    if state.phase == "charging":
        target_stator = 32
    state.stator_c += (target_stator - state.stator_c) * (1 - math.exp(-state.dt / 40))
    target_module = 25 + (state.phase == "charging") * 6 + max(0, 30 - state.outside_c) * 0.05
    state.module_c += (target_module - state.module_c) * (1 - math.exp(-state.dt / 80))
    state.grade = 2.4 * math.sin(state.odometer_km * 2.3)
    state.pack_voltage = 348 + state.soc * 0.72 - max(0, state.pack_current) * 0.04
    if state.phase == "parked" and state.locked and not state.occupied:
        state.sentry = "SentryModeStateArmed"
        state.display = "DisplayStateSentry"
    elif state.phase == "charging":
        state.sentry = "SentryModeStateOff"
        state.display = "DisplayStateCharging"
    elif state.phase == "driving":
        state.sentry = "SentryModeStateOff"
        state.display = "DisplayStateDriving"
    elif state.phase == "access":
        state.sentry = "SentryModeStateOff"
        state.display = "DisplayStateOn"
    else:
        state.sentry = "SentryModeStateOff"
        state.display = "DisplayStateOn"
    if state.phase in ("driving", "maneuver", "access"):
        state.track_elapsed_s += state.dt
        if state.track_elapsed_s > 200:
            state.track_elapsed_s = 0
            state.track_i += 1
    _wiper(state)


def _move_windows(state, dt):
    for name in WINDOW_NAMES:
        cmd = state.window_cmd[name]
        pos = state.windows[name]
        delta = cmd - pos
        if abs(delta) <= 1:
            state.windows[name] = cmd
        else:
            state.windows[name] = pos + math.copysign(min(abs(delta), 40 * dt), delta)


def _move_mirrors(state, dt):
    for attr, cmd in (("mirror_pan", "mirror_pan_cmd"), ("mirror_tilt", "mirror_tilt_cmd")):
        pos = getattr(state, attr)
        target = getattr(state, cmd)
        delta = target - pos
        if abs(delta) <= 0.4:
            setattr(state, attr, target)
        else:
            setattr(state, attr, pos + math.copysign(min(abs(delta), 25 * dt), delta))


def _wiper(state: State):
    speed = state.speed_kmh
    if state.weather != "rain" or state.phase not in ("driving", "maneuver"):
        desired = "OFF"
    elif speed < 3:
        desired = "OFF" if state.wiper == "OFF" else ("OFF" if speed < 1 else "INTERVAL")
    elif state.wiper == "FAST":
        desired = "FAST" if speed > 42 else "SLOW"
    elif state.wiper == "SLOW":
        desired = "FAST" if speed > 62 else ("SLOW" if speed > 8 else "INTERVAL")
    elif speed > 62:
        desired = "FAST"
    elif speed > 18:
        desired = "SLOW"
    else:
        desired = "INTERVAL"
    state.wiper = desired
    if (
        state.weather == "rain"
        and not state.washer_used
        and speed > 8
        and state.phase == "driving"
    ):
        state.washer = True
        state.washer_until = state.t + timedelta(seconds=1.5)
        state.washer_used = True


def _energy(state: State, dt):
    if state.phase == "charging" and state.charge_state == "DetailedChargeStateCharging":
        kw = 11.0
        room = (float(state.params["charge_target_soc"]) - state.soc) / 100 * PACK_KWH
        add = min(room, kw * dt / 3600)
        if add <= 0.01:
            state.ac_power_kw = 0
            state.pack_current = 0
            state.charge_state = "DetailedChargeStateComplete"
            return
        state.soc += add / PACK_KWH * 100
        state.ac_power_kw = kw
        state.pack_current = -(kw * 1000) / max(state.pack_voltage, 300)
        state.lifetime_kwh += 0  # charging is not discharge
        return
    state.ac_power_kw = 0
    if state.phase in ("driving", "maneuver") and state.speed_kmh > 0.4 and state.gear in ("D", "R"):
        drag_kw = 0.0016 * (state.speed_kmh ** 2)
        accel_kw = max(0.0, state.long_accel) * state.speed_kmh * 0.45
        regen_kw = max(0.0, -state.long_accel) * state.speed_kmh * 0.28 if state.speed_kmh > 12 else 0
        hvac_kw = 0.7 if state.hvac_on else 0.05
        net_kw = max(-40, drag_kw + accel_kw - regen_kw + hvac_kw)
        state.soc = _clamp(state.soc - net_kw * dt / 3600 / PACK_KWH * 100, 3, 100)
        state.pack_current = net_kw * 1000 / max(state.pack_voltage, 300)
        if net_kw > 0:
            state.trip_kwh += net_kw * dt / 3600
            state.lifetime_kwh += net_kw * dt / 3600
    else:
        hotel_kw = 0.4 if state.hvac_on else 0.08
        state.soc = _clamp(state.soc - hotel_kw * dt / 3600 / PACK_KWH * 100, 3, 100)
        state.pack_current = hotel_kw * 1000 / max(state.pack_voltage, 300)
        state.lifetime_kwh += hotel_kw * dt / 3600


def advance(state: State, dt, target_kmh, emit: Emitter, limit_kmh=0.0):
    dt = max(0.05, float(dt))
    state.dt = dt
    state.limit_kmh = limit_kmh
    if state.burst_until and state.t < state.burst_until and target_kmh > 20:
        target_kmh = min(160, target_kmh * 1.28)
    if state.gear in ("P", "N") or state.phase in ("parked", "access", "charging"):
        target_kmh = 0
    accel = state.params["accel_mps2"]
    brake = state.params["brake_mps2"]
    if state.brake_override and target_kmh < state.speed_kmh:
        brake = state.brake_override
    if state.accel_override and state.accel_override_until and state.t < state.accel_override_until and target_kmh > state.speed_kmh:
        accel = state.accel_override
    if state.autopilot and target_kmh > 0:
        state.pedal = 0
        # Controller still moves the car; the driver's pedal stays up.
        new_speed, _pedal, brake_pct, long_accel = _approach(state.speed_kmh, target_kmh, accel, brake, dt)
        pedal = 0.0
    else:
        new_speed, pedal, brake_pct, long_accel = _approach(state.speed_kmh, target_kmh, accel, brake, dt)
    if state.brake_override and new_speed < 1:
        state.brake_override = None
    prev_bias = state.heading_bias
    step_m = (state.speed_kmh + new_speed) / 2 / 3.6 * dt
    direction = -1 if state.gear == "R" else (1 if state.gear == "D" else 0)
    state.speed_kmh = new_speed if direction or target_kmh == 0 else 0
    if state.gear in ("P", "N"):
        state.speed_kmh = new_speed  # approach already pulled it toward 0
        direction = 0
        if state.speed_kmh < 0.4:
            state.speed_kmh = 0
    state.long_accel = long_accel
    state.pedal = pedal
    state.brake_pct = brake_pct
    state.odometer_km += step_m / 1000
    if state.phase == "driving" and direction > 0:
        state.drive_m += step_m
        state.along_m += step_m
    elif direction < 0:
        state.along_m = max(0, state.along_m - step_m)
    if state.planned_m > 1 and state.phase in ("driving", "maneuver"):
        fraction = _clamp(state.along_m / state.planned_m, 0, 1)
        state.lat, state.lon = _lerp_point(state.origin, state.dest, fraction, 0.0015)
        base = _bearing(state.origin, state.dest)
        state.heading = (base + state.heading_bias) % 360
    yaw = (state.heading_bias - prev_bias) / dt
    v = state.speed_kmh / 3.6
    state.lat_accel = _clamp(v * math.radians(yaw) + 0.12 * math.sin(state.odometer_km * 40), -4.5, 4.5)
    if state.autopilot:
        state.cruise_kmh = target_kmh
    else:
        state.cruise_kmh = 0
    state.t += timedelta(seconds=dt)
    _move_windows(state, dt)
    _move_mirrors(state, dt)
    _energy(state, dt)
    _sync_derived(state)
    emit.sample(dt)


def wait(state, seconds, emit, step, target=0, limit_kmh=0):
    left = float(seconds)
    guard = 0
    while left > 0.02:
        guard += 1
        if guard > 20000:
            break
        dt = min(step, left)
        advance(state, dt, target, emit, limit_kmh=limit_kmh)
        left -= dt


def _highway_share(cruise):
    if cruise >= 115:
        return 0.72
    if cruise >= 80:
        return 0.4
    if cruise >= 65:
        return 0.18
    return 0.05


def _build_road(distance_m, params, rng):
    cruise = params["cruise_kmh"]
    share = _highway_share(cruise)
    if cruise >= 110:
        dwell = (3, 8)
    elif cruise >= 75:
        dwell = (6, 14)
    else:
        dwell = (12, 28)
    chunks = []
    left = distance_m
    built = 0.0
    guard = 0
    while left > 50 and guard < 80:
        guard += 1
        force_fast = cruise >= 110 and built < distance_m * 0.6
        if force_fast or rng.random() < share:
            kind, limit, lo, hi = "highway", 110, 4000, 9000
        elif rng.random() < 0.45 and cruise >= 70:
            kind, limit, lo, hi = "arterial", 70, 1200, 2800
        else:
            kind, limit, lo, hi = "urban", 50, 350, 900
        if cruise < 65:
            kind, limit, lo, hi = "urban", 50, 280, 700
        length = min(left, rng.uniform(lo, hi))
        limit = max(30, limit + rng.uniform(-4, 4))
        chunks.append({"type": "road", "kind": kind, "limit": limit, "length": length})
        left -= length
        built += length
        if kind != "highway" and left > 80:
            chunks.append({"type": "stop", "dwell": rng.uniform(*dwell), "limit": limit})
    if not chunks:
        chunks.append({"type": "road", "kind": "urban", "limit": 50, "length": distance_m})
    return chunks


def _target_speed(state):
    cruise = state.params["cruise_kmh"]
    bias = state.params["speeding_bias"]
    limit = max(state.limit_kmh, 20)
    grade_cut = 1 - max(0.0, state.grade) * 0.008
    return max(8, min(cruise, limit) * (1 + bias) * grade_cut)


def _door_plan(cycles):
    cycles = int(cycles)
    if cycles <= 1:
        return ["df"], []
    start = ["df"]
    end = ["df"]
    extras = cycles - 2
    pool = ["pf", "dr", "pr", "trunk", "frunk"]
    for i in range(extras):
        door = pool[i % len(pool)]
        (start if i % 2 == 0 else end).append(door)
    return start, end


def _set_opening(state, name, opened):
    if name == "trunk":
        state.trunk = opened
    elif name == "frunk":
        state.frunk = opened
    else:
        state.doors[name] = opened


def _pulse_openings(state, emit, names, step):
    rng = state.rng
    for name in names:
        _set_opening(state, name, True)
        wait(state, rng.uniform(4.0, 7.5), emit, step, target=0)
        _set_opening(state, name, False)
        wait(state, rng.uniform(0.8, 1.6), emit, step, target=0)


def _drive_trip(state, emit, label, dest, distance_km, step, inject, trip_index):
    rng = state.rng
    params = state.params
    state.trip_id = uuid.uuid4().hex[:12]
    state.trip_name = label
    state.weather = "rain" if rng.random() < params["wiper_tendency"] else "clear"
    state.washer_used = False
    state.outside_c = float(state.driver.get("climate_c", 22)) + rng.uniform(-1.5, 1.5)
    if state.weather == "rain":
        state.outside_c -= 3
    state.origin = (state.lat, state.lon)
    state.dest = (dest["lat"], dest["lon"])
    state.planned_m = max(300.0, distance_km * 1000)
    state.along_m = 0.0
    state.drive_m = 0.0
    state.phase = "access"
    state.locked = False
    state.mirror_folded = False
    state.hvac_on = True
    state.occupied = False
    state.passenger = int(params["door_cycles_per_trip"]) >= 4
    emit.event("trip_start", "info", {"name": label, "destination": dest.get("label", ""), "weather": state.weather, "km": distance_km})
    start_doors, end_doors = _door_plan(params["door_cycles_per_trip"])
    _pulse_openings(state, emit, start_doors, step)
    state.occupied = True
    wait(state, rng.uniform(1.0, 2.4), emit, step)
    late_belt = (1.0 - float(params["seatbelt_compliance"])) * 75
    state.belted = late_belt < 4
    wait(state, 1.0, emit, step)
    state.brake_pct = 40
    state.drive_rail = True
    wait(state, 0.8, emit, step)

    reverses = max(0, min(8, int(round((int(params["gear_shifts_per_trip"]) - 2) / 2))))
    state.phase = "maneuver"
    state.gear = "D"
    wait(state, 0.6, emit, step, target=0)
    for _ in range(reverses):
        state.gear = "R"
        wait(state, rng.uniform(3.0, 4.5), emit, step, target=7)
        state.gear = "D"
        wait(state, 1.2, emit, step, target=0)

    actions = []
    changes = int(params["window_changes_per_trip"])
    for i in range(changes):
        frac = (i + 1) / (changes + 1)
        which = WINDOW_NAMES[i % 4]
        target = 0 if i % 2 else rng.uniform(35, 90)
        actions.append((state.planned_m * frac, "window", which, target))
    nudges = int(params["mirror_adjustments_per_trip"])
    for i in range(nudges):
        frac = (i + 1) / (nudges + 1)
        actions.append((state.planned_m * frac * 0.9, "mirror", rng.uniform(-12, 18), rng.uniform(-6, 10)))
    for frac, side in ((0.28, "TurnSignalStateLeft"), (0.63, "TurnSignalStateRight")):
        actions.append((state.planned_m * frac, "lane", side, 0))
    actions.sort(key=lambda item: item[0])
    action_i = 0

    burst_m = state.planned_m * 0.42
    door_m = state.planned_m * 0.72
    burst_done = not inject
    door_done = not inject or trip_index > 0

    chunks = _build_road(state.planned_m, params, rng)
    state.phase = "driving"
    state.gear = "D"
    if late_belt >= 4:
        state.belted = False
        state.belt_due = state.t + timedelta(seconds=late_belt)
    stall = 0
    for chunk in chunks:
        if chunk["type"] == "stop":
            state.autopilot = False
            state.high_beam = False
            if rng.random() < params["hard_brake_rate"] and state.speed_kmh > 25:
                state.brake_override = 6.6
            guard = 0
            while state.speed_kmh > 0.8 and guard < 400:
                advance(state, step, 0, emit, limit_kmh=chunk["limit"])
                guard += 1
            wait(state, chunk["dwell"], emit, step, target=0, limit_kmh=chunk["limit"])
            if rng.random() < params["hard_accel_rate"]:
                state.accel_override = max(params["accel_mps2"], 3.1)
                state.accel_override_until = state.t + timedelta(seconds=2.5)
            continue
        state.road = chunk["kind"]
        state.autopilot = chunk["kind"] == "highway" and rng.random() < params["autopilot_share"]
        state.high_beam = bool(state.night and chunk["kind"] == "highway" and state.weather == "clear")
        end_m = state.drive_m + chunk["length"]
        dip_at = state.drive_m + chunk["length"] * 0.55 if chunk["kind"] == "highway" and params["hard_brake_rate"] >= 0.3 else None
        guard = 0
        while state.drive_m < end_m and guard < 20000:
            guard += 1
            if state.gear != "D":
                state.gear = "D"
            target = _target_speed(state)
            if dip_at is not None and state.drive_m >= dip_at and state.speed_kmh > 80:
                state.brake_override = 6.4
                target = max(50, target * 0.62)
                dip_at = None
            advance(state, step, target, emit, limit_kmh=chunk["limit"])
            if state.speed_kmh < 1:
                stall += 1
                if stall > 8:
                    state.gear = "D"
                    state.speed_kmh = 8
                    stall = 0
            else:
                stall = 0
            while action_i < len(actions) and state.drive_m >= actions[action_i][0]:
                kind = actions[action_i][1]
                if kind == "window":
                    state.window_cmd[actions[action_i][2]] = actions[action_i][3]
                elif kind == "mirror":
                    state.mirror_pan_cmd = actions[action_i][2]
                    state.mirror_tilt_cmd = actions[action_i][3]
                elif kind == "lane":
                    state.turn = actions[action_i][2]
                    state.turn_until = state.t + timedelta(seconds=3)
                    state.heading_bias = 10 if "Left" in state.turn else -10
                action_i += 1
            if not burst_done and state.drive_m >= burst_m and state.speed_kmh > 35:
                state.burst_until = state.t + timedelta(seconds=22)
                state.belt_forced_off_until = state.t + timedelta(seconds=22)
                state.belted = False
                burst_done = True
                emit.event("injected_speed_burst", "alert", {"seconds": 22})
            if not door_done and state.drive_m >= door_m and state.speed_kmh > 20:
                state.force_door_until = state.t + timedelta(seconds=6)
                door_done = True
                emit.event("injected_door", "alert", {"door": "df", "seconds": 6})
        state.autopilot = False
        state.high_beam = False

    guard = 0
    while state.speed_kmh > 0.8 and guard < 400:
        advance(state, step, 0, emit, limit_kmh=30)
        guard += 1
    state.lat, state.lon = dest["lat"], dest["lon"]
    state.heading = _bearing(state.origin, state.dest)
    state.gear = "P"
    state.drive_rail = False
    state.autopilot = False
    state.phase = "access"
    state.belted = False
    state.belt_due = None
    state.belt_forced_off_until = None
    for name in WINDOW_NAMES:
        state.window_cmd[name] = 0
    wait(state, 2.5, emit, step)
    _pulse_openings(state, emit, end_doors, step)
    state.occupied = False
    state.passenger = False
    state.hvac_on = False
    if rng.random() <= params["lock_compliance"] and not (inject and trip_index == 0):
        state.locked = True
        state.mirror_folded = True
        wait(state, 1.0, emit, step)
    else:
        state.phase = "parked"
        state.locked = False
        state.mirror_folded = False
        wait(state, rng.uniform(120, 240), emit, min(step, 5))
        state.locked = True
        state.mirror_folded = True
        wait(state, 1.0, emit, step)
    state.phase = "parked"
    emit.event("trip_end", "info", {"name": label, "odometer_km": _num(state.odometer_km, 3), "soc": _num(state.soc, 2)})


def _plan(scenario, params, rng, offset_min, day):
    commute = float(params["commute_km"])
    pattern = int(params["trips_per_day"])
    night = rng.random() < float(params["night_drive_share"])
    del offset_min
    if scenario == "commute":
        depart = 22.4 if night else 7.8 + rng.uniform(0, 0.3)
        return [(depart, "morning", "work", commute)], False
    if scenario == "timed":
        minutes = float(params.get("_duration_min") or 20)
        km = max(3.0, params["cruise_kmh"] * (minutes / 60) * 0.62)
        return [(9.0, "timed", "work", round(km, 1))], False
    # workday
    morning = 7.7 + rng.uniform(0, 0.35)
    trips = [(morning, "morning", "work", commute)]
    if pattern >= 3:
        trips.append((12.4, "lunch", "errand", round(max(2.5, commute * 0.22), 1)))
        trips.append((12.7, "lunch-back", "work", round(max(2.5, commute * 0.22), 1)))
    evening = 22.35 if night else 17.4 + rng.uniform(0, 0.4)
    if pattern >= 2:
        trips.append((evening, "evening", "home", commute))
    if pattern >= 4:
        trips.append((evening + 2.2, "errand", "errand", 5))
        trips.append((evening + 2.5, "errand-back", "home", 5))
    if pattern == 1:
        trips = trips[:1]
    return trips, True


def _destination(kind, driver, rng, here):
    if kind == "work":
        return driver["work"]
    if kind == "home":
        return driver["home"]
    return {
        "lat": here[0] + rng.uniform(-0.03, 0.03),
        "lon": here[1] + rng.uniform(-0.03, 0.03),
        "label": "Errand",
    }


def run_simulation(driver, *, scenario, interval_ms, seed, inject, day, log_dir: Path, duration_min=None):
    scenario = scenario if scenario in ("commute", "workday", "timed") else "workday"
    interval_ms = int(_clamp(int(interval_ms), 200, 5000))
    step = interval_ms / 1000
    rng = random.Random(int(seed))
    params = dict(driver["params"])
    if duration_min:
        params["_duration_min"] = float(duration_min)
    offset = int(driver["utc_offset_min"])
    trips, charge_at_end = _plan(scenario, params, rng, offset, day)
    first_depart = _at(day, trips[0][0], offset)
    start = first_depart - timedelta(minutes=3)
    home = driver["home"]
    state = State(
        t=start,
        driver=driver,
        params=params,
        dt=step,
        rng=rng,
        lat=home["lat"],
        lon=home["lon"],
        odometer_km=float(driver["odometer_km"]),
        soc=float(driver["soc"]),
        lifetime_kwh=float(driver["lifetime_energy_kwh"]),
        outside_c=float(driver.get("climate_c", 22)),
        inside_c=float(driver.get("climate_c", 22)),
        heading=_bearing((home["lat"], home["lon"]), (driver["work"]["lat"], driver["work"]["lon"])),
    )
    state.mirror_pan_cmd = 8
    state.mirror_tilt_cmd = 4
    log_dir.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex[:12]
    telemetry_path = log_dir / f"{run_id}.jsonl"
    events_path = log_dir / f"{run_id}.events.jsonl"
    series_path = log_dir / f"{run_id}.series.json"
    emit = Emitter(state, telemetry_path, events_path)
    start_soc = state.soc
    try:
        emit.event("session_start", "info", {"scenario": scenario, "seed": int(seed), "inject_anomalies": bool(inject)})
        state.phase = "parked"
        wait(state, 60, emit, 30)
        # Catch the clock up to just before the first departure if the 60s step overshoots.
        if state.t < first_depart - timedelta(seconds=30):
            gap = (first_depart - timedelta(seconds=20) - state.t).total_seconds()
            wait(state, gap, emit, 60)
        trip_count = 0
        for index, (hour, name, dest_kind, km) in enumerate(trips):
            depart = _at(day, hour, offset)
            if depart <= state.t:
                depart = state.t + timedelta(seconds=20)
            gap = (depart - state.t).total_seconds()
            if gap > 2:
                state.phase = "parked"
                state.gear = "P"
                state.hvac_on = False
                state.occupied = False
                wait(state, gap, emit, 60)
            dest = _destination(dest_kind, driver, rng, (state.lat, state.lon))
            _drive_trip(state, emit, name, dest, float(km), step, bool(inject), index)
            trip_count += 1
        ended_home = _haversine((state.lat, state.lon), (home["lat"], home["lon"])) < 0.4
        if charge_at_end and ended_home and state.soc < float(params["charge_target_soc"]) - 0.4:
            state.phase = "charging"
            state.charge_port = True
            state.charge_state = "DetailedChargeStateCharging"
            state.locked = True
            state.mirror_folded = True
            state.hvac_on = False
            emit.event("charge_start", "info", {"target_soc": params["charge_target_soc"], "power_kw": 11})
            guard = 0
            while state.charge_state == "DetailedChargeStateCharging" and guard < 800:
                advance(state, 30, 0, emit, limit_kmh=0)
                guard += 1
            state.charge_port = False
            if state.charge_state != "DetailedChargeStateComplete":
                state.charge_state = "DetailedChargeStateComplete"
            emit.event("charge_complete", "info", {"soc": _num(state.soc, 2)})
            state.phase = "parked"
            wait(state, 30, emit, 30)
        else:
            state.phase = "parked"
            wait(state, 30, emit, 30)
        emit.event("session_end", "info", {"soc": _num(state.soc, 2), "odometer_km": _num(state.odometer_km, 3)})
        if emit.example is None and emit.samples:
            emit.example = None
    finally:
        emit.close()

    metrics = emit.metrics(start_soc)
    metrics["trips"] = trip_count
    series = _decimate(emit.series, 1600)
    series_path.write_text(json.dumps(series), encoding="utf-8")
    example = emit.example
    if example is None:
        example = _first_doc(telemetry_path)
    return {
        "id": run_id,
        "driver_id": driver["id"],
        "driver_name": driver["name"],
        "scenario": scenario,
        "seed": int(seed),
        "inject_anomalies": bool(inject),
        "interval_ms": interval_ms,
        "day": day.isoformat(),
        "started": start.isoformat(timespec="seconds"),
        "ended": state.t.isoformat(timespec="seconds"),
        "samples": emit.samples,
        "event_count": len(emit.events),
        "metrics": metrics,
        "series": series,
        "events": emit.events,
        "example": example,
        "vehicle_after": {
            "odometer_km": round(state.odometer_km, 3),
            "soc": round(state.soc, 2),
            "lifetime_energy_kwh": round(state.lifetime_kwh, 3),
        },
        "files": {
            "telemetry_file": f"data/logs/{telemetry_path.name}",
            "events_file": f"data/logs/{events_path.name}",
            "series_file": f"data/logs/{series_path.name}",
        },
    }


def _first_doc(path: Path):
    with path.open(encoding="utf-8") as handle:
        line = handle.readline()
    return json.loads(line) if line else None


def _decimate(points, max_n):
    if len(points) <= max_n:
        return points
    must = {0, len(points) - 1}
    for i in range(1, len(points)):
        if points[i]["gear"] != points[i - 1]["gear"] or points[i]["phase"] != points[i - 1]["phase"]:
            must.add(i)
    step = len(points) / max_n
    i = 0.0
    while int(i) < len(points):
        j = min(len(points), int(i + step))
        chunk = points[int(i):j]
        if chunk:
            peak = max(range(int(i), j), key=lambda k: points[k]["speed"])
            must.add(int(i))
            must.add(peak)
        i += step
    return [points[i] for i in sorted(must)]


def _demo():
    from app.profiles import default_drivers

    drivers = {d["id"]: d for d in default_drivers()}
    out = Path(__file__).resolve().parent.parent / "data" / "logs"
    scores = {}
    for key in ("usman", "waqas"):
        result = run_simulation(
            drivers[key],
            scenario="commute",
            interval_ms=1000,
            seed=7,
            inject=False,
            day=date(2026, 11, 23),
            log_dir=out,
        )
        m = result["metrics"]
        scores[key] = m
        print(
            key,
            "samples", m["samples"],
            "events", m["events"],
            "km", m["distance_km"],
            "max", m["max_speed_kmh"],
            "shifts", m["gear_shifts"],
            "doors", m["door_cycles"],
            "soc", m["start_soc"], "->", m["end_soc"],
        )
        assert m["samples"] > 30, key
        assert m["gear_shifts"] >= 2, key
        assert m["door_cycles"] >= 1, key
        assert m["distance_km"] > 1, key
        assert m["end_soc"] < m["start_soc"] + 0.2, key
    assert scores["waqas"]["max_speed_kmh"] > scores["usman"]["max_speed_kmh"] + 15
    print("self-check ok")


if __name__ == "__main__":
    _demo()
