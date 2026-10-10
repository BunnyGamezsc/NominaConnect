#!/bin/bash
# Run only inside an operator-supplied disposable Debian LXC.
set -euo pipefail
if [[ ${NOMINA_SMB_FIXTURE:-} != disposable || $EUID != 0 ]]; then
  echo 'Run as root inside a disposable Debian LXC with NOMINA_SMB_FIXTURE=disposable.' >&2
  exit 1
fi
hostname=${1:-files.bunny.internal}
port=${2:-445}
if [[ ! $hostname =~ ^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$ || ! $port =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )); then
  echo 'Usage: setup-smb-fixture.sh DNS_HOSTNAME BACKEND_PORT' >&2
  exit 1
fi
alias=${hostname%%.*}
if (( ${#alias} > 15 )); then
  echo 'The fixture requires a hostname whose first label fits a 15-character NetBIOS alias.' >&2
  exit 1
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y samba smbclient
for user in smb-writer smb-denied; do
  id "$user" >/dev/null 2>&1 || useradd --user-group --no-create-home --shell /usr/sbin/nologin "$user"
  read -r -s -p "New fixture password for $user: " password
  echo
  if [[ -z $password ]]; then echo 'A nonempty password is required.' >&2; exit 1; fi
  printf '%s\n%s\n' "$password" "$password" | smbpasswd -s -a "$user"
  unset password
done
install -d -o smb-writer -g smb-writer -m 0700 /srv/nomina-smb-verify
cat > /etc/samba/nomina-fixture.conf <<EOF
[global]
    server role = standalone server
    security = user
    workgroup = WORKGROUP
    netbios name = NOMINA-SMB
    netbios aliases = $alias
    smb ports = $port
    server min protocol = SMB2_02
    server max protocol = SMB3
    map to guest = Never
    load printers = no
    disable spoolss = yes

[verify]
    path = /srv/nomina-smb-verify
    browseable = yes
    read only = no
    guest ok = no
    valid users = smb-writer
    create mask = 0600
    directory mask = 0700
EOF
testparm -s /etc/samba/nomina-fixture.conf
install -d /etc/systemd/system/smbd.service.d
cat > /etc/systemd/system/smbd.service.d/nomina-fixture.conf <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/sbin/smbd --foreground --no-process-group --configfile=/etc/samba/nomina-fixture.conf
EOF
systemctl disable --now nmbd.service
systemctl daemon-reload
systemctl enable smbd.service
systemctl restart smbd.service
systemctl is-active smbd.service
echo "Fixture ready: //$hostname/verify, backend TCP $port. Only smb-writer can access verify."
