# Store connection secrets in a secure local store

NominaConnect configuration will contain references to connection secrets, not
the secrets themselves. The primary Proxmox workflow runs as root directly in
the Proxmox shell and therefore does not need a remote Proxmox API token. Other
provider credentials are kept in the OS keychain or another secure local secret
store, keeping plain-text credentials out of project configuration.
