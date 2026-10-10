# NominaConnect

Set up DNS, HTTPS and private remote access for services on a Proxmox node.
NominaConnect provisions dedicated LXCs for Technitium, a reverse proxy, a
certificate authority and a VPN, then connects them through a guided CLI.

**Beta.** Local and remote HTTPS, reboot recovery and gateway firewall checks
have passed in the lab. The [field report](docs/bunnytest-tailnet-field-report.md)
records unfinished checks and failures. See the [remaining fix plan](docs/production-check-followups.md)
before treating the current checkout as production ready.

This README describes the current checkout. Unmerged PR features may not be
included in the latest published release.

## Before you start

- Run Nomina as root **on the Proxmox host**, through its shell or SSH.
- Choose a bridge, storage target and downloaded Debian standard LXC template.
  The field test used Debian 12.
- Reserve a separate static IP for each service. Check the subnet, gateway,
  container internet access, available memory and storage before provisioning.
- Choose an internal domain, such as `bunny.internal`.
- For Tailscale, prepare an enrollment auth key and a separate DNS admin API
  token. Proxmox 8.2 or later supports the VPN TUN-device setup used here.
- Keep the host awake during installation and testing. Synchronize its clock
  before certificate issuance and renewal checks.

Clients do not need to supply internet to Proxmox. A nested VirtualBox lab can
keep management on an Ethernet bridge and use an independent NAT adapter for
internet. [Lab network details](tools/lab/README.md).

## Install

The [native installer](https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install-native.sh)
downloads a compiled release without requiring Node.js. Download and inspect
the script, copy it to your Proxmox node, then run it there:

```sh
bash install-native.sh
nomina --version
```

