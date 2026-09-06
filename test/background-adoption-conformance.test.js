import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";
import { runTrackingJob } from "../src/tracking.js";
import { getPlatformProvider } from "../src/providers.js";
import {
  resolveProviderResource,
  locatorMatches,
  providerIdentityDrifted,
  applyProviderReferenceChange
} from "../src/adoption.js";
import {
  createConformanceEnvironment,
  contextFor,
  managedItemFor,
  PROVIDER_LAYOUT,
  EXPOSED_HOSTNAME,
  BACKEND,
  ZONE
} from "./fixtures/provider-environments.js";

// ---------------------------------------------------------------------------
// Background provider-precedence adoption (issue #22).
//
// `nomina service recheck` has always adopted a provider-native identity in
// the foreground. These tests hold background tracking to the same standard:
// a peer renamed in the Tailscale console, a route rewritten in Caddy, a
// record edited in Technitium is observed, adopted through the same real
// adapter the foreground uses, persisted under the write queue, and reported
// on the next CLI command — or refused with a verification warning when the
// match is not safe.
// ---------------------------------------------------------------------------

const PROJECT_DIR = "/projects/bunnyhome";

class FakeFilesystem {
  files = new Map();
  directories = new Set();
  modes = new Map();

  exists(path) { return this.files.has(path) || this.directories.has(path); }
  mkdir(path) { this.directories.add(path); }
  writeFile(path, content) { this.files.set(path, content); }
  rename(from, to) { this.files.set(to, this.files.get(from)); this.files.delete(from); }
  chmod(path, mode) { this.modes.set(path, mode); }
  read(path) { return this.files.get(path); }
}

const proxmoxRootRuntime = () => ({ isRoot: () => true, isProxmoxHost: () => true });

/** @param {{ proxy: string, vpn?: string }} selection */
function projectYaml({ proxy, vpn }) {
  const vpnBlock = vpn === undefined
    ? "    vpn: null"
    : `    vpn:
      id: ${PROVIDER_LAYOUT[vpn].managedItemId}
      service: ${vpn}
      deployment:
        ip: ${PROVIDER_LAYOUT[vpn].ip}
        hostname: ${vpn}`;
  return `apiVersion: nomina.connect/v0alpha1
kind: NominaConnect
proxmox:
  node: pve-1
  defaultBridge: vmbr0
  defaultStorage: local-lvm
baseLocalDomain: ${ZONE}
managedInventory:
  platform:
    dns:
      id: ${PROVIDER_LAYOUT.technitium.managedItemId}
      service: technitium
      deployment:
        ip: ${PROVIDER_LAYOUT.technitium.ip}
        hostname: technitium
    reverseProxy:
      id: ${PROVIDER_LAYOUT[proxy].managedItemId}
      service: ${proxy}
      deployment:
        ip: ${PROVIDER_LAYOUT[proxy].ip}
        hostname: ${proxy}
    certificateAuthority: null
${vpnBlock}
  services:
    - id: nc_service_photos
      name: photos
      exposure:
        hostname: ${EXPOSED_HOSTNAME}
        backend:
          ip: ${BACKEND.ip}
          port: ${BACKEND.port}
        protocol: https
        certificateAuthority: none
connectionSecretReferences:
  ${PROVIDER_LAYOUT.technitium.managedItemId}: nominaconnect/provider/${PROVIDER_LAYOUT.technitium.managedItemId}
  ${PROVIDER_LAYOUT[proxy].managedItemId}: nominaconnect/provider/${PROVIDER_LAYOUT[proxy].managedItemId}
${vpn === undefined ? "" : `  ${PROVIDER_LAYOUT[vpn].managedItemId}: nominaconnect/provider/${PROVIDER_LAYOUT[vpn].managedItemId}\n`}`;
}

// Records the provider references NominaConnect would have written when the
// platform was provisioned and the exposure published, so a later pass has a
// baseline to compare a direct provider edit against.
/**
 * @param {any} environment
 * @param {{ proxy: string, vpn?: string, withExposureIdentities?: boolean }} selection
 */
