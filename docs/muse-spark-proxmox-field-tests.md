# Muse Spark 1.3: clean Proxmox tailnet field test

Run this work in a separate OpenCode thread with Muse Spark 1.3. Muse may
delegate focused code, log, or test analysis to Kimi K3 through NVIDIA in
OpenCode; keep all destructive Proxmox commands under Muse's own control.

The **only** target is the disposable VirtualBox Proxmox VM at `192.168.1.3`
on the Ethernet lab. The production server is out of scope. The latest repo
checkout is on the Mac. Do not print passwords, auth keys, API tokens, or
private project state in the thread or report.

## Verified starting point

- The VM's first NIC was re-bridged to the Windows Realtek Ethernet controller.
  Mac batch-mode root SSH to `192.168.1.3` works. The VM is `pve`, Proxmox VE
  9.2.2, with `vmbr0` at `192.168.1.3/24` and default route via the Mac at
  `192.168.1.1`. The web UI listens on port 8006.
- At the last read-only check, LXCs 100-103 existed but were **stopped**:
  Technitium, Caddy, step-ca, and Tailscale. The old full-stack project under
  `/root/nomina-fullstack` still had its config and private state. Recheck
  both before deleting; this baseline can change.
- A Windows VirtualBox Host-Only adapter named `Ethernet 4` was observed at
  `192.168.1.1`, conflicting with the Mac gateway. Its current state is
  unconfirmed. Resolve that duplicate on Windows if it remains. The Windows
  physical NIC was `192.168.1.2` with a reported gateway of `192.168.1.20`;
  confirm its current route before relying on it.
- The old per-LXC Proxmox NAT workarounds were absent at the last check. The
  Mac Ethernet gateway address is present, but its PF NAT state has not been
  verified. The old [run report](proxmox-test-run-report.md) explains the
  historical workarounds and 7/7 Caddy and Traefik acceptance runs.

## 1. Inventory, uninstall, and clear the disposable VM

Confirm the SSH host is `pve` at `192.168.1.3`. Record `pct list`, every LXC
config, relevant project paths, and the project-owned VMIDs without exposing
secrets. This VM is disposable for this task: the operator explicitly
authorized removing **all** of its LXCs and the old NominaConnect install.
Do not run these operations against any other Proxmox host.

Run the old project's `nomina uninstall --yes` from its project directory so
its state, provider resources, and managed LXCs are removed through the normal
path. Check the result against the inventory. Stop and `pct destroy` any
remaining LXCs on this **test VM only**, including old orphans; report each
VMID removed. Remove the old installed `nomina` binary from this VM after
confirming its path. Preserve Proxmox itself, its network configuration,
storage, templates, and the test source checkout. Verify `pct list` is empty
before provisioning again.

## 2. Use the existing Ethernet bridge

Use `vmbr0`; the VM is already reachable over the Realtek bridge. Do not run
the retired Windows host-only/`vmbr1` setup. Check VirtualBox NIC 1 is bridged
to the Realtek controller with promiscuous mode **Allow All**. Resolve the
Windows `192.168.1.1` address collision if still present. Test Mac/Windows
reachability and VM outbound DNS/internet. If an LXC cannot reach the Mac
gateway or Windows, diagnose nested MAC filtering before treating it as a
NominaConnect failure. Record any workaround and its cleanup; do not silently
reapply the September runtime NAT or DNS redirection rules.

## 3. Build on the Mac and copy the exact binary

Sync this local checkout's source to `/opt/nominaconnect-test` on the VM for
the Node acceptance suite. On the Mac, run `bun install`, then:

```sh
bash tools/lab/deploy-local-build.sh root@192.168.1.3
```

The script runs `build:native` on the Mac, copies the Linux x64 binary to
`/opt/nominaconnect-test/nomina-linux-x64`, compares SHA-256 hashes, and runs
its `--version` on the VM. Use that absolute path for every product CLI test.
The acceptance suite imports source modules directly, so report its results
separately from binary tests. Rebuild, recopy, and recheck the hash after any
source change. Do not use a release download or the old `/usr/local/bin/nomina`.

## 4. Provision from empty state and test

Run `node --test` and `pnpm exec tsc --noEmit` on the matching source. Select
a Debian template actually present on the VM, free static IPs on
`192.168.1.0/24`, the active storage, `vmbr0`, and a working LXC gateway.
Start `node tools/lab/backend.mjs` on the Proxmox host for a known HTTP
backend at `192.168.1.3:8080`.

Run `acceptance/live-proxmox.acceptance.mjs` with its disposable gates first
for Caddy, then for Traefik. Use the [acceptance guide](live-proxmox-acceptance.md)
for required environment variables. After confirming LXC traffic can reach
the Mac gateway directly, the lab values are `NOMINA_ACCEPTANCE_BRIDGE=vmbr0`,
`NOMINA_ACCEPTANCE_GATEWAY=192.168.1.1`, DNS `.53`, proxy `.54`, and backend
`192.168.1.3:8080`. If nested MAC filtering still blocks that route, stop and
diagnose it before choosing another gateway or adding NAT rules. Confirm the
suite removes only its own LXCs between runs and records 7/7 checks or exact
failures.

Then create a fresh full-stack project with the **deployed binary**:
Technitium, Caddy or Traefik, step-ca, and Tailscale. Verify actual LXC
health, managed DNS, trusted HTTPS, Tailscale enrollment, and an allowed
exposure. Publish another exposure with `--tailnet false`. Test direct local
access, a separate remote tailnet client, and a client at home with Tailscale
connected. The opted-out exposure should return 404 through the tailnet
gateway, including at home, unless the optional home DNS helper has switched
that client to local DNS. Record resolver answer, destination IP, HTTP result,
and certificate result for each case. Verify Technitium blocking remains in
effect and no LAN `/32` routes are advertised. Capture prior tailnet global
DNS settings and verify safe restoration when Tailscale is removed.

## 5. Report and cleanup

Write `docs/muse-spark-proxmox-field-report.md`: baseline inventory, precise
build and hash evidence, commands with secrets redacted, acceptance results,
the local/remote/at-home matrix, defects versus lab problems, and unresolved
limits. Fix reproducible product or harness defects with focused tests and
repeat the affected binary field tests after redeployment.

Remove only the **new** project and its LXCs through NominaConnect's uninstall
path, then confirm `pct list` is empty and the original VM management address
still works. Restore tailnet DNS only through the product's guarded cleanup;
if an external change blocks restoration, report it instead of overwriting it.
