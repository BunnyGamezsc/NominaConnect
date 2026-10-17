# Host SSH

Host SSH opens a shell on the Proxmox machine running Nomina. It uses one
generated Ed25519 client key and an existing OS account selected during setup
(default `root`). Passwords, keyboard-interactive login, unrelated authorized
keys and certificate authorities cannot authenticate to this dedicated service.
The host's existing SSH service and administrator keys are preserved.

## Setup

In the interactive menu choose **Enable host SSH**, select the hostname and OS
account, then use **Edit an exposure → Download SSH key** to export the key.
You can also choose **Host SSH** when publishing a manual exposure.

Scripted setup:

```sh
nomina ssh enable --hostname pve.bunny.internal --ssh-user root
nomina ssh export --output /root/nomina_ssh
```

Nomina discovers the local private IPv4 address used to reach the proxy. For a
multi-interface host, specify `--host-ip 192.168.1.10`. This must be an address
assigned to the machine running Nomina, not another server or LXC. OpenSSH,
systemd, iproute2 and Python 3 with Linux pidfd support must already be installed
on the supported Proxmox host. Python terminates managed shells that PAM moves
outside the dedicated SSH service's process group.

The export is a mode-0600 file on the host; transfer it securely to your computer.
Nomina never prints its private contents or puts them in project YAML/state.
On macOS/Linux, save it as `~/.ssh/nomina_ssh`, run
`chmod 600 ~/.ssh/nomina_ssh`, and add this to `~/.ssh/config`:

```sshconfig
Host pve.bunny.internal
  User root
  IdentityFile ~/.ssh/nomina_ssh
  IdentitiesOnly yes
```

Windows OpenSSH uses the same configuration in `%USERPROFILE%\.ssh\config`;
keep the private key accessible only to your Windows account. After this one-time
setup, use `ssh root@pve.bunny.internal` (substitute the selected OS account).

## Home network and Nomina VPN

The name resolves to the managed proxy on the LAN. Port 22 forwards privately
to the dedicated host sshd at its private IPv4 address on port 22222. Web traffic
uses its independent HTTPS route, for example to Proxmox port 8006. SMB and
generic TCP can share the name on other available ports.

VPN is optional. Enabling SSH retains its VPN access preference before VPN
provisioning. When Nomina provisions its Tailscale gateway later, it reconciles
the existing SSH exposure without generating another key. Remote DNS points to
the gateway, whose VPN-only port 22 forwards to the same managed listener.
There are no home-router changes, UPnP calls, public listeners or LAN subnet
advertisements. NetBird remote access is deferred.

When a standard Debian proxy already uses port 22 for administration, Nomina
temporarily moves that administrative listener to the proxy's private address
on port 22223. Its SSH configuration, keys, enabled states and existing sessions
are preserved. Two scoped systemd drop-ins are removed when host SSH is removed,
restoring the original administrative listener. The Proxmox host's ordinary SSH
service is unaffected. Port 22223 is reserved for this private administration.
Custom SSH overrides/options, unrelated port-22 processes and an occupied
administration port are rejected before host credentials are created.
A gateway's LAN administrative SSH listener is
preserved because forwarding matches only the gateway's VPN address. Existing
unmanaged gateway forwarding also produces a conflict error.

## Replace, disable and remove

```sh
nomina ssh replace-key --output /root/new_nomina_ssh
nomina ssh disable
```

Replacement requires a new output path and revokes the old key, disconnecting
managed sessions. The service keeps its server identity key, so ordinary key
replacement does not change its SSH host fingerprint. If a replaced key was
stolen, delete its exported copies too.

Disabling SSH removes its exposure and client key and stops the managed host
service. Re-enabling generates a fresh client key that must be transferred
again. Other exposures keep their DNS, routes and TCP forwarding. Removing the
last exposure for a name removes its managed A record. When names are shared,
remove/edit by exposure name or inventory ID; hostname-only selection is
rejected as ambiguous. Nuclear uninstall also removes the dedicated host unit
and its keys before deleting recovery state.

Local automated checks do not establish real Proxmox or remote Tailscale login.
Complete the [server verification checklist](ssh-implementation-checklist.md)
before treating this as validated on a live server.
