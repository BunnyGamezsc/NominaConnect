# bunnytest.internal Tailscale field test

Date: October 7, 2026. PR: https://github.com/BunnyGamezsc/NominaConnect/pull/24.
Branch: `feat/tailnet-exposures`, starting commit
`b9d85984fc127f1ca98c2c19a577bdd39005361b` plus the certificate publication fix.

## Result

Both requested URLs worked locally and through Tailscale after the Mac's
Ethernet cable was physically disconnected. macOS used its normal DNS resolver
and the browser trusted the exported step-ca root. No hosts entries, custom
domain resolvers, DNS switching scripts, or browser warning bypasses were used.

| Exposure | Backend | Backend TLS | Local and disconnected HTTPS |
| --- | --- | --- | --- |
| `dns.bunnytest.internal` | `192.168.1.53:5380` | Flag omitted; prompt answered No | HTTP 200, Technitium, verified certificate |
| `pve.bunnytest.internal` | `192.168.1.3:8006` | `--backend-tls` supplied | HTTP 200, Proxmox, verified certificate |

Browser-facing HTTPS is independent of the backend TLS option.

## Installed lab

The project is `/root/nomina-bunnytest`. All services were provisioned through
the native Nomina CLI and remain installed.

| Service | VMID | LAN address | RAM | Root disk |
| --- | --- | --- | --- | --- |
| Technitium | 100 | `192.168.1.53` | 768 MB | 2 GB |
| Caddy | 101 | `192.168.1.54` | 512 MB | 2 GB |
| step-ca | 102 | `192.168.1.56` | 512 MB | 2 GB |
| Tailscale | 103 | `192.168.1.57` | 256 MB | 2 GB |

The Tailscale gateway enrolled at `100.109.138.62` and was renamed `bunnytest`.
Both exposures allow tailnet
access. No subnet route was required to reach the backends.

Proxmox's independent internet route uses VirtualBox NAT on `enp0s8`, gateway
`10.0.3.2`. Containers use Proxmox at `192.168.1.3` as their gateway. An enabled
`nomina-bunnytest-routing.service` sets IPv4 forwarding and an idempotent
MASQUERADE rule scoped to `192.168.1.0/24` leaving `enp0s8`. Technitium's lab
forwarders are `1.1.1.1` and `8.8.8.8`.

The ordinary Mac Ethernet service uses `192.168.1.20/24`, router
`192.168.1.3`, and DNS `192.168.1.53`. Without an Ethernet gateway, macOS kept
Wi-Fi DNS as its unscoped resolver; adding the actual Proxmox LAN gateway
made native local resolution work. Wi-Fi DNS was not modified. Only the public
step-ca root was downloaded and trusted in the Mac login keychain for SSL.

## Certificate defect found and fixed

The initial Proxmox exposure served a Caddy Local Authority certificate even
though a step-ca certificate also existed in storage. Publishing added the HTTP
route before its issuer policy. Replacements also deleted and recreated live
policy arrays. Each accepted Admin API mutation reloads Caddy, so an intermediate
configuration could issue and cache an internal certificate.

The adapter now installs the issuer policy before publishing the route, replaces
existing values using PATCH, and uses PUT only when PATCH returns 404. The wire
regression examines each intermediate configuration during initial publication
and republication. It failed before the fix and passes afterward.

The fixed native binary was deployed with SHA-256
`7e3b56a87e320b542d6c1c1c61bb03ee7f36ec908ede6b9d603e66ea71e937dd`.
Both exposures were republished. Caddy restarted using its saved ACME policies,
which cleared the previously cached certificate selection. The local and remote
probes then verified both step-ca certificate chains and hostnames.

Validation: 499 unit tests passed, zero failures. Typecheck and diff whitespace
checks passed. The source fix and regression tests are present in this checkout.

## Disconnected evidence

- The user physically unplugged Ethernet; `en8` was no longer present.
- Mac internet switched to Wi-Fi `en0`, `192.168.11.24/24`, gateway
  `192.168.11.1`. The PC uses Wi-Fi subnet `192.168.12.0/24`.
- Native macOS lookup returned `100.109.138.62` for both exposure names.
  The gateway destination routed through Tailscale `utun4`.
- Fresh HTTPS requests using native DNS returned HTTP 200, the expected pages,
  and verified step-ca certificates. Leaf fingerprints matched the local run.
- Both Mac browser pages loaded after disconnection and reported
  "Connection is secure."
- Gateway DNS answered over UDP and TCP. Direct connections to LAN
  `192.168.1.3:8006` and `192.168.1.54:443` were unreachable. Gateway ports
  5380, 8006 and 2019 were also unreachable; the intended HTTPS exposures worked.
- A Tailscale ping received a DERP relay response. Direct peer connectivity was
  not established by that ping; relay HTTPS worked.
- Nomina set one global tailnet nameserver. The Tailscale DNS API omitted
  `overrideLocalDNS`, so Nomina correctly emitted its verification warning.
  Actual Mac DNS worked without an admin-console or Mac resolver workaround.

