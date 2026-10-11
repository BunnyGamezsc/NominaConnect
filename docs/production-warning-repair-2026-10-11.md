# Production tracking warning repair

Production host: `192.168.4.85`, hostname `nuc`. Inspected and repaired on
October 11, 2026, through the existing `pve` SSH connection. No containers
were deleted, recreated, stopped, or reconfigured. Only the step-ca service
inside LXC 102 was restarted.

## Findings and repairs

The CA was healthy. `systemctl show step-ca` reported `active/running`, and
`step ca health --ca-url https://localhost:9000` passed against its existing
root certificate. The same verified request to `https://192.168.4.87:9000`
failed because the server certificate had no IP SAN. Nomina's adapter mapped
that TLS error to `process=stopped`, producing the misleading warning.

After backing up the CA, added `192.168.4.87` to `dnsNames` in
`/var/lib/stepca/config/ca.json` and restarted `step-ca.service`. The verified
IP health check then returned `ok`. Its root and intermediate certificates
and both private keys remained byte-for-byte identical. No trust reset,
reinitialization, software upgrade, or new container was needed.

The CA hostname does not resolve through Technitium from LXC 102, but Caddy
already has a working host mapping for `step-ca.bunny.internal`. Existing
Caddy issuance configuration was preserved. No DNS record was added for
the CA because the IP SAN repair resolves Nomina's health failure.

The apex `bunny.internal` has one A record, one NS record, and one SOA record.
These are normal records, not three competing exposure records. Glance had
no stored DNS integration locator, so tracking matched all three by hostname.
The app now restricts DNS reference candidates to the managed record type and
zone. It recorded the existing A reference without writing to Technitium.
Multiple matching A records still produce an ambiguity warning.

The YAML parser loads redirect code `308` as a string, while Caddy returns a
number. Strict comparison generated a verified Glance change on every pass.
Tracking now compares the codes numerically. Regression coverage includes
both 307 and 308 through the real YAML parser.

Repeated pending verification warnings now coalesce by their scope and exact
message. Their occurrence count and first/last timestamps are retained.
Previously saved duplicate warnings are grouped when displaying the pending
summary. Separate change events remain separate.

Step-ca TLS and network failures reported by the adapter's unreachable path
now retain unknown process state and a diagnostic reason. TLS validation
failures do not claim that the CA process stopped. Provider health reporting
and tracking preserve that reason.

## Installed build and validation

Installed a local, unpublished `2.5.1` hotfix at `/opt/nominaconnect/nomina`.
The existing `/usr/local/bin/nomina` symlink is unchanged. The build used
`git archive HEAD` plus only the six changed runtime/package files. Existing
working-tree changes in `src/docker-hosts.js` and its tests were preserved
locally and excluded from the production binary.

Binary SHA-256:
`a0f55d89471ef97e2e2a47fc0d266a59f479f560375c909bc46ebb34aa44b88c`.
Upload hash and installed version were verified before using the CLI.

- Eight focused regression tests reproduce the warning/redirect patterns,
  protect multiple-A ambiguity and missing/wrong-zone refusal, and check
  warning grouping and truthful TLS failure reporting.
- Full Node suite: 667 passed, two skipped, zero failures.
- TypeScript check and `git diff --check`: passed.
- A complete read-only production adoption pass reported zero warnings and
  only the expected missing Glance DNS reference before committing it.
- First installed CLI pass recorded that reference with zero warnings.
  Second installed CLI pass left zero pending notices and zero warnings.
- Verified TLS chains and hostnames against the existing CA root for
  `bunny.internal`, `home.bunny.internal`, `dns.bunny.internal`,
  `pve.bunny.internal`, `status.bunny.internal`, and `stats.bunny.internal`.
  These checks verify TLS, not application login or backend behavior.
- All six LXCs remained running: 100, 101, 102, 103, 104, and 106.
  VM 105 remained stopped. LXC/VM inventories and configuration files matched
  their saved baseline exactly. Docker inventory in LXC 106 was unchanged.
- `/root/nomina.yaml` remained byte-for-byte identical. Only operational state
  changed to record the DNS reference and acknowledge the archived notices.

## Backups and rollback

Root-only backup directory on production:
`/root/nomina-warning-repair-20261011`.

It contains the original binary as `nomina-2.5.0`, `VERSION-before`, project
YAML and state, LXC/VM configurations and inventories, the CA archive,
certificate/key hashes, both CLI notice receipts, binary hashes, and final
verification evidence. Original notices were archived before acknowledgement.
The directory contains credentials and private CA material; keep it root-only.

To roll back the CLI as root on production, install the saved binary to a
temporary sibling, then rename it over `/opt/nominaconnect/nomina`, and restore
`VERSION-before` to `/opt/nominaconnect/VERSION`. Leave the existing
`nomina.bak` and `/usr/local/bin/nomina` symlink intact.

To undo the CA repair, restore only `var/lib/stepca/config/ca.json` from
`step-ca.tar` into LXC 102, then restart `step-ca.service`. Do not restore or
replace the CA keys or certificate files. Undoing the SAN repair will restore
the original verified-IP health failure.

The read-only diagnostic source is
`tools/diagnostics/tracking-check.js`. Its compiled copy is retained at
`/root/nomina-warning-repair-20261011/tracking-check` and accepts `/root` as
its project directory argument. It inspects and computes adoptions without
committing them. No release or pull request was published in this session.
