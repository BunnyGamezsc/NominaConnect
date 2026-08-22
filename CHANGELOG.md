# Changelog

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
