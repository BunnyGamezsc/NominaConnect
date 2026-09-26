# Proxmox field-test tools

The VirtualBox test VM uses its existing Ethernet bridge: Windows' Realtek
controller is `192.168.1.2/24`, Proxmox is `192.168.1.3/24` on `vmbr0`, and
the Mac is the Ethernet gateway at `192.168.1.1` on `en8`. The Mac forwards
outbound traffic through its Wi-Fi connection. No additional VirtualBox
host-only adapter or Proxmox bridge is required to reach the VM.

The Windows VirtualBox Host-Only adapter named `Ethernet 4` was observed at
`192.168.1.1`, duplicating the Mac gateway. Check its current state on Windows
before testing; disable or readdress it if it still owns that address. The VM
became reachable after its first NIC was re-bridged to the Realtek controller.
These observations are in the [Muse field-test handoff](../../docs/muse-spark-proxmox-field-tests.md).

The four older service LXCs were present but stopped at the last check. Run
`pct list` and inspect their configs before choosing addresses for a new test.
Do not delete or reuse their addresses merely because they are stopped.

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

## Temporary Mac gateway

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
