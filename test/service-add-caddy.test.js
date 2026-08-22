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
      deployment:
        ip: 10.0.0.53
        hostname: technitium
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
  providerReferences: {
    nc_dns_test: { vmid: 120, ip: "10.0.0.53" }
  },
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
      return { vmid: overrides.vmid ?? 121, hostname: spec.hostname };
    },
    pctExec(vmid, command) {
      execCalls.push({ vmid, command });
      return overrides.pctExec?.(vmid, command) ?? { exitCode: 0, stdout: "ok" };
    }
  };
}

function createCaddyAdapter(overrides = {}) {
  const resources = overrides.resources ?? [
    { id: "existing.bunnyhome.test", route: "https://existing.bunnyhome.test" }
  ];
  return {
    setup(plan) {
      return {
        ...plan,
        lxcCommands: ["install-caddy", "configure-https-routes"]
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

test("nomina service add caddy provisions an unprivileged Debian LXC with defaults", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const proxmox = createProxmoxAdapter();

  const result = await runCli(
    ["service", "add", "caddy", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.54"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { caddy: createCaddyAdapter() }
    }
  );

  assert.match(result.stdout, /Caddy provisioned/i);
  assert.match(result.stdout, /10\.0\.0\.54/);
  assert.equal(proxmox.created.length, 1);
  assert.deepEqual(proxmox.created[0], {
    node: "pve-1",
    hostname: "caddy",
    ip: "10.0.0.54",
    bridge: "vmbr0",
    storage: "local-lvm",
    unprivileged: true,
    template: "debian-12-standard",
    gateway: "10.0.0.1",
    nameserver: "10.0.0.1",
    resources: { cpus: 2, memoryMb: 512, diskGb: 4 }
  });
  assert.deepEqual(
    proxmox.execCalls.map((call) => call.command),
    ["install-caddy", "configure-https-routes"]
  );

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /ip: 10\.0\.0\.54/);
  assert.match(config, /hostname: caddy/);

  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.deepEqual(state.providerReferences.nc_proxy_test, { vmid: 121, ip: "10.0.0.54" });
  assert.equal(result.health.status, "healthy");
  assert.deepEqual(result.inspection.unmanaged.length, 1);
  assert.deepEqual(result.inspection.managed.length, 0);
});

test("nomina service add caddy requires Technitium to be provisioned first", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  delete state.providerReferences.nc_dns_test;
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify(state, null, 2)}\n`);

  await assert.rejects(
    runCli(
      ["service", "add", "caddy", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.54"],
      { filesystem, runtime: proxmoxRootRuntime(), proxmox: createProxmoxAdapter(), providerAdapters: { caddy: createCaddyAdapter() } }
    ),
    /Technitium must be provisioned/i
  );
});

test("nomina service add caddy rejects a second provisioning attempt", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  state.providerReferences.nc_proxy_test = { vmid: 121, ip: "10.0.0.54" };
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify(state, null, 2)}\n`);

  await assert.rejects(
    runCli(
      ["service", "add", "caddy", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.54"],
      { filesystem, runtime: proxmoxRootRuntime(), proxmox: createProxmoxAdapter() }
    ),
    /already provisioned/i
  );
});

test("nomina service add caddy reports unhealthy health checks", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);

  const result = await runCli(
    ["service", "add", "caddy", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.54"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox: createProxmoxAdapter(),
      providerAdapters: {
        caddy: createCaddyAdapter({
          health: { process: "stopped", endpoint: "unreachable" }
        })
      }
    }
  );

  assert.equal(result.health.status, "unhealthy");
  assert.match(result.stdout, /unhealthy/i);
});
