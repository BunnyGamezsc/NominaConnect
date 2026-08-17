# Default the bridge and generate hostnames

`nomina init` selects a default Proxmox network bridge for new service LXCs,
with a per-service override. NominaConnect generates predictable LXC hostnames
from service names and lets users override them during setup. This keeps routine
provisioning fast without hiding network or naming choices.
