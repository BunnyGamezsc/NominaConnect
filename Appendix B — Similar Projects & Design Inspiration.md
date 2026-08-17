# Appendix B — Similar Projects & Design Inspiration

This project intentionally draws inspiration from several existing tools. None of these individually accomplish the overall vision, but each demonstrates an important design pattern that should be studied.

The goal is **not** to clone any one project.

Instead, combine the strongest ideas from each while maintaining the architecture described in this document.

---

# 1. T3 Stack

[https://create.t3.gg](https://create.t3.gg)

## Inspiration

T3 Stack asks a small number of questions and generates a fully configured project.

Example:

- Next.js
- TypeScript
- Tailwind
- Prisma
- NextAuth
- tRPC

The user answers a few questions and receives a complete project.

## Apply This Philosophy

The homelab platform should feel similar.

Instead of generating a web application, it generates an infrastructure platform.

Example:

Deployment Target

↓

DNS Provider

↓

Reverse Proxy

↓

Certificate Provider

↓

VPN

↓

Ready-to-use homelab

The user should feel like they are "creating a stack."

---

# 2. Proxmox VE Helper Scripts (Community Scripts)

[https://community-scripts.github.io/ProxmoxVE/](https://community-scripts.github.io/ProxmoxVE/)

## Inspiration

One-click installation of services.

Examples:

- Jellyfin
- Immich
- AdGuard
- Grafana
- Home Assistant

These scripts demonstrate excellent automation.

## What To Learn

- Automated installation
- Good defaults
- Repeatability
- Broad service support

## What NOT To Copy

Each service is largely independent.

This project should instead understand relationships between services.

Example:

Installing Immich should not auto configure anything. It should allow the user to just put a service’s IP+port and desired domain in a simple config file, reload, and then everything just works

The platform should coordinate infrastructure automatically.

---

# 3. CasaOS

[https://casaos.io](https://casaos.io)

## Inspiration

Simple application installation.

Users browse applications and click Install.

The platform manages Docker.

## What To Learn

- Clean UI
- Easy installation
- Application catalog
- Good user experience

## What NOT To Copy

CasaOS largely hides infrastructure.

This project intentionally exposes infrastructure choices.

Users should understand:

- DNS
- Reverse Proxy
- VPN
- Certificates

instead of hiding them.

---

# 4. Umbrel

[https://umbrel.com](https://umbrel.com)

## Inspiration

Beautiful appliance-like experience.

Simple installation.

Application marketplace.

## What To Learn

- Polished UX
- Consistency
- Easy upgrades
- Nice presentation

## What NOT To Copy

Umbrel is intentionally opinionated.

This project should remain modular.

Infrastructure providers should be replaceable.

---

# 5. Coolify

[https://coolify.io](https://coolify.io)

## Inspiration

Self-hosted deployment platform.

Handles:

- containers
- networking
- domains
- certificates

## What To Learn

Applications integrate into existing infrastructure.

Infrastructure is managed automatically.

## Difference

Coolify targets cloud deployments.

This project targets private homelabs.

---

# 6. Dockge

[https://dockge.kuma.pet](https://dockge.kuma.pet)

## Inspiration

Docker Compose management.

Simple editing.

Simple deployments.

## Difference

This project should support Docker,

but Docker is only one deployment backend.

---

# 7. Portainer

[https://www.portainer.io](https://www.portainer.io)

## Inspiration

Infrastructure visualization.

Container management.

## Difference

Portainer manages Docker.

This platform manages the entire domain system on the homelab (NOT THE ENTIRE HOMELAB)

Docker is only one component.

---

# 8. Kubernetes

## Inspiration

Not Kubernetes itself.

Instead, its architectural philosophy.

Desired State

↓

Actual State

↓

Reconciliation

The command:

homelab apply

should conceptually work similarly.

The user declares what they want.

The platform computes the necessary changes.

---

# 9. Terraform

## Inspiration

Declarative infrastructure.

One configuration.

Idempotent execution.

Provider plugins.

## Apply This Philosophy

Users describe the desired platform.

The engine computes the required actions.

Infrastructure should not be manually edited after deployment.

---

# 10. Ansible

## Inspiration

Repeatable automation.

Human-readable configuration.

Procedural installation.

## Difference

Ansible generally executes tasks.

This platform should eventually become declarative.

---

# 11. Docker Compose

## Inspiration

Simple service descriptions.

Readable YAML.

Relationships between services.

## Difference

Docker Compose is an output.

It should not become the project's source of truth.

The platform configuration should generate Docker Compose when required.

---

# 12. NixOS

## Inspiration

Entire systems described declaratively.

One configuration.

Rebuild system.

## Difference

This project should borrow the philosophy,

not necessarily the technology.

---

# 13. Home Assistant

## Inspiration

Integrations.

Device discovery.

Plugin ecosystem.

## Apply This Philosophy

Infrastructure providers should behave like integrations.

Example:

DNS

↓

Technitium

↓

Provides DNS API

↓

Applications automatically consume it.

---

# 14. Traefik

## Inspiration

Automatic service discovery.

Dynamic configuration.

Provider model.

## Difference

The project should support Traefik,

not depend on it.

---

# 15. Caddy

## Inspiration

Extremely simple configuration.

Automatic HTTPS.

Minimal setup.

The project should preserve this simplicity whenever Caddy is selected.

---

# 16. Tailscale

## Inspiration

Remote networking should feel effortless.

The user should not think about:

- NAT
- Port Forwarding
- Firewalls

Remote access should "just work."

---

# 17. NetBird

## Inspiration

Self-hostable Zero Trust networking.

Good API.

Optional advanced integrations.

Example:

Traefik

↓

NetBird Reverse Proxy

These integrations should be optional enhancements.

---

# Overall Design Philosophy

The ideal user experience should feel like:

T3 Stack

-

Terraform

-

Proxmox VE Helper Scripts

-

CasaOS

-

Kubernetes

while remaining focused on homelab infrastructure.

More specifically:

- **T3 Stack** provides the guided "choose your stack" experience.
- **Terraform** provides the declarative, provider-based architecture and desired-state model.
- **Kubernetes** provides the reconciliation mindset (`homelab apply` converges the system toward the desired state).
- **Proxmox VE Helper Scripts** demonstrate reliable automation for installing individual services.
- **CasaOS/Umbrel** inspire a polished, approachable UX and application catalog.
- **Docker Compose** is treated as one possible deployment artifact, not the primary source of truth.
- **NixOS** inspires the philosophy that an entire system can be described from a single configuration.
- **Home Assistant** demonstrates how a rich ecosystem of integrations/plugins can grow over time.

The resulting platform should not feel like "another Docker manager."

Instead, it should feel like a **homelab (DOMAINS) infrastructure operating platform**—one that understands the relationships between infrastructure components and applications, provides a guided but transparent setup experience, and uses a single declarative configuration to drive deployments across multiple environments (Proxmox, Docker, manual Linux, and future backends).
