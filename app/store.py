"""SQLite for drivers, runs, and personal baselines. Logs stay on disk as JSONL."""

import json
import sqlite3
import threading
from pathlib import Path

from app.profiles import default_drivers

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
LOGS = DATA / "logs"
DB_PATH = DATA / "relay.db"

_lock = threading.Lock()


def _connect():
    DATA.mkdir(parents=True, exist_ok=True)
    LOGS.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init():
    with _lock:
        conn = _connect()
        try:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS drivers (
                    id TEXT PRIMARY KEY,
                    doc TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS runs (
                    id TEXT PRIMARY KEY,
                    driver_id TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    doc TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS baselines (
                    driver_id TEXT PRIMARY KEY,
                    doc TEXT NOT NULL
                );
                """
            )
            count = conn.execute("SELECT COUNT(*) AS n FROM drivers").fetchone()["n"]
            if count == 0:
                for driver in default_drivers():
                    conn.execute(
                        "INSERT INTO drivers (id, doc) VALUES (?, ?)",
                        (driver["id"], json.dumps(driver)),
                    )
            conn.commit()
        finally:
            conn.close()


def list_drivers():
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute("SELECT doc FROM drivers ORDER BY id").fetchall()
            return [json.loads(row["doc"]) for row in rows]
        finally:
            conn.close()


def get_driver(driver_id):
    with _lock:
        conn = _connect()
        try:
            row = conn.execute("SELECT doc FROM drivers WHERE id = ?", (driver_id,)).fetchone()
            return json.loads(row["doc"]) if row else None
        finally:
            conn.close()


def save_driver(driver):
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO drivers (id, doc) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc",
                (driver["id"], json.dumps(driver)),
            )
            conn.commit()
        finally:
            conn.close()
    return driver


def get_baseline(driver_id):
    with _lock:
        conn = _connect()
        try:
            row = conn.execute("SELECT doc FROM baselines WHERE driver_id = ?", (driver_id,)).fetchone()
            return json.loads(row["doc"]) if row else {}
        finally:
            conn.close()


def save_baseline(driver_id, doc):
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO baselines (driver_id, doc) VALUES (?, ?) ON CONFLICT(driver_id) DO UPDATE SET doc = excluded.doc",
                (driver_id, json.dumps(doc)),
            )
            conn.commit()
        finally:
            conn.close()


def clear_baseline(driver_id):
    with _lock:
        conn = _connect()
        try:
            conn.execute("DELETE FROM baselines WHERE driver_id = ?", (driver_id,))
            conn.commit()
        finally:
            conn.close()


def save_run(run):
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                "INSERT INTO runs (id, driver_id, created_at, doc) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, driver_id = excluded.driver_id",
                (run["id"], run["driver_id"], run["created_at"], json.dumps(run)),
            )
            conn.commit()
        finally:
            conn.close()


def list_runs(driver_id=None):
    with _lock:
        conn = _connect()
        try:
            if driver_id:
                rows = conn.execute(
                    "SELECT doc FROM runs WHERE driver_id = ? ORDER BY created_at DESC",
                    (driver_id,),
                ).fetchall()
            else:
                rows = conn.execute("SELECT doc FROM runs ORDER BY created_at DESC").fetchall()
            out = []
            for row in rows:
                doc = json.loads(row["doc"])
                doc.pop("series", None)
                doc.pop("events", None)
                doc.pop("example", None)
                doc.pop("drive_stats", None)
                doc.pop("drive_cursor", None)
                out.append(doc)
            return out
        finally:
            conn.close()


def get_run(run_id):
    with _lock:
        conn = _connect()
        try:
            row = conn.execute("SELECT doc FROM runs WHERE id = ?", (run_id,)).fetchone()
            return json.loads(row["doc"]) if row else None
        finally:
            conn.close()


def delete_run(run_id):
    run = get_run(run_id)
    if not run:
        return False
    with _lock:
        conn = _connect()
        try:
            conn.execute("DELETE FROM runs WHERE id = ?", (run_id,))
            conn.commit()
        finally:
            conn.close()
    for name in ("telemetry_file", "events_file", "series_file"):
        rel = (run.get("files") or {}).get(name)
        if not rel:
            continue
        path = ROOT / rel
        if path.is_file():
            path.unlink()
    return True


def latest_by_driver():
    runs = list_runs()
    found = {}
    for run in runs:
        found.setdefault(run["driver_id"], run["id"])
    return found
