"""Signal catalog.

Three views of one instant:
- Tesla Fleet Telemetry field names and units (fleet-telemetry vehicle_data.proto)
- COVESA Vehicle Signal Specification-style paths and units
- CAN frames. IDs 0x118, 0x257, 0x102, 0x103, and 0x3E9 match the public
  Model 3 / Model Y community DBC. Payload bytes are a simplified packing so
  the log has a hex frame; bit positions are not the community DBC layout.
  Frames 0x321, 0x322, and 0x5A1 are simulator frames for pack, thermal,
  window, and mirror values that the public DBC spreads across many messages.
"""

FRAMES = {
    "DI_systemStatus": {
        "id": 0x118,
        "id_hex": "0x118",
        "bus": "VehicleBus",
        "ecu": "DI",
        "dlc": 8,
        "source": "Community Model 3 DBC id. Simplified payload.",
    },
    "DI_speed": {
        "id": 0x257,
        "id_hex": "0x257",
        "bus": "PartyBus",
        "ecu": "DI",
        "dlc": 8,
        "source": "Community Model 3 DBC id. Simplified payload.",
    },
    "VCLEFT_doorStatus": {
        "id": 0x102,
        "id_hex": "0x102",
        "bus": "VehicleBus",
        "ecu": "VCLEFT",
        "dlc": 8,
        "source": "Community Model 3 DBC id. Simplified payload.",
    },
    "VCRIGHT_doorStatus": {
        "id": 0x103,
        "id_hex": "0x103",
        "bus": "VehicleBus",
        "ecu": "VCRIGHT",
        "dlc": 8,
        "source": "Community Model 3 DBC id. Simplified payload.",
    },
    "DAS_bodyControls": {
        "id": 0x3E9,
        "id_hex": "0x3E9",
        "bus": "VehicleBus",
        "ecu": "DAS",
        "dlc": 8,
        "source": "Community Model 3 DBC id. Simplified payload.",
    },
    "SIM_bmsStatus": {
        "id": 0x321,
        "id_hex": "0x321",
        "bus": "VehicleBus",
        "ecu": "BMS",
        "dlc": 8,
        "source": "Simulator frame. Pack voltage, current, and SOC.",
    },
    "SIM_thermalTpms": {
        "id": 0x322,
        "id_hex": "0x322",
        "bus": "VehicleBus",
        "ecu": "BMS",
        "dlc": 8,
        "source": "Simulator frame. Battery module temps and tire pressures.",
    },
    "SIM_openings": {
        "id": 0x5A1,
        "id_hex": "0x5A1",
        "bus": "VehicleBus",
        "ecu": "VCSEC",
        "dlc": 8,
        "source": "Simulator frame. Window percent, mirror pan/tilt, charge-port flap.",
    },
    "SIM_vision": {
        "id": 0x3C2,
        "id_hex": "0x3C2",
        "bus": "PartyBus",
        "ecu": "DAS",
        "dlc": 8,
        "source": "Simulator frame. Counts from the vision stack. Tesla does not publish the occupancy network on the public DBC.",
    },
}

# DI_gear enum from the community Model 3 DBC (not the protobuf ShiftState numbers).
DI_GEAR = {"INVALID": 0, "P": 1, "R": 2, "N": 3, "D": 4}

