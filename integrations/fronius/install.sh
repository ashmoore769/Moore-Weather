#!/bin/sh
# Install only this collector. Existing services and existing config are retained.
set -eu
umask 077

if [ "$(id -u)" -ne 0 ]; then
    echo "Run this local installer with sudo." >&2
    exit 1
fi
if [ ! -d /run/systemd/system ] || ! command -v systemctl >/dev/null 2>&1; then
    echo "This installer requires a running systemd host." >&2
    exit 1
fi
if [ ! -x /usr/bin/python3 ]; then
    echo "Python 3.11 or newer must already be installed at /usr/bin/python3." >&2
    exit 1
fi
/usr/bin/python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || {
    echo "Python 3.11 or newer is required." >&2
    exit 1
}

solar_source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for solar_file in collector.py collector.env.example moore-solar.service; do
    if [ ! -f "$solar_source_dir/$solar_file" ]; then
        echo "Collector files are incomplete. Run the installer from the checked-out repository." >&2
        exit 1
    fi
done

if ! id moore-solar >/dev/null 2>&1; then
    useradd --system --user-group --home-dir /var/lib/moore-solar \
        --shell /usr/sbin/nologin --no-create-home moore-solar
fi
solar_service_home=$(getent passwd moore-solar | cut -d: -f6)
solar_service_shell=$(getent passwd moore-solar | cut -d: -f7)
if [ "$(id -u moore-solar)" -eq 0 ] || [ "$(id -gn moore-solar)" != moore-solar ] || \
        [ "$solar_service_home" != /var/lib/moore-solar ] || [ "$solar_service_shell" != /usr/sbin/nologin ]; then
    echo "Existing moore-solar account is not suitable; no files were installed." >&2
    exit 1
fi

for solar_destination in /opt/moore-solar /etc/moore-solar /var/lib/moore-solar \
        /etc/moore-solar/collector.env /etc/systemd/system/moore-solar.service; do
    if [ -L "$solar_destination" ]; then
        echo "A collector destination is a symbolic link; inspect it before installing." >&2
        exit 1
    fi
done

install -d -o root -g root -m 0755 /opt/moore-solar
install -d -o root -g root -m 0700 /etc/moore-solar
install -d -o moore-solar -g moore-solar -m 0700 /var/lib/moore-solar
install -o root -g root -m 0755 "$solar_source_dir/collector.py" /opt/moore-solar/collector.py
install -o root -g root -m 0644 "$solar_source_dir/moore-solar.service" /etc/systemd/system/moore-solar.service
if [ ! -e /etc/moore-solar/collector.env ]; then
    install -o root -g root -m 0600 "$solar_source_dir/collector.env.example" /etc/moore-solar/collector.env
fi
chown root:root /etc/moore-solar/collector.env
chmod 0600 /etc/moore-solar/collector.env
systemctl daemon-reload

cat <<'TEXT'
Installed the collector files. No services were started or restarted.

After the local read-only check succeeds and the server endpoint is ready:
  sudoedit /etc/moore-solar/collector.env
  sudo systemctl enable --now moore-solar.service
  systemctl is-active moore-solar.service
  journalctl -u moore-solar.service --since '10 minutes ago' --no-pager

When updating an already running collector, restart only moore-solar.service
after reviewing the new version. Existing configuration was not overwritten.
TEXT
