#!/bin/bash
# Install the bounded network recovery check on the Pi itself.
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/sbin:/usr/local/bin

die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }

if (( EUID != 0 )); then
    die 'Run this installer with sudo on the Raspberry Pi.'
fi

interface=wlan0
if (( $# )); then
    [[ $# == 2 && $1 == --interface ]] || die 'Usage: sudo bash install.sh [--interface wlan0]'
    interface=$2
fi
[[ $interface =~ ^[[:alnum:]_.-]{1,15}$ ]] || die 'Invalid interface name.'

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
for source_name in network_healthcheck.py network-healthcheck.service network-healthcheck.timer; do
    [[ -f "$source_dir/$source_name" && ! -L "$source_dir/$source_name" ]] || die "Missing regular source file: $source_name"
done
for command_name in python3 systemctl nmcli install mktemp cp mv flock date stat; do
    command -v "$command_name" >/dev/null || die "Required command not found: $command_name"
done
python3 -I -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || die 'Python 3.11 or newer is required.'
python3 -I -c 'import pathlib, sys; p = pathlib.Path(sys.argv[1]); compile(p.read_bytes(), str(p), "exec")' "$source_dir/network_healthcheck.py"
systemctl show --property=Version --value >/dev/null || die 'A running systemd manager is required.'
systemctl is-active --quiet NetworkManager.service || die 'NetworkManager is not active; restore connectivity before installing.'

exec 9>/run/moore-pi-network-install.lock
flock -n 9 || die 'Another network recovery installation is already running.'

script_target=/usr/local/sbin/network-healthcheck
service_target=/etc/systemd/system/network-healthcheck.service
timer_target=/etc/systemd/system/network-healthcheck.timer
config_target=/etc/moore-pi/network-healthcheck.json
state_target=/var/lib/moore-pi-network/state.json
targets=("$script_target" "$service_target" "$timer_target")
backup_names=(network-healthcheck network-healthcheck.service network-healthcheck.timer)
present=(0 0 0)
temporary_files=()
rollback_needed=0
backup_dir=
timer_was_enabled=not-found
timer_was_active=inactive

for target in "${targets[@]}" "$config_target" "$state_target"; do
    if [[ -e "$target" || -L "$target" ]]; then
        [[ -f "$target" && ! -L "$target" ]] || die "Expected a regular file: $target"
        [[ $(stat -c '%u' -- "$target") == 0 ]] || die "Expected root ownership: $target"
        permissions=$(stat -c '%a' -- "$target")
        (( (8#$permissions & 0022) == 0 )) || die "Group/world-writable file requires review: $target"
    fi
done
for target_dir in /usr/local/sbin /etc/systemd/system /etc/moore-pi /var/lib/moore-pi-network /var/backups/moore-pi-network; do
    if [[ -e "$target_dir" || -L "$target_dir" ]]; then
        [[ -d "$target_dir" && ! -L "$target_dir" ]] || die "Expected a real directory: $target_dir"
        [[ $(stat -c '%u' -- "$target_dir") == 0 ]] || die "Expected root ownership: $target_dir"
        permissions=$(stat -c '%a' -- "$target_dir")
        (( (8#$permissions & 0022) == 0 )) || die "Group/world-writable directory requires review: $target_dir"
    fi
done

# A drop-in, mask, runtime unit or alternate fragment could defeat the limits.
# Leave such customisation for explicit review instead of silently replacing it.
for unit in network-healthcheck.service network-healthcheck.timer; do
    load_state=$(systemctl show "$unit" --property=LoadState --value)
    [[ $load_state == loaded || $load_state == not-found ]] || die "Unexpected unit state for $unit: $load_state"
    drop_ins=$(systemctl show "$unit" --property=DropInPaths --value)
    [[ -z $drop_ins ]] || die "Existing systemd overrides require review: $unit"
    fragment=$(systemctl show "$unit" --property=FragmentPath --value)
    [[ -z $fragment || $fragment == "/etc/systemd/system/$unit" ]] || die "Unexpected unit location for $unit: $fragment"
done
timer_was_enabled=$(systemctl is-enabled network-healthcheck.timer 2>/dev/null || true)
case "$timer_was_enabled" in
    enabled|disabled|not-found|'') ;;
    *) die "Unexpected timer enablement requires review: $timer_was_enabled" ;;
esac
timer_was_active=$(systemctl is-active network-healthcheck.timer 2>/dev/null || true)
case "$timer_was_active" in
    active|inactive|failed|unknown) ;;
    *) die "Timer is changing state; retry once it is settled: $timer_was_active" ;;
esac

cleanup() {
    local temporary
    for temporary in "${temporary_files[@]}"; do
        rm -f -- "$temporary"
    done
}

atomic_install() {
    local source_file=$1 destination=$2 mode=$3 temporary
    temporary=$(mktemp "${destination}.moore-install.XXXXXX")
    temporary_files+=("$temporary")
    install -o root -g root -m "$mode" -- "$source_file" "$temporary"
    mv -fT -- "$temporary" "$destination"
}

rollback() {
    local index temporary restore_failed=0
    printf 'Installation failed; restoring the previous network check files.\n' >&2
    systemctl stop network-healthcheck.timer network-healthcheck.service >/dev/null 2>&1 || true
    # Configuration and the reboot budget are deliberately never rolled back.
    # Rewinding the budget could grant extra reboot attempts.
    for index in 0 1 2; do
        if [[ ${present[$index]} == 1 ]]; then
            temporary=$(mktemp "${targets[$index]}.moore-restore.XXXXXX") || { restore_failed=1; continue; }
            temporary_files+=("$temporary")
            if ! cp -a -- "$backup_dir/${backup_names[$index]}" "$temporary" ||
               ! mv -fT -- "$temporary" "${targets[$index]}"; then
                restore_failed=1
            fi
        else
            rm -f -- "${targets[$index]}" || restore_failed=1
        fi
    done
    systemctl daemon-reload || restore_failed=1
    if (( restore_failed )); then
        systemctl disable network-healthcheck.timer >/dev/null 2>&1 || true
        printf 'Automatic restoration was incomplete; the recovery timer remains stopped.\n' >&2
    elif [[ $timer_was_enabled == enabled ]]; then
        systemctl enable network-healthcheck.timer >/dev/null 2>&1 || true
    else
        systemctl disable network-healthcheck.timer >/dev/null 2>&1 || true
    fi
    if (( ! restore_failed )) && [[ $timer_was_active == active ]]; then
        systemctl start network-healthcheck.timer || true
    fi
    printf 'Backup retained at %s\n' "$backup_dir" >&2
    printf 'Check network-healthcheck.timer before closing this SSH session.\n' >&2
}

failed() {
    local exit_code=$? line=$1
    trap - ERR
    set +e
    if (( rollback_needed )); then
        rollback
    fi
    printf 'Network recovery installation stopped at line %s (status %s).\n' "$line" "$exit_code" >&2
    exit "$exit_code"
}
interrupted() {
    local exit_code=$1
    trap - ERR HUP INT TERM
    set +e
    if (( rollback_needed )); then
        rollback
    fi
    printf 'Network recovery installation interrupted.\n' >&2
    exit "$exit_code"
}
trap cleanup EXIT
trap 'failed "$LINENO"' ERR
trap 'interrupted 129' HUP
trap 'interrupted 130' INT
trap 'interrupted 143' TERM

install -d -o root -g root -m 0700 /var/backups/moore-pi-network
backup_dir=$(mktemp -d "/var/backups/moore-pi-network/install-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
for index in 0 1 2; do
    if [[ -f ${targets[$index]} ]]; then
        cp -a -- "${targets[$index]}" "$backup_dir/${backup_names[$index]}"
        present[$index]=1
    fi
done
if [[ -f $config_target ]]; then
    cp -a -- "$config_target" "$backup_dir/network-healthcheck.json"
fi
if [[ -f $state_target ]]; then
    cp -a -- "$state_target" "$backup_dir/state.json"
fi
printf 'previous_timer_enabled=%s\nprevious_timer_active=%s\n' "$timer_was_enabled" "$timer_was_active" > "$backup_dir/install-state.txt"

# This is read-only with respect to the network. It captures the active profile
# on first installation and refuses to overwrite a mismatched or damaged setup.
python3 -I "$source_dir/network_healthcheck.py" --initialize --interface "$interface"

rollback_needed=1
if [[ $(systemctl show network-healthcheck.timer --property=LoadState --value) == loaded ]]; then
    systemctl stop network-healthcheck.timer
fi
if [[ $(systemctl show network-healthcheck.service --property=LoadState --value) == loaded ]]; then
    systemctl stop network-healthcheck.service
fi
atomic_install "$source_dir/network_healthcheck.py" "$script_target" 0755
atomic_install "$source_dir/network-healthcheck.service" "$service_target" 0644
atomic_install "$source_dir/network-healthcheck.timer" "$timer_target" 0644
systemctl daemon-reload

# A healthy read-only check is required before the scheduled actions are armed.
"$script_target" --status
systemctl start network-healthcheck.service
systemctl enable --now network-healthcheck.timer
systemctl is-active --quiet network-healthcheck.timer
rollback_needed=0

printf '\nInstalled bounded Wi-Fi recovery. Backup: %s\n' "$backup_dir"
printf 'Network settings, No-IP configuration and solar configuration were not changed.\n'
printf 'The timer checks every five minutes; a healthy device is not rebooted.\n\n'
systemctl show network-healthcheck.timer moore-solar.service noip-duc.service \
    --property=Id,ActiveState,SubState