SIGNALS = [
    {"group": "Driving", "tesla": "VehicleSpeed", "vss": "Vehicle.Speed", "unit_tesla": "mph", "unit_vss": "km/h", "frame": "DI_speed", "kind": "sensor"},
    {"group": "Driving", "tesla": "Gear", "vss": "Vehicle.Powertrain.Transmission.SelectedGear", "unit_tesla": "ShiftState", "unit_vss": "P/R/N/D", "frame": "DI_systemStatus", "kind": "sensor", "note": "VSS CurrentGear has no Park. SelectedGear is the simulator leaf; CurrentGear is -1/0/1 and the parking brake marks Park."},
    {"group": "Driving", "tesla": "PedalPosition", "vss": "Vehicle.Chassis.Accelerator.PedalPosition", "unit_tesla": "%", "unit_vss": "%", "frame": "DI_systemStatus", "kind": "sensor"},
    {"group": "Driving", "tesla": "BrakePedal", "vss": "Vehicle.Chassis.Brake.PedalPosition", "unit_tesla": "bool", "unit_vss": "%", "frame": "DI_systemStatus", "kind": "sensor"},
    {"group": "Driving", "tesla": "LongitudinalAcceleration", "vss": "Vehicle.Acceleration.Longitudinal", "unit_tesla": "m/s^2", "unit_vss": "m/s^2", "frame": "", "kind": "sensor"},
    {"group": "Driving", "tesla": "LateralAcceleration", "vss": "Vehicle.Acceleration.Lateral", "unit_tesla": "m/s^2", "unit_vss": "m/s^2", "frame": "", "kind": "sensor"},
    {"group": "Driving", "tesla": "Odometer", "vss": "Vehicle.TraveledDistance", "unit_tesla": "mi", "unit_vss": "m", "frame": "", "kind": "sensor"},
    {"group": "Driving", "tesla": "CruiseSetSpeed", "vss": "Vehicle.ADAS.CruiseControl.SpeedSet", "unit_tesla": "mph", "unit_vss": "km/h", "frame": "", "kind": "actuator"},
    {"group": "Driving", "tesla": "GradeEstimatePercent", "vss": "", "unit_tesla": "%", "unit_vss": "", "frame": "", "kind": "sensor", "note": "Tesla fleet field. Logged only on the tesla object; VSS has no single grade leaf."},
    {"group": "Powertrain", "tesla": "Soc", "vss": "Vehicle.Powertrain.TractionBattery.StateOfCharge.Current", "unit_tesla": "%", "unit_vss": "%", "frame": "SIM_bmsStatus", "kind": "sensor"},
    {"group": "Powertrain", "tesla": "PackVoltage", "vss": "Vehicle.Powertrain.TractionBattery.CurrentVoltage", "unit_tesla": "V", "unit_vss": "V", "frame": "SIM_bmsStatus", "kind": "sensor"},
    {"group": "Powertrain", "tesla": "PackCurrent", "vss": "Vehicle.Powertrain.TractionBattery.CurrentCurrent", "unit_tesla": "A", "unit_vss": "A", "frame": "SIM_bmsStatus", "kind": "sensor", "note": "Positive current is discharge. Negative current is charge."},
    {"group": "Powertrain", "tesla": "EstBatteryRange", "vss": "Vehicle.Powertrain.TractionBattery.Range", "unit_tesla": "mi", "unit_vss": "km", "frame": "", "kind": "sensor"},
    {"group": "Powertrain", "tesla": "EnergyRemaining", "vss": "Vehicle.Powertrain.TractionBattery.StateOfCharge.CurrentEnergy", "unit_tesla": "kWh", "unit_vss": "kWh", "frame": "", "kind": "sensor"},
    {"group": "Powertrain", "tesla": "DiAxleSpeedR", "vss": "Vehicle.Powertrain.ElectricMotor.Rear.Speed", "unit_tesla": "rpm", "unit_vss": "rpm", "frame": "", "kind": "sensor"},
    {"group": "Powertrain", "tesla": "DiTorqueActualR", "vss": "Vehicle.Powertrain.ElectricMotor.Rear.Torque", "unit_tesla": "Nm", "unit_vss": "Nm", "frame": "", "kind": "sensor", "note": "Axle-referred torque, same convention as the fleet field."},
    {"group": "Powertrain", "tesla": "DiStatorTempR", "vss": "Vehicle.Powertrain.ElectricMotor.Rear.Temperature", "unit_tesla": "C", "unit_vss": "C", "frame": "SIM_thermalTpms", "kind": "sensor"},
    {"group": "Powertrain", "tesla": "BMSState", "vss": "", "unit_tesla": "BMSStateValue", "unit_vss": "", "frame": "SIM_bmsStatus", "kind": "sensor"},
    {"group": "Powertrain", "tesla": "DetailedChargeState", "vss": "Vehicle.Powertrain.TractionBattery.Charging.IsCharging", "unit_tesla": "enum", "unit_vss": "bool", "frame": "", "kind": "sensor"},
    {"group": "Body", "tesla": "DoorState", "vss": "Vehicle.Cabin.Door.Row1.DriverSide.IsOpen", "unit_tesla": "Doors", "unit_vss": "bool", "frame": "VCLEFT_doorStatus", "kind": "sensor", "note": "Four cabin doors use Row1/Row2 and DriverSide/PassengerSide. Frunk is Vehicle.Body.Hood.IsOpen. Trunk is Vehicle.Body.Trunk.Rear.IsOpen."},
    {"group": "Body", "tesla": "Locked", "vss": "Vehicle.Cabin.Door.Row1.DriverSide.IsLocked", "unit_tesla": "bool", "unit_vss": "bool", "frame": "VCLEFT_doorStatus", "kind": "sensor"},
    {"group": "Body", "tesla": "FdWindow", "vss": "Vehicle.Cabin.Door.Row1.DriverSide.Window.Position", "unit_tesla": "WindowState", "unit_vss": "%", "frame": "SIM_openings", "kind": "actuator", "note": "0% is closed, 100% is fully down. Tesla's enum is Closed, PartiallyOpen, or Opened."},
    {"group": "Body", "tesla": "WiperHeatEnabled", "vss": "Vehicle.Body.Windshield.Front.Wiping.Mode", "unit_tesla": "bool", "unit_vss": "OFF/INTERVAL/SLOW/FAST", "frame": "DAS_bodyControls", "kind": "actuator", "note": "Fleet telemetry exposes wiper heat. Wiper mode itself is carried from the DAS wiper signal and the VSS wiping mode."},
    {"group": "Body", "tesla": "", "vss": "Vehicle.Body.Mirrors.DriverSide.IsFolded", "unit_tesla": "", "unit_vss": "bool", "frame": "VCLEFT_doorStatus", "kind": "actuator"},
    {"group": "Body", "tesla": "LightsTurnSignal", "vss": "Vehicle.Body.Lights.DirectionIndicator.Left.IsSignaling", "unit_tesla": "TurnSignalState", "unit_vss": "bool", "frame": "DAS_bodyControls", "kind": "actuator", "note": "TurnSignalStateLeft or TurnSignalStateRight during a lane change. The other side is the sibling DirectionIndicator leaf. Samples during the move carry LateralAcceleration."},
    {"group": "Safety", "tesla": "AutomaticEmergencyBrakingOff", "vss": "Vehicle.ADAS.ABS.IsEngaged", "unit_tesla": "bool", "unit_vss": "bool", "frame": "", "kind": "sensor", "note": "The fleet field is true only when automatic emergency braking is switched off. A drive-view collision logs BrakePedal, LongitudinalAcceleration, LightsHazardsActive, and this field false. ABS and ESC engaged are the VSS leaves. The public fleet stream has no collision leaf."},
    {"group": "Body", "tesla": "LightsHighBeams", "vss": "Vehicle.Body.Lights.Beam.High.IsOn", "unit_tesla": "bool", "unit_vss": "bool", "frame": "DAS_bodyControls", "kind": "actuator"},
    {"group": "Climate", "tesla": "InsideTemp", "vss": "Vehicle.Cabin.Temperature", "unit_tesla": "C", "unit_vss": "C", "frame": "", "kind": "sensor"},
    {"group": "Climate", "tesla": "OutsideTemp", "vss": "Vehicle.Exterior.AirTemperature", "unit_tesla": "C", "unit_vss": "C", "frame": "", "kind": "sensor"},
    {"group": "Climate", "tesla": "HvacPower", "vss": "Vehicle.Cabin.HVAC.IsAirConditioningActive", "unit_tesla": "HvacPowerState", "unit_vss": "bool", "frame": "", "kind": "actuator"},
    {"group": "Safety", "tesla": "DriverSeatBelt", "vss": "Vehicle.Cabin.Seat.Row1.DriverSide.IsBelted", "unit_tesla": "bool", "unit_vss": "bool", "frame": "", "kind": "sensor", "note": "Tesla's DriverSeatBelt boolean is true when the belt is unbuckled. The VSS leaf is true when it is fastened."},
    {"group": "Safety", "tesla": "DriverSeatOccupied", "vss": "Vehicle.Cabin.Seat.Row1.DriverSide.IsOccupied", "unit_tesla": "bool", "unit_vss": "bool", "frame": "SIM_vision", "kind": "sensor", "note": "Seat sensor fused with the cabin camera. Passenger and both rear seats are on the matching VSS leaves."},
    {"group": "Vision", "tesla": "", "vss": "", "unit_tesla": "", "unit_vss": "", "frame": "SIM_vision", "kind": "sensor", "note": "Each telemetry row has a perception object: camera tracks for vehicles, pedestrians, obstacles, and speed bumps, curb distances, free parking spaces, and cabin occupancy. Tesla's public fleet stream does not include these raw tracks. The positions on Street, Avenue, and Ring road are the same objects drawn on the Drive tab."},
    {"group": "Safety", "tesla": "SentryMode", "vss": "", "unit_tesla": "SentryModeState", "unit_vss": "", "frame": "", "kind": "actuator", "note": "Tesla-specific. Armed while the car is locked and empty."},
    {"group": "Service", "tesla": "TpmsPressureFl", "vss": "Vehicle.Chassis.Axle.Row1.Wheel.Left.Tire.Pressure", "unit_tesla": "bar", "unit_vss": "kPa", "frame": "SIM_thermalTpms", "kind": "sensor"},
    {"group": "Location", "tesla": "Location", "vss": "Vehicle.CurrentLocation.Latitude", "unit_tesla": "deg", "unit_vss": "deg", "frame": "", "kind": "sensor"},
    {"group": "Location", "tesla": "GpsHeading", "vss": "Vehicle.CurrentLocation.Heading", "unit_tesla": "deg", "unit_vss": "deg", "frame": "", "kind": "sensor"},
    {"group": "Media", "tesla": "MediaAudioVolume", "vss": "Vehicle.Cabin.Infotainment.Media.Volume", "unit_tesla": "0-11", "unit_vss": "%", "frame": "", "kind": "actuator"},
    {"group": "Vehicle", "tesla": "DriveRail", "vss": "Vehicle.Powertrain.TractionBattery.IsPowerConnected", "unit_tesla": "bool", "unit_vss": "bool", "frame": "", "kind": "sensor"},
]

