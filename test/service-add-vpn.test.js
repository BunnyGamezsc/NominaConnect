import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";
import {
  buildMenuOptions,
  canProvisionTailscale,
  canProvisionNetbird,
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

const INITIALIZED_PROJECT = `apiVersion: nomina.connect/v0alpha1
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
    reverseProxy:
      id: nc_proxy_test
      service: caddy
    certificateAuthority: null
    vpn:
      id: nc_vpn_test
      service: tailscale
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test
  nc_vpn_test: nominaconnect/provider/nc_vpn_test
`;

const NETBIRD_PROJECT = `apiVersion: nomina.connect/v0alpha1
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
    reverseProxy:
      id: nc_proxy_test
      service: caddy
    certificateAuthority: null
    vpn:
      id: nc_vpn_test
      service: netbird
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test
  nc_vpn_test: nominaconnect/provider/nc_vpn_test
`;

const INITIAL_STATE = {
  version: 1,
  providerReferences: {},
  tracking: { notices: [] }
};

function seedProject(filesystem, projectDir = "/projects/bunnyhome") {
  filesystem.mkdir(projectDir);
  filesystem.mkdir(`${projectDir}/.nomina`);
  filesystem.writeFile(`${projectDir}/nomina.yaml`, INITIALIZED_PROJECT);
  filesystem.writeFile(`${projectDir}/.nomina/state.json`, `${JSON.stringify(INITIAL_STATE, null, 2)}\n`);
}

function seedNetbirdProject(filesystem, projectDir = "/projects/bunnyhome") {
  filesystem.mkdir(projectDir);
  filesystem.mkdir(`${projectDir}/.nomina`);
  filesystem.writeFile(`${projectDir}/nomina.yaml`, NETBIRD_PROJECT);
  filesystem.writeFile(`${projectDir}/.nomina/state.json`, `${JSON.stringify(INITIAL_STATE, null, 2)}\n`);
}

function createProxmoxAdapter(overrides = {}) {
  const created = [];
  const execCalls = [];
  return {
    created,
    execCalls,
    checkIpAvailability(ip) {
      return overrides.ipAvailability?.(ip) ?? { status: "available" };
    },
    createLxc(spec) {
      created.push(spec);
      return { vmid: overrides.vmid ?? 130, hostname: spec.hostname };
    },
    pctExec(vmid, command) {
      execCalls.push({ vmid, command });
      return overrides.pctExec?.(vmid, command) ?? { exitCode: 0, stdout: "ok" };
    }
  };
}

function createTailscaleAdapter(overrides = {}) {
  const resources = overrides.resources ?? [
    { id: "existing-peer", peer: "legacy-node" }
  ];
  return {
    setup(plan) {
      return {
        ...plan,
        lxcCommands: ["install-tailscale", "join-tailnet"]
      };
    },
    inspect() {
      return { resources: resources.map((resource) => ({ ...resource })) };
    },
    adopt(request) {
      return { managedInventoryUpdate: request.managed };
    },
    healthCheck() {
      return overrides.health ?? { process: "running", endpoint: "reachable" };
    }
  };
}

function createNetbirdAdapter(overrides = {}) {
  const resources = overrides.resources ?? [
    { id: "existing-peer", peer: "legacy-node" }
  ];
  return {
    setup(plan) {
      return {
        ...plan,
        lxcCommands: ["install-netbird", "join-netbird-network"]
      };
    },
    inspect() {
      return { resources: resources.map((resource) => ({ ...resource })) };
    },
    adopt(request) {
      return { managedInventoryUpdate: request.managed };
    },
    healthCheck() {
      return overrides.health ?? { process: "running", endpoint: "reachable" };
    }
  };
}

test("nomina service add tailscale provisions an unprivileged Debian LXC with defaults", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const proxmox = createProxmoxAdapter();

  const result = await runCli(
    ["service", "add", "tailscale", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.60"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { tailscale: createTailscaleAdapter() }
    }
  );

  assert.match(result.stdout, /Tailscale provisioned/i);
  assert.match(result.stdout, /10\.0\.0\.60/);
  assert.equal(proxmox.created.length, 1);
  assert.deepEqual(proxmox.created[0], {
    node: "pve-1",
    hostname: "tailscale",
    ip: "10.0.0.60",
    bridge: "vmbr0",
    storage: "local-lvm",
    unprivileged: true,
    template: "debian-12-standard",
    gateway: "10.0.0.1",
    nameserver: "10.0.0.1",
    resources: { cpus: 1, memoryMb: 256, diskGb: 2 }
  });
  assert.deepEqual(
    proxmox.execCalls.map((call) => call.command),
    ["install-tailscale", "join-tailnet"]
  );

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /ip: 10\.0\.0\.60/);
  assert.match(config, /hostname: tailscale/);

  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.deepEqual(state.providerReferences.nc_vpn_test, { vmid: 130, ip: "10.0.0.60" });
  assert.equal(result.health.status, "healthy");
  assert.deepEqual(result.inspection.unmanaged.length, 1);
});

