# Proxmox test run report — 2026-09-06

First live-hardware run of `docs/proxmox-test-run.md` Layer 1 (unit/conformance)
and Layer 2 (§5 guided walkthrough) against the Proxmox VM at `192.168.1.3`.
Extended on 2026-09-06 (later sessions) with Layer 3 (automated acceptance
suite) and a full-stack run that adds step-ca and a VPN to the same project.

Working tree state: everything below is **uncommitted** (base `dfcb3c7`).
No secrets are recorded in this report or in the tree.

## 1. Suites — before and after the fixes

| Where | Result |
|---|---|
| Workstation, `node --test`, before fixes | 452 pass, 0 fail |
| Proxmox host (`/opt/nominaconnect-test`, rsynced tree), before fixes | 452 pass, 0 fail |
| Workstation, after product fixes (§4) | **454 pass, 0 fail** (452 + 2 new regression tests) |
| Proxmox host, after product fixes | **454 pass, 0 fail** |

(`node --test` only — `bun test` is known-broken per §1 of the test-run doc.)

## 2. §5 walkthrough results

§5.1 `init` was already done by the prior session
(node `pve`, bridge `vmbr0`, storage `local-lvm`, domain `home.test`,
dns `technitium`, proxy `caddy`, ca/vpn `none`) and was verified, not re-run.

