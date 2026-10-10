# Require HTTPS for Caddy web exposures

Caddy must publish every managed web application through HTTPS. When no
trust-providing CA is configured, it serves TLS with an untrusted certificate;
the application still works and clients show a trust warning. A configured CA
makes the HTTPS certificate trusted. This separates transport encryption from
client trust and keeps CA selection optional.

Raw TCP exposures use a separate transport under ADR-0040 and do not request
HTTP routes or HTTPS certificates.