test("nomina service add netbird provisions an unprivileged Debian LXC with defaults", async () => {
  const filesystem = new FakeFilesystem();
  seedNetbirdProject(filesystem);
  const proxmox = createProxmoxAdapter();

  const result = await runCli(
    ["service", "add", "netbird", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.61"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { netbird: createNetbirdAdapter() }
    }
  );

  assert.match(result.stdout, /NetBird provisioned/i);
  assert.match(result.stdout, /10\.0\.0\.61/);
  assert.equal(proxmox.created.length, 1);
  assert.deepEqual(proxmox.created[0], {
    node: "pve-1",
    hostname: "netbird",
    ip: "10.0.0.61",
    bridge: "vmbr0",
    storage: "local-lvm",
    unprivileged: true,
    template: "debian-12-standard",
    gateway: "10.0.0.1",
    nameserver: "10.0.0.1",
    resources: { cpus: 1, memoryMb: 256, diskGb: 2 }
  });
  assert.deepEqual(
    proxmox.execCalls.map((call) => call.command),
    ["install-netbird", "join-netbird-network"]
  );

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /ip: 10\.0\.0\.61/);
  assert.match(config, /hostname: netbird/);

  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.deepEqual(state.providerReferences.nc_vpn_test, { vmid: 130, ip: "10.0.0.61" });
  assert.equal(result.health.status, "healthy");
});

test("nomina service add tailscale blocks provisioning when the requested IP is known to collide", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const proxmox = createProxmoxAdapter({
    ipAvailability: () => ({ status: "known-collision", conflictWith: "existing-lxc/115" })
  });

  await assert.rejects(
    runCli(
      ["service", "add", "tailscale", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.60"],
      { filesystem, runtime: proxmoxRootRuntime(), proxmox, providerAdapters: { tailscale: createTailscaleAdapter() } }
    ),
    /known.*collision|already in use/i
  );
  assert.equal(proxmox.created.length, 0);
});

test("nomina service add tailscale warns when wider-network IP availability is uncertain", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const proxmox = createProxmoxAdapter({
    ipAvailability: () => ({ status: "uncertain", reason: "no arp response from upstream network" })
  });

  const result = await runCli(
    ["service", "add", "tailscale", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.60"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { tailscale: createTailscaleAdapter() }
    }
  );

  assert.match(result.stdout, /warning/i);
  assert.equal(proxmox.created.length, 1);
  assert.deepEqual(result.warnings, [
    "Requested IP 10.0.0.60 availability is uncertain: no arp response from upstream network."
  ]);
});

