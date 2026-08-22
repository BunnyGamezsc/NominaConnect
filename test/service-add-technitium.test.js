import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";

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
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test
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
      return { vmid: overrides.vmid ?? 120, hostname: spec.hostname };
    },
    pctExec(vmid, command) {
      execCalls.push({ vmid, command });
      return overrides.pctExec?.(vmid, command) ?? { exitCode: 0, stdout: "ok" };
    }
  };
}

function createTechnitiumAdapter(overrides = {}) {
  const resources = overrides.resources ?? [
    { id: "bunnyhome.test", record: "bunnyhome.test NS localhost" }
  ];
  return {
    setup(plan) {
      return {
        ...plan,
        lxcCommands: ["install-technitium", "configure-managed-zones"]
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

test("nomina service add technitium provisions an unprivileged Debian LXC with defaults", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const proxmox = createProxmoxAdapter();

  const result = await runCli(
    ["service", "add", "technitium", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.53"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { technitium: createTechnitiumAdapter() }
    }
  );

  assert.match(result.stdout, /Technitium provisioned/i);
  assert.match(result.stdout, /10\.0\.0\.53/);
  assert.equal(proxmox.created.length, 1);
  assert.deepEqual(proxmox.created[0], {
    node: "pve-1",
    hostname: "technitium",
    ip: "10.0.0.53",
    bridge: "vmbr0",
    storage: "local-lvm",
    unprivileged: true,
    template: "debian-12-standard",
    gateway: "10.0.0.1",
    nameserver: "10.0.0.1",
    resources: { cpus: 2, memoryMb: 1024, diskGb: 8 }
  });
  assert.deepEqual(
    proxmox.execCalls.map((call) => call.command),
    ["install-technitium", "configure-managed-zones"]
  );

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /ip: 10\.0\.0\.53/);
  assert.match(config, /hostname: technitium/);

  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.deepEqual(state.providerReferences.nc_dns_test, { vmid: 120, ip: "10.0.0.53" });
  assert.equal(result.health.status, "healthy");
  assert.deepEqual(result.inspection.managed.length, 1);
});

test("nomina service add technitium blocks provisioning when the requested IP is known to collide", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const proxmox = createProxmoxAdapter({
    ipAvailability: () => ({ status: "known-collision", conflictWith: "existing-lxc/115" })
  });

  await assert.rejects(
    runCli(
      ["service", "add", "technitium", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.53"],
      { filesystem, runtime: proxmoxRootRuntime(), proxmox, providerAdapters: { technitium: createTechnitiumAdapter() } }
    ),
    /known.*collision|already in use/i
  );
  assert.equal(proxmox.created.length, 0);
});

test("nomina service add technitium warns when wider-network IP availability is uncertain", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const proxmox = createProxmoxAdapter({
    ipAvailability: () => ({ status: "uncertain", reason: "no arp response from upstream network" })
  });

  const result = await runCli(
    ["service", "add", "technitium", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.53"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { technitium: createTechnitiumAdapter() }
    }
  );

  assert.match(result.stdout, /warning/i);
  assert.match(result.stdout, /uncertain|cannot determine/i);
  assert.equal(proxmox.created.length, 1);
  assert.deepEqual(result.warnings, [
    "Requested IP 10.0.0.53 availability is uncertain: no arp response from upstream network."
  ]);
});

test("nomina service add technitium accepts resource, bridge, storage, and hostname overrides", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const proxmox = createProxmoxAdapter();

  await runCli(
    [
      "service", "add", "technitium",
      "--project-dir", "/projects/bunnyhome",
      "--ip", "10.0.0.54",
      "--bridge", "vmbr1",
      "--storage", "local-zfs",
      "--hostname", "dns-primary",
      "--cpus", "4",
      "--memory", "2048",
      "--disk", "16"
    ],
    { filesystem, runtime: proxmoxRootRuntime(), proxmox, providerAdapters: { technitium: createTechnitiumAdapter() } }
  );

  assert.deepEqual(proxmox.created[0], {
    node: "pve-1",
    hostname: "dns-primary",
    ip: "10.0.0.54",
    bridge: "vmbr1",
    storage: "local-zfs",
    unprivileged: true,
    template: "debian-12-standard",
    gateway: "10.0.0.1",
    nameserver: "10.0.0.1",
    resources: { cpus: 4, memoryMb: 2048, diskGb: 16 }
  });
});

test("nomina service add technitium uses the --template override when creating the LXC", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const proxmox = createProxmoxAdapter();

  await runCli(
    [
      "service", "add", "technitium",
      "--project-dir", "/projects/bunnyhome",
      "--ip", "10.0.0.53",
      "--template", "local:vztmpl/debian-13-standard_13.7-1_amd64.tar.zst"
    ],
    { filesystem, runtime: proxmoxRootRuntime(), proxmox, providerAdapters: { technitium: createTechnitiumAdapter() } }
  );

  assert.equal(proxmox.created[0].template, "local:vztmpl/debian-13-standard_13.7-1_amd64.tar.zst");
});

