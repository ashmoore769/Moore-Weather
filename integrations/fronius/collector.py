#!/usr/bin/env python3
"""Read one GEN24 Solar API endpoint and send a bounded, durable HTTPS feed.

Only the Python standard library is used. --check reads the inverter once and
prints whitelisted measurements without creating files or contacting the server.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from http.client import HTTPException
import json
import logging
import math
import os
from pathlib import Path
import re
import signal
import sqlite3
import ssl
import sys
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import (
    HTTPRedirectHandler, HTTPSHandler, ProxyHandler, Request, build_opener,
)


LOG = logging.getLogger("moore-solar")
POWERFLOW_PATH = "/solar_api/v1/GetPowerFlowRealtimeData.fcgi"
INGEST_PATH = "/internal/solar/ingest"
MAX_BATCH_SAMPLES = 120
MAX_BATCH_BYTES = 128 * 1024
MAX_QUEUE_SAMPLES = 20160
# Leave one hour below the server's 14-day acceptance window for clock skew and
# time spent in flight. Pruned samples are counted and reported, never fabricated.
MAX_QUEUE_AGE_SECONDS = 14 * 86400 - 3600
TIMESTAMP = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|[+-][0-9]{2}:[0-9]{2})$")
MODES = {"produce-only", "meter", "vague-meter", "bidirectional", "ac-coupled", "isolated"}
METER_LOCATIONS = {"load", "grid", "unknown"}


class CollectorError(Exception):
    """A safe, non-secret explanation that may be written to the service log."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def iso_time(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def timestamp(value: object) -> datetime:
    if not isinstance(value, str) or not TIMESTAMP.fullmatch(value):
        raise CollectorError("Inverter timestamp must include an explicit time zone")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError as error:
        raise CollectorError("Inverter timestamp is invalid") from error


def measurement(value: object, name: str, minimum: float, maximum: float) -> float | int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CollectorError(f"Inverter {name} must be a finite number or null")
    if not minimum <= value <= maximum:
        raise CollectorError(f"Inverter {name} is outside the accepted range")
    if not math.isfinite(value):
        raise CollectorError(f"Inverter {name} must be a finite number or null")
    return value


def object_field(value: object, name: str) -> dict:
    if not isinstance(value, dict):
        raise CollectorError(f"Inverter response is missing a valid {name} object")
    return value


def normalize_powerflow(payload: object, collected_at: datetime | None = None) -> dict:
    """Translate the documented GEN24 fields without exposing identifiers.

    P_PV is DC power; inverter P is AC output. P_Load's sign is inverted so
    consumption is positive. Null does not mean zero, including at night.
    """
    collected_at = collected_at or utc_now()
    if collected_at.tzinfo is None:
        raise CollectorError("Collector clock must include a time zone")
    source = object_field(payload, "response")
    head = object_field(source.get("Head"), "Head")
    status = object_field(head.get("Status"), "Head.Status")
    if type(status.get("Code")) is not int or status["Code"] != 0:
        raise CollectorError("Inverter Solar API did not return a successful status")
    observed_at = timestamp(head.get("Timestamp"))
    if observed_at > collected_at + timedelta(minutes=5):
        raise CollectorError("Inverter timestamp is more than five minutes ahead; check clock synchronization")
    if observed_at < collected_at - timedelta(minutes=15):
        raise CollectorError("Inverter timestamp is more than fifteen minutes old; no fresh sample was queued")
    body = object_field(source.get("Body"), "Body")
    data = object_field(body.get("Data"), "Body.Data")
    site = object_field(data.get("Site"), "Site")
    inverters = object_field(data.get("Inverters"), "Inverters")
    inverter = object_field(inverters.get("1", {}), "Inverters.1")
    load = measurement(site.get("P_Load"), "P_Load", -1_000_000, 1_000_000)
    total = inverter.get("E_Total")
    if total is None:
        total = site.get("E_Total")
    mode, location = site.get("Mode"), site.get("Meter_Location")
    return {
        "observedAt": iso_time(observed_at),
        "collectedAt": iso_time(collected_at),
        "pvPowerW": measurement(site.get("P_PV"), "P_PV", 0, 1_000_000),
        "inverterPowerW": measurement(inverter.get("P"), "inverter P", -1_000_000, 1_000_000),
        "gridPowerW": measurement(site.get("P_Grid"), "P_Grid", -1_000_000, 1_000_000),
        "loadPowerW": None if load is None else -load,
        "batteryPowerW": measurement(site.get("P_Akku"), "P_Akku", -1_000_000, 1_000_000),
        "batterySocPercent": measurement(inverter.get("SOC"), "SOC", 0, 100),
        "totalAcEnergyWh": measurement(total, "E_Total", 0, 1_000_000_000_000),
        "meterLocation": location if isinstance(location, str) and location in METER_LOCATIONS else None,
        "mode": mode if isinstance(mode, str) and mode in MODES else None,
    }