Running the installer again updates the binary and keeps the previous binary
as `/opt/nominaconnect/nomina.bak` by default. Updating Nomina does not upgrade
provisioned services. The [Node.js installer](https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install.sh)
is an alternative. For unreleased PR code, build the checkout using the
[developer instructions](#develop-and-test).

## Set up the platform

Create a project directory on Proxmox:

```sh
mkdir -p /root/my-homelab
cd /root/my-homelab
nomina
```

1. Initialize the project. Choose the node, bridge, storage and domain. For
   the tested flow, select Technitium, Caddy, step-ca and Tailscale.
2. Provision Technitium with a reserved IP and a working bootstrap resolver.
   It cannot resolve through itself before installation.
3. Provision Caddy at another reserved IP. Later containers normally use
   managed Technitium DNS.
4. Provision step-ca before publishing trusted exposures.
5. Publish exposures with the correct backend IP, port and TLS setting.
6. Export and trust the public CA root on clients. Verify local HTTPS.
7. Provision Tailscale. Enable Tailscale DNS on clients and verify the same
   HTTPS names from another network.

Subcommands use the same guided prompts when flags are omitted:

```sh
nomina init
nomina service add technitium
nomina service add caddy
nomina service add step-ca
nomina exposure publish
nomina service add tailscale
```

`nomina.yaml` declares the managed inventory. Private state lives in `.nomina/`;
root-owned credentials live under `/var/lib/nominaconnect/secrets`. Nomina finds
a project in the current directory or a parent. Automation can specify
`--project-dir /root/my-homelab` explicitly.

## Publish HTTPS exposures

Every exposure uses HTTPS **to the client**. `--backend-tls` controls the
connection **from the proxy to the backend**.

| Backend | Example | Backend TLS |
| --- | --- | --- |
| HTTP | Technitium web UI, port 5380 | Omit the flag; answer No |
| HTTPS | Proxmox web UI, port 8006 | Supply `--backend-tls`; answer Yes |

Replace these example addresses and domain with your own:

```sh
nomina exposure publish --name dns --hostname dns.bunny.internal \
  --backend-ip 192.168.1.53 --backend-port 5380

nomina exposure publish --name pve --hostname pve.bunny.internal \
  --backend-ip 192.168.1.3 --backend-port 8006 --backend-tls
```

Open `https://dns.bunny.internal` and `https://pve.bunny.internal`.
Omitting backend TLS does not turn off browser HTTPS. The backend TLS option
accepts appliance certificates without issuer verification on that backend
hop; client-facing HTTPS still requires CA trust. Republish an exposure to
change its settings.

Enable Caddy's HTTP-to-HTTPS redirects separately:

```sh
nomina caddy redirect on
```

There is no `--http-redirect` exposure flag. For a hostname that redirects to
another site instead of using a backend:

```sh
nomina exposure publish --name root --hostname bunny.internal \
  --redirect-to home.bunny.internal
```

Paths and queries are preserved. The default is 308; `--redirect-code 307`
selects temporary redirects. Traefik uses permanent/temporary classes, so
GET/HEAD responses may use 301/302.

## Trust the CA on clients

From the project on Proxmox:

```sh
nomina ca guide
nomina ca export --output /root/step-ca-root.crt
```

Copy the public root certificate to the client. From a Mac:

```sh
scp root@192.168.1.3:/root/step-ca-root.crt ~/Downloads/step-ca-root.crt
```

Compare its fingerprint with the certificate on Proxmox. Import it into
Keychain Access and trust it for SSL. Other clients need their system or
browser trust-store installation. Copy only the public root, never CA private
keys. Trust works for both local and Tailscale access; browser warning bypasses
are unnecessary. Caddy Internal CA is an alternative whose public root also
needs client trust.

## Tailscale access

Provision DNS and the proxy first, then run `nomina service add tailscale`.
The prompts request two different credentials:

| Credential | Purpose |
| --- | --- |
| Auth key | Enroll the service LXC in the tailnet |
| Admin API token with DNS permission | Configure and restore tailnet DNS |

Create them in the [Tailscale admin console](https://login.tailscale.com/admin/settings/keys).
Use the secret prompts. Unattended setup can supply the admin token through
`NOMINA_TAILSCALE_API_TOKEN`. Keep credentials out of CLI arguments and
`nomina.yaml`. Rotate it with `nomina secret change --service tailscale-admin`.

The gateway forwards DNS queries to Technitium. Successful A answers in the
managed domain that point at the proxy are rewritten to the gateway's Tailscale
IPv4 address. Negative and blocked answers remain unchanged. The gateway
forwards TCP 80/443 and opted-in TCP exposure listener ports to the proxy,
restricts other incoming tailnet traffic,
and advertises no LAN subnet route. Gateway IPv6 ingress is blocked.

**DNS setup affects the entire tailnet.** Nomina replaces global nameservers
with this gateway and requests DNS override. MagicDNS is preserved. Setup
refuses split-DNS rules using another resolver. Previous nameservers and the
override setting are saved for removal. Some tailnets omit the override field
from the API; Nomina warns that it could not verify the setting. Check actual
client resolution before relying on it.

Enable Tailscale DNS and trust the CA on every client. Subnet-route acceptance
is not needed for these exposures.

| Client state | Expected result |
| --- | --- |
| Local, Tailscale off | Local Technitium returns the proxy LAN address |
| Local, Tailscale on | Gateway Tailscale address; transport can use local Ethernet/Wi-Fi |
| Away, Tailscale on | Same HTTPS and opted-in TCP names through Tailscale |
| Away, Tailscale off | Internal services unavailable |

A `100.x` DNS answer at home does not prove traffic uses a remote relay.
`tailscale ping <gateway-name>` shows the actual path. Nomina does not change
the DNS answer to the proxy LAN address automatically based on location.

Exposures allow tailnet access by default. To opt out:

```sh
nomina exposure publish --name dns --hostname dns.bunny.internal \
  --backend-ip 192.168.1.53 --backend-port 5380 --tailnet false
```

The intended behavior is HTTP 404 through the gateway and normal direct LAN
access. The hostname still resolves. A local client using Tailscale DNS also
uses the gateway and its restriction. Live acceptance verifies gateway denial,
continued LAN HTTPS and reenablement. The tailnet access policy separately
controls which members can reach the gateway; Nomina does not tighten it.

Use `--hostname` when provisioning to name the LXC. To rename an existing
Tailscale node, find its VMID with `pct list`, then run from Proxmox:
`pct exec <vmid> -- tailscale set --hostname <name>`.

## Verify and troubleshoot

1. Run `dig @<technitium-lan-ip> dns.bunny.internal` and verify the proxy's
   LAN address. Open both HTTPS URLs and check client trust.
2. Connect Tailscale. Run `dig dns.bunny.internal` and
   `tailscale ping <gateway-name>` to check DNS and transport separately.
3. Move the client to a different network, keeping internet and Tailscale.
   Reload the same URLs. Proxmox and its containers need independent internet.
4. Verify intended DNS/web access and blocked gateway administration ports,
   including 22, 2019, 5380 and 8006. Repeat after restarting Tailscale.
5. Before production use, verify host reboot recovery, renewal, backup recovery
   and the disposable lifecycle tests.

| Symptom | Check |
| --- | --- |
| DNS and all browsers stall | Host sleep, gateway online status, physical reachability and client default route. A connected cable does not mean the host is awake. |
| Local DNS fails | Query Technitium directly; check client DNS selection and the managed A record. |
| Remote DNS fails | Tailscale running, client DNS enabled, gateway online, tailnet nameserver and override settings. |
| Certificate warning | Client CA trust, hostname, selected issuer and synchronized clocks. |
| Proxmox exposure fails | Backend TLS must be enabled for port 8006. |
| Package install fails | Container DNS, internet, root-disk space and host thin-pool usage. |
| Services fail after reboot | `pct config <vmid>` should include `onboot: 1`; inspect systemd logs. |

Use `pct list`, `pct config <vmid>` and
`pct exec <vmid> -- journalctl -u <service> --no-pager` on Proxmox. The menu and
`nomina changes` report inspection warnings. Observable provider edits are
adopted; unrelated configuration remains outside the managed inventory.

## Maintenance and removal

Back up the project, private state, credential store, provider data and CA
keys. A public root certificate cannot restore the CA. The field check restored
CA keys/configuration into a disconnected LXC and compared provider-file copies.
Verify a complete replacement deployment against your recovery requirements.

A fresh Technitium installation uses its default `admin` password. Nomina
stores the connection password but does not change the provider's account.
Change the password in Technitium and update Nomina's stored connection secret
before production use. Review the Tailscale admin token's permissions and
expiry, gateway device-key expiry, and old test-device registrations as well.

Use `nomina service upgrade <name>` for explicit upgrades. A pre-upgrade
snapshot is optional when the storage supports it. Removal and destruction
are separate workflows; read the prompt to decide whether to retain an LXC.

Tailscale removal restores saved DNS before destroying its gateway. If another
operator changed DNS settings, resolve the conflict first. `nomina uninstall`
is destructive: it destroys recorded managed/retained LXCs and deletes project
configuration, state and credentials. It stops before destruction if DNS
restoration fails and retains recovery files if destruction is incomplete.
Completed DNS restoration and each destroyed VMID are recorded immediately,
so a retry targets only surviving containers and does not require a deleted
gateway. A successfully destroyed stopped container does not block completion.
Do not use uninstall to update the binary.

If Tailscale enrollment rejects an auth key, choose **Update connection secret**
and then **Recheck provisioning** to retry in the same LXC. Alternatively,
**Destroy a service LXC** deletes the container and its locally stored Tailscale
auth key and admin API token after confirmation. For an untracked container left
by an older version, run `nomina service recheck tailscale --ip <LXC-IP>` first.
These actions do not revoke keys in the Tailscale admin console.

For an emergency per-service deletion when Tailscale DNS cannot be restored,
run `nomina service destroy tailscale --force` and confirm the prompt. This
skips DNS recovery, stores the saved DNS settings in
`.nomina/state.json` under `tailnetDnsRecovery`, and prints a warning. Restore
those settings manually in the Tailscale admin console; `--force` does not
affect the safer behavior of `nomina uninstall`.

## Providers and development

Supported providers: Technitium; Caddy or Traefik; step-ca or Caddy Internal CA;
Tailscale or NetBird. NetBird currently enrolls against NetBird Cloud. The
same-name DNS/web gateway above is the Tailscale integration.

### Develop and test

```sh
npm install
npm test
npm run typecheck
npm run build:native  # requires Bun; builds Linux x64
```

Unit, wire and adapter-conformance tests do not provision infrastructure.
[Live acceptance](docs/live-proxmox-acceptance.md) is separate and requires
explicit disposable-host opt-in. From a Mac, deploy the current binary with:

```sh
bash tools/lab/deploy-local-build.sh root@<proxmox-ip>
```

The helper installs `/opt/nominaconnect-test/nomina-linux-x64`, verifies matching
SHA-256 hashes and leaves the release `nomina` link alone.

## Documentation

- [Docker host bindings and endpoint discovery](docs/docker-hosts.md)

- [Architecture](docs/architecture.md), [domain language](CONTEXT.md), [ADRs](docs/adr/)
- [Interactive CLI](docs/tui.md)
- [Manual DNS/proxy/TLS workflow](docs/manual/dns-proxy-tls.md)
- [Live Proxmox acceptance](docs/live-proxmox-acceptance.md)
- [Current field report](docs/bunnytest-tailnet-field-report.md), [remaining fix plan](docs/production-check-followups.md)
- [Lab tools](tools/lab/README.md), [changelog](CHANGELOG.md)

## TCP and Minecraft Java exposures

Choose TCP in the exposure wizard, then enter the hostname, backend IP, and
backend port. Scripted setup uses the same workflow:

```sh
nomina exposure publish --name minecraft --protocol tcp \
  --hostname mc.example.internal --backend-ip 198.51.100.20 \
  --backend-port 25565 --tailnet true
```

A Minecraft Java client enters `mc.example.internal`. LAN DNS points at the selected
proxy LXC; tailnet DNS returns the gateway's Tailscale address. Both listen on
25565. TCP works with Caddy or Traefik and does not use an HTTP route or request a
certificate. The application retains its own authentication and encryption.

`--listener-port` defaults to the backend port on creation. Republish retains the
saved listener port while updating the backend. Each listener address and port
can serve one backend; choosing another hostname does not make a shared port
possible. Ports used by gateway administration and platform services are reserved.
The initial TCP path supports IPv4. Minecraft Bedrock/UDP is outside this path.

`--tailnet false` removes the exposure's gateway forwarding while keeping LAN
access. DNS may still return the gateway address remotely, where its port is
blocked. Run `nomina service remove minecraft` to disconnect owned DNS and TCP
forwarding. Edited or conflicting resources cause a refusal or verification
warning. Successful TCP health means transport reachability, not a Minecraft join.

Persistent socket forwarding runs in the proxy LXC, independently of the web
proxy process. Its socket and service units are enabled at boot. Gateway port
files are replayed by the existing persistent firewall. See
[the live verification guide](docs/tcp-live-verification.md) for builds, checks,
and the later combined TCP/SMB test stage.

## SMB exposures

Choose SMB in the wizard, or publish an existing Samba LXC, NAS or VM:

```sh
nomina exposure publish --name files --protocol smb \
  --hostname files.example.internal --backend-ip 198.51.100.21 --tailnet true
```

The backend port defaults to 445. Supply `--backend-port 1445` for a server on
another port. The LAN proxy and opted-in Tailscale gateway always listen on TCP
445, so Windows opens `\\files.example.internal\SHARE` and macOS Finder opens
`smb://files.example.internal/SHARE`, without a client port. SMB is saved as a TCP
exposure with `preset: smb`; republish keeps the preset and client port.

Samba owns shares, credentials, permissions and application encryption.
NominaConnect does not provision or administer the backend. Configure the
backend's hostname alias for the chosen name before client testing. The
[Samba fixture and verification guide](docs/smb-live-verification.md) covers
aliases, authenticated file checks and exact inputs for the combined release
stage. A healthy TCP endpoint does not verify SMB authentication or file access.

SMB, Minecraft and HTTPS can coexist. Another backend cannot use the same port
445 listener. Updates, restart persistence, `--tailnet false`, tracking and
`nomina service remove files` use the existing TCP lifecycle.
