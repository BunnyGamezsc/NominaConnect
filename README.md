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
- [Manual reference path](docs/manual/dns-proxy-tls.md) — validation workflow for DNS + proxy + TLS.
- [Domain language](CONTEXT.md) — ubiquitous terms used across the project.
- [ADRs](docs/adr/) — recorded implementation decisions.

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
