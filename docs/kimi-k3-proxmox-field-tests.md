# Kimi K3 handoff: Proxmox VM field tests

Use this document in a separate Kimi K3 thread. Work from NominaConnect
`feat/tailnet-exposures`, the branch behind [PR #24](https://github.com/BunnyGamezsc/NominaConnect/pull/24).
The Windows PC hosts the VirtualBox **test VM at `192.168.1.3`**, bridged onto
an isolated Ethernet network. The production Proxmox server is out of scope:
do not SSH to it, copy binaries to it, or run tests there.
In the September 6 run, the Mac (`en8`, `192.168.1.1`) provided that Ethernet
network with internet through Wi-Fi (`en0`) and PF NAT. VirtualBox filtered
LXC MAC addresses, so workstation-to-LXC access was blocked. Read
[the run report](proxmox-test-run-report.md) for what actually passed;
[the older walkthrough](proxmox-test-run.md) contains historical instructions
and an outdated statement that acceptance was never run.

## Goal and boundaries

Set up the Windows-hosted lab with the
[self-service launcher](../tools/lab/README.md), prove Windows can reach real
LXCs on `vmbr1`, then field test the current PR against the VM. Keep a clear
line between lab networking failures, acceptance harness failures, and product
failures. Do not claim at-home access is seamless while Tailscale remains on.
Do not paste passwords, Tailscale keys, admin tokens, or full private state into
the thread or report.

The machine is disposable for this run, but existing containers may still be
present. Inventory `pct list` first. Destroy only LXCs created by a test
project and identified by that project's state. Leave unrelated LXCs alone.

## 1. Recover access and record a baseline

The operator forgot the **test VM's** Proxmox password. September 6 OpenCode
sessions record key-based root SSH to
`192.168.1.3` at that time. The key's present location and validity are
unverified; do not assume the production server's key works here. First make
sure the Ryzen PC and VirtualBox VM are powered on and the Ethernet lab path
is reachable: one prior session lost contact with the VM while the Mac
gateway was still healthy. Then probe
`root@192.168.1.3` with batch-mode SSH first. If a key still works, reset the
password with
`passwd root` in an interactive SSH or VM console session. If no key works,
use the VirtualBox console and the
[Proxmox root password reset guide](https://pve.proxmox.com/wiki/Root_Password_Reset).
Do not automate a password reset by editing the guest disk. Confirm root SSH
and the Proxmox web login using `root@pam` before changing networking.

Record, with secrets redacted: Windows version, VirtualBox version, Proxmox
version, VM name, current VM NIC modes, current Proxmox IP/default route,
`pct list`, and `pvesm status`. Confirm the test VM is `192.168.1.3` with a
default route through the Mac gateway `192.168.1.1`. If the Mac's prior gateway
is off, follow [the Mac gateway guide](../tools/lab/README.md#earlier-mac-gateway)
before testing outbound traffic. If the bridged Ethernet connection is not
working, restore it in the VirtualBox console before using the launcher.
The prior sessions used runtime-only forwarding, MASQUERADE, and DNS DNAT
workarounds on `vmbr0`; these may have vanished on reboot. The new `vmbr1`
script supplies its own persistent bridge and NAT, so inventory old rules and
containers but do not reapply the old workarounds blindly. A later September
session asked to leave the full-stack LXCs running, so an empty `pct list` is
not a safe assumption.

## 2. Set up the Windows lab network

On Windows, clone this branch or copy `tools/lab` together. Follow
[the lab guide](../tools/lab/README.md). Shut down the VM, then run its
PowerShell launcher as Administrator with the VM name and `root@192.168.1.3`.
Add `-SshIdentityFile` if using the recovered key. Do not assume the old
key works merely because it worked in September. The launcher runs SSH from
Windows, so a key available only on the Mac does not automatically work there.
If Mac SSH succeeds, install a Windows public key into the **test VM's** root
`authorized_keys` over that connection, or recover a console login. Do not
copy a private key or change credentials on the production server.

Default lab addresses:

| Role | Address |
| --- | --- |
| Windows host-only adapter | `172.28.240.1/24` |
| Proxmox `vmbr1` and LXC gateway | `172.28.240.3/24` |
| Technitium LXC | `172.28.240.53` |
| Caddy or Traefik LXC | `172.28.240.54` |
| step-ca LXC | `172.28.240.56` |
| Tailscale LXC | `172.28.240.57` |

If the default subnet overlaps the Windows host, choose another private
`-LabPrefix` and substitute it everywhere below. After setup, check from
Windows that `Test-NetConnection 172.28.240.3 -Port 8006` succeeds. Check
`setup-virtualbox-proxmox.ps1 -Action status` and, on Proxmox, `ip -br addr`,
`ip route`, `sysctl net.ipv4.ip_forward`, and the lab NAT rule. Note whether
VirtualBox actually forwards traffic from an LXC MAC to the Windows host.
This is the main previously unproven point.

## 3. Build locally and deploy the exact binary

On the **Mac with the latest local checkout**, build that checkout rather than
a published release or a fresh build on Proxmox. Install Bun and run
`bun install` once in the checkout. Then run from the repository root:

```sh
bash tools/lab/deploy-local-build.sh root@192.168.1.3
```

If the key is not your SSH default, append its path, for example
`~/.ssh/id_ed25519`. The script
runs the repository's `build:native` script locally, copies
`dist/nomina-linux-x64` to `/opt/nominaconnect-test/nomina-linux-x64` on the
VM, verifies matching SHA-256 hashes, and runs the deployed binary's
`--version`. Record the commit ID, any uncommitted local changes, and both
hashes in the report. Abort field tests if build, copy, hash verification, or
the version check fails. Rebuild and redeploy after every code change.
`deploy-local-build.ps1` is an alternative only if the working checkout later
moves to Windows.
This matches the previous full-stack run's pattern: build on the Mac, copy
`dist/nomina-linux-x64` to the test VM, compare hashes, then invoke that
binary. The September acceptance runs used synced source, which is why the
binary field test remains a separate required step.

Copy or check out the matching source under `/opt/nominaconnect-test` on
Proxmox for the acceptance suite. Install the repository's Node version and
dependencies there, then run `node --test` and `pnpm exec tsc --noEmit`. The
historical walkthrough says `bun test` used the wrong runner; use Node's test
runner. The acceptance suite imports source modules directly; it is a
source-level check, **not** proof that the copied binary was tested. Keep the
binary in `/opt/nominaconnect-test` separate from any installed release.

Start the included backend on the Proxmox host in a separate shell with
`node tools/lab/backend.mjs`. Confirm `http://172.28.240.3:8080/` returns
`nomina lab backend ok`. Keep it running for acceptance and exposure tests.

## 4. Run the live acceptance suite twice

Use an empty, disposable address set. On the Proxmox root shell:

```sh
export NOMINA_ACCEPTANCE=1
export NOMINA_ACCEPTANCE_DISPOSABLE=yes
export NOMINA_ACCEPTANCE_STORAGE=local-lvm
export NOMINA_ACCEPTANCE_BRIDGE=vmbr1
export NOMINA_ACCEPTANCE_TEMPLATE=debian-13
export NOMINA_ACCEPTANCE_GATEWAY=172.28.240.3
export NOMINA_ACCEPTANCE_DNS_IP=172.28.240.53
export NOMINA_ACCEPTANCE_PROXY_IP=172.28.240.54
export NOMINA_ACCEPTANCE_BACKEND=172.28.240.3:8080
node --test acceptance/live-proxmox.acceptance.mjs
```

Select a template actually present in `pveam list local`; do not assume
`debian-13` is already downloaded. Run first with Caddy, then set
`NOMINA_ACCEPTANCE_PROXY=traefik` and run again after the first suite has
removed its LXCs. Record assertion names, pass/fail, elapsed time, and the
surviving `pct list`. Do not destroy an unknown VMID to free an address.

After each provider is installed, test from Windows:
`Test-NetConnection 172.28.240.53 -Port 5380`,
`Test-NetConnection 172.28.240.54 -Port 443`, and
`Resolve-DnsName photos.acceptance.test -Server 172.28.240.53 -Type A`.
The acceptance suite itself runs on Proxmox, so these Windows checks separately
prove the host-to-LXC path.

## 5. Exercise the new tailnet path

Create a separate full-stack project on the disposable VM, using **only**
`/opt/nominaconnect-test/nomina-linux-x64` for NominaConnect commands. Use `vmbr1`,
Technitium, Caddy, step-ca, and Tailscale. Use the current CLI help and
[README tailnet section](../README.md#tailnet-access-to-exposures) for flags.
Supply the Tailscale auth key and admin DNS token only through the CLI prompt
or `NOMINA_TAILSCALE_API_TOKEN`; never record them. The tailnet DNS change is
global, so capture the prior nameservers and override flag for comparison.

Publish two hostnames with the same backend. Allow tailnet access for one and
use `--tailnet false` for the other. Test this matrix:

| Origin and query path | Allowed exposure | Opted-out exposure |
| --- | --- | --- |
| Windows direct LAN DNS and proxy address | HTTPS reaches backend | HTTPS reaches backend |
| A separate remote tailnet client using Tailscale DNS | HTTPS reaches backend | Proxy returns 404 |
| Windows at home with Tailscale DNS still enabled | HTTPS uses gateway | Proxy returns 404 |
| Windows at home after the optional home DNS helper verifies local DNS | HTTPS reaches backend locally | HTTPS reaches backend locally |

The last row requires Windows' ordinary system resolver to use Technitium
(`172.28.240.53`) after Tailscale DNS is disabled. Check that first; the helper
will restore Tailscale DNS if the system resolver does not return the expected
LAN answer. Record the actual DNS answer and destination IP for each case.
Do not treat a successful direct `Resolve-DnsName -Server` query as proof that
the system resolver uses Technitium.

Also verify that a Technitium-blocked hostname stays blocked through the
tailnet DNS gateway, that allowed managed A answers use the gateway's `100.x`
address, and that no LAN `/32` subnet routes are advertised. Verify the
gateway accepts only TCP 80/443 for web forwarding. Test a client with an exit
node separately; Tailscale documents that an exit node can change which DNS
resolver is local to the client.

Remove the Tailscale service at the end and compare global nameservers plus
DNS override to the saved values. If someone changed tailnet DNS externally
after setup, record the refusal instead of forcing restoration.

## 6. Report and cleanup

Write `docs/kimi-k3-proxmox-field-report.md` with the environment, exact
commands after redaction, expected and observed results for each matrix row,
logs needed to reproduce failures, and a verdict for each failure: lab,
acceptance suite, product, or unverified. Fix reproducible product or harness
defects on the PR branch with focused tests; explain any behavior that cannot
be checked with the available devices. Run `node --test` and TypeScript again
after code changes, then run the Mac deployment script again and record
the new hash before retesting the binary.

Remove test projects by their own NominaConnect uninstall path. Check `pct list`
against the baseline. Only then run the Windows lab launcher's `-Action remove`
to remove `vmbr1`, NAT and the dedicated host-only adapter. Confirm the VM's
original management connection still works. Do not erase the report during
cleanup.
