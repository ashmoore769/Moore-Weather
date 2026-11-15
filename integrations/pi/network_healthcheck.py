#!/usr/bin/python3 -I
"""Bounded recovery for a vanished Wi-Fi adapter, not an internet watchdog.

No HTTP requests, credentials, driver unloading, forced resets, or radio-off
commands. Run by a five-minute systemd timer. --status is strictly read-only.
"""

import argparse
from dataclasses import dataclass
import fcntl
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
import uuid


CONFIG = Path("/etc/moore-pi/network-healthcheck.json")
STATE = Path("/var/lib/moore-pi-network/state.json")
LOCK = Path("/run/moore-pi-network.lock")
BOOT_GRACE = 600
MISSING_SECONDS = 600
MISSING_CHECKS = 3
MAX_CHECK_GAP = 420
HEALTHY_REARM_SECONDS = 1800
REBOOT_COOLDOWN = 21600
REBOOT_WINDOW = 86400
MAX_REBOOTS = 2


class CheckError(Exception):
    pass


def log(message):
    print(message, flush=True)


def valid_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def validate_config(config):
    if (not isinstance(config, dict) or type(config.get("version")) is not int
            or config["version"] != 1
            or not isinstance(config.get("interface"), str)
            or not re.fullmatch(r"[a-zA-Z0-9_.-]{1,15}", config["interface"])
            or not valid_uuid(config.get("connection_uuid"))):
        raise CheckError("Invalid recovery configuration; no recovery action taken")
    return config


@dataclass(frozen=True)
class Clock:
    boot_id: str
    uptime: float
    wall: float


@dataclass(frozen=True)
class Snapshot:
    interface_present: bool
    nm_present: bool
    connected: bool
    radio_enabled: bool
    hard_blocked: bool = False
    other_wireless: bool = False
    wired_connected: bool = False
    other_profile_connected: bool = False

    @property
    def healthy(self):
        return (self.interface_present and self.nm_present and self.connected
                and self.radio_enabled and not self.hard_blocked)

    @property
    def missing(self):
        return (not self.interface_present and not self.nm_present
                and self.radio_enabled and not self.hard_blocked
                and not self.other_wireless and not self.wired_connected
                and not self.other_profile_connected)