| Step | Result |
|---|---|
| 5.2 Technitium | `service add technitium --ip 192.168.1.53 …` → provisioned on vmid 100, `unprivileged: 1`, API login returns `status ok`, health **healthy**. Required fixes #2 and #1 first (three failed attempts). |
| 5.3 Caddy | `service add caddy --ip 192.168.1.54 …` → provisioned on vmid 101, admin API `:2019` answering from the host, health **healthy**. Required fix #3 first (one failed attempt). |
| 5.4 Unmanaged seeds | `legacy.home.test` A-record and `operator.home.test` route seeded by hand. Deviation: `srv_https` does not exist until first publish (the doc's seed POST assumes it), so the server was created by hand first with the same shape `ensureServers` uses. Caddy returns HTTP 200 + `null` for missing config paths, which initially hid this. |
| 5.5 Publish | `exposure publish --name photos --hostname photos.home.test --backend-ip 192.168.1.3 --backend-port 8080 --backend-tls false` → published, healthy. Managed + unmanaged coexist on both providers. Host-side E2E (workstation→container is blocked, §6): `curl -k --resolve photos.home.test:443:192.168.1.54 https://photos.home.test/` → `backend ok`; `photos.home.test` resolves via .53 → `.54`. |
| 5.6 Adoption | Provider-side backend rewrite adopted with provider precedence (`nomina.yaml` backend port → `9999`, fingerprints in state). Ambiguous-route and missing-record warnings both fire (the latter only after fix #4). |
| 5.7 Optional layers | Skipped: needs `--ca step-ca` at init and real VPN credentials. |
| 5.8 Upgrade/teardown | `service upgrade caddy --snapshot` → snapshot created, healthy, both routes preserved across the restart. `uninstall --yes` destroyed vmids 100/101 and removed project files; host `pct list` empty. |

Headless flags used throughout (non-interactive SSH): `--hostname`, `--cpus 2`
(skips the resource confirm), `--secret`, `--backend-tls false`, `--snapshot`.
Without them the CLI blocks on prompts (`LXC hostname`, resource confirm,
backend-TLS confirm, snapshot confirm) and dies with an unsettled-await
warning under non-interactive SSH.

## 3. Environment blockers (lab, not product)

- **§2.1 is still open.** The VirtualBox adapter on the Ryzen box filters LXC
  MACs: container ARP for the gateway FAILS, the Mac cannot reach any
  container IP, while host↔container works both directions in isolation.
  Fix on the hypervisor: adapter Promiscuous Mode → **Allow All**.
- Workarounds used (all Proxmox-host runtime-only, lost on reboot):
  `--gateway 192.168.1.3` + `--nameserver 1.1.1.1` on `service add`,
  `sysctl net.ipv4.ip_forward=1`, per-IP
  `iptables -t nat -A POSTROUTING -s <ctn-ip> ! -d 192.168.1.0/24 -j MASQUERADE`
  for .53/.54, plain `python3 -m http.server 8080` backend on the host.
  Proxy-ARP (`ip neigh add proxy …`) was tried and does **not** help: inbound
  broadcasts appear to be filtered at the vNIC too, so LAN→container stays
  down regardless. All workstation-originated checks were run from the host.
- The Mac NAT gateway itself (`en8` alias .1, pf NAT) and key SSH to
  `root@192.168.1.3` were healthy all session.

## 4. Product fixes applied (uncommitted)

1. **30 s default timeout killed apt steps** (`src/technitium-adapter.js:6-13`,
   `src/caddy-adapter.js:18-23,56`). `apt-get install` measured **33.4 s**
   on VM storage vs `DEFAULT_TIMEOUT_MS = 30_000`. Added explicit
   `timeoutMs` (180 s apt/curl, 60 s repo setup/restart). Pinned expectations
   updated in `test/technitium-adapter.test.js`,
   `test/adapter-runtime.test.js`.
2. **Technitium needs `nesting=1`** (`src/adapter-runtime.js:236,368`,
   `src/technitium-adapter.js:16-23`). Its sandboxed unit
   (`PrivateTmp`, `ProtectSystem=strict`, …) fails with `226/NAMESPACE` in an
   unprivileged LXC without nesting. New `proxmox.enableNesting()` mirrors the
   VPN TUN grant; verified live (unit `active`, API up after `pct set` +
   reboot, then via `service add`).
3. **Caddy repo key never dearmored** (`src/caddy-adapter.js:19-20`). The
   armored key at a `.gpg` `signed-by` path yields
   `NO_PUBKEY ABA1F9B8875A6661`. Now `curl | gpg --dearmor`, plus `gnupg`
   in the prereq install (Tailscale/NetBird precedent).
4. **Ambiguous proxy suppressed the DNS warning** (`src/adoption.js:530`).
   The exposure loop's `continue` skipped DNS adoption whenever the proxy
   route was ambiguous, so the doc's combined refusal probe only ever showed
   one warning. DNS adoption now runs before the proxy block. Regression
   tests added for caddy+traefik
   (`test/background-adoption-conformance.test.js`), proven to fail with the
   block disabled and pass with it; both warnings confirmed live.
5. **Nameserver echo** (`src/tui.js`, `managedTechnitiumIp`). The setup summary
   showed the gateway fallback instead of the effective managed-Technitium
   default. Cosmetic; no test pinned it.

## 5. Follow-ups

- Failed `service add` leaves orphan LXCs behind (hit 3×); IP preflight then
  blocks the retry until manual `pct stop/destroy`. Consider cleanup or an
  explicit pointer on failure.
- Doc touch-ups for `docs/proxmox-test-run.md`: §5.4 Caddy seed needs the
  `srv_https` server to exist (create-by-hand step or publish-first note);
  §5.5/§5.8 should document the headless flags (`--hostname`, `--cpus`,
  `--secret`, `--backend-tls false`, `--snapshot`/`--no-snapshot`).
- Layer 3 readiness: the suite defaults to gateway `.1`, which is DNS-dead in
  this lab — it will need `NOMINA_ACCEPTANCE_GATEWAY=192.168.1.3` plus fresh
  MASQUERADE rules per run IP, and its prompt coverage (hostname/resource
  confirms) is untested headlessly.
- The §8 feedback questions are answered: apt/Technitium do **not** fit the
  old budgets on VM-hosted Proxmox (fixed by #1), and background tracking
  surfaces adoption within one cycle once #4 is in.


---

# Layer 3 and full-stack run — 2026-09-06 (later sessions)

## 6. Layer 3 acceptance suite

`acceptance/live-proxmox.acceptance.mjs` ran green **7/7 on both proxy
providers** (`caddy` and `traefik`) with `NOMINA_ACCEPTANCE_GATEWAY=192.168.1.3`.
Host logs: `/tmp/nomina-acceptance.log`, `/tmp/nomina-acceptance-traefik.log`.

Suite fixes required to get there (all in `acceptance/`):

- Caddy seed/verify went through bare `fetch`, which Caddy's admin API rejects
  with 403 (the browser headers `globalThis.fetch` injects). Now uses
  `createHttpClient()`, the same transport the adapters use.
- `srv_https` does not exist on a fresh Caddy, so the suite pre-creates it by
  `PUT` when missing.
- Route seeding used `POST`, which returns 500/400 on a fresh server; now
  `GET`+`PUT`.
- Traefik fragment backtick escaping fix.

## 7. Full-stack run (technitium + caddy + step-ca + tailscale)

Project `/root/nomina-fullstack`, zone `home.test`, run against a freshly built
baseline binary deployed to `/usr/local/bin/nomina` (md5-verified at deploy).

| Step | Result |
|---|---|
| Technitium `.53` (vmid 100) | provisioned, health **healthy** |
| Caddy `.54` (vmid 101) | provisioned, health **healthy** |
| step-ca `.56` (vmid 102) | provisioned, health **healthy** — after fixes #6, #7 and #8 below. Serving cert now carries `IP Address:192.168.1.56`; `curl --cacert` against the CA's own root validates **by IP** (rc=0) and `/acme/acme/directory` answers 200. |
| Exposure publish | `exposure publish --name photos --hostname photos.home.test --backend-ip 192.168.1.3 --backend-port 8080 --backend-tls false` → published, healthy. Caddy obtained a certificate from step-ca over ACME `tls-alpn-01` ("certificate obtained successfully"). |
| Trusted TLS end-to-end | `curl --cacert <step-ca root> --resolve photos.home.test:443:192.168.1.54 https://photos.home.test/` → **`ssl_verify=0`, HTTP 200, body `backend ok`**, issuer `CN=NominaConnect CA Intermediate CA`. This is the first fully trusted (non-`-k`) HTTPS path in the lab. |
| `ca guide` / `ca cert` | both render correctly against the live CA; `ca cert` prints the real root. |
| Secret hygiene | `grep -rIl "tskey-auth"` finds **no match** in the project dir, in `nomina.yaml`/`.nomina/state.json`, inside the Tailscale LXC (`/etc`, `/var/lib/tailscale`), or in root's shell history. The key exists only in the local secret store, which is its intended home: files are `0600 root:root` inside a `0700` directory. |
| Tailscale `.57` (vmid 103) | provisioned, health **healthy**, enrolled in the operator's tailnet under a real `*.ts.net` name with a `100.x` address, and visible in `tailscale status` alongside the operator's own node (identifiers omitted here deliberately). Auth key supplied through a per-command env var only. |
| VPN provider identity | `service add` captured the tailnet identity into local state (`locator` = node id + dnsName + hostname, plus a fingerprint) and **not** into provider configuration, per ADR-0002/ADR-0005. |

## 8. Product fixes applied (uncommitted, continued from §4)

6. **Health checks could never settle** (`src/provisioning.js`, `src/cli.js`
   recheck + upgrade paths). Provisioning and recheck wrapped the health probe
   in `withBoundedRetry`, which only retries a *thrown* error — but adapters
   report "not ready yet" as an unhealthy *result*, so the first probe was
   final. The upgrade path had no retry at all, despite probing immediately
   after restarting the service. All three now use `withHealthyRetry`, the
   helper `exposure.js` already used for exactly this window. A `retryOptions`
   seam was threaded through `provisionPlatformService` and the CLI adapters so
   tests can skip the real backoff. Three regression tests added, each proven
   to fail without the fix.
7. **step-ca was never reachable over validated TLS** (`src/step-ca-adapter.js`,
   `src/adapter-runtime.js`). step-ca serves its own API with a certificate
   issued by its own root, but the adapter used a validating HTTPS client with
   no trust anchor, so *every* step-ca call failed TLS verification (`curl`
   rc=60) and was reported as `unreachable`. The adapter now bootstraps the way
   `step ca bootstrap` does: fetch `/roots.pem` once over an unvalidated
   connection, cache it per endpoint, and pin every subsequent request to that
   root. `createHttpClient` grew a per-request `tls` option to carry it. Only
   the one bootstrap request skips verification.
8. **step-ca had no SAN for the address it is reached at**
   (`src/step-ca-adapter.js`). `step ca init` requested SANs for the hostname,
   `localhost` and `step-ca.<zone>` only, but the adapter connects by IP —
   so even with the correct root, validation failed hostname verification
   (verified live: `curl --cacert` rc=60 by IP, rc=0 by name). The install now
   includes the CA's own IP in `--dns`. Confirmed live: the reissued cert
   carries `IP Address:192.168.1.56` and by-IP validation succeeds.

Fixes #7 and #8 together mean step-ca had **never** worked end-to-end before
this run; §5.7 of the earlier walkthrough skipped the CA layer, which is why it
went unnoticed.

Suites after all fixes: **464 pass, 0 fail** (`node --test`), up from 454.

## 9. Still open

- Nothing outstanding from the full-stack run: technitium, caddy, step-ca and
  tailscale are all provisioned and healthy, exposure is published over fully
  trusted TLS, and the VPN node is enrolled.
- Lab-only, not product: pointing step-ca at `--nameserver 1.1.1.1` breaks ACME
  validation, because the CA cannot resolve the local zone to reach the
  challenge target. The product's own default (managed Technitium IP for every
  non-Technitium service) is correct and was verified live — omit the
  `--nameserver` override for CA and proxy LXCs.
- Re-provisioning step-ca invalidates the root, which leaves Caddy holding a
  stale ACME account and trust bundle. `rm -rf /var/lib/caddy/.local/share/caddy/{acme,certificates}`
  plus a restart clears it. Worth considering whether the product should do
  this automatically when it detects a CA root change.
- Everything from §5 above still stands.
