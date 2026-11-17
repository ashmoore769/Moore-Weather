#!/usr/bin/env python3
"""Passive EPEVER Tracer/MT50 Modbus-RTU collector for Moore Weather.

The TCP socket is strictly receive-only. Do not use this tool to send Modbus
requests when the MT50 is already the bus master.
"""
import argparse
from collections import deque
from datetime import datetime, timezone
import json
import logging
import os
from pathlib import Path
import signal
import socket
import sqlite3
import sys
import threading
import time
from urllib.parse import urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

LOG = logging.getLogger("moore-yard-power")
FIELDS = ("batteryVoltageV", "pvVoltageV", "pvPowerW", "chargeCurrentA",
          "controllerLoadPowerW", "controllerTempC", "pvCurrentA",
          "controllerLoadCurrentA", "chargingPowerW")
REQUEST_31 = bytes.fromhex("01 43 31 00 00 76 CB 1F")
MAX_QUEUE = 14 * 24 * 60 + 120
MAX_AGE = (14 * 24 * 60 - 60) * 60
SOCKET_TIMEOUT = 15


class CollectorError(Exception):
    pass


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for value in data:
        crc ^= value
        for _ in range(8):
            crc = (crc >> 1) ^ (0xA001 if crc & 1 else 0)
    return crc


def valid_crc(frame: bytes) -> bool:
    return len(frame) >= 4 and crc16(frame[:-2]) == int.from_bytes(frame[-2:], "little")


