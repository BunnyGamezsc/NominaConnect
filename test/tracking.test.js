import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";
import {
  runTrackingJob,
  formatPendingNotices,
  formatChangesDetail,
  formatChangeSummary,
  clearPendingNotices
} from "../src/tracking.js";
import {
  collectPlatformServices,
  collectExposedServices,
  detectPlatformChanges,
  adoptPlatformDeployment,
  adoptServiceExposure,
  createAdoptedChange,
  withBoundedRetry,
  runAdoptionPass
} from "../src/adoption.js";
import {
  buildMenuOptions,
  canProvisionTechnitium,
  canProvisionCaddy,
  runInteractiveApp
} from "../src/tui.js";

const proxmoxRootRuntime = () => ({ isRoot: () => true, isProxmoxHost: () => true });

class FakeFilesystem {
  files = new Map();
  directories = new Set();
  modes = new Map();

  exists(path) {
    return this.files.has(path) || this.directories.has(path);
  }

  mkdir(path) {
    this.directories.add(path);
  }

  writeFile(path, content) {
    this.files.set(path, content);
  }

  rename(from, to) {
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
  }

  chmod(path, mode) {
    this.modes.set(path, mode);
  }

  read(path) {
    return this.files.get(path);
  }
}

function createProvisionedProjectYaml({
  proxyService = "caddy",
  proxyHostname = "caddy",
  caService = null,
  vpnService = null
} = {}) {
  const caBlock = caService === null
    ? "    certificateAuthority: null"
    : `    certificateAuthority:
      id: nc_ca_test
      service: ${caService}`;
  const vpnBlock = vpnService === null
    ? "    vpn: null"
    : `    vpn:
      id: nc_vpn_test
      service: ${vpnService}`;

  return `apiVersion: nomina.connect/v0alpha1
kind: NominaConnect
proxmox:
  node: pve-1
  defaultBridge: vmbr0
  defaultStorage: local-lvm
baseLocalDomain: bunnyhome.test
managedInventory:
  platform:
    dns:
      id: nc_dns_test
      service: technitium
      deployment:
        ip: 10.0.0.53
        hostname: technitium
    reverseProxy:
      id: nc_proxy_test
      service: ${proxyService}
      deployment:
        ip: 10.0.0.54
        hostname: ${proxyHostname}
${caBlock}
${vpnBlock}
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test
`;
}

function createProvisionedState(overrides = {}) {
  return {
    version: 1,
    providerReferences: {
      nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
      nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
      ...overrides
    },
    tracking: { notices: [] }
  };
}

function seedProvisionedProject(filesystem, projectDir = "/projects/bunnyhome", stateOverrides = {}) {
  filesystem.mkdir(projectDir);
  filesystem.mkdir(`${projectDir}/.nomina`);
  filesystem.writeFile(`${projectDir}/nomina.yaml`, createProvisionedProjectYaml());
  filesystem.writeFile(
    `${projectDir}/.nomina/state.json`,
    `${JSON.stringify(createProvisionedState(stateOverrides), null, 2)}\n`
  );
}

function createTechnitiumAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "bunnyhome.test", record: "bunnyhome.test NS localhost" }
    ],
    publishCalls: []
  };
  return {
    publishCalls: state.publishCalls,
    setup(plan) {
      return { ...plan, lxcCommands: ["install-technitium", "configure-managed-zones"] };
    },
    inspect() {
      return { resources: state.resources.map((r) => ({ ...r })) };
    },
    publishRecord(request) {
      state.publishCalls.push(request);
      state.resources = state.resources.filter((r) => r.id !== request.hostname);
      state.resources.push({ id: request.hostname, record: `${request.hostname} A ${request.ip}` });
    },
    healthCheck() {
      return overrides.health ?? { process: "running", endpoint: "reachable" };
    },
    healthCheckExposure() {
      return overrides.exposureHealth ?? { dns: "reachable", status: "healthy" };
    }
  };
}

function createCaddyAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "existing.bunnyhome.test", route: "https://existing.bunnyhome.test" }
    ],
    publishCalls: []
  };
  return {
    publishCalls: state.publishCalls,
    setup(plan) {
      return { ...plan, lxcCommands: ["install-caddy", "configure-https-routes"] };
    },
    inspect() {
      return {
        resources: state.resources.map((r) => ({ ...r })),
        ...(overrides.inspectResult ?? {})
      };
    },
    publishRoute(request) {
      state.publishCalls.push(request);
      state.resources = state.resources.filter((r) => r.id !== request.hostname);
      state.resources.push({
        id: request.hostname,
        route: `https://${request.hostname} -> ${request.backendIp}:${request.backendPort}`
      });
    },
    healthCheck() {
      return overrides.health ?? { process: "running", endpoint: "reachable" };
    },
    healthCheckExposure(request) {
      return overrides.exposureHealth?.(request) ?? { https: "reachable", status: "healthy" };
    }
  };
}

function createTraefikAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "existing.bunnyhome.test", route: "https://existing.bunnyhome.test" }
    ],
    publishCalls: []
  };
  return {
    publishCalls: state.publishCalls,
    setup(plan) {
      return { ...plan, lxcCommands: ["install-traefik", "configure-https-routes"] };
    },
    inspect() {
      return {
        resources: state.resources.map((r) => ({ ...r })),
        ...(overrides.inspectResult ?? {})
      };
    },
    publishRoute(request) {
      state.publishCalls.push(request);
      state.resources = state.resources.filter((r) => r.id !== request.hostname);
      state.resources.push({
        id: request.hostname,
        route: `https://${request.hostname} -> ${request.backendIp}:${request.backendPort}`
      });
    },
    healthCheck() {
      return overrides.health ?? { process: "running", endpoint: "reachable" };
    },
    healthCheckExposure(request) {
      return overrides.exposureHealth?.(request) ?? { https: "reachable", status: "healthy" };
    }
  };
}

function createStepCaAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "nomina-profile", profile: "nomina-internal" }
    ]
  };
  return {
    setup(plan) {
      return { ...plan, lxcCommands: ["install-step-ca", "configure-internal-pki"] };
    },
    inspect() {
      return {
        resources: state.resources.map((r) => ({ ...r })),
        ...(overrides.inspectResult ?? {})
      };
    },
    adopt(request) {
      return { managedInventoryUpdate: request.managed };
    },
    healthCheck() {
      return overrides.health ?? { process: "running", endpoint: "reachable" };
    }
  };
}

function createCaddyInternalCaAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "nomina-issuer", issuer: "nomina-caddy-pki" }
    ]
  };
  return {
    setup(plan) {
      return { ...plan, lxcCommands: ["configure-caddy-internal-ca"] };
    },
    inspect() {
      return {
        resources: state.resources.map((r) => ({ ...r })),
        ...(overrides.inspectResult ?? {})
      };
    },
    adopt(request) {
      return { managedInventoryUpdate: request.managed };
    },
    healthCheck() {
      return overrides.health ?? { process: "running", endpoint: "reachable" };
    }
  };
}

function createTailscaleAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "nomina-peer", peer: "nomina-node" }
    ]
  };
  return {
    setup(plan) {
      return { ...plan, lxcCommands: ["install-tailscale", "join-tailnet"] };
    },
    inspect() {
      return {
        resources: state.resources.map((r) => ({ ...r })),
        ...(overrides.inspectResult ?? {})
      };
    },
    adopt(request) {
      return { managedInventoryUpdate: request.managed };
    },
    healthCheck() {
      return overrides.health ?? { process: "running", endpoint: "reachable" };
    }
  };
}

function createNetBirdAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "nomina-peer", peer: "nomina-node" }
    ]
  };
  return {
    setup(plan) {
      return { ...plan, lxcCommands: ["install-netbird", "join-netbird-network"] };
    },
    inspect() {
      return {
        resources: state.resources.map((r) => ({ ...r })),
        ...(overrides.inspectResult ?? {})
      };
    },
    adopt(request) {
      return { managedInventoryUpdate: request.managed };
    },
    healthCheck() {
      return overrides.health ?? { process: "running", endpoint: "reachable" };
    }
  };
}

test("collectPlatformServices returns all non-null platform services", () => {
  const inventory = {
    platform: {
      dns: { id: "nc_dns", service: "technitium" },
      reverseProxy: { id: "nc_proxy", service: "caddy" },
      certificateAuthority: null,
      vpn: null
    }
  };
  const services = collectPlatformServices(inventory);
  assert.equal(services.length, 2);
  assert.equal(services[0].platformKey, "dns");
  assert.equal(services[1].platformKey, "reverseProxy");
});

test("detectPlatformChanges returns undefined when no changes observed", () => {
  const deployment = { ip: "10.0.0.53", hostname: "technitium" };
  const result = detectPlatformChanges({ deployment }, deployment);
  assert.equal(result, undefined);
});

test("detectPlatformChanges detects IP change", () => {
  const observed = { deployment: { ip: "10.0.0.99", hostname: "technitium" } };
  const current = { ip: "10.0.0.53", hostname: "technitium" };
  const result = detectPlatformChanges(observed, current);
  assert.equal(result.kind, "platform-changed");
  assert.equal(result.changes.ip, "10.0.0.99");
});

test("detectPlatformChanges detects hostname change", () => {
  const observed = { deployment: { ip: "10.0.0.53", hostname: "dns-new" } };
  const current = { ip: "10.0.0.53", hostname: "technitium" };
  const result = detectPlatformChanges(observed, current);
  assert.equal(result.kind, "platform-changed");
  assert.equal(result.changes.hostname, "dns-new");
});

test("detectPlatformChanges detects resource change", () => {
  const observed = {
    deployment: {
      ip: "10.0.0.53",
      hostname: "technitium",
      resources: { cpus: 4, memoryMb: 1024, diskGb: 8 }
    }
  };
  const current = {
    ip: "10.0.0.53",
    hostname: "technitium",
    resources: { cpus: 2, memoryMb: 1024, diskGb: 8 }
  };
  const result = detectPlatformChanges(observed, current);
  assert.equal(result.kind, "platform-changed");
  assert.equal(result.changes.resources.cpus, 4);
});

test("adoptPlatformDeployment updates the platform service deployment", () => {
  const config = {
    managedInventory: {
      platform: {
        dns: { id: "nc_dns", service: "technitium" }
      }
    }
  };
  const newDeployment = { ip: "10.0.0.99", hostname: "dns-new" };
  const updated = adoptPlatformDeployment(config, "dns", newDeployment);
  assert.deepEqual(updated.managedInventory.platform.dns.deployment, newDeployment);
});

