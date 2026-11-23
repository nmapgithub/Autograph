"""Autograph HTTP API and the single-page lab."""

import json
from datetime import date, datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from app.catalog import FRAMES, PARAM_SCHEMA, SIGNALS, STANDARDS, clamp_params
from app.drivelog import record_drive
from app.profiles import template_from
from app.simulator import run_simulation
from app.store import (
    LOGS,
    ROOT,
    clear_baseline,
    delete_run,
    get_baseline,
    get_driver,
    get_run,
    init,
    list_drivers,
    list_runs,
    save_baseline,
    save_driver,
    save_run,
)
from app.ueba import analyze, update_baseline

STATIC = ROOT / "static"
ORDER = {"usman": 0, "waqas": 1, "john": 2}

app = FastAPI(title="Autograph", version="1.0.0")
app.mount("/static", StaticFiles(directory=STATIC), name="static")


class SimulateBody(BaseModel):
    driver_id: str
    scenario: str = "workday"
    interval_ms: int = 1000
    seed: int | None = None
    inject_anomalies: bool = False
    day: str | None = None
    duration_min: float | None = Field(default=None, ge=5, le=180)
    params: dict | None = None
    advance_odometer: bool = True


class DriverBody(BaseModel):
    name: str | None = None
    role: str | None = None
    params: dict | None = None