def parse_registers(frame: bytes) -> dict[int, int]:
    """Decode EPEVER custom sparse function 0x43, excluding CRC.

    The response byte 2 is the bit coverage in *bits*, where two bits are
    allocated per register slot. The high-endian bit mask selects the present
    16-bit values in ascending register order.
    """
    if len(frame) < 7 or frame[:2] != b"\x01\x43" or not valid_crc(frame):
        raise CollectorError("Not a valid EPEVER sparse response")
    bit_coverage = frame[2]
    mask_len = (bit_coverage + 15) // 16
    if bit_coverage % 2 or mask_len < 1 or len(frame) < mask_len + 5:
        raise CollectorError("Invalid sparse mask length")
    mask = int.from_bytes(frame[3:3 + mask_len], "big")
    count = sum(bool(mask & (1 << i)) for i in range(bit_coverage // 2))
    if len(frame) != 5 + mask_len + 2 * count:
        raise CollectorError("Invalid sparse response size")
    values = frame[3 + mask_len:-2]
    offset = 0
    registers = {}
    for slot in range(bit_coverage // 2):
        if mask & (1 << slot):
            registers[slot] = int.from_bytes(values[offset:offset + 2], "big")
            offset += 2
    return registers


def decode_metrics(frame: bytes) -> dict:
    if frame[:3] != b"\x01\x43\xec":
        raise CollectorError("Not a measurement response")
    data = parse_registers(frame)
    # The MT50 request beginning 01 43 31 reads the 0x3100 register family.
    def value(register: int, divisor: float = 100.0) -> float | None:
        raw = data.get(register - 0x3100)
        return None if raw is None else round(raw / divisor, 4)
    # EPEVER values are non-negative for these registers. Signed conversion is
    # intentionally limited to controller temperature, per register map.
    def temperature(register: int) -> float | None:
        raw = data.get(register - 0x3100)
        if raw is None:
            return None
        if raw & 0x8000:
            raw -= 0x10000
        return round(raw / 100, 2)
    return {
        "batteryVoltageV": value(0x3104),
        "pvVoltageV": value(0x3100),
        "pvPowerW": value(0x3102),
        "chargeCurrentA": value(0x3105),
        "controllerLoadPowerW": value(0x310A),
        "controllerTempC": temperature(0x3111),
        "pvCurrentA": value(0x3101),
        "controllerLoadCurrentA": value(0x3109),
        "chargingPowerW": value(0x3106),
    }


class FrameDecoder:
    def __init__(self):
        self.buffer = bytearray()
        self.awaiting_measurement = False
        self.valid_frames = 0
        self.crc_rejections = 0

    @staticmethod
    def candidate_lengths(buf: bytearray) -> list[tuple[int, str]]:
        if len(buf) < 3 or buf[0] != 1:
            return []
        function = buf[1]
        if function == 0x43:
            lengths = [(8, "request")]
            count = buf[2]
            if count % 2 == 0 and 0 < count <= 240:
                mask_len = (count + 15) // 16
                if len(buf) >= 3 + mask_len:
                    mask = int.from_bytes(buf[3:3 + mask_len], "big")
                    payload_regs = (mask & ((1 << (count // 2)) - 1)).bit_count()
                    length = 5 + mask_len + 2 * payload_regs
                    if length <= 300:
                        lengths.append((length, "response"))
            return lengths
        if function in (0x02, 0x04):
            return [(8, "request"), (5 + buf[2], "response")]
        return []

    def feed(self, chunk: bytes) -> list[dict]:
        self.buffer.extend(chunk)
        readings = []
        while len(self.buffer) >= 5:
            if self.buffer[0] != 1 or self.buffer[1] not in (0x43, 0x02, 0x04):
                del self.buffer[0]
                continue
            # A sparse response (especially 0xEC) begins with its coverage byte,
            # but the mask may arrive in a later TCP packet. Wait until we have
            # its complete mask before treating the 8-byte request candidate as
            # a malformed frame. TCP chunk boundaries are not Modbus boundaries.
            if self.buffer[1] == 0x43 and self.buffer[2] % 2 == 0 and 0 < self.buffer[2] <= 240:
                required_header = 3 + (self.buffer[2] + 15) // 16
                if len(self.buffer) < required_header:
                    break
            candidates = self.candidate_lengths(self.buffer)
            complete = [(size, kind) for size, kind in candidates if len(self.buffer) >= size]
            match = next(((size, kind) for size, kind in complete
                          if valid_crc(self.buffer[:size])), None)
            if match:
                size, kind = match
                frame = bytes(self.buffer[:size])
                del self.buffer[:size]
                self.valid_frames += 1
                if kind == "request":
                    self.awaiting_measurement = frame == REQUEST_31
                elif kind == "response" and frame[:3] == b"\x01\x43\xec" and self.awaiting_measurement:
                    try:
                        reading = decode_metrics(frame)
                        if reading["batteryVoltageV"] is not None:
                            readings.append(reading)
                    except CollectorError:
                        pass
                    self.awaiting_measurement = False
                continue
            # If a valid frame may still be incomplete, wait for more TCP bytes.
            if not complete or (len(complete) < len(candidates) and len(self.buffer) < 300):
                break
            self.crc_rejections += 1
            del self.buffer[0]
        if len(self.buffer) > 512:
            self.buffer = self.buffer[-256:]
        return readings


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def make_sample(reading: dict, now: datetime | None = None) -> dict:
    moment = now or datetime.now(timezone.utc)
    iso = moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    sample = {"observedAt": iso, "collectedAt": iso}
    for field in FIELDS:
        sample[field] = reading.get(field)
    return sample


class Queue:
    def __init__(self, folder: Path):
        folder.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(folder / "queue.sqlite", timeout=5)
        self.db.execute("CREATE TABLE IF NOT EXISTS pending (observed_at TEXT PRIMARY KEY, body TEXT NOT NULL)")
        self.db.commit()

    def enqueue(self, sample: dict):
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO pending VALUES (?, ?)",
                            (sample["observedAt"], json.dumps(sample, allow_nan=False, separators=(",", ":"))))
            self.prune()
    def prune(self):
        cutoff = datetime.fromtimestamp(time.time() - MAX_AGE, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self.db.execute("DELETE FROM pending WHERE observed_at < ?", (cutoff,))
        self.db.execute("DELETE FROM pending WHERE observed_at IN (SELECT observed_at FROM pending ORDER BY observed_at DESC LIMIT -1 OFFSET ?)", (MAX_QUEUE,))
        self.db.commit()
    def batch(self):
        self.prune()
        return [(key, json.loads(body)) for key, body in
                self.db.execute("SELECT observed_at,body FROM pending ORDER BY observed_at LIMIT 120")]
    def acknowledge(self, rows):
        with self.db:
            self.db.executemany("DELETE FROM pending WHERE observed_at = ?", [(key,) for key, _ in rows])
    def count(self):
        return self.db.execute("SELECT COUNT(*) FROM pending").fetchone()[0]
    def close(self):
        self.db.close()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, newurl):
        raise CollectorError("Upload redirects are prohibited")


class Uploader:
    def __init__(self, url: str, token: str):
        parsed = urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.port not in (None, 443) or \
                parsed.path != "/internal/yard-power/ingest" or parsed.query or parsed.fragment or \
                parsed.username or parsed.password:
            raise CollectorError("YARD_POWER_INGEST_URL must be the exact HTTPS yard-power ingest endpoint")
        if not (32 <= len(token) <= 256 and all(33 <= ord(c) <= 126 for c in token)):
            raise CollectorError("YARD_POWER_INGEST_TOKEN must be 32-256 visible ASCII characters")
        self.url = url
        self.token = token
        self.http = build_opener(NoRedirect())

    def upload(self, rows):
        body = json.dumps({"version": 1, "samples": [sample for _, sample in rows]},
                          separators=(",", ":"), allow_nan=False).encode("utf-8")
        request = Request(self.url, data=body, method="POST", headers={
            "Accept": "application/json", "Content-Type": "application/json",
            "Authorization": "Bearer " + self.token, "User-Agent": "MooreYardPower/1"})
        try:
            with self.http.open(request, timeout=15) as response:
                if response.status != 200:
                    raise CollectorError("Unexpected upload response")
                payload = response.read(2048)
            answer = json.loads(payload)
            if not isinstance(answer, dict) or answer.get("accepted", -1) + answer.get("duplicates", -1) != len(rows):
                raise CollectorError("Upload acknowledgment mismatch")
        except CollectorError:
            raise
        except Exception as error:
            raise CollectorError("Upload failed (" + type(error).__name__ + ")") from None


def read_socket(host: str, port: int, decoder: FrameDecoder, on_measurement, stop: threading.Event):
    with socket.create_connection((host, port), timeout=10) as conn:
        conn.settimeout(SOCKET_TIMEOUT)
        LOG.info("Connected to Elfin; receive-only mode")
        while not stop.is_set():
            try:
                block = conn.recv(2048)
            except socket.timeout:
                raise CollectorError("Serial stream timeout") from None
            if not block:
                raise CollectorError("Elfin closed connection")
            for reading in decoder.feed(block):
                on_measurement(reading)


def run(env: dict, stop: threading.Event, *, check: bool = False):
    host = env.get("YARD_POWER_ELFIN_HOST", "192.168.86.69")
    if not host or len(host) > 253 or any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-" for ch in host):
        raise CollectorError("Invalid local Elfin host")
    port = int(env.get("YARD_POWER_ELFIN_PORT", "8899"))
    if not 1 <= port <= 65535:
        raise CollectorError("Invalid Elfin port")
    queue = None if check else Queue(Path(env.get("YARD_POWER_STATE_DIR", "/var/lib/moore-yard-power")))
    uploader = None if check else Uploader(env.get("YARD_POWER_INGEST_URL", ""), env.get("YARD_POWER_INGEST_TOKEN", ""))
    recent = deque(maxlen=256)
    last_minute = None
    decoder = FrameDecoder()
    backoff = 5
    last_upload = 0
    last_measurement = 0

    def on_measurement(reading):
        nonlocal last_minute, last_measurement
        last_measurement = time.monotonic()
        sample = make_sample(reading)
        if check:
            print(json.dumps(sample, indent=2), flush=True)
            stop.set()
            return
        minute = sample["observedAt"][:16]
        if minute != last_minute:
            queue.enqueue(sample)
            last_minute = minute
            LOG.info("Captured valid yard-power measurement; queued=%d", queue.count())

    try:
        while not stop.is_set():
            try:
                def callback(reading):
                    nonlocal last_upload
                    on_measurement(reading)
                    if uploader and time.monotonic() - last_upload >= 60:
                        rows = queue.batch()
                        if rows:
                            try:
                                uploader.upload(rows)
                                queue.acknowledge(rows)
                                LOG.info("Uploaded %d yard-power samples", len(rows))
                            except CollectorError as error:
                                LOG.warning("%s; retained pending readings", error)
                        last_upload = time.monotonic()

                read_socket(host, port, decoder, callback, stop)
                backoff = 5
            except (OSError, CollectorError) as error:
                LOG.warning("Connection unavailable (%s); retry in %ds", type(error).__name__, backoff)
                if not check and queue and uploader:
                    rows = queue.batch()
                    if rows:
                        try:
                            uploader.upload(rows)
                            queue.acknowledge(rows)
                        except CollectorError:
                            pass
                stop.wait(backoff)
                backoff = min(120, backoff * 2)
    finally:
        if queue:
            queue.close()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="one receive-only measurement; no upload or storage")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    try:
        run(os.environ, stop, check=args.check)
        return 0
    except (CollectorError, OSError, ValueError, sqlite3.Error) as error:
        LOG.error("Yard-power collector failed (%s)", type(error).__name__)
        return 2


if __name__ == "__main__":
    sys.exit(main())
