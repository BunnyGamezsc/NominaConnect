# Model deployment as a user choice

Native Proxmox LXC is NominaConnect's first implemented deployment backend, but
deployment remains an explicit user-selected option in the managed inventory.
The model must accommodate other environments and backends, including Docker in
a Proxmox VM, rather than baking LXC assumptions into every service. This keeps
the initial Proxmox focus compatible with the platform's multi-backend design.
