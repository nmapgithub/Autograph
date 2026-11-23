"""Absolute safety score and a personal baseline.

The absolute score uses fixed envelopes, so a whole fleet of fast drivers does
not redefine what is safe. The personal baseline uses earlier days for that
same driver, so a hard day shows up as unusual only when it departs from them.
"""

import math


def _f(metrics, key, default=0.0):
    try:
        return float(metrics.get(key, default) or 0)
    except (TypeError, ValueError):
        return float(default)


def _scale(value, low, high):
    if high <= low:
        return 0.0
    return max(0.0, min(1.0, (value - low) / (high - low)))


def absolute_score(metrics):
    distance = max(_f(metrics, "distance_km"), 0.1)
    drive_s = max(_f(metrics, "drive_s"), 1.0)
    hard_brake_per = _f(metrics, "hard_brake_count") / distance * 100
    hard_accel_per = _f(metrics, "hard_accel_count") / distance * 100
    speeding_ratio = _f(metrics, "speeding_s") / drive_s
    factors = []

    def add(name, points, detail):
        points = round(max(0.0, points), 1)
        if points >= 0.8:
            factors.append({"name": name, "points": points, "detail": detail})

    add(
        "Speeding",
        24 * _scale(speeding_ratio, 0.03, 0.22),
        f"{_f(metrics, 'speeding_s'):.0f}s above the posted limit",
    )
    add(
        "Peak speed",
        20 * _scale(_f(metrics, "max_speed_kmh"), 100, 140),
        f"peak {_f(metrics, 'max_speed_kmh'):.0f} km/h",
    )
    add(
        "Hard braking",
        12 * _scale(hard_brake_per, 2, 14),
        f"{int(_f(metrics, 'hard_brake_count'))} stops harder than 3.5 m/s²",
    )
    add(
        "Hard launch",
        10 * _scale(hard_accel_per, 1, 14),
        f"{int(_f(metrics, 'hard_accel_count'))} pull-aways above 2.8 m/s²",
    )
    add(
        "Belt off while moving",
        16 * _scale(_f(metrics, "seatbelt_off_s"), 3, 70),
        f"{_f(metrics, 'seatbelt_off_s'):.0f}s unbelted above 10 km/h",
    )
    if _f(metrics, "door_open_while_moving_s") >= 1 or int(_f(metrics, "door_open_while_moving")):
        add(
            "Door open while rolling",
            18,
            f"{_f(metrics, 'door_open_while_moving_s'):.0f}s with a door ajar above 5 km/h",
        )
    add(
        "Left unlocked",
        10 * _scale(_f(metrics, "unlocked_away_s"), 30, 240),
        f"{_f(metrics, 'unlocked_away_s'):.0f}s parked, empty, and unlocked",
    )
    if int(_f(metrics, "tpms_soft")):
        add("Tire pressure", 4, "a tire sat under 2.6 bar")
    add(
        "Night driving",
        4 * _scale(_f(metrics, "night_s") / drive_s, 0.15, 0.8),
        f"{_f(metrics, 'night_s'):.0f}s of driving after 21:00 or before 05:00",
    )

    total = min(100.0, round(sum(item["points"] for item in factors), 1))
    if total < 25:
        band = "low"
    elif total < 55:
        band = "watch"
    else:
        band = "high"
    return {"score": total, "band": band, "factors": factors}


def habit_lines(name, metrics):
    distance = _f(metrics, "distance_km")
    drive_min = _f(metrics, "drive_s") / 60
    lines = [
        f"{name} covered {distance:.1f} km in {drive_min:.0f} minutes, averaging {_f(metrics, 'avg_speed_kmh'):.0f} km/h with a peak of {_f(metrics, 'max_speed_kmh'):.0f} km/h.",
        f"The shifter moved {int(_f(metrics, 'gear_shifts'))} times, {int(_f(metrics, 'reverse_count'))} of them into reverse.",
        f"Doors cycled {int(_f(metrics, 'door_cycles'))} times, windows moved {int(_f(metrics, 'window_changes'))} times, and the mirrors were touched {int(_f(metrics, 'mirror_events'))} times.",
        f"Wipers were on for {_f(metrics, 'wiper_s') / 60:.0f} minutes. Autopilot covered {100 * _f(metrics, 'autopilot_s') / max(_f(metrics, 'drive_s'), 1):.0f}% of the moving time.",
        f"The pack went from {_f(metrics, 'start_soc'):.0f}% to {_f(metrics, 'end_soc'):.0f}% and used {_f(metrics, 'energy_kwh'):.2f} kWh on the road. Charging ran for {_f(metrics, 'charge_s') / 60:.0f} minutes.",
    ]
    return lines