class Host:
    """Small OS adapter so tests can exercise recovery without real actions."""

    def command(self, args, timeout=8):
        try:
            result = subprocess.run(args, capture_output=True, text=True,
                                    timeout=timeout, check=False,
                                    env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin",
                                         "LC_ALL": "C", "LANG": "C"})
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise CheckError(f"{args[0]} unavailable or timed out") from exc
        if result.returncode:
            # Do not echo NetworkManager output, connection names or secrets.
            raise CheckError(f"{args[0]} failed (exit {result.returncode})")
        return result.stdout.strip()

    def nm(self, *args, wait=5):
        return self.command(["nmcli", "--wait", str(wait), *args], wait + 3)

    def clock(self):
        try:
            boot = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
            uptime = float(Path("/proc/uptime").read_text().split()[0])
            wall = time.time()
        except (OSError, ValueError, IndexError) as exc:
            raise CheckError("Cannot read boot clock") from exc
        if not valid_uuid(boot) or not number(uptime) or not number(wall):
            raise CheckError("Invalid boot clock")
        return Clock(boot, uptime, wall)

    def active_uuid(self, interface):
        value = self.nm("-g", "GENERAL.CON-UUID", "device", "show", interface)
        if not valid_uuid(value):
            raise CheckError("Target Wi-Fi has no active connection UUID")
        return value

    def probe(self, config):
        interface = config["interface"]
        # Failed enumeration is UNKNOWN, never evidence that hardware vanished.
        devices = self.nm("-t", "-f", "DEVICE,TYPE,STATE", "device", "status")
        records = [line.split(":", 2) for line in devices.splitlines()]
        if (not records or any(len(record) != 3 or not all(record) for record in records)
                or len({record[0] for record in records}) != len(records)):
            raise CheckError("Cannot interpret NetworkManager device inventory")
        radio = self.nm("-t", "-f", "WIFI", "general")
        if radio not in ("enabled", "disabled"):
            raise CheckError("Cannot interpret Wi-Fi radio state")
        profile_type = self.nm("-g", "connection.type", "connection", "show",
                               "uuid", config["connection_uuid"])
        if profile_type != "802-11-wireless":
            raise CheckError("Configured Wi-Fi profile is unavailable or incompatible")
        try:
            interfaces = list(Path("/sys/class/net").iterdir())
            present = interface in {entry.name for entry in interfaces}
            wireless = {entry.name for entry in interfaces
                        if (entry / "wireless").exists() or (entry / "phy80211").exists()}
            hard_blocked = False
            rfkill = Path("/sys/class/rfkill")
            if rfkill.exists():
                for entry in rfkill.iterdir():
                    if (entry / "type").read_text().strip() == "wlan":
                        hard = (entry / "hard").read_text().strip()
                        if hard not in ("0", "1"):
                            raise CheckError("Cannot interpret Wi-Fi hardware block state")
                        hard_blocked |= hard == "1"
        except OSError as exc:
            raise CheckError("Cannot inspect Wi-Fi device state in sysfs") from exc
        target = [record for record in records if record[0] == interface]
        if len(target) > 1 or (target and target[0][1] != "wifi"):
            raise CheckError("Configured interface does not match a Wi-Fi device")
        connected = bool(target and target[0][2].startswith("connected"))
        other_profile = False
        if connected:
            other_profile = self.active_uuid(interface) != config["connection_uuid"]
            connected = not other_profile
        wireless.update(record[0] for record in records if record[1] == "wifi")
        return Snapshot(present, bool(target), connected, radio == "enabled",
                        hard_blocked, bool(wireless - {interface}),
                        any(kind == "ethernet" and state.startswith("connected")
                            for _, kind, state in records), other_profile)

    def enable_radio(self):
        self.nm("radio", "wifi", "on", wait=10)

    def reconnect(self, config):
        self.nm("connection", "up", "uuid", config["connection_uuid"],
                "ifname", config["interface"], wait=20)

    def reboot(self):
        # No --force: systemd stops services and unmounts filesystems normally.
        self.command(["systemctl", "--no-block", "reboot"], timeout=10)


def fresh_state(clock):
    return {"version": 1, "boot_id": clock.boot_id, "last_uptime": clock.uptime,
            "last_wall": clock.wall, "missing_since": None, "missing_last": None,
            "missing_count": 0, "healthy_since": None, "healthy_last": None,
            "attempts": [], "last_reboot_boot": None, "rearm_pending": False}


def validate_state(state):
    if (not isinstance(state, dict) or type(state.get("version")) is not int
            or state["version"] != 1):
        raise CheckError("Invalid recovery ledger; automatic recovery is disabled")
    if not valid_uuid(state.get("boot_id")):
        raise CheckError("Invalid boot in recovery ledger")
    for key in ("last_uptime", "last_wall"):
        if not number(state.get(key)):
            raise CheckError("Invalid clock in recovery ledger")
    for key in ("missing_since", "missing_last", "healthy_since", "healthy_last"):
        if key not in state or (state[key] is not None and not number(state[key])):
            raise CheckError("Invalid observation in recovery ledger")
    if (type(state.get("missing_count")) is not int or state["missing_count"] < 0
            or type(state.get("rearm_pending")) is not bool
            or "last_reboot_boot" not in state
            or (state["last_reboot_boot"] is not None
                and not valid_uuid(state["last_reboot_boot"]))):
        raise CheckError("Invalid recovery limits in ledger")
    for prefix in ("missing", "healthy"):
        since, last = state[f"{prefix}_since"], state[f"{prefix}_last"]
        if ((since is None) != (last is None)
                or (since is not None and not since <= last <= state["last_uptime"])):
            raise CheckError("Inconsistent observation times in recovery ledger")
    if (state["missing_since"] is None) != (state["missing_count"] == 0):
        raise CheckError("Inconsistent missing-device count in recovery ledger")
    attempts = state.get("attempts")
    if not isinstance(attempts, list) or len(attempts) > 8:
        raise CheckError("Invalid recovery attempts in ledger")
    for attempt in attempts:
        if (not isinstance(attempt, dict) or not number(attempt.get("at"))
                or not valid_uuid(attempt.get("boot_id"))):
            raise CheckError("Invalid recovery attempt in ledger")
    return state


