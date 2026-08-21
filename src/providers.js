function createProviderPlugin({ name, operations, upgradeOperations = [`upgrade-${name}`], exposureProtocol = undefined }) {
  return Object.freeze({
    name,
    async setup(adapter, managedItem, context = {}) {
      return await adapter.setup({
        provider: name,
        managedItemId: managedItem.id,
        operations,
        ...(context.connectionSecretReference === undefined ? {} : { connectionSecretReference: context.connectionSecretReference }),
        ...(exposureProtocol === undefined ? {} : { exposureProtocol })
      });
    },
    async upgrade(adapter, managedItem, context = {}) {
      if (adapter?.upgrade) {
        return await adapter.upgrade({
          provider: name,
          managedItemId: managedItem.id,
          operations: upgradeOperations,
          ...(context.connectionSecretReference === undefined ? {} : { connectionSecretReference: context.connectionSecretReference })
        });
      }
      return {
        provider: name,
        managedItemId: managedItem.id,
        operations: upgradeOperations,
        lxcCommands: upgradeOperations
      };
    },
    async inspect(adapter, managedItem, { providerReferences = [], connectionSecretReference } = {}) {
      const observed = await adapter.inspect({
        provider: name,
        managedItemId: managedItem.id,
        ...(connectionSecretReference === undefined ? {} : { connectionSecretReference })
      });
      const managedIds = new Set(providerReferences);
      const resources = observed.resources ?? [];
      return {
        provider: name,
        managedItemId: managedItem.id,
        managed: resources.filter((resource) => managedIds.has(resource.id)),
        unmanaged: resources.filter((resource) => !managedIds.has(resource.id)),
        ...(observed.deployment !== undefined ? { deployment: observed.deployment } : {}),
        ...(observed.configuration !== undefined ? { configuration: observed.configuration } : {}),
        ...(observed.availableUpgrade !== undefined ? { availableUpgrade: observed.availableUpgrade } : {})
      };
    },
    async adopt(adapter, managedItem, observedConfiguration, context = {}) {
      return await adapter.adopt({
        provider: name,
        managedItemId: managedItem.id,
        managed: observedConfiguration.managed,
        ...(context.connectionSecretReference === undefined ? {} : { connectionSecretReference: context.connectionSecretReference })
      });
    },
    async healthCheck(adapter, managedItem, context = {}) {
      const observed = await adapter.healthCheck({
        provider: name,
        managedItemId: managedItem.id,
        ...(context.connectionSecretReference === undefined ? {} : { connectionSecretReference: context.connectionSecretReference })
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
