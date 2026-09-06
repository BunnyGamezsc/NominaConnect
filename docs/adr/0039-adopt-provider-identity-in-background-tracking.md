# Adopt provider identity in background tracking

Provider-precedence adoption (ADR-0005) used to reach provider-native identity
only through the foreground `nomina service recheck` command. Background
tracking inspected deployments and exposures but never called `adapter.adopt()`,
so a peer renamed in the Tailscale console, a route rewritten in Caddy, or a
record edited in Technitium stayed silently divergent until an operator ran a
manual recheck.

Background tracking now adopts provider-native identity in the same pass. For
each managed platform item and each exposed service it resolves the stored
provider-native locator first, falls back to a resource the adapter flags as
its own, and only then to the managed id. A resolved resource whose locator or
fingerprint has moved is handed to `plugin.adopt()`; the adapter decides
whether the match is safe, and the returned locator and fingerprint are written
into `project.state.providerReferences` through the configuration write queue.

A locator matches exactly, or on a provider-native `id` that survived a rename.
Technitium, Caddy, Traefik and step-ca address a resource by its whole locator
and record a direct edit in the fingerprint instead, so exact matching is
right for them. Tailscale and NetBird carry a stable id alongside a renameable
hostname, so the id alone may carry a match. Anything else is a different
resource, not a renamed one.

Missing, ambiguous, and conflicting matches never become a guess. They become
verification warnings, the managed configuration is preserved untouched, and
the provider is not written to. Adoption remains a write to NominaConnect's own
state: no NominaConnect ID is ever placed in provider configuration (ADR-0003),
and background tracking still never changes live software (ADR-0034).
