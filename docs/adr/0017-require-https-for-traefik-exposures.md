# Require HTTPS for Traefik web exposures

Traefik must follow the same web exposure rule as Caddy: every managed web application
uses HTTPS. Without a configured trust-providing CA, it serves an untrusted TLS
certificate rather than falling back to HTTP. This gives both proxy choices the
same user-facing encryption and trust behavior.

Raw TCP exposures use a separate transport under ADR-0040 and do not request
HTTP routes or HTTPS certificates.
