# Household device setup

After provisioning step-ca or Caddy Internal CA in the menu, **Skip for now** is the initial choice. **Set up household devices** opens the same workflow later. Scripted provisioning finishes at CA provisioning. The operator owns the exports and distributes them manually.

## Add device setup to an existing project

Upgrade the Nomina binary through the usual [installation path](../README.md#install) once a release includes device setup. Open Nomina from the directory with the existing `nomina.yaml` and `.nomina/state.json`. The upgraded CLI reads the existing project directly. Choose **Set up household devices** to opt in. This opens the same workflow offered after CA provisioning in a new project and uses the root from your existing managed CA.

Saving the first package adds its definition to `nomina.yaml` and a stable package identity to `.nomina/state.json`. The existing deployment, provider references, and exposure settings carry over. Keep both files together when backing up the project. Installing the binary alone does not add a package.

**Use the device’s existing DNS** is the default for Apple. The profile includes the CA and optional shortcuts. Private names still need to resolve through DNS already available on that device, such as the LAN or Tailscale. This option needs no DoT listener, resolver settings, or resolver upgrade. Earlier preview packages that already selected Apple DoT retain it when loaded.

## Build and configure

Run the CLI on the project's trusted Proxmox host. Windows exports need NSIS 3.x (`makensis` on PATH, available in Debian's `nsis` package). Household Windows devices use their built-in Windows PowerShell 5.1. To build Nomina from source, install the project dependencies and run `npm run build:native:local` with Bun. The native executable embeds the installer sources. From a checkout, `node bin/nomina.js` also works.

To export an Apple trust profile using the device’s existing DNS:

```sh
nomina ca profile configure --name household --target apple
nomina ca profile export --name household --output ./household-trust
```

To add encrypted DNS later, edit that same package with `--apple-dns encrypted` and provide the DNS settings. The example below also adds a Windows installer with ordinary DNS. Substitute the actual home Wi-Fi, private zone, and resolver. Each repeated flag contributes one value.

```sh
nomina ca profile configure --name household --display-name 'Home services' \
  --description 'Private services on home Wi-Fi' --target apple --target windows \
  --apple-dns encrypted \
  --ssid 'Home Wi-Fi' --mode private-domain --suffix home.example \
  --resolver dns.home.example --address 192.168.1.53 --address fd12::53
nomina ca profile list
nomina ca profile inspect --name household
nomina ca profile resolver-check --name household
nomina ca profile export --name household --output ./household-private
nomina ca profile configure --name household --mode whole-system
nomina ca profile export --name household --output ./household-all
```

Use an existing parent and a fresh directory for each export. The exporter checks prerequisites before publishing the complete directory. The manifest records the package identity, content revision, platform, policy, root fingerprint and file hashes. Back up both `nomina.yaml` and `.nomina/state.json` to retain replacement identity. Give independent packages different names. Install one alternative of each logical package. Use distinct home networks or nonoverlapping policies across packages.

Use `--apple-dns existing` and export a replacement profile to switch an Apple device back to its existing DNS. A combined package can use existing DNS on Apple and a home Wi-Fi policy on Windows. The Windows DNS selection remains independent of the Apple choice.

Configure edits the named definition. Omitted flags retain saved fields. Repeat `--target`, `--ssid`, `--address` or `--shortcut` to replace that list. New packages start with zero shortcuts. Each shortcut accepts a complete HTTP(S) URL, an optional local PNG up to 256 × 256 and an opening behavior. Use public-facing URLs free of tokens or passwords. Icons resolve relative to the project. Use `--clear-shortcuts` to remove all selections.

```sh
nomina ca profile configure --name household \
  --shortcut '{"name":"Photos","url":"https://photos.home.example/albums","icon":"photos.png","opening":"ios-fullscreen"}' \
  --shortcut '{"name":"Music","url":"https://music.home.example/","opening":"browser"}'
```

## Prepare the resolver

Windows uses ordinary system DNS over port 53. Apple packages use DNS over TLS on TCP 853 when encrypted DNS is selected. Supply the resolver IPs and, for DoT, a TLS hostname covered by the listener certificate. Resolver check and export query the relevant endpoints for a zone SOA, including the private suffix in private mode and a public zone in whole-system mode. The private suffix and project domain must answer SOA queries. The Proxmox host must be able to reach each address. Take LAN routing, IPv6, and firewall access into account when choosing them.

Reusing a working DoT endpoint avoids a configuration change or restart on your existing resolver. For the managed Technitium setup path:

