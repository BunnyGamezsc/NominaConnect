# SMB fixture and verification handoff

Implements SMB ticket #27 using the existing TCP ticket #26 workflow from
spec #25. Combined testing and release ticket #28
must complete real LAN and Tailscale checks before release. SSH remains deferred.

## Publishing and server names

```sh
nomina exposure publish --name files --protocol smb \
  --hostname files.example.internal --backend-ip 198.51.100.21 --tailnet true
```

Backend port defaults to 445. `--backend-port 1445` changes only the backend.
Both client paths retain TCP 445. `--listener-port` must be omitted or 445.
Windows uses `\\files.example.internal\verify`; Finder's Connect to Server uses
`smb://files.example.internal/verify`. The backend can be any reachable existing
SMB server; no backend VMID or NominaConnect deployment record is needed.

The saved record has `protocol: tcp`, `preset: smb` and `listenerPort: 445`.
Updating through the wizard, republishing without `--protocol`, tracking native
backend edits, republishing platform integrations and removal reuse TCP.
NominaConnect's health result covers DNS and TCP transport only. SMB negotiation,
authentication, share authorization and content checks are separate evidence.

For the standalone Samba fixture, the setup script adds the hostname's first
label, `files`, to `netbios aliases`. Keep existing aliases when configuring a
real server. Samba documents aliases as additional NetBIOS names and limits
NetBIOS names to 15 characters. Full DNS hostname resolution comes from the
managed A record; the fixture does not use NetBIOS discovery or forward port
139. See [Samba's name settings](https://www.samba.org/samba/docs/current/man-html/smb.conf.5.html#NETBIOSALIASES).

An alias does not supply domain authentication. For an AD-joined server, have
its administrator register the required `cifs/files.example.internal` service
identity and configure the server's supported alias policy. NominaConnect
does not change AD, NAS alias policies, keys or passwords. The fixture uses
standalone users with Kerberos disabled in the client checks. If a real backend
restricts source IPs, allow its proxy LXC's address, since socket forwarding
establishes the backend connection from that proxy.
See [Samba's domain-alias discussion](https://lists.samba.org/archive/samba/2022-November/242878.html)
for the separate service identity/keytab requirement.

## Disposable Debian LXC fixture

Use an operator-approved spare VMID, unused static IP and Debian stable
template. Suggested size is 1 CPU, 512 MB RAM, 4 GB disk, unprivileged, no TUN
device. This fixture is outside NominaConnect's managed inventory. Do not run
the setup on a production Samba server or any retained platform LXC.

On the authorized Proxmox host, substitute values supplied for that lab:

```sh
pct create "$SMB_VMID" "$DEBIAN_TEMPLATE" --unprivileged 1 \
  --hostname nomina-smb-fixture --cores 1 --memory 512 \
  --rootfs "$STORAGE:4" --net0 "name=eth0,bridge=$BRIDGE,ip=$SMB_CIDR,gw=$GATEWAY" \
  --nameserver "$RESOLVER" --onboot 1
pct start "$SMB_VMID"
pct push "$SMB_VMID" tools/setup-smb-fixture.sh /root/setup-smb-fixture.sh
pct enter "$SMB_VMID"
NOMINA_SMB_FIXTURE=disposable bash /root/setup-smb-fixture.sh files.example.internal 445
exit
```

The script installs Samba and prompts privately for two distinct fixture
passwords. `smb-writer` owns the read/write `verify` share. `smb-denied` has a
valid Samba password but is excluded by `valid users`. Guest mapping is disabled,
SMB2 or newer is required, and only the chosen backend port is bound. A systemd
drop-in points smbd at a separate `/etc/samba/nomina-fixture.conf`; existing
`smb.conf` is not overwritten. The drop-in, users and share belong to this
disposable fixture. Never install this fixture as a NominaConnect service.

For the alternate-backend test, repeat setup with port 1445, keeping passwords
as desired, and republish with `--backend-port 1445`. Restore port 445 after that
check if the next test expects the default. Reboot persistence comes from the
fixture's enabled smbd service and the existing TCP socket/gateway boot hooks.

## Real client checks and evidence

Install Samba's `smbclient` and Python 3 on a LAN client and a client away from
the LAN. Prepare two local authentication files with mode 0600, outside the
repository, in Samba's authentication-file format:

```text
username = smb-writer
password = the-fixture-writer-password
domain = WORKGROUP
```

The second file uses `smb-denied` and that account's password. Do not put
passwords into shell arguments or evidence. The script uses DNS hostname
resolution, no `-I` override and no explicit port, and records separate logs
plus matching SHA-256 hashes. It uses a temporary Samba lock directory, sets
`--option='name cache timeout=0'`, and checks every operation's connection
diagnostics against the expected destination. A zero timeout alone does not
prevent reading previously stored answers: Samba reads `gencache.tdb` from
its lock directory. Native DNS alone cannot prove
that smbclient used the new answer after switching networks: a cached LAN
answer caused a false-positive tailnet check in this lab. With no port override,
Samba probes standard ports 445 and 139; NominaConnect exposes only 445.
See [Samba's name-cache setting](https://www.samba.org/samba/docs/current/man-html/smb.conf.5.html#NAMECACHETIMEOUT),
[cache implementation](https://github.com/samba-team/samba/blob/master/source3/lib/gencache.c),
and [smbclient's authentication and command options](https://www.samba.org/samba/docs/current/man-html/smbclient.1.html).

```sh
# LAN: Tailscale off, using Technitium; expect the proxy's LAN IP.
bash tools/check-smb-client.sh files.example.internal "$PROXY_LAN_IP" \
  "$WRITER_AUTH_FILE" "$DENIED_AUTH_FILE" ./evidence/smb-lan
# Away from LAN: Tailscale DNS on; expect the gateway's 100.x address.
bash tools/check-smb-client.sh files.example.internal "$GATEWAY_TAILSCALE_IP" \
  "$WRITER_AUTH_FILE" "$DENIED_AUTH_FILE" ./evidence/smb-tailnet
```

Each run requires authenticated share listing, upload, download with byte
comparison, anonymous rejection, nonexistent-user rejection, authenticated
unauthorized-user rejection, and reconnect/download with another comparison.
Denied checks require an authentication/access-denied SMB status; a DNS failure
or timeout cannot pass them. Unique test files are removed after a successful
run. If interrupted, remove only the `nomina-verify-*` files from the fixture.
Retain the evidence directories with client version, date and build checksum.

Repeat both checks after a reachable backend IP/port update, backend LXC restart,
proxy LXC restart, gateway LXC restart and tailscaled restart. Also open the
share with native Windows and macOS clients through the hostname. Upload and
download a file, comparing its hash on the client. Close/reopen the share after
each restart. Capture DNS answers, native client version and outcomes separately.

With Minecraft and HTTPS still published, republish files with `--tailnet false`.
LAN checks must pass. An away client's new SMB connection and already-open
session must fail; TCP 445 must be denied even if remote DNS still answers.
Minecraft and opted-in HTTPS must still work. Restore `--tailnet true` and
reconnect successfully. A second hostname on listener 445 must be rejected
before DNS/forwarding writes. Remove with `nomina service remove files`, then
confirm only its DNS record, port-445 units and gateway forwarding are removed.
Recreate files for the combined test if needed. Preserve unrelated Samba,
Technitium, proxy and gateway resources throughout.

## Inputs for combined testing and release

- Authorized root connection to Proxmox and project directory containing
  `nomina.yaml`, state and secure provider credentials. Preserve existing
  platform LXCs and use a separate approved spare VMID for the fixture.
- Debian template volume, storage, bridge, unused SMB backend IP/CIDR, gateway,
  resolver, spare VMID, and two private fixture passwords, or an equivalent
  existing SMB server with an authenticated writable share and denied user.
- Chosen hostname/share, such as `files.example.internal/verify`; use the actual
  project's DNS suffix.
  Record backend alias policy and alternate backend IP/port for update testing.
- Actual proxy LAN IP, gateway LAN/Tailscale IPs and their recorded VMIDs.
  Port 445 must be free on proxy/gateway and allowed for opted-in clients by
  Tailscale policy. Keep gateway administrator access available.
- LAN and off-LAN Tailscale clients, native Windows/macOS SMB clients,
  `smbclient`/Python 3, private authentication-file paths and evidence locations.
- Reachable Minecraft Java server, client session and `mc` hostname, existing
  HTTPS exposures, and provider/firewall baselines for simultaneous regressions.
- Tested source checkout and x64/arm64 build hashes. Build with `npm run
  build:native` and `npm run build:native:arm64`; copy the architecture-matching
  binary to Proxmox and verify its hash before testing. Versioning, changelog,
  release publication and released-artifact checks belong to #28.

## Validation boundary

The TCP baseline passed repository tests and typechecking before SMB changes.
Automated CLI checks cover preset persistence, default/alternate backend ports,
guided and scripted setup, conflicts before mutation, health, coexistence,
tracking, tailnet opt-out and scoped removal. Generated-script checks cover
port-445 units and persisted gateway boot replay alongside Minecraft. These
fixtures do not prove real SMB application access or live firewall behavior.

Live verification passed against disposable Samba and Minecraft fixtures:

- Repository suite: 553 passed, two expected platform/live skips; typecheck and
  Linux x64/arm64 native builds passed.
- Linux wire suite: seven passed with no skips, including systemd socket proxy.
- Authenticated SMB listing, upload/download byte comparison, rejected access,
  and reconnection passed on LAN and with Ethernet physically unplugged through
  Tailscale. Each corrected client check verifies its destination address.
- Alternate backend port, reboot persistence, tailnet opt-out, conflict rejection,
  scoped removal, and preservation of existing HTTPS/DNS passed.
- Minecraft Java 1.21.11 joined by hostname on both paths. Native macOS mounted
  the SMB share by hostname, uploaded an image, and read matching backend content;
  the operator also confirmed native access through Tailscale.

Detailed logs, private credentials, addresses, account identities, and local
paths remain outside the committed evidence. Native Windows testing provides
additional client coverage; the recorded Samba and macOS checks verify SMB
application access. The release workflow verifies published artifacts through
the supported installer before closing #28. SSH remains deferred until then.