def _std(entry, floor):
    n = entry.get("n", 0)
    if n < 2:
        return float(floor)
    var = entry.get("m2", 0) / (n - 1)
    return max(float(floor), math.sqrt(max(0.0, var)))


def personal_anomalies(metrics, baseline):
    """Compare with earlier days. baseline is {metric: {mean, m2, n}} or None."""
    if not baseline:
        return {
            "runs_before": 0,
            "items": [],
            "note": "This day starts the personal baseline. Run the same driver again to see what counts as unusual for them.",
        }
    sample_n = 0
    for entry in baseline.values():
        sample_n = max(sample_n, int(entry.get("n", 0)))
        break
    # n is per metric; they share a count.
    n = int(next(iter(baseline.values())).get("n", 0)) if baseline else 0
    watched = [
        ("max_speed_kmh", "Peak speed", "km/h", 6, True),
        ("avg_speed_kmh", "Average speed", "km/h", 4, False),
        ("speeding_s", "Time over the limit", "s", 20, True),
        ("hard_brake_count", "Hard brakes", "", 1.0, True),
        ("hard_accel_count", "Hard launches", "", 1.0, True),
        ("seatbelt_off_s", "Belt off while moving", "s", 8, True),
        ("door_open_while_moving_s", "Door open while rolling", "s", 2, True),
        ("unlocked_away_s", "Left unlocked", "s", 30, True),
        ("gear_shifts", "Gear shifts", "", 2, False),
        ("door_cycles", "Door cycles", "", 1, False),
        ("window_changes", "Window changes", "", 1, False),
        ("distance_km", "Distance", "km", 2, False),
        ("wiper_s", "Wiper time", "s", 30, False),
    ]
    items = []
    if n < 1:
        note = "This day starts the personal baseline. Run the same driver again to see what counts as unusual for them."
        return {"runs_before": 0, "items": [], "note": note}

    for key, label, unit, floor, safety in watched:
        if key not in baseline or key not in metrics:
            continue
        entry = baseline[key]
        mean = float(entry.get("mean", 0))
        value = _f(metrics, key)
        delta = value - mean
        std = _std(entry, floor)
        z = delta / std if std else 0
        interesting = False
        if n >= 2 and abs(z) >= 2.2 and abs(delta) >= floor * 0.5:
            interesting = True
        elif n == 1 and safety and abs(delta) >= max(floor * 2, abs(mean) * 0.45, 1):
            interesting = True
        if not interesting:
            continue
        direction = "above" if delta > 0 else "below"
        items.append(
            {
                "metric": key,
                "label": label,
                "safety": safety,
                "value": round(value, 2),
                "mean": round(mean, 2),
                "z": round(z, 2),
                "direction": direction,
                "detail": f"{label} is {value:.1f}{unit}, {direction} this driver's earlier average of {mean:.1f}{unit}.",
            }
        )
    if n == 1:
        note = "One earlier day is on file. Large safety jumps are flagged. A third day tightens the personal band."
    elif items:
        note = f"Compared with {n} earlier day{'s' if n != 1 else ''} from this driver."
    else:
        note = f"This day sits inside the band from {n} earlier days."
    items.sort(key=lambda item: (not item["safety"], -abs(item["z"])))
    return {"runs_before": n, "items": items, "note": note}


def update_baseline(baseline, metrics):
    keys = [
        "max_speed_kmh",
        "avg_speed_kmh",
        "speeding_s",
        "hard_brake_count",
        "hard_accel_count",
        "seatbelt_off_s",
        "door_open_while_moving_s",
        "unlocked_away_s",
        "gear_shifts",
        "door_cycles",
        "window_changes",
        "distance_km",
        "wiper_s",
        "mirror_events",
        "autopilot_s",
        "night_s",
        "energy_kwh",
    ]
    out = dict(baseline or {})
    for key in keys:
        if key not in metrics:
            continue
        x = float(metrics[key])
        slot = dict(out.get(key) or {"mean": 0.0, "m2": 0.0, "n": 0})
        n = int(slot["n"]) + 1
        delta = x - float(slot["mean"])
        mean = float(slot["mean"]) + delta / n
        m2 = float(slot["m2"]) + delta * (x - mean)
        out[key] = {"mean": mean, "m2": m2, "n": n}
    return out


def analyze(name, metrics, baseline):
    absolute = absolute_score(metrics)
    personal = personal_anomalies(metrics, baseline)
    return {
        "driver_name": name,
        "absolute": absolute,
        "personal": personal,
        "habit": habit_lines(name, metrics),
        "metrics": metrics,
    }
