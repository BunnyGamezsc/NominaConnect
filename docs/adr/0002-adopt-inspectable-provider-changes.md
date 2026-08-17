# Adopt inspectable provider changes

NominaConnect will inspect the current state of configured providers and
automatically adopt inspectable changes to resources in its managed inventory,
including provider-specific GUI edits. If it cannot inspect a provider well
enough to confirm a managed integration, it will show a verification warning
instead of claiming the integration is healthy. This keeps the inventory useful
for users who work directly in Caddy, Technitium, and similar provider UIs while
making uncertain state explicit.
