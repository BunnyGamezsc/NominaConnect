# Changelog

## [1.4.7] - 2026-08-23 (Dev/Pre-release)

### Added
- **Edit an exposure can flip the backend TLS setting** — the TUI re-asks "Does the backend serve HTTPS/TLS itself?" pre-filled with the stored value.
- **README**: new "Exposing services" section documenting when `--backend-tls` should be on vs off.

## [1.4.6] - 2026-08-23 (Dev/Pre-release)

### Added
- **TLS backends** (`--backend-tls`): publish HTTPS-only services (Proxmox `:8006`, OPNsense, Synology). Persisted as `exposure.backend.tls`; Caddy dials the backend over TLS with skip-verify on the internal hop only.

### Fixed
- **HTTP→HTTPS redirect silently never fired on Caddy 2.11.4** (`protocol` matcher never matches) → dual-server topology (`srv_https` :443 / `srv_http` :80) with automatic legacy `srv0` migration.
- **Duplicate-ID error during srv0 migration** → `srv0` deleted before its routes are recreated.

## [1.4.4] - 2026-08-23 (Dev/Pre-release)

### Fixed
- **HTTP→HTTPS redirect silently never worked on Caddy 2.11.4** — the `protocol` request matcher is silently never matched by that build, so HTTPS requests matched no route and Caddy's JSON-mode default answered an empty `200` (and with redirects off, plain HTTP proxied cleartext). Routes now live on **two dedicated servers** — `srv_https` (:443, TLS routes) and `srv_http` (:80, 308 redirects) — eliminating protocol matchers entirely.
- **Automatic legacy migration**: `publishRoute` migrates old single-server configs (`srv0`) into the new servers — host routes → `srv_https`, hostless catch-alls → `srv_http`, stale scheme pins stripped, then `srv0` removed. Existing containers upgrade in place on the next publish; no manual wipe needed.

## [1.4.3] - 2026-08-23

Stable release: v1.4.2 fixes plus nuclear uninstall. Includes everything since v1.3.15 (HTTP→HTTPS auto-redirect, exposure health retry, Technitium-based LXC DNS, `nomina --version`).

### Added
- **Nuclear uninstall** (`nomina uninstall [--yes]`, TUI `Nuclear uninstall`): destroys every managed LXC recorded in NominaConnect state (provider references + retained services, deduped — unmanaged containers are never touched), then deletes `nomina.yaml`, the `.nomina/` state directory, and `/var/lib/nominaconnect/` (secrets store). Requires explicit confirmation unless `--yes`; per-LXC failures become warnings instead of aborting.
- **HTTP→HTTPS auto-redirect for Caddy exposures** (`nomina caddy redirect on|off`, state-aware TUI toggle): plain-`http://` hits get a `308` to HTTPS.

### Fixed
- **Managed TLS routes also matched plain `:80` traffic** — host-only matcher shadowed the redirect and served cleartext ("Not secure"). Routes are pinned to `protocol: "https://"`; port-80 hits fall through to the redirect.

## [1.4.2] - 2026-08-23 (Dev/Pre-release)

### Fixed
- **Managed TLS routes also matched plain `:80` traffic** — the matcher was host-only, so with redirects enabled the TLS route shadowed the 308 and exposures were served in cleartext ("Not secure"). Routes are now pinned to `protocol: "https://"`; port-80 hits fall through to the redirect.

## [1.4.1] - 2026-08-23 (Dev/Pre-release)

### Added
- **HTTP→HTTPS auto-redirect for Caddy exposures** — `nomina caddy redirect on|off` (and a state-aware TUI toggle) persists the preference and re-publishes every exposure. With it enabled, plain-`http://` hits get a `308` to `https://`, so typing `dns.bunny.internal` without a scheme lands on TLS in any browser. Redirect routes are implementation detail: invisible to inspection/adoption, removed with unpublish, idempotent on republish.

## [1.4.0] - 2026-08-23

Major hardening release: everything learned from the live `bunny.home` → `bunny.home.arpa` → `bunny.internal` migration on a real homelab.

