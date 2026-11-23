"""Push Autograph JSONL logs to an OpenSearch cluster the user names."""

import base64
import json
import re
import ssl
from http.client import HTTPConnection, HTTPSConnection, RemoteDisconnected
from pathlib import Path
from urllib.parse import urlparse

from fastapi import HTTPException

INDEX_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,254}$")
BATCH_DOCS = 200
BATCH_BYTES = 4 * 1024 * 1024


def push_logs(body, runs, root: Path):
    scheme, host, port = _target(body.scheme, body.host, body.port)
    telemetry = _index(body.telemetry_index, "Telemetry index")
    events = _index(body.events_index, "Events index")
    files = _files(runs, root, telemetry, events)
    if not files:
        raise HTTPException(404, "No log files to push.")
    indexes = []
    for _path, index in files:
        if index not in indexes:
            indexes.append(index)
    auth = _auth(body.username, body.password)
    conn = _connect(scheme, host, port, body.verify_tls)
    indexed = 0
    failed = 0
    errors = []
    try:
        for index in indexes:
            _ensure_index(conn, index, auth)
        batch = []
        size = 0
        for path, index in files:
            with path.open(encoding="utf-8") as handle:
                for line in handle:
                    if not line.strip():
                        continue
                    piece = (json.dumps({"index": {"_index": index}}) + "\n" + (line if line.endswith("\n") else line + "\n")).encode("utf-8")
                    batch.append(piece)
                    size += len(piece)
                    if len(batch) >= BATCH_DOCS or size >= BATCH_BYTES:
                        ok, bad, reasons = _bulk(conn, batch, auth)
                        indexed += ok
                        failed += bad
                        _keep(errors, reasons)
                        batch = []
                        size = 0
        if batch:
            ok, bad, reasons = _bulk(conn, batch, auth)
            indexed += ok
            failed += bad
            _keep(errors, reasons)
    except HTTPException:
        raise
    except (TimeoutError, OSError, ssl.SSLError) as exc:
        hint = _connect_hint(exc, scheme, body.verify_tls)
        done = f" {indexed} documents were stored before the connection stopped." if indexed else ""
        raise HTTPException(502, f"Could not finish the push to {scheme}://{host}:{port}.{done} {hint}") from exc
    finally:
        conn.close()
    return {
        "ok": failed == 0,
        "endpoint": f"{scheme}://{host}:{port}",
        "telemetry_index": telemetry,
        "events_index": events,
        "indexed": indexed,
        "failed": failed,
        "errors": errors,
    }


def _target(scheme, host, port):
    chosen = (scheme or "https").strip().lower()
    if chosen not in ("http", "https"):
        raise HTTPException(400, "Protocol must be http or https.")
    text = (host or "").strip()
    if "://" in text:
        parsed = urlparse(text)
        if parsed.scheme in ("http", "https"):
            chosen = parsed.scheme
        text = parsed.netloc or parsed.path
    text = text.split("/")[0].strip()
    chosen_port = port
    if text.startswith("[") and "]" in text:
        name = text[1:text.index("]")]
        tail = text[text.index("]") + 1:]
        if tail.startswith(":") and tail[1:].isdigit():
            chosen_port = int(tail[1:])
        text = name
    elif text.count(":") == 1:
        name, maybe = text.rsplit(":", 1)
        if maybe.isdigit():
            text = name
            chosen_port = int(maybe)
    if not text or any(ch in text for ch in " /?#@\\"):
        raise HTTPException(400, "Host must be a hostname or an IP address.")
    try:
        chosen_port = int(chosen_port)
    except (TypeError, ValueError) as exc:
        raise HTTPException(400, "Port must be between 1 and 65535.") from exc
    if not 1 <= chosen_port <= 65535:
        raise HTTPException(400, "Port must be between 1 and 65535.")
    return chosen, text, chosen_port


def _index(name, label):
    text = (name or "").strip().lower()
    if not INDEX_RE.fullmatch(text) or text.startswith(".") or ".." in text:
        raise HTTPException(400, f"{label} must be a lowercase name such as vehicle-telemetry.")
    return text


