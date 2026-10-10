# TCP verification handoff

This implements TCP ticket #26 from spec #25.
The [SMB preset and fixture](smb-live-verification.md) are implemented in ticket
#27. SSH, UDP and release publication remain separate tickets.

## Build and install

Builds are generated locally under `dist/nomina-linux-x64` and
`dist/nomina-linux-arm64`. From the source checkout:

```sh
npm run typecheck
npm test
npm run build:native
npm run build:native:arm64
```

Copy the appropriate binary to the Proxmox host, compare its SHA-256 with the
local build, and install it with mode 0755. Run it as root
from the existing project directory containing `nomina.yaml`. This is an
unreleased verification build at the current repository version.

Technitium and Caddy or Traefik must already be provisioned. Proxy LXCs need
Debian systemd, `/lib/systemd/systemd-socket-proxyd`, `ss`, bash and coreutils.
Tailscale must have its managed gateway firewall and DNS relay configured for
remote checks. No new Caddy module or Traefik TCP entrypoint is needed.

## Publish and verify Minecraft

```sh
nomina exposure publish --name minecraft --protocol tcp \
  --hostname mc.example.internal --backend-ip 198.51.100.20 \
  --backend-port 25565 --tailnet true
```

1. On a LAN client with Tailscale off and Technitium as resolver, resolve
   `mc.example.internal`. Expect the proxy LAN IP. Probe TCP 25565, then join using
   only `mc.example.internal` in a Minecraft Java client. Record both checks.
2. On a client away from the LAN with Tailscale DNS enabled, resolve the same
   name. Expect the gateway's `100.x` address. Probe TCP 25565 and perform a real
   hostname-only Minecraft Java join. DNS resolution and a TCP connection alone
   do not prove a join.
3. Verify HTTPS exposures, filtered and negative DNS answers, external DNS,
   gateway LAN SSH administration and unrelated provider resources still work.
4. Republish with a reachable replacement backend IP or port. Omit
   `--listener-port`; clients must keep port 25565 and the same hostname.
5. Restart the proxy LXC and gateway LXC, and restart `tailscaled`. Reconnect
   through both LAN and tailnet. No republish should be necessary after restart.
6. Republish with `--tailnet false`, keeping all other flags. LAN joining must
   work and remote joining and TCP probing must fail, including an already-open
   remote connection. Republish with `--tailnet true` to restore access.
7. Test another hostname on the same listener and platform ports 22/53/80/443.
   Expect rejection before DNS or forwarding changes. Separately reserve a
   candidate port with a real process on either LXC and verify rejection.
8. Stop the backend and republish. Expect unhealthy TCP with an unreachable
   backend reason. Restore the backend and republish to recover.
9. Remove with `nomina service remove minecraft`. Only its A record, socket,
   service and gateway port file/rules should disappear. Recreate it if the
   combined test stage needs it.

Inspect generated resources with the actual VMIDs from `.nomina/state.json`:

```sh
pct exec PROXY_VMID -- systemctl status nomina-tcp-25565.socket nomina-tcp-25565.service
pct exec GATEWAY_VMID -- cat /etc/nominaconnect/tcp-tailnet/25565
pct exec GATEWAY_VMID -- iptables-save
```

Only the socket is enabled; the forwarding service starts on connection. Port
files map the gateway listener port to the proxy LAN IP. Backend settings are
in `/etc/nominaconnect/tcp/25565.json` and the socket/service units. Backend edits
in the service unit can be observed and adopted by tracking; reload systemd and
restart the service to make a native edit effective. Unsupported unit edits are
preserved and reported, rather than overwritten.

## Automated and later combined checks

`test/exposure-publish.test.js` exercises the CLI with injected providers, saved
configuration, ownership, conflicts, health, lifecycle, tracking, and a real TCP
byte-transfer fixture. `test/tcp-adapter-wire.test.js` executes generated scripts
against executable platform fixtures, replays persisted gateway rules, and
contains a Linux-only test using the real systemd socket proxy with an inherited
listening socket. Run that test on Linux with Node and the Debian binary before
claiming production forwarding has been verified:

```sh
node --test test/tcp-adapter-wire.test.js
```

After the SMB ticket, run Minecraft and authenticated SMB concurrently through
both paths. Check share listing, upload/download with content comparison, denied
access and reconnect after restart, alongside HTTPS and administration checks.
Do not publish a release until the combined test ticket verifies these results.

## Completed live verification

The Linux wire suite passed all seven tests, including the real systemd socket
proxy. A Minecraft Java 1.21.11 client joined by hostname on LAN and through
Tailscale with Ethernet physically unplugged. Live SMB checks also passed while
the Minecraft server remained published, along with lifecycle and HTTPS/DNS
regressions. See [the SMB verification results](smb-live-verification.md#validation-boundary)
for the shared validation summary. Final release checks remain in #28.
