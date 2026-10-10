# Separate TCP from web exposures

Managed exposures select HTTPS or raw TCP, with existing records retaining HTTPS.
Ordinary TCP selects its backend by listener address and port, so each TCP
exposure owns a distinct port on the selected proxy LXC and defaults to its
backend port on creation; republish retains that client port when the backend
moves. TCP uses Debian's existing systemd socket forwarding with persistent
per-port units, independently of Caddy or Traefik, avoiding proxy extensions
and HTTPS certificate changes for non-web applications.

The LAN DNS record points at the proxy LXC. The existing Technitium relay rewrites
that answer to the Tailscale gateway address remotely, and the gateway forwards
only opted-in TCP listener ports. Scoped chains and port files preserve DNS,
web forwarding, gateway administration and unmanaged resources; conflicts are
checked before publishing. Transport health is reported separately from a
Minecraft join or other application authentication.

References: [systemd socket proxy](https://github.com/systemd/systemd/blob/main/man/systemd-socket-proxyd.xml),
[Debian systemd package](https://packages.debian.org/trixie/amd64/systemd/filelist),
[socket binding at boot](https://systemd.io/NETWORK_ONLINE/).
