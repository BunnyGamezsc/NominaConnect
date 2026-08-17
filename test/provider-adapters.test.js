import test from "node:test";
import assert from "node:assert/strict";

import { INITIAL_PLATFORM_CATALOG } from "../src/catalog.js";
import { getPlatformProvider } from "../src/cli.js";

const PROVIDER_CONTRACTS = Object.freeze([
  {
    name: "technitium",
    operations: ["install-technitium", "configure-managed-zones"],
    unmanaged: { id: "legacy.home.test", record: "legacy.home.test A 10.0.0.9" },
    managed: { id: "photos.home.test", record: "photos.home.test A 10.0.0.10" }
  },
  {
    name: "caddy",
    operations: ["install-caddy", "configure-https-routes"],
    exposureProtocol: "https",
    unmanaged: { id: "existing.home.test", route: "https://existing.home.test" },
    managed: { id: "photos.home.test", route: "https://photos.home.test" }
  },
  {
    name: "traefik",
    operations: ["install-traefik", "configure-https-routes"],
    exposureProtocol: "https",
    unmanaged: { id: "existing.home.test", route: "https://existing.home.test" },
    managed: { id: "photos.home.test", route: "https://photos.home.test" }
  },
  {
    name: "step-ca",
    operations: ["install-step-ca", "configure-internal-pki"],
    unmanaged: { id: "existing-profile", profile: "legacy-internal" },
    managed: { id: "nomina-profile", profile: "nomina-internal" }
  },
  {
    name: "caddy-internal-ca",
    operations: ["configure-caddy-internal-ca"],
    unmanaged: { id: "existing-issuer", issuer: "legacy-caddy-pki" },
    managed: { id: "nomina-issuer", issuer: "nomina-caddy-pki" }
  },
  {
    name: "tailscale",
    operations: ["install-tailscale", "join-tailnet"],
    unmanaged: { id: "existing-peer", peer: "legacy-node" },
    managed: { id: "nomina-peer", peer: "nomina-node" }
  },
  {
    name: "netbird",
    operations: ["install-netbird", "join-netbird-network"],
    unmanaged: { id: "existing-peer", peer: "legacy-node" },
    managed: { id: "nomina-peer", peer: "nomina-node" }
  }
]);

function createFakeProviderAdapter({ resources = [], process = "running", endpoint = "reachable" } = {}) {
  return {
    resources: resources.map((resource) => ({ ...resource })),
    setup(plan) {
      return plan;
    },
    inspect() {
      return { resources: this.resources.map((resource) => ({ ...resource })) };
    },
    adopt(request) {
      if (request.writeResources !== undefined) {
        this.resources = request.writeResources.map((resource) => ({ ...resource }));
      }
      return { managedInventoryUpdate: request.managed };
    },
    healthCheck() {
      return { process, endpoint };
    }
  };
}

test("every selectable platform provider can set up, inspect, adopt, and health-check without touching unmanaged configuration", () => {
  const catalogNames = Object.values(INITIAL_PLATFORM_CATALOG).flat().map((option) => option.name);
  assert.deepEqual(catalogNames, PROVIDER_CONTRACTS.map((contract) => contract.name));

  for (const contract of PROVIDER_CONTRACTS) {
    const plugin = getPlatformProvider(contract.name);
    const managedItem = { id: "nc_managed", service: contract.name };
    const adapter = createFakeProviderAdapter({
      resources: [contract.unmanaged, contract.managed]
    });

    const setupPlan = plugin.setup(adapter, managedItem);
    assert.equal(setupPlan.provider, contract.name);
    assert.equal(setupPlan.managedItemId, "nc_managed");
    assert.deepEqual(setupPlan.operations, contract.operations);
    assert.equal(setupPlan.exposureProtocol, contract.exposureProtocol);

    const observed = plugin.inspect(adapter, managedItem, {
      providerReferences: [contract.managed.id]
    });
    assert.deepEqual(observed.managed, [contract.managed]);
    assert.deepEqual(observed.unmanaged, [contract.unmanaged]);
    assert.equal(JSON.stringify(adapter.resources).includes("nc_"), false);

    const adopted = plugin.adopt(adapter, managedItem, observed);
    assert.deepEqual(adopted.managedInventoryUpdate, [contract.managed]);
    assert.deepEqual(
      plugin.inspect(adapter, managedItem, { providerReferences: [contract.managed.id] }).unmanaged,
      [contract.unmanaged]
    );

    assert.deepEqual(plugin.healthCheck(adapter, managedItem), {
      provider: contract.name,
      managedItemId: "nc_managed",
      process: "running",
      endpoint: "reachable",
      status: "healthy"
    });
  }
});

test("provider health checks report unhealthy when the service process is down", () => {
  const adapter = createFakeProviderAdapter({ process: "stopped", endpoint: "unreachable" });
  const result = getPlatformProvider("technitium").healthCheck(adapter, {
    id: "nc_dns",
    service: "technitium"
  });

  assert.equal(result.status, "unhealthy");
  assert.equal(result.process, "stopped");
  assert.equal(result.endpoint, "unreachable");
});