test("nomina service add tailscale accepts resource, bridge, storage, and hostname overrides", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const proxmox = createProxmoxAdapter();

  await runCli(
    [
      "service", "add", "tailscale",
      "--project-dir", "/projects/bunnyhome",
      "--ip", "10.0.0.62",
      "--bridge", "vmbr1",
      "--storage", "local-zfs",
      "--hostname", "ts-primary",
      "--cpus", "2",
      "--memory", "512",
      "--disk", "4"
    ],
    { filesystem, runtime: proxmoxRootRuntime(), proxmox, providerAdapters: { tailscale: createTailscaleAdapter() } }
  );

  assert.deepEqual(proxmox.created[0], {
    node: "pve-1",
    hostname: "ts-primary",
    ip: "10.0.0.62",
    bridge: "vmbr1",
    storage: "local-zfs",
    unprivileged: true,
    template: "debian-12-standard",
    gateway: "10.0.0.1",
    nameserver: "10.0.0.1",
    resources: { cpus: 2, memoryMb: 512, diskGb: 4 }
  });
});

test("nomina service add tailscale reports unhealthy health checks", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);

  const result = await runCli(
    ["service", "add", "tailscale", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.60"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox: createProxmoxAdapter(),
      providerAdapters: {
        tailscale: createTailscaleAdapter({
          health: { process: "stopped", endpoint: "unreachable" }
        })
      }
    }
  );

  assert.equal(result.health.status, "unhealthy");
  assert.match(result.stdout, /unhealthy/i);
});

test("nomina service add tailscale rejects when tailscale is not selected as VPN in project", async () => {
  const filesystem = new FakeFilesystem();
  seedNetbirdProject(filesystem);

  await assert.rejects(
    runCli(
      ["service", "add", "tailscale", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.60"],
      { filesystem, runtime: proxmoxRootRuntime(), proxm: createProxmoxAdapter(), providerAdapters: { tailscale: createTailscaleAdapter() } }
    ),
    /not selected as the VPN provider/i
  );
});

test("nomina service add tailscale rejects a second provisioning attempt", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  state.providerReferences.nc_vpn_test = { vmid: 130, ip: "10.0.0.60" };
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify(state, null, 2)}\n`);

  await assert.rejects(
    runCli(
      ["service", "add", "tailscale", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.60"],
      { filesystem, runtime: proxmoxRootRuntime(), proxm: createProxmoxAdapter() }
    ),
    /already provisioned/i
  );
});

test("nomina service add netbird rejects when netbird is not selected as VPN in project", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);

  await assert.rejects(
    runCli(
      ["service", "add", "netbird", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.61"],
      { filesystem, runtime: proxmoxRootRuntime(), proxm: createProxmoxAdapter(), providerAdapters: { netbird: createNetbirdAdapter() } }
    ),
    /not selected as the VPN provider/i
  );
});

test("nomina service add netbird rejects a second provisioning attempt", async () => {
  const filesystem = new FakeFilesystem();
  seedNetbirdProject(filesystem);
  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  state.providerReferences.nc_vpn_test = { vmid: 130, ip: "10.0.0.61" };
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify(state, null, 2)}\n`);

  await assert.rejects(
    runCli(
      ["service", "add", "netbird", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.61"],
      { filesystem, runtime: proxmoxRootRuntime(), proxm: createProxmoxAdapter() }
    ),
    /already provisioned/i
  );
});

test("nomina service add tailscale requires an initialized project", async () => {
  const filesystem = new FakeFilesystem();

  await assert.rejects(
    runCli(
      ["service", "add", "tailscale", "--project-dir", "/projects/missing", "--ip", "10.0.0.60"],
      { filesystem, runtime: proxmoxRootRuntime(), proxm: createProxmoxAdapter() }
    ),
    /no NominaConnect project/i
  );
});

test("interactive menu offers Tailscale VPN when it needs provisioning", () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium" },
          reverseProxy: { id: "nc_proxy_test", service: "caddy" },
          certificateAuthority: null,
          vpn: { id: "nc_vpn_test", service: "tailscale" }
        }
      }
    },
    state: {
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      }
    }
  };

  assert.equal(canProvisionTailscale(project), true);
  const optionValues = buildMenuOptions(project).map((option) => option.value);
  assert.ok(optionValues.includes("provision-tailscale"));
});

