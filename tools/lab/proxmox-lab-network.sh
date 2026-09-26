#!/usr/bin/env bash
# Install a dedicated host-only bridge and outbound NAT on a disposable Proxmox VM.
set -euo pipefail

interfaces=/etc/network/interfaces
state_dir=/var/lib/nominaconnect
state_file=$state_dir/lab-network.state
sysctl_file=/etc/sysctl.d/98-nomina-lab-forward.conf
begin='# BEGIN NOMINACONNECT LAB NETWORK'
end='# END NOMINACONNECT LAB NETWORK'
bridge=vmbr1

fail() { printf 'Nomina lab: %s\n' "$*" >&2; exit 1; }
value() { sed -n "s/^$1=//p" "$state_file" | head -n 1; }

need_root() {
  [ "$(id -u)" -eq 0 ] || fail 'Run this script as root on the Proxmox VM.'
  command -v pct >/dev/null || fail 'This is not a Proxmox host.'
}

install() {
  local mac= ip= subnet= nic= uplink= previous_forward= backup=
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --mac) mac=${2:-}; shift 2 ;;
      --ip) ip=${2:-}; shift 2 ;;
      --subnet) subnet=${2:-}; shift 2 ;;
      *) fail "Unknown install option: $1" ;;
    esac
  done
  [[ $mac =~ ^([[:xdigit:]]{2}:){5}[[:xdigit:]]{2}$ ]] || fail 'Pass the VirtualBox host-only NIC MAC address.'
  [[ $ip =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/24$ ]] || fail 'Pass a /24 Proxmox address.'
  [[ $subnet =~ ^([0-9]{1,3}\.){3}0/24$ ]] || fail 'Pass the matching /24 lab subnet.'
  [ -f "$interfaces" ] || fail 'Proxmox interfaces file is missing.'
  command -v ifreload >/dev/null || fail 'Install ifupdown2 before configuring the lab bridge.'
  command -v iptables >/dev/null || fail 'iptables is required for lab egress NAT.'
  if [ -f "$state_file" ]; then
    [ "$(value mac)" = "${mac,,}" ] && [ "$(value ip)" = "$ip" ] &&
      [ "$(value subnet)" = "$subnet" ] || fail 'A different lab network is already installed. Remove it first.'
    ifreload -a
    iptables -t nat -C POSTROUTING -s "$subnet" -o "$(value uplink)" -j MASQUERADE 2>/dev/null ||
      iptables -t nat -A POSTROUTING -s "$subnet" -o "$(value uplink)" -j MASQUERADE
    status
    return
  fi
  grep -Fqx "$begin" "$interfaces" && fail 'A lab stanza exists without its state file. Inspect the interfaces file.'
  grep -Eq "^iface[[:space:]]+$bridge[[:space:]]" "$interfaces" && fail "$bridge is already configured in Proxmox."
  ip link show "$bridge" >/dev/null 2>&1 && fail "$bridge already exists; choose an unused Proxmox bridge."
  [ ! -e "$sysctl_file" ] || fail "$sysctl_file already exists. Inspect it before setup."

  for path in /sys/class/net/*/address; do
    if [ "$(tr '[:upper:]' '[:lower:]' < "$path")" = "${mac,,}" ]; then
      nic=$(basename "$(dirname "$path")")
      break
    fi
  done
  [ -n "$nic" ] || fail 'The VirtualBox host-only NIC is not visible in Proxmox. Reboot the VM after adding it.'
  [ ! -e "/sys/class/net/$nic/master" ] || fail "$nic is already attached to another bridge."
  uplink=$(ip -4 route show default | awk 'NR==1 {for(i=1;i<=NF;i++) if($i=="dev") {print $(i+1); exit}}')
  [ -n "$uplink" ] && [ "$uplink" != "$nic" ] || fail 'The Proxmox VM needs an existing internet uplink and default route.'
  previous_forward=$(sysctl -n net.ipv4.ip_forward)

  mkdir -p "$state_dir"
  chmod 700 "$state_dir"
  backup="$interfaces.nomina-lab.$(date +%Y%m%d%H%M%S)"
  cp -p "$interfaces" "$backup"
  cat >> "$interfaces" <<EOF

$begin
auto $bridge
iface $bridge inet static
    address $ip
    bridge-ports $nic
    bridge-stp off
    bridge-fd 0
    post-up iptables -t nat -C POSTROUTING -s $subnet -o $uplink -j MASQUERADE || iptables -t nat -A POSTROUTING -s $subnet -o $uplink -j MASQUERADE
    post-down iptables -t nat -D POSTROUTING -s $subnet -o $uplink -j MASQUERADE || true
$end
EOF
  printf 'net.ipv4.ip_forward=1\n' > "$sysctl_file"
  sysctl -w net.ipv4.ip_forward=1 >/dev/null
  if ! ifreload -a; then
    cp -p "$backup" "$interfaces"
    rm -f "$sysctl_file"
    sysctl -w "net.ipv4.ip_forward=$previous_forward" >/dev/null
    ifreload -a || true
    fail 'Network reload failed. The previous interfaces file was restored.'
  fi
  iptables -t nat -C POSTROUTING -s "$subnet" -o "$uplink" -j MASQUERADE 2>/dev/null ||
    iptables -t nat -A POSTROUTING -s "$subnet" -o "$uplink" -j MASQUERADE
  printf 'mac=%s\nip=%s\nsubnet=%s\nnic=%s\nuplink=%s\nprevious_forward=%s\nbackup=%s\n' \
    "${mac,,}" "$ip" "$subnet" "$nic" "$uplink" "$previous_forward" "$backup" > "$state_file"
  chmod 600 "$state_file"
  status
}

status() {
  [ -f "$state_file" ] || { printf 'Nomina lab network is not installed.\n'; return; }
  printf 'Lab bridge: %s, address %s, NIC %s\n' "$bridge" "$(value ip)" "$(value nic)"
  printf 'Uplink: %s, forwarding: %s\n' "$(value uplink)" "$(sysctl -n net.ipv4.ip_forward)"
  if iptables -t nat -C POSTROUTING -s "$(value subnet)" -o "$(value uplink)" -j MASQUERADE 2>/dev/null; then
    printf 'Lab outbound NAT: active\n'
  else
    printf 'Lab outbound NAT: missing\n'
  fi
}

remove() {
  local vmid subnet uplink previous_forward
  [ -f "$state_file" ] || { printf 'Nomina lab network is already absent.\n'; return; }
  while read -r vmid; do
    [ -n "$vmid" ] || continue
    if pct config "$vmid" | grep -Eq "bridge=$bridge([,[:space:]]|$)"; then
      fail "LXC $vmid still uses $bridge. Remove or move it before removing the lab network."
    fi
  done < <(pct list | awk 'NR>1 {print $1}')
  subnet=$(value subnet)
  uplink=$(value uplink)
  previous_forward=$(value previous_forward)
  sed -i "/^$begin$/,/^$end$/d" "$interfaces"
  ifreload -a || fail 'Could not reload Proxmox networking. Inspect /etc/network/interfaces before retrying.'
  iptables -t nat -D POSTROUTING -s "$subnet" -o "$uplink" -j MASQUERADE 2>/dev/null || true
  rm -f "$sysctl_file"
  sysctl -w "net.ipv4.ip_forward=$previous_forward" >/dev/null
  rm -f "$state_file"
  printf 'Nomina lab bridge and NAT removed.\n'
}

need_root
case "${1:-}" in
  install) shift; install "$@" ;;
  status) status ;;
  remove) remove ;;
  *) fail 'Use: proxmox-lab-network.sh install --mac aa:bb:cc:dd:ee:ff --ip 172.28.240.3/24 --subnet 172.28.240.0/24 | status | remove' ;;
esac
