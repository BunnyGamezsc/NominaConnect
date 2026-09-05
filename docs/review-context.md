# NominaConnect review context

Short guide for code review. What this project is, how it got here, and what to watch for.

## What it does

NominaConnect declares a homelab in one visible file and makes the real infrastructure match without taking over everything around it.

You pick named software from a fixed catalog and NominaConnect provisions it as a dedicated LXC on Proxmox, wires DNS, proxy, and certificate authority together, and keeps the result healthy. It runs as `nomina` on the Proxmox host itself. By default you run it with no arguments and get a guided terminal menu. Flags exist for scripts and tests.

Core idea is managed inventory. Only the services and exposures listed in `nomina.yaml` are managed. Everything else on the provider is left alone. If someone edits a managed record directly in Technitium or Caddy, background tracking inspects the provider, adopts the observed value into `nomina.yaml`, and records it in change history. If matching is ambiguous or the service fails its health check, it leaves provider config alone and surfaces a verification warning instead.

Domain language lives in `CONTEXT.md`. Use those terms in review. Provider reference is not a NominaConnect ID. Adoption is not overwrite. A connection secret is not a plain text config value. Getting the names wrong leads to real design mistakes.

## How it is built

Entry is `bin/nomina.js`. It wires three injectable seams: filesystem, command runner plus HTTP client, and prompts. Production code uses `createProductionAdapters` in `src/adapter-runtime.js`. Tests inject fakes.

```
bin/nomina.js -> src/cli.js + src/tui.js
src/cli.js      command handlers
src/tui.js      menus and guided prompts, built from project context
src/config.js   nomina.yaml plus .nomina/ state and provider references
src/provisioning.js   LXC creation and service setup
src/exposure.js       publishManagedExposure, DNS plus proxy wiring
src/technitium-adapter.js  Technitium DNS API
src/caddy-adapter.js      Caddy Admin API on :2019
src/step-ca-adapter.js    step-ca ACME CA on :9000
src/adoption.js + src/tracking.js   inspection, adoption, bounded retry
src/secrets.js            root owned store at /var/lib/nominaconnect
```

Key properties to preserve:

* Proxmox host control uses `pct exec` from the root shell. No per LXC SSH in the primary path. See ADR-0032.
* Caddy is driven through targeted Admin API calls. The code never replaces the whole Caddy config. Each route has a provider native locator and fingerprint.
* Every exposure is HTTPS. Without a trust providing CA, Caddy serves an untrusted certificate. It never falls back to plain HTTP. See ADR-0016.
* Secrets are referenced in `nomina.yaml`, stored in files with mode 0600, and redacted from logs and errors.
* One Proxmox node, one bridge and storage selected at init, static IP per service supplied by the user with preflight checks, unprivileged Debian LXCs by default, explicit upgrades only.

Tests are `node --test` plus `tsc --noEmit`. Current count is 233. The main seam is the adapter conformance suite. Business logic should be tested through injected adapters, not terminal internals.

## How it evolved

All dates are August 2026. The project moved fast from scaffolding to live hardware in about three days. Releases use `dev` for fast prereleases and squash to `main` for stable. Install channels mirror that split.

### v1.0.0  scaffold
Fake adapters only, TUI plus declarative inventory, homelab.yaml example. Proved the menu and config shape without touching a real host.

### v1.1.0 to v1.1.2  first real provider
Issue 14. Real Technitium adapter landed. Proxmox LXC creation with storage, template, bridge, and IP checks, gateway plus nameserver wiring, `curl` plus `ca-certificates` bootstrap before the Technitium installer, and fingerprint based DNS operations. Also added template selection via `listTemplates`, and fixed missing gateway on fresh LXCs.

### v1.1.3 to v1.2.3  making it run on real hardware
This was a hardening loop driven by live trials on `nuc` at `bunny.internal`.

