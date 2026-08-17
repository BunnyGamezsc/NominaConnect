# Require HTTPS for Caddy exposures

Caddy must publish every managed application through HTTPS. When no
trust-providing CA is configured, it serves TLS with an untrusted certificate;
the application still works and clients show a trust warning. A configured CA
makes the HTTPS certificate trusted. This separates transport encryption from
client trust and keeps CA selection optional.
