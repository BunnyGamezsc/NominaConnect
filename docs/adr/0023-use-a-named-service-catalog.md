# Use a named service catalog

The CLI will present named, supported service plugins with concise explanations
instead of accepting arbitrary shell commands or container images. Each plugin
owns its Proxmox-LXC setup, inspection, and platform integration behavior, so
the CLI can make its actions transparent and reliable.
