# Production check follow-ups

PR: https://github.com/BunnyGamezsc/NominaConnect/pull/24.
Evidence: [bunnytest field report](bunnytest-tailnet-field-report.md).
The retained deployment stays installed. The operator will review the PR;
do not merge automatically.

## Completed technical gates

- A real Caddy process reproduced the missing HTTPS listener. The adapter now
  repairs a routes-only server without replacing unmanaged routes. The live
  seed handles Caddy's `200 null` response and uses PATCH for existing arrays.
  All 11 live acceptance tests passed, including trusted gateway HTTPS 404
  with forged headers, LAN HTTPS 200, reenablement, HTTP denial and redirects.
  Cleanup verified exact prior tailnet DNS, credentials and pre-existing VMIDs.
- The corrected renewal helper passed with fresh trusted TLS. Serial
  `D0C0E03544868D95B6195283D3269DD2` changed to
  `35CF5EA2CB8D82DB05DC8E4D2E2B0EC4`, with expiry advancing from 00:51:16 to
  00:53:18 UTC on October 8. Original CA/Caddy settings were restored, the
  marker exists, and only the two original exposures remain.
- CLI regressions confirmed and fixed partial-uninstall defects. A stop failure
  does not block successful destruction. Completed targets and DNS restoration
  are checkpointed so retries cannot target a reused VMID or require a deleted
  gateway. Failed destruction still retains configuration and credentials.
- A full Proxmox reboot with final firewall/DNS units changed the boot ID to
  `7d45cb84-e45b-467a-8f6c-e94e6eb03ed4`. VMIDs 100–103 started automatically,
  NTP synchronized, DNS/firewall services recovered, administration ports stayed
  blocked on IPv4 and IPv6, and intended IPv4 DNS/HTTPS worked.
- The installed DNS unit retried six times over a 35-second synthetic missing
  bind-address interval and recovered automatically after its original address
  setting was restored. No interface or route changes were needed.
- A disconnected disposable step-ca LXC restored matching private keys,
  certificates/configuration and an active CA service. All provider archives
  and a project/credential copy passed extraction and content comparison.
  Private backups remain only on Proxmox; the clone was removed. This verifies
  CA startup and file recovery, not an entire replacement homelab brought online.
- Local-only and post-reboot both-on native-DNS HTTPS passed with fresh trusted
  TLS. Direct UDP/TCP gateway DNS served internal and unique public queries.
  Local Tailscale transport used Ethernet at 2 ms. Physical disconnection passed at
  October 8 01:24 UTC: native DNS and trusted HTTPS 200 worked over `utun5`,
  UDP/TCP DNS answered, restricted ports stayed blocked, and direct LAN HTTPS
  was unreachable. Tailscale used DERP(sfo) at 45 ms; no direct peer path
  was established.
- 501 unit/wire/conformance tests passed. Typecheck and whitespace checks passed.
  Linux x64 binary SHA-256 matched on Mac and Proxmox:
  `49cffa79e99340afa361f0ad3413f7663d5c55395c775fdc86fe8294d7db5777`.

## Operator security sign-off

The lab is still a beta validation installation, not a production approval.

- Technitium's default admin password successfully authenticated during the
  read-only audit. Change the provider account password and update Nomina's
  stored connection credential before production use. Account rotation was
  outside this session's credential-review scope.
- The existing Tailscale API token and reusable enrollment key both expire
  December 25, 2026. Their private files match the console's public IDs.
  The API token has full Tailscale API access. DNS read/write and device/policy
  reads were verified. Review scope and rotate before expiry.
  [Tailscale's API permission model](https://tailscale.com/docs/reference/tailscale-api).
- The retained gateway's device key expires April 5, 2027. The policy permits
  trusted tailnet members and was preserved. Old offline `tailscale` test-device
  registrations remain, including an expired entry. Review and remove only
  identities whose test ownership is established. LXC destruction does not
  remove its control-plane registration.
- Windows home-DNS UI behavior remains outside this Mac/native-DNS field run.

## Recovery state

Only retained VMIDs 100–103 remain, running. Renewal restoration is marked in
`/root/nomina-bunnytest/.nomina/renewal-check/restored`. Gateway fault injection
is cleaned up. Root-only backup/restore results and the clone cleanup marker
are under `/root/nomina-production-check-backups/recovery-1791420929261`.
Earlier failed helper attempts and evidence remain separately. Do not delete
the lab, reset its CA or remove client trust for cleanup.
