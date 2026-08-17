# Run from the Proxmox root shell

NominaConnect's primary workflow runs as root directly in the Proxmox shell,
like a Proxmox community script. It uses local Proxmox management commands
instead of requiring a remote Proxmox API token. This makes the intended
operator context explicit and simplifies native-LXC provisioning.