test("adoptPlatformDeployment does not modify other platform services", () => {
  const config = {
    managedInventory: {
      platform: {
        dns: { id: "nc_dns", service: "technitium" },
        reverseProxy: { id: "nc_proxy", service: "caddy", deployment: { ip: "10.0.0.54" } }
      }
    }
  };
  const updated = adoptPlatformDeployment(config, "dns", { ip: "10.0.0.99" });
  assert.deepEqual(updated.managedInventory.platform.reverseProxy.deployment, { ip: "10.0.0.54" });
});

test("createAdoptedChange produces a valid change record", () => {
  const change = createAdoptedChange("technitium", "dns", { ip: "old" }, { ip: "new" }, "platform-changed");
  assert.equal(change.serviceName, "technitium");
  assert.equal(change.platformKey, "dns");
  assert.equal(change.kind, "platform-changed");
  assert.deepEqual(change.before, { ip: "old" });
  assert.deepEqual(change.after, { ip: "new" });
  assert.equal(change.verified, false);
  assert.ok(change.timestamp);
});

test("runAdoptionPass inspects all provisioned platform services", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);

  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium", deployment: { ip: "10.0.0.53", hostname: "technitium" } },
          reverseProxy: { id: "nc_proxy_test", service: "caddy", deployment: { ip: "10.0.0.54", hostname: "caddy" } },
          certificateAuthority: null,
          vpn: null
        },
        services: []
      },
      baseLocalDomain: "bunnyhome.test"
    },
    state: createProvisionedState()
  };

  const technitium = createTechnitiumAdapter();
  const caddy = createCaddyAdapter();

  const result = await runAdoptionPass({
    project,
    providerAdapters: { technitium, caddy }
  });

  assert.equal(result.changes.length, 0);
  assert.equal(result.warnings.length, 0);
});

test("runAdoptionPass produces verification warning when provider adapter is unavailable", async () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium" },
          reverseProxy: { id: "nc_proxy_test", service: "caddy" },
          certificateAuthority: null,
          vpn: null
        },
        services: []
      },
      baseLocalDomain: "bunnyhome.test"
    },
    state: createProvisionedState()
  };

  const result = await runAdoptionPass({
    project,
    providerAdapters: {}
  });

  assert.equal(result.changes.length, 0);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0].message, /unavailable for inspection/i);
});

test("runAdoptionPass produces verification warning when health check fails", async () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium", deployment: { ip: "10.0.0.53" } },
          reverseProxy: null,
          certificateAuthority: null,
          vpn: null
        },
        services: []
      },
      baseLocalDomain: "bunnyhome.test"
    },
    state: { version: 1, providerReferences: { nc_dns_test: { vmid: 120, ip: "10.0.0.53" } }, tracking: { notices: [] } }
  };

  const technitium = createTechnitiumAdapter({
    health: { process: "stopped", endpoint: "unreachable" }
  });

  const result = await runAdoptionPass({
    project,
    providerAdapters: { technitium }
  });

  assert.equal(result.changes.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /health check failed/i);
});

test("runAdoptionPass handles inspection errors gracefully", async () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium" },
          reverseProxy: null,
          certificateAuthority: null,
          vpn: null
        },
        services: []
      },
      baseLocalDomain: "bunnyhome.test"
    },
    state: { version: 1, providerReferences: { nc_dns_test: { vmid: 120, ip: "10.0.0.53" } }, tracking: { notices: [] } }
  };

  const technitium = {
    inspect() {
      throw new Error("provider unavailable");
    },
    healthCheck() {
      return { process: "running", endpoint: "reachable" };
    }
  };

  const result = await runAdoptionPass({
    project,
    providerAdapters: { technitium }
  });

  assert.equal(result.changes.length, 0);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /Failed to inspect/i);
});

test("runTrackingJob returns empty results when no project found", async () => {
  const filesystem = new FakeFilesystem();
  const result = await runTrackingJob({
    filesystem,
    projectDir: "/missing"
  });
  assert.equal(result.changes.length, 0);
  assert.equal(result.warnings.length, 0);
});

test("runTrackingJob records adoption changes in state notices", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);

  const technitium = createTechnitiumAdapter();
  const caddy = createCaddyAdapter();

  const result = await runTrackingJob({
    filesystem,
    projectDir: "/projects/bunnyhome",
    providerAdapters: { technitium, caddy }
  });

  assert.equal(result.changes.length, 0);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.notices.length, 0);
});

test("runTrackingJob persists verification warnings to state", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);

  const result = await runTrackingJob({
    filesystem,
    projectDir: "/projects/bunnyhome",
    providerAdapters: {}
  });

  assert.equal(result.warnings.length, 2);
  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.equal(state.tracking.notices.length, 2);
  assert.equal(state.tracking.notices[0].kind, "verification-warning");
  assert.match(state.tracking.notices[0].summary, /unavailable/i);
});

test("nomina changes shows no changes when state is clean", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);

  const result = await runCli(
    ["changes", "--project-dir", "/projects/bunnyhome"],
    { filesystem, runtime: proxmoxRootRuntime() }
  );

  assert.match(result.stdout, /No changes recorded/i);
});

