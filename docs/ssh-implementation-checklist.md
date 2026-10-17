# Host SSH implementation

SSH opens a shell on the machine running Nomina. Setup chooses an existing OS
account, defaulting to root. Nomina generates one downloadable private key;
replacement, disabling and removal revoke the previous key. VPN is optional:
LAN access works first, and provisioning Nomina's Tailscale VPN later makes the
same hostname work remotely. No router configuration, public listener, or port
forwarding on a home router is created. NetBird integration is deferred.

## Implementation

Checked items are implemented and covered by local checks. They do not replace
the separate live-server verification below.

- [x] Identify exposures independently of their hostname; preserve existing IDs.
- [x] Permit HTTPS/redirect plus TCP/SMB/SSH at the same hostname.
- [x] Reject competing web routes and competing TCP listener ports before writes.
- [x] Keep DNS until the last exposure using the hostname is removed.
- [x] Reject ambiguous hostname-only edit/removal; select by name or ID.
- [x] Run a dedicated host sshd without changing the system SSH configuration.
- [x] Bind only a verified local private IPv4 address; choose the account during setup.
- [x] Enforce the Nomina key exclusively, including root; reject password/interactive auth.
- [x] Generate/export the private key through root-only files; never print key material.
- [x] Prepare/download a replacement before activation; preserve working access until activation.
- [x] Complete disruptive operations independently of the SSH connection being revoked.
- [x] Replace/revoke keys and terminate managed sessions when disabling access.
- [x] Forward private client port 22 through the proxy to the host sshd.
- [x] Reconcile SSH when VPN is added later; preserve web, DNS and other TCP rules.
- [x] Integrate guided setup/edit/removal, domain changes, tracking and uninstall.
- [x] Add local regressions and run the full test suite and typecheck.

## Local verification — 2026-10-17

- [x] Full macOS `node --test` suite: 717 tests, 714 passed, 3 skipped, 0 failures.
- [x] `npm run typecheck`.
- [x] `npm run build:native`: compiled the Linux x64 binary.
- [x] `git diff --check`.
- [x] Real Ed25519 key generation, secure export and replacement tests.
- [x] Local OpenSSH effective-configuration validation (`sshd -T`).
- [x] Generated forwarding/firewall scripts exercised in isolated local fixtures.
- [x] Shared web/SSH/SMB/TCP lifecycle, later VPN provisioning and domain changes.

The three macOS skips require Linux's systemd-socket-proxyd, Linux pidfds and
PowerShell respectively. The Linux adapter/wire suite passed 36 tests with no
skips on Proxmox. The live run found and fixed PAM sessions escaping the daemon
cgroup; rotation, disable and interrupted removal now terminate those sessions.

## Sharing rules

All shared hostnames resolve to the managed proxy on the LAN and to the Nomina
VPN gateway remotely. HTTPS and redirects share the single web routing slot;
generic TCP and SMB use distinct client-facing ports, and host SSH owns port 22.
Two names do not make it possible to send the same ordinary TCP port to two
different backends. Existing listeners and unmanaged DNS/configuration are
preserved; conflicts produce an error. Docker discovery continues to suggest
distinct names but explicitly selected compatible sharing is supported.

## Live verification

- [x] Provision on dev Proxmox; verify root and a selected non-root login-shell account.
- [x] Export the key securely and connect with ordinary macOS/Linux OpenSSH.
- [ ] Verify downloaded-key installation and login with a Windows client.
- [x] Verify password, keyboard-interactive and unrelated administrator keys cannot authenticate.
- [x] Verify existing host SSH keys/configuration still work independently.
- [x] Verify host SSH and Proxmox HTTPS on the same name with Caddy and Traefik.
- [x] Provision VPN after SSH; verify the same command from a remote VPN client.
- [x] Associate the existing Tailscale gateway after SSH; reconcile without replacing its key.
- [x] Configure SSH with VPN already present; authenticate over its tunnel address.
- [x] Verify the same native-DNS SSH command with Ethernet disabled after fresh VPN enrollment (DERP relay).
- [x] Remove SSH: old key and active sessions fail; shared web/DNS/TCP survive.
- [x] Preserve existing SMB/Minecraft forwarding rules; verify retained web/DNS availability.
- [ ] Optional application check: authenticated SMB and game-client sessions alongside SSH.
- [x] Remove web first: SSH and DNS survive; remove final exposure: DNS is removed.
- [x] Replace the key: old key fails and new key works; host fingerprint stays stable.
- [x] Re-enable after removal: fresh client key required.
- [x] Reboot host, proxy and VPN gateway; repeat access and isolation checks.
- [x] Exercise occupied ports 22/22222 and interrupted setup/removal without damaging administration.
- [x] Exercise real CLI uninstall with isolated secrets and only disposable LXC ownership.
- [x] Confirm no home-router, public-interface or Internet forwarding was configured.

Live testing completed on dev `192.168.1.3`; retained LXCs 100–107, credentials,
configuration and administrative SSH were preserved. Initial fixtures 108/109 were replaced by a fresh DNS/proxy/VPN run.
Final fixtures 108–110, temporary VPN enrollment/zone, host keys/unit and exported
private copies were removed; original DNS and client settings were restored.
Default proxy administration is relocated privately to 22223 and restored on
removal/failure; no operator port workaround is required. See the
[live report](ssh-live-test-report.md) for the defect, evidence, exact scope,
cleanup and the remaining Windows/VPN limitations.

References: [OpenSSH server settings](https://man.openbsd.org/sshd_config),
[systemd TCP forwarding](https://github.com/systemd/systemd/blob/main/man/systemd-socket-proxyd.xml).
