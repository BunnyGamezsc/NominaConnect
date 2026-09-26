#!/usr/bin/env bash
# Build the current Mac checkout for Linux x64 and verify the copy on Proxmox.
set -euo pipefail

usage() {
  printf 'Usage: %s root@PROXMOX-IP [SSH-PRIVATE-KEY] [SSH-PORT]\n' "$0" >&2
  exit 2
}
[ "$#" -ge 1 ] && [ "$#" -le 3 ] || usage
target=$1
[[ $target =~ ^root@[A-Za-z0-9.-]+$ ]] || usage
port=${3:-22}
[[ $port =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || usage
identity=()
if [ "$#" -ge 2 ]; then
  [ -f "$2" ] || { printf 'SSH key not found: %s\n' "$2" >&2; exit 1; }
  identity=(-i "$2")
fi
command -v bun >/dev/null || { printf 'Install Bun on this Mac first.\n' >&2; exit 1; }
repo=$(cd "$(dirname "$0")/../.." && pwd)
binary=$repo/dist/nomina-linux-x64
remote=/opt/nominaconnect-test/nomina-linux-x64
temporary=/tmp/nomina-linux-x64-upload

cd "$repo"
bun run build:native
[ -f "$binary" ] || { printf 'Build output missing: %s\n' "$binary" >&2; exit 1; }
local_hash=$(shasum -a 256 "$binary" | awk '{print $1}')
scp "${identity[@]}" -P "$port" -o ConnectTimeout=10 "$binary" "$target:$temporary"
ssh "${identity[@]}" -p "$port" -o ConnectTimeout=10 "$target" \
  "mkdir -p /opt/nominaconnect-test && install -m 755 $temporary $remote && rm -f $temporary"
remote_hash=$(ssh "${identity[@]}" -p "$port" -o ConnectTimeout=10 "$target" "sha256sum $remote" | awk '{print $1}')
if [ "$local_hash" != "$remote_hash" ]; then
  printf 'Binary hashes differ (Mac %s, Proxmox %s). Do not run field tests.\n' "$local_hash" "$remote_hash" >&2
  exit 1
fi
ssh "${identity[@]}" -p "$port" -o ConnectTimeout=10 "$target" "$remote --version"
printf 'Verified %s on Proxmox (SHA-256 %s). Use this path for field tests.\n' "$remote" "$local_hash"
