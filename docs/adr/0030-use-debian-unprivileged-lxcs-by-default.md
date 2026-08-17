# Use Debian unprivileged LXCs by default

The first native-LXC plugins use Debian stable templates and create unprivileged
service LXCs by default. A plugin that truly requires elevated privileges must
declare the exception and request explicit confirmation. `nomina init` selects a
default Proxmox storage target, with an optional per-service override.
