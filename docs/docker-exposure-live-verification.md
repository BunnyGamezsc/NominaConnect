# Docker exposure verification for issue #33

Verified on 2026-10-10 against the implementation of
[#32 / PR #34](https://github.com/BunnyGamezsc/NominaConnect/pull/34).
The exposure implementation is [PR #35](https://github.com/BunnyGamezsc/NominaConnect/pull/35).
The #33 branch starts at `50372e3` on `feat/32-docker-lxc-bindings` and its
stacked PR targets that branch. PR #34 merged before these checks completed.
Merge order is #34, then #33; retarget #33 to `main` when integrating it.

## Automated checks

- Repository suite after the parity/review fixes: 658 tests, 656 passed,
  2 skipped, 0 failures.
- Local skips were the PowerShell helper CLI and Linux socket-forwarder test.
  PowerShell was unavailable. The TCP wire suite ran on Proxmox with all
  7 tests passing, including real `systemd-socket-proxyd` byte forwarding.
- `npm run typecheck`: passed.
- Focused Docker exposure/Caddy wire tests passed after the final review text
  change. Docker exposure/host tests passed after scoped IPv6 addresses were
  made an explained rejection instead of a URL parsing exception.
- `npm run build:native`: Linux x64 baseline build passed.
- The compiled Linux CLI passed version/help, scripted discovery, review with
  unchanged YAML/state, confirmed publication, HTTPS nginx content, HTTP 308
  redirection, and HTTPS access after binding removal.
- The opt-in exposure acceptance test skips locally without an authorized
  root Proxmox environment; it passed on the lab with no skipped checks.

The tests exercise the real CLI and existing exposure lifecycle with recorded
provider/configuration writes: guided/scripted parity, Compose and standalone
selection, editable settings, unknown protocols, naming, duplicate bindings,
stale/recreated/disappeared endpoints, backend overrides, unreachable backends,
DNS/routes/listener conflicts, cancellation, manual fallback, binding removal,
and Caddy/Traefik HTTPS/TCP/SMB regressions.

## Live environment and results

Authorized Proxmox host: `192.168.1.3`. Docker CT 106 (`192.168.1.88`) retains
the #32 standalone nginx and Compose replica fixtures. A separate Caddy CT
107 (`192.168.1.89`) forwards exposures from an isolated project at
`/opt/nomina-issue33-live/project`. The retained lab project is
`/root/nomina-bunnytest`; its Technitium DNS provider supplies the new
`docker33.bunnytest.internal` names. No CA or VPN is configured in the
isolated project.

| Check | Result |
| --- | --- |
| Scripted review | Configuration unchanged; no publication |
| Web endpoint | HTTPS nginx response through effective host port 8080 |
| Explicit override | Compose replica host port persisted and returned HTTP 200 |
| Existing hostname | Rejected without overwrite |
| Generic TCP | HTTP bytes forwarded through listener 18080; collision rejected |
| SMB | Client TCP 445 forwarded to Docker host port 14445 |
| SMB application access | SMB3 authenticated listing and file read through `docker-files.docker33.bunnytest.internal`; anonymous access rejected |
| Binding removal | Saved exposures retained and HTTPS still returned HTTP 200 |
| Docker preservation | Container/network/volume inspection digest unchanged by the acceptance run |
| Retained lab | Project YAML/state hashes and existing CT configuration/status unchanged |

The Samba fixture `nomina-issue33-smb` was explicitly created by the acceptance
harness before its preservation snapshot. Its share, server alias and random
test credentials are fixture setup, separate from product discovery and
publication. Credentials stay in root-only files and are omitted from this
report. No existing Docker application was adopted, redeployed or reconfigured.

The successful acceptance run resumed four exposures published by the prior
run; it checked their saved protocol/backend/listener/preset before continuing
client checks. Its evidence and log are retained on the lab at
`/opt/nomina-issue33-live/project/evidence.json` and
`/opt/nomina-issue33-live/acceptance.log`.
Native CLI evidence and its tested binary SHA-256 are retained at
`/opt/nomina-issue33-live/native-evidence.json` and
`/opt/nomina-issue33-live/native-check.log`.
The initial implementation's tested Linux x64 binary SHA-256 is
`1e319f8ec5b22b34f9130435c431e129bd3f5721c1ba58dd2e5667b0c9ecd454`.
The native check script is retained at
`/opt/nomina-issue33-live/nomina33-native-check.mjs`, and the TCP wire log at
`/opt/nomina-issue33-live/tcp-wire.log`.

## Failures investigated

The follow-up parity audit drives the root **Publish an exposure** menu through
the production Clack adapter and compares its exposure, backend probe and TCP
preflight requests with scripted flags. It covers Docker/manual HTTPS, backend
TLS, generic TCP listeners, SMB, tailnet choices, unknown protocols, redirects
307/308, parent-project discovery, supplied fields during manual fallback,
readiness-only review and cancellation. The option mapping is documented in
[Menu and flag parity](docker-exposures.md#menu-and-flag-parity).

The audit fixed numeric text defaults, the missing manual TCP listener prompt,
lost flags during manual fallback, project discovery during menu publication,
and missing TCP listener preflights in readiness review. Docker's final menu
now offers publication, readiness review and cancellation with cancellation
selected initially. Both readiness routes use the existing read-only TCP
preflight; publication retains the same lifecycle.

CodeRabbit's manual `--yes` finding was valid. Manual entry now receives the
computed prompt adapter, so `--yes` disables installed prompts and missing
required fields fail validation without writes. Regression tests cover
HTTPS/TCP/SMB, inferred/explicit manual selection and redirects. Function
documentation was added for the affected collectors and TCP preflight.

The follow-up native Linux x64 binary SHA-256 is
`4ff54b1fcc8e92b604392f71a941113634608263eab9a2e3150d9256d1eb0b08`.
Its scripted TCP readiness review passed; reserved and occupied listeners were
rejected. Manual `--yes` produced a missing-field validation error without
prompting or writing. An actual terminal run of the root TUI selected Docker,
the standalone endpoint, generic TCP and an edited listener 18081. It accepted
the numeric backend-port default 8080 and completed readiness review. YAML and
state hashes remained unchanged across both review routes. The binary,
`parity-evidence.json`, `parity-live.log`, and `tui-parity.typescript` are
retained under `/opt/nomina-issue33-live/`.
The same binary then explicitly published a Docker TCP exposure on 18081 and
returned nginx HTTP 200 through that listener. A manual `--yes` SMB republish
completed without prompts and retained its identity, backend 14445 and client
listener 445. These checks are recorded in `parity-finish.log`. The additional
TCP exposure remains in the isolated project for inspection.
The live exposure acceptance suite passed again after these changes, including
SMB3 listing/file read, anonymous rejection, HTTPS/TCP access and binding
disconnection. Its Docker digest and retained lab preservation checks passed.

Caddy configuration writes reload its admin server. Reusing an HTTP connection
caused the next request to reset during live publication. The adapter now uses
`Connection: close` for admin requests, and a real HTTP wire regression test
checks fresh connections across writes. The subsequent live publication passed.
One interrupted publication left a DNS record without a saved exposure; the
new conflict preflight rejected it. It was retained, and a distinct hostname
was explicitly chosen for the successful run.

The first isolated proxy setup used an incorrect fixture gateway; CT 107 was
corrected to the lab gateway without touching another CT. Cloudsmith returned
HTTP 402 during the existing Caddy installation workflow. The fixture used
Debian's Caddy 2.6.2 package and the existing admin/persistence setup. Standard
Cloudsmith provisioning therefore did **not** pass in this environment.

The acceptance fixture's first credential-file transfer incorrectly sent the
credentials as shell commands. A quoted heredoc fixed the transfer. Resume
also normalizes YAML's string port representation before comparing saved
exposures. Both fixture failures were resolved before the successful SMB check.
An initial native build ran out of local disk space; a bounded retry and the
final build succeeded.

## Limits and retained resources

The live proxy serves Caddy's untrusted internal certificate. HTTPS content
checks explicitly accept that certificate; client trust, step-ca issuance and
off-LAN Tailscale access were not validated by this isolated run. Live Traefik,
Windows/macOS SMB mounts, SSH application login, IPv6 routing, and ARM64 native
execution were not performed. Automated coverage exercises existing proxy,
TLS and tailnet integrations; transport health does not claim application
authentication or certificate trust.

The proxy CT, Samba fixture, exposure/DNS records, project, logs and binaries
remain available for inspection. Fixture resources require explicit cleanup;
disconnecting a Docker binding leaves them and the exposures intact.