def read_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise CheckError(f"Cannot read {path.name}; existing state was not reset") from exc


def atomic_json(path, value):
    """Save before a reboot, including fsync on the containing directory."""
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(value, stream, sort_keys=True)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Store:
    def load(self):
        return validate_state(read_json(STATE))

    def save(self, state):
        atomic_json(STATE, validate_state(state))


def clear_missing(state):
    state.update(missing_since=None, missing_last=None, missing_count=0)


def clear_healthy(state):
    state.update(healthy_since=None, healthy_last=None)


def observe_healthy(state, clock):
    state["last_uptime"] = max(state["last_uptime"], clock.uptime)
    state["last_wall"] = max(state["last_wall"], clock.wall)
    clear_missing(state)
    previous = state["healthy_last"]
    if previous is None or not 0 <= clock.uptime - previous <= MAX_CHECK_GAP:
        state["healthy_since"] = clock.uptime
    state["healthy_last"] = clock.uptime
    if clock.uptime - state["healthy_since"] >= HEALTHY_REARM_SECONDS:
        state["rearm_pending"] = False


def reboot_block(state, clock):
    if clock.wall < 1704067200 or clock.wall < state["last_wall"] - 5:
        return "wall clock is unset or moved backwards"
    if any(attempt["at"] > clock.wall + 5 for attempt in state["attempts"]):
        return "reboot ledger contains a future timestamp"
    if state["last_reboot_boot"] == clock.boot_id:
        return "a reboot was already requested during this boot"
    if state["rearm_pending"]:
        return "waiting for 30 minutes of healthy Wi-Fi after the previous reboot request"
    if any(clock.wall - attempt["at"] < REBOOT_COOLDOWN for attempt in state["attempts"]):
        return "six-hour reboot cooldown is active"
    if sum(clock.wall - attempt["at"] < REBOOT_WINDOW for attempt in state["attempts"]) >= MAX_REBOOTS:
        return "two-reboot daily limit is reached"
    return None


def check_once(host, store, config):
    state = validate_state(store.load())  # Reinstall never resets an invalid ledger.
    clock = host.clock()
    if state["boot_id"] != clock.boot_id or clock.uptime < state["last_uptime"]:
        clear_missing(state)
        clear_healthy(state)
        state["boot_id"] = clock.boot_id
    state["last_uptime"] = clock.uptime
    # Preserve a high-water mark so a clock rollback cannot replenish the budget.
    state["last_wall"] = max(state["last_wall"], clock.wall)
    try:
        snapshot = host.probe(config)
        if not snapshot.radio_enabled and not snapshot.hard_blocked:
            log("Wi-Fi radio is disabled; requesting radio on")
            host.enable_radio()
            snapshot = host.probe(config)
        if snapshot.healthy:
            observe_healthy(state, clock)
            store.save(state)
            log("Wi-Fi healthy; no recovery action needed")
            return 0
        clear_healthy(state)
        if snapshot.other_profile_connected:
            clear_missing(state)
            store.save(state)
            log("Wi-Fi is connected to a different profile; preserving that connection; review recovery configuration")
            return 1
        if snapshot.interface_present and snapshot.nm_present and not snapshot.hard_blocked:
            clear_missing(state)
            store.save(state)
            log("Wi-Fi device is present; requesting its existing connection")
            try:
                host.reconnect(config)
            except CheckError as exc:
                log(f"Reconnect did not complete: {exc}; no reboot")
            snapshot = host.probe(config)
            if snapshot.healthy:
                observe_healthy(state, host.clock())
                store.save(state)
                log("Wi-Fi connection restored")
                return 0
            # A reconnect failure never starts a missing-device streak in this run.
            log("Wi-Fi connection is unavailable; waiting for the next check; no reboot")
            return 1
        if not snapshot.missing:
            clear_missing(state)
            store.save(state)
            log("Wi-Fi is blocked, another adapter is available, or device views disagree; no reboot")
            return 1
        if clock.uptime < BOOT_GRACE:
            clear_missing(state)
            store.save(state)
            log("Wi-Fi device is missing; ten-minute boot grace is active")
            return 1
        previous = state["missing_last"]
        if previous is None or not 0 <= clock.uptime - previous <= MAX_CHECK_GAP:
            state["missing_since"] = clock.uptime
            state["missing_count"] = 0
        state["missing_last"] = clock.uptime
        state["missing_count"] += 1
        elapsed = clock.uptime - state["missing_since"]
        store.save(state)
        if state["missing_count"] < MISSING_CHECKS or elapsed < MISSING_SECONDS:
            log(f"Wi-Fi device missing: {state['missing_count']} checks over {int(elapsed)} seconds; waiting")
            return 1
        block = reboot_block(state, clock)
        if block:
            log(f"Wi-Fi device remains missing; reboot suppressed: {block}")
            return 1
        # Probe again immediately before the only disruptive action.
        snapshot = host.probe(config)
        if not snapshot.missing:
            clear_missing(state)
            if snapshot.healthy:
                observe_healthy(state, host.clock())
            store.save(state)
            log("Wi-Fi state changed before escalation; reboot cancelled")
            return 0 if snapshot.healthy else 1
        state["attempts"] = (state["attempts"] + [{"at": clock.wall, "boot_id": clock.boot_id}])[-8:]
        state["last_reboot_boot"] = clock.boot_id
        state["rearm_pending"] = True
        store.save(state)  # If persistence fails, do not issue the reboot.
        log("Wi-Fi hardware remained missing for at least ten minutes; requesting one orderly reboot")
        host.reboot()
        return 0
    except CheckError as exc:
        clear_missing(state)
        clear_healthy(state)
        store.save(state)
        log(f"Network state/action unavailable: {exc}; no further recovery action")
        return 1


