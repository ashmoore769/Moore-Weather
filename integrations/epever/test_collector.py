#!/usr/bin/env python3
"""Offline tests for EPEVER sparse Modbus framing and read-only decoding."""
import importlib.util
from pathlib import Path
import random
import sys
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("yard_collector", HERE / "collector.py")
collector = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = collector
spec.loader.exec_module(collector)

REQUEST = bytes.fromhex("01 43 31 00 00 76 CB 1F")
REPLY = bytes.fromhex(
    "01 43 EC 00 00 00 00 00 00 00 00 00 00 00 2C 0F FF FF"
    "07 C6 00 0F 01 30 00 00 05 67 00 16 01 30 00 00 05 67"
    "00 0A 00 8A 00 00 05 67 00 0A 00 8A 00 00 09 C4 0E A8"
    "0E A8 09 C4 00 64 09 C4 04 B0 06 0D"
)
OTHER_REQUEST = bytes.fromhex("01 43 32 00 00 04 4B 7E")
OTHER_REPLY = bytes.fromhex("01 43 08 07 00 00 00 07 00 01 03 96")


class DecoderTests(unittest.TestCase):
    def test_known_crc_and_metrics(self):
        self.assertTrue(collector.valid_crc(REQUEST))
        self.assertTrue(collector.valid_crc(REPLY))
        self.assertEqual(len(REPLY), 66)
        readings = collector.decode_metrics(REPLY)
        self.assertEqual(readings["batteryVoltageV"], 13.83)
        self.assertEqual(readings["pvVoltageV"], 19.90)
        self.assertEqual(readings["pvPowerW"], 3.04)
        self.assertEqual(readings["chargeCurrentA"], .22)
        self.assertEqual(readings["controllerLoadPowerW"], 1.38)
        self.assertEqual(readings["controllerTempC"], 37.52)
        self.assertEqual(readings["pvCurrentA"], .15)
        self.assertEqual(readings["controllerLoadCurrentA"], .10)

    def test_various_tcp_chunk_boundaries(self):
        payload = OTHER_REQUEST + OTHER_REPLY + REQUEST + REPLY + OTHER_REQUEST + OTHER_REPLY
        expected_frames = 6
        for seed in range(25):
            decoder = collector.FrameDecoder()
            rng = random.Random(seed)
            actual = []
            pos = 0
            while pos < len(payload):
                n = rng.randrange(1, 15)
                actual.extend(decoder.feed(payload[pos:pos + n]))
                pos += n
            self.assertEqual(decoder.valid_frames, expected_frames, seed)
            self.assertEqual(len(actual), 1, seed)
            self.assertEqual(actual[0]["batteryVoltageV"], 13.83)

    def test_reject_corruption_and_orphan_response(self):
        decoder = collector.FrameDecoder()
        self.assertEqual(decoder.feed(REPLY), [])
        damaged = bytearray(REPLY)
        damaged[-1] ^= 1
        decoder = collector.FrameDecoder()
        self.assertEqual(decoder.feed(REQUEST + damaged), [])
        self.assertEqual(decoder.feed(OTHER_REQUEST + OTHER_REPLY + REQUEST + REPLY), [collector.decode_metrics(REPLY)])

    def test_no_data_if_request_does_not_match(self):
        decoder = collector.FrameDecoder()
        self.assertEqual(decoder.feed(OTHER_REQUEST + REPLY), [])
        self.assertEqual(decoder.feed(REQUEST + REPLY), [collector.decode_metrics(REPLY)])


if __name__ == "__main__":
    unittest.main()
