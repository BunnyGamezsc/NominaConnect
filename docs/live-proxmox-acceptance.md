# Live Proxmox acceptance run

NominaConnect has two layers of adapter coverage.

**Conformance** (`npm test`) drives every provider in the initial platform
catalog through the production adapter set — the same composition the installed
`nomina` binary wires — against controlled command and HTTP fixtures. It runs
in seconds and gates every change. See `test/adapter-conformance.test.js` and
`test/background-adoption-conformance.test.js`.

**Acceptance** (`npm run test:acceptance`) runs the same public commands
against a real, disposable Proxmox host, so a command plan or an HTTP fixture
can never be mistaken for working infrastructure. It is not part of `npm test`
and never runs by accident.

## What it verifies

- A real dedicated unprivileged Debian LXC is created with the requested
  hostname, static IP and bridge.
- IP preflight sees a genuine collision on the host.
- A published exposure is HTTPS and actually serves, with no HTTP fallback.
- Unmanaged provider configuration seeded before the run survives it.
- Publishing records a provider-native locator and fingerprint that background
  tracking can resolve on a later pass.
- With a VPN selected, the client reports an operational enrollment and the
  enrollment credential never reaches command output.

## Running it

Run as root on the Proxmox host (ADR-0031). Use a host you are willing to lose:
the suite creates LXCs, and although teardown only destroys vmids it read back
out of its own project state, a live homelab is the wrong place for it.

```sh
export NOMINA_ACCEPTANCE=1
export NOMINA_ACCEPTANCE_DISPOSABLE=yes
export NOMINA_ACCEPTANCE_STORAGE=local-lvm
export NOMINA_ACCEPTANCE_BRIDGE=vmbr0
export NOMINA_ACCEPTANCE_TEMPLATE=debian-13
export NOMINA_ACCEPTANCE_GATEWAY=10.0.0.1
export NOMINA_ACCEPTANCE_DNS_IP=10.0.0.53
export NOMINA_ACCEPTANCE_PROXY_IP=10.0.0.54
export NOMINA_ACCEPTANCE_BACKEND=10.0.0.80:8080

npm run test:acceptance
```

Optional:

```sh
export NOMINA_ACCEPTANCE_PROXY=traefik        # default caddy
export NOMINA_ACCEPTANCE_DOMAIN=acceptance.test
export NOMINA_ACCEPTANCE_NODE=pve-1           # default: hostname
export NOMINA_ACCEPTANCE_VPN=tailscale        # or netbird
export NOMINA_ACCEPTANCE_VPN_IP=10.0.0.57
export NOMINA_ACCEPTANCE_VPN_KEY=tskey-auth-…
```

Without `NOMINA_ACCEPTANCE=1` and `NOMINA_ACCEPTANCE_DISPOSABLE=yes` — or off
a Proxmox root shell, or with any required variable unset — the suite skips
with the reason printed rather than doing anything to the host.

## Teardown

Every LXC the run created is stopped and destroyed afterwards, chosen only from
the vmids recorded in the run's own `.nomina/state.json`. A container that
already existed on the host is never a teardown target. If the run is
interrupted, its temporary project directory under `$TMPDIR` still holds the
state file listing exactly what to remove.
