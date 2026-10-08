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
- Managed LXCs have automatic startup enabled for host reboots.
- With Tailscale and Caddy, opting out of tailnet access denies gateway requests
  with forged forwarding headers while the exposure remains available locally.
- The gateway must serve HTTPS before opt-out, and reenablement must restore
  it. HTTP denial and the LAN HTTPS redirect are verified separately.
- Tailscale's gateway firewall rejects IPv6 and restricts ingress before its
  own accept hooks. No LAN subnet is advertised.
- Public uninstall restores the exact previous tailnet DNS settings and leaves
  pre-existing LXCs and their global credentials intact.

## Running it

Run as root on the Proxmox host (ADR-0031). Use a host you are willing to lose:
the suite creates LXCs and changes tailnet-wide DNS during a Tailscale run.
Reserve distinct test IPs. Teardown excludes every VMID present before the run.

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
# Bootstrap resolver only if the gateway does not provide DNS.
export NOMINA_ACCEPTANCE_TECHNITIUM_NAMESERVER=1.1.1.1
# Optional resource overrides for a constrained lab.
export NOMINA_ACCEPTANCE_CPUS=1
export NOMINA_ACCEPTANCE_MEMORY_MB=512
export NOMINA_ACCEPTANCE_DISK_GB=2
```

`NOMINA_ACCEPTANCE_FORWARDERS` is only for labs whose network blocks direct
root-server DNS while allowing public recursors. When set, the suite points
the fresh Technitium at those forwarders through its own API before any
downstream LXC needs managed DNS. Unset by default: no behavior change on
open networks.

`NOMINA_ACCEPTANCE_TECHNITIUM_NAMESERVER` optionally sets the resolver inside
the first Technitium LXC while its own DNS service is being installed. The
default is the LXC's gateway address. Set this when that gateway does not
answer DNS; later service LXCs use the managed Technitium address by default.

## Tailscale credentials (two different keys)

A VPN run needs **two** credentials from the Tailscale admin console. They are
not interchangeable:

- **Auth key** (`tskey-auth-…`): lets one device join the tailnet. Mint at
  `https://login.tailscale.com/admin/settings/keys` under **Auth keys**.
  Prefer a short expiry and a tag if your tailnet uses them. The service LXC
  consumes it once for `tailscale up`.
- **Admin API token** (`tskey-api-…`): lets NominaConnect call the Tailscale
  control-plane API to set the gateway as the tailnet's sole nameserver, enable
  **Override local DNS**, and restore the prior nameserver and override settings
  on removal. Setup does not create split-DNS rules and refuses to continue when
  an existing split-DNS rule points at another resolver. Mint
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

The suite uses an isolated credential store inside its temporary project.
It invokes public uninstall to restore DNS before destroying the gateway.
It also finds failed-provisioning orphans by reserved IP and expected hostname,
excluding all pre-existing VMIDs. The teardown verifies that the original
LXCs, global credential digest and live tailnet DNS settings are unchanged.
If uninstall cannot restore DNS, teardown stops and retains the temporary
project and credentials for recovery. An interrupted run likewise leaves its
project under `$TMPDIR`.

## Fast Caddy process regression

`acceptance/caddy-tailnet.acceptance.mjs` drives the production Caddy adapter
against a real Caddy process. It starts from a routes-only HTTPS server with
no listener, then verifies trusted gateway denial, LAN availability, HTTP
redirect behavior and reenablement. It does not provision LXCs or change DNS.
It is skipped unless `NOMINA_CADDY_BINARY` points at a Caddy executable.

Run as root inside a separate Linux network namespace, with loopback enabled:

```sh
unshare --net sh -c 'ip link set lo up; NOMINA_CADDY_BINARY=/usr/bin/caddy node --test acceptance/caddy-tailnet.acceptance.mjs'
```

The test uses temporary CA storage and does not install client trust.
