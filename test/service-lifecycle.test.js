import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";
import { runTrackingJob } from "../src/tracking.js";
import { runAdoptionPass } from "../src/adoption.js";
import { buildMenuOptions, runInteractiveApp } from "../src/tui.js";

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

const PROVISIONED_PROJECT = `apiVersion: nomina.connect/v0alpha1
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
      service: caddy
      deployment:
        ip: 10.0.0.54
        hostname: caddy
    certificateAuthority: null
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test
`;

const PROVISIONED_STATE = {
  version: 1,
  providerReferences: {
    nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
    nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
  },
  retainedServices: {},
  tracking: { notices: [] }
};

function seedProvisionedProject(filesystem, projectDir = "/projects/bunnyhome") {
  filesystem.mkdir(projectDir);
  filesystem.mkdir(`${projectDir}/.nomina`);
  filesystem.writeFile(`${projectDir}/nomina.yaml`, PROVISIONED_PROJECT);
  filesystem.writeFile(`${projectDir}/.nomina/state.json`, `${JSON.stringify(PROVISIONED_STATE, null, 2)}\n`);
}

function createProxmoxAdapter(overrides = {}) {
  const created = [];
  const execCalls = [];
  const snapshotCalls = [];
  const stopCalls = [];
  const destroyCalls = [];
  return {
    created,
    execCalls,
    snapshotCalls,
    stopCalls,
    destroyCalls,
    supportsSnapshots(storage) {
      return overrides.supportsSnapshots !== undefined
        ? (typeof overrides.supportsSnapshots === "function" ? overrides.supportsSnapshots(storage) : overrides.supportsSnapshots)
        : true;
    },
    createSnapshot(vmid, snapshotName) {
      snapshotCalls.push({ vmid, snapshotName });
      return { vmid, snapshotName, timestamp: "2026-08-20T20:00:00.000Z" };
    },
    stopLxc(vmid) {
      stopCalls.push({ vmid });
      return { exitCode: 0, status: "stopped" };
    },
    destroyLxc(vmid) {
      destroyCalls.push({ vmid });
      return { exitCode: 0, status: "destroyed" };
    },
    pctExec(vmid, command) {
      execCalls.push({ vmid, command });
      return overrides.pctExec?.(vmid, command) ?? { exitCode: 0, stdout: "ok" };
    }
  };
}

function createTechnitiumAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "bunnyhome.test", record: "bunnyhome.test NS localhost" }
    ],
    upgradeCalls: []
  };
  return {
    upgradeCalls: state.upgradeCalls,
    inspect() {
      return {
        resources: state.resources.map((r) => ({ ...r })),
        ...(overrides.inspectResult ?? {})
      };
    },
    upgrade(plan) {
      state.upgradeCalls.push(plan);
      return {
        ...plan,
        lxcCommands: ["upgrade-technitium"]
      };
    },
    healthCheck() {
      return overrides.health ?? { process: "running", endpoint: "reachable" };
    }
  };
}

function createCaddyAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "existing.bunnyhome.test", route: "https://existing.bunnyhome.test" }
    ],
    upgradeCalls: [],
    unpublishCalls: []
  };
  return {
    upgradeCalls: state.upgradeCalls,
    unpublishCalls: state.unpublishCalls,
    inspect() {
      return {
        resources: state.resources.map((r) => ({ ...r })),
        ...(overrides.inspectResult ?? {})
      };
    },
    upgrade(plan) {
      state.upgradeCalls.push(plan);
      return {
        ...plan,
        lxcCommands: ["upgrade-caddy"]
      };
    },
    unpublishRoute(request) {
      state.unpublishCalls.push(request);
      state.resources = state.resources.filter((r) => r.id !== request.hostname);
    },
    healthCheck() {
      return overrides.health ?? { process: "running", endpoint: "reachable" };
    }
  };
}

test("nomina service upgrade technitium creates a Proxmox snapshot and executes upgrade", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const proxmox = createProxmoxAdapter();
  const technitium = createTechnitiumAdapter();

  const result = await runCli(
    ["service", "upgrade", "technitium", "--project-dir", "/projects/bunnyhome", "--snapshot"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { technitium }
    }
  );

  assert.match(result.stdout, /Technitium upgraded/i);
  assert.equal(proxmox.snapshotCalls.length, 1);
  assert.equal(proxmox.snapshotCalls[0].vmid, 120);
  assert.ok(proxmox.execCalls.some((c) => c.vmid === 120 && c.command === "upgrade-technitium"));
  assert.equal(result.health.status, "healthy");
});

