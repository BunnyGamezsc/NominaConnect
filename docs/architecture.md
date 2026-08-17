# Architecture

## Product boundary

NominaConnect is a homelab infrastructure operating platform. It understands
the relationship between infrastructure components and applications, then
converges supported environments toward a declared system state.

It is not a generic container manager. Docker Compose may be generated as a
deployment artifact, but it is not the source of truth.

## Ubiquitous language

| Term | Meaning |
| --- | --- |
| System definition | The one user-maintained declaration of a homelab. |
| Platform service | A foundational service: DNS, reverse proxy, certificate authority, or VPN. |
| Application | A workload that consumes platform services. |
| Environment | Where a workload runs, such as Proxmox LXC, Proxmox VM with Docker, Linux with Docker Compose, or manual Linux. |
| Service plugin | A named software integration that owns its installation behavior per environment. |
| Artifact | A generated output such as Compose, Caddy configuration, DNS records, or certificates. |
| Reconciliation | Comparing declared intent to observed state and applying the minimum supported changes. |

## Boundaries and ownership

```text
system definition
      |
      +-- platform selection: DNS / proxy / CA / VPN
      +-- environment selection
      +-- application declarations
      |
      v
reconciler ----> service plugins ----> backend-specific artifacts/actions
                    |                         |
                    |                         +-- manual Linux
                    |                         +-- Docker Compose
                    |                         +-- Proxmox LXC
                    |                         +-- Proxmox VM
                    v
              integration contracts
              (DNS, proxy, TLS, VPN)
```

The platform owns DNS records, reverse-proxy routes, and certificate issuance
for applications. Applications declare their identity and requirements; they
do not require users to hand-edit platform configuration.

## Source-of-truth rule

The system definition is primary. The following are derived and must be safe to
regenerate:

- Docker Compose files
- proxy configuration
- DNS records
- certificate requests or issued certificates
- LXC/VM deployment configuration

## Plugin shape

A future service plugin is organized by the software it represents, not by a
deployment engine. This keeps the service's deployment knowledge together and
makes manual installation a first-class backend.

```text
services/
  caddy/
    manual/
    docker/
    proxmox-lxc/
    proxmox-vm/
```

## First vertical slice

The initial reference slice is deliberately narrow:

1. Choose a DNS provider, reverse proxy, and certificate strategy explicitly.
2. Declare a local-only domain and one application.
3. Install and verify the entire route manually.
4. Document commands and observations.
5. Identify the exact artifacts an eventual reconciler would generate.

No deployment code belongs in the project until that slice is repeatable.

## First implemented backend

The first automated backend will be Proxmox native LXC. It creates one dedicated
service LXC per managed service, providing a clear ownership boundary and stable
Proxmox identity. Deployment remains a user-selected option in the system
definition so future backends, including Docker in a Proxmox VM, can be added
without changing the service model.

`nomina init` performs a guided platform bootstrap in dependency order: DNS,
reverse proxy, then optional certificate authority and VPN. At each layer, it
asks the user to select named software rather than hiding the choice behind
generic capabilities. Applications are added after their required platform
services exist.

For Caddy, published applications always use HTTPS. If no trust-providing CA is
configured, Caddy serves TLS with an untrusted certificate; applications still
work, but clients show the expected trust warning. Configuring a CA makes the
HTTPS certificate trusted. Skipping CA setup must not block application setup.

During new-service setup, the user supplies the desired static IP address for
each dedicated service LXC. NominaConnect records and uses that address; it does
not automatically allocate addresses. An IP preflight blocks known collisions
and warns when wider-network availability cannot be verified.

## Operator interface

NominaConnect is CLI-only (no web dashboard). The default operator experience is
an interactive terminal UI: run `nomina` with no arguments, choose an action,
and answer guided prompts. Subcommands such as `nomina init` or
`nomina service add technitium` use the same prompts when flags are omitted.

NominaConnect discovers `nomina.yaml` from the working directory or a parent
folder. Operators are not asked for a project path. See `docs/tui.md` for the
full TUI design pattern, prompt adapter contract, and extension guidelines.

Provider and service configuration changes are inspected and adopted
asynchronously while CLI commands run, so unrelated work is not delayed by a
full managed-inventory scan.
