# Design constraints

These are implementation constraints, not aspirational ideas.

- Start with a manually installed and verified reference system.
- Expose named choices such as Technitium or AdGuard, Caddy or Traefik,
  Tailscale or NetBird, and step-ca or Caddy Internal CA.
- Keep software descriptions concise but explain why each component exists.
- Ask users about their environment, not merely whether they prefer Docker or
  LXC.
- Support local-only namespaces such as `photos.bunnyhome.com`; warnings are
  allowed, rejection is not.
- Establish DNS, reverse proxy, certificate authority, and VPN before
  applications.
- Treat manual installation as an equal deployment backend.
- Keep optional integrations optional; make recommendations without lock-in.
- Maintain a clear separation: design → manual validation → documentation →
  automation.

The project should make infrastructure visible and teachable without becoming
verbose. It should preserve a polished, guided experience while remaining
transparent about the software and generated artifacts involved.