test("nomina changes shows pending notices and clears them", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);

  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  state.tracking.notices = [
    {
      id: "nc_notice_1",
      kind: "verification-warning",
      serviceName: "technitium",
      platformKey: "dns",
      verified: false,
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "Provider adapter for technitium is unavailable for inspection."
    }
  ];
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify(state, null, 2)}\n`);

  const result = await runCli(
    ["changes", "--project-dir", "/projects/bunnyhome"],
    { filesystem, runtime: proxmoxRootRuntime() }
  );

  assert.match(result.stdout, /technitium/i);
  assert.match(result.stdout, /unavailable/i);

  const clearedState = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.equal(clearedState.tracking.notices.length, 0);
});

test("nomina changes shows multiple pending notices", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);

  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  state.tracking.notices = [
    {
      id: "nc_notice_1",
      kind: "verification-warning",
      serviceName: "technitium",
      platformKey: "dns",
      verified: false,
      timestamp: "2026-01-01T00:00:00.000Z",
      summary: "technitium health check failed."
    },
    {
      id: "nc_notice_2",
      kind: "verification-warning",
      serviceName: "caddy",
      platformKey: "reverseProxy",
      verified: false,
      timestamp: "2026-01-01T00:00:01.000Z",
      summary: "caddy health check failed."
    }
  ];
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify(state, null, 2)}\n`);

  const result = await runCli(
    ["changes", "--project-dir", "/projects/bunnyhome"],
    { filesystem, runtime: proxmoxRootRuntime() }
  );

  assert.match(result.stdout, /technitium/);
  assert.match(result.stdout, /caddy/);
  const unverifiedCount = (result.stdout.match(/unverified/g) || []).length;
  assert.equal(unverifiedCount, 2);
});

test("formatPendingNotices returns empty string for no notices", () => {
  assert.equal(formatPendingNotices([]), "");
});

test("formatPendingNotices groups verified and unverified notices", () => {
  const notices = [
    { verified: true, summary: "Change adopted." },
    { verified: false, summary: "Warning issued." }
  ];
  const output = formatPendingNotices(notices);
  assert.match(output, /1 verified change/);
  assert.match(output, /1 unverified change/);
  assert.match(output, /Change adopted/);
  assert.match(output, /Warning issued/);
});

test("formatChangesDetail formats notices with timestamps", () => {
  const notices = [
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      serviceName: "technitium",
      platformKey: "dns",
      verified: true,
      summary: "Change adopted."
    }
  ];
  const output = formatChangesDetail(notices);
  assert.match(output, /2026-01-01/);
  assert.match(output, /technitium/);
  assert.match(output, /verified/);
  assert.match(output, /Change adopted/);
});

test("formatChangesDetail returns no-changes message for empty array", () => {
  assert.match(formatChangesDetail([]), /No changes recorded/);
});

test("clearPendingNotices removes all notices from state", () => {
  const state = {
    version: 1,
    providerReferences: {},
    tracking: { notices: [{ id: "nc_1", summary: "test" }] }
  };
  const cleared = clearPendingNotices(state);
  assert.equal(cleared.tracking.notices.length, 0);
  assert.equal(cleared.version, 1);
});

test("interactive menu shows View changes when there are pending notices", () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium" },
          reverseProxy: { id: "nc_proxy_test", service: "caddy" },
          certificateAuthority: null,
          vpn: null
        }
      }
    },
    state: {
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      },
      tracking: {
        notices: [
          { id: "nc_1", summary: "Test change" }
        ]
      }
    }
  };

  const optionValues = buildMenuOptions(project).map((option) => option.value);
  assert.ok(optionValues.includes("view-changes"));
  assert.ok(optionValues.includes("publish-exposure"));
});

test("interactive menu hides View changes when no pending notices", () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium" },
          reverseProxy: { id: "nc_proxy_test", service: "caddy" },
          certificateAuthority: null,
          vpn: null
        }
      }
    },
    state: {
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      },
      tracking: { notices: [] }
    }
  };

  const optionValues = buildMenuOptions(project).map((option) => option.value);
  assert.ok(!optionValues.includes("view-changes"));
});

test("interactive menu can route to view-changes", async () => {
  const commands = [];
  await runInteractiveApp({
    filesystem: {
      exists: (path) => path === "/projects/home/nomina.yaml",
      read: () => ""
    },
    cwd: "/projects/home",
    interactive: {
      chooseAction: async () => "view-changes"
    },
    runCommand: async (argumentsList) => {
      commands.push(argumentsList);
      return { stdout: "No changes recorded.\n" };
    }
  });

  assert.deepEqual(commands, [["changes"]]);
});

test("background tracking job starts after CLI command completes", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  let trackingStarted = false;

  await runCli(
    ["changes", "--project-dir", "/projects/bunnyhome"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      providerAdapters: {
        technitium: createTechnitiumAdapter(),
        caddy: createCaddyAdapter()
      }
    }
  );

  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.ok(state.tracking);
  assert.ok(Array.isArray(state.tracking.notices));
});