def inverter_origin(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (ValueError, TypeError) as error:
        raise CollectorError("FRONIUS_BASE_URL is not a valid HTTP(S) origin") from error
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment
            or any(ord(c) < 33 for c in value) or (port is not None and port == 0)):
        raise CollectorError("FRONIUS_BASE_URL must be an HTTP(S) origin without credentials, path or query")
    return value.rstrip("/")


def ingest_url(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except (ValueError, TypeError) as error:
        raise CollectorError("SOLAR_INGEST_URL is invalid") from error
    if (parsed.scheme != "https" or not parsed.hostname or parsed.path != INGEST_PATH
            or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment or any(ord(c) < 33 for c in value)
            or (port is not None and port == 0)):
        raise CollectorError(f"SOLAR_INGEST_URL must be HTTPS with the exact {INGEST_PATH} path and no credentials or query")
    return value


@dataclass(frozen=True)
class Config:
    origin: str
    destination: str
    token: str
    state_dir: Path
    poll_seconds: int = 60

    @classmethod
    def from_env(cls, env: dict | os._Environ) -> "Config":
        origin = inverter_origin(env.get("FRONIUS_BASE_URL", ""))
        destination = ingest_url(env.get("SOLAR_INGEST_URL", ""))
        token = env.get("SOLAR_INGEST_TOKEN", "")
        if not 32 <= len(token) <= 256 or any(not 33 <= ord(c) <= 126 for c in token):
            raise CollectorError("SOLAR_INGEST_TOKEN must contain 32 to 256 non-whitespace ASCII characters")
        try:
            interval = int(env.get("SOLAR_POLL_SECONDS", "60"))
        except ValueError as error:
            raise CollectorError("SOLAR_POLL_SECONDS must be an integer from 15 to 120") from error
        if not 15 <= interval <= 120:
            raise CollectorError("SOLAR_POLL_SECONDS must be an integer from 15 to 120")
        state_dir = Path(env.get("SOLAR_STATE_DIR", "/var/lib/moore-solar"))
        if not state_dir.is_absolute():
            raise CollectorError("SOLAR_STATE_DIR must be an absolute path")
        return cls(origin, destination, token, state_dir, interval)


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise CollectorError("HTTP redirects are not permitted; verify the configured endpoint")


def reject_json_constant(_value):
    raise CollectorError("Response contains a non-finite JSON number")


def bounded_json_integer(value):
    if len(value) > 32:
        raise CollectorError("Response contains an excessively large JSON integer")
    return int(value)


def finite_json_float(value):
    number = float(value)
    if not math.isfinite(number):
        raise CollectorError("Response contains a non-finite JSON number")
    return number


def check_json_depth(text: str):
    # The protocol needs fewer than ten nesting levels. Check before parsing so
    # a malformed response cannot use the interpreter's much larger stack limit.
    depth, quoted, escaped = 0, False, False
    for char in text:
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in "[{":
            depth += 1
            if depth > 32:
                raise CollectorError("Endpoint JSON is too deeply nested")
        elif char in "]}":
            depth -= 1


def compact_json(value: object) -> bytes:
    return json.dumps(value, allow_nan=False, separators=(",", ":")).encode("utf-8")


class HttpClient:
    def __init__(self, opener=None):
        # The LAN inverter must not be contacted through an environment proxy.
        # HTTPS uses the normal trusted CA store; certificate verification is on.
        self.opener = opener or build_opener(
            ProxyHandler({}), NoRedirects(), HTTPSHandler(context=ssl.create_default_context())
        )

    def request_json(self, request: Request, timeout: float, max_bytes: int) -> object:
        try:
            with self.opener.open(request, timeout=timeout) as response:
                if response.status != 200:
                    raise CollectorError(f"Endpoint replied HTTP {response.status}")
                raw = response.read(max_bytes + 1)
            if len(raw) > max_bytes:
                raise CollectorError("Endpoint response exceeded the size limit")
            text = raw.decode("utf-8")
            check_json_depth(text)
            return json.loads(text, parse_constant=reject_json_constant,
                              parse_int=bounded_json_integer, parse_float=finite_json_float)
        except HTTPError as error:
            error.close()
            raise CollectorError(f"Endpoint replied HTTP {error.code}") from error
        except (URLError, TimeoutError, OSError, HTTPException) as error:
            raise CollectorError(f"Endpoint request failed ({type(error).__name__})") from error
        except (ValueError, RecursionError) as error:
            raise CollectorError("Endpoint did not return valid JSON") from error

    def read_inverter(self, origin: str) -> dict:
        request = Request(inverter_origin(origin) + POWERFLOW_PATH,
                          headers={"Accept": "application/json", "User-Agent": "MooreSolarCollector/1"})
        response = self.request_json(request, timeout=5, max_bytes=256 * 1024)
        return normalize_powerflow(response)

    def send(self, destination: str, token: str, samples: list[dict]) -> dict:
        body = compact_json({"version": 1, "samples": samples})
        if not 1 <= len(samples) <= MAX_BATCH_SAMPLES or len(body) > MAX_BATCH_BYTES:
            raise CollectorError("Upload batch exceeds the protocol limits")
        request = Request(ingest_url(destination), data=body, method="POST", headers={
            "Accept": "application/json", "Content-Type": "application/json",
            "Authorization": "Bearer " + token, "User-Agent": "MooreSolarCollector/1",
        })
        ack = self.request_json(request, timeout=10, max_bytes=8192)
        if (not isinstance(ack, dict) or set(ack) != {"accepted", "duplicates"}
                or any(type(ack[k]) is not int or ack[k] < 0 for k in ("accepted", "duplicates"))
                or ack["accepted"] + ack["duplicates"] != len(samples)):
            raise CollectorError("Server acknowledgement is incomplete; queued samples were retained")
        return ack


class Queue:
    def __init__(self, directory: Path, *, max_samples=MAX_QUEUE_SAMPLES,
                 max_age_seconds=MAX_QUEUE_AGE_SECONDS):
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(directory / "queue.sqlite", timeout=5)
        self.max_samples, self.max_age_seconds = max_samples, max_age_seconds
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA wal_autocheckpoint=64")
        self.db.execute("PRAGMA journal_size_limit=1048576")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS pending (
                observed_at TEXT PRIMARY KEY NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS counters (
                name TEXT PRIMARY KEY NOT NULL,
                value INTEGER NOT NULL
            );
            INSERT OR IGNORE INTO counters(name, value) VALUES ('pruned', 0);
        """)

    def close(self):
        self.db.close()

    def count(self) -> int:
        return self.db.execute("SELECT COUNT(*) FROM pending").fetchone()[0]

    def pruned_count(self) -> int:
        return self.db.execute("SELECT value FROM counters WHERE name='pruned'").fetchone()[0]

    def _prune(self, now: datetime) -> int:
        cutoff = iso_time(now - timedelta(seconds=self.max_age_seconds))
        dropped = self.db.execute("DELETE FROM pending WHERE observed_at < ?", (cutoff,)).rowcount
        overflow = max(0, self.count() - self.max_samples)
        if overflow:
            dropped += self.db.execute("""DELETE FROM pending WHERE observed_at IN
                (SELECT observed_at FROM pending ORDER BY observed_at LIMIT ?)""", (overflow,)).rowcount
        if dropped:
            self.db.execute("UPDATE counters SET value=value+? WHERE name='pruned'", (dropped,))
        return dropped

    def prune(self, now: datetime | None = None) -> int:
        with self.db:
            return self._prune(now or utc_now())

    def enqueue(self, sample: dict, now: datetime | None = None) -> int:
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO pending(observed_at,payload) VALUES (?,?)",
                            (sample["observedAt"], compact_json(sample).decode("utf-8")))
            return self._prune(now or utc_now())

    def batch(self) -> list[dict]:
        newest = self.db.execute("SELECT observed_at,payload FROM pending ORDER BY observed_at DESC LIMIT 1").fetchone()
        if newest is None:
            return []
        # The newest sample always has priority so a recovered connection does
        # not show a stale dashboard while the historical backlog is drained.
        candidates = [newest, *self.db.execute("""SELECT observed_at,payload FROM pending
            WHERE observed_at <> ? ORDER BY observed_at LIMIT ?""", (newest[0], MAX_BATCH_SAMPLES - 1)).fetchall()]
        samples: list[dict] = []
        for _, payload in candidates:
            sample = json.loads(payload)
            proposed = samples + [sample]
            if len(compact_json({"version": 1, "samples": proposed})) > MAX_BATCH_BYTES:
                break
            samples.append(sample)
        if not samples:
            raise CollectorError("Stored sample exceeds the upload limit")
        return sorted(samples, key=lambda sample: sample["observedAt"])

    def acknowledge(self, samples: list[dict]):
        with self.db:
            self.db.executemany("DELETE FROM pending WHERE observed_at=?",
                                ((sample["observedAt"],) for sample in samples))


def upload_pending(queue: Queue, client: HttpClient, config: Config) -> tuple[dict | None, int]:
    dropped = queue.prune()
    if dropped:
        LOG.warning("Pruned %d expired or excess pending samples; a history gap remains", dropped)
    samples = queue.batch()
    if not samples:
        return None, 0
    ack = client.send(config.destination, config.token, samples)
    # If the response is lost after a server commit, this line is not reached.
    # A retry receives duplicate acknowledgements and safely clears the queue.
    queue.acknowledge(samples)
    return ack, len(samples)


def next_backoff(previous: int) -> int:
    return min(900, max(30, previous * 2))


def run(config: Config, client: HttpClient, stop: threading.Event):
    queue = Queue(config.state_dir)
    next_poll, next_upload, retry_delay = time.monotonic(), 0.0, 0
    LOG.info("Solar collector started; poll interval %ds; %d pending samples", config.poll_seconds, queue.count())
    try:
        while not stop.is_set():
            if time.monotonic() >= next_poll:
                try:
                    sample = client.read_inverter(config.origin)
                    dropped = queue.enqueue(sample)
                    if dropped:
                        LOG.warning("Pruned %d expired or excess pending samples; a history gap remains", dropped)
                except CollectorError as error:
                    LOG.warning("Inverter read: %s", error)
                next_poll = time.monotonic() + config.poll_seconds
            if not stop.is_set() and queue.count() and time.monotonic() >= next_upload:
                try:
                    ack, count = upload_pending(queue, client, config)
                    retry_delay = 0
                    if ack is not None:
                        LOG.info("Acknowledged %d samples (%d new, %d duplicate); %d pending",
                                 count, ack["accepted"], ack["duplicates"], queue.count())
                    next_upload = time.monotonic() + (10 if queue.count() else config.poll_seconds)
                except CollectorError as error:
                    retry_delay = next_backoff(retry_delay)
                    next_upload = time.monotonic() + retry_delay
                    LOG.warning("Upload: %s; retry in %ds; pending samples retained", error, retry_delay)
            deadlines = [next_poll]
            if queue.count():
                deadlines.append(next_upload)
            stop.wait(max(0.25, min(deadlines) - time.monotonic()))
    finally:
        queue.close()
        LOG.info("Solar collector stopped")


def main(argv=None, env=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="read the inverter once; no upload or file writes")
    args = parser.parse_args(argv)
    env = os.environ if env is None else env
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    try:
        if args.check:
            origin = inverter_origin(env.get("FRONIUS_BASE_URL", ""))
            sample = HttpClient().read_inverter(origin)
            print(json.dumps(sample, indent=2, allow_nan=False))
            return 0
        config = Config.from_env(env)
        stop = threading.Event()
        signal.signal(signal.SIGTERM, lambda *_args: stop.set())
        signal.signal(signal.SIGINT, lambda *_args: stop.set())
        run(config, HttpClient(), stop)
        return 0
    except CollectorError as error:
        LOG.error("%s", error)
        return 2
    except (sqlite3.Error, OSError) as error:
        # Do not print exception values: URLs, file contents, or environment
        # values supplied by another component do not belong in service logs.
        LOG.error("Local collector storage or system operation failed (%s)", type(error).__name__)
        return 1


if __name__ == "__main__":
    sys.exit(main())
