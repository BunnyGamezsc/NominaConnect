import test from "node:test";
import assert from "node:assert/strict";

import { INITIAL_PLATFORM_CATALOG } from "../src/catalog.js";
import { getPlatformProvider } from "../src/providers.js";
import {
  createConformanceEnvironment,
  contextFor,
  managedItemFor,
  PROVIDER_LAYOUT,
  EXPOSED_HOSTNAME,
  ZONE
} from "./fixtures/provider-environments.js";

// ---------------------------------------------------------------------------
// The adapter conformance suite (issue #21).
//
// Every provider in the initial platform catalog is driven through the same
// plugin contract against the *production* adapter set — the composition the
// installed CLI wires on a Proxmox host — rather than through a fake that only
// implements the contract's shape. A provider cannot appear in the catalog
// with partial real behaviour and still pass this file.
//
// The existing fast fake-adapter tests stay where they are: this suite is
// added alongside them as the common highest seam, not as a replacement.
// ---------------------------------------------------------------------------

const CONFORMANCE = Object.freeze([
  {
    name: "technitium",
    // Only the published record is managed. The zone's own SOA and the record
    // an operator created by hand are both unmanaged configuration.
    managedReferences: [EXPOSED_HOSTNAME],
    managedId: EXPOSED_HOSTNAME,
    unmanagedId: `legacy.${ZONE}`,
    installs: "/tmp/technitium-install.sh",
    upgrades: "/tmp/technitium-install.sh"
  },
  {
    name: "caddy",
    managedReferences: [EXPOSED_HOSTNAME],
    managedId: EXPOSED_HOSTNAME,
    unmanagedId: `existing.${ZONE}`,
    installs: "caddy",
    upgrades: "--only-upgrade"
  },
  {
    name: "traefik",
    managedReferences: [EXPOSED_HOSTNAME],
    managedId: EXPOSED_HOSTNAME,
    unmanagedId: `nas.${ZONE}`,
    installs: "traefik",
    upgrades: "traefik"
  },
  {
    name: "step-ca",
    managedReferences: ["admin"],
    managedId: "admin",
    unmanagedId: "acme",
    installs: "step-ca",
    upgrades: "--only-upgrade"
  },
  {
    // The Caddy Internal CA is a mode of the Caddy adapter, not an independent
    // service: it shares Caddy's LXC and its control plane.
    name: "caddy-internal-ca",
    managedReferences: [EXPOSED_HOSTNAME],
    managedId: EXPOSED_HOSTNAME,
    unmanagedId: `existing.${ZONE}`,
    installs: "trust",
    upgrades: "--only-upgrade"
  },
  {
    name: "tailscale",
    managedReferences: ["nodeSELF01"],
    managedId: "nodeSELF01",
    unmanagedId: "peerFRIEND1",
    installs: "tailscale",
    upgrades: "--only-upgrade"
  },
  {
    name: "netbird",
    managedReferences: ["gL5xQ3nJmVh0Nk1sVBrqPcJvV6yQ4dQ0oXxk8dR3vBc="],
    managedId: "gL5xQ3nJmVh0Nk1sVBrqPcJvV6yQ4dQ0oXxk8dR3vBc=",
    unmanagedId: "peerLAPTOPr8mQd1sVBrqPcJvV6yQ4dQ0oXxk8dR3vBc=",
    installs: "netbird",
    upgrades: "--only-upgrade"
  }
]);

function conformanceCase(contract) {
  const environment = createConformanceEnvironment();
  environment.useNetBirdCredential();
  return {
    environment,
    provider: environment.providers[contract.name],
    adapter: environment.providerAdapters[contract.name],
    plugin: getPlatformProvider(contract.name),
    managedItem: managedItemFor(contract.name),
    context: contextFor(contract.name, { providerReferences: contract.managedReferences })
  };
}

test("the conformance suite covers every provider in the initial platform catalog", () => {
  const catalogNames = Object.values(INITIAL_PLATFORM_CATALOG).flat().map((option) => option.name);
  assert.deepEqual(
    [...catalogNames].sort(),
    CONFORMANCE.map((contract) => contract.name).sort(),
    "a provider added to the catalog must also be added to the conformance suite"
  );
});