test("interactive menu offers NetBird VPN when it needs provisioning", () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium" },
          reverseProxy: { id: "nc_proxy_test", service: "caddy" },
          certificateAuthority: null,
          vpn: { id: "nc_vpn_test", service: "netbird" }
        }
      }
    },
    state: {
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      }
    }
  };

  assert.equal(canProvisionNetbird(project), true);
  const optionValues = buildMenuOptions(project).map((option) => option.value);
  assert.ok(optionValues.includes("provision-netbird"));
});

test("interactive menu hides Tailscale when it is already provisioned", () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium" },
          reverseProxy: { id: "nc_proxy_test", service: "caddy" },
          certificateAuthority: null,
          vpn: { id: "nc_vpn_test", service: "tailscale" }
        }
      }
    },
    state: {
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
        nc_vpn_test: { vmid: 130, ip: "10.0.0.60" }
      }
    }
  };

  assert.equal(canProvisionTailscale(project), false);
  const optionValues = buildMenuOptions(project).map((option) => option.value);
  assert.ok(!optionValues.includes("provision-tailscale"));
});

test("interactive menu can route to service add tailscale", async () => {
  const commands = [];
  await runInteractiveApp({
    filesystem: {
      exists: (path) => path === "/projects/home/nomina.yaml",
      read: () => ""
    },
    cwd: "/projects/home",
    interactive: {
      chooseAction: async () => "provision-tailscale"
    },
    runCommand: async (argumentsList) => {
      commands.push(argumentsList);
      return { stdout: "provisioned\n" };
    }
  });

  assert.deepEqual(commands, [["service", "add", "tailscale"]]);
});

test("interactive menu can route to service add netbird", async () => {
  const commands = [];
  await runInteractiveApp({
    filesystem: {
      exists: (path) => path === "/projects/home/nomina.yaml",
      read: () => ""
    },
    cwd: "/projects/home",
    interactive: {
      chooseAction: async () => "provision-netbird"
    },
    runCommand: async (argumentsList) => {
      commands.push(argumentsList);
      return { stdout: "provisioned\n" };
    }
  });

  assert.deepEqual(commands, [["service", "add", "netbird"]]);
});

test("nomina service add tailscale can prompt for the static IP", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);

  const result = await runCli(
    ["service", "add", "tailscale", "--project-dir", "/projects/bunnyhome"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox: createProxmoxAdapter(),
      providerAdapters: { tailscale: createTailscaleAdapter() },
      prompts: {
        ask: async (question, fallback) => {
          if (question === "Static IP for Tailscale") return "10.0.0.60";
          if (question === "LXC hostname") return fallback;
          return fallback;
        },
        confirm: async () => true
      }
    }
  );

  assert.match(result.stdout, /10\.0\.0\.60/);
  assert.match(result.stdout, /Tailscale provisioned/i);
});

test("nomina init with VPN provider selects the VPN in the managed inventory", async () => {
  const filesystem = new FakeFilesystem();

  await runCli(["init"], {
    filesystem,
    cwd: "/projects/home",
    runtime: { isRoot: () => true, isProxmoxHost: () => true },
    prompts: {
      ask: async (question) => {
        const answers = {
          "Proxmox node": "pve-1",
          "Default network bridge": "vmbr0",
          "Default storage target": "local-lvm",
          "Base local domain": "home.test"
        };
        return answers[question];
      },
      select: async ({ message }) => {
        if (message === "DNS provider") return "technitium";
        if (message === "Reverse proxy") return "caddy";
        if (message === "Certificate authority") return "none";
        if (message === "VPN provider") return "tailscale";
        throw new Error(`Unexpected select: ${message}`);
      }
    }
  });

  const config = filesystem.read("/projects/home/nomina.yaml");
  assert.match(config, /service: tailscale/);
  assert.ok(!config.includes("vpn: null"));
});
