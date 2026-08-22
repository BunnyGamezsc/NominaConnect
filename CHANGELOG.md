# Changelog

## [1.1.4] - 2026-08-22 (Dev/Pre-release)

### Fixed
- **Provisioning crashed with `ENOENT ... statx '/var/lib/nominaconnect/secrets/...'`**:
  `nomina init` wrote connection secret references into `nomina.yaml`, but nothing ever
  collected the credential or created the referenced file in the local secret store, so the
  first provider call failed while reading the missing secret file.
  - All service add flows, `service upgrade`, and Caddy Internal CA setup now ensure the
    connection secret exists before touching the provider
  - When missing, the CLI prompts once with masked input and stores it in the secure local
    secret store (root-owned directory 0700, file 0600)
  - Stored secrets are reused silently; scripted runs without a prompt fail with a clear
    error instead of a raw ENOENT stack trace

## [1.1.3] - 2026-08-22 (Dev/Pre-release)

### Fixed
- **Fresh LXCs had no outbound network**: containers were created with a static IP but no
  gateway or nameserver, so apt and the Technitium installer failed inside the container with
  "Temporary failure resolving 'deb.debian.org'".
  - `pct create` now configures `gw=` on net0 and passes `--nameserver`
  - Gateway derives from the service IP (`x.y.z.1`); nameserver defaults to the gateway
  - Override per service with new `--gateway` / `--nameserver` flags; both persist to `nomina.yaml`

## [1.1.2] - 2026-08-22

### Fixed
- **Technitium provisioning on minimal Debian templates**: the install plan used `/usr/bin/curl`
  as its first command, which does not exist on freshly created LXCs (exit 127, "No such file or
  directory - Failed to exec /usr/bin/curl"). The plan now runs `apt-get update` and installs
  `curl` + `ca-certificates` inside the LXC before downloading the Technitium installer.

## [1.1.1] - 2026-08-22

### Fixed
- **LXC template selection**: provisioning no longer hardcodes `debian-12-standard`, which failed
  on hosts without that template ("Template debian-12-standard was not found on a vztmpl storage")
  - All providers (Technitium, Caddy, Traefik, step-ca, Tailscale, NetBird) now offer a template
    selector during service setup, populated from templates detected on the host's `vztmpl`
    storages via `pvesm`/`pveam`
  - New `--template` flag accepts any template volume ID for scripted provisioning
  - The chosen template is recorded in the service's deployment config in `nomina.yaml`
  - Clearer error message when a selected template cannot be found

### Added
- Proxmox adapter exposes `listTemplates()` for discovering available LXC template volumes

## [1.1.0] - 2026-08-22 (Beta/Experimental)

### Added
- **Experimental Real Adapters**: First production adapter implementation for Technitium DNS
  - Real Proxmox LXC creation with prerequisite validation (storage, template, bridge, IP, unprivileged)
  - Live Technitium API integration for DNS zone and record management
  - HTTP client with timeout and secret redaction for provider API calls
  - Secure credential storage via root-owned local secret mechanism
  - Fingerprint-based record operations to preserve unrelated records
  - Comprehensive test coverage for Proxmox validation and Technitium adapter

### Changed
- **Refactored Provider Plugin**: Consistent request building via `providerRequest` helper
- **Enhanced Proxmox Adapter**: Added LXC inspection via `pct config` parsing
- **Improved Provisioning**: Added provider context bundling and configure step

### Known Limitations (Beta/Experimental)
- Only Technitium DNS is fully implemented as a real adapter
- Other providers (Caddy, Traefik, step-ca, etc.) still use test/generic adapters
- Production use of the Technitium adapter is experimental
- Backup and disaster recovery procedures are still being refined

### Security
- All provider credentials are redacted from logs, error messages, and command output
- Connection secrets stored in root-owned mode 0600 files
- HTTP requests include automatic timeout and abort controller

## [1.0.0] - Previous Release

### Added
- Initial MVP release with test-only adapters
- Declarative homelab infrastructure platform for Proxmox
- Interactive TUI for project initialization and service management
- Fake adapters for development and testing
- DNS, reverse proxy, certificate authority, and VPN service abstractions
