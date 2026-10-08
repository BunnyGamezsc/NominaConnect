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
