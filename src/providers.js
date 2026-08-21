function createProviderPlugin({ name, operations, exposureProtocol = undefined }) {
  return Object.freeze({
    name,
    setup(adapter, managedItem) {
      return adapter.setup({
        provider: name,
        managedItemId: managedItem.id,
        operations,
        ...(exposureProtocol === undefined ? {} : { exposureProtocol })
      });
    },
    inspect(adapter, managedItem, { providerReferences = [] } = {}) {
      const observed = adapter.inspect({ provider: name, managedItemId: managedItem.id });
      const managedIds = new Set(providerReferences);
      const resources = observed.resources ?? [];
      return {
        provider: name,
        managedItemId: managedItem.id,
        managed: resources.filter((resource) => managedIds.has(resource.id)),
        unmanaged: resources.filter((resource) => !managedIds.has(resource.id)),
        ...(observed.deployment !== undefined ? { deployment: observed.deployment } : {}),
        ...(observed.configuration !== undefined ? { configuration: observed.configuration } : {})
      };
    },
    adopt(adapter, managedItem, observedConfiguration) {
      return adapter.adopt({
        provider: name,
        managedItemId: managedItem.id,
        managed: observedConfiguration.managed
      });
    },
    healthCheck(adapter, managedItem) {
      const observed = adapter.healthCheck({
        provider: name,
        managedItemId: managedItem.id
      });
      const healthy = observed.process === "running" && observed.endpoint === "reachable";
      return {
        provider: name,
        managedItemId: managedItem.id,
        process: observed.process,
        endpoint: observed.endpoint,
        status: healthy ? "healthy" : "unhealthy"
      };
    }
  });
}

export const PLATFORM_PROVIDERS = Object.freeze({
  technitium: createProviderPlugin({
    name: "technitium",
    operations: ["install-technitium", "configure-managed-zones"]
  }),
  caddy: createProviderPlugin({
    name: "caddy",
    operations: ["install-caddy", "configure-https-routes"],
    exposureProtocol: "https"
  }),
  traefik: createProviderPlugin({
    name: "traefik",
    operations: ["install-traefik", "configure-https-routes"],
    exposureProtocol: "https"
  }),
  "step-ca": createProviderPlugin({
    name: "step-ca",
    operations: ["install-step-ca", "configure-internal-pki"]
  }),
  "caddy-internal-ca": createProviderPlugin({
    name: "caddy-internal-ca",
    operations: ["configure-caddy-internal-ca"]
  }),
  tailscale: createProviderPlugin({
    name: "tailscale",
    operations: ["install-tailscale", "join-tailnet"]
  }),
  netbird: createProviderPlugin({
    name: "netbird",
    operations: ["install-netbird", "join-netbird-network"]
  })
});

export function getPlatformProvider(name) {
  const plugin = PLATFORM_PROVIDERS[name];
  if (plugin === undefined) {
    throw new Error(`Unsupported platform provider: ${name}.`);
  }
  return plugin;
}
