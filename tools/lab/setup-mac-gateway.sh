#!/bin/bash
# Temporary macOS NAT gateway for the older Proxmox lab.
set -euo pipefail

state_dir=/var/db/nominaconnect/mac-lab
state_file=$state_dir/state
anchor=com.apple/nomina-lab

fail() { printf 'Nomina Mac lab: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail 'Run with sudo.'
[ "$#" -eq 3 ] || fail 'Usage: sudo setup-mac-gateway.sh INTERFACE LAB_IP SUBNET (for example en8 192.168.1.1 192.168.1.0/24)'
guest_if=$1
lab_ip=$2
subnet=$3
[[ $guest_if =~ ^[a-zA-Z0-9]+$ ]] || fail 'Invalid guest interface.'
[[ $lab_ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || fail 'Invalid lab IP.'
[[ $subnet =~ ^([0-9]{1,3}\.){3}0/24$ ]] || fail 'This helper requires a /24 subnet.'
[[ $lab_ip == "${subnet%.0/24}."* ]] || fail 'Lab IP is outside the subnet.'
[ ! -e "$state_file" ] || fail 'The Mac lab gateway is already installed; run uninstall before setting it up again.'
ifconfig "$guest_if" >/dev/null 2>&1 || fail "Interface $guest_if does not exist."
if ifconfig "$guest_if" | grep -Eq "inet[[:space:]]+$lab_ip([[:space:]]|$)"; then
  fail "$guest_if already has $lab_ip; this script will not take ownership of an existing alias."
fi
uplink=$(route -n get default | awk '/interface:/ {print $2; exit}')
[ -n "$uplink" ] && [ "$uplink" != "$guest_if" ] || fail 'A separate default-route uplink is required.'
if ifconfig "$uplink" | grep -Eq "inet[[:space:]]+${subnet%.0/24}\.[0-9]+([[:space:]]|$)"; then
  fail 'The lab subnet overlaps the Mac uplink subnet.'
fi
if pfctl -a "$anchor" -s nat 2>/dev/null | grep -q .; then
  fail "PF anchor $anchor already has NAT rules."
fi
previous_forward=$(sysctl -n net.inet.ip.forwarding)
mkdir -p "$state_dir"
chmod 700 "$state_dir"
printf 'nat on %s from %s to any -> (%s)\n' "$uplink" "$subnet" "$uplink" > "$state_dir/nat.pf"
chmod 600 "$state_dir/nat.pf"
pfctl -n -a "$anchor" -f "$state_dir/nat.pf" >/dev/null 2>&1 || fail 'PF rejected the lab NAT rule.'

alias_added=0
anchor_loaded=0
pf_token=
rollback() {
  if [ "$anchor_loaded" -eq 1 ]; then pfctl -a "$anchor" -F nat >/dev/null 2>&1 || true; fi
  if [ -n "$pf_token" ]; then pfctl -X "$pf_token" >/dev/null 2>&1 || true; fi
  sysctl -w "net.inet.ip.forwarding=$previous_forward" >/dev/null 2>&1 || true
  if [ "$alias_added" -eq 1 ]; then ifconfig "$guest_if" inet "$lab_ip" -alias >/dev/null 2>&1 || true; fi
  rm -f "$state_dir/nat.pf"
}
trap rollback ERR
ifconfig "$guest_if" inet "$lab_ip" netmask 255.255.255.0 alias
alias_added=1
sysctl -w net.inet.ip.forwarding=1 >/dev/null
pfctl -a "$anchor" -f "$state_dir/nat.pf" >/dev/null 2>&1
anchor_loaded=1
pf_output=$(pfctl -E 2>&1)
pf_token=$(printf '%s\n' "$pf_output" | awk '/Token[[:space:]]*:/ {print $3; exit}')
if [[ ! $pf_token =~ ^[0-9]+$ ]]; then
  rollback
  fail 'PF did not return a valid enable token.'
fi
printf 'guest_if=%s\nlab_ip=%s\nsubnet=%s\nuplink=%s\nprevious_forward=%s\npf_token=%s\n' \
  "$guest_if" "$lab_ip" "$subnet" "$uplink" "$previous_forward" "$pf_token" > "$state_file"
chmod 600 "$state_file"
trap - ERR
printf 'Mac lab NAT active: %s via %s, gateway %s on %s.\n' "$subnet" "$uplink" "$lab_ip" "$guest_if"
printf 'When done, run sudo %s/uninstall-mac-gateway.sh\n' "$(dirname "$0")"
