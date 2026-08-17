# NominaConnect Proxmox CLI MVP

## Problem Statement

Homelab operators running Proxmox need to set up and connect foundational
services—DNS, reverse proxy, certificate authority, and VPN—without manually
transcribing the same hostname, IP address, and routing information between
tools. Existing provider UIs remain useful, but a change in Caddy, Traefik,
Technitium, a CA, a VPN provider, or a managed service can leave a hand-built
homelab hard to understand and easy to misconfigure.

NominaConnect must provide a transparent root-shell CLI that creates dedicated
native Proxmox LXCs, manages only the user's declared managed inventory, and
keeps that inventory connected to observable provider and service
configuration. It must preserve unmanaged configuration, expose meaningful
software choices, and remain useful when users work directly in provider UIs.

## Solution

Build NominaConnect as a CLI run as root on a Proxmox host. Running `nomina`
with no arguments opens an interactive terminal UI; subcommands use the same
guided prompts when flags are omitted. `nomina init`
creates a visible, human-editable project configuration and guides the operator
through platform bootstrap in dependency order. `nomina service add` creates a
dedicated unprivileged Debian LXC for a named service plugin, using the
operator's requested IP and explicit or default Proxmox bridge, storage,
resource sizing, and hostname.

Every managed item has a private NominaConnect ID and provider references held
only in NominaConnect state. Provider and full service configuration are
inspected by work-to-completion background tracking jobs. Observable provider
state takes precedence: detected changes are adopted through one atomic
configuration write queue, then verified with plugin health checks. The CLI
shows pending notices at the next invocation and exposes full detail through
`nomina changes`.

The MVP offers a complete initial platform catalog: Technitium; Caddy or
Traefik; step-ca or Caddy Internal CA where compatible; and optional Tailscale
or NetBird. Caddy and Traefik publish managed web exposures through HTTPS at
all times. Without a trust-providing CA, an untrusted HTTPS certificate is
expected rather than an HTTP fallback.

## User Stories

1. As a Proxmox homelab operator, I want to run NominaConnect as root in the Proxmox shell, so that it can provision native LXCs without remote API credentials.
2. As an operator, I want `nomina init` to create a visible project configuration, so that my managed inventory is reviewable and portable.
3. As an operator, I want initialization to ask for my Proxmox node, default bridge, default storage target, and base local domain, so that later service setup has clear defaults.
4. As an operator, I want to choose named DNS, reverse-proxy, CA, and VPN software, so that NominaConnect does not hide consequential architecture choices.
5. As an operator, I want Technitium as an initial DNS choice, so that a real DNS provider can be configured and inspected.
6. As an operator, I want to choose Caddy or Traefik, so that reverse-proxy choice matches my homelab preference.
7. As an operator, I want CA configuration to be optional and separate from proxy selection, so that I can choose trust behavior deliberately.
8. As an operator, I want to choose step-ca or Caddy Internal CA when compatible, so that certificate trust is explicit.
9. As an operator, I want optional Tailscale or NetBird setup, so that VPN is available without being mandatory.
10. As an operator, I want to add a supported named service from a concise catalog, so that I understand what NominaConnect will install.
11. As an operator, I want every managed service placed in one dedicated LXC, so that service ownership, networking, and recovery boundaries are clear.
12. As an operator, I want the CLI to ask for my desired static service IP, so that NominaConnect never allocates addresses behind my back.
13. As an operator, I want an IP preflight, so that a known collision blocks provisioning and an unknown wider-network result is visibly warned about.
14. As an operator, I want plugin-provided CPU, memory, disk, and related recommendations with overrides, so that I can make infrastructure trade-offs consciously.
15. As an operator, I want a predictable but overridable LXC hostname, so that services are recognizable in Proxmox.
16. As an operator, I want NominaConnect to use unprivileged Debian LXCs by default, so that service isolation is the secure default.
17. As an operator, I want NominaConnect to control managed LXCs through `pct exec`, so that I do not need separate SSH administration for every LXC.
18. As an operator, I want to choose a full hostname for a web service, with a suggestion based on my base local domain, so that local-only names remain first-class.
19. As an operator, I want NominaConnect to create and connect the managed DNS record, proxy route, and TLS behavior for a published service, so that I do not duplicate integration work in separate UIs.
20. As an operator, I want Caddy and Traefik exposures to use HTTPS even without a configured CA, so that encryption is preserved while browser trust remains an explicit CA decision.
21. As an operator, I want direct edits in a supported provider UI to be inspected and adopted, so that NominaConnect reflects the homelab I actually operate.
22. As an operator, I want NominaConnect to preserve unmanaged provider configuration, so that it never silently adopts or overwrites unrelated DNS, proxy, CA, or VPN resources.
23. As an operator, I want NominaConnect IDs and state to remain private to NominaConnect, so that provider configuration stays native and independently usable.
24. As an operator, I want background tracking to begin alongside CLI work and continue after the command exits until its pass completes, so that unrelated commands remain responsive.
25. As an operator, I want background tracking to inspect all managed service configuration, not just infrastructure integration fields, so that supported services remain accurately represented.
26. As an operator, I want provider changes to win when they are observable, so that direct provider UI edits become the latest managed configuration.
27. As an operator, I want adopted changes to be health-checked, so that NominaConnect distinguishes observed configuration from a working service.
28. As an operator, I want completed background work summarized on my next command and available in `nomina changes`, so that a CLI-only product does not hide activity.
29. As an operator, I want unavailable providers retried with bounded backoff and reported as verification warnings, so that transient failures do not break unrelated work.
30. As an operator, I want foreground and background configuration writes serialized and atomic, so that concurrent work cannot corrupt my project configuration.
31. As an operator, I want to remove a service's managed integrations without immediately destroying its LXC or data, so that service removal is recoverable.
32. As an operator, I want destruction to be a separate, explicitly confirmed action, so that persistent data is never treated as disposable infrastructure.
33. As an operator, I want upgrades to occur only through an explicit upgrade command, so that background tracking never changes running software.
34. As an operator, I want an optional, confirmed pre-upgrade snapshot when my Proxmox storage supports it, so that I can choose a rollback point.
35. As an operator, I want clear verification warnings whenever NominaConnect cannot inspect a managed resource, so that it never implies the homelab is healthy without evidence.

