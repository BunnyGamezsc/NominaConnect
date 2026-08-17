const provider = (name, description, compatibleWith = undefined) => Object.freeze({ name, description, compatibleWith });

export const INITIAL_PLATFORM_CATALOG = Object.freeze({
  dns: Object.freeze([
    provider("technitium", "provides local DNS records and name resolution")
  ]),
  reverseProxy: Object.freeze([
    provider("caddy", "publishes HTTPS routes to managed services"),
    provider("traefik", "publishes HTTPS routes to managed services")
  ]),
  certificateAuthority: Object.freeze([
    provider("step-ca", "issues trusted internal certificates", ["caddy", "traefik"]),
    provider("caddy-internal-ca", "issues Caddy-managed internal certificates", ["caddy"])
  ]),
  vpn: Object.freeze([
    provider("tailscale", "connects the managed inventory to a private network"),
    provider("netbird", "connects the managed inventory to a private network")
  ])
});

const allProviders = Object.values(INITIAL_PLATFORM_CATALOG).flat();

export function hasCatalogOption(category, name) {
  return INITIAL_PLATFORM_CATALOG[category].some((option) => option.name === name);
}

export function certificateAuthorityIsCompatible(authority, reverseProxy) {
  return authority === "none" || allProviders
    .find((option) => option.name === authority)
    ?.compatibleWith.includes(reverseProxy) === true;
}

export function getPlatformProvider(name) {
  if (!allProviders.some((providerDefinition) => providerDefinition.name === name)) {
    throw new Error(`Unsupported platform provider: ${name}.`);
  }

  return Object.freeze({
    name,
    setup: (adapter, managedItem) => adapter.setup({ provider: name, managedItem }),
    inspect: (adapter, managedItem) => adapter.inspect({ provider: name, managedItem }),
    adopt: (adapter, managedItem, observedConfiguration) => adapter.adopt({ provider: name, managedItem, observedConfiguration }),
    healthCheck: (adapter, managedItem) => adapter.healthCheck({ provider: name, managedItem })
  });
}