* v1.1.3 set `gw` on `net0` and `--nameserver`. Before that LXCs had no outbound network.
* v1.1.4 fixed a crash where `nomina init` wrote a secret reference but never created the file. Added `ensureConnectionSecret` with a masked prompt and root owned 0700/0600 store in `src/secrets.js` and `src/adapter-runtime.js`.
* v1.2.1 and v1.2.3 fixed provisioning races. Technitium plus Caddy installers returned success before `dotnet` or `caddy` was listening, so `configure` and `inspect` threw `HttpRequestError` and left an orphaned LXC with no provider reference. Fixed with longer timeouts and `withBoundedRetry` around `configure`, `inspect`, and `healthCheck`.
* v1.2.2 added `nomina secret change` for rotating a password after changing it in a provider UI.
* v1.2.4 added `nomina service recheck`, Caddy Admin listening on `0.0.0.0:2019` instead of `127.0.0.1`, and an initial `:80 { respond OK 200 }` server so Admin API probes succeed.
* v1.2.5 fixed recheck IP detection by scanning `pct config <vmid>` instead of `pct list`, and fixed tracking by passing `connectionSecretReference` plus `ip` and `zone` to `inspect` and `healthCheck`.

Caddy exposures also went live here. Issue 15. `nomina exposure publish` now creates the Technitium A record and a Caddy Admin API route via targeted `PUT`/`GET`/`DELETE`, never overwriting unrelated records or routes.

### v1.3.0 to v1.3.15  trusted TLS and migration
Issue 17. Real step-ca adapter: dedicated LXC, `step ca init` with STEPPATH at `/var/lib/stepca`, systemd unit at `/etc/systemd/system/step-ca.service`, ACME at `https://<caIp>:9000/acme/acme/directory`, health checks for `/health` and `/acme/acme/directory`. Caddy publishes trusted routes through that ACME directory when step-ca is selected, internal issuer otherwise. `exposure publish` pins `step-ca.<zone>` in the Caddy LXC `/etc/hosts` and installs the root cert with `update-ca-certificates`.

After that, v1.3.8 to v1.3.15 fixed a chain of live exposure issues:

* Caddy route payload carried an invalid `tls` field, route array handling used hostname keyed PUT which always 409s, and `fetch` sent `sec-fetch-mode: cors` which Admin API rejects with 403. Fixed by moving TLS issuer to `apps.tls.automation.policies`, rewriting the whole routes array via DELETE then PUT, and switching the default transport to `node:http`/`node:https`.
* Caddy restart wiped routes and TLS policies because Admin API is ephemeral. Added a systemd drop-in preferring persisted `/etc/caddy/caddy.json` and dumping live config after each publish or remove.
* Exposure DNS A record pointed at the backend IP so `curl https://<hostname>` bypassed Caddy and got connection refused. Fixed to publish `proxyRef.ip` in Technitium and dial `backendIp:backendPort` in Caddy.
* ACME failed with `x509: no IP SANs` because the directory URL used a bare IP. Changed to `step-ca.<baseLocalDomain>` hostname, requested SANs on init, and pinned plus trusted that name in the Caddy LXC.
* `Change the local domain` and `Export the step-ca root certificate` shipped, with full cleanup and SAN extension. The TUI exposure picker was fixed to use stable NominaConnect IDs instead of colliding names.

### v1.4.0 to v1.4.7  the proxy is actually correct now
v1.4.0 hardened provisioning: new LXCs resolve DNS through Technitium instead of the gateway. Router resolvers were answering local zones with bogus AAAA and breaking ACME validation inside the CA container. Added health retry on publish for ACME issuance.

v1.4.1 to v1.4.3 added `HTTP->HTTPS` auto redirect as `308` via `nomina caddy redirect on|off`. First implementation pinned routes to `protocol: https://` and fell through port 80 to the redirect. Turned out Caddy 2.11.4 never matches that protocol matcher, so HTTPS requests matched nothing and got an empty 200, and with redirect off plain HTTP proxied in cleartext. `v1.4.4` fixed this by moving to a dual server topology, `srv_https` on :443 for TLS routes and `srv_http` on :80 for redirects, with automatic migration from legacy `srv0` and deletion of `srv0` before recreation to avoid duplicate ID errors. `v1.4.3` also shipped nuclear uninstall which destroys only managed LXCs recorded in state, then deletes `nomina.yaml`, `.nomina/`, and `/var/lib/nominaconnect/`.