### Added
- **`nomina --version` / `nomina version`** — prints the CLI version (install scripts and channel checks).
- **Exposure health retry** — publish now waits (bounded, with backoff) for ACME issuance to complete instead of reporting a false `unhealthy` while step-ca is still signing.
- **Caddy persistence on upgrade** — `nomina service upgrade caddy` installs the systemd drop-in that survives restarts on pre-existing containers (previously only new installs got it).

### Changed
- **BREAKING**: newly provisioned service LXCs resolve DNS through **Technitium** instead of the network gateway (`src/provisioning.js`). Router resolvers answer local zones with bogus AAAA/rebind-blocked records, which silently broke ACME challenge validation inside the CA container ("authorization took too long"). Gateway remains the fallback for Technitium itself; explicit `--nameserver` still wins.

## [1.3.15] - 2026-08-23

Stable release: squash of dev v1.3.6–v1.3.14 plus new features below.

### Added
- **Change the local domain from the CLI/TUI** (`nomina domain change <new-domain>`, TUI `Change the local domain`): migrates every exposure to a new base local domain end-to-end — renames hostnames in `nomina.yaml`, cleans up old Technitium records and Caddy routes (cleanup failures become non-blocking warnings), extends step-ca `dnsNames` SANs for `step-ca.<new-domain>` and restarts it, re-pins/re-trusts the CA in the Caddy LXC, republishes each exposure (fresh ACME certs under the new names), and persists live Caddy config.
- **Export the step-ca root certificate** (`nomina ca export [--output step-ca-root.crt]`, TUI `Export step-ca root certificate`): fetches the root (via `pct exec`, HTTPS fallback), writes it to disk, and prints scp retrieval plus per-device install steps (macOS/Windows/Linux/Firefox/iOS/Android).

### Fixed
- **Exposure DNS pointed at backend instead of Caddy** — Technitium `A` now publishes the reverse-proxy IP; backend only in Caddy's `reverse_proxy` dial.
- **step-ca exposures failed ACME issuance** (`x509: ... no IP SANs`) — ACME directory URL uses the CA hostname (`step-ca.<baseLocalDomain>`), init requests that SAN, and publish pins/trusts the CA name+root in the Caddy LXC before issuing.
- **Caddy restart wiped published routes/TLS policies** — installer adds a systemd drop-in preferring persisted `/etc/caddy/caddy.json`; publish/remove dump live config after each mutation.
- Exposure remove/edit picker fixes (NominaConnect ID resolution, platform-key collision).

## [1.3.14] - 2026-08-23 (Dev/Pre-release)

### Fixed
- **step-ca exposures failed ACME issuance: `x509: cannot validate certificate for <caIp> because it doesn't contain any IP SANs`** (live exposure trial on `nuc`):
  - ACME directory URL now uses the CA **hostname** `step-ca.<baseLocalDomain>` instead of the bare IP (`src/exposure.js` `tls.caHost`, `src/caddy-adapter.js` `issuerFor` prefers hostname, IP kept as fallback for older projects).
  - `step ca init` now requests the SAN: `--dns "$(hostname -f),localhost,step-ca.<zone>"` (`src/step-ca-adapter.js`).
  - `exposure publish` prepares the Caddy LXC before issuance: pins `<caIp> step-ca.<zone>` into `/etc/hosts` and installs the CA root into `/usr/local/share/ca-certificates` + `update-ca-certificates` (`src/cli.js`, idempotent).
- **Caddy restart wiped all published routes and TLS policies** (admin-API config is ephemeral; unit loaded only `/etc/caddy/Caddyfile`): installer writes systemd drop-in `nomina-persistence.conf` that prefers persisted `/etc/caddy/caddy.json`; publish/remove now dump live config to that file after every mutation (`src/cli.js`).

## [1.3.13] - 2026-08-23 (Dev/Pre-release)

### Fixed
- **Remove an exposure: Service nc_… not found** — `promptExposureServiceName` (`src/tui.js:820`) now correctly returns stable `s.id` (`nc_…`) to avoid collision with platform key `dns`, but `removeService` (`src/cli.js:886`) only matched by `s.name`/`s.exposure.hostname`. Add `s.id === resolvedServiceName` check so `Remove an exposure` → `technitium (dns.bunny.home)` (`nc_86331352…`) resolves.

