"""Built-in drivers. Numbers are a starting point; the API stores edits."""

from copy import deepcopy

from app.catalog import clamp_params


def _person(**kwargs):
    params = kwargs.pop("params")
    doc = {
        "role": "",
        "color": "#8fce7a",
        "model": "Model 3",
        "car_type": "CarTypeModel3",
        "firmware": "2026.44.3",
        "trim": "Long Range",
        "exterior_color": "Pearl White",
        "wheel_type": "18 Aero",
        "charge_port": "ChargePortCCS",
        "pack_kwh": 75.0,
        "rated_range_km": 520.0,
        "right_hand_drive": False,
        "tires_bar": [2.90, 2.90, 2.90, 2.90],
        "climate_c": 22.0,
        "distance_unit": "DistanceUnitKilometers",
        "temperature_unit": "TemperatureUnitCelsius",
    }
    doc.update(kwargs)
    doc["params"] = clamp_params(params)
    doc["factory"] = {
        "odometer_km": doc["odometer_km"],
        "soc": doc["soc"],
        "lifetime_energy_kwh": doc["lifetime_energy_kwh"],
    }
    return doc


DRIVERS = [
    _person(
        id="usman",
        name="Usman",
        role="Weekday commuter",
        color="#8fce7a",
        vin="7SIM3E1EAPF100001",
        vehicle_name="Usman Model 3",
        exterior_color="Pearl White",
        utc_offset_min=300,
        city="Lahore",
        climate_c=21.0,
        home={"lat": 31.5204, "lon": 74.3587, "label": "Home, Gulberg"},
        work={"lat": 31.4697, "lon": 74.2728, "label": "Work, Johar Town"},
        odometer_km=18420.4,
        soc=78.0,
        lifetime_energy_kwh=3120.0,
        params={
            "commute_km": 16,
            "trips_per_day": 2,
            "night_drive_share": 0.05,
            "cruise_kmh": 82,
            "speeding_bias": 0.02,
            "accel_mps2": 1.3,
            "brake_mps2": 1.6,
            "hard_brake_rate": 0.05,
            "hard_accel_rate": 0.04,
            "autopilot_share": 0.45,
            "gear_shifts_per_trip": 4,
            "door_cycles_per_trip": 2,
            "window_changes_per_trip": 1,
            "mirror_adjustments_per_trip": 0,
            "wiper_tendency": 0.25,
            "seatbelt_compliance": 0.99,
            "lock_compliance": 0.99,
            "charge_target_soc": 80,
            "hvac_c": 22,
            "media_volume": 3,
        },
    ),
    _person(
        id="waqas",
        name="Waqas",
        role="Fast, late, heavy on the pedal",
        color="#e15a45",
        vin="7SIM3E1EAPF100002",
        vehicle_name="Waqas Model 3",
        exterior_color="Midnight Silver",
        utc_offset_min=300,
        city="Karachi",
        climate_c=28.0,
        home={"lat": 24.8607, "lon": 67.0011, "label": "Home, Clifton"},
        work={"lat": 24.8128, "lon": 67.0295, "label": "Work, I.I. Chundrigar"},
        odometer_km=40211.8,
        soc=58.0,
        lifetime_energy_kwh=8240.0,
        params={
            "commute_km": 24,
            "trips_per_day": 2,
            "night_drive_share": 0.65,
            "cruise_kmh": 128,
            "speeding_bias": 0.16,
            "accel_mps2": 2.6,
            "brake_mps2": 3.2,
            "hard_brake_rate": 0.45,
            "hard_accel_rate": 0.5,
            "autopilot_share": 0.12,
            "gear_shifts_per_trip": 8,
            "door_cycles_per_trip": 2,
            "window_changes_per_trip": 4,
            "mirror_adjustments_per_trip": 1,
            "wiper_tendency": 0.1,
            "seatbelt_compliance": 0.72,
            "lock_compliance": 0.9,
            "charge_target_soc": 95,
            "hvac_c": 21,
            "media_volume": 8,
        },
    ),
    _person(
        id="john",
        name="John",
        role="Short trips, many stops, forgets the lock",
        color="#d08a3a",
        vin="7SIM3E1EAPF100003",
        vehicle_name="John Model 3",
        exterior_color="Deep Blue",
        utc_offset_min=-360,
        city="Austin",
        climate_c=15.0,
        distance_unit="DistanceUnitMiles",
        temperature_unit="TemperatureUnitFahrenheit",
        tires_bar=[2.90, 2.90, 2.88, 2.46],
        home={"lat": 30.2672, "lon": -97.7431, "label": "Home, downtown"},
        work={"lat": 30.3074, "lon": -97.7536, "label": "Work, the Domain"},
        odometer_km=12004.2,
        soc=71.0,
        lifetime_energy_kwh=2410.0,
        params={
            "commute_km": 9,
            "trips_per_day": 3,
            "night_drive_share": 0.12,
            "cruise_kmh": 46,
            "speeding_bias": 0.0,
            "accel_mps2": 1.0,
            "brake_mps2": 1.4,
            "hard_brake_rate": 0.08,
            "hard_accel_rate": 0.03,
            "autopilot_share": 0.05,
            "gear_shifts_per_trip": 12,
            "door_cycles_per_trip": 6,
            "window_changes_per_trip": 3,
            "mirror_adjustments_per_trip": 3,
            "wiper_tendency": 0.72,
            "seatbelt_compliance": 0.96,
            "lock_compliance": 0.62,
            "charge_target_soc": 70,
            "hvac_c": 23,
            "media_volume": 4,
        },
    ),
]


def default_drivers():
    return deepcopy(DRIVERS)


def template_from(name, existing_ids):
    base = deepcopy(DRIVERS[0])
    slug = "".join(ch for ch in name.lower().strip() if ch.isalnum()) or "driver"
    candidate = slug
    n = 2
    while candidate in existing_ids:
        candidate = f"{slug}{n}"
        n += 1
    base["id"] = candidate
    base["name"] = name.strip()
    base["role"] = "Custom driver"
    base["color"] = "#7aa2d6"
    base["vin"] = f"7SIM3E1EAPF{100100 + len(existing_ids):06d}"[:17]
    base["vehicle_name"] = f"{name.strip()} Model 3"
    base["odometer_km"] = 1000.0
    base["soc"] = 80.0
    base["lifetime_energy_kwh"] = 200.0
    base["factory"] = {
        "odometer_km": 1000.0,
        "soc": 80.0,
        "lifetime_energy_kwh": 200.0,
    }
    return base
