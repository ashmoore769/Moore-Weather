"""Offline recovery-policy tests. Never access a real network or request reboot."""

import contextlib
import copy
import fcntl
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import network_healthcheck as recovery


BOOT_A = "11111111-1111-4111-8111-111111111111"
BOOT_B = "22222222-2222-4222-8222-222222222222"
BOOT_C = "33333333-3333-4333-8333-333333333333"
PROFILE = "44444444-4444-4444-8444-444444444444"
BASE_WALL = 1800000000
CONFIG = {"version": 1, "interface": "wlan0", "connection_uuid": PROFILE}
HEALTHY = recovery.Snapshot(True, True, True, True)
MISSING = recovery.Snapshot(False, False, False, True)
DISCONNECTED = recovery.Snapshot(True, True, False, True)


class FakeHost:
    def __init__(self, snapshot=MISSING, events=None):
        self.now = recovery.Clock(BOOT_A, 1000, BASE_WALL)
        self.snapshots = [snapshot]
        self.events = events if events is not None else []
        self.actions = []
        self.reconnect_error = None
        self.radio_error = None
        self.reboot_error = None
        self.profile = PROFILE
        self.probes = 0

    def clock(self):
        return self.now

    def advance(self, seconds=300, *, wall_seconds=None, boot=None):
        self.now = recovery.Clock(boot or self.now.boot_id, self.now.uptime + seconds,
                                  self.now.wall + (seconds if wall_seconds is None else wall_seconds))

    def probe(self, config):
        self.probes += 1
        value = self.snapshots.pop(0) if len(self.snapshots) > 1 else self.snapshots[0]
        if isinstance(value, Exception):
            raise value
        return value

    def active_uuid(self, interface):
        return self.profile

    def enable_radio(self):
        self.actions.append("radio_on")
        if self.radio_error:
            raise self.radio_error

    def reconnect(self, config):
        self.actions.append("reconnect")
        if self.reconnect_error:
            raise self.reconnect_error

    def reboot(self):
        self.actions.append("reboot")
        self.events.append(("reboot", None))
        if self.reboot_error:
            raise self.reboot_error


class FakeStore:
    def __init__(self, clock, events=None):
        self.state = recovery.fresh_state(clock)
        self.events = events if events is not None else []
        self.fail_attempt_write = False

    def load(self):
        return recovery.validate_state(copy.deepcopy(self.state))

    def save(self, state):
        recovery.validate_state(state)
        if self.fail_attempt_write and state["rearm_pending"]:
            raise OSError("simulated full filesystem")
        self.state = copy.deepcopy(state)
        self.events.append(("save", copy.deepcopy(state)))


class RecoveryPolicyTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.host = FakeHost(events=self.events)
        self.store = FakeStore(self.host.clock(), self.events)
        self.output = io.StringIO()
        self.capture = contextlib.redirect_stdout(self.output)
        self.capture.__enter__()
        self.addCleanup(self.capture.__exit__, None, None, None)

    def run_check(self):
        return recovery.check_once(self.host, self.store, CONFIG)

    def three_missing_checks(self):
        results = [self.run_check()]
        for _ in range(2):
            self.host.advance()
            results.append(self.run_check())
        return results

    def test_healthy_wifi_never_changes_network_or_reboots(self):
        self.host.snapshots = [HEALTHY]
        self.assertEqual(self.run_check(), 0)
        self.assertEqual(self.host.actions, [])

    def test_router_or_password_failure_only_retries_existing_connection(self):
        self.host.snapshots = [DISCONNECTED]
        self.host.reconnect_error = recovery.CheckError("nmcli failed (exit 4)")
        for _ in range(8):
            self.assertEqual(self.run_check(), 1)
            self.host.advance()
        self.assertEqual(self.host.actions, ["reconnect"] * 8)
        self.assertEqual(self.store.state["attempts"], [])
        self.assertEqual(self.store.state["missing_count"], 0)

    def test_reconnect_can_restore_connection_without_reboot(self):
        self.host.snapshots = [DISCONNECTED, HEALTHY]
        self.assertEqual(self.run_check(), 0)
        self.assertEqual(self.host.actions, ["reconnect"])

    def test_intentional_change_to_another_profile_is_preserved(self):
        self.host.snapshots = [recovery.Snapshot(
            True, True, False, True, other_profile_connected=True)]
        self.three_missing_checks()
        self.assertEqual(self.host.actions, [])
        self.assertEqual(self.store.state["missing_count"], 0)

    def test_reconnect_completion_updates_observation_uptime(self):
        self.host.snapshots = [DISCONNECTED, HEALTHY]
        original_reconnect = self.host.reconnect

        def slow_reconnect(config):
            original_reconnect(config)
            self.host.advance(20)

        self.host.reconnect = slow_reconnect
        self.assertEqual(self.run_check(), 0)
        self.assertEqual(self.store.state["healthy_last"], self.host.clock().uptime)
        recovery.validate_state(self.store.state)

    def test_missing_adapter_needs_three_checks_spanning_ten_minutes(self):
        self.assertEqual(self.three_missing_checks(), [1, 1, 0])
        self.assertEqual(self.host.actions, ["reboot"])
        self.assertEqual(len(self.store.state["attempts"]), 1)

    def test_rapid_manual_checks_cannot_accelerate_missing_duration(self):
        for _ in range(10):
            self.run_check()
            self.host.advance(1)
        self.assertEqual(self.host.actions, [])

    def test_boot_grace_prevents_recovery_escalation(self):
        for uptime in (0, 300, 599):
            self.host.now = recovery.Clock(BOOT_B, uptime, BASE_WALL + uptime)
            self.run_check()
        self.assertEqual(self.host.actions, [])
        self.assertEqual(self.store.state["missing_count"], 0)

    def test_new_boot_cannot_inherit_old_missing_streak(self):
        self.run_check()
        self.host.advance()
        self.run_check()
        self.host.now = recovery.Clock(BOOT_B, 900, BASE_WALL + 1800)
        self.run_check()
        self.assertEqual(self.store.state["missing_count"], 1)
        self.assertEqual(self.host.actions, [])

    def test_unknown_networkmanager_state_clears_missing_streak(self):
        self.run_check()
        self.host.advance()
        self.run_check()
        self.host.advance()
        self.host.snapshots = [recovery.CheckError("nmcli unavailable or timed out")]
        self.assertEqual(self.run_check(), 1)
        self.assertEqual(self.store.state["missing_count"], 0)
        self.assertEqual(self.host.actions, [])

    def test_replacement_wireless_wired_or_hard_block_suppresses_reboot(self):
        for snapshot in (
            recovery.Snapshot(False, False, False, True, other_wireless=True),
            recovery.Snapshot(False, False, False, True, wired_connected=True),
            recovery.Snapshot(False, False, False, True, hard_blocked=True),
            recovery.Snapshot(False, True, False, True),
            recovery.Snapshot(True, False, False, True),
        ):
            with self.subTest(snapshot=snapshot):
                self.host = FakeHost(snapshot)
                self.store = FakeStore(self.host.clock())
                self.three_missing_checks()
                self.assertEqual(self.host.actions, [])
                self.assertEqual(self.store.state["missing_count"], 0)

    def test_last_moment_adapter_recovery_cancels_reboot(self):
        self.run_check()
        self.host.advance()
        self.run_check()
        self.host.advance()
        self.host.snapshots = [MISSING, HEALTHY]
        self.assertEqual(self.run_check(), 0)
        self.assertEqual(self.host.actions, [])
        self.assertEqual(self.store.state["attempts"], [])

    def test_unknown_final_probe_cancels_reboot(self):
        self.run_check()
        self.host.advance()
        self.run_check()
        self.host.advance()
        self.host.snapshots = [MISSING, recovery.CheckError("probe timed out")]
        self.assertEqual(self.run_check(), 1)
        self.assertEqual(self.host.actions, [])

    def test_reboot_attempt_is_persisted_before_reboot_request(self):
        self.three_missing_checks()
        self.assertEqual(self.events[-1][0], "reboot")
        kind, state = self.events[-2]
        self.assertEqual(kind, "save")
        self.assertEqual(state["last_reboot_boot"], BOOT_A)
        self.assertTrue(state["rearm_pending"])
        self.assertEqual(len(state["attempts"]), 1)

    def test_failed_attempt_persistence_prevents_reboot(self):
        self.store.fail_attempt_write = True
        self.run_check()
        self.host.advance()
        self.run_check()
        self.host.advance()
        with self.assertRaises(OSError):
            self.run_check()
        self.assertEqual(self.host.actions, [])
        self.assertEqual(self.store.state["attempts"], [])

    def test_failed_reboot_command_still_consumes_attempt(self):
        self.host.reboot_error = recovery.CheckError("systemctl failed (exit 1)")
        self.three_missing_checks()
        self.host.advance()
        self.three_missing_checks()
        self.assertEqual(self.host.actions, ["reboot"])
        self.assertEqual(len(self.store.state["attempts"]), 1)

    def test_six_hour_cooldown_survives_process_restart(self):
        self.store.state["attempts"] = [{"at": BASE_WALL - 3600, "boot_id": BOOT_B}]
        self.store.state["last_reboot_boot"] = BOOT_B
        self.three_missing_checks()
        self.assertEqual(self.host.actions, [])
        self.assertIn("six-hour", self.output.getvalue())

    def test_daily_budget_survives_previous_boots(self):
        self.store.state["attempts"] = [
            {"at": BASE_WALL - 7 * 3600, "boot_id": BOOT_B},
            {"at": BASE_WALL - 14 * 3600, "boot_id": BOOT_C},
        ]
        self.store.state["last_reboot_boot"] = BOOT_B
        self.three_missing_checks()
        self.assertEqual(self.host.actions, [])
        self.assertIn("daily limit", self.output.getvalue())

    def test_old_budget_allows_a_later_independent_recovery(self):
        self.store.state["attempts"] = [{"at": BASE_WALL - 90000, "boot_id": BOOT_B}]
        self.store.state["last_reboot_boot"] = BOOT_B
        self.three_missing_checks()
        self.assertEqual(self.host.actions, ["reboot"])

    def test_one_request_per_boot_even_if_wall_cooldown_expired(self):
        self.store.state["attempts"] = [{"at": BASE_WALL - 90000, "boot_id": BOOT_A}]
        self.store.state["last_reboot_boot"] = BOOT_A
        self.three_missing_checks()
        self.assertEqual(self.host.actions, [])

    def test_failed_recovery_boot_stays_latched_even_after_six_hours(self):
        self.store.state["attempts"] = [{"at": BASE_WALL - 30000, "boot_id": BOOT_B}]
        self.store.state["last_reboot_boot"] = BOOT_B
        self.store.state["rearm_pending"] = True
        self.three_missing_checks()
        self.assertEqual(self.host.actions, [])
        self.assertIn("30 minutes", self.output.getvalue())

    def test_thirty_minutes_of_observed_healthy_wifi_rearms_after_boot(self):
        self.store.state["rearm_pending"] = True
        self.store.state["last_reboot_boot"] = BOOT_A
        self.host.now = recovery.Clock(BOOT_B, 1000, BASE_WALL + 40000)
        self.host.snapshots = [HEALTHY]
        for _ in range(6):
            self.run_check()
            self.assertTrue(self.store.state["rearm_pending"])
            self.host.advance()
        self.run_check()
        self.assertFalse(self.store.state["rearm_pending"])

    def test_long_unobserved_health_gap_does_not_rearm(self):
        self.store.state["rearm_pending"] = True
        self.host.snapshots = [HEALTHY]
        self.run_check()
        self.host.advance(1800)
        self.run_check()
        self.assertTrue(self.store.state["rearm_pending"])

    def test_corrupt_ledger_stops_before_any_network_action(self):
        del self.store.state["attempts"]
        with self.assertRaises(recovery.CheckError):
            self.run_check()
        self.assertEqual(self.host.actions, [])
        self.assertEqual(self.host.probes, 0)

    def test_syntactically_valid_but_inconsistent_ledger_fails_closed(self):
        corruptions = (
            {"missing_since": 900, "missing_last": None, "missing_count": 1},
            {"missing_since": None, "missing_last": None, "missing_count": 2},
            {"missing_since": 900, "missing_last": 800, "missing_count": 2},
            {"healthy_since": 800, "healthy_last": 1100},
            {"healthy_since": None, "healthy_last": 900},
            {"version": True},
            {"last_wall": float("nan")},
            {"rearm_pending": "false"},
        )
        for corruption in corruptions:
            with self.subTest(corruption=corruption):
                self.store.state = recovery.fresh_state(self.host.clock())
                self.store.state.update(corruption)
                with self.assertRaises(recovery.CheckError):
                    self.run_check()
                self.assertEqual(self.host.actions, [])
                self.assertEqual(self.host.probes, 0)

    def test_clock_rollback_cannot_reset_reboot_budget(self):
        self.store.state["last_wall"] = BASE_WALL + 10000
        self.three_missing_checks()
        self.assertEqual(self.host.actions, [])
        self.assertEqual(self.store.state["last_wall"], BASE_WALL + 10000)
        self.assertIn("moved backwards", self.output.getvalue())

    def test_wall_clock_jump_does_not_satisfy_ten_minute_observation(self):
        self.run_check()
        self.host.advance(1, wall_seconds=100000)
        self.run_check()
        self.host.advance(1, wall_seconds=100000)
        self.run_check()
        self.assertEqual(self.host.actions, [])

    def test_future_reboot_ledger_timestamp_fails_closed(self):
        self.store.state["attempts"] = [{"at": BASE_WALL + 10000, "boot_id": BOOT_B}]
        self.three_missing_checks()
        self.assertEqual(self.host.actions, [])
        self.assertIn("future timestamp", self.output.getvalue())

    def test_long_timer_gap_starts_a_new_missing_observation(self):
        self.run_check()
        self.host.advance()
        self.run_check()
        self.host.advance(700)
        self.run_check()
        self.assertEqual(self.store.state["missing_count"], 1)
        self.assertEqual(self.host.actions, [])

    def test_healthy_observation_clears_missing_history(self):
        self.run_check()
        self.host.advance()
        self.run_check()
        self.host.snapshots = [HEALTHY]
        self.host.advance()
        self.run_check()
        self.host.snapshots = [MISSING]
        self.host.advance()
        self.run_check()
        self.assertEqual(self.store.state["missing_count"], 1)
        self.assertEqual(self.host.actions, [])

    def test_disabled_radio_is_enabled_without_turning_it_off(self):
        self.host.snapshots = [recovery.Snapshot(True, True, False, False), HEALTHY]
        self.assertEqual(self.run_check(), 0)
        self.assertEqual(self.host.actions, ["radio_on"])

    def test_hardware_block_never_triggers_radio_action(self):
        self.host.snapshots = [recovery.Snapshot(True, True, False, False, hard_blocked=True)]
        self.run_check()
        self.assertEqual(self.host.actions, [])

    def test_status_is_read_only_for_healthy_missing_and_unknown(self):
        for snapshot, expected_code in ((HEALTHY, 0), (MISSING, 1),
                                        (recovery.CheckError("unknown"), 1)):
            with self.subTest(snapshot=snapshot):
                self.host.snapshots = [snapshot]
                before = copy.deepcopy(self.store.state)
                events_before = len(self.events)
                self.assertEqual(recovery.status(self.host, self.store, CONFIG), expected_code)
                self.assertEqual(self.store.state, before)
                self.assertEqual(len(self.events), events_before)
                self.assertEqual(self.host.actions, [])


class InitializationAndStorageTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.config_path = self.root / "etc" / "recovery.json"
        self.state_path = self.root / "state" / "ledger.json"
        self.lock_path = self.root / "recovery.lock"
        self.patches = mock.patch.multiple(recovery, CONFIG=self.config_path,
                                           STATE=self.state_path, LOCK=self.lock_path)
        self.patches.start()
        self.addCleanup(self.patches.stop)
        self.host = FakeHost(HEALTHY)
        self.capture = contextlib.redirect_stdout(io.StringIO())
        self.capture.__enter__()
        self.addCleanup(self.capture.__exit__, None, None, None)

    def test_initialization_uses_current_profile_without_network_changes(self):
        self.assertEqual(recovery.initialize(self.host, "wlan0"), 0)
        self.assertEqual(json.loads(self.config_path.read_text()), CONFIG)
        self.assertEqual(self.host.actions, [])
        self.assertEqual(self.config_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.state_path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.state_path.parent.stat().st_mode & 0o777, 0o700)

    def test_reinstallation_preserves_existing_reboot_ledger_exactly(self):
        recovery.initialize(self.host, "wlan0")
        state = json.loads(self.state_path.read_text())
        state["attempts"] = [{"at": BASE_WALL - 3000, "boot_id": BOOT_B}]
        state["last_reboot_boot"] = BOOT_B
        state["rearm_pending"] = True
        recovery.atomic_json(self.state_path, state)
        before = self.state_path.read_bytes()
        self.assertEqual(recovery.initialize(self.host, "wlan0"), 0)
        self.assertEqual(self.state_path.read_bytes(), before)

    def test_initialization_requires_working_configured_wifi(self):
        self.host.snapshots = [MISSING]
        with self.assertRaises(recovery.CheckError):
            recovery.initialize(self.host, "wlan0")
        self.assertFalse(self.config_path.exists())
        self.assertFalse(self.state_path.exists())

    def test_changed_connection_is_not_silently_written_over(self):
        recovery.initialize(self.host, "wlan0")
        before = self.config_path.read_bytes()
        self.host.profile = BOOT_C
        with self.assertRaises(recovery.CheckError):
            recovery.initialize(self.host, "wlan0")
        self.assertEqual(self.config_path.read_bytes(), before)

    def test_corrupt_existing_ledger_is_not_reset_on_install(self):
        recovery.initialize(self.host, "wlan0")
        self.state_path.write_text("{not valid json")
        with self.assertRaises(recovery.CheckError):
            recovery.initialize(self.host, "wlan0")
        self.assertEqual(self.state_path.read_text(), "{not valid json")

    def test_partial_configuration_is_preserved_for_review(self):
        recovery.initialize(self.host, "wlan0")
        self.config_path.unlink()
        before = self.state_path.read_bytes()
        with self.assertRaises(recovery.CheckError):
            recovery.initialize(self.host, "wlan0")
        self.assertEqual(self.state_path.read_bytes(), before)
        self.assertFalse(self.config_path.exists())

    def test_status_cli_does_not_create_lock_or_modify_state(self):
        recovery.initialize(self.host, "wlan0")
        before = self.state_path.read_bytes()
        with mock.patch.object(recovery, "Host", return_value=self.host), \
                mock.patch.object(recovery.sys, "argv", ["network-healthcheck", "--status"]):
            self.assertEqual(recovery.main(), 0)
        self.assertFalse(self.lock_path.exists())
        self.assertEqual(self.state_path.read_bytes(), before)

    def test_concurrent_check_exits_without_probing_or_acting(self):
        with self.lock_path.open("w") as locked:
            fcntl.flock(locked, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with mock.patch.object(recovery, "Host") as host_type, \
                    mock.patch.object(recovery.os, "geteuid", return_value=0), \
                    mock.patch.object(recovery.sys, "argv", ["network-healthcheck"]):
                self.assertEqual(recovery.main(), 0)
                host_type.assert_not_called()

    def test_missing_ledger_fails_closed_in_normal_cli(self):
        recovery.initialize(self.host, "wlan0")
        self.state_path.unlink()
        with mock.patch.object(recovery, "Host", return_value=self.host), \
                mock.patch.object(recovery.os, "geteuid", return_value=0), \
                mock.patch.object(recovery.sys, "argv", ["network-healthcheck"]):
            self.assertEqual(recovery.main(), 2)
        self.assertEqual(self.host.actions, [])
        self.assertFalse(self.state_path.exists())


class OSAdapterTests(unittest.TestCase):
    def test_command_timeout_is_unknown_not_device_absence(self):
        with mock.patch.object(recovery.subprocess, "run",
                               side_effect=subprocess.TimeoutExpired(["nmcli"], 8)):
            with self.assertRaises(recovery.CheckError):
                recovery.Host().probe(CONFIG)

    def test_command_failure_never_echoes_raw_output_or_credentials(self):
        failure = subprocess.CompletedProcess(["nmcli"], 8,
                                               "private connection text", "secret password")
        with mock.patch.object(recovery.subprocess, "run", return_value=failure):
            with self.assertRaises(recovery.CheckError) as caught:
                recovery.Host().probe(CONFIG)
        self.assertIn("exit 8", str(caught.exception))
        self.assertNotIn("private", str(caught.exception))
        self.assertNotIn("secret", str(caught.exception))

    def test_empty_or_malformed_nm_inventory_is_unknown(self):
        for devices in ("", "unrecognised", "wlan0:wifi"):
            with self.subTest(devices=devices):
                host = recovery.Host()
                with mock.patch.object(host, "nm", return_value=devices):
                    with self.assertRaises(recovery.CheckError):
                        host.probe(CONFIG)

    def test_reconnect_is_bounded_and_targets_existing_uuid(self):
        host = recovery.Host()
        with mock.patch.object(host, "command", return_value="") as command:
            host.reconnect(CONFIG)
        args, kwargs = command.call_args
        self.assertEqual(args[0], ["nmcli", "--wait", "20", "connection", "up", "uuid",
                                  PROFILE, "ifname", "wlan0"])
        self.assertGreater(args[1], 20)
        self.assertLessEqual(args[1], 30)

    def test_reboot_is_orderly_and_never_forced(self):
        host = recovery.Host()
        with mock.patch.object(host, "command", return_value="") as command:
            host.reboot()
        self.assertEqual(command.call_args.args[0], ["systemctl", "--no-block", "reboot"])

    def test_sysfs_absence_and_successful_nm_absence_are_both_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            net = root / "net"
            net.mkdir()
            (net / "lo").mkdir()
            rfkill = root / "rfkill"
            rfkill.mkdir()
            mapping = {"/sys/class/net": net, "/sys/class/rfkill": rfkill}
            host = recovery.Host()
            with mock.patch.object(recovery, "Path", side_effect=lambda value: mapping[value]), \
                    mock.patch.object(host, "nm", side_effect=[
                        "lo:loopback:connected (externally)", "enabled", "802-11-wireless"]):
                self.assertTrue(host.probe(CONFIG).missing)
            (net / "wlan0").mkdir()
            with mock.patch.object(recovery, "Path", side_effect=lambda value: mapping[value]), \
                    mock.patch.object(host, "nm", side_effect=[
                        "lo:loopback:connected (externally)", "enabled", "802-11-wireless"]):
                self.assertFalse(host.probe(CONFIG).missing)

    def test_invalid_config_cannot_supply_shell_syntax_or_path_traversal(self):
        for interface in ("wlan0;reboot", "../wlan0", "$(reboot)", "", "a" * 16):
            with self.subTest(interface=interface):
                with self.assertRaises(recovery.CheckError):
                    recovery.validate_config({**CONFIG, "interface": interface})


if __name__ == "__main__":
    unittest.main()
