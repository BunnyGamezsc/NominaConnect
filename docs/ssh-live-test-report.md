# Host SSH live verification — October 17, 2026

The SSH implementation was exercised on the **dev** Proxmox host
`192.168.1.3`, using the native Linux binary and actual OpenSSH, systemd,
Technitium, Caddy, Traefik and Tailscale processes. Production was not accessed.
Review and live testing found and fixed session revocation, interrupted
publication cleanup, effective systemd ownership, adoption verification and
commands disconnecting their own controller. Default proxy setup now works
without manually disabling its administrative SSH service.

Final validation: **717 macOS tests: 714 passed, three platform-dependent skips,
zero failures**; **36 Linux host/proxy/forwarding/controller tests passed with
zero skips**. Typecheck, native Linux build and whitespace checks passed.
The original run is documented below, followed by the final PR-readiness checks.

## Deployment and isolation

Initial-run native binary:
`/opt/nominaconnect-test/nomina-linux-x64`, version `2.5.1`, SHA-256
`9e4edeafd74fa6971d94367b8a103acb1c6de4c36eb4d67b5c46469bc91a5511`.
It was built from the current uncommitted checkout and copied with
`tools/lab/deploy-local-build.sh`; local and remote hashes matched.

The retained `/root/nomina-bunnytest` installation and all preexisting LXCs
**100–107** were preserved. Isolated projects used the existing Technitium
credential/reference but owned only new Caddy **108 / 192.168.1.90** and
Traefik **109 / 192.168.1.91**. Both were provisioned through the native CLI.
Fixture names were `ssh-live.bunnytest.internal` and
`ssh-traefik-live.bunnytest.internal`.

The first run exposed the default proxy port-22 conflict. It is resolved:
standard Debian administration is relocated to the proxy's private port 22223
using reversible owned systemd drop-ins. Existing SSH configuration, keys,
fingerprint, enabled states and active administrative sessions are preserved.
Removing host SSH or failing publication restores the original listener. Custom
SSH policies/overrides or unrelated listeners are preserved and rejected before
credential creation. This behavior passed against a fresh default proxy.

## Results

| Live check | Result and evidence |
| --- | --- |
| Selected root account | Native `ssh enable`, key export and login through proxy `:22` and dedicated host `192.168.1.3:22222`; shell returned `root` on `pve`. |
| Selected non-root account | Temporary `nomina_ssh_live` account had `/bin/bash` and a locked password. Generated-key login returned that account, through both proxies. |
| Ordinary workstation login | Exported key copied securely to macOS with mode 0600; ordinary OpenSSH using `ssh-live.bunnytest.internal` returned `root` on `pve`, without DNS or hosts edits. Linux client logins also passed. |
| Credential isolation | Real Mac administrator key still authenticated on OS port 22 and was rejected on dedicated port 22222. Password-only and keyboard-interactive-only attempts were rejected; `sshd -T` confirmed public-key-only policy, no authorized-key file and no trusted user CA. |
| Export safety | Mode 0600 verified. Export/replace into an existing output file failed while the active key remained valid. Private key contents were never printed. |
| Rotation | Old key rejected, new key accepted, host fingerprint unchanged. A live authenticated `exec sleep 600` session was terminated. |
| Disable/re-enable | Root and non-root flows exercised; old keys failed, re-enable generated a different key. A non-root shell with a background sleep was terminated on disable. |
| Caddy shared hostname | Real Proxmox HTTPS response 200, SSH and a separate TCP listener 18090 shared one DNS name. Removing web preserved SSH/DNS; removing SSH preserved HTTPS/DNS/TCP. DNS remained through the final TCP consumer and disappeared after its removal. |
| Traefik shared hostname | Real Proxmox HTTPS 200 and SSH shared one name. Removing web retained SSH/DNS; removing its final SSH exposure removed fixture DNS. |
| Existing VPN associated after SSH | Associating retained gateway 103 with the isolated inventory and reconciling SSH preserved its key and added only gateway TCP 22 targeting fixture proxy 108. |
| SSH enabled with VPN already present | Disable/re-enable ran with that gateway configured. Mac SSH to `100.109.138.62:22` returned the selected non-root account on `pve`; the old key failed over the VPN. Route used `utun4`; Tailscale ping used an encrypted direct peer path through `192.168.1.57:41641`. |
| Restart | Dedicated host daemon, proxy forwarding and gateway firewall restarted. SSH through both proxies, HTTPS, DNS and TCP still worked. |
| Full host reboot | Boot ID changed from `bca048ea-19ec-468d-adbb-90db20e8158e` to `a353377b-98be-4081-aaf9-f170d40ee861`. All LXCs 100–109 auto-started. Both proxy SSH paths, HTTPS/DNS/TCP and VPN SSH passed afterward; SSH fingerprint remained unchanged. |
| Occupied listeners/account validation | Proxy port 22 and host port 22222 conflicts rejected safely, without generating usable host credentials. A nologin account was rejected. |
| Interrupted setup/removal | Injected failure at the real service-start boundary revoked newly generated authorization; retry authenticated successfully. Injected stop failure still revoked authorization and terminated a live session; exported key failed and uninstall retry completed. Other commands and actual filesystem/process behavior remained real. |
| Scoped nuclear uninstall | Production CLI dispatcher with real host/proxmox adapters removed active dedicated SSH and only owned Traefik 109. An isolated secret-store root prevented this fixture from deleting retained credentials. Default native nuclear uninstall against the shared global store was deliberately not run. |
| Listener isolation | Dedicated host service listened only on selected private IPv4 `192.168.1.3:22222`; proxy listeners bound their selected private addresses. No home-router settings or public forwarding were added. |

