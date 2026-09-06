# Grant VPN LXCs a TUN device

An unprivileged service LXC (ADR-0030) has no `/dev/net/tun`, and a VPN client
cannot form a tunnel without one. NominaConnect checks the device from inside
the container before it installs a VPN client. If the device is missing, it
grants it from the Proxmox root shell — `pct set <vmid> --dev0 /dev/net/tun`
plus `keyctl=1,nesting=1`, then a reboot of that LXC — and re-checks.

The mutation is limited to the dedicated service LXC NominaConnect created for
that VPN, so no unmanaged container gains a device. A host that cannot provide
the device (Proxmox before 8.2 has no `dev[n]` option) is not worked around:
setup fails with the exact `pct` commands and the equivalent
`lxc.cgroup2.devices.allow` / `lxc.mount.entry` lines, and leaves the LXC in
place for the operator to keep or destroy.

This keeps the container unprivileged: passing through one character device is
not the same as running a privileged LXC.
