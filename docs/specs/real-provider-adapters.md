# Real Proxmox and Provider Adapters

## Problem Statement

NominaConnect's CLI, managed inventory, provider-plugin contracts, tracking,
and lifecycle workflows are implemented and tested with fake adapters. The
installed CLI, however, only wires filesystem, runtime, and prompt adapters.
It cannot create an LXC, configure Technitium, publish a Caddy or Traefik
route, inspect a CA, or join a VPN in a real Proxmox homelab.

An operator can follow the menus and receive a provider-adapter-unavailable
error rather than a working service. NominaConnect must replace that gap with
real, safe adapter implementations while preserving unmanaged configuration and
supporting provider precedence for inspectable user changes.

## Solution

Deliver production adapters for local Proxmox-shell execution and the initial
platform catalog: Technitium, Caddy, Traefik, step-ca, Caddy Internal CA,
Tailscale, and NetBird. The installed CLI must compose these adapters by
default, so the existing commands perform real work on a Proxmox host instead
of relying on injected fakes.

All provider operations become asynchronous and run through a common command
and HTTP boundary with timeouts, redacted diagnostics, and structured failures.
The existing provider-plugin operations stay the high-level contract; each real
adapter implements setup, inspection, adoption, health checks, upgrades, and
any provider-specific exposure operation.

NominaConnect stores no internal marker in provider configuration. A provider
reference in root-owned local state contains a provider-native locator and a
last-known structural fingerprint. On inspection, an adapter resolves its
stored locator first, then may use a constrained, unambiguous semantic match.
If a direct edit prevents reliable matching, NominaConnect preserves provider
configuration and records a verification warning instead of guessing.

## User Stories

1. As a Proxmox operator, I want the installed `nomina` binary to wire real adapters automatically, so that commands work without a custom test harness.
2. As a Proxmox operator, I want `nomina service add` to create a real dedicated unprivileged Debian LXC, so that platform services become usable machines.
3. As a Proxmox operator, I want the requested service IP checked against local Proxmox state before creation, so that a known collision blocks provisioning.
4. As a Proxmox operator, I want every LXC operation performed through local Proxmox-shell execution, so that NominaConnect follows the intended root-shell operating model.
5. As a Proxmox operator, I want provider installation commands to be time-bounded and report useful redacted errors, so that a failed setup can be diagnosed safely.
6. As a Proxmox operator, I want to enter provider credentials through a secure local secret mechanism, so that tokens never appear in `nomina.yaml`, command arguments, or routine output.
7. As a Proxmox operator, I want Technitium zones and A records created through its supported API, so that managed DNS records are usable and inspectable.
8. As a Proxmox operator, I want direct edits to a managed Technitium record adopted when it remains uniquely identifiable, so that the managed inventory reflects observable provider state.
9. As a Proxmox operator, I want Caddy installed in a managed LXC and configured through its local Admin API, so that a managed HTTPS route is real rather than simulated.
10. As a Proxmox operator, I want Caddy routes to remain HTTPS with or without a configured CA, so that encryption is never downgraded to HTTP.
11. As a Proxmox operator, I want Caddy route edits adopted only when NominaConnect can identify the same route safely, so that unrelated routes are never changed or claimed.
12. As a Proxmox operator, I want Traefik installed with a watched dynamic-file directory, so that real route configuration is durable and observable.
13. As a Proxmox operator, I want Traefik-managed dynamic fragments inspected and adopted after direct file edits, so that its provider state can remain connected to the managed inventory.
14. As a Proxmox operator, I want Traefik dashboard/API access treated as observability rather than a configuration-write API, so that NominaConnect uses a supported configuration path.
15. As a Proxmox operator, I want step-ca provisioned and inspected as a real CA, so that compatible Caddy and Traefik exposures can become trusted.
16. As a Proxmox operator, I want Caddy Internal CA handled through the Caddy adapter, so that NominaConnect does not pretend it is an independent service with an unrelated control plane.
17. As a Proxmox operator, I want Tailscale and NetBird optional services to perform real enrollment using securely supplied credentials, so that a selected VPN is operational.
18. As a Proxmox operator, I want adapters to validate LXC prerequisites such as a TUN device before VPN setup, so that unsupported container settings fail with actionable remediation.
19. As a Proxmox operator, I want each real adapter to inspect process state, endpoint reachability, and applicable integration health, so that a successful install is not mistaken for a working service.
20. As a Proxmox operator, I want background tracking to use the same real adapters as foreground commands, so that observed provider changes and warnings are meaningful.
21. As a Proxmox operator, I want uninspectable, offline, or ambiguously matched provider state to produce a verification warning, so that NominaConnect does not overwrite or misrepresent configuration.
22. As a Proxmox operator, I want provider upgrades to be executed only by the explicit lifecycle command, so that background tracking never changes live software.
23. As a maintainer, I want every adapter to pass one common conformance suite, so that new providers cannot appear in the catalog with only partial real behavior.
24. As a maintainer, I want a disposable live Proxmox acceptance path for real adapters, so that command plans and mocks cannot be mistaken for working infrastructure.

## Implementation Decisions

