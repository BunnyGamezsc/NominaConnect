# Appendix A — Explicit Design Decisions & Non-Goals

This section records architectural decisions made during planning that should **not** be "improved" or changed simply because another design is more common. These decisions are intentional.

---

# 1. Build the Manual System First

The project **must not** begin by writing automation.

Instead:

1. Design the architecture.
2. Install every component manually.
3. Verify every interaction.
4. Document every command.
5. Only then automate it.

Automation is a wrapper around a proven manual process.

It is **not** the process itself.

---

# 2. This Is Not Just an Installer

The goal is **not** to install Docker containers.

The goal is to build a reusable homelab platform that understands:

- infrastructure
- networking
- DNS
- reverse proxies
- certificates
- VPNs
- applications

The installer is simply one interface to this platform.

---

# 3. Software Should Not Be Hidden Behind Generic "Capabilities"

Earlier architectural ideas suggested abstracting everything into generic capability choices.

This is **not** the desired UX.

The installer should explicitly present the real software.

Example:

GOOD

Choose a DNS Server

• Technitium
  Full-featured DNS server with an API for automation.

• AdGuard Home
  DNS server focused on ad blocking.

BAD

Choose DNS

• Basic

• Advanced

The user should always know exactly what software will be installed.

This project targets homelab users who generally want to understand their infrastructure.

---

# 4. Descriptions Should Stay Short

Every software choice should have approximately one sentence.

Not paragraphs.

Not documentation.

Not marketing.

Enough information to understand the purpose without overwhelming the user.

---

# 5. The Installer Should Ask About Software

The installer should not attempt to hide implementation details.

Users should explicitly choose:

- Technitium vs AdGuard
- Caddy vs Traefik
- Tailscale vs NetBird
- step-ca vs Caddy Internal CA

because these are meaningful architectural decisions.

---

# 6. Do Not Ask About "Domain Types"

The installer should **not** ask:

"What type of domain do you want?"

That exposes implementation details that are not important.

Instead:

Ask for the desired root domain.

Example:

bunnyhome.com

home.arpa

mylab.local

etc.

Certificate decisions should happen independently.

---

# 7. Certificate Logic

Certificates are a separate concern from DNS.

If users own a public domain and want publicly trusted certificates, they may use a public CA.

If they do not own the domain (or simply want a private-only environment), recommend installing step-ca.

The installer should not force users into one naming strategy.

---

# 8. Fake Local Domains Are Intentionally Supported

The platform intentionally allows users to create local-only DNS namespaces.

Example:

photos.bunnyhome.com

These exist only inside the user's DNS server.

This is an intentional feature.

The installer should not reject or rewrite these domains simply because they are not publicly owned.

Warnings may be acceptable.

Blocking them is not.

---

# 9. Platform Before Applications

Infrastructure comes first.

Infrastructure consists of:

- DNS
- Reverse Proxy
- Certificate Authority
- VPN

Applications are installed afterwards.

Applications automatically integrate with the existing infrastructure.

---

# 10. The Platform Owns the Infrastructure

Applications should never require users to manually:

- edit DNS
- edit proxy configuration
- issue certificates

The platform handles this automatically.

---

# 11. One Source of Truth

Users should ultimately edit one configuration.

Everything else should be generated.

Examples:

- Docker Compose
- Caddyfile
- DNS Records
- Certificates
- LXC configuration

These are outputs.

Not primary configuration.

---

# 12. Reconciliation Model

The long-term goal is:

homelab apply

The engine computes:

Desired State

↓

Current State

↓

Required Changes

It should not blindly reinstall everything.

---

# 13. Plugin Philosophy

There are intentionally only two major plugin categories.

Deployment Plugins

Responsible for HOW software is installed.

Examples:

- Proxmox LXC
- Proxmox VM
- Docker
- Manual Installation

Service Plugins

Responsible for WHAT software is installed.

Examples:

- Technitium
- Caddy
- step-ca
- Tailscale
- Immich
- Grafana

Avoid introducing additional plugin categories unless there is a compelling architectural reason.

---

# 14. Service Plugins Own Deployment Logic

Each service owns its installation logic for every supported backend.

Example:

services/

    caddy/

        docker/

        proxmox-lxc/

        proxmox-vm/

        manual/

Do not centralize installation logic inside deployment plugins.

---

# 15. Manual Installation Is a First-Class Backend

Manual installation is not an afterthought.

It should be treated as another deployment backend.

This has several advantages:

- easier debugging
- easier learning
- reference implementation
- maximum compatibility

---

# 16. Deployment Choices Should Be Environment-Based

The installer should ask about the user's environment.

Example:

What does your home lab run on?

• Proxmox (Native LXC Containers)

• Proxmox (Docker in a VM)

• Linux (Docker Compose)

• Linux (Manual Installation)

This is preferred over asking about Docker vs LXC directly.

---

# 17. Optional Integrations Are Welcome

Some combinations unlock additional functionality.

Example:

NetBird + Traefik

↓

Enable NetBird Reverse Proxy integration.

These should appear as optional enhancements.

They should never force users onto a specific stack.

---

# 18. The Project Is Educational

Unlike platforms that intentionally hide infrastructure,

this project should expose it.

Users should understand:

- what software exists
- why it exists
- how it fits together

without needing to read external documentation.

The installer should teach without becoming verbose.

---

# 19. Recommendations Are Acceptable, Lock-In Is Not

The installer may recommend a default stack.

For example:

Technitium

Caddy

step-ca

Tailscale

However,

the installer should never assume these choices internally.

Every component should remain swappable.

---

# 20. Architecture Over Convenience

Whenever there is a conflict between:

- making the implementation easier

or

- preserving a clean modular architecture

prefer the cleaner architecture.

The long-term maintainability of the platform is more important than minimizing the initial amount of code.

---

# 21. Preserve the Separation of Design and Implementation

When extending the project, avoid prematurely implementing features that have not been validated manually.

The expected workflow is always:

Design → Manual Validation → Documentation → Automation

not

Idea → Automation → Hope It Works

This principle should guide future development decisions.