1. Inspect the standalone DNS server's **Settings**. Use Technitium 15.4.x or 15.6.x, private-network-only recursion, and explicit LAN listener addresses. Include any existing required private or loopback listeners. Nomina's setup review rejects wildcard binds. For a project that needs its existing binds left in place, use the Apple existing-DNS option or an independently configured DoT endpoint. Keep port 853 available on the endpoint.
2. Supply a renewable server leaf certificate with the reviewed DNS name, its private key and chain in Technitium's PKCS#12 certificate setting on the DNS host. Protect the file and password there. The setup command reuses this certificate and the configured port. Arrange renewal and confirm that Technitium reloads the new leaf before expiration. Nomina does not generate a server key in the client bundle.
3. Run `nomina ca profile resolver-setup --name household`. Review the identified LXC, existing certificate path, LAN binds, endpoint, port and CA fingerprint. The command prints a digest when a change is needed. Repeat it with `--approve DIGEST` from that review to enable DoT. A changed review requires fresh approval. The menu offers the same review. Technitium restarts its DNS listeners when it applies or reverts this toggle, so plan for a brief interruption if you enable it on a resolver already serving clients. On verification failure the command rechecks the settings before reverting its toggle. Run the review again following an interruption.
4. Run `resolver-check` again after renewal or changes. Resolve any TLS-name, certificate-chain, port, recursion, or SOA failure before exporting. DoT authenticates the hostname over each bootstrap IP, using public built-in roots plus the retrieved household root. A new CA fingerprint requires explicit export approval via `--accept-root-change` and manual redistribution. A renewed leaf under the same root can use the existing package.

