# Changelog

## [1.2.1] - 2026-08-22

### Fixed
- **Technitium provisioning raced the service start** (`Unable to connect. Is the computer able to access the url?`):
  `nomina service add technitium` created the LXC and ran the Technitium installer (`curl` → `bash /tmp/technitium-install.sh`), then immediately called the Admin API (`POST /api/user/login`, `GET /api/user/session/get`, `GET /api/zones/...`). On slower templates (debian-13, 1 CPU) the `dotnet` process wasn’t listening on `:5380` yet, so `configure`/`inspect` threw `HttpRequestError` and the CLI aborted before writing `state.json` (leaving a running LXC `100` with no provider reference and a blocked retry on the same IP).
  - `technitium-adapter` install step `bash /tmp/technitium-install.sh` now runs with `timeoutMs: 180_000` (was 30s default) to avoid premature `SIGTERM`
  - `caddy-adapter` final `apt-get install caddy` now runs with `timeoutMs: 120_000`
  - `provisionPlatformService` (`src/provisioning.js:128`) now wraps `configure`, `inspect`, and `healthCheck` in `withBoundedRetry` (`maxRetries 6`, `baseDelay 2s`, `backoff 1.5` → ~25s total) so a transient `ECONNREFUSED`/`HttpRequestError` while `dotnet` boots is retried, then health is preserved
  - Verifies on `nuc` with `192.168.4.90` (`vmbr0`, `gw 192.168.4.1`, `ping 192.168.4.90`, `curl http://192.168.4.90:5380/api/user/login → 200`, `ss -tlnp *:5380 dotnet`)

## [1.2.0] - 2026-08-22

### Added
- **Publish real Caddy HTTPS exposures via Admin API** (#15):
  - Production Caddy adapter installs Caddy in a dedicated LXC and configures routes through the local Admin API (`:2019`) with targeted `PUT`/`GET`/`DELETE` — never replaces the whole Caddy configuration
  - Managed provider reference records the provider-native config path and SHA256 fingerprint
  - `nomina exposure publish` creates or updates only the resolved managed Technitium `A` record and Caddy route, preserving unrelated DNS records and Caddy routes
  - Every exposure is HTTPS; without a configured CA it serves an untrusted internal certificate rather than falling back to HTTP
  - Caddy Internal CA configures trusted exposures in the existing Caddy LXC (no separate CA LXC) via `caddy trust`
  - Direct edits to a uniquely matched managed route are adopted after verified health check; ambiguous or unrelated routes are preserved with a verification warning
  - Explicit upgrade via `nomina service upgrade caddy` (`apt-get install --only-upgrade`), health checks (`GET /config/`), and Proxmox prerequisite validation (storage, template, bridge, IP, unprivileged)

### Fixed
- **Provisioning crashed with `ENOENT ... statx '/var/lib/nominaconnect/secrets/...'`** (1.1.4):
  `nomina init` wrote connection secret references into `nomina.yaml`, but nothing ever
  collected the credential or created the referenced file in the local secret store, so the
  first provider call failed while reading the missing secret file.
  - All service add flows, `service upgrade`, and Caddy Internal CA setup now ensure the
    connection secret exists before touching the provider
  - When missing, the CLI prompts once with masked input and stores it in the secure local
    secret store (root-owned directory 0700, file 0600)
  - Stored secrets are reused silently; scripted runs without a prompt fail with a clear
    error instead of a raw ENOENT stack trace

- **Fresh LXCs had no outbound network** (1.1.3): containers were created with a static IP but no
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