Caddy/Traefik fixture HTTPS checks validated routing and application HTTP 200;
they used untrusted fixture certificates. Final retained application checks
separately validated trusted certificate chains and native DNS.

## Defect and correction

Before the fix, an authenticated root sleep survived `revoke()`. Its cgroup was
`/user.slice/user-0.slice/session-37.scope`: PAM moved the session outside
`nomina-host-ssh.service`, so service cgroup termination missed it.

Revocation now clears the authorized/client keys, obtains the dedicated daemon's
MainPID, captures its descendants while their ancestry remains available and
terminates them through Linux pidfds before stopping the daemon. Process start
identities are checked to avoid targeting reused PIDs. This leaves unrelated
SSH sessions alone. If session cleanup fails, authorization is still revoked
and the daemon is stopped, but incomplete cleanup is reported. Python 3 with
Linux pidfd support is now an explicit supported-host prerequisite.

The actual live PAM session, rotation session, non-root session and interrupted
removal checks passed after correction. The Linux regression also kills a
descendant in a separate session/process group while preserving an unrelated
process and the parent daemon.

## Preservation and cleanup

- Only new LXCs 108 and 109 were destroyed. Preexisting 100–107 remain running.
- Retained `nomina.yaml` and state bytes are identical to their saved baselines.
  Retained credential hashes and OS `/etc/ssh` plus administrator credential
  hashes match. The OS SSH service remains active and usable.
- Gateway scripts were restored byte-for-byte. Firewall rules match the original
  snapshot exactly after excluding iptables-save's generated timestamp comments.
  Existing SMB/Minecraft rules were retained; fixture TCP 22 was removed.
- Dedicated host SSH unit, keys, fixture DNS, login account/home and exported
  private-key copies on both machines were removed. Test evidence remains root
  private on Proxmox, without exported private keys.
- The Mac's original Tailscale profile `cbe0` and `Stopped` state were restored.
  The existing lab profile was used temporarily; no tailnet DNS settings changed.
- After cleanup, fresh native-DNS HTTPS to retained DNS and Proxmox returned
  **200 with verified TLS** both through gateway `100.109.138.62` and locally
  through `192.168.1.54`. Gateway administration port 22 was blocked again, as
  were the existing restricted IPv4/IPv6 ports. Internal/public UDP and TCP DNS
  checks passed.

Initial harness mistakes are retained in raw results: stale known_hosts after
intentional uninstall, using the host's public resolver instead of explicitly
querying lab DNS, overlapping two fixture stages, comparing iptables timestamp
comments and attempting user deletion before its PAM user manager exited.
Each affected assertion was corrected or independently rechecked. These are
separate from the reproduced product PAM revocation defect. Raw results are
an execution history, not a zero-failure summary.

