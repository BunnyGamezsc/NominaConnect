#!/bin/bash
# Real SMB application checks. No IP override or client port is used.
set -euo pipefail
if [[ $# != 5 ]]; then
  echo 'Usage: check-smb-client.sh HOSTNAME EXPECTED_DNS_IP WRITER_AUTH_FILE DENIED_AUTH_FILE EVIDENCE_DIR' >&2
  exit 1
fi
hostname=$1
expected=$2
if [[ ! $hostname =~ ^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$ ]]; then
  echo 'Invalid DNS hostname.' >&2; exit 1
fi
for command in smbclient python3; do command -v "$command" >/dev/null; done
writer=$(cd "$(dirname "$3")" && pwd)/$(basename "$3")
denied=$(cd "$(dirname "$4")" && pwd)/$(basename "$4")
[[ -r $writer && -r $denied ]]
mkdir -p "$5"
evidence=$(cd "$5" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
python3 - "$hostname" "$expected" > "$evidence/dns.txt" <<'PY'
import socket, sys
addresses = sorted({r[4][0] for r in socket.getaddrinfo(sys.argv[1], 445, socket.AF_INET, socket.SOCK_STREAM)})
print(sys.argv[1], addresses)
if addresses != [sys.argv[2]]:
    raise SystemExit("DNS must return only the expected listener IP")
PY
# Samba reads existing gencache.tdb entries even with name cache timeout=0.
# Isolate its lock directory for this run so an old network's answer is absent.
mkdir "$work/samba-lock"
client=(smbclient -R host -m SMB3 --option="lock directory=$work/samba-lock" --option='name cache timeout=0' --option='client min protocol=SMB2_02' --use-kerberos=off -d 3 -t 10)
verify_destination() {
  python3 - "$1" "$expected" <<'PY'
import pathlib, re, sys
connections = re.findall(r'Connecting to (\S+) at port (\d+)', pathlib.Path(sys.argv[1]).read_text())
# With no port override smbclient probes both standard SMB ports. Only 445 is
# exposed by NominaConnect; neither candidate may use a stale LAN address.
allowed_ports = {'445', '139'}
if not connections or connections[0] != (sys.argv[2], '445') or any(ip != sys.argv[2] or port not in allowed_ports for ip, port in connections):
    raise SystemExit(f"Unexpected SMB connection destinations: {connections}")
print(f"Verified SMB destination: {connections}")
PY
}
"${client[@]}" -L "$hostname" -A "$writer" -g > "$evidence/listing.txt" 2>&1
verify_destination "$evidence/listing.txt" listing
grep -Eq '^Disk\|verify\|' "$evidence/listing.txt"
cd "$work"
python3 - <<'PY'
import os
with open('source.bin', 'wb') as f:
    f.write(os.urandom(65536))
PY
remote="nomina-verify-$(date +%s)-$$.bin"
"${client[@]}" "//$hostname/verify" -A "$writer" -c "put source.bin $remote" > "$evidence/upload.txt" 2>&1
verify_destination "$evidence/upload.txt"
# A separate connection must read the file written by the first connection.
"${client[@]}" "//$hostname/verify" -A "$writer" -c "get $remote downloaded.bin" > "$evidence/download.txt" 2>&1
verify_destination "$evidence/download.txt"
cmp source.bin downloaded.bin
python3 - > "$evidence/content-sha256.txt" <<'PY'
import hashlib
for name in ['source.bin', 'downloaded.bin']:
    print(hashlib.sha256(open(name, 'rb').read()).hexdigest(), name)
PY
reject() {
  local label=$1
  shift
  if "${client[@]}" "//$hostname/verify" "$@" -c ls > "$evidence/$label.txt" 2>&1; then
    echo "FAIL: $label unexpectedly accessed verify" >&2; exit 1
  fi
  verify_destination "$evidence/$label.txt"
  # A timeout or DNS error is not evidence of rejected authentication.
  grep -Eq 'NT_STATUS_(ACCESS_DENIED|LOGON_FAILURE|WRONG_PASSWORD)' "$evidence/$label.txt"
}
reject anonymous -N -U '%'
reject unknown-user -U 'nomina-unknown%fixture-invalid-password'
reject authenticated-denied -A "$denied"
# Reconnect after the rejected sessions and compare the content again.
"${client[@]}" "//$hostname/verify" -A "$writer" -c "get $remote reconnected.bin; del $remote" > "$evidence/reconnect.txt" 2>&1
verify_destination "$evidence/reconnect.txt"
cmp source.bin reconnected.bin
echo "PASS: $hostname listing, upload, download/content, denied access and fresh-session reconnect" | tee "$evidence/result.txt"
