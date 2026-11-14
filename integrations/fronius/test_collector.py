"""Offline collector behavior tests: only synthetic data and loopback HTTP."""

import contextlib
from datetime import datetime, timedelta, timezone
from http.client import BadStatusLine, IncompleteRead
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import URLError
from urllib.request import Request

import collector


FIXED = datetime(2026, 1, 12, 2, 30, tzinfo=timezone.utc)


def powerflow(at=FIXED):
    return {
        "Head": {"Status": {"Code": 0}, "Timestamp": collector.iso_time(at)},
        "Body": {"Data": {
            "Site": {
                "P_PV": 3140.5, "P_Grid": -2200.25, "P_Load": -800,
                "P_Akku": None, "E_Total": 21_000_000,
                "E_Day": None, "E_Year": None, "Mode": "meter", "Meter_Location": "grid",
            },
            "Inverters": {"1": {"P": 3000.25, "E_Total": 21_000_000}},
            "PrivateExample": {"serial": "SYNTHETIC-SHOULD-NOT-LEAVE"},
        }},
    }


def sample(at=FIXED):
    return collector.normalize_powerflow(powerflow(at), at)


def config(directory):
    return collector.Config("http://192.0.2.10", "https://weather.example.invalid/internal/solar/ingest",
                            "test-only-machine-credential-0123456789", Path(directory))


class Response(io.BytesIO):
    status = 200


class StubOpener:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.requests = []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        item = next(self.responses)
        if isinstance(item, Exception):
            raise item
        return Response(item if isinstance(item, bytes) else collector.compact_json(item))