## [1.3.12] - 2026-08-23 (Dev/Pre-release)

### Fixed
- **Exposure DNS pointed at backend instead of Caddy** (`src/exposure.js:48` `publishRecord` used `backendIp` for the `A` record). `curl https://<hostname>` resolved `dig +short` to `192.168.4.90:443` (backend) not the reverse-proxy, so `Caddy` was bypassed and `443 Connection refused`. Now publishes `A → proxyRef.ip` (`reverseProxy` `caddy`/`traefik` `10.0.0.54`) and `Caddy` `reverse_proxy dial → backendIp:backendPort`. Existing exposures keep `exposure.backend` in `nomina.yaml`; only the `A` is repointed. Tests at `test/exposure-publish.test.js:1`.

## [1.3.11] - 2026-08-23 (Dev/Pre-release)

### Fixed
- **Edit an exposure jumped straight to Backend IP** (`src/tui.js:820` `promptExposureServiceName` auto-returned when only one exposure existed). Picker (`Which exposure would you like to manage?`) now always renders, so `Edit an exposure` shows the list first (`src/tui.js:392`).

## [1.3.10] - 2026-08-23 (Dev/Pre-release)

### Fixed
- **Remove an exposure deleted Technitium and Edit showed wrong prompt** (`src/tui.js:787` `promptRemoveServiceName` listed exposures alongside platform services; `src/tui.js:820` `promptExposureServiceName` returned `s.name` which collides with platform key `dns` in `src/cli.js:831` `key === resolvedServiceName`). `Remove a managed service` now lists only managed platform inventory (`dns`, `reverseProxy` `caddy`/`traefik`, `certificateAuthority` `step-ca`/`caddy-internal-ca`, `vpn` `tailscale`/`netbird`); exposures are isolated to `Edit an exposure` / `Remove an exposure` via `promptExposureServiceName` returning stable `s.id`. `Edit an exposure` now shows the exposure picker list first, then prompts `Backend IP`/`Backend port` with current `exposure.backend` as defaults (`src/tui.js:392`).

## [1.3.9] - 2026-08-23 (Dev/Pre-release)

### Added
- **Edit and remove exposures from the Interactive CLI** (`src/tui.js:121` `hasExposures`/`canEditExposure`/`canRemoveExposure`, `src/tui.js:186` `buildMenuOptions`, `src/tui.js:358` `runInteractiveApp`): when at least one exposure exists, the main menu now shows `Edit an exposure` (re-prompt `Backend IP`/`Backend port` with current values as defaults and re-publish via `exposure publish` — same `src/cli.js:58` `publishManagedExposure` upsert `src/config.js:upsertManagedExposure`, so unchanged `nomina.yaml` fields keep their value) and `Remove an exposure` (select via `promptExposureServiceName` and disconnect via `service remove` `src/cli.js:886` `technitium.unpublishRecord` + `proxy.unpublishRoute`). Delete remains available as the generic `Remove a managed service` / `Destroy a service LXC` entries for platform LXCs.

## [1.3.8] - 2026-08-23 (Dev/Pre-release)

### Fixed
- **Exposure publish failed: `Caddy Admin API POST /config/apps/http/servers/srv0/routes failed with status 500: {"error":"invalid traversal path at: config/apps/http"}`** — verified against real Caddy v2.11.4; three independent defects (`src/caddy-adapter.js`, new `test/caddy-adapter-wire.test.js`):
  - Route payload carried a `tls` field, which is not a valid Caddy `Route` field (config load fails `unknown field "tls"`). TLS issuer now lives in `apps.tls.automation.policies` keyed by subject — `acme` + step-ca directory URL (`https://<caIp>:9000/acme/acme/directory`) when step-ca is selected, `{module:"internal"}` otherwise; trust is derived from the policy wire state by `healthCheckExposure`/`inspect`.
  - `routes` is an array, so hostname-keyed PUT/DELETE could never work (`invalid array index` / traversal errors). Upserts rewrite the whole array via DELETE→PUT (Caddy PUT over an existing key returns `409 key already exists`), inserting host routes *before* hostless catch-alls — otherwise the installer's `:80 { respond "OK" }` route shadows every published exposure.
  - `createHttpClient` used `globalThis.fetch`, which sends `sec-fetch-mode: cors`; current Caddy admin endpoints reject browser-like requests with `403 client is not allowed to access from origin ''`. Default transport is now `node:http`/`node:https` sending only explicit headers (`src/adapter-runtime.js`). Injectable `options.fetch` path kept for tests.