async function baselineState(environment, { proxy, vpn, withExposureIdentities = true }) {
  /** @type {Record<string, any>} */
  const providerReferences = {
    [PROVIDER_LAYOUT.technitium.managedItemId]: {
      vmid: PROVIDER_LAYOUT.technitium.vmid,
      ip: PROVIDER_LAYOUT.technitium.ip
    },
    [PROVIDER_LAYOUT[proxy].managedItemId]: {
      vmid: PROVIDER_LAYOUT[proxy].vmid,
      ip: PROVIDER_LAYOUT[proxy].ip
    }
  };

  if (vpn !== undefined) {
    const identity = await selfIdentity(environment, vpn);
    providerReferences[PROVIDER_LAYOUT[vpn].managedItemId] = {
      vmid: PROVIDER_LAYOUT[vpn].vmid,
      ip: PROVIDER_LAYOUT[vpn].ip,
      ...identity
    };
  }

  if (withExposureIdentities) {
    providerReferences.nc_service_photos = {
      dns: EXPOSED_HOSTNAME,
      reverseProxy: EXPOSED_HOSTNAME,
      integrations: {
        dns: await exposureIdentityOf(environment, "technitium", [ZONE, EXPOSED_HOSTNAME]),
        reverseProxy: await exposureIdentityOf(environment, proxy, [EXPOSED_HOSTNAME])
      }
    };
  }

  return { version: 1, providerReferences, tracking: { notices: [] } };
}

async function selfIdentity(environment, provider) {
  const observed = await getPlatformProvider(provider).inspect(
    environment.providerAdapters[provider],
    managedItemFor(provider),
    contextFor(provider, { providerReferences: [] })
  );
  const self = [...observed.managed, ...observed.unmanaged].find((resource) => resource.self === true);
  return { locator: self.locator, fingerprint: self.fingerprint };
}

async function exposureIdentityOf(environment, provider, providerReferences) {
  const observed = await getPlatformProvider(provider).inspect(
    environment.providerAdapters[provider],
    managedItemFor(provider),
    contextFor(provider, { providerReferences })
  );
  const match = observed.managed.find((resource) => resource.id === EXPOSED_HOSTNAME);
  return { locator: match.locator, fingerprint: match.fingerprint };
}

/**
 * @param {any} environment
 * @param {{ proxy: string, vpn?: string, withExposureIdentities?: boolean }} selection
 */
async function seedProject(environment, selection) {
  const { proxy, vpn, withExposureIdentities = true } = selection;
  const filesystem = new FakeFilesystem();
  filesystem.mkdir(PROJECT_DIR);
  filesystem.mkdir(`${PROJECT_DIR}/.nomina`);
  filesystem.writeFile(`${PROJECT_DIR}/nomina.yaml`, projectYaml({ proxy, vpn }));
  const state = await baselineState(environment, { proxy, vpn, withExposureIdentities });
  filesystem.writeFile(`${PROJECT_DIR}/.nomina/state.json`, `${JSON.stringify(state, null, 2)}\n`);
  return filesystem;
}

function readState(filesystem) {
  return JSON.parse(filesystem.read(`${PROJECT_DIR}/.nomina/state.json`));
}

function track(filesystem, environment) {
  return runTrackingJob({
    filesystem,
    projectDir: PROJECT_DIR,
    providerAdapters: environment.providerAdapters,
    retryOptions: { maxRetries: 2, baseDelayMs: 0, sleep: async () => {} }
  });
}

// ---------------------------------------------------------------------------
// The matching rule that decides whether an adoption is safe at all
// ---------------------------------------------------------------------------

test("a locator matches exactly, or on a provider-native id that survived a rename", () => {
  const record = { zone: ZONE, name: EXPOSED_HOSTNAME, type: "A" };
  assert.equal(locatorMatches({ ...record }, record), true);
  assert.equal(locatorMatches({ ...record, type: "CNAME" }, record), false);
  assert.equal(
    locatorMatches({ id: "nodeSELF01", hostname: "vpn-gateway" }, { id: "nodeSELF01", hostname: "tailscale" }),
    true,
    "a renamed node keeps its provider-native id"
  );
  assert.equal(locatorMatches({ id: "nodeOTHER" }, { id: "nodeSELF01" }), false);
});