class NormalizationTests(unittest.TestCase):
    def test_distinct_dc_ac_signs_and_whitelist(self):
        result = sample()
        self.assertEqual(result["pvPowerW"], 3140.5)
        self.assertEqual(result["inverterPowerW"], 3000.25)
        self.assertEqual(result["gridPowerW"], -2200.25)
        self.assertEqual(result["loadPowerW"], 800)
        self.assertIsNone(result["batteryPowerW"])
        self.assertIsNone(result["batterySocPercent"])
        self.assertEqual(result["totalAcEnergyWh"], 21_000_000)
        self.assertEqual(result["mode"], "meter")
        self.assertNotIn("SYNTHETIC-SHOULD-NOT-LEAVE", json.dumps(result))
        self.assertEqual(set(result), {
            "observedAt", "collectedAt", "pvPowerW", "inverterPowerW", "gridPowerW", "loadPowerW",
            "batteryPowerW", "batterySocPercent", "totalAcEnergyWh", "meterLocation", "mode",
        })

    def test_zero_and_missing_are_different(self):
        payload = powerflow()
        payload["Body"]["Data"]["Site"].update(P_PV=0, P_Load=0, P_Grid=None, P_Akku=0)
        payload["Body"]["Data"]["Inverters"]["1"].update(P=0, E_Total=0, SOC=0)
        result = collector.normalize_powerflow(payload, FIXED)
        for key in ("pvPowerW", "loadPowerW", "batteryPowerW", "inverterPowerW", "totalAcEnergyWh", "batterySocPercent"):
            self.assertEqual(result[key], 0)
        self.assertIsNone(result["gridPowerW"])

        payload["Body"]["Data"]["Site"] = {}
        payload["Body"]["Data"]["Inverters"] = {}
        result = collector.normalize_powerflow(payload, FIXED)
        self.assertTrue(all(value is None for key, value in result.items() if key not in {"observedAt", "collectedAt"}))

    def test_battery_charge_and_net_generation_signs(self):
        payload = powerflow()
        payload["Body"]["Data"]["Site"].update(P_Akku=-600, P_Load=100)
        payload["Body"]["Data"]["Inverters"]["1"]["SOC"] = 61.5
        result = collector.normalize_powerflow(payload, FIXED)
        self.assertEqual(result["batteryPowerW"], -600)
        self.assertEqual(result["batterySocPercent"], 61.5)
        self.assertEqual(result["loadPowerW"], -100)

    def test_explicit_timezone_and_canonical_utc(self):
        payload = powerflow()
        payload["Head"]["Timestamp"] = "2026-01-12T12:30:00+10:00"
        result = collector.normalize_powerflow(payload, FIXED)
        self.assertEqual(result["observedAt"], "2026-01-12T02:30:00.000Z")

    def test_no_missing_or_stale_clock_guessing(self):
        for value in (None, "2026-01-12T02:30:00", "2026-02-30T00:00:00Z",
                      collector.iso_time(FIXED - timedelta(minutes=16)),
                      collector.iso_time(FIXED + timedelta(minutes=6))):
            with self.subTest(value=value):
                payload = powerflow()
                payload["Head"]["Timestamp"] = value
                with self.assertRaises(collector.CollectorError):
                    collector.normalize_powerflow(payload, FIXED)

    def test_bad_status_structure_and_measurements(self):
        for code in (1, "0", False, None):
            with self.subTest(code=code):
                payload = powerflow()
                payload["Head"]["Status"]["Code"] = code
                with self.assertRaises(collector.CollectorError):
                    collector.normalize_powerflow(payload, FIXED)
        for value in (True, "120", float("nan"), float("inf"), -1, 10**500):
            with self.subTest(value_type=type(value).__name__):
                payload = powerflow()
                payload["Body"]["Data"]["Site"]["P_PV"] = value
                with self.assertRaises(collector.CollectorError):
                    collector.normalize_powerflow(payload, FIXED)
        payload = powerflow()
        del payload["Body"]["Data"]["Site"]
        with self.assertRaises(collector.CollectorError):
            collector.normalize_powerflow(payload, FIXED)

    def test_unrecognized_metadata_does_not_leak_or_block_readings(self):
        payload = powerflow()
        payload["Body"]["Data"]["Site"].update(Mode={"arbitrary": "private"}, Meter_Location="future-value")
        result = collector.normalize_powerflow(payload, FIXED)
        self.assertIsNone(result["mode"])
        self.assertIsNone(result["meterLocation"])
        self.assertEqual(result["pvPowerW"], 3140.5)

    def test_check_needs_no_token_and_makes_no_queue(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "must-not-exist"
            with patch.object(collector, "HttpClient") as client, contextlib.redirect_stdout(io.StringIO()) as output:
                client.return_value.read_inverter.return_value = sample()
                result = collector.main(["--check"], {
                    "FRONIUS_BASE_URL": "http://192.0.2.10", "SOLAR_STATE_DIR": str(state),
                    "SOLAR_INGEST_URL": "invalid-on-purpose", "SOLAR_INGEST_TOKEN": "",
                })
                self.assertEqual(result, 0)
                client.return_value.read_inverter.assert_called_once_with("http://192.0.2.10")
                client.return_value.send.assert_not_called()
                self.assertEqual(json.loads(output.getvalue())["pvPowerW"], 3140.5)
                self.assertFalse(state.exists())


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.queue = collector.Queue(Path(self.directory.name))

    def tearDown(self):
        self.queue.close()
        self.directory.cleanup()

    def test_restart_and_duplicate_preserve_first_sample(self):
        first = sample()
        self.queue.enqueue(first, FIXED)
        duplicate = {**first, "pvPowerW": 999}
        self.queue.enqueue(duplicate, FIXED)
        self.queue.close()
        self.queue = collector.Queue(Path(self.directory.name))
        self.assertEqual(self.queue.count(), 1)
        self.assertEqual(self.queue.batch()[0]["pvPowerW"], 3140.5)

    def test_newest_sample_is_sent_with_oldest_backlog(self):
        for minute in range(140):
            self.queue.enqueue(sample(FIXED + timedelta(minutes=minute)), FIXED + timedelta(minutes=140))
        batch = self.queue.batch()
        self.assertEqual(len(batch), 120)
        self.assertEqual(batch[0]["observedAt"], collector.iso_time(FIXED))
        self.assertEqual(batch[-1]["observedAt"], collector.iso_time(FIXED + timedelta(minutes=139)))
        self.assertLessEqual(len(collector.compact_json({"version": 1, "samples": batch})), 128 * 1024)
        self.queue.acknowledge(batch)
        self.assertEqual(self.queue.count(), 20)

    def test_age_and_count_limits_are_counted_and_persisted(self):
        self.queue.max_age_seconds = 3600
        self.queue.max_samples = 3
        self.queue.enqueue(sample(FIXED - timedelta(hours=2)), FIXED - timedelta(hours=2))
        for minute in range(5):
            self.queue.enqueue(sample(FIXED + timedelta(minutes=minute)), FIXED + timedelta(minutes=5))
        self.assertEqual(self.queue.count(), 3)
        self.assertEqual(self.queue.pruned_count(), 3)
        self.assertEqual(self.queue.batch()[0]["observedAt"], collector.iso_time(FIXED + timedelta(minutes=2)))
        self.queue.close()
        self.queue = collector.Queue(Path(self.directory.name))
        self.assertEqual(self.queue.pruned_count(), 3)

    def test_lost_acknowledgement_retries_as_duplicates_after_restart(self):
        now = collector.utc_now()
        reading = sample(now)
        self.queue.enqueue(reading, now)
        stored = set()

        class Server:
            attempts = 0

            def send(self, _destination, _token, samples):
                self.attempts += 1
                duplicates = sum(item["observedAt"] in stored for item in samples)
                stored.update(item["observedAt"] for item in samples)
                if self.attempts == 1:
                    raise collector.CollectorError("Synthetic lost acknowledgement")
                return {"accepted": len(samples) - duplicates, "duplicates": duplicates}

        client = Server()
        with self.assertRaises(collector.CollectorError):
            collector.upload_pending(self.queue, client, config(self.directory.name))
        self.assertEqual(self.queue.count(), 1)
        self.queue.close()
        self.queue = collector.Queue(Path(self.directory.name))
        ack, count = collector.upload_pending(self.queue, client, config(self.directory.name))
        self.assertEqual(ack, {"accepted": 0, "duplicates": 1})
        self.assertEqual(count, 1)
        self.assertEqual(self.queue.count(), 0)

    def test_incomplete_and_invalid_ack_never_delete_pending_rows(self):
        now = collector.utc_now()
        self.queue.enqueue(sample(now), now)
        for ack in ({"accepted": 0, "duplicates": 0}, {"accepted": True, "duplicates": 0},
                    {"accepted": 1}, {"accepted": -1, "duplicates": 2}, b"<html>error</html>"):
            with self.subTest(ack=ack):
                client = collector.HttpClient(StubOpener([ack]))
                with self.assertRaises(collector.CollectorError):
                    collector.upload_pending(self.queue, client, config(self.directory.name))
                self.assertEqual(self.queue.count(), 1)

    def test_truncated_http_ack_retains_queue_and_sanitizes_error(self):
        class TruncatedResponse(Response):
            def read(self, _size=-1):
                raise IncompleteRead(b'{"accepted":1,"duplicates":', 2)

        class TruncatedOpener:
            def open(self, _request, timeout):
                return TruncatedResponse(b"")

        now = collector.utc_now()
        self.queue.enqueue(sample(now), now)
        client = collector.HttpClient(TruncatedOpener())
        with self.assertRaises(collector.CollectorError) as error:
            collector.upload_pending(self.queue, client, config(self.directory.name))
        self.assertEqual(str(error.exception), "Endpoint request failed (IncompleteRead)")
        self.assertEqual(self.queue.count(), 1)


class TransportTests(unittest.TestCase):
    def test_url_and_token_validation_fail_closed(self):
        valid = {
            "FRONIUS_BASE_URL": "http://192.0.2.10", "SOLAR_STATE_DIR": "/tmp/test-solar-state",
            "SOLAR_INGEST_URL": "https://weather.example.invalid/internal/solar/ingest",
            "SOLAR_INGEST_TOKEN": "test-only-machine-credential-0123456789",
        }
        for key, value in (
            ("FRONIUS_BASE_URL", "http://user:password@192.0.2.10"),
            ("FRONIUS_BASE_URL", "http://192.0.2.10/other"),
            ("SOLAR_INGEST_URL", "http://weather.example.invalid/internal/solar/ingest"),
            ("SOLAR_INGEST_URL", "https://weather.example.invalid/internal/solar/ingest?token=bad"),
            ("SOLAR_INGEST_URL", "https://weather.example.invalid/other"),
            ("SOLAR_INGEST_TOKEN", "short"), ("SOLAR_INGEST_TOKEN", "x" * 40 + "\nother-header"),
            ("SOLAR_POLL_SECONDS", "1"), ("SOLAR_POLL_SECONDS", "300"), ("SOLAR_POLL_SECONDS", "nan"),
            ("SOLAR_STATE_DIR", "relative/path"),
        ):
            with self.subTest(key=key):
                with self.assertRaises(collector.CollectorError):
                    collector.Config.from_env({**valid, key: value})

    def test_only_server_receives_machine_credential_and_measurements(self):
        now = collector.utc_now()
        opener = StubOpener([powerflow(now), {"accepted": 1, "duplicates": 0}])
        client = collector.HttpClient(opener)
        result = client.read_inverter("http://192.0.2.10")
        client.send("https://weather.example.invalid/internal/solar/ingest", "fixture-credential", [result])
        local, upload = opener.requests
        self.assertIsNone(local[0].get_header("Authorization"))
        self.assertEqual(local[1], 5)
        self.assertEqual(upload[1], 10)
        self.assertEqual(upload[0].get_header("Authorization"), "Bearer fixture-credential")
        self.assertIsNone(upload[0].get_header("Origin"))
        self.assertNotIn(b"SYNTHETIC-SHOULD-NOT-LEAVE", upload[0].data)
        self.assertEqual(json.loads(upload[0].data)["version"], 1)

    def test_oversized_invalid_and_nonfinite_responses_are_rejected(self):
        for body in (b"x" * 1025, b"{\"value\":NaN}", b"{\"value\":Infinity}", b"\xff", b"<html>no</html>"):
            client = collector.HttpClient(StubOpener([body]))
            with self.assertRaises(collector.CollectorError):
                client.request_json(Request("http://192.0.2.10"), 5, 1024)

    def test_network_error_does_not_echo_sensitive_exception_text(self):
        client = collector.HttpClient(StubOpener([URLError("synthetic-secret-must-not-be-logged")]))
        with self.assertRaises(collector.CollectorError) as error:
            client.request_json(Request("http://192.0.2.10"), 5, 1024)
        self.assertNotIn("synthetic-secret", str(error.exception))

    def test_bad_http_status_and_overly_nested_json_are_controlled_errors(self):
        for response in (BadStatusLine("synthetic-private-response"),
                         b"[" * 1500 + b"0" + b"]" * 1500,
                         b"9" * 5000):
            with self.subTest(response_type=type(response).__name__):
                client = collector.HttpClient(StubOpener([response]))
                with self.assertRaises(collector.CollectorError) as error:
                    client.request_json(Request("http://192.0.2.10"), 5, 8192)
                self.assertNotIn("synthetic-private", str(error.exception))

    def test_brackets_and_escaped_quotes_inside_json_strings_are_not_nesting(self):
        value = {"string": '[' * 200 + 'quote: " and backslash: \\' + ']' * 200}
        client = collector.HttpClient(StubOpener([value]))
        self.assertEqual(client.request_json(Request("http://192.0.2.10"), 5, 8192), value)

    def test_real_http_redirect_never_reaches_destination(self):
        visited = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                visited.append((self.path, self.headers.get("Authorization")))
                if self.path == "/redirect":
                    self.send_response(307)
                    self.send_header("Location", f"http://127.0.0.1:{self.server.server_port}/target")
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"{}")

            do_POST = do_GET

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            client = collector.HttpClient()
            for method in ("GET", "POST"):
                request = Request(f"http://127.0.0.1:{server.server_port}/redirect", method=method,
                                  headers={"Authorization": "Bearer synthetic-only"})
                with self.assertRaises(collector.CollectorError):
                    client.request_json(request, 2, 1024)
            self.assertEqual([path for path, _auth in visited], ["/redirect", "/redirect"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)


class LoopTests(unittest.TestCase):
    def test_upload_backoff_does_not_stop_regular_collection(self):
        clock = [0.0]
        uploads, polls = [], []

        class Stop:
            def is_set(self):
                return clock[0] >= 305

            def wait(self, delay):
                clock[0] += delay

        class OfflineServer:
            def read_inverter(self, _origin):
                polls.append(clock[0])
                return sample(FIXED + timedelta(seconds=clock[0]))

            def send(self, _destination, _token, _samples):
                uploads.append(clock[0])
                raise collector.CollectorError("Synthetic offline server")

        with tempfile.TemporaryDirectory() as directory:
            with patch.object(collector.time, "monotonic", side_effect=lambda: clock[0]), \
                    patch.object(collector, "utc_now", side_effect=lambda: FIXED + timedelta(seconds=clock[0])), \
                    self.assertLogs(collector.LOG, level="WARNING"):
                collector.run(config(directory), OfflineServer(), Stop())
            self.assertEqual(polls, [0, 60, 120, 180, 240, 300])
            self.assertEqual(uploads, [0, 30, 90, 210])
            queue = collector.Queue(Path(directory))
            try:
                self.assertEqual(queue.count(), 6)
            finally:
                queue.close()
        delay = 0
        for _ in range(30):
            delay = collector.next_backoff(delay)
            self.assertGreaterEqual(delay, 30)
            self.assertLessEqual(delay, 900)
        self.assertEqual(delay, 900)


if __name__ == "__main__":
    unittest.main()