The implementation reads the root through managed LXC host control. It accepts the configured step-ca root, or the standard Caddy system-service local root after the authority has initialized it. Custom Caddy storage requires independent integration. Native Technitium setup changes only its DoT enable flag. Client removal leaves that shared server listener available. [Technitium 15.4 API](https://github.com/TechnitiumSoftware/DnsServer/blob/v15.4.0/APIDOCS.md) · [Technitium 15.6.2 API](https://github.com/TechnitiumSoftware/DnsServer/blob/v15.6.2/APIDOCS.md) · [Listener restart implementation](https://github.com/TechnitiumSoftware/DnsServer/blob/v15.6.2/DnsServerCore/WebServiceSettingsApi.cs#L1133) · [Caddy service root](https://caddyserver.com/docs/running)

### Include a Technitium upgrade

When an existing resolver is ready for encrypted DNS, choose **Include an in-place Technitium upgrade in the review** during device setup. The CLI offers the same review and approval.

```sh
nomina ca profile resolver-setup --name household --upgrade-technitium
nomina ca profile resolver-setup --name household --upgrade-technitium --approve DIGEST
```

The review checks the current resolver settings and ordinary DNS before running the provider updater. Use the displayed digest to authorize the update and DNS setup together. Nomina uses its existing in-place service upgrade path and requests a Proxmox snapshot where supported. It checks ordinary DNS and the listener settings after upgrading and verifies DoT before export. An unsupported installed version or changed listener settings stop DoT setup. The binary upgrade and first package definition reuse the existing Nomina project files and managed services.

Prepare the restricted listener addresses and server certificate before opting in. The workflow checks those prerequisites before the Technitium upgrade and preserves the configured binds, CA and certificate settings. On an existing resolver, plan for DNS downtime during both the vendor update and the listener restart. The vendor updater installs the release it currently distributes. Keep the service backup available for recovery if the upgrade itself fails. [Technitium Linux updater](https://technitium.com/dns/) · [Technitium backup guidance](https://blog.technitium.com/2026/04/technitium-dns-server-v15-released.html)

## Install, replace and remove

Send the selected artifact, fingerprint and `INSTALL.txt` through a trusted channel. The root can authenticate any HTTPS site. SSIDs and service names appear in the bundle. An SSID match does not authenticate the network.

- **macOS 26+** — Open `mac.mobileconfig` and approve it in System Settings → General → Device Management. Check the root's TLS trust in Keychain Access. Install the separate user-scoped `mac-shortcuts.mobileconfig` when present. Reinstall the same logical package to change DNS mode. Remove the old shortcuts profile if the new package has zero clips. Remove both profiles in Device Management to uninstall. [Apple DNS schema](https://github.com/apple/device-management/blob/release/mdm/profiles/com.apple.dnsSettings.managed.yaml) · [Web Clip schema](https://github.com/apple/device-management/blob/release/mdm/profiles/com.apple.webClip.managed.yaml)
- **iOS/iPadOS 26+** — Open `mobile.mobileconfig`, review and install it in Settings → General → VPN & Device Management. Enable the reviewed root under General → About → Certificate Trust Settings. Remove the profile from VPN & Device Management. Full-screen opening is a mobile Web Clip option. [Apple manual trust instructions](https://support.apple.com/en-us/102390)
- **Windows 11 x64** — Double-click `NominaDeviceSetup.exe`, approve elevation, and review the fingerprint and settings. Use Installed apps → Nomina device setup → Modify for status and repair, or Uninstall for removal. Rerun a new installer of the same package for replacement. The package-specific Program Files directory contains `status.txt`. Cleanup records preserved edited items in `preserved.txt`. Organizational signing or application policies may block unsigned installers or helpers. [Installed apps registration](https://learn.microsoft.com/en-us/windows/win32/msi/uninstall-registry-key)

When encrypted DNS is selected, Apple matches primary Wi-Fi with ordered connect/disconnect rules and sets `AllowFailover` to false. Windows checks connected WLAN SSIDs. Its helper installs one native NRPT rule with either the exact private suffix and its descendants, or the catch-all namespace. This covers ordinary Windows DNS Client queries across interfaces while preserving adapter DNS and DHCP. A matching home SSID on a second connected Wi-Fi interface also activates the Windows rule. The Windows policy leaves multicast/single-label resolution and existing system fallback policy in effect. A resolver outage at home can stop normal browsing. Windows reconciles at startup, sign-in, network transitions and resume, with a one-minute fallback schedule. Real transition latency remains unmeasured. [Microsoft NRPT namespace semantics](https://learn.microsoft.com/en-us/previous-versions/windows/desktop/dnsclientpsprov/dnsclientnrptrule) · [DNS fallback](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-gpnrpt/b5760f13-0a23-4e37-9253-ad12af60e8a6) · [SSID access](https://learn.microsoft.com/en-us/windows/win32/nativewifi/wi-fi-access-location-changes)

VPN DNS, browser secure DNS, Group Policy and application resolvers may own some queries. Overlapping Windows policies are reported. Both packages leave Tailscale settings alone. The system state can distinguish a pre-existing root and Nomina's shared claims. Windows stores identical certificates under one thumbprint, so a later independent re-import of identical bytes has no separate ownership marker.

## Verification

Run `npm test`, `npm run typecheck` and `npm run build:native:local`. For focused coverage run `node --test test/device-setup.test.js test/technitium-adapter.test.js test/ca-strategies.test.js test/tui.test.js test/home-dns-client.test.js`. The device tests use OpenSSL, Python 3, NSIS and, optionally, PowerShell (`NOMINA_DEVICE_TEST_PWSH` selects its executable). They generate disposable test certificates. The TLS fixture listens only on loopback. The PowerShell test injects network, rule and root-store operations. None installs a profile or changes system trust or DNS.

**Pending real-device acceptance.** Use an authorized isolated network for these checks. Record OS build, provider version, source package fingerprint and observed timing for each run.

1. Capture baseline DNS, trust, VPN state, tasks, shortcuts and effective NRPT. On Mac inspect `scutil --dns`. On Windows inspect `Get-DnsClientServerAddress`, `Get-DnsClientNrptRule` and `Get-DnsClientNrptPolicy -Effective`. Include IPv4, IPv6, concurrent interfaces, a pre-existing root and an unrelated DNS rule.
2. Install private mode. Verify private apex, mixed case, trailing dot, subdomains and a similar name outside the suffix. Use system lookups, resolver query logs and private HTTPS in a browser. Verify unrelated names use ordinary DNS. Test the Mac and iPhone/iPad individually.
3. Leave and rejoin Wi-Fi, test Ethernet-only and cellular where available, sleep/resume, sign out/in and restart. Measure policy transitions. Test an isolated resolver outage while still connected to home Wi-Fi. Verify package behavior separately from browser secure DNS and VPN DNS.
4. Replace with whole-system mode. Verify public and private queries in the home resolver log and ordinary DNS off-network. Check only one policy remains. Reinstall with zero and multiple shortcuts, inspect icons and opening behavior, and exercise Windows Modify.
5. Uninstall. Compare baseline adapter DNS, effective rules, root store, task registrations, trust and shortcuts. Repeat with two packages sharing a root, a pre-existing root, an externally edited rule or shortcut, and an interrupted installation. Check preservation reports and confirm unrelated configuration survives.

### Recorded offline results, November 17, 2026

| Check | Result |
| --- | --- |
| Build host | macOS 27.2, build 26B123, arm64 |
| Toolchain | Node 26.7.0, TypeScript 5.9.3, Bun 1.3.9, NSIS 3.13, OpenSSL 3.6.4, Python 3.14.7 |
| Regression suite | 729 passed, 3 skipped, 0 failed. The skips cover two Linux-only checks and the separate legacy Windows Tailscale helper. |
| Additional legacy-helper run | Enabling PowerShell 7.4.22 globally on macOS makes the legacy helper fixture reach WindowsIdentity.GetCurrent, which requires Windows. The new helper's PowerShell fixture passed on the same host. |
| Builds | Typecheck, local arm64 Mac CLI, Linux x64 and arm64 CLIs, NSIS installers for both modes. A compiled Bun exporter generated unsigned bundles from an ephemeral fixture root. Repeated installer builds from identical inputs compared byte-for-byte. |
| Apple artifacts | macOS plutil and Python plistlib parsed generated profiles. Tests compared embedded root DER, profile identity, DNS policy, matching order, Web Clips and scope. |
| Resolver | Local TLS fixture verified SNI, chain rejection and DNS SOA semantics. Technitium 15.6.2 API and settings fixtures covered review, reuse, scoped writes and rollback. Deployed provider version unknown. |
| Windows lifecycle | Injected OS functions exercised home/away DNS, IPv4/IPv6 resolver lists, collisions and external edits, denied writes and restart recovery, replacement, shared/pre-existing roots and shortcut cleanup. |
| Device and infrastructure acceptance | Pending by operator instruction. No profiles, machine trust, DNS, Tailscale settings or deployed services were changed. Windows 11 build, iOS/iPadOS versions, effective DNS routing, scheduler timing, installation UI, real HTTPS and uninstallation remain unverified on devices. |