## Reproduction and artifacts

The staged development harness is saved with the local evidence as
`/Users/shridhar/Desktop/nomina-ssh-live-evidence-20261017/check-host-ssh-live.mjs`
and on the dev host as `/root/nomina-ssh-live-20261017/check.mjs`.
It requires root, explicit `NOMINA_SSH_LIVE=1`, dev address `192.168.1.3`, the
recorded isolated fixture projects/source and matching binary. It is intended
for this lab setup; phases must run sequentially and exported paths must be
fresh. It does not provision its fixtures or reboot automatically.

The exact setup scripts and original executed harness remain on the dev host:

```text
/root/nomina-ssh-live-20261017/prepare.mjs
/root/nomina-ssh-live-20261017/prepare-traefik.mjs
/root/nomina-ssh-live-20261017/check.mjs
/root/nomina-ssh-live-20261017/results.json
/root/nomina-ssh-live-20261017/linux-final.tap
```

Preparation copied the retained configuration, kept only its DNS reference,
selected a fresh proxy ID and empty service inventory, and provisioned these
two disposable proxies through the native binary. Exact provision arguments:

```sh
nomina service add caddy --ip 192.168.1.90 --hostname ssh-live-caddy --bridge vmbr0 --storage local-lvm --template debian-12-standard_12.12-1_amd64.tar.zst --gateway 192.168.1.3 --nameserver 192.168.1.53 --cpus 1 --memory 256 --disk 2
nomina service add traefik --ip 192.168.1.91 --hostname ssh-live-traefik --bridge vmbr0 --storage local-lvm --template debian-12-standard_12.12-1_amd64.tar.zst --gateway 192.168.1.3 --nameserver 192.168.1.53 --cpus 1 --memory 256 --disk 2
```

Run harness phases with `NOMINA_SSH_LIVE=1 node <harness> <phase>`:
`root`, `shared`, `disable`, `nonroot`, `vpn`, `traefik`,
`nonroot-reenable`, `restart`, then explicitly reboot the dev host and run
`postboot`, `export-safety`, `cleanup`, `cleanup-recheck`, `fault-injection`.
The phase `adapter-root` is a standalone diagnostic requiring a clean managed
host SSH directory; it was used to reproduce the original session defect.

The Linux checks ran from the matching source copy:

```sh
node --test test/host-ssh-adapter.test.js test/tcp-adapter-wire.test.js
```

Public results, TAP files, boot/cgroup evidence, public CA root and final LAN/VPN
readiness JSON are also saved locally under
`/Users/shridhar/Desktop/nomina-ssh-live-evidence-20261017`.

## Final PR-readiness follow-up

The integration run used binary SHA-256
`9adeb1897cf35d46335f50ca935c74a51f4b575ddaee3ddb768b5377e3a2ecd6`.
The final PR binary, including the additional guarded handoff for individual
LXC destruction, is
`3cc0ca4b5618e8a1b3d2c7e1a866d1abeb8cf8659f90e897f4cc2243e84c43d0`.
The additional disposable fixture used Technitium **108 / 192.168.1.91**,
Caddy **109 / 192.168.1.90** and a freshly enrolled Tailscale gateway
**110 / 192.168.1.92**, with VPN address **100.69.235.77**.

- Fresh default proxy setup moved administration to private 22223 automatically.
  The original administrator key and fingerprint still worked, an open
  administrative session survived, and removal restored exact active/enabled
  states and original port 22. An injected forwarding failure rolled back the
  move and revoked host credentials.
- DNS publication failure now removes newly created forwarding, restores proxy
  administration and removes only unshared fixture DNS. The regression proves
  existing shared web routes and DNS remain intact.
- Initial setup rejects preexisting systemd unit fragments and overrides.
  Disabled owned access can be reconfigured for a different existing account or
  assigned private address. SSH adoption requires both forwarding and actual
  key authentication to report verified health.
