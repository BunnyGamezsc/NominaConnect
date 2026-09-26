#!/bin/bash
# Remove only the macOS alias and PF NAT rule installed by setup-mac-gateway.sh.
set -euo pipefail

state_dir=/var/db/nominaconnect/mac-lab
state_file=$state_dir/state
anchor=com.apple/nomina-lab
fail() { printf 'Nomina Mac lab: %s\n' "$*" >&2; exit 1; }
[ "$(id -u)" -eq 0 ] || fail 'Run with sudo.'
[ -f "$state_file" ] || fail 'No saved Mac lab gateway was found. Nothing was changed.'
guest_if=$(sed -n 's/^guest_if=//p' "$state_file")
lab_ip=$(sed -n 's/^lab_ip=//p' "$state_file")
subnet=$(sed -n 's/^subnet=//p' "$state_file")
uplink=$(sed -n 's/^uplink=//p' "$state_file")
previous_forward=$(sed -n 's/^previous_forward=//p' "$state_file")
pf_token=$(sed -n 's/^pf_token=//p' "$state_file")
[[ $guest_if =~ ^[a-zA-Z0-9]+$ && $uplink =~ ^[a-zA-Z0-9]+$ ]] || fail 'Saved interface name is invalid.'
[[ $lab_ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ && $subnet =~ ^([0-9]{1,3}\.){3}0/24$ ]] || fail 'Saved address is invalid.'
[[ $previous_forward =~ ^[01]$ && $pf_token =~ ^[0-9]+$ ]] || fail 'Saved PF state is invalid.'
# This anchor is dedicated to the lab; PF may normalize its rule when listing it.
pfctl -a "$anchor" -F nat >/dev/null 2>&1
pfctl -X "$pf_token" >/dev/null 2>&1 || fail 'Could not release the lab PF enable token; the NAT rule was cleared.'
ifconfig "$guest_if" inet "$lab_ip" -alias
if [ "$(sysctl -n net.inet.ip.forwarding)" = 1 ]; then
  sysctl -w "net.inet.ip.forwarding=$previous_forward" >/dev/null
fi
rm -f "$state_file" "$state_dir/nat.pf"
rmdir "$state_dir" 2>/dev/null || true
printf 'Mac lab NAT and %s alias removed.\n' "$guest_if"