v1.4.5 to v1.4.7 added TLS backends with `--backend-tls`. Some backends like Proxmox `:8006` only speak HTTPS, so Caddy now dials them with `tls { insecure_skip_verify }` on the internal hop only, stored as `exposure.backend.tls`. The TUI re-asks that question when editing an exposure, and the flag survives domain changes and edits. The client to Caddy hop stays trusted via step-ca.

Live verification at this stage caught a split DNS illusion: Technitium inside the LXC uses its own recursive resolver and `PreferIPv6`, and broken upstream IPv6 made `go.technitium.com/?id=44` App Store fetches stall for 30 seconds. System curl masked it with Happy Eyeballs. Not a NominaConnect bug, but worth knowing when you see timeout reports.

## Tracker state

Closed and production ready: 2 init, 3 Technitium LXC, 4 Caddy plus Technitium publish, 11 safe lifecycle, 9 plus 10 tracking Caddy and Technitium plus extended catalog, 14 Technitium plus Proxmox, 15 Caddy exposures, 17 step-ca trust for Caddy.

Open and not yet production real: 12 real provider adapters parent, 13 adapter boundary, 19 Tailscale, 20 NetBird, 21 adapter conformance suite. If a review touches VPN paths, it is still fake adapters and tests. Do not approve them as production behavior.

Traefik landed after this note was first written: 16 (real exposures through the watched dynamic directory) and 18 (step-ca trust: root distribution into the Traefik LXC, a managed `certificatesResolvers` block spliced into `traefik.yml`, and issuance plus handshake verification per exposure). Review those against `src/traefik-adapter.js`, `test/traefik-adapter-wire.test.js`, and `test/traefik-exposure-cli.test.js`, not against this paragraph.

Release history: 35 tags from v1.0.0 at 2026-08-21 through v1.4.7 at 2026-08-23. Latest stable is v1.4.3, latest dev prerelease is v1.4.7. 233 tests passing.

## What to look for in review

I keep seeing the same classes of bug come back. Check these first.

1. Provider inspection wins. If observed provider config differs from `nomina.yaml`, the provider value is adopted after a health check. The review should reject code that overwrites provider state or silently merges.

2. Preservation. Unmanaged DNS records and Caddy routes must survive every operation. Targeted mutation only. Look for whole config replacement or array clobbering.

3. Locators and fingerprints. Provider references store a native locator plus last known fingerprint. Review should confirm the code resolves by locator first and only falls back to constrained semantic match, and treats ambiguous matches as a verification warning.

4. Caddy Admin API handling. Routes live on `srv_https` and `srv_http`, not `srv0`. Any new code that touches `srv0` or uses a hostname keyed PUT on a routes array is wrong. Remember DELETE then PUT to avoid 409, and that `protocol` matchers do not work on the current Caddy build.

5. TLS backend flag. `exposure.backend.tls` controls `transport.tls.insecure_skip_verify`. It applies only to the Caddy to backend hop. The client to Caddy hop must stay trusted. Verify the serializer, TUI prompt, and domain change preservation.

6. DNS wiring. The Technitium A for an exposure points at the reverse proxy IP. The Caddy `reverse_proxy` dial points at the backend. Swapping those bypasses the proxy.

7. Secrets. No secret in `nomina.yaml`, arguments, logs, or error output. Root owned 0700 dir and 0600 file, masked prompt via `src/prompts.js`. The check is not optional.

8. Provisioning timing. Every LXC service starts slowly on 1 CPU Debian 13. Timeouts and `withBoundedRetry` around `configure`, `inspect`, and `healthCheck` must stay. Removing them reopens the orphaned LXC bug.

9. Persistence. Caddy live config must be dumped to `/etc/caddy/caddy.json` after publish or remove, and the systemd drop-in must load it. Otherwise a container restart wipes exposures.

10. TUI picker correctness. Exposure pickers must return stable `s.id`, not `s.name`, or they collide with platform service keys like `dns`. And the picker list should render before asking for backend IP or port.

11. Domain language. Call things what `CONTEXT.md` calls them. If a PR introduces a new term or reuses an existing term loosely, push back.

For a concise checklist inside the review itself, open `docs/adr/`, `docs/specs/real-provider-adapters.md`, and `CHANGELOG.md` alongside the diff. Most past fixes map directly to one of those files.
