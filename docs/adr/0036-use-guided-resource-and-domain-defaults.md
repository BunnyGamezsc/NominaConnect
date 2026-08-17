# Use guided resource and domain defaults

The first release centers on the initial platform catalog. Each service plugin
shows recommended LXC CPU, memory, disk, and related resources while allowing
the user to override them. `nomina init` records a base local domain and web
service setup suggests `<service>.<base-domain>` while allowing any full
hostname, including a local-only domain.
