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
`5f26f6f0602787d4ede9c3768e0d2744055deaf1866de8404966e1aa3951b6cc`.
Both exposures were republished. Caddy restarted using its saved ACME policies,
which cleared the previously cached certificate selection. The local and remote
probes then verified both step-ca certificate chains and hostnames.

Initial validation: 499 unit tests passed, zero failures. Typecheck and diff whitespace
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

## Final production verification

The final disposable acceptance run passed all 11 tests with no failures or
skips. It verified enrollment, preservation of unmanaged DNS/proxy settings,
locators, IP collisions, automatic startup and gateway firewall rules. The
opt-out test verified trusted gateway HTTPS 404 with forged forwarding headers,
LAN HTTPS 200, reenablement to gateway 200, HTTP denial and the LAN redirect.
Cleanup restored exact prior tailnet DNS and preserved the retained credential
digest and every pre-existing VMID. Only running VMIDs 100–103 remained.

The earlier connection refusal was not caused by the access matcher. Caddy's
HTTPS server already lacked a listener before opt-out. The unmanaged-route
seed treated a missing path's `200 null` response as an existing server, then
created a routes-only server through API traversal. The adapter now repairs an
absent/empty HTTPS listener while preserving operator routes. A real-process
regression reproduced TCP refusal before the fix and passed afterward. The
seed now creates the complete server and uses PATCH to replace existing arrays;
PUT had returned 409 once the full server existed. One other retry stopped at
an external package-site DNS failure; it did not exercise opt-out. The final
full run passed after these helper corrections.

Partial-uninstall CLI tests also exposed two defects. An already stopped LXC
incorrectly blocked completion even after successful destruction. A partial
retry still targeted destroyed VMIDs and attempted DNS restoration through a
deleted gateway. Successful DNS restoration and every destroyed VMID are now
checkpointed. The retry regression includes reuse of a destroyed ID by an
unrelated LXC and leaves it untouched. Failed destruction retains recovery
configuration and credentials. The full unit/wire/conformance suite passed
501 tests; typecheck and whitespace checks passed.

The corrected certificate-renewal helper completed with fresh connections.
Serial `D0C0E03544868D95B6195283D3269DD2`, expiring at October 8 00:51:16 UTC,
changed to `35CF5EA2CB8D82DB05DC8E4D2E2B0EC4`, expiring at 00:53:18 UTC.
Both observations used trusted HTTPS with HTTP 200. Original CA duration and
active/persisted Caddy settings were restored, the private restoration marker
exists, and only the original dns/pve exposures remain.

Current firewall and DNS installer settings were applied to the retained
gateway. The installed DNS unit retried six times over a 35-second synthetic
missing bind-address interval, then recovered automatically after its original
address setting was restored. The final unit and recovery marker were restored
and cleaned up. No interface or route settings were changed by this test.

A full Proxmox reboot changed boot ID
`af4785cd-24b7-4412-9554-2e2c91731689` to
`7d45cb84-e45b-467a-8f6c-e94e6eb03ed4`. VMIDs 100–103 started automatically.
`NTPSynchronized=yes` and active Tailscale, DNS relay and firewall services were
verified. No manual service recovery was needed. After reboot, fresh trusted
native-DNS HTTPS returned 200 for both retained URLs. Direct gateway UDP/TCP
DNS answered internal and unique public queries. The public negative response
was NOERROR/NODATA with an upstream SOA, matching a direct public-recursive
query. IPv4 ports 22, 2019, 5380 and 8006 stayed blocked; gateway IPv6 ports
22, 53 and 443 stayed blocked. Both raw-ingress firewall hooks survived reboot.

Local-only native DNS returned `192.168.1.54`, and both URLs passed trusted
HTTPS with Tailscale off. The client was reenabled afterward. Both-on native
DNS returned `100.109.138.62`; the route used `utun5`, while Tailscale ping used
local Ethernet `192.168.1.57:41641` at 2 ms. Resolver cache clearing was used
for fresh checks; no DNS configuration, hosts entries or switching helpers
were added. Final physical-disconnection verification passed at October 8 01:24 UTC.
Ethernet was inactive; both native names resolved to `100.109.138.62` and
returned fresh trusted HTTPS 200. Gateway UDP/TCP DNS answered internal and
unique public queries. Restricted IPv4/IPv6 ports and direct LAN HTTPS were
unreachable. The gateway route used `utun5`; Tailscale ping used DERP(sfo)
at 45 ms. This verifies relay access; a direct peer path was not established.

Backup/restore verified provider archives for Technitium, Caddy, step-ca and
Tailscale plus a project/credential archive through extraction and content
comparison. A full step-ca LXC backup was restored into disposable VMID 104
with its network link disabled. CA private keys, certificates and configuration
matched, and step-ca started successfully. The clone was removed. Private
archives remain only on Proxmox under
`/root/nomina-production-check-backups/recovery-1791420929261`, with results and
an explicit `cleaned` marker. This demonstrates CA startup and provider-file
recovery, not a complete replacement homelab operating online. Two earlier
helper attempts failed before restore because of an incorrect vzdump path and
unprivileged access to its temporary directory; their recovery directories
remain separate. Snapshot cleanup completed.

## Security review and readiness limits

The read-only audit authenticated successfully with Technitium's default admin
password. Rotate the provider account and update Nomina's stored credential
before production use. Account rotation was outside the credential-review
scope of this session.

The T3 console showed the existing API token and reusable enrollment key,
both described as ProxmoxDev1, created September 26 and expiring December 25,
2026. Private host files were matched to their public IDs without printing
values. The token is a fully permitted Tailscale API access token; DNS writes
and device/policy reads were verified. It is not a DNS-scoped trust credential.
[Tailscale API permission model](https://tailscale.com/docs/reference/tailscale-api).
Plan rotation before expiry. The retained gateway device key expires April 5,
2027. The operator's broad policy for trusted tailnet members was verified
and preserved.

Old offline test-device registrations remain in the Tailscale control plane,
including an expired entry. The audit records their metadata on Proxmox.
Destroying the test LXCs did not remove those registrations. Review ownership
before control-plane cleanup. Windows home-DNS UI behavior remains outside
this Mac field run.

Technical acceptance passed. Production approval still requires operator
security sign-off and manual review of PR #24. The retained installation,
credentials, CA and Mac root trust remain intact. PR #24 remains unmerged.

Final deployed native binary SHA-256:
`49cffa79e99340afa361f0ad3413f7663d5c55395c775fdc86fe8294d7db5777`.

Latest local evidence includes `acceptance-final.log`, `renewal-results.json`,
`gateway-recovery-results.json`, `backup-restore-results.json`,
`reboot-results.json`, `readiness-local-only.json`, `readiness-both-on.json`,
`readiness-disconnected.json` and `token-metadata.json` under `/Users/shridhar/Desktop/bunnytest-lab`.
See [the sign-off and recovery plan](production-check-followups.md).
