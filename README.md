# NominaConnect

NominaConnect is a declarative homelab infrastructure platform for Proxmox.
It helps operators set up and connect DNS, reverse proxy, certificate authority,
and VPN services without manually transcribing the same hostnames and IPs between
tools.

## Installation

Choose your installation method:

**Native binary (recommended, no Node.js required):**
```bash
curl -fsSL https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install-native.sh | sudo bash
```
*Automatically downloads the latest release from GitHub.*

**Node.js version:**
```bash
curl -fsSL https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install.sh | sudo bash
```

## Quick start

On your Proxmox host:

```bash
sudo nomina
```

That opens the interactive menu. Choose **Initialize a new project** on first
run, then **Provision Technitium DNS**, **Provision Caddy reverse proxy**, and
**Publish a web exposure** as you bring the platform online.

## Exposing services (HTTP vs HTTPS backends)

Every exposure is published as **HTTPS to the client** (via Caddy + your CA).
The question is what the **backend** itself speaks — and NominaConnect needs to
know, because dialing a TLS-only service in plaintext produces garbage
responses or infinite redirect loops.

| Backend type | Examples | `--backend-tls`? |
| --- | --- | --- |
| Plain HTTP | Node/Python apps, Technitium UI (`:5380`), most self-hosted web apps | ❌ leave it off |
| TLS-only appliance | Proxmox UI (`:8006`), OPNsense, Synology DSM, routers | ✅ switch it on |

**Rule of thumb:** if you would normally visit the backend with `https://`
(and click through a self-signed warning), turn `--backend-tls` on.

```bash
# Plain HTTP backend (default):
nomina exposure publish --name photos --hostname photos.bunny.internal \
  --backend-ip 192.168.4.10 --backend-port 3000 --project-dir /root

# HTTPS-only backend:
nomina exposure publish --name pve --hostname pve.bunny.internal \
  --backend-ip 192.168.4.1 --backend-port 8006 --backend-tls --project-dir /root
```

With `--backend-tls`, the reverse proxy dials the backend over TLS with
verification relaxed (`insecure_skip_verify` on Caddy, `insecureSkipVerify` on
a Traefik `serversTransport` scoped to that one service) — that only relaxes the
**proxy → backend** hop against the appliance's self-signed certificate. The
**client → proxy** hop stays fully trusted via step-ca.

The interactive TUI asks "Does the backend serve HTTPS/TLS itself?" during
publish, and again when editing an exposure (pre-filled with the current
value). The flag is stored in `nomina.yaml` (`exposure.backend.tls`) and
survives domain changes, redirect toggles, and edits. Changed your mind?
Re-publish the same exposure with/without the flag to flip it.

## Redirect exposures (no backend)

A hostname can redirect to another URL instead of proxying to a backend.
Useful for apex to app moves like `bunny.internal` → `home.bunny.internal`.
DNS and TLS work the same (A record to the proxy, trusted cert via step-ca),
but no backend IP or port is needed. Path and query are preserved.

```bash
# 308 Permanent is the default and recommended (cached, preserves method):
nomina exposure publish --name root --hostname bunny.internal \
  --redirect-to home.bunny.internal --project-dir /root

# 307 Temporary instead (not cached, preserves method):
nomina exposure publish --name root --hostname bunny.internal \
  --redirect-to home.bunny.internal --redirect-code 307 --project-dir /root
```

`--redirect-to` accepts a bare hostname (`home.bunny.internal`) or a full URL
(`https://home.bunny.internal`). The wizard asks "Is this a redirect to
another URL?" during publish and edit, then the target and the code (308
recommended, 307 temporary). Stored in `nomina.yaml` as `exposure.redirect`
and supported on both Caddy and Traefik.

Status-code note: Caddy serves the exact 307/308. Traefik only distinguishes
permanent vs temporary, so GET/HEAD redirect with 301/302 while requests with
a body keep their method with 308/307. The stored code selects the class.

## Real Provider Adapters

