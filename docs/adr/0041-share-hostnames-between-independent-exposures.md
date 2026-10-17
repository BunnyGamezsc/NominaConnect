# Share hostnames between independent exposures

An exposure retains its own inventory ID while compatible web, TCP, SMB and host
SSH exposures can share DNS. DNS is removed only when its last managed consumer
is removed; web routes remain unique by hostname and ordinary TCP listeners by
address and port. This extends ADR-0040 without treating DNS names as TCP routing
keys, and prevents removal of SSH from deleting an existing Proxmox web address.