test("resolution prefers the stored locator, then a self-identified resource, then the managed id", () => {
  const stored = { id: "nodeSELF01" };
  const resources = [
    { id: "nodeSELF01", locator: { id: "nodeSELF01" }, self: true },
    { id: "peerFRIEND1", locator: { id: "peerFRIEND1" } }
  ];
  assert.equal(resolveProviderResource(resources, { locator: stored }).via, "locator");
  assert.equal(resolveProviderResource(resources, {}).via, "self");
  assert.equal(resolveProviderResource([resources[1]], { id: "peerFRIEND1" }).via, "id");
  assert.equal(resolveProviderResource([], { id: "peerFRIEND1" }).status, "missing");
  assert.equal(
    resolveProviderResource([resources[0], { ...resources[0] }], { locator: stored }).status,
    "ambiguous"
  );
});

test("drift is a locator or fingerprint that moved, and nothing else", () => {
  const stored = { locator: { id: "a" }, fingerprint: "one" };
  assert.equal(providerIdentityDrifted({ locator: { id: "a" }, fingerprint: "one" }, stored), false);
  assert.equal(providerIdentityDrifted({ locator: { id: "a" }, fingerprint: "two" }, stored), true);
  assert.equal(providerIdentityDrifted({ locator: { id: "b" }, fingerprint: "one" }, stored), true);
  assert.equal(providerIdentityDrifted(undefined, stored), false);
});

test("an adopted provider reference is merged into local state without disturbing the LXC record", () => {
  const references = { nc_vpn_test: { vmid: 124, ip: "10.0.0.57", locator: { id: "old" }, fingerprint: "one" } };
  const merged = applyProviderReferenceChange(references, {
    managedItemId: "nc_vpn_test",
    after: { locator: { id: "old", hostname: "vpn-gateway" }, fingerprint: "two" }
  });
  assert.equal(merged.nc_vpn_test.vmid, 124);
  assert.equal(merged.nc_vpn_test.ip, "10.0.0.57");
  assert.equal(merged.nc_vpn_test.fingerprint, "two");
  assert.equal(merged.nc_vpn_test.locator.hostname, "vpn-gateway");
});

// ---------------------------------------------------------------------------
// VPN platform services: a peer renamed in the provider's own console
// ---------------------------------------------------------------------------

for (const vpn of ["tailscale", "netbird"]) {
  test(`background tracking adopts a ${vpn} peer renamed in its own console`, async () => {
    const environment = createConformanceEnvironment();
    environment.useNetBirdCredential();
    const filesystem = await seedProject(environment, { proxy: "caddy", vpn });
    const before = readState(filesystem).providerReferences[PROVIDER_LAYOUT[vpn].managedItemId];

    environment.providers[vpn].drift();
    const result = await track(filesystem, environment);

    const adopted = result.changes.find(
      (change) => change.kind === "provider-reference-changed" && change.serviceName === vpn
    );
    assert.ok(adopted !== undefined, "the renamed peer is adopted");
    assert.equal(adopted.verified, true, "adoption is verified by the service health check");

    const after = readState(filesystem).providerReferences[PROVIDER_LAYOUT[vpn].managedItemId];
    assert.equal(after.locator.id, before.locator.id, "the provider-native id is stable across a rename");
    assert.notEqual(after.fingerprint, before.fingerprint, "the new provider state is persisted");
    assert.equal(after.vmid, PROVIDER_LAYOUT[vpn].vmid, "the LXC reference is left intact");
    assert.match(
      JSON.stringify(after),
      vpn === "tailscale" ? /vpn-gateway\.tail1a2b/ : /vpn-gateway\.netbird\.cloud/,
      "the provider's own value wins (provider precedence)"
    );
    assert.ok(environment.providers[vpn].preservedUnmanaged(), "other peers are never touched");
  });

  test(`background tracking warns instead of adopting an ambiguous ${vpn} peer`, async () => {
    const environment = createConformanceEnvironment();
    environment.useNetBirdCredential();
    const filesystem = await seedProject(environment, { proxy: "caddy", vpn });
    const before = readState(filesystem).providerReferences[PROVIDER_LAYOUT[vpn].managedItemId];

    environment.providers[vpn].duplicate();
    environment.providers[vpn].drift();
    const result = await track(filesystem, environment);

    assert.ok(
      result.warnings.some((warning) => /matched 2 provider resources/i.test(warning.message)),
      `expected an ambiguity warning, got ${JSON.stringify(result.warnings)}`
    );
    assert.deepEqual(
      readState(filesystem).providerReferences[PROVIDER_LAYOUT[vpn].managedItemId],
      before,
      "an ambiguous match leaves the stored provider reference alone"
    );
  });

  test(`background tracking warns when the managed ${vpn} peer is gone`, async () => {
    const environment = createConformanceEnvironment();
    environment.useNetBirdCredential();
    const filesystem = await seedProject(environment, { proxy: "caddy", vpn });

    environment.providers[vpn].removeManaged();
    const result = await track(filesystem, environment);

    assert.ok(
      result.warnings.some((warning) => /no longer has a matching resource/i.test(warning.message)),
      `expected a missing-resource warning, got ${JSON.stringify(result.warnings)}`
    );
  });
}