def status(host, store, config):
    state = store.load()
    clock = host.clock()
    try:
        snapshot = host.probe(config)
    except CheckError as exc:
        print(json.dumps({"healthy": False, "error": str(exc), "actions": "none"}, indent=2))
        return 1
    print(json.dumps({"healthy": snapshot.healthy, "interface": config["interface"],
                      "interfacePresent": snapshot.interface_present,
                      "networkManagerSeesDevice": snapshot.nm_present,
                      "connectedToConfiguredProfile": snapshot.connected,
                      "automaticRebootBlockedBy": reboot_block(state, clock),
                      "rebootRequestsInLast24Hours": sum(
                          0 <= clock.wall - attempt["at"] < REBOOT_WINDOW
                          for attempt in state["attempts"]),
                      "actions": "none (read-only status)"}, indent=2))
    return 0 if snapshot.healthy else 1


def initialize(host, interface):
    if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,15}", interface):
        raise CheckError("Invalid interface")
    proposed = {"version": 1, "interface": interface,
                "connection_uuid": host.active_uuid(interface)}
    proposed = validate_config(proposed)
    if not host.probe(proposed).healthy:
        raise CheckError("Installation requires healthy Wi-Fi on the target interface")
    if CONFIG.exists() or STATE.exists():
        if not (CONFIG.exists() and STATE.exists()):
            raise CheckError("Incomplete existing configuration/ledger; inspect before changing it")
        current = validate_config(read_json(CONFIG))
        validate_state(read_json(STATE))
        if current != proposed:
            raise CheckError("Existing recovery profile differs; configuration was preserved")
        log("Existing recovery configuration and reboot ledger verified and preserved")
        return 0
    CONFIG.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    STATE.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(CONFIG.parent, 0o700)
    os.chmod(STATE.parent, 0o700)
    atomic_json(STATE, fresh_state(host.clock()))
    atomic_json(CONFIG, proposed)
    log("Recovery configuration initialized from the current Wi-Fi connection; no network changes")
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--status", action="store_true", help="read-only status; 0 means healthy")
    group.add_argument("--initialize", action="store_true", help="initialize while connected; preserve existing ledger")
    parser.add_argument("--interface", default="wlan0", help="interface for initial setup only")
    args = parser.parse_args()
    try:
        if args.status:
            return status(Host(), Store(), validate_config(read_json(CONFIG)))
        if os.geteuid() != 0:
            raise CheckError("Run as root; --status never changes the system")
        with LOCK.open("a", encoding="ascii") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                log("Another recovery check is running; no action")
                return 0
            if args.initialize:
                return initialize(Host(), args.interface)
            return check_once(Host(), Store(), validate_config(read_json(CONFIG)))
    except (CheckError, OSError) as exc:
        log(f"Recovery stopped safely: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