## [1.3.7] - 2026-08-23 (Dev/Pre-release)

### Added
- **step-ca trust guide** (`nomina ca guide` / `View step-ca trust guide`): `src/ca-guide.js` `getStepCaTrustGuide` prints CA IP/vmid-aware instructions to fetch `root_ca.crt` (`pct exec <vmid> -- cat /var/lib/stepca/certs/root_ca.crt` or `curl -k https://<caIp>:9000/roots.pem`) and install on macOS/Windows/Linux/iOS/Android/Firefox; `nomina ca cert` exports the cert via `pct exec` or `https://<caIp>:9000/roots.pem`. Answers "when I add a new exposure, will it get a step-ca cert?" — yes, when `step-ca` is selected and provisioned, `Caddy` requests via `ACME https://<caIp>:9000/acme/acme/directory` with `tls.trusted:true`; without trusting the root, browsers show untrusted but still HTTPS.

## [1.3.6] - 2026-08-23 (Dev/Pre-release)

### Changed
- Dev sync to `main` `v1.3.5` (step-ca `step-ca.service` STEPPATH fix) — publishes dev channel with the fix for `curl -fsSL .../dev/install-native.sh | bash -s dev`.

## [1.3.5] - 2026-08-23

### Fixed
- **step-ca init succeeded but `Failed to enable unit: Unit step-ca.service does not exist`** (`Generating root certificate... done! ... Your PKI is ready ... Failed to enable unit`): `step ca init` wrote to `/root/.step` (`$HOME/.step`) not `/var/lib/stepca`, and the `step-ca` Debian package provides no systemd unit on `debian-13`. `STEP_CA_INSTALL` now uses `STEPPATH=/var/lib/stepca`, creates `/etc/systemd/system/step-ca.service` (`Environment=STEPPATH=/var/lib/stepca ExecStart=/usr/bin/step-ca --password-file /var/lib/stepca/password.txt /var/lib/stepca/config/ca.json`), `daemon-reload` and `enable --now`. Retry after `pct stop 102; pct destroy 102`.

## [1.3.3] - 2026-08-23

### Fixed
- **step-ca `step: command not found` / `Unit step-ca.service does not exist`** (`pct exec 102 -- ... step ca init ... exited with status 1`): `STEP_CA_INSTALL` only installed `step-ca`, but `step ca init` needs `step-cli`. Now `apt-get install --yes step-ca step-cli` (and `upgrade` installs both). Retry after `pct stop 102; pct destroy 102`.

## [1.3.1] - 2026-08-23

### Fixed
- **step-ca APT key 404** (`curl: (22) The requested URL returned error: 404 gpg: no valid OpenPGP data found`): `https://packages.smallstep.com/keys/apt/GPG-KEY.asc` was removed upstream. `STEP_CA_INSTALL` now uses `https://packages.smallstep.com/keys/apt/repo-signing-key.gpg` → `/etc/apt/keyrings/smallstep.asc` and `DEB822` `smallstep.sources` (`Types: deb URIs: https://packages.smallstep.com/stable/debian Suites: debs`) per https://smallstep.com/docs/step-ca/installation. Retry after `pct stop 102; pct destroy 102` and `curl -fsSL .../main/install-native.sh | bash`.

## [1.3.0] - 2026-08-23

