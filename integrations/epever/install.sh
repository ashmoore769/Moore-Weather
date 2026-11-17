#!/bin/sh
# Install Yard Power independently; never alter the Fronius or No-IP services.
set -eu
umask 077
if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi
if [ ! -d /run/systemd/system ] || [ ! -x /usr/bin/python3 ]; then
  echo "This installer requires systemd and /usr/bin/python3." >&2
  exit 1
fi
/usr/bin/python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)'
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for name in collector.py collector.env.example moore-yard-power.service; do
  test -f "$source_dir/$name" || { echo "Missing $name" >&2; exit 1; }
done
if ! id moore-yard-power >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/moore-yard-power \
    --shell /usr/sbin/nologin --no-create-home moore-yard-power
fi
if [ "$(id -u moore-yard-power)" -eq 0 ]; then
  echo "Invalid collector user." >&2
  exit 1
fi
for destination in /opt/moore-yard-power /etc/moore-yard-power /var/lib/moore-yard-power \
  /etc/moore-yard-power/collector.env /etc/systemd/system/moore-yard-power.service; do
  if [ -L "$destination" ]; then echo "Unexpected symlink: $destination" >&2; exit 1; fi
done
install -d -o root -g root -m 0755 /opt/moore-yard-power
install -d -o root -g root -m 0700 /etc/moore-yard-power
install -d -o moore-yard-power -g moore-yard-power -m 0700 /var/lib/moore-yard-power
install -o root -g root -m 0755 "$source_dir/collector.py" /opt/moore-yard-power/collector.py
install -o root -g root -m 0644 "$source_dir/moore-yard-power.service" /etc/systemd/system/moore-yard-power.service
if [ ! -e /etc/moore-yard-power/collector.env ]; then
  install -o root -g root -m 0600 "$source_dir/collector.env.example" /etc/moore-yard-power/collector.env
fi
chown root:root /etc/moore-yard-power/collector.env
chmod 0600 /etc/moore-yard-power/collector.env
systemctl daemon-reload
echo "Yard Power collector installed but not started. Configure its environment before enabling it."
