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

With `--backend-tls`, Caddy dials the backend over TLS with
`insecure_skip_verify` — that only relaxes the **Caddy → backend** hop against
the appliance's self-signed certificate. The **client → Caddy** hop stays fully
trusted via step-ca.

The interactive TUI asks "Does the backend serve HTTPS/TLS itself?" during
publish, and again when editing an exposure (pre-filled with the current
value). The flag is stored in `nomina.yaml` (`exposure.backend.tls`) and
survives domain changes, redirect toggles, and edits. Changed your mind?
Re-publish the same exposure with/without the flag to flip it.

## Experimental Real Adapters (v1.1)

**Status: Beta/Experimental**

NominaConnect 1.1 introduces the first real provider adapter for Technitium DNS.
This replaces the previous test-only adapters with actual Proxmox LXC provisioning
and live Technitium API integration.

**Currently Supported:**
- ✅ Technitium DNS (real LXC creation + API operations)
- ⏳ Caddy reverse proxy (coming soon)
- ⏳ Traefik reverse proxy (coming soon)
- ⏳ step-ca certificate authority (coming soon)
- ⏳ Caddy Internal CA (coming soon)
- ⏳ Tailscale VPN (coming soon)
- ⏳ NetBird VPN (coming soon)

**What This Means:**
- The Technitium adapter now creates real Debian LXCs on your Proxmox host
- DNS records are managed through the live Technitium API (port 5380)
- Provider credentials are stored securely in root-owned local files
- All operations include timeout, secret redaction, and structured error handling

**Known Limitations:**
- Only Technitium is fully implemented as a real adapter
- Other providers still use test/generic adapters
- Production use of the Technitium adapter is experimental
- Backup and disaster recovery procedures are still being refined

**Roadmap:**
Future releases will add real adapters for the remaining providers (Caddy, Traefik,
step-ca, etc.) to complete the production adapter implementation.

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
- [Domain language](CONTEXT.md) — ubiquitous terms used across the project.
- [ADRs](docs/adr/) — recorded implementation decisions.
- [Changelog](CHANGELOG.md) — version history and changes.

## Principles

- One visible `nomina.yaml` declares the managed inventory.
- Infrastructure (DNS, proxy, CA, VPN) is established before applications.
- Users select named software, not vague capabilities.
- The interactive TUI is the default; flags exist for automation and tests.
- Generated provider configuration is inspectable; NominaConnect adopts observable changes.

## Repository map

- `bin/nomina.js` — entry point; wires the TUI and Proxmox adapters.
- `src/cli.js` — command handlers shared by the menu and subcommands.
- `src/tui.js` — menus and guided prompts.
- `src/prompts.js` — production prompt adapter (`@clack/prompts`).
- `examples/homelab.yaml` — illustrative legacy system definition format.
