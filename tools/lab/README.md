# Proxmox field-test tools

## Current retained lab

The current `bunnytest` lab uses Windows Ethernet `192.168.1.2/24`, Proxmox
`192.168.1.3/24` on `vmbr0`, and Mac Ethernet `192.168.1.20/24`. Windows uses
its own Wi-Fi for internet. VirtualBox adapter 1 bridges the physical Ethernet
for management; adapter 2 supplies independent NAT internet to Proxmox;
adapter 3 is host-only at `192.168.56.0/24` for PC-to-VM access without the Mac.
The old conflicting host-only address `192.168.1.1` was replaced.

Proxmox forwards container traffic through its NAT adapter. The Mac is no
longer its internet gateway. The retained project and four LXCs must not be
deleted as test cleanup. Keep Windows awake during unattended tests.

The [current field report](../../docs/bunnytest-tailnet-field-report.md) records
addresses, service IDs, validation and remaining failures. The older
[Muse handoff](../../docs/muse-spark-proxmox-field-tests.md) describes the
previous Mac-dependent arrangement and is historical context.

## Build on the Mac and copy the exact binary

From the latest Mac checkout, with Bun installed:

```sh
bun install
bash tools/lab/deploy-local-build.sh root@192.168.1.3
```

The deploy script runs `build:native` locally, copies
`dist/nomina-linux-x64` to `/opt/nominaconnect-test/nomina-linux-x64`, checks
matching SHA-256 hashes, and runs `--version` on the VM. Use that absolute
binary path for product field tests. The acceptance suite imports source
modules directly and needs a matching source copy on the VM.

`tools/lab/backend.mjs` is a small HTTP backend for exposure tests. Start it
on the Proxmox host with `node tools/lab/backend.mjs`; it listens on port
8080 and returns `nomina lab backend ok`.

## Retained-lab readiness helpers

These helpers are scoped to the current bunnytest addresses and VMIDs.
Read them before reuse. Proxmox helpers require root and `NOMINA_READINESS=1`.

- `check-certificate-renewal.mjs /root/nomina-bunnytest` creates one short-lived
  exposure, verifies automatic renewal with fresh trusted TLS, and restores
  CA/Caddy settings. Check `.nomina/renewal-check/restored` after interruptions.
- `check-backup-restore.mjs /root/nomina-bunnytest` stores root-only provider,
  project and secret archives on Proxmox. It restores step-ca into a disconnected
  temporary LXC, compares private keys/configuration and checks service startup.
  It removes only that clone. Check storage first. `clone.json` records recovery
  state if interrupted; `cleaned` marks successful clone cleanup.
- `check-gateway-recovery.mjs /root/nomina-bunnytest` applies current firewall
  and DNS units. It briefly uses an absent bind address, verifies repeated DNS
  retries and automatic recovery after restoring the original unit, then cleans
  up. Follow `.nomina/gateway-recovery-pending` if interrupted.
- `inspect-tailnet-readiness.mjs /root/nomina-bunnytest` performs a read-only
  credential-default, device and DNS audit without printing secrets. API-token
  expiry still needs operator or console verification.
- On the Mac, `check-client-readiness.mjs <mode> <evidence-directory>` checks
  native DNS, fresh trusted HTTPS, direct DNS and gateway port restrictions.
  Modes are `local-only`, `both-on` and `disconnected`. The directory must contain
  `step-ca-root.crt`. Client toggles and physical Ethernet disconnection are
  separate actions; this helper does not change client networking.

## Optional historical Mac gateway

This is not needed for the current independent-internet lab.
The earlier Mac setup used `en8` at `192.168.1.1` and PF NAT through the
Mac's default-route interface. If that gateway is already working, leave it
alone. For a fresh, repeatable setup after removing any old manual alias or
NAT rule, use:

```sh
sudo bash tools/lab/setup-mac-gateway.sh en8 192.168.1.1 192.168.1.0/24
sudo bash tools/lab/uninstall-mac-gateway.sh
```

Setup records the interface alias, PF enable token, NAT anchor, and prior
forwarding value under `/var/db/nominaconnect/mac-lab`. Uninstall removes
only those recorded changes. It cannot safely uninstall the earlier manually
configured gateway; inspect and remove that configuration separately first.
The scripts have passed syntax checks but have not been run on this Mac.