STANDARDS = [
    "Inside the car, controllers publish CAN frames (ISO 11898). On a Model 3-class vehicle the public picture is a Vehicle Bus and a Party Bus at 500 kbit/s. The drive inverter publishes gear and pedal position on 0x118. Body controllers publish the doors on 0x102 and 0x103. Driver assistance publishes wipers and lamps on 0x3E9. Speed is also on 0x257. AUTOSAR sits above that on a real ECU: a DBC signal becomes a PDU, and the application reads it through the runtime. This simulator logs the frame the way a gateway would see it.",
    "A gateway gathers those signals. Tesla Fleet Telemetry, documented in the public fleet-telemetry protobuf, sends a configured subset about every 500 ms while the car is awake. Some fields also honor a minimum delta so tiny jitter does not flood the pipe. A value the car cannot measure is marked invalid. Gear uses ShiftStateP/R/N/D. Windows use WindowStateClosed, PartiallyOpen, or Opened. Door state is the six-door bitmap: driver front, driver rear, passenger front, passenger rear, frunk, trunk.",
    "COVESA Vehicle Signal Specification is the neutral tree for the same facts. Vehicle.Speed is km/h. Doors are Vehicle.Cabin.Door.Row1.DriverSide.IsOpen and the three sibling doors. State of charge is Vehicle.Powertrain.TractionBattery.StateOfCharge.Current. Tesla's snapshot stays in the tesla object, in Tesla's units (speed in mph, tire pressure in bar). The vss object is that same instant, converted. Where the stock VSS tree has no leaf (Park on the gear enum, sentry, wiper heat), the tesla object still carries the fleet field and the catalog says so.",
    "The cameras are simulated the way Tesla Vision works, not copied out of a real car. Eight exterior cameras plus the cabin camera report vehicles, pedestrians, obstacles, speed bumps, the curbs on either side, and empty parking bays, each with range, side offset, and confidence. The cabin camera and the seat sensors say who is in the driver seat, the passenger seat, and the rear seats. Fleet telemetry's public protobuf does not ship that occupancy network, so these tracks live in the perception object and in a simulator CAN summary, frame 0x3C2. On the Drive tab the logged objects are the same cars, people, and bumps drawn on the road. ",
    "Autograph does not connect to a real car. It runs a driver — Usman, Waqas, John, or anyone you add — through a day: sentry, unlock, doors, seatbelt, gear, a speed trace with stops, windows, mirrors, wipers, lights, battery, and charging. Driving and the door sequence are sampled at the interval you pick (500 ms matches the fleet bucket). Parked and charging stretches are sampled every 30–60 seconds so a full day stays a few thousand documents instead of a hundred thousand near-duplicates. Each line in the telemetry file is one OpenSearch document. @timestamp is the sample time with that driver's local offset. A second file records changes: a door, a gear shift, a hard brake, a window.",
    "The UEBA view scores the day two ways. The absolute score uses fixed safety envelopes: speeding, hard braking, a belt off while moving, a door open while rolling, a car left unlocked. The personal baseline compares the day with that driver's earlier days, so a fast driver can be normal for themselves and still sit high on the absolute score. Habit figures — gear shifts, door cycles, windows, mirrors, wipers — describe how they drive. The Logs tab downloads newline-delimited JSON, or an OpenSearch bulk file, or pushes the indexes vehicle-telemetry and vehicle-events to a cluster you name.",
]

