# Windows VirtualBox Proxmox lab network

This is a self-service setup for the VirtualBox Proxmox test VM on Windows at
`192.168.1.3`. Its existing NIC is bridged onto the isolated Ethernet lab
network, not the production server or its Wi-Fi subnet.
The [September live run](../../docs/proxmox-test-run-report.md) used a Mac
gateway: `en8` at `192.168.1.1` forwarded the Ethernet lab through Wi-Fi
`en0` with PF NAT. The Windows launcher adds a separate VirtualBox host-only
adapter so Windows can reach the VM's LXCs; it leaves the existing Ethernet
bridge and Mac gateway alone.

```text
Windows host                 VirtualBox Proxmox VM             LXCs
172.28.240.1/24 <---------> vmbr1 172.28.240.3/24 <------> .53, .54, .56, .57
                              | NAT for LXC outbound traffic
                              v
                         vmbr0 192.168.1.3 -> Mac en8 .1 -> Mac Wi-Fi en0
```

VirtualBox must pass the LXC MAC addresses on its host-only NIC. The launcher
sets that NIC to `allow-all` promiscuous mode. Oracle documents both the
[host-only network](https://docs.oracle.com/en/virtualization/virtualbox/7.2/user/networkingdetails.html)
and the [NIC options](https://docs.oracle.com/en/virtualization/virtualbox/7.1/user/vboxmanage.html).

## Before setup

1. Install VirtualBox 7.1 or newer and the Windows OpenSSH Client. Keep both
   scripts in this directory together.
2. Confirm the Proxmox VM's Ethernet bridge is still `192.168.1.3`, root SSH
   there is reachable, and its default route via the Mac's `192.168.1.1`
   gateway has internet access. If the Mac gateway is off, use the Mac setup
   script below first. The Windows launcher does not configure or replace the
   VM's management NIC or the Mac gateway.
3. Shut the Proxmox VM down cleanly. Open **Windows PowerShell as Administrator**.
4. If you forgot the **test VM's** root password, first try the SSH key used
   against `192.168.1.3` in the earlier live run. That key worked then, but
   may no longer be present or accepted. On Windows, pass its private key
   with `-SshIdentityFile` only if it is available there.
   If you can still SSH with that key, run `passwd root` inside the VM to set a
   new password. If no key works, use the VirtualBox console and Proxmox's
   [root password reset guide](https://pve.proxmox.com/wiki/Root_Password_Reset).
   For a GRUB boot, edit the Linux boot entry, append `init=/bin/bash`, boot,
   run `mount -o remount,rw /` and `passwd root`, then reboot normally. Other
   bootloaders have different menus. Do not put the password in a command
   argument, this repo, or the field test report.

The setup needs working root SSH because it copies and runs the companion
Proxmox script. A recovered console login lets you restore that SSH access.
If the root SSH server refuses password login, use or install a key from the
console instead of weakening SSH settings.

## Run

From an elevated Windows PowerShell window in this directory:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup-virtualbox-proxmox.ps1 -Action setup -VmName 'pve' -SshTarget 'root@192.168.1.3'
```

With an SSH key, add `-SshIdentityFile 'C:\Users\YOU\.ssh\id_ed25519'`.
The script prompts for the VM name and SSH target if omitted. It checks that
the VM is powered off, creates a dedicated host-only adapter, attaches it as
NIC 2, starts the VM, copies the companion script over SSH, and configures
`vmbr1` plus LXC outbound NAT. If NIC 2 is in use, pass an unused `-NicSlot`
from 2 to 8. If `172.28.240.0/24` overlaps your network, pass another private
three-octet prefix with `-LabPrefix`, for example `-LabPrefix 172.28.241`.

The script records its own adapter and VM settings under
`%LOCALAPPDATA%\NominaConnect\lab`. Re-running `setup` with the same options
finishes an interrupted setup without adding another adapter. On the VM, it
backs up `/etc/network/interfaces` before appending the `vmbr1` stanza. It
never rewrites `vmbr0`.

Check the network:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup-virtualbox-proxmox.ps1 -Action status -VmName 'pve' -SshTarget 'root@192.168.1.3'
Test-NetConnection 172.28.240.3 -Port 8006
```

For NominaConnect, select `vmbr1` as the bridge. Use `172.28.240.53` for
Technitium, `.54` for Caddy or Traefik, `.56` for step-ca, and `.57` for
Tailscale. Their gateway is **`172.28.240.3`**, the Proxmox VM. These addresses
must be free before provisioning. Windows can directly reach the LXCs on this
host-only network. Other LAN devices cannot; test remote access through the
tailnet from another device.

To remove the lab network, first remove or move every LXC attached to
`vmbr1`, then run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup-virtualbox-proxmox.ps1 -Action remove -VmName 'pve' -SshTarget 'root@192.168.1.3'
```

Removal stops the VM cleanly, detaches only the NIC the launcher added,
removes its dedicated Windows adapter, and restarts the VM if it was running.
The Proxmox script removes its own bridge stanza and NAT rule. If removal
fails, the saved state remains so you can fix the cause and retry.

This code has not yet run on the Windows host or Proxmox VM. Follow the
[Kimi K3 field test handoff](../../docs/kimi-k3-proxmox-field-tests.md) for
the first live run and record any VirtualBox version differences. Before
product field tests, run `bash tools/lab/deploy-local-build.sh root@VM-IP`
from the latest Mac checkout. It builds that checkout's Linux binary, copies
it to Proxmox, and verifies matching hashes. The PowerShell deploy script is
available if the working checkout moves to Windows later.

## Earlier Mac gateway

For a repeat of the earlier Mac `en8` lab, use the paired scripts below on
the Mac. Supply the guest-facing interface, gateway address, and /24 subnet;
the outbound interface comes from the Mac's current default route.

```sh
sudo bash tools/lab/setup-mac-gateway.sh en8 192.168.1.1 192.168.1.0/24
sudo bash tools/lab/uninstall-mac-gateway.sh
```

Setup adds the specified address as an interface alias, installs NAT in its
own `com.apple/nomina-lab` PF anchor, enables IPv4 forwarding, and saves the
prior forwarding value plus its PF enable token under
`/var/db/nominaconnect/mac-lab`. Uninstall clears that NAT anchor, releases
the PF token, removes only the alias it added, and restores forwarding.
Run setup each time the gateway is needed and uninstall when done. These
scripts require macOS and have not been run against the earlier Mac. If the
old gateway address or NAT rule was configured manually, remove that old
configuration separately first; setup refuses to take ownership of an
existing address. The scripts do not alter the Windows VirtualBox lab.
