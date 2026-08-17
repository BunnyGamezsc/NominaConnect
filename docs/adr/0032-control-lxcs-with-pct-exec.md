# Control LXCs with pct exec

NominaConnect will install, configure, and inspect dedicated service LXCs with
local `pct exec` calls from the Proxmox root shell. This replaces per-LXC SSH
administration, keeps privileged control on the Proxmox host, and matches the
community-script operating model.