test("tracking job persists health-check warnings atomically", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);

  await runTrackingJob({
    filesystem,
    projectDir: "/projects/bunnyhome",
    providerAdapters: {}
  });

  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.ok(state.tracking.notices.length > 0);
  for (const notice of state.tracking.notices) {
    assert.equal(notice.kind, "verification-warning");
    assert.equal(notice.verified, false);
    assert.ok(notice.summary);
    assert.ok(notice.timestamp);
  }
});

test("tracking job does not modify config when no changes detected", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const originalConfig = filesystem.read("/projects/bunnyhome/nomina.yaml");

  const technitium = createTechnitiumAdapter();
  const caddy = createCaddyAdapter();

  await runTrackingJob({
    filesystem,
    projectDir: "/projects/bunnyhome",
    providerAdapters: { technitium, caddy }
  });

  const afterConfig = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.equal(originalConfig, afterConfig);
});

test("nomina changes requires an initialized project", async () => {
  const filesystem = new FakeFilesystem();

  await assert.rejects(
    runCli(
      ["changes", "--project-dir", "/projects/missing"],
      { filesystem, runtime: proxmoxRootRuntime() }
    ),
    /no NominaConnect project/i
  );
});

test("withBoundedRetry succeeds on first attempt", async () => {
  let callCount = 0;
  const result = await withBoundedRetry(async () => {
    callCount += 1;
    return "success";
  });
  assert.equal(result, "success");
  assert.equal(callCount, 1);
});

test("withBoundedRetry retries and succeeds on subsequent attempt", async () => {
  let callCount = 0;
  const delays = [];
  const result = await withBoundedRetry(
    async () => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("transient network failure");
      }
      return "recovered";
    },
    {
      maxRetries: 3,
      baseDelayMs: 10,
      backoffFactor: 2,
      sleep: async (ms) => delays.push(ms)
    }
  );
  assert.equal(result, "recovered");
  assert.equal(callCount, 2);
  assert.deepEqual(delays, [10]);
});

test("withBoundedRetry fails after exhausting max retries", async () => {
  let callCount = 0;
  const delays = [];
  await assert.rejects(
    withBoundedRetry(
      async () => {
        callCount += 1;
        throw new Error("persistent outage");
      },
      {
        maxRetries: 2,
        baseDelayMs: 5,
        backoffFactor: 2,
        sleep: async (ms) => delays.push(ms)
      }
    ),
    /persistent outage/
  );
  assert.equal(callCount, 3);
  assert.deepEqual(delays, [5, 10]);
});

test("runAdoptionPass inspects and adopts Traefik deployment changes with verified health", async () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: null,
          reverseProxy: {
            id: "nc_traefik_test",
            service: "traefik",
            deployment: { ip: "10.0.0.54", hostname: "traefik", resources: { cpus: 2, memoryMb: 512, diskGb: 4 } }
          },
          certificateAuthority: null,
          vpn: null
        },
        services: []
      },
      baseLocalDomain: "bunnyhome.test"
    },
    state: {
      providerReferences: {
        nc_traefik_test: { vmid: 121, ip: "10.0.0.54" }
      }
    }
  };

  const traefik = createTraefikAdapter({
    inspectResult: {
      deployment: { ip: "10.0.0.99", hostname: "traefik-updated", resources: { cpus: 4, memoryMb: 1024, diskGb: 8 } }
    },
    health: { process: "running", endpoint: "reachable" }
  });

  const result = await runAdoptionPass({
    project,
    providerAdapters: { traefik },
    retryOptions: { sleep: () => Promise.resolve() }
  });

  assert.equal(result.warnings.length, 0);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].serviceName, "traefik");
  assert.equal(result.changes[0].platformKey, "reverseProxy");
  assert.equal(result.changes[0].kind, "platform-changed");
  assert.equal(result.changes[0].verified, true);
  assert.equal(result.changes[0].after.ip, "10.0.0.99");
  assert.equal(result.changes[0].after.hostname, "traefik-updated");
});

test("runAdoptionPass marks Traefik deployment changes unverified when health check fails", async () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: null,
          reverseProxy: {
            id: "nc_traefik_test",
            service: "traefik",
            deployment: { ip: "10.0.0.54", hostname: "traefik" }
          },
          certificateAuthority: null,
          vpn: null
        },
        services: []
      },
      baseLocalDomain: "bunnyhome.test"
    },
    state: {
      providerReferences: {
        nc_traefik_test: { vmid: 121, ip: "10.0.0.54" }
      }
    }
  };

  const traefik = createTraefikAdapter({
    inspectResult: {
      deployment: { ip: "10.0.0.99", hostname: "traefik" }
    },
    health: { process: "stopped", endpoint: "unreachable" }
  });

  const result = await runAdoptionPass({
    project,
    providerAdapters: { traefik },
    retryOptions: { sleep: () => Promise.resolve() }
  });

  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].verified, false);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /traefik health check failed/i);
});

