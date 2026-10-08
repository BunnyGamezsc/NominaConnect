# Production check follow-ups

PR: https://github.com/BunnyGamezsc/NominaConnect/pull/24.
Evidence: [bunnytest field report](bunnytest-tailnet-field-report.md).
The retained deployment must stay installed. Do not merge the PR automatically.

## 1. Resolve the live exposure opt-out failure before production approval

The last disposable run passed nine subtests but failed the opt-out test.
After publishing `photos.productioncheck.internal` with `--tailnet false`,
the gateway LXC's connection to the proxy on TCP 443 was refused. The expected
result is a verified HTTPS response with status 404. Refusal does not prove
the intended access restriction or continued LAN availability.

Reproduce on a separate disposable project using the public CLI. Preserve
the retained project's credentials and tailnet DNS snapshot.

1. Publish with tailnet access enabled and verify HTTPS from the host and
   gateway. Capture active Caddy configuration, listening sockets and logs.
2. Republish with tailnet access disabled. Probe immediately and after a
   bounded settle interval, capturing the same evidence.
3. Distinguish a transient reload/listener gap from persistent loss of HTTPS
   or a background tracking mutation. Verify the process is still running.
4. If HTTPS disappears when the matcher changes, retain an explicit TLS
   listener/policy independent of the gateway exclusion. If only settling is
   missing, fix readiness verification rather than hiding persistent refusal.
5. Add a regression at the real wire seam. Require gateway HTTPS 404 even
   with forged forwarding headers, LAN HTTPS 200, then gateway 200 after
   reenabling access. Check HTTP redirects separately.

Do not mark this check passed until the full disposable run passes and restores
the exact previous tailnet DNS settings.

## 2. Rerun the corrected certificate-renewal helper

Automatic renewal was observed in Caddy's log and verified with a fresh Mac
TLS handshake: the serial changed and expiry advanced by almost five minutes.
The original polling helper reused a TLS session and continued seeing the old
leaf. The corrected helper uses fresh connections, requires synchronized time,
and starts the short test maintenance interval before collecting its baseline.

Run `tools/lab/check-certificate-renewal.mjs` on Proxmox only after keeping the
PC awake. Confirm a new serial, later expiry, trusted HTTPS and the `restored`
marker. Confirm only the two original exposures remain. No further run was
started when the operator requested a quick wrap-up.

## 3. Check partial-uninstall retry behavior

DNS-restoration failure now prevents destruction. Failed container destruction
retains state and credentials. Add a recovery test for a partially completed
uninstall followed by a retry: previously destroyed VMIDs must not prevent
completion, and an already stopped LXC must not be treated as a surviving
resource if destruction succeeds. Include the case where the gateway was
destroyed after DNS restoration but another LXC could not be destroyed.

This is a code-inspection concern, not a live-confirmed defect. Establish a
failing test before changing state persistence or missing-resource handling.
Keep enough private recovery information to retry without resetting unrelated
tailnet settings or targeting a reused VMID.

## 4. Final deployment verification

- Keep Windows awake and verify Proxmox NTP synchronization after host sleep
  or VM suspension. Chrony was adjusted in this lab to recover later jumps.
- Repeat gateway port restrictions after a full host reboot with the final
  raw-ingress firewall fix. The fix passed a Tailscale service restart, but
  the earlier full reboot preceded that final change.
- Repeat local-only, both-on and disconnected-client HTTPS checks using
  native DNS and a trusted CA. A stable Tailscale answer at home is expected;
  verify the transport path separately.
- Exercise backup/restore, including CA keys and provider data, in a disposable
  copy. A public root export is not a disaster-recovery test.
- Review admin-token permissions and expiry, default application credentials,
  and tailnet membership for the intended installation. The operator chose
  access for all trusted tailnet members; the existing tailnet policy was kept.
- Review offline test device entries in the Tailscale console. Destroying an
  LXC is not evidence that its control-plane device registration was removed.

## Changes already implemented

Issuer policy is installed before the Caddy route and replacements use PATCH;
managed LXCs start on boot; gateway IPv6 is closed; firewall replacements are
atomic; a raw ingress allowlist runs before Tailscale's accept hooks;
uninstall preserves recovery resources on failure and respects an isolated
credential store; exposure removal calls the actual Technitium DNS-delete
adapter. The unit/wire suite passed 499 tests, and typecheck passed.