## Implementation Decisions

- The product is CLI-only and runs as root on a Proxmox host. Its primary Proxmox control surface is local management commands and `pct exec`, not a remote Proxmox API client.
- The default operator experience is an interactive terminal UI (`nomina` with no arguments). Command flags pre-fill the same prompt functions for scripts and tests; see `docs/tui.md`.
- NominaConnect discovers `nomina.yaml` from the working directory or a parent folder. Operators are not asked for a project path.
- A visible project configuration declares the managed inventory. Secure connection secrets, volatile provider references, tracking records, and change history remain outside that file in root-owned local state.
- The configuration stores permanent NominaConnect IDs for managed items. Provider-native references are stored separately; NominaConnect does not inject markers into provider configuration.
- Native Proxmox LXC is the first implemented deployment option. It creates one dedicated Debian stable, unprivileged LXC per managed service; the configuration remains extensible for other user-selected deployment options.
- The new-service flow asks for static IP, selects defaults for bridge and storage with per-service overrides, shows overrideable resource recommendations, and derives an overrideable hostname from the service name.
- The first catalog includes Technitium, Caddy, Traefik, step-ca, Caddy Internal CA, Tailscale, and NetBird. Every selectable plugin must implement setup, inspection, adoption, and health-check contracts.
- Bootstrap ordering is DNS, reverse proxy, optional CA, and optional VPN. Applications are a later catalog phase, but the platform model must already represent managed integrations and published exposures.
- Caddy and Traefik exposures always use HTTPS. Absence of a trust-providing CA means untrusted HTTPS, not HTTP. The certificate-authority selection remains separate and compatibility-aware.
- A service plugin owns deployment behavior by service and deployment option, as well as inspection of service configuration and platform integrations.
- A tracking job starts asynchronously with a CLI invocation and runs to completion after the initiating command returns. It inspects managed resources, adopts observable provider/service changes, and performs affected health checks.
- Provider precedence applies whenever an item can be inspected: observed provider configuration is persisted into the managed inventory. Uninspectable items produce verification warnings.
- A single configuration write queue commits foreground and tracking updates atomically. Change history makes adoptions and user modifications reversible and visible.
- `nomina changes` is the detailed activity surface; the next CLI invocation prints a concise change notice.
- Tracking retries unavailable providers with bounded backoff. It never upgrades service software automatically.
- Service removal disconnects managed integrations and retains the stopped LXC/data. Destruction and upgrade are explicit commands; upgrades offer an optional, user-confirmed Proxmox snapshot when available.
- The project intentionally departs from Appendix A's automation-after-manual-validation order at the user's direction. The documented manual reference workflows become acceptance criteria for the automated implementation.

## Testing Decisions

- The primary seam is the root-shell CLI command contract: given a project configuration and fake Proxmox/provider adapters, a command produces an observable provisioning plan, state transition, change notice, or verification warning.
- Tests must assert external behavior: created LXC specifications, requested command plans, persisted managed inventory, preserved unmanaged configuration, change notices, and reported health outcomes. They must not assert private helper calls or internal data-layout details.
- Adapter contract tests validate that each provider plugin can set up, inspect, adopt, and health-check a managed resource while leaving unmanaged resources untouched.
- Configuration tests cover validation, permanent NominaConnect IDs, provider references, atomic write serialization, and recovery after an interrupted write.
- Provisioning tests cover root-shell command construction, requested-IP preflight outcomes, default and override resolution, unprivileged Debian LXC defaults, and `pct exec` lifecycle control.
- Tracking tests cover asynchronous work-to-completion behavior, provider precedence, bounded retry, notifications on a later command, and health-gated verified adoption.
- Lifecycle tests cover explicit upgrades, optional snapshots, removal that retains an LXC, and explicitly confirmed destruction.
- There is no prior automated test suite. The CLI contract and adapter fakes are deliberately the highest initial seam, minimizing dependence on a real Proxmox host or live provider.

## Out of Scope

- A dashboard, web UI, or mobile UI.
- Remote Proxmox API-first operation, Proxmox-cluster orchestration, Docker-in-VM deployment, manual-Linux automation, and non-Proxmox backends.
- Arbitrary shell-command, container-image, or generic application deployment.
- Application catalog plugins beyond the initial platform-service catalog.
- Automatic IP address allocation, automatic service upgrades, and automatic destruction of retained service data.
- Global discovery/adoption or mutation of provider configuration outside the managed inventory.
- Public-CA/ACME flows, additional DNS/proxy/CA/VPN providers, and provider choices without complete setup/inspection/adoption support.
- An always-running NominaConnect daemon; tracking jobs are started by CLI activity and run only until their pass completes.

## Further Notes

The spec uses the domain language in `CONTEXT.md` and follows the recorded ADRs, including later ADRs that supersede earlier SSH and blocking-inspection choices. The proposed highest testing seam is the CLI command contract with adapter fakes; it keeps implementation testable without requiring a live Proxmox host or real provider credentials.

Publication is pending because no issue tracker repository is connected in this workspace. Once connected, publish this document as an issue titled `Build the NominaConnect Proxmox CLI MVP` and apply the `ready-for-agent` label.