// ---------------------------------------------------------------------------
// Exposures: routes and records edited directly in the provider
// ---------------------------------------------------------------------------

for (const proxy of ["caddy", "traefik"]) {
  test(`background tracking adopts a ${proxy} route rewritten directly in the provider`, async () => {
    const environment = createConformanceEnvironment();
    const filesystem = await seedProject(environment, { proxy });
    const before = readState(filesystem).providerReferences.nc_service_photos.integrations.reverseProxy;

    environment.providers[proxy].drift();
    const result = await track(filesystem, environment);

    const adopted = result.changes.find(
      (change) => change.kind === "provider-reference-changed" && change.integration === "reverseProxy"
    );
    assert.ok(adopted !== undefined, "the rewritten route is adopted");
    assert.equal(adopted.serviceId, "nc_service_photos");

    const after = readState(filesystem).providerReferences.nc_service_photos;
    assert.notEqual(after.integrations.reverseProxy.fingerprint, before.fingerprint);
    assert.equal(after.reverseProxy, EXPOSED_HOSTNAME, "the hostname reference publish stored is kept");

    // Provider precedence: the observed backend is also adopted into the
    // managed inventory, so nomina.yaml stops disagreeing with the proxy.
    assert.match(filesystem.read(`${PROJECT_DIR}/nomina.yaml`), /10\.0\.0\.90/);
    assert.ok(environment.providers[proxy].preservedUnmanaged(), "unrelated routes are untouched");
  });

  test(`background tracking warns when ${proxy} no longer serves the managed route`, async () => {
    const environment = createConformanceEnvironment();
    const filesystem = await seedProject(environment, { proxy });

    environment.providers[proxy].removeManaged();
    const result = await track(filesystem, environment);

    assert.ok(
      result.warnings.some((warning) => /no longer serves a route for/i.test(warning.message)),
      `expected a missing-route warning, got ${JSON.stringify(result.warnings)}`
    );
    assert.ok(environment.providers[proxy].preservedUnmanaged());
  });

  test(`background tracking refuses an ambiguous ${proxy} route`, async () => {
    const environment = createConformanceEnvironment();
    const filesystem = await seedProject(environment, { proxy });
    const before = readState(filesystem).providerReferences.nc_service_photos.integrations.reverseProxy;

    environment.providers[proxy].duplicate();
    const result = await track(filesystem, environment);

    assert.ok(
      result.warnings.some((warning) => /ambiguous/i.test(warning.message)),
      `expected an ambiguity warning, got ${JSON.stringify(result.warnings)}`
    );
    assert.deepEqual(
      readState(filesystem).providerReferences.nc_service_photos.integrations.reverseProxy,
      before
    );
  });

  test(`background tracking still warns about a missing DNS record when the ${proxy} route is ambiguous`, async () => {
    const environment = createConformanceEnvironment();
    const filesystem = await seedProject(environment, { proxy });

    environment.providers[proxy].duplicate();
    environment.providers.technitium.removeManaged();
    const result = await track(filesystem, environment);

    assert.ok(
      result.warnings.some((warning) => /ambiguous/i.test(warning.message)),
      `expected an ambiguity warning, got ${JSON.stringify(result.warnings)}`
    );
    assert.ok(
      result.warnings.some((warning) => /DNS record for .* no longer has a matching resource/i.test(warning.message)),
      `expected a missing-record warning, got ${JSON.stringify(result.warnings)}`
    );
  });
}

