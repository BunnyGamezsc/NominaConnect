# Keep NominaConnect IDs private

NominaConnect will use stable internal IDs only in its own configuration and
state. It will associate them with provider-native references rather than adding
NominaConnect markers to Caddy, DNS, Docker, Proxmox, or other provider
configuration. This preserves users' ability to manage providers directly and
keeps NominaConnect metadata out of provider-owned resources.
