# Isolate Nomina host SSH access

Use a dedicated OpenSSH service on the Proxmox host, with one Nomina-generated
client key and an explicitly chosen existing account (default root), rather
than editing the host's administrative sshd or authorized_keys. The managed
proxy supplies private client port 22 and the optional Nomina VPN carries the
same service later; the host service listens only on a verified private host
address. Removing access revokes its key and terminates its managed sessions
while preserving the system SSH service, shared DNS and web exposures.

OpenSSH reads the sole managed public key through a fixed root-run `/bin/cat`
authorization command, with ordinary authorized-key files disabled. This lets a
chosen non-root account authenticate while the managed key directory remains
private to root; no user-controlled arguments are passed to that command.

Stock Debian proxy templates already use port 22 for their own administration.
Relocate that listener to the proxy's private port 22223 through two owned
systemd drop-ins while host SSH is enabled. Preserve the original SSH files,
keys and enabled states, record active states, and restore administration on
removal or failed publication. Reject custom overrides/options or unrelated
listeners rather than replacing operator configuration. This makes default
setup work without disabling administration or changing the host OS sshd.

PAM can move authenticated shells out of the daemon's service cgroup. Revocation
captures dedicated-daemon descendants and terminates them using Linux pidfds
before stopping the daemon, checking process identities to avoid PID reuse.

When a command would disrupt its own managed SSH connection, resolve its inputs
and confirmation first, release project locks, then hand the complete operation
to a separate systemd service. Persist root-private completion status outside
project/secret directories so removal can finish after the caller disconnects.
Offer staged replacement-key preparation and activation: the current key stays
usable while the replacement is downloaded, and activation alone revokes it.