test("nomina service upgrade skips snapshot when --no-snapshot is passed", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const proxmox = createProxmoxAdapter();
  const technitium = createTechnitiumAdapter();

  const result = await runCli(
    ["service", "upgrade", "technitium", "--project-dir", "/projects/bunnyhome", "--no-snapshot"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { technitium }
    }
  );

  assert.match(result.stdout, /Technitium upgraded/i);
  assert.equal(proxmox.snapshotCalls.length, 0);
  assert.ok(proxmox.execCalls.some((c) => c.vmid === 120 && c.command === "upgrade-technitium"));
});

test("nomina service upgrade skips snapshot when storage does not support snapshots", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const proxmox = createProxmoxAdapter({ supportsSnapshots: false });
  const technitium = createTechnitiumAdapter();

  const result = await runCli(
    ["service", "upgrade", "technitium", "--project-dir", "/projects/bunnyhome"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { technitium }
    }
  );

  assert.match(result.stdout, /Technitium upgraded/i);
  assert.equal(proxmox.snapshotCalls.length, 0);
});

test("nomina service remove retains stopped LXC data and disconnects integrations", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const proxmox = createProxmoxAdapter();
  const caddy = createCaddyAdapter();

  const result = await runCli(
    ["service", "remove", "caddy", "--project-dir", "/projects/bunnyhome"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { caddy }
    }
  );

  assert.match(result.stdout, /removed/i);
  assert.match(result.stdout, /retained/i);
  assert.equal(proxmox.stopCalls.length, 1);
  assert.equal(proxmox.stopCalls[0].vmid, 121);
  assert.equal(proxmox.destroyCalls.length, 0); // LXC must NOT be destroyed!

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.ok(!config.includes("hostname: caddy"));

  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.equal(state.providerReferences.nc_proxy_test, undefined);
  assert.equal(state.retainedServices.nc_proxy_test.vmid, 121);
});

test("nomina service destroy requires confirmation and permanently deletes LXC data", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const proxmox = createProxmoxAdapter();

  // First remove to retain
  await runCli(
    ["service", "remove", "caddy", "--project-dir", "/projects/bunnyhome"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { caddy: createCaddyAdapter() }
    }
  );

  // Now destroy with explicit --confirm
  const result = await runCli(
    ["service", "destroy", "caddy", "--project-dir", "/projects/bunnyhome", "--confirm"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox
    }
  );

  assert.match(result.stdout, /destroyed/i);
  assert.match(result.stdout, /deleted/i);
  assert.equal(proxmox.destroyCalls.length, 1);
  assert.equal(proxmox.destroyCalls[0].vmid, 121);

  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.equal(state.retainedServices.nc_proxy_test, undefined);
});

test("nomina service destroy cancels when confirmation is declined", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const proxmox = createProxmoxAdapter();

  const prompts = {
    confirm: async () => false
  };

  const result = await runCli(
    ["service", "destroy", "caddy", "--project-dir", "/projects/bunnyhome"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      prompts
    }
  );

  assert.match(result.stdout, /cancelled/i);
  assert.equal(proxmox.destroyCalls.length, 0); // LXC must NOT be destroyed!
});

test("background tracking reports available changes but never upgrades a service", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);

  const technitium = {
    upgradeCalls: [],
    inspect() {
      return {
        resources: [{ id: "bunnyhome.test", record: "bunnyhome.test NS localhost" }],
        availableUpgrade: "Technitium DNS Server v13.0.0"
      };
    },
    upgrade() {
      throw new Error("Background tracking must NEVER invoke upgrade!");
    },
    healthCheck() {
      return { process: "running", endpoint: "reachable" };
    }
  };

  const proxmox = createProxmoxAdapter();

  const result = await runTrackingJob({
    filesystem,
    projectDir: "/projects/bunnyhome",
    providerAdapters: { technitium, caddy: createCaddyAdapter() }
  });

  // Upgrade was NOT executed
  assert.equal(proxmox.execCalls.length, 0);
  assert.equal(technitium.upgradeCalls.length, 0);

  // Available upgrade notice is recorded
  assert.ok(result.notices.some((n) => n.summary?.includes("upgrade") || n.summary?.includes("v13.0.0") || n.kind === "upgrade-available"));
});

