"""Exercise installer transactions in a disposable filesystem, never host /etc.

Only its absolute installation paths, root identity and PATH are substituted.
Bash, file copying, permissions, atomic moves, traps and rollback run normally.
NetworkManager/systemd and the already separately tested Python check are fakes.
"""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest


SOURCE = Path(__file__).resolve().parent

FAKE_SYSTEMCTL = r'''
import json, os, sys
from pathlib import Path
root = Path(os.environ["MOORE_TEST_ROOT"])
control_file = root / "control.json"
control = json.loads(control_file.read_text())
args = sys.argv[1:]
with (root / "events.jsonl").open("a") as stream:
    stream.write(json.dumps(["systemctl", *args]) + "\n")
units = [arg for arg in args[1:] if arg.endswith((".service", ".timer"))]
action = args[0]
def finish(code=0):
    control_file.write_text(json.dumps(control))
    raise SystemExit(code)
if action == "show":
    prop = next((arg.split("=", 1)[1] for arg in args if arg.startswith("--property=")), "")
    if prop == "Version":
        print("258")
    elif prop in ("LoadState", "FragmentPath", "DropInPaths"):
        path = root / "etc/systemd/system" / units[0]
        if prop == "LoadState": print("loaded" if path.exists() else "not-found")
        if prop == "FragmentPath": print(path if path.exists() else "")
        if prop == "DropInPaths": print("/unexpected/override.conf" if control.get("override") else "")
    else:
        for unit in units: print("Id=" + unit + "\nActiveState=active")
elif action == "is-enabled":
    print(control["enabled"])
    finish(0 if control["enabled"] == "enabled" else 1)
elif action == "is-active":
    active = units[0] == "NetworkManager.service" or control["active"]
    if "--quiet" not in args: print("active" if active else "inactive")
    finish(0 if active else 3)
elif action == "stop":
    if "network-healthcheck.timer" in units: control["active"] = False
elif action == "start":
    if "network-healthcheck.service" in units and control.get("start_fail"):
        if control.get("advance_budget"):
            (root / "var/lib/moore-pi-network/state.json").write_text(
                '{"attempts":["advanced-during-service-start"]}\n')
        finish(1)
    if "network-healthcheck.timer" in units: control["active"] = True
elif action == "enable":
    control["enabled"] = "enabled"
    if "--now" in args: control["active"] = True
elif action == "disable":
    control["enabled"] = "disabled"
elif action != "daemon-reload":
    raise SystemExit("Unexpected fake systemctl command: " + repr(args))
finish()
'''

FAKE_CORE = r'''
import json, os, sys
from pathlib import Path
root = Path(os.environ["MOORE_TEST_ROOT"])
control = json.loads((root / "control.json").read_text())
action = "initialize" if "--initialize" in sys.argv else "status"
with (root / "events.jsonl").open("a") as stream:
    stream.write(json.dumps(["core", action]) + "\n")
if control.get(action + "_fail"):
    print("Simulated " + action + " rejection")
    raise SystemExit(2 if action == "initialize" else 1)
print("Healthy fixture; existing configuration and budget preserved")
'''


class InstallerTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="moore-pi-install-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.source = self.root / "source"
        self.bin = self.root / "fake-bin"
        self.source.mkdir()
        self.bin.mkdir()
        for directory in ("run", "usr/local/sbin", "etc/systemd/system", "etc/moore-pi",
                          "var/lib/moore-pi-network", "var/backups/moore-pi-network"):
            (self.root / directory).mkdir(parents=True, mode=0o700)

        installer = (SOURCE / "install.sh").read_text()
        installer = installer.replace("if (( EUID != 0 )); then", "if false; then")
        installer = re.sub(r"^export PATH=.*$", "export PATH='" + str(self.bin) + ":" + os.defpath + "'",
                           installer, flags=re.MULTILINE)
        for path in ("/usr/local/sbin", "/etc/systemd/system", "/etc/moore-pi",
                     "/var/lib/moore-pi-network", "/var/backups/moore-pi-network", "/run"):
            installer = installer.replace(path, str(self.root) + path)
        (self.source / "install.sh").write_text(installer)
        for unit in ("network-healthcheck.service", "network-healthcheck.timer"):
            shutil.copyfile(SOURCE / unit, self.source / unit)
        self.write_python(self.source / "network_healthcheck.py", FAKE_CORE)
        self.write_python(self.bin / "systemctl", FAKE_SYSTEMCTL)
        self.write_python(self.bin / "nmcli", "raise SystemExit(0)\n")
        self.write_python(self.bin / "python3", "import os, sys\nos.execv(" + repr(sys.executable)
                          + ", [" + repr(sys.executable) + ", *sys.argv[1:]])\n")
        self.write_python(self.bin / "stat", '''
            import os, stat, sys
            value = sys.argv[sys.argv.index("-c") + 1]
            if value == "%u": print("0")
            elif value == "%a": print(format(stat.S_IMODE(os.stat(sys.argv[-1]).st_mode), "o"))
            else: raise SystemExit("Unexpected stat request")
        ''')
        # The sandbox may run as an ordinary CI user. Preserve real install/copy
        # behavior while omitting only the privileged ownership request.
        self.write_python(self.bin / "install", """
            import os, sys
            args = sys.argv[1:]
            for flag in ("-o", "-g"):
                if flag in args:
                    index = args.index(flag)
                    del args[index:index + 2]
            os.execv(REAL_INSTALL, [REAL_INSTALL, *args])
        """.replace("REAL_INSTALL", repr(shutil.which("install"))))

        self.old = {
            "usr/local/sbin/network-healthcheck": b"#!/bin/bash\n# old network check\n",
            "etc/systemd/system/network-healthcheck.service": b"[Service]\nType=oneshot\n",
            "etc/systemd/system/network-healthcheck.timer": b"[Timer]\nOnBootSec=2min\n",
            "etc/moore-pi/network-healthcheck.json": b'{"existing":"configuration"}\n',
            "var/lib/moore-pi-network/state.json": b'{"attempts":["preserve-this-budget"]}\n',
        }
        for path, contents in self.old.items():
            target = self.root / path
            target.write_bytes(contents)
            target.chmod(0o600)
        (self.root / "usr/local/sbin/network-healthcheck").chmod(0o755)
        self.configure()

    def write_python(self, path, source):
        path.write_text("#!" + sys.executable + "\n" + textwrap.dedent(source).lstrip())
        path.chmod(0o755)

    def configure(self, **overrides):
        control = {"enabled": "enabled", "active": True, **overrides}
        (self.root / "control.json").write_text(json.dumps(control))

    def run_installer(self):
        return subprocess.run(["bash", str(self.source / "install.sh"), "--interface", "wlan0"],
                              env={**os.environ, "MOORE_TEST_ROOT": str(self.root)},
                              text=True, capture_output=True, timeout=20)

    def events(self):
        path = self.root / "events.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def assert_original_files(self, skip=()):
        for path, contents in self.old.items():
            if path not in skip:
                self.assertEqual((self.root / path).read_bytes(), contents, path)

    def assert_timer_restored(self):
        control = json.loads((self.root / "control.json").read_text())
        self.assertEqual(control["enabled"], "enabled")
        self.assertTrue(control["active"])

    def test_healthy_install_preserves_budget_and_checks_before_arming(self):
        result = self.run_installer()
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual((self.root / "usr/local/sbin/network-healthcheck").read_bytes(),
                         (self.source / "network_healthcheck.py").read_bytes())
        for unit in ("network-healthcheck.service", "network-healthcheck.timer"):
            self.assertEqual((self.root / "etc/systemd/system" / unit).read_bytes(),
                             (SOURCE / unit).read_bytes())
        for path in ("etc/moore-pi/network-healthcheck.json", "var/lib/moore-pi-network/state.json"):
            self.assertEqual((self.root / path).read_bytes(), self.old[path])
        events = self.events()
        self.assertLess(events.index(["core", "status"]),
                        events.index(["systemctl", "enable", "--now", "network-healthcheck.timer"]))
        self.assertFalse(any(event[:2] == ["systemctl", "restart"] for event in events))
        backup = list((self.root / "var/backups/moore-pi-network").glob("install-*"))
        self.assertEqual(len(backup), 1)
        self.assertEqual((backup[0] / "network-healthcheck").read_bytes(),
                         self.old["usr/local/sbin/network-healthcheck"])
        self.assert_timer_restored()

    def test_unhealthy_preflight_preserves_old_install_and_running_timer(self):
        self.configure(initialize_fail=True)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assert_original_files()
        self.assertFalse(any(event[:2] == ["systemctl", "stop"] for event in self.events()))
        self.assert_timer_restored()

    def test_unhealthy_installed_status_rolls_back_files_and_timer(self):
        self.configure(status_fail=True)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("restoring the previous network check files", result.stderr)
        self.assert_original_files()
        self.assert_timer_restored()

    def test_service_start_failure_rolls_back_without_rewinding_ledger(self):
        self.configure(start_fail=True, advance_budget=True)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        ledger = "var/lib/moore-pi-network/state.json"
        self.assert_original_files(skip=(ledger,))
        self.assertEqual((self.root / ledger).read_bytes(),
                         b'{"attempts":["advanced-during-service-start"]}\n')
        backup = next((self.root / "var/backups/moore-pi-network").glob("install-*"))
        self.assertEqual((backup / "state.json").read_bytes(), self.old[ledger])
        self.assert_timer_restored()

    def test_unknown_drop_in_is_rejected_before_network_or_file_changes(self):
        self.configure(override=True)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("overrides require review", result.stderr)
        self.assert_original_files()
        self.assertNotIn(["core", "initialize"], self.events())
        self.assert_timer_restored()

    def test_group_writable_state_is_rejected_and_permissions_preserved(self):
        state = self.root / "var/lib/moore-pi-network/state.json"
        state.chmod(0o660)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Group/world-writable file requires review", result.stderr)
        self.assertEqual(state.stat().st_mode & 0o777, 0o660)
        self.assert_original_files()
        self.assertNotIn(["core", "initialize"], self.events())
        self.assertFalse(any(event[:2] == ["systemctl", "stop"] for event in self.events()))

    def test_world_writable_state_directory_is_rejected_without_chmod(self):
        directory = self.root / "var/lib/moore-pi-network"
        directory.chmod(0o707)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Group/world-writable directory requires review", result.stderr)
        self.assertEqual(directory.stat().st_mode & 0o777, 0o707)
        self.assert_original_files()
        self.assertNotIn(["core", "initialize"], self.events())

    def test_rollback_keeps_a_previously_disabled_timer_disabled(self):
        self.configure(enabled="disabled", active=False, status_fail=True)
        result = self.run_installer()
        self.assertNotEqual(result.returncode, 0)
        self.assert_original_files()
        control = json.loads((self.root / "control.json").read_text())
        self.assertEqual(control["enabled"], "disabled")
        self.assertFalse(control["active"])


if __name__ == "__main__":
    unittest.main()
