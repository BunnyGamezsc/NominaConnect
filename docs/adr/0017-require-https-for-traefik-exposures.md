# Require HTTPS for Traefik exposures

Traefik must follow the same exposure rule as Caddy: every managed application
uses HTTPS. Without a configured trust-providing CA, it serves an untrusted TLS
certificate rather than falling back to HTTP. This gives both proxy choices the
same user-facing encryption and trust behavior.