test("background tracking adopts a managed Technitium record edited in the provider", async () => {
  const environment = createConformanceEnvironment();
  const filesystem = await seedProject(environment, { proxy: "caddy" });
  const before = readState(filesystem).providerReferences.nc_service_photos.integrations.dns;

  environment.providers.technitium.drift();
  const result = await track(filesystem, environment);

  const adopted = result.changes.find(
    (change) => change.kind === "provider-reference-changed" && change.integration === "dns"
  );
  assert.ok(adopted !== undefined, "the edited record is adopted");
  assert.deepEqual(adopted.after.locator, before.locator, "the record's locator still resolves it");
  assert.notEqual(adopted.after.fingerprint, before.fingerprint);

  const after = readState(filesystem).providerReferences.nc_service_photos.integrations.dns;
  assert.equal(after.fingerprint, adopted.after.fingerprint);
  assert.ok(environment.providers.technitium.preservedUnmanaged(), "the operator's own record is preserved");
});

test("background tracking warns when a managed Technitium record has been deleted", async () => {
  const environment = createConformanceEnvironment();
  const filesystem = await seedProject(environment, { proxy: "caddy" });

  environment.providers.technitium.removeManaged();
  const result = await track(filesystem, environment);

  assert.ok(
    result.warnings.some((warning) => /DNS record for .* no longer has a matching resource/i.test(warning.message)),
    `expected a missing-record warning, got ${JSON.stringify(result.warnings)}`
  );
});

test("background tracking refuses a Technitium record that matches two managed candidates", async () => {
  const environment = createConformanceEnvironment();
  const filesystem = await seedProject(environment, { proxy: "caddy" });
  const before = readState(filesystem).providerReferences.nc_service_photos.integrations.dns;

  environment.providers.technitium.duplicate();
  const result = await track(filesystem, environment);

  assert.ok(
    result.warnings.some((warning) => /ambiguous|matched 2 provider resources/i.test(warning.message)),
    `expected an ambiguity warning, got ${JSON.stringify(result.warnings)}`
  );
  assert.deepEqual(readState(filesystem).providerReferences.nc_service_photos.integrations.dns, before);
});

test("a project published before provider references carried a locator records one on its next pass", async () => {
  const environment = createConformanceEnvironment();
  const filesystem = await seedProject(environment, { proxy: "caddy", withExposureIdentities: false });

  await track(filesystem, environment);

  const integrations = readState(filesystem).providerReferences.nc_service_photos.integrations;
  assert.equal(integrations.dns.locator.name, EXPOSED_HOSTNAME);
  assert.equal(integrations.reverseProxy.locator.host, EXPOSED_HOSTNAME);
});

// ---------------------------------------------------------------------------
// The rest of the tracking contract, now running on real adapters
// ---------------------------------------------------------------------------

test("background tracking retries a transient provider failure with bounded backoff", async () => {
  const environment = createConformanceEnvironment();
  const filesystem = await seedProject(environment, { proxy: "caddy", vpn: "tailscale" });

  // Technitium is briefly unavailable and recovers on the third attempt, the
  // way a provider does while its LXC is still coming up.
  const technitium = environment.providers.technitium;
  const realRequest = technitium.request.bind(technitium);
  let attempts = 0;
  technitium.request = (request) => {
    attempts += 1;
    if (attempts <= 2) {
      const error = /** @type {Error & { unreachable?: boolean }} */ (new Error("connection refused"));
      error.name = "HttpRequestError";
      error.unreachable = true;
      throw error;
    }
    return realRequest(request);
  };

  const delays = [];
  const result = await runTrackingJob({
    filesystem,
    projectDir: PROJECT_DIR,
    providerAdapters: environment.providerAdapters,
    retryOptions: { maxRetries: 3, baseDelayMs: 10, backoffFactor: 2, sleep: async (ms) => { delays.push(ms); } }
  });

  assert.ok(attempts > 2, "the failed inspection was retried");
  assert.deepEqual(delays.slice(0, 2), [10, 20], "the retry backoff is bounded and increasing");
  assert.equal(
    result.warnings.some((warning) => /Failed to inspect technitium/.test(warning.message)),
    false,
    "a provider that recovered inside the retry budget is not a warning"
  );
});