test("nomina service add technitium derives the gateway and nameserver, honoring explicit overrides", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const proxmox = createProxmoxAdapter();

  await runCli(
    ["service", "add", "technitium", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.53"],
    { filesystem, runtime: proxmoxRootRuntime(), proxmox, providerAdapters: { technitium: createTechnitiumAdapter() } }
  );
  assert.equal(proxmox.created[0].gateway, "10.0.0.1");
  assert.equal(proxmox.created[0].nameserver, "10.0.0.1");

  const proxmoxOverride = createProxmoxAdapter();
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify(INITIAL_STATE, null, 2)}\n`);
  await runCli(
    [
      "service", "add", "technitium",
      "--project-dir", "/projects/bunnyhome",
      "--ip", "10.0.9.77",
      "--gateway", "10.0.9.254",
      "--nameserver", "10.0.9.53"
    ],
    { filesystem, runtime: proxmoxRootRuntime(), proxmox: proxmoxOverride, providerAdapters: { technitium: createTechnitiumAdapter() } }
  );
  assert.equal(proxmoxOverride.created[0].gateway, "10.0.9.254");
  assert.equal(proxmoxOverride.created[0].nameserver, "10.0.9.53");
});

test("nomina service add technitium offers detected templates for selection instead of defaulting to debian-12", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const proxmox = createProxmoxAdapter();
  proxmox.listTemplates = async () => [
    "local:vztmpl/debian-11-standard_11.7-1_amd64.tar.zst",
    "local:vztmpl/debian-13-standard_13.7-1_amd64.tar.zst"
  ];
  const selections = [];
  const prompts = {
    select: async ({ message, options, initialValue }) => {
      selections.push({ message, options: options.map((option) => option.value), initialValue });
      return "local:vztmpl/debian-13-standard_13.7-1_amd64.tar.zst";
    },
    ask: async (question, fallback) => {
      if (question === "Static IP for Technitium") return "10.0.0.53";
      if (question === "LXC hostname") return fallback;
      throw new Error(`Unexpected question: ${question}`);
    },
    confirm: async () => true,
    info: () => {}
  };

  const result = await runCli(
    ["service", "add", "technitium", "--project-dir", "/projects/bunnyhome"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { technitium: createTechnitiumAdapter() },
      prompts
    }
  );

  assert.deepEqual(selections, [{
    message: "LXC template",
    options: [
      "local:vztmpl/debian-11-standard_11.7-1_amd64.tar.zst",
      "local:vztmpl/debian-13-standard_13.7-1_amd64.tar.zst"
    ],
    initialValue: "local:vztmpl/debian-11-standard_11.7-1_amd64.tar.zst"
  }]);
  assert.equal(result.lxcSpec.template, "local:vztmpl/debian-13-standard_13.7-1_amd64.tar.zst");
  assert.equal(proxmox.created[0].template, "local:vztmpl/debian-13-standard_13.7-1_amd64.tar.zst");
  assert.match(filesystem.read("/projects/bunnyhome/nomina.yaml"), /debian-13-standard/);
});

test("nomina service add technitium reports unhealthy health checks", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);

  const result = await runCli(
    ["service", "add", "technitium", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.53"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox: createProxmoxAdapter(),
      providerAdapters: {
        technitium: createTechnitiumAdapter({
          health: { process: "stopped", endpoint: "unreachable" }
        })
      }
    }
  );

  assert.equal(result.health.status, "unhealthy");
  assert.match(result.stdout, /unhealthy/i);
});

test("nomina service add technitium rejects provisioning outside the Proxmox root shell", async () => {
  await assert.rejects(
    runCli(
      ["service", "add", "technitium", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.53"],
      {
        filesystem: new FakeFilesystem(),
        runtime: { isRoot: () => false, isProxmoxHost: () => true },
        proxmox: createProxmoxAdapter()
      }
    ),
    /must run as root/i
  );
});

test("nomina service add technitium requires an initialized project", async () => {
  const filesystem = new FakeFilesystem();

  await assert.rejects(
    runCli(
      ["service", "add", "technitium", "--project-dir", "/projects/missing", "--ip", "10.0.0.53"],
      { filesystem, runtime: proxmoxRootRuntime(), proxmox: createProxmoxAdapter() }
    ),
    /no NominaConnect project/i
  );
});

test("nomina service add technitium rejects a second provisioning attempt", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  state.providerReferences.nc_dns_test = { vmid: 120, ip: "10.0.0.53" };
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify(state, null, 2)}\n`);

  await assert.rejects(
    runCli(
      ["service", "add", "technitium", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.53"],
      { filesystem, runtime: proxmoxRootRuntime(), proxmox: createProxmoxAdapter() }
    ),
    /already provisioned/i
  );
});