test("nomina service upgrade prompts for service and snapshot confirmation when interactive", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const proxmox = createProxmoxAdapter();
  const technitium = createTechnitiumAdapter();

  const prompts = {
    select: async ({ options }) => options[0].value,
    confirm: async () => true
  };

  const result = await runCli(
    ["service", "upgrade", "--project-dir", "/projects/bunnyhome"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { technitium },
      prompts
    }
  );

  assert.match(result.stdout, /Technitium upgraded/i);
  assert.equal(proxmox.snapshotCalls.length, 1);
});

test("nomina service upgrade rejects when service is not provisioned", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  delete state.providerReferences.nc_dns_test;
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify(state, null, 2)}\n`);

  await assert.rejects(
    runCli(
      ["service", "upgrade", "technitium", "--project-dir", "/projects/bunnyhome"],
      {
        filesystem,
        runtime: proxmoxRootRuntime(),
        proxmox: createProxmoxAdapter(),
        providerAdapters: { technitium: createTechnitiumAdapter() }
      }
    ),
    /not provisioned/i
  );
});

test("nomina service upgrade reports unhealthy health outcome", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const proxmox = createProxmoxAdapter();
  const technitium = createTechnitiumAdapter({
    health: { process: "stopped", endpoint: "unreachable" }
  });

  const result = await runCli(
    ["service", "upgrade", "technitium", "--project-dir", "/projects/bunnyhome", "--no-snapshot"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { technitium }
    }
  );

  assert.equal(result.health.status, "unhealthy");
  assert.match(result.stdout, /unhealthy/i);
});

test("nomina service upgrade supports Traefik, step-ca, Tailscale, and NetBird", async () => {
  const filesystem = new FakeFilesystem();
  const projectDir = "/projects/bunnyhome";
  filesystem.mkdir(projectDir);
  filesystem.mkdir(`${projectDir}/.nomina`);

  const fullYaml = `apiVersion: nomina.connect/v0alpha1
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
      service: traefik
      deployment:
        ip: 10.0.0.54
        hostname: traefik
    certificateAuthority:
      id: nc_ca_test
      service: step-ca
      deployment:
        ip: 10.0.0.55
        hostname: step-ca
    vpn:
      id: nc_vpn_test
      service: tailscale
      deployment:
        ip: 10.0.0.56
        hostname: tailscale
  services: []
connectionSecretReferences: {}
`;
  const fullState = {
    version: 1,
    providerReferences: {
      nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
      nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
      nc_ca_test: { vmid: 122, ip: "10.0.0.55" },
      nc_vpn_test: { vmid: 123, ip: "10.0.0.56" }
    },
    retainedServices: {},
    tracking: { notices: [] }
  };

  filesystem.writeFile(`${projectDir}/nomina.yaml`, fullYaml);
  filesystem.writeFile(`${projectDir}/.nomina/state.json`, `${JSON.stringify(fullState, null, 2)}\n`);

  const proxmox = createProxmoxAdapter();
  const traefikAdapter = {
    upgrade: (plan) => ({ ...plan, lxcCommands: ["upgrade-traefik"] }),
    inspect: () => ({ resources: [] }),
    healthCheck: () => ({ process: "running", endpoint: "reachable" })
  };
  const stepCaAdapter = {
    upgrade: (plan) => ({ ...plan, lxcCommands: ["upgrade-step-ca"] }),
    inspect: () => ({ resources: [] }),
    healthCheck: () => ({ process: "running", endpoint: "reachable" })
  };
  const tailscaleAdapter = {
    upgrade: (plan) => ({ ...plan, lxcCommands: ["upgrade-tailscale"] }),
    inspect: () => ({ resources: [] }),
    healthCheck: () => ({ process: "running", endpoint: "reachable" })
  };

  const traefikResult = await runCli(
    ["service", "upgrade", "traefik", "--project-dir", projectDir, "--no-snapshot"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { traefik: traefikAdapter }
    }
  );
  assert.match(traefikResult.stdout, /Traefik upgraded/i);

  const stepCaResult = await runCli(
    ["service", "upgrade", "step-ca", "--project-dir", projectDir, "--no-snapshot"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { "step-ca": stepCaAdapter }
    }
  );
  assert.match(stepCaResult.stdout, /Step-ca upgraded/i);

  const tailscaleResult = await runCli(
    ["service", "upgrade", "tailscale", "--project-dir", projectDir, "--no-snapshot"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { tailscale: tailscaleAdapter }
    }
  );
  assert.match(tailscaleResult.stdout, /Tailscale upgraded/i);
});

test("nomina service remove on exposed service removes exposure and disconnects DNS and proxy", async () => {
  const filesystem = new FakeFilesystem();
  const projectDir = "/projects/bunnyhome";
  filesystem.mkdir(projectDir);
  filesystem.mkdir(`${projectDir}/.nomina`);

  const yamlWithExposure = `apiVersion: nomina.connect/v0alpha1
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
      service: caddy
      deployment:
        ip: 10.0.0.54
        hostname: caddy
    certificateAuthority: null
    vpn: null
  services:
    - id: nc_svc_app
      name: myapp
      exposure:
        hostname: myapp.bunnyhome.test
        backend:
          ip: 10.0.0.99
          port: 8080
        protocol: https