- `ssh prepare-key` exports a pending key while the old key remains usable.
  The old key successfully downloaded the replacement through real SFTP.
  `ssh activate-key` was then invoked through the managed SSH connection:
  its detached operation completed after closing that connection, the old key
  failed, the downloaded key worked, and the server fingerprint was unchanged.
  `ssh disable` invoked through managed SSH likewise completed removal and
  restored proxy administration. Operation status/log files are root private.
- Fresh VPN enrollment occurred after SSH was already working. Its original
  client key was preserved. Production gateway configuration and DNS writes
  were verified with exact prior DNS/preferences/split-DNS snapshots.
- On macOS, native LAN DNS resolved `ssh.sshaccept.internal` to the proxy before
  VPN provisioning. With VPN enabled the same hostname resolved to
  **100.69.235.77**, routed through `utun4`, and ordinary OpenSSH returned `pve`.
- With the Ethernet service disabled, the direct LAN host was unreachable while
  that same native-DNS SSH command succeeded over **DERP(sfo)**. Retained DNS and
  Proxmox HTTPS both returned 200 with verified certificates. This was a software
  Ethernet disconnection, not a claimed physical cable removal. Ethernet was
  restored in a `finally` block, with an independent recovery timer.
- Final proxy 109 and gateway 110 reboots recovered host SSH, private proxy
  administration and persisted gateway rules. VPN SSH passed afterward.

Additional evidence is stored under
`/root/nomina-ssh-final-20261017` on the dev host and
`/Users/shridhar/Desktop/nomina-ssh-live-evidence-20261017` locally, including
`operation-results.json`, `vpn-closure.json`, `reboot-final.json`,
`linux-closure.tap` and `ssh-final-vpn-client.json`. Raw histories include
corrected harness issues (stock PAM startup delay, separate known_hosts for
proxy administration versus host access, a closed HTTP socket in Node 26, and
Tailscale ping returning nonzero after a successful relay pong).

## Standards review

Fixed effective-unit ownership checks, verified-adoption health and disabled
account/address reconfiguration. Failed-publication recovery now restores
administration as required by ADR-0042. No unresolved reviewed code findings.

## Spec review

Fixed controller self-termination and added staged key download/activation for
users whose only remote path is Nomina SSH. Default setup, shared-hostname
removal, fresh VPN provisioning, native DNS, off-LAN relay access and restart
recovery were exercised. Certificate portal implementation is outside this PR.

## Final cleanup

All additional fixtures 108–110 and their fresh VPN device were removed.
The owned test DNS zone, staged/exported client keys, dedicated host unit/keys
and newly owned fixture credentials were removed. Prior tailnet DNS, preferences
and split-DNS matched the original snapshot. Retained project/state bytes and
credential digests matched; LXCs 100–107 remained running. The Mac Ethernet
service was enabled and its original `cbe0` Tailscale profile was restored in
Stopped state. Fresh native-DNS trusted HTTPS and DNS/firewall checks passed
through the original VPN gateway and locally after restoration.

## Client coverage

Linux and macOS OpenSSH were exercised. A real Windows client login was not
run; it is a documented manual compatibility check, not a dependency on a
Windows machine or a request to expose its SSH server. Existing SMB/Minecraft
rules and transport availability were preserved; this SSH run did not repeat
application-level SMB credentials or game-client sessions.

## CodeRabbit follow-up — local verification only

Managed-session detection previously depended on `SSH_CONNECTION`, which an
elevated shell started by `sudo` or `su` can lose. It now falls back to Linux
process ancestry using the dedicated daemon's root-owned PID file. Uncertain,
unsafe or unreadable process metadata stops disruptive inline work; detached
workers still bypass handoff to avoid recursion. Regression fixtures cover
elevated sessions, independent consoles, command names containing parentheses,
missing PID files, malformed metadata and ancestry cycles.

Added JSDoc for changed named functions and production methods to address the
review's documentation coverage warning. Local validation passed:
`node --test test/*.test.js` (719 tests, 716 passed, 3 platform skips, 0 failures),
`npm run typecheck`, `npm run build:native` and `git diff --check`.
No additional live-server tests were run for this follow-up, as requested.