test("a provider that stays down becomes a verification warning, not a failed command", async () => {
  const environment = createConformanceEnvironment();
  const filesystem = await seedProject(environment, { proxy: "caddy" });
  environment.providers.caddy.stop();

  const result = await track(filesystem, environment);

  assert.ok(result.warnings.length > 0, "an unreachable provider is reported");
  assert.ok(
    result.warnings.some((warning) => /caddy/i.test(`${warning.serviceName} ${warning.message}`)),
    `expected a Caddy warning, got ${JSON.stringify(result.warnings)}`
  );
});

test("adopted provider references are reported on the next CLI command", async () => {
  const environment = createConformanceEnvironment();
  environment.useNetBirdCredential();
  const filesystem = await seedProject(environment, { proxy: "caddy", vpn: "tailscale" });

  environment.providers.tailscale.drift();
  environment.providers.caddy.drift();
  await track(filesystem, environment);

  const changes = await runCli(["changes", "--project-dir", PROJECT_DIR], {
    filesystem,
    runtime: proxmoxRootRuntime(),
    providerAdapters: environment.providerAdapters
  });

  assert.match(changes.stdout, /tailscale/);
  assert.match(changes.stdout, /provider reference was adopted/i);
  assert.match(changes.stdout, /verified/);
  assert.equal(readState(filesystem).tracking.notices.length, 0, "reported notices are cleared");
});

test("a pass with nothing to adopt writes nothing and reports nothing", async () => {
  const environment = createConformanceEnvironment();
  environment.useNetBirdCredential();
  const filesystem = await seedProject(environment, { proxy: "caddy", vpn: "tailscale" });
  const before = filesystem.read(`${PROJECT_DIR}/.nomina/state.json`);

  const result = await track(filesystem, environment);

  assert.deepEqual(result.changes, [], `unexpected changes: ${JSON.stringify(result.changes)}`);
  assert.deepEqual(result.warnings, [], `unexpected warnings: ${JSON.stringify(result.warnings)}`);
  assert.equal(filesystem.read(`${PROJECT_DIR}/.nomina/state.json`), before, "a quiet pass is not a write");
});

test("a managed resource that drifted out of the managed reference set is reported, not claimed", async () => {
  const environment = createConformanceEnvironment();
  environment.useNetBirdCredential();
  const filesystem = await seedProject(environment, { proxy: "caddy", vpn: "tailscale" });

  // The stored locator names a node the tailnet no longer has, so nothing
  // matches it. The client's own node is still identifiable, but it now falls
  // outside the managed reference set the stored locator defines — adopting it
  // would claim a resource this project's reference set does not recognise.
  const state = readState(filesystem);
  state.providerReferences[PROVIDER_LAYOUT.tailscale.managedItemId].locator = {
    id: "nodeRETIRED",
    hostname: "retired"
  };
  filesystem.writeFile(`${PROJECT_DIR}/.nomina/state.json`, `${JSON.stringify(state, null, 2)}\n`);

  const result = await track(filesystem, environment);

  assert.ok(
    result.warnings.some((warning) => /reports as unmanaged/i.test(warning.message)),
    `expected an unmanaged-conflict warning, got ${JSON.stringify(result.warnings)}`
  );
  assert.deepEqual(
    readState(filesystem).providerReferences[PROVIDER_LAYOUT.tailscale.managedItemId].locator,
    { id: "nodeRETIRED", hostname: "retired" },
    "an unmanaged conflict leaves the stored provider reference alone"
  );
  assert.ok(environment.providers.tailscale.preservedUnmanaged());
});