### Added
- **Real step-ca certificate authority with trusted Caddy exposures** (#17):
  - New `src/step-ca-adapter.js` (`createStepCaAdapter`) manages a dedicated unprivileged Debian LXC (`STEP_CA_DEPLOYMENT` `2 CPU/512 MB/4 GB`, `debian-12-standard`) via `pct` and `step-ca` smallstep APT repository (`apt-get install step-ca` `180s`, `step ca init` standalone `NominaConnect CA` on `:9000` with ACME provisioner)
  - `Caddy` adapter now publishes trusted routes via `step-ca` ACME (`https://<caIp>:9000/acme/acme/directory`, `tls.trusted:true`) and retains untrusted HTTPS (`tls.trusted:false` `issuer: internal`) when no CA is selected — never falls back to HTTP
  - `exposure publish` resolves `step-ca` `https://<ip>:9000` endpoint (vs `caddy-internal-ca` `http://<ip>:2019`), verifies CA health (`GET /health`) and ACME directory (`GET /acme/acme/directory` → `/roots.pem` fallback), and reports `certificateAuthority: {tls: valid|unreachable|invalid}` as a precise verification warning when issuance/trust/reachability fails (`src/exposure.js:103` `caEndpoint`, `src/caddy-adapter.js:330`)
  - Dedicated LXC lifecycle (`provision`, `inspect`, `healthCheck`, `explicit upgrade` via `apt-get install --only-upgrade --yes step-ca`), `inspect` preserves unmanaged provisioners and `healthCheckExposure` distinguishes trust/issue vs reachability

### Fixed
- **Promotes dev pre-releases 1.2.4–1.2.6 to stable** (previously dev-only):
  - `Recheck provisioning` (`nomina service recheck`) to adopt orphaned LXCs after transient `HttpRequestError` left `state.json` unwritten
  - `Caddy Admin API` now `0.0.0.0:2019` with `:80 { respond "OK" 200 }` server; `listRoutes`/`publishRoute` handle `400 invalid traversal` by ensuring `srv0` (`PUT /config/apps/http/servers/srv0`)
  - `IP preflight` via `pct config` `net0` `ip=` scan (not just `pct list`) and `runAdoptionPass` now passes `connectionSecretReference`/`ip`/`zone` to `inspect`/`healthCheck` to avoid `Technitium API endpoint is required` warnings

## [1.2.6] - 2026-08-23 (Dev/Pre-release)

### Fixed
- **Caddy recheck 400 invalid traversal** (`Caddy Admin API /config/apps/http/servers/srv0/routes failed with status 400`): `Caddyfile` was `{ admin 0.0.0.0:2019 }` with no `http` server, so `GET /config/apps/http/servers/srv0/routes` → `400`. `listRoutes` now treats `400`/`invalid traversal` as empty, `publishRoute` ensures `srv0` via `PUT /config/apps/http/servers/srv0 {listen:[":80",":443"],routes:[]}`, and `CADDY_INSTALL` now writes `:80 { respond "OK" 200 }`.

## [1.2.5] - 2026-08-22 (Dev/Pre-release)

### Fixed
- **Recheck found no LXC and tracking warned `Technitium API endpoint is required`**:
  - `checkIpAvailability` (`src/adapter-runtime.js:183`) only grepped `pct list` (no IP column on `nuc`, e.g. `100 running technitium`), so `192.168.4.86` on `101` was missed and `recheck` errored `No existing LXC found`; now falls back to `pct config <vmid>` `net0` `ip=` scan for each `VMID` from `pct list`
  - `runAdoptionPass` (`src/adoption.js:185`) only passed `providerReferences` to `technitium`/`caddy` `inspect`/`healthCheck`, so `resolveEndpoint` threw `Technitium API endpoint is required` and pending `Failed to inspect technitium…` warning persisted; now passes `connectionSecretReference`/`ip`/`zone` (`caddy-internal-ca` falls back to `caddy` `ip`) and `proxy` exposure health also gets `ip`
  - Test fixture `pct config` now vmid-aware (`100` → `pve` `10.0.0.1`, `120` → `technitium` `10.0.0.53`) to keep `184` tests passing

## [1.2.4] - 2026-08-22 (Dev/Pre-release)

### Added
- **Recheck provisioning to adopt existing LXC** (`dev:22cc0b0` + `c11bb46`):
  - New `Recheck provisioning` TUI entry (`src/tui.js:95` `canRecheckProvisioning` → `buildMenuOptions`) appears when any platform service has a secret reference but no `providerReferences` (e.g. Technitium `192.168.4.90` `vmid 100` left running after `Unable to connect…` before `state.json` was written). Routes to `nomina service recheck` (`src/cli.js:135` `handleServiceCommand` → `recheckService`).
  - `nomina service recheck [service] --ip <ip> --project-dir /root` finds the orphaned LXC via `proxmox.checkIpAvailability` (`known-collision lxc/100`), `pct config <vmid>` → `inspectLxc`, `withBoundedRetry` health (`GET /api/user/session/get` for Technitium, `GET /config/` for Caddy) and writes `providerReferences`/`deployment` without `pct create`. Use `nomina` → `Recheck provisioning` → `technitium` → `192.168.4.90` or `nomina service recheck caddy --ip 192.168.4.86`.

### Fixed
- **Caddy Admin API only listened on localhost** (`ss 127.0.0.1:2019`, `admin endpoint started localhost:2019`, host `curl http://192.168.4.86:2019/config/ → Connection refused`): `src/caddy-adapter.js:11` `CADDY_INSTALL` now ends with `printf '{\n  admin 0.0.0.0:2019\n}\n' > /etc/caddy/Caddyfile && systemctl enable --now caddy && systemctl restart caddy` (`30s`). Future `nomina service add caddy` is reachable at `http://192.168.4.86:2019`; existing `101` fix: `pct exec 101 -- bash -c 'printf "{\n  admin 0.0.0.0:2019\n}\n" > /etc/caddy/Caddyfile && systemctl restart caddy'`.

## [1.2.3] - 2026-08-22

### Fixed
- **Caddy provisioning raced the service start** (same `Unable to connect. Is the computer able to access the url?` as `1.2.1` for Technitium, now for `caddy`):
  `nomina service add caddy` finished `apt-get install caddy` (`120s` timeout) then immediately `GET http://<ip>:2019/config/` / `GET /config/apps/http/servers/srv0/routes` for `inspect`/`healthCheck`. On `debian-13/1 CPU` Caddy’s `systemd` unit wasn’t yet listening, so `HttpRequestError` aborted provisioning before `state.json` was written (orphaned LXC, blocked IP retry).
  - `caddy-adapter` final `apt-get install caddy` now `timeoutMs: 180_000`
  - `provisionPlatformService` now uses `8×3s, backoff 1.5` (`~146s` total) for `configure`/`inspect` and `6×2s` for `healthCheck`, so transient `ECONNREFUSED` while Caddy boots is retried
  - Verify on `nuc` after `Technitium` on `192.168.4.90`: `pct list`, `pct config <vmid>`, `pct exec <vmid> -- systemctl is-active caddy; ss -tlnp | grep 2019; curl -s http://127.0.0.1:2019/config/`

## [1.2.2] - 2026-08-22

### Added
- **Update connection secret from the TUI** (`nomina secret change`):
  - New `Update connection secret` menu entry (`src/tui.js:98` `canUpdateConnectionSecret` → `buildMenuOptions`) appears once any secret reference and provisioned service exist (e.g. after `Technitium` on `192.168.4.90`); routes to `nomina secret change` (`src/cli.js:49` `handleSecretCommand`)
  - `src/cli.js:147` `changeConnectionSecret` + `src/tui.js:766` `promptSecretServiceName` list platform services/exposures with masking (`src/secrets.js:12` `clack.password`), then `src/secrets.js:13` `updateConnectionSecret` overwrites the root-owned `0700`/`0600` file in `/var/lib/nominaconnect/secrets/` via `secretStore.store`
  - Use after changing the Technitium password in its UI (`admin` → new): run `nomina` → `Update connection secret` → pick `technitium (dns)` → enter new password → `Connection secret for Technitium updated.` — no manual `printf`/`chmod` needed
  - CLI also supports `nomina secret change --service technitium --project-dir /root` for scripts

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