PARAM_SCHEMA = [
    {"key": "commute_km", "group": "Route", "label": "Trip distance", "help": "Length of the main home-to-work drive.", "unit": "km", "min": 3, "max": 80, "step": 1, "default": 16},
    {"key": "trips_per_day", "group": "Route", "label": "Day pattern", "help": "1 morning only. 2 work and back. 3 adds a lunch loop. 4 also adds a night errand.", "unit": "", "min": 1, "max": 4, "step": 1, "default": 2},
    {"key": "night_drive_share", "group": "Route", "label": "Night return", "help": "Chance the drive home starts after 22:00 instead of late afternoon.", "unit": "0-1", "min": 0, "max": 1, "step": 0.01, "default": 0.05},
    {"key": "cruise_kmh", "group": "Speed", "label": "Cruise speed", "help": "Speed they settle at on an open road, before the limit caps it.", "unit": "km/h", "min": 30, "max": 150, "step": 1, "default": 82},
    {"key": "speeding_bias", "group": "Speed", "label": "Over-limit share", "help": "Fraction above the posted limit they are willing to hold. 0.16 is 16 percent over.", "unit": "0-1", "min": 0, "max": 0.45, "step": 0.01, "default": 0.02},
    {"key": "accel_mps2", "group": "Speed", "label": "Acceleration", "help": "How hard they pull away.", "unit": "m/s²", "min": 0.6, "max": 4.5, "step": 0.1, "default": 1.3},
    {"key": "brake_mps2", "group": "Speed", "label": "Braking", "help": "Normal stop. Hard stops are separate.", "unit": "m/s²", "min": 0.8, "max": 5, "step": 0.1, "default": 1.6},
    {"key": "hard_brake_rate", "group": "Speed", "label": "Hard-brake share", "help": "Share of stops that bite harder than about 3.5 m/s².", "unit": "0-1", "min": 0, "max": 1, "step": 0.01, "default": 0.05},
    {"key": "hard_accel_rate", "group": "Speed", "label": "Hard-launch share", "help": "Share of pull-aways above about 2.8 m/s².", "unit": "0-1", "min": 0, "max": 1, "step": 0.01, "default": 0.04},
    {"key": "autopilot_share", "group": "Speed", "label": "Autopilot on highways", "help": "Chance highway stretches run with cruise and autosteer engaged.", "unit": "0-1", "min": 0, "max": 1, "step": 0.01, "default": 0.4},
    {"key": "gear_shifts_per_trip", "group": "Speed", "label": "Gear shifts per trip", "help": "Park, reverse, drive, and back to park. Extra shifts come in pairs from reverse parking moves, so the count lands on the nearest even number of that form.", "unit": "", "min": 2, "max": 20, "step": 1, "default": 4},
    {"key": "door_cycles_per_trip", "group": "Body", "label": "Door cycles per trip", "help": "Open-and-close pairs. Two is driver door at both ends. Higher opens passenger doors, the trunk, or the frunk.", "unit": "", "min": 1, "max": 8, "step": 1, "default": 2},
    {"key": "window_changes_per_trip", "group": "Body", "label": "Window changes", "help": "Moves during the drive. Windows go back up when they park.", "unit": "", "min": 0, "max": 8, "step": 1, "default": 1},
    {"key": "mirror_adjustments_per_trip", "group": "Body", "label": "Mirror nudges", "help": "Pan and tilt changes while driving. The mirrors still unfold at unlock and fold at lock.", "unit": "", "min": 0, "max": 6, "step": 1, "default": 0},
    {"key": "wiper_tendency", "group": "Body", "label": "Rain tendency", "help": "Chance the trip is wet, which runs the wipers and, when it is cold, the wiper heater.", "unit": "0-1", "min": 0, "max": 1, "step": 0.01, "default": 0.25},
    {"key": "seatbelt_compliance", "group": "Body", "label": "Seatbelt before driving", "help": "1 means the belt is on before the car moves. Lower values leave it off into the drive, up to about 75 seconds.", "unit": "0-1", "min": 0, "max": 1, "step": 0.01, "default": 0.99},
    {"key": "lock_compliance", "group": "Body", "label": "Lock on walk-away", "help": "Chance the car locks as soon as they leave. Otherwise it sits unlocked for a few minutes.", "unit": "0-1", "min": 0, "max": 1, "step": 0.01, "default": 0.99},
    {"key": "charge_target_soc", "group": "Energy", "label": "Charge target", "help": "Home AC charge stops here. 11 kW, three-phase.", "unit": "%", "min": 50, "max": 100, "step": 1, "default": 80},
    {"key": "hvac_c", "group": "Energy", "label": "Cabin setpoint", "help": "Requested cabin temperature.", "unit": "°C", "min": 16, "max": 26, "step": 0.5, "default": 22},
    {"key": "media_volume", "group": "Energy", "label": "Media volume", "help": "Tesla's scale runs from 0 to 11.", "unit": "0-11", "min": 0, "max": 11, "step": 0.5, "default": 3},
]


def clamp_params(raw):
    clean = {}
    src = raw or {}
    for spec in PARAM_SCHEMA:
        value = src.get(spec["key"], spec["default"])
        try:
            value = float(value)
        except (TypeError, ValueError):
            value = float(spec["default"])
        value = max(spec["min"], min(spec["max"], value))
        if spec["step"] >= 1 and spec["key"] not in ("media_volume", "hvac_c"):
            value = int(round(value))
        elif spec["key"] in ("media_volume", "hvac_c"):
            value = round(value, 1)
        else:
            value = round(value, 2)
        clean[spec["key"]] = value
    return clean
