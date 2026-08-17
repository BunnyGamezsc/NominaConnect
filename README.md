# NominaConnect

NominaConnect is a declarative homelab infrastructure platform. It describes the
services a homelab needs, the relationships between them, and the environment
they run in. It is not a Docker dashboard or a collection of opaque install
scripts.

The repository begins with the manual reference system on purpose. Each layer
must be designed, installed manually, verified, and documented before the
project generates configuration or automates deployment.

## Start here

1. Read [the architecture](docs/architecture.md).
2. Copy [the example system definition](examples/homelab.yaml) and make it
   describe one real homelab.
3. Work through [the first manual reference path](docs/manual/dns-proxy-tls.md)
   on a disposable host.
4. Record the commands, observations, and verification results in that guide.

No automation is intentionally included yet. The first automation should be
created only after this reference path is repeatable and verified.

## Principles

- One user-edited system definition is the source of truth.
- Infrastructure (DNS, proxy, certificate authority, VPN) is established before
  applications.
- Users select named software, not vague capabilities.
- Local-only domains are supported; warnings are preferable to blockers.
- A service owns its deployment logic for every backend, including manual
  installation.
- Generated Compose files, proxy configuration, DNS records, and certificates
  are outputs, never the canonical configuration.

## Repository map

- `docs/architecture.md` — boundaries, domain terms, desired-state model.
- `docs/manual/` — the proven manual reference implementations.
- `docs/decisions.md` — product-level constraints carried into future work.
- `examples/homelab.yaml` — illustrative single-source-of-truth configuration.

## Near-term milestone

Manually validate a DNS + reverse-proxy + internal-certificate path for a local
domain and one application. Capture exact commands and acceptance evidence;
then define the smallest generated artifacts and only then add an `apply`
implementation.
