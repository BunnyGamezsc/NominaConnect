# Create a dedicated LXC per service

For the first Proxmox native-LXC backend, NominaConnect will create and manage
one dedicated LXC for each managed service. This provides a clear ownership
boundary, predictable service networking, and a stable Proxmox LXC ID. Installing
into an existing LXC is deferred to a separate adoption workflow.