- Convert the Proxmox and provider adapter boundary to asynchronous operations. Existing fake adapters remain valid by returning immediate values; all production adapter work uses awaited results.
- The installed CLI composes a production adapter set. Dependency injection remains available for tests and alternate environments, but no normal operator command depends on injected adapters.
- A command runner executes fixed binaries with argument arrays rather than shell interpolation. It applies timeouts, captures structured stdout/stderr, and redacts values sourced from the connection-secret mechanism.
- The Proxmox adapter uses local Proxmox-shell commands to inspect existing LXC addresses, validate templates/storage, create and inspect LXCs, execute commands with `pct exec`, stop/remove LXCs, and make supported snapshots. It never uses remote Proxmox API authentication for the primary workflow.
- Provisioning verifies the requested Debian template, storage, bridge, IP, and unprivileged-LXC requirements before mutation. Missing prerequisites result in a clear remediation error; destructive cleanup is never automatic.
- Connection secrets are resolved from a root-owned secure local secret mechanism using the existing configuration references. Secrets must not be persisted in `nomina.yaml`, provider fragments, command arguments, change notices, or error output.
- Provider references remain local NominaConnect state. They contain only a provider-native locator plus a last-known fingerprint; a NominaConnect ID is never written into Caddy, Technitium, Traefik, step-ca, Tailscale, NetBird, or Proxmox configuration.
- The Technitium adapter uses the authenticated Technitium API for authoritative-zone and managed-record operations. A managed DNS locator consists of the authoritative zone, record name, and type; it is refreshed after an adopted value change.
- The Caddy adapter installs Caddy in its service LXC and uses the local Admin API for live configuration and inspection. Its locator records the provider-native configuration path and route fingerprint. It only mutates the resolved managed route, never loads or replaces the whole Caddy configuration.
- The Traefik adapter installs Traefik with a watched directory of dynamic configuration fragments. NominaConnect writes and reads only the fragment identified by its local provider reference. Traefik's dashboard/API is used for observation and health, not as a configuration-write mechanism.
- A Caddy Internal CA is implemented as a Caddy adapter mode. It does not receive a separate LXC or independent provider control plane.
- The step-ca adapter manages a dedicated step-ca LXC and its compatibility artifacts for Caddy/Traefik. Trust distribution and certificate issuance are health-checked as part of an exposure, not inferred from a running process alone.
- Caddy and Traefik always configure HTTPS routes. No configured trust-providing CA yields an untrusted HTTPS result; it never yields an HTTP fallback.
- The Tailscale and NetBird adapters create/operate their selected dedicated service LXCs, resolve enrollment credentials from the secret mechanism, validate container networking prerequisites, and inspect the provider CLI/API status needed for health and adoption.
- Inspection is read-only. Adoption writes only NominaConnect configuration/state through the existing atomic queue after a unique managed match and affected health check. Missing, multiple, or conflicting matches are verification warnings.
- The adapter conformance suite is the primary implementation seam. It invokes public NominaConnect commands against a disposable adapter environment and asserts external outcomes: LXC lifecycle, provider-native resource changes, preserved unmanaged resources, inspection/adoption results, and health states.
- Retain the existing fake-adapter tests as fast unit coverage. Add a separately runnable, disposable live-Proxmox acceptance suite for the real command/HTTP adapters and initial provider paths.

## Testing Decisions

- A good test observes real operator outcomes rather than command-helper internals: an LXC exists with the requested properties, a DNS answer exists, a proxy route reaches its backend, a certificate outcome is reported, a VPN reaches the expected status, or a safe warning is recorded.
- The adapter conformance suite becomes the common highest seam. It exercises each catalog provider through the public command workflow and verifies setup, inspect, adopt, health-check, and explicit upgrade behavior as applicable.
- The Proxmox adapter is tested against a command-recording fixture for fast behavior coverage and against a disposable Proxmox host for acceptance coverage. Tests verify argument-based command execution and no accidental broad deletion.
- HTTP provider adapters use local controlled API fixtures for contract tests, including authentication failures, malformed responses, timeouts, and ambiguous locators.
- Technitium acceptance tests verify an authoritative local zone, a managed A-record publish/update/remove cycle, direct provider-side value adoption, and preservation of an unrelated record.
- Caddy acceptance tests verify Admin-API route insertion/update/removal, HTTPS endpoint health, untrusted HTTPS without a CA, safe handling of a route that cannot be uniquely matched, and preservation of unrelated Caddy routes.
- Traefik acceptance tests verify a watched dynamic fragment produces a live router/service, direct fragment edits are inspected, and unrelated dynamic fragments remain untouched.
- CA acceptance tests verify Caddy Internal CA and step-ca paths separately, including trusted-versus-untrusted exposure outcomes and CA failure warnings.
- VPN acceptance tests verify credential resolution is redacted, prerequisite failures are actionable, and the selected client reports an operational or clearly failed enrollment state.
- Tracking tests run against real adapter interfaces and retain the current assertions for bounded retry, atomic writes, provider precedence, and health-gated notices.
- Prior art is the current fake-adapter contract tests and CLI-level provisioning, exposure, tracking, and lifecycle tests. They must be extended, not replaced.

## Out of Scope

- New application-service plugins or a generic arbitrary-command/container-image backend.
- Remote Proxmox API-first operation, Proxmox-cluster orchestration, Docker-in-VM deployment, and non-Proxmox backends.
- Automatic IP allocation, automatic upgrades, automatic destruction, or mutation of unmanaged provider resources.
- Writing NominaConnect IDs/markers into provider configuration.
- Treating Traefik's dashboard/API as a configuration-write API.
- New DNS, reverse-proxy, CA, or VPN providers beyond Technitium, Caddy, Traefik, step-ca, Caddy Internal CA, Tailscale, and NetBird.
- Public ACME certificates, public DNS automation, and a web dashboard.

## Further Notes

The planned test seam is one adapter conformance suite, supplemented by live
acceptance runs on disposable infrastructure. It keeps the public CLI contract
stable while proving that an installed NominaConnect can perform real work.

Current provider documentation supports the chosen control surfaces: the Caddy
Admin API supports targeted configuration operations; Traefik supports watched
dynamic configuration through its file provider; and Technitium documents
authenticated API endpoints for record management. The implementation should
pin these provider-protocol assumptions to the provider versions it supports.
