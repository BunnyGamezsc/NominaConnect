# Superseded: use `pct exec` rather than per-LXC SSH

Superseded by ADR-0032. NominaConnect controls dedicated service LXCs through
local `pct exec` calls from the Proxmox root shell, so per-LXC SSH keys are not
needed in the primary workflow.
