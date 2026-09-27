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
export NOMINA_ACCEPTANCE_FORWARDERS=1.1.1.1,8.8.8.8
```

`NOMINA_ACCEPTANCE_FORWARDERS` is only for labs whose network blocks direct
root-server DNS while allowing public recursors. When set, the suite points
the fresh Technitium at those forwarders through its own API before any
downstream LXC needs managed DNS. Unset by default: no behavior change on
open networks.

## Tailscale credentials (two different keys)

A VPN run needs **two** credentials from the Tailscale admin console. They are
not interchangeable:

- **Auth key** (`tskey-auth-…`): lets one device join the tailnet. Mint at
  `https://login.tailscale.com/admin/settings/keys` under **Auth keys**.
  Prefer a short expiry and a tag if your tailnet uses them. The service LXC
  consumes it once for `tailscale up`.
- **Admin API token** (`tskey-api-…`): lets NominaConnect call the Tailscale
  control-plane API to set tailnet-wide DNS (split-DNS for the lab zone,
  tailnet nameservers) and to restore the prior tailnet DNS on removal. Mint
  at `https://login.tailscale.com/admin/settings/keys` under **API access
  tokens** (past the Auth keys section). Prefer a short expiry and revoke it
  after the run. It never enters the LXC; it stays in the local secret store.

For the suite:

```sh
export NOMINA_ACCEPTANCE_VPN=tailscale
export NOMINA_ACCEPTANCE_VPN_IP=10.0.0.57
export NOMINA_ACCEPTANCE_VPN_KEY=tskey-auth-…        # enrollment only
export NOMINA_ACCEPTANCE_TAILSCALE_API_TOKEN=tskey-api-…  # tailnet DNS admin
```

For the `nomina` binary (same meanings, different names):

```sh
export NOMINA_SECRET_TAILSCALE__TAILNET_AUTH_KEY_=tskey-auth-…
export NOMINA_TAILSCALE_API_TOKEN=tskey-api-…
```

(The doubled/trailing underscores in the first name come from the product's
`NOMINA_SECRET_<LABEL>` derivation; copy it exactly.)

Handling rules, everywhere: keep each key in its own root-only (`0600`) file
on the Proxmox host and load it into the environment at run time — never paste
either key into chat, tickets, or reports, and never pass one as a CLI flag
(it would show in process listings). The VPN acceptance check asserts the
enrollment credential never reaches command output.

Without `NOMINA_ACCEPTANCE=1` and `NOMINA_ACCEPTANCE_DISPOSABLE=yes` — or off
a Proxmox root shell, or with any required variable unset — the suite skips
with the reason printed rather than doing anything to the host.

## Teardown

Every LXC the run created is stopped and destroyed afterwards, chosen only from
the vmids recorded in the run's own `.nomina/state.json`. A container that
already existed on the host is never a teardown target. If the run is
interrupted, its temporary project directory under `$TMPDIR` still holds the
state file listing exactly what to remove.