test("runAdoptionPass inspects and adopts Traefik exposed route changes", async () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: null,
          reverseProxy: {
            id: "nc_traefik_test",
            service: "traefik",
            deployment: { ip: "10.0.0.54", hostname: "traefik" }
          },
          certificateAuthority: null,
          vpn: null
        },
        services: [
          {
            id: "nc_svc_app",
            name: "app",
            exposure: {
              hostname: "app.bunnyhome.test",
              backend: { ip: "10.0.0.20", port: 3000 },
              protocol: "https"
            }
          }
        ]
      },
      baseLocalDomain: "bunnyhome.test"
    },
    state: {
      providerReferences: {
        nc_traefik_test: { vmid: 121, ip: "10.0.0.54" }
      }
    }
  };

  const traefik = createTraefikAdapter({
    resources: [
      {
        id: "app.bunnyhome.test",
        backendIp: "10.0.0.88",
        backendPort: 8080
      }
    ],
    exposureHealth: () => ({ https: "reachable", status: "healthy" })
  });

  const result = await runAdoptionPass({
    project,
    providerAdapters: { traefik },
    retryOptions: { sleep: () => Promise.resolve() }
  });

  assert.equal(result.warnings.length, 0);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].kind, "exposure-changed");
  assert.equal(result.changes[0].serviceName, "app");
  assert.equal(result.changes[0].verified, true);
  assert.deepEqual(result.changes[0].after.backend, { ip: "10.0.0.88", port: 8080 });
});

test("runAdoptionPass inspects and adopts step-ca deployment changes with verified health", async () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: null,
          reverseProxy: null,
          certificateAuthority: {
            id: "nc_ca_test",
            service: "step-ca",
            deployment: { ip: "10.0.0.55", hostname: "step-ca", resources: { cpus: 2, memoryMb: 512, diskGb: 4 } }
          },
          vpn: null
        },
        services: []
      },
      baseLocalDomain: "bunnyhome.test"
    },
    state: {
      providerReferences: {
        nc_ca_test: { vmid: 122, ip: "10.0.0.55" }
      }
    }
  };

  const stepCa = createStepCaAdapter({
    inspectResult: {
      deployment: { ip: "10.0.0.95", hostname: "step-ca-primary", resources: { cpus: 4, memoryMb: 1024, diskGb: 8 } }
    },
    health: { process: "running", endpoint: "reachable" }
  });

  const result = await runAdoptionPass({
    project,
    providerAdapters: { "step-ca": stepCa },
    retryOptions: { sleep: () => Promise.resolve() }
  });

  assert.equal(result.warnings.length, 0);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].serviceName, "step-ca");
  assert.equal(result.changes[0].platformKey, "certificateAuthority");
  assert.equal(result.changes[0].verified, true);
  assert.equal(result.changes[0].after.ip, "10.0.0.95");
});

test("runAdoptionPass produces verification warning when step-ca health check fails", async () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: null,
          reverseProxy: null,
          certificateAuthority: {
            id: "nc_ca_test",
            service: "step-ca",
            deployment: { ip: "10.0.0.55", hostname: "step-ca" }
          },
          vpn: null
        },
        services: []
      },
      baseLocalDomain: "bunnyhome.test"
    },
    state: {
      providerReferences: {
        nc_ca_test: { vmid: 122, ip: "10.0.0.55" }
      }
    }
  };

  const stepCa = createStepCaAdapter({
    health: { process: "stopped", endpoint: "unreachable" }
  });

  const result = await runAdoptionPass({
    project,
    providerAdapters: { "step-ca": stepCa },
    retryOptions: { sleep: () => Promise.resolve() }
  });

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /step-ca health check failed/i);
});

test("runAdoptionPass inspects caddy-internal-ca using caddy adapter fallback", async () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: null,
          reverseProxy: { id: "nc_caddy_test", service: "caddy", deployment: { ip: "10.0.0.54" } },
          certificateAuthority: {
            id: "nc_ca_test",
            service: "caddy-internal-ca"
          },
          vpn: null
        },
        services: []
      },
      baseLocalDomain: "bunnyhome.test"
    },
    state: {
      providerReferences: {
        nc_caddy_test: { vmid: 121, ip: "10.0.0.54" },
        nc_ca_test: { vmid: 121, service: "caddy-internal-ca" }
      }
    }
  };

  const caddy = createCaddyAdapter({
    health: { process: "running", endpoint: "reachable" }
  });

  const result = await runAdoptionPass({
    project,
    providerAdapters: { caddy },
    retryOptions: { sleep: () => Promise.resolve() }
  });

  assert.equal(result.warnings.length, 0);
  assert.equal(result.changes.length, 0);
});

test("runAdoptionPass produces verification warning when caddy-internal-ca health check fails", async () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: null,
          reverseProxy: null,
          certificateAuthority: {
            id: "nc_ca_test",
            service: "caddy-internal-ca"
          },
          vpn: null
        },
        services: []
      },
      baseLocalDomain: "bunnyhome.test"
    },
    state: {
      providerReferences: {
        nc_ca_test: { vmid: 121, service: "caddy-internal-ca" }
      }
    }
  };

  const caddy = createCaddyAdapter({
    health: { process: "stopped", endpoint: "unreachable" }
  });

  const result = await runAdoptionPass({
    project,
    providerAdapters: { caddy },
    retryOptions: { sleep: () => Promise.resolve() }
  });

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /caddy-internal-ca health check failed/i);
});