**Status: Beta**

The installed `nomina` binary composes real adapters by default: commands create
actual Proxmox LXCs and talk to the providers' own control surfaces.

**Currently Supported:**
- ✅ Technitium DNS — real LXC + live Technitium API (`:5380`)
- ✅ Caddy reverse proxy — real LXC + Caddy Admin API (`:2019`)
- ✅ Traefik reverse proxy — real LXC + watched dynamic file directory
- ✅ step-ca certificate authority (Caddy and Traefik exposures)
- ✅ Caddy Internal CA
- ✅ Tailscale VPN — real LXC + `tailscale` client enrolled with a tailnet auth key
- ✅ NetBird VPN — real LXC + `netbird` client enrolled with a setup key

**What This Means:**
- Provider credentials are stored securely in root-owned local files
- All operations include timeouts, secret redaction, and structured errors
- Direct edits made in a provider's own UI or config files are inspected and
  adopted rather than overwritten

**Known Limitations:**
- VPN enrollment needs a credential you create up front: a Tailscale auth key
  (`https://login.tailscale.com/admin/settings/keys` → Generate auth key —
  one-use is fine) or a NetBird setup key. The installer prompts for it, and
  NominaConnect never writes it to `nomina.yaml`, state, or command output.
- Without a certificate authority, Caddy and Traefik exposures serve their own
  self-signed certificate — HTTPS, but untrusted until you select step-ca
- A VPN LXC needs the host's TUN device; NominaConnect adds it with
  `pct set <vmid> --dev0 /dev/net/tun` on Proxmox 8.2 and later, and tells you
  what to add by hand on older hosts
- NetBird enrolls against NetBird Cloud; a self-hosted management server is not
  selectable yet
- Backup and disaster recovery procedures are still being refined

## Tailnet access to exposures

When Tailscale is selected, provision Technitium and Caddy or Traefik first,
then run `nomina service add tailscale`. NominaConnect asks for two different
credentials: a Tailscale **auth key** to enroll its LXC and an **admin API token**
with `dns` permission to configure the tailnet. Both go
into the root-only secret store. For unattended setup, supply the admin token
through `NOMINA_TAILSCALE_API_TOKEN`, not a CLI flag. Rotate it with
`nomina secret change --service tailscale-admin` when needed.

The Tailscale LXC listens for DNS on its Tailscale IPv4 address. It forwards
queries to Technitium, then changes successful A answers for the managed
domain that point to the reverse proxy into the gateway's Tailscale address.
Blocked and negative Technitium answers stay blocked or negative. The gateway
forwards TCP 80/443 to the proxy and refuses other incoming tailnet ports.
It does not advertise any LAN route, so this works regardless of the
installation's LAN subnet and does not route application backends.
NominaConnect makes the gateway the tailnet's sole global nameserver and
enables DNS override. This replaces existing global nameservers so they cannot
bypass Technitium filtering. MagicDNS is preserved. Setup refuses split-DNS
rules pointing at another resolver. NominaConnect saves the prior global
nameserver list and DNS override setting in the private project state, then
restores them when Tailscale is removed or destroyed. If those settings were
changed outside NominaConnect afterward, removal stops and asks you to resolve
the DNS change first. Existing clients do not need to accept subnet routes.

New exposures allow tailnet access by default. The publish and edit prompts
include **Allow this exposure over Tailscale?**; the CLI equivalent is
`--tailnet false` or `--tailnet true` on `nomina exposure publish`. An opted-out
hostname still resolves, but Caddy or Traefik returns 404 to requests forwarded
by NominaConnect's Tailscale gateway. Direct LAN requests remain allowed. The
setting is saved in `nomina.yaml` and survives republishing and domain changes.