class NewDriverBody(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class DriveSampleBody(BaseModel):
    age_ms: int = 0
    meters: float = 0
    speed_kmh: float = 0
    gear: str = "P"
    long_accel: float = 0
    pedal: float = 0
    brake_pct: float = 0
    path: str = "Street"
    limit_kmh: float = 40
    heading: float = 0
    doors: dict = Field(default_factory=dict)
    window_pct: float = 0
    wiper: bool = False
    rain: bool = False
    belt: bool = True
    locked: bool = True
    lights: bool = False
    high: bool = False
    hazard: bool = False
    mirrors_folded: bool = False
    mirror_nudge: bool = False
    frunk: bool = False
    trunk: bool = False
    autopilot: bool = False
    mode: str = "manual"


class DriveEventBody(BaseModel):
    age_ms: int = 0
    kind: str = "note"
    text: str = ""
    severity: str = "info"
    speed_kmh: float = 0
    gear: str = "P"


class DriveBatchBody(BaseModel):
    driver_id: str
    run_id: str | None = None
    mode: str = "manual"
    path: str = "Street"
    finished: bool = False
    samples: list[DriveSampleBody] = Field(default_factory=list)
    events: list[DriveEventBody] = Field(default_factory=list)


def _sort_drivers(drivers):
    return sorted(drivers, key=lambda d: (ORDER.get(d["id"], 50), d["name"].lower()))


def _public_run(run):
    slim = dict(run)
    for key in ("series", "events", "example", "drive_stats", "drive_cursor"):
        slim.pop(key, None)
    return slim


def _parse_day(value):
    if not value:
        return date.today()
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise HTTPException(400, "Day must be YYYY-MM-DD.") from exc


def _execute(body: SimulateBody):
    driver = get_driver(body.driver_id)
    if not driver:
        raise HTTPException(404, "Unknown driver.")
    if body.params:
        driver["params"] = clamp_params(body.params)
        save_driver(driver)
    seed = body.seed if body.seed is not None else int(datetime.now().timestamp()) % 1_000_000
    try:
        result = run_simulation(
            driver,
            scenario=body.scenario,
            interval_ms=body.interval_ms,
            seed=seed,
            inject=body.inject_anomalies,
            day=_parse_day(body.day),
            log_dir=LOGS,
            duration_min=body.duration_min,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    baseline = get_baseline(driver["id"])
    report = analyze(driver["name"], result["metrics"], baseline)
    if not body.inject_anomalies:
        save_baseline(driver["id"], update_baseline(baseline, result["metrics"]))
    if body.advance_odometer:
        driver = get_driver(driver["id"])
        driver.update(result["vehicle_after"])
        save_driver(driver)
    created = datetime.now(timezone.utc).isoformat(timespec="seconds")
    stored = {
        "id": result["id"],
        "driver_id": result["driver_id"],
        "driver_name": result["driver_name"],
        "scenario": result["scenario"],
        "seed": result["seed"],
        "inject_anomalies": result["inject_anomalies"],
        "interval_ms": result["interval_ms"],
        "day": result["day"],
        "started": result["started"],
        "ended": result["ended"],
        "samples": result["samples"],
        "event_count": result["event_count"],
        "metrics": result["metrics"],
        "ueba": report,
        "example": result["example"],
        "files": result["files"],
        "created_at": created,
    }
    save_run(stored)
    return {
        "run": _public_run(stored),
        "ueba": report,
        "series": result["series"],
        "events": result["events"],
        "example": result["example"],
    }


@app.on_event("startup")
def _startup():
    init()


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


@app.get("/api/health")
def health():
    return {"ok": True, "name": "autograph"}


@app.get("/api/meta")
def meta():
    return {
        "standards": STANDARDS,
        "params": PARAM_SCHEMA,
        "scenarios": [
            {"id": "commute", "label": "One commute"},
            {"id": "workday", "label": "Full day"},
            {"id": "timed", "label": "Timed drive"},
        ],
        "frames": FRAMES,
        "indexes": {"telemetry": "vehicle-telemetry", "events": "vehicle-events"},
    }


@app.get("/api/catalog")
def catalog():
    return {"signals": SIGNALS, "frames": FRAMES}


@app.get("/api/drivers")
def drivers():
    return {"drivers": _sort_drivers(list_drivers())}


@app.post("/api/drivers")
def create_driver(body: NewDriverBody):
    existing = {d["id"] for d in list_drivers()}
    driver = template_from(body.name, existing)
    save_driver(driver)
    return driver


@app.put("/api/drivers/{driver_id}")
def update_driver(driver_id: str, body: DriverBody):
    driver = get_driver(driver_id)
    if not driver:
        raise HTTPException(404, "Unknown driver.")
    if body.name:
        driver["name"] = body.name.strip()
        driver["vehicle_name"] = f"{driver['name']} Model 3"
    if body.role is not None:
        driver["role"] = body.role.strip()
    if body.params:
        driver["params"] = clamp_params(body.params)
    save_driver(driver)
    return driver


@app.post("/api/drivers/{driver_id}/reset")
def reset_driver(driver_id: str):
    driver = get_driver(driver_id)
    if not driver:
        raise HTTPException(404, "Unknown driver.")
    factory = driver.get("factory") or {}
    driver["odometer_km"] = factory.get("odometer_km", driver["odometer_km"])
    driver["soc"] = factory.get("soc", driver["soc"])
    driver["lifetime_energy_kwh"] = factory.get("lifetime_energy_kwh", driver["lifetime_energy_kwh"])
    save_driver(driver)
    clear_baseline(driver_id)
    return driver


@app.post("/api/drives")
def drives(body: DriveBatchBody):
    driver = get_driver(body.driver_id)
    if not driver:
        raise HTTPException(404, "Unknown driver.")
    if len(body.samples) > 80 or len(body.events) > 80:
        raise HTTPException(400, "Send a shorter batch.")
    try:
        run = record_drive(driver, body)
    except OSError as exc:
        raise HTTPException(500, "Could not write the drive log.") from exc
    return {"run": run}


@app.post("/api/simulate")
def simulate(body: SimulateBody):
    return _execute(body)


@app.post("/api/simulate/fleet")
def simulate_fleet(body: SimulateBody):
    seed = body.seed if body.seed is not None else int(datetime.now().timestamp()) % 1_000_000
    reports = []
    for index, driver in enumerate(_sort_drivers(list_drivers())):
        one = body.model_copy(update={"driver_id": driver["id"], "seed": seed + index, "params": None})
        reports.append(_execute(one))
    return {"runs": reports}


@app.get("/api/runs")
def runs(driver_id: str | None = None):
    return {"runs": [_public_run(run) for run in list_runs(driver_id)]}


@app.get("/api/runs/{run_id}")
def run_detail(run_id: str):
    run = get_run(run_id)
    if not run:
        raise HTTPException(404, "Unknown run.")
    series_rel = (run.get("files") or {}).get("series_file")
    series = []
    if series_rel:
        path = ROOT / series_rel
        if path.is_file():
            series = json.loads(path.read_text(encoding="utf-8"))
    events = _read_events(run)
    return {"run": _public_run(run), "ueba": run.get("ueba"), "series": series, "events": events, "example": run.get("example")}


@app.get("/api/runs/{run_id}/samples")
def run_samples(run_id: str, offset: int = 0, limit: int = 40, phase: str | None = None):
    run = get_run(run_id)
    if not run:
        raise HTTPException(404, "Unknown run.")
    path = ROOT / run["files"]["telemetry_file"]
    if not path.is_file():
        raise HTTPException(404, "Telemetry file is missing.")
    limit = max(1, min(100, limit))
    offset = max(0, offset)
    rows = []
    seen = 0
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            doc = json.loads(line)
            if phase and doc.get("phase") != phase:
                continue
            if seen >= offset and len(rows) < limit:
                rows.append(doc)
            seen += 1
            if len(rows) >= limit and phase is None and seen >= offset + limit:
                break
    return {"samples": rows, "offset": offset, "limit": limit, "matched": seen, "total": run.get("samples", seen)}


@app.delete("/api/runs/{run_id}")
def remove_run(run_id: str):
    if not delete_run(run_id):
        raise HTTPException(404, "Unknown run.")
    return {"ok": True}


@app.get("/api/runs/{run_id}/export")
def export_run(run_id: str, kind: str = "telemetry", fmt: str = "jsonl"):
    run = get_run(run_id)
    if not run:
        raise HTTPException(404, "Unknown run.")
    if kind not in ("telemetry", "events"):
        raise HTTPException(400, "kind must be telemetry or events.")
    key = "telemetry_file" if kind == "telemetry" else "events_file"
    path = ROOT / run["files"][key]
    if not path.is_file():
        raise HTTPException(404, "Log file is missing.")
    index = "vehicle-telemetry" if kind == "telemetry" else "vehicle-events"
    filename = f"{run_id}-{kind}.{'ndjson' if fmt == 'bulk' else 'jsonl'}"
    if fmt == "bulk":
        def bulk():
            with path.open(encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    yield json.dumps({"index": {"_index": index}}) + "\n"
                    yield line if line.endswith("\n") else line + "\n"
        return StreamingResponse(
            bulk(),
            media_type="application/x-ndjson",
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )
    return FileResponse(path, media_type="application/x-ndjson", filename=filename)


@app.get("/api/ueba")
def ueba_board():
    drivers = _sort_drivers(list_drivers())
    day_runs = []
    drive_runs = []
    for run in list_runs():
        if run.get("source") == "drive" or run.get("scenario") in ("manual", "self-drive"):
            drive_runs.append(run)
        else:
            day_runs.append(run)
    latest = {}
    for run in day_runs:
        latest.setdefault(run["driver_id"], run)
    for run in drive_runs:
        latest.setdefault(run["driver_id"], run)
    board = []
    for driver in drivers:
        run = latest.get(driver["id"])
        board.append(
            {
                "driver": {
                    "id": driver["id"],
                    "name": driver["name"],
                    "role": driver["role"],
                    "color": driver["color"],
                    "city": driver["city"],
                    "vin": driver["vin"],
                    "odometer_km": driver["odometer_km"],
                    "soc": driver["soc"],
                },
                "run": _public_run(run) if run else None,
                "ueba": (run or {}).get("ueba"),
            }
        )
    return {"board": board}


def _read_events(run):
    rel = (run.get("files") or {}).get("events_file")
    if not rel:
        return []
    path = ROOT / rel
    if not path.is_file():
        return []
    events = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                events.append(json.loads(line))
    return events