test("runAdoptionPass inspects and adopts Tailscale deployment changes with verified health", async () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: null,
          reverseProxy: null,
          certificateAuthority: null,
          vpn: {
            id: "nc_vpn_test",
            service: "tailscale",
            deployment: { ip: "10.0.0.56", hostname: "tailscale", resources: { cpus: 1, memoryMb: 256, diskGb: 2 } }
          }
        },
        services: []
      },
      baseLocalDomain: "bunnyhome.test"
    },
    state: {
      providerReferences: {
        nc_vpn_test: { vmid: 130, ip: "10.0.0.56" }
      }
    }
  };

  const tailscale = createTailscaleAdapter({
    inspectResult: {
      deployment: { ip: "10.0.0.96", hostname: "tailscale-node", resources: { cpus: 2, memoryMb: 512, diskGb: 4 } }
    },
    health: { process: "running", endpoint: "reachable" }
  });

  const result = await runAdoptionPass({
    project,
    providerAdapters: { tailscale },
    retryOptions: { sleep: () => Promise.resolve() }
  });

  assert.equal(result.warnings.length, 0);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].serviceName, "tailscale");
  assert.equal(result.changes[0].platformKey, "vpn");
  assert.equal(result.changes[0].verified, true);
  assert.equal(result.changes[0].after.ip, "10.0.0.96");
  assert.equal(result.changes[0].after.hostname, "tailscale-node");
});

test("runAdoptionPass produces verification warning when Tailscale health check fails", async () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: null,
          reverseProxy: null,
          certificateAuthority: null,
          vpn: {
            id: "nc_vpn_test",
            service: "tailscale",
            deployment: { ip: "10.0.0.56", hostname: "tailscale" }
          }
        },
        services: []
      },
      baseLocalDomain: "bunnyhome.test"
    },
    state: {
      providerReferences: {
        nc_vpn_test: { vmid: 130, ip: "10.0.0.56" }
      }
    }
  };

  const tailscale = createTailscaleAdapter({
    health: { process: "stopped", endpoint: "unreachable" }
  });

  const result = await runAdoptionPass({
    project,
    providerAdapters: { tailscale },
    retryOptions: { sleep: () => Promise.resolve() }
  });

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /tailscale health check failed/i);
});

test("runAdoptionPass inspects and adopts NetBird deployment changes with verified health", async () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: null,
          reverseProxy: null,
          certificateAuthority: null,
          vpn: {
            id: "nc_vpn_test",
            service: "netbird",
            deployment: { ip: "10.0.0.57", hostname: "netbird", resources: { cpus: 1, memoryMb: 256, diskGb: 2 } }
          }
        },
        services: []
      },
      baseLocalDomain: "bunnyhome.test"
    },
    state: {
      providerReferences: {
        nc_vpn_test: { vmid: 131, ip: "10.0.0.57" }
      }
    }
  };

  const netbird = createNetBirdAdapter({
    inspectResult: {
      deployment: { ip: "10.0.0.97", hostname: "netbird-node", resources: { cpus: 2, memoryMb: 512, diskGb: 4 } }
    },
    health: { process: "running", endpoint: "reachable" }
  });

  const result = await runAdoptionPass({
    project,
    providerAdapters: { netbird },
    retryOptions: { sleep: () => Promise.resolve() }
  });

  assert.equal(result.warnings.length, 0);
  assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].serviceName, "netbird");
  assert.equal(result.changes[0].platformKey, "vpn");
  assert.equal(result.changes[0].verified, true);
  assert.equal(result.changes[0].after.ip, "10.0.0.97");
  assert.equal(result.changes[0].after.hostname, "netbird-node");
});

test("runAdoptionPass produces verification warning when NetBird health check fails", async () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: null,
          reverseProxy: null,
          certificateAuthority: null,
          vpn: {
            id: "nc_vpn_test",
            service: "netbird",
            deployment: { ip: "10.0.0.57", hostname: "netbird" }
          }
        },
        services: []
      },
      baseLocalDomain: "bunnyhome.test"
    },
    state: {
      providerReferences: {
        nc_vpn_test: { vmid: 131, ip: "10.0.0.57" }
      }
    }
  };

  const netbird = createNetBirdAdapter({
    health: { process: "stopped", endpoint: "unreachable" }
  });

  const result = await runAdoptionPass({
    project,
    providerAdapters: { netbird },
    retryOptions: { sleep: () => Promise.resolve() }
  });

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /netbird health check failed/i);
});

test("runTrackingJob recovers from transient inspection failure with bounded retry", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);

  let inspectAttempts = 0;
  const technitium = {
    inspect() {
      inspectAttempts += 1;
      if (inspectAttempts === 1) {
        throw new Error("Temporary network timeout");
      }
      return { resources: [{ id: "bunnyhome.test", record: "bunnyhome.test NS localhost" }] };
    },
    healthCheck() {
      return { process: "running", endpoint: "reachable" };
    }
  };
  const caddy = createCaddyAdapter();

  const result = await runTrackingJob({
    filesystem,
    projectDir: "/projects/bunnyhome",
    providerAdapters: { technitium, caddy },
    retryOptions: { maxRetries: 2, baseDelayMs: 1, sleep: () => Promise.resolve() }
  });

  assert.equal(inspectAttempts, 2);
  assert.equal(result.warnings.length, 0);
});