connectionSecretReferences: {}
`;
  const stateWithExposure = {
    version: 1,
    providerReferences: {
      nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
      nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
      nc_svc_app: { dns: "myapp.bunnyhome.test", reverseProxy: "myapp.bunnyhome.test" }
    },
    retainedServices: {},
    tracking: { notices: [] }
  };

  filesystem.writeFile(`${projectDir}/nomina.yaml`, yamlWithExposure);
  filesystem.writeFile(`${projectDir}/.nomina/state.json`, `${JSON.stringify(stateWithExposure, null, 2)}\n`);

  const caddy = createCaddyAdapter();
  const technitium = {
    unpublishCalls: [],
    unpublishRecord(req) {
      this.unpublishCalls.push(req);
    },
    inspect: () => ({ resources: [] }),
    healthCheck: () => ({ process: "running", endpoint: "reachable" })
  };

  const result = await runCli(
    ["service", "remove", "myapp", "--project-dir", projectDir],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox: createProxmoxAdapter(),
      providerAdapters: { technitium, caddy }
    }
  );

  assert.match(result.stdout, /Exposure myapp/i);
  assert.match(result.stdout, /removed/i);
  assert.equal(technitium.unpublishCalls.length, 1);
  assert.equal(caddy.unpublishCalls.length, 1);

  const updatedConfig = filesystem.read(`${projectDir}/nomina.yaml`);
  assert.ok(!updatedConfig.includes("myapp.bunnyhome.test"));

  const updatedState = JSON.parse(filesystem.read(`${projectDir}/.nomina/state.json`));
  assert.equal(updatedState.providerReferences.nc_svc_app, undefined);
});

test("nomina service destroy directly destroys active provisioned service when confirmed", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const proxmox = createProxmoxAdapter();

  const result = await runCli(
    ["service", "destroy", "technitium", "--project-dir", "/projects/bunnyhome", "--confirm"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox
    }
  );

  assert.match(result.stdout, /destroyed/i);
  assert.equal(proxmox.destroyCalls.length, 1);
  assert.equal(proxmox.destroyCalls[0].vmid, 120);

  const updatedState = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.equal(updatedState.providerReferences.nc_dns_test, undefined);
});

test("nomina service requires root Proxmox shell for upgrade, remove, destroy", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);

  const nonRoot = { isRoot: () => false, isProxmoxHost: () => true };

  await assert.rejects(
    runCli(["service", "upgrade", "technitium", "--project-dir", "/projects/bunnyhome"], { filesystem, runtime: nonRoot }),
    /must run as root/i
  );
  await assert.rejects(
    runCli(["service", "remove", "technitium", "--project-dir", "/projects/bunnyhome"], { filesystem, runtime: nonRoot }),
    /must run as root/i
  );
  await assert.rejects(
    runCli(["service", "destroy", "technitium", "--project-dir", "/projects/bunnyhome", "--confirm"], { filesystem, runtime: nonRoot }),
    /must run as root/i
  );
});

test("nomina service rejects unknown subcommand", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);

  await assert.rejects(
    runCli(["service", "invalid", "technitium", "--project-dir", "/projects/bunnyhome"], {
      filesystem,
      runtime: proxmoxRootRuntime()
    }),
    /add\|upgrade\|remove\|destroy/i
  );
});
