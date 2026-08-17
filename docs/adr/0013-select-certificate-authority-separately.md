# Select the certificate authority separately

The certificate-authority provider is selected separately from the reverse
proxy. The bootstrap will show only compatible combinations—for example, Caddy
Internal CA or step-ca with Caddy, and step-ca with Traefik—rather than making
TLS an implicit property of the selected proxy. This keeps the architectural
choice visible without exposing invalid combinations.