test("runTrackingJob handles persistent provider outage as verification warning without blocking", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);

  let attempts = 0;
  const traefik = {
    inspect() {
      attempts += 1;
      throw new Error("Traefik API unreachable: connection refused");
    },
    healthCheck() {
      return { process: "stopped", endpoint: "unreachable" };
    }
  };

  const projectDir = "/projects/bunnyhome";
  filesystem.writeFile(`${projectDir}/nomina.yaml`, createProvisionedProjectYaml({ proxyService: "traefik", proxyHostname: "traefik" }));
  const state = JSON.parse(filesystem.read(`${projectDir}/.nomina/state.json`));
  state.providerReferences["nc_proxy_test"] = { vmid: 121, ip: "10.0.0.54" };
  filesystem.writeFile(`${projectDir}/.nomina/state.json`, `${JSON.stringify(state, null, 2)}\n`);

  const result = await runTrackingJob({
    filesystem,
    projectDir,
    providerAdapters: { technitium: createTechnitiumAdapter(), traefik },
    retryOptions: { maxRetries: 2, baseDelayMs: 1, sleep: () => Promise.resolve() }
  });

  assert.equal(attempts, 3);
  assert.ok(result.warnings.length > 0);
  assert.match(result.warnings.find((w) => w.platformKey === "reverseProxy")?.message, /Traefik API unreachable/i);

  const updatedState = JSON.parse(filesystem.read(`${projectDir}/.nomina/state.json`));
  assert.ok(updatedState.tracking.notices.some((n) => n.kind === "verification-warning"));
});

test("nomina changes displays consistent notices across Traefik, step-ca, Tailscale, NetBird and clears them", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);

  const projectDir = "/projects/bunnyhome";
  const state = JSON.parse(filesystem.read(`${projectDir}/.nomina/state.json`));
  state.tracking.notices = [
    {
      id: "nc_notice_traefik",
      kind: "platform-changed",
      serviceName: "traefik",
      platformKey: "reverseProxy",
      verified: true,
      timestamp: "2026-08-20T10:00:00.000Z",
      summary: "traefik ip, hostname changed."
    },
    {
      id: "nc_notice_step_ca",
      kind: "platform-changed",
      serviceName: "step-ca",
      platformKey: "certificateAuthority",
      verified: true,
      timestamp: "2026-08-20T10:00:01.000Z",
      summary: "step-ca resources.cpus changed."
    },
    {
      id: "nc_notice_tailscale",
      kind: "verification-warning",
      serviceName: "tailscale",
      platformKey: "vpn",
      verified: false,
      timestamp: "2026-08-20T10:00:02.000Z",
      summary: "tailscale health check failed: process=stopped, endpoint=unreachable."
    },
    {
      id: "nc_notice_netbird",
      kind: "platform-changed",
      serviceName: "netbird",
      platformKey: "vpn",
      verified: true,
      timestamp: "2026-08-20T10:00:03.000Z",
      summary: "netbird ip changed."
    }
  ];
  filesystem.writeFile(`${projectDir}/.nomina/state.json`, `${JSON.stringify(state, null, 2)}\n`);

  const result = await runCli(
    ["changes", "--project-dir", projectDir],
    { filesystem, runtime: proxmoxRootRuntime() }
  );

  assert.match(result.stdout, /traefik \(reverseProxy\) — verified/);
  assert.match(result.stdout, /step-ca \(certificateAuthority\) — verified/);
  assert.match(result.stdout, /tailscale \(vpn\) — unverified/);
  assert.match(result.stdout, /netbird \(vpn\) — verified/);
  assert.match(result.stdout, /traefik ip, hostname changed\./);
  assert.match(result.stdout, /tailscale health check failed/);

  const clearedState = JSON.parse(filesystem.read(`${projectDir}/.nomina/state.json`));
  assert.equal(clearedState.tracking.notices.length, 0);
});

test("formatChangeSummary formats exposure-changed and platform changes consistently", () => {
  assert.equal(
    formatChangeSummary({
      kind: "exposure-changed",
      serviceName: "photos",
      changes: { backend: { ip: "10.0.0.99", port: 8080 } }
    }),
    "photos exposure backend changed."
  );
  assert.equal(
    formatChangeSummary({
      kind: "platform-changed",
      serviceName: "step-ca",
      changes: { ip: "10.0.0.95" }
    }),
    "step-ca ip changed."
  );
  assert.equal(
    formatChangeSummary({
      kind: "platform-deployed",
      serviceName: "tailscale",
      after: { ip: "10.0.0.56" }
    }),
    "tailscale deployment observed at 10.0.0.56."
  );
});

test("adoptServiceExposure updates the matching service exposure in configuration", () => {
  const config = {
    managedInventory: {
      services: [
        {
          id: "nc_svc_1",
          name: "app",
          exposure: {
            hostname: "app.test",
            backend: { ip: "10.0.0.10", port: 80 }
          }
        },
        {
          id: "nc_svc_2",
          name: "db",
          exposure: {
            hostname: "db.test",
            backend: { ip: "10.0.0.11", port: 5432 }
          }
        }
      ]
    }
  };

  const updated = adoptServiceExposure(config, "nc_svc_1", {
    hostname: "app.test",
    backend: { ip: "10.0.0.99", port: 8080 }
  });

  assert.equal(updated.managedInventory.services[0].exposure.backend.ip, "10.0.0.99");
  assert.equal(updated.managedInventory.services[0].exposure.backend.port, 8080);
  assert.equal(updated.managedInventory.services[1].exposure.backend.ip, "10.0.0.11");
});