With Tailscale connected and DNS override enabled, a device at home also gets
the gateway's Tailscale address. It reaches allowed exposures through the
gateway, and opted-out exposures are refused. NominaConnect does not switch
automatically to direct LAN access based on the client's location. To reach an
opted-out exposure at home, disconnect Tailscale or configure that device to
use local DNS while at home. Automatic switching requires a client-side
network-aware DNS helper. The optional home DNS addon supports macOS, Linux,
and Windows. It checks the home router and a managed DNS answer, then changes
only that client between local and Tailscale DNS. See [the home DNS addon guide](clients/home-dns/README.md).
[Tailscale's DNS override documentation](https://tailscale.com/docs/reference/dns-in-tailscale)
explains why connected clients ignore local DNS settings.

Tailnet devices must use Tailscale DNS. The CA root must
also be trusted on each client for a browser to accept certificates issued by
step-ca or Caddy Internal CA. A device that disables tailnet DNS will not get
the managed hostname behavior while away.

You can also run subcommands directly — they use the same guided prompts when
flags are omitted:

```bash
sudo nomina init
sudo nomina service add technitium
sudo nomina service add caddy
sudo nomina exposure publish
sudo nomina service add          # prompts for which service to provision
```

NominaConnect finds `nomina.yaml` in the current directory or any parent folder.
You do not pass a project path.

## Documentation

- [Architecture](docs/architecture.md) — boundaries, domain terms, desired-state model.
- [Interactive TUI design](docs/tui.md) — menus, prompts, testing seam, adding new flows.
- [MVP spec](docs/specs/nominaconnect-proxmox-cli-mvp.md) — full product requirements.
- [Real Adapters Spec](docs/specs/real-provider-adapters.md) — production adapter implementation plan.
- [Manual reference path](docs/manual/dns-proxy-tls.md) — validation workflow for DNS + proxy + TLS.
- [Live Proxmox acceptance](docs/live-proxmox-acceptance.md) — running the disposable-host acceptance suite.
- [Proxmox test run](docs/proxmox-test-run.md) — worked first-run walkthrough against a disposable host.
- [Proxmox field-test tools](tools/lab/README.md) — Mac binary deployment and optional Mac NAT setup/uninstall.
- [Muse Spark field-test handoff](docs/muse-spark-proxmox-field-tests.md) — clean rebuild and tailnet checks on the VirtualBox test VM.
- [Domain language](CONTEXT.md) — ubiquitous terms used across the project.
- [ADRs](docs/adr/) — recorded implementation decisions.
- [Changelog](CHANGELOG.md) — version history and changes.

## Principles

- One visible `nomina.yaml` declares the managed inventory.
- Infrastructure (DNS, proxy, CA, VPN) is established before applications.
- Users select named software, not vague capabilities.
- The interactive TUI is the default; flags exist for automation and tests.
- Generated provider configuration is inspectable; NominaConnect adopts observable changes.

## Testing

```bash
npm test              # unit, contract, and adapter conformance suites
npm run test:acceptance   # disposable live-Proxmox acceptance run (opt-in)
```

`npm test` includes the adapter conformance suite, which drives every provider
in the initial platform catalog — Technitium, Caddy, Traefik, step-ca, Caddy
Internal CA, Tailscale, NetBird — through the same production adapter set the
installed binary wires, against controlled command and HTTP fixtures. A
provider cannot join the catalog with only partial real behaviour and still
pass. The faster fake-adapter tests remain alongside it as unit coverage.

The acceptance run is opt-in and never runs by accident; see
[docs/live-proxmox-acceptance.md](docs/live-proxmox-acceptance.md).

## Repository map

- `bin/nomina.js` — entry point; wires the TUI and Proxmox adapters.
- `src/cli.js` — command handlers shared by the menu and subcommands.
- `src/tui.js` — menus and guided prompts.
- `src/prompts.js` — production prompt adapter (`@clack/prompts`).
- `test/fixtures/provider-environments.js` — the disposable stand-in for a Proxmox host and the provider catalog.
- `acceptance/live-proxmox.acceptance.mjs` — opt-in acceptance run against a real disposable Proxmox host.
- `examples/homelab.yaml` — illustrative legacy system definition format.