def _files(runs, root: Path, telemetry: str, events: str):
    found = []
    for run in reversed(list(runs)):
        stored = run.get("files") or {}
        for key, index in (("telemetry_file", telemetry), ("events_file", events)):
            rel = stored.get(key)
            if not rel:
                continue
            path = root / rel
            if path.is_file():
                found.append((path, index))
    return found


def _auth(username, password):
    user = username or ""
    secret = password or ""
    if not user and not secret:
        return {}
    token = base64.b64encode(f"{user}:{secret}".encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {token}"}


def _connect(scheme, host, port, verify_tls):
    if scheme == "https":
        context = ssl.create_default_context()
        if not verify_tls:
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        return HTTPSConnection(host, port, timeout=180, context=context)
    return HTTPConnection(host, port, timeout=180)


def _headers(auth, content_type=None):
    headers = {"Accept": "application/json", "User-Agent": "autograph"}
    headers.update(auth)
    if content_type:
        headers["Content-Type"] = content_type
    return headers


def _read(conn, method, path, auth, body=None, content_type=None):
    try:
        conn.request(method, path, body=body, headers=_headers(auth, content_type))
        response = conn.getresponse()
        data = response.read()
    except RemoteDisconnected:
        raise
    _raise_for_status(response.status, data)
    return response.status, data


def _ensure_index(conn, index, auth):
    conn.request("HEAD", f"/{index}", headers=_headers(auth))
    response = conn.getresponse()
    response.read()
    if response.status == 200:
        return
    if response.status not in (404,):
        _raise_for_status(response.status, b"")
    _read(conn, "PUT", f"/{index}", auth, body=b"{}", content_type="application/json")


def _bulk(conn, pieces, auth):
    status, data = _read(conn, "POST", "/_bulk", auth, body=b"".join(pieces), content_type="application/x-ndjson")
    try:
        payload = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(502, f"OpenSearch returned a response that was not JSON ({status}).") from exc
    indexed = 0
    failed = 0
    reasons = []
    for item in payload.get("items") or []:
        info = item.get("index") or item.get("create") or {}
        if int(info.get("status") or 500) >= 300:
            failed += 1
            err = info.get("error") or {}
            reason = err.get("reason") if isinstance(err, dict) else str(err)
            reasons.append(f"{info.get('_index', 'index')}: {reason}"[:240])
        else:
            indexed += 1
    if not payload.get("items"):
        raise HTTPException(502, "OpenSearch accepted the batch but returned no documents.")
    return indexed, failed, reasons


def _raise_for_status(status, data):
    if status in (200, 201):
        return
    if status == 401:
        raise HTTPException(401, "OpenSearch rejected the username or password.")
    if status == 403:
        raise HTTPException(403, "OpenSearch refused this user. Check the index privileges.")
    text = ""
    try:
        parsed = json.loads(data.decode("utf-8"))
        err = parsed.get("error")
        if isinstance(err, dict):
            text = err.get("reason") or err.get("type") or ""
        elif isinstance(err, str):
            text = err
    except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
        text = ""
    text = " ".join(str(text).split())[:180]
    detail = f"OpenSearch returned {status}."
    if text:
        detail = f"{detail} {text}"
    raise HTTPException(502, detail)


def _keep(found, reasons):
    for reason in reasons:
        if len(found) >= 5:
            return
        found.append(reason)


def _connect_hint(exc, scheme, verify_tls):
    name = exc.__class__.__name__
    if isinstance(exc, ssl.SSLError) or "SSL" in name or "CERTIFICATE" in name.upper():
        if verify_tls and scheme == "https":
            return "The certificate was rejected. For a local cluster, turn on “Allow a self-signed certificate”."
        return "The TLS handshake failed."
    if isinstance(exc, TimeoutError):
        return "The cluster did not answer in time."
    if getattr(exc, "errno", None) in (10061, 111, 61):
        return "Nothing accepted the connection. Check the host, port, and protocol."
    return "Check the host, port, and protocol."