The user manually turned the Mac client off during a final evidence capture.
DNS then reverted to Wi-Fi DNS and remote access failed, as expected without the
tunnel. At the user's request Tailscale was turned back on. Both native-DNS HTTPS
probes passed again at 2026-10-07T21:56:12Z. A final status check confirmed the
Mac client Running and online, with the gateway online. This was an intentional
client toggle, not an observed automatic tunnel failure.

Local artifacts are `/Users/shridhar/Desktop/bunnytest-lab/report.md`,
`off-network-results.json`, `probes.mjs`, and the public `step-ca-root.crt`.

## Scope and retained state

The retained deployment has not been uninstalled. The project, credentials,
four containers, Mac public-root trust and tailnet DNS remain configured.
Disposable acceptance containers were created and removed separately.

## Production checks in progress

- Full Proxmox reboot passed. Boot ID changed from
  `34b4fdee-7e80-46c1-8617-87f7b9984beb` to
  `af4785cd-24b7-4412-9554-2e2c91731689`. All four LXCs started automatically
  within about 64 seconds. Managed provisioning now sets `--onboot 1`.
- IPv6 exposed the gateway's SSH port despite its IPv4 firewall. The product
  now rejects gateway IPv6 input and forwarding, and requires the firewall
  service before starting Tailscale. Live verification closed IPv6 ports
  22, 53 and 443 while intended IPv4 DNS and HTTPS continued to work.
  Atomic updates were applied twice and preserved an unrelated firewall chain.
  Restarting Tailscale exposed a second defect: its accept hooks precede the
  filter restrictions. A raw-table ingress allowlist now blocks undesired
  destinations and ports before those hooks. After restart, both IPv4 and IPv6
  SSH probes timed out while intended HTTPS still returned HTTP 200.
- Uninstall now stops before destruction if restoring tailnet DNS fails, and
  preserves recovery state and secrets if container destruction fails. An
  explicitly configured secret store is used instead of deleting another
  installation's global store. Regression tests passed.
- Exposure removal now calls the real Technitium `deleteRecord` adapter with
  its endpoint and credential reference. The previous adapter method did not
  exist, leaving stale DNS records. Its regression passed.
- The final disposable acceptance run passed nine subtests and failed one.
  Enrollment, unmanaged configuration preservation, recorded locators,
  IP collision checks, on-boot configuration and gateway firewall assertions
  passed. The opt-out test received connection refused on proxy TCP 443 instead
  of the expected verified HTTPS 404. LAN availability and reenablement in that
  subtest remain unverified. The suite's cleanup hook completed without error,
  including exact previous tailnet DNS restoration, original credential-digest
  preservation and pre-existing VMID preservation. Final `pct list` contained
  only the retained VMIDs 100 through 103, all running.
  Earlier attempts exposed test-helper mistakes in certificate-response parsing
  and an unsupported exposure flag; both were corrected. An initial package
  install failure was not reproduced after cache cleanup and storage trimming.
- Caddy automatically renewed the temporary short-lived certificate.
  Its initial serial `BA541868F4F554151CCAD99460178769`, expiring at
  2026-10-08 00:14:36 UTC, changed to
  `8FFB7EA93D6CED7F5FFA42F6DE0B663E`, expiring at 00:19:30 UTC.
  A fresh Mac TLS handshake verified the new certificate and HTTP 200.
  The polling helper reused a TLS session and kept observing the old leaf;
  fresh connections are now required. Its corrected rerun was not started
  after the operator requested a quick wrap-up. Original CA and Caddy settings
  were restored, confirmed by the private recovery marker. Proxmox was
  measured about 12 minutes behind the Mac, with NTP reachable but the system
  clock unsynchronized. The clock was corrected, and chrony was configured
  to step after VM clock jumps beyond its initial startup samples.
  `NTPSynchronized=yes` was verified before the new renewal run.
  The renewal helper now requires synchronization before
  changing CA settings. Existing recovery backups remain on Proxmox.
- Both-on checks passed 30 DNS requests, followed by verified HTTP 200 from
  both URLs. Tailscale ping preferred Ethernet `192.168.1.57:41641` at 3 ms.
  A subsequent outage reproduced DNS timeouts while the PC, Proxmox and local
  DNS all became unreachable; the gateway was reported offline. Ethernet
  remained active and the Mac default route still pointed at Proxmox.
  The operator confirmed waking the PC after it had slept. Both-on DNS
  and HTTPS passed again after recovery. The stable Tailscale answer
  was routed through Ethernet locally, without a Mac DNS override.
- Read-only tailnet policy inspection found a broad allow rule.
  The operator chose access for trusted tailnet members;
  the existing policy remains in place.

The final acceptance suite did not pass. This report does not declare production
readiness. See [the remaining fix and verification plan](production-check-followups.md).
PR #24 remains unmerged. No live tests were left running at the final host check.

Final deployed native binary SHA-256:
`7e3b56a87e320b542d6c1c1c61bb03ee7f36ec908ede6b9d603e66ea71e937dd`.
Mac-to-Proxmox clock difference was about one second after synchronization.