for (const contract of CONFORMANCE) {
  test(`${contract.name} sets up through fixed commands that never carry a NominaConnect ID`, async () => {
    const { plugin, adapter, managedItem, context, environment } = conformanceCase(contract);

    const plan = await plugin.setup(adapter, managedItem, context);

    assert.ok(Array.isArray(plan.lxcCommands) && plan.lxcCommands.length > 0, "setup must produce install commands");
    for (const command of plan.lxcCommands) {
      assert.equal(typeof command.binary, "string");
      assert.ok(command.binary.startsWith("/"), "commands run a fixed binary by absolute path");
      assert.ok(Array.isArray(command.args), "commands use an argument array, not shell interpolation");
      assert.ok(command.args.every((argument) => typeof argument === "string"));
    }
    assert.ok(
      JSON.stringify(plan.lxcCommands).includes(contract.installs),
      `${contract.name} install commands should install ${contract.installs}`
    );

    // ADR-0003: a NominaConnect ID lives in local state, never in provider
    // configuration or in anything sent to a provider.
    const sent = JSON.stringify({ commands: environment.hostCommands, requests: environment.httpRequests });
    assert.doesNotMatch(sent, /nc_[a-z0-9_-]*test/i, "no NominaConnect ID may reach a provider");
  });

  test(`${contract.name} inspection separates managed from unmanaged and changes nothing`, async () => {
    const { plugin, adapter, managedItem, context, provider } = conformanceCase(contract);

    const observed = await plugin.inspect(adapter, managedItem, context);

    assert.deepEqual(
      observed.managed.map((resource) => resource.id),
      [contract.managedId],
      "inspection reports exactly the managed resource"
    );
    assert.ok(
      observed.unmanaged.some((resource) => resource.id === contract.unmanagedId),
      "inspection reports the operator's own resource as unmanaged"
    );
    assert.ok(provider.preservedUnmanaged(), "inspection is read-only");
  });

  test(`${contract.name} adoption records a provider-native locator and fingerprint`, async () => {
    const { plugin, adapter, managedItem, context, provider } = conformanceCase(contract);

    const observed = await plugin.inspect(adapter, managedItem, context);
    const adopted = await plugin.adopt(adapter, managedItem, observed, context);

    assert.equal(adopted.managedInventoryUpdate.length, 1);
    const [resource] = adopted.managedInventoryUpdate;
    assert.equal(resource.id, contract.managedId);
    assert.equal(typeof resource.locator, "object", "adoption records a provider-native locator");
    assert.equal(typeof resource.fingerprint, "string", "adoption records a structural fingerprint");
    assert.equal(adopted.warnings ?? undefined, undefined);
    assert.ok(provider.preservedUnmanaged(), "adoption writes NominaConnect state, not provider configuration");
  });

  test(`${contract.name} adoption refuses an ambiguous match instead of guessing`, async () => {
    const { plugin, adapter, managedItem, context, provider } = conformanceCase(contract);

    provider.duplicate();
    const observed = await plugin.inspect(adapter, managedItem, context);
    assert.ok(observed.managed.length > 1, "the provider now reports more than one candidate");

    const adopted = await plugin.adopt(adapter, managedItem, observed, context);

    assert.deepEqual(adopted.managedInventoryUpdate, []);
    assert.equal(adopted.warnings.length, 1);
    assert.match(adopted.warnings[0], /ambiguous/i);
  });

  test(`${contract.name} reports a provider-side change as a new fingerprint`, async () => {
    const { plugin, adapter, managedItem, context, provider } = conformanceCase(contract);

    const before = await plugin.inspect(adapter, managedItem, context);
    provider.drift();
    const after = await plugin.inspect(adapter, managedItem, context);

    assert.notEqual(
      after.managed[0].fingerprint,
      before.managed[0].fingerprint,
      "a direct provider edit must move the structural fingerprint"
    );
  });

  test(`${contract.name} health reflects the running provider, not a successful install`, async () => {
    const healthy = conformanceCase(contract);
    assert.equal(
      (await healthy.plugin.healthCheck(healthy.adapter, healthy.managedItem, healthy.context)).status,
      "healthy"
    );

    const stopped = conformanceCase(contract);
    stopped.provider.stop();
    const health = await stopped.plugin.healthCheck(stopped.adapter, stopped.managedItem, stopped.context);
    assert.equal(health.status, "unhealthy", "a provider that is down is never reported healthy");
  });

  test(`${contract.name} changes live software only on an explicit upgrade`, async () => {
    const { plugin, adapter, managedItem, context, environment } = conformanceCase(contract);

    await plugin.inspect(adapter, managedItem, context);
    await plugin.healthCheck(adapter, managedItem, context);
    const observed = await plugin.inspect(adapter, managedItem, context);
    await plugin.adopt(adapter, managedItem, observed, context);

    // ADR-0034: nothing short of `nomina service upgrade` may install software.
    const beforeUpgrade = JSON.stringify(environment.hostCommands);
    assert.doesNotMatch(beforeUpgrade, /--only-upgrade|install/, "inspection and adoption never install anything");

    const plan = await plugin.upgrade(adapter, managedItem, context);
    assert.ok(
      JSON.stringify(plan.lxcCommands).includes(contract.upgrades),
      `${contract.name} upgrade should run ${contract.upgrades}`
    );
  });

  test(`${contract.name} treats a missing managed resource as a verification warning, not a rewrite`, async () => {
    const { plugin, adapter, managedItem, context, provider } = conformanceCase(contract);

    provider.removeManaged();
    const observed = await plugin.inspect(adapter, managedItem, context);

    assert.deepEqual(observed.managed, [], "the managed resource is gone");
    const adopted = await plugin.adopt(adapter, managedItem, observed, context);
    assert.deepEqual(adopted.managedInventoryUpdate, [], "nothing is adopted from an empty match");
    assert.ok(provider.preservedUnmanaged(), "unmanaged configuration is preserved throughout");
  });

  test(`${contract.name} inspection of an offline provider never reports a managed resource`, async () => {
    const { plugin, adapter, managedItem, context } = conformanceCase(contract);
    const layout = PROVIDER_LAYOUT[contract.name];
    assert.equal(context.ip, layout.ip);

    const offline = conformanceCase(contract);
    offline.provider.stop();

    let observed;
    try {
      observed = await offline.plugin.inspect(offline.adapter, offline.managedItem, offline.context);
    } catch (error) {
      assert.ok(error instanceof Error, "an unreachable provider fails loudly");
      return;
    }
    assert.deepEqual(observed.managed, [], "an unreachable provider reports nothing rather than a stale answer");
  });
}
