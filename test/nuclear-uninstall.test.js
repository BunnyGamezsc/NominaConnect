import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";
import { buildMenuOptions } from "../src/tui.js";

const proxmoxRootRuntime = () => ({ isRoot: () => true, isProxmoxHost: () => true });

class FakeFilesystem {
  files = new Map();
  directories = new Set();
  deleted = [];

  exists(path) {
    return this.files.has(path) || this.directories.has(path);
  }
  mkdir(path) {
    const segments = path.split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current += `/${segment}`;
      this.directories.add(current);
    }
  }
  writeFile(path, content) {
    this.files.set(path, content);
  }
  rename(from, to) {
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
  }
  chmod() {}
  read(path) {
    return this.files.get(path);
  }
  deletePath(path) {
    this.deleted.push(path);
    for (const file of [...this.files.keys()]) {
      if (file === path || file.startsWith(`${path}/`)) {
        this.files.delete(file);
      }
    }
    this.directories.delete(path);
  }
}

const PROJECT_YAML = `apiVersion: nomina.connect/v0alpha1
kind: NominaConnect
proxmox:
  node: pve-1
  defaultBridge: vmbr0
  defaultStorage: local-lvm
baseLocalDomain: bunny.internal
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
    certificateAuthority:
      id: nc_ca_test
      service: step-ca
      deployment:
        ip: 10.0.0.55
        hostname: step-ca
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
`;

function seed(filesystem) {
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.mkdir("/var/lib/nominaconnect/secrets");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", PROJECT_YAML);
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify({
    version: 1,
    providerReferences: {
      nc_dns_test: { vmid: 100, ip: "10.0.0.53" },
      nc_proxy_test: { vmid: 101, ip: "10.0.0.54" },
      nc_ca_test: { vmid: 102, ip: "10.0.0.55" }
    },
    retainedServices: {
      nc_old_test: { vmid: 100, ip: "10.0.0.90", service: "technitium", removedAt: "2026-08-23T00:00:00Z" }
    },
    tracking: { notices: [] }
  }, null, 2)}
`);
  filesystem.writeFile("/var/lib/nominaconnect/secrets/nc_dns_test", "secret");
}

function createProxmoxAdapter() {
  const calls = [];
  return {
    calls,
    async stopLxc(vmid) {
      calls.push(["stop", vmid]);
    },
    async destroyLxc(vmid) {
      calls.push(["destroy", vmid]);
    }
  };
}

test("nuclear uninstall destroys every provisioned and retained LXC once and removes config, state, and secrets", async () => {
  const filesystem = new FakeFilesystem();
  seed(filesystem);
  const proxmox = createProxmoxAdapter();

  const result = await runCli(
    ["uninstall", "--yes", "--project-dir", "/projects/bunnyhome"],
    { filesystem, runtime: proxmoxRootRuntime(), proxmox }
  );

  assert.match(result.stdout, /100/);
  assert.match(result.stdout, /101/);
  assert.match(result.stdout, /102/);

  // Retained vmid 100 duplicates the provisioned one; must be destroyed exactly once.
  const destroyedCalls = proxmox.calls.filter(([kind]) => kind === "destroy");
  assert.deepEqual(destroyedCalls.map(([, vmid]) => vmid).sort((a, b) => a - b), [100, 101, 102]);
  const stoppedVmids = proxmox.calls.filter(([kind]) => kind === "stop").map(([, vmid]) => vmid);
  for (const vmid of [100, 101, 102]) {
    assert.equal(stoppedVmids.includes(vmid), true, `vmid ${vmid} must be stopped before destroy`);
  }

  assert.equal(filesystem.exists("/projects/bunnyhome/nomina.yaml"), false, "nomina.yaml must be deleted");
  assert.equal(filesystem.exists("/projects/bunnyhome/.nomina/state.json"), false, "state.json must be deleted");
  assert.equal(filesystem.exists("/var/lib/nominaconnect/secrets/nc_dns_test"), false, "secrets must be deleted");
  assert.ok(filesystem.deleted.includes("/var/lib/nominaconnect"));
});

test("nuclear uninstall refuses to proceed without confirmation and destroys nothing", async () => {
  const filesystem = new FakeFilesystem();
  seed(filesystem);
  const proxmox = createProxmoxAdapter();

  const result = await runCli(
    ["uninstall", "--project-dir", "/projects/bunnyhome"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      prompts: { confirm: async () => false }
    }
  );

  assert.equal(result.cancelled, true);
  assert.equal(proxmox.calls.length, 0);
  assert.equal(filesystem.exists("/projects/bunnyhome/nomina.yaml"), true);
});

test("nuclear uninstall without a project still clears the global secret store", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/somewhere-else");
  filesystem.mkdir("/var/lib/nominaconnect/secrets");
  filesystem.writeFile("/var/lib/nominaconnect/secrets/leftover", "secret");
  const proxmox = createProxmoxAdapter();

  const result = await runCli(
    ["uninstall", "--yes", "--project-dir", "/somewhere-else"],
    { filesystem, runtime: proxmoxRootRuntime(), proxmox }
  );

  assert.equal(proxmox.calls.length, 0, "no LXC references means nothing to destroy");
  assert.equal(filesystem.exists("/var/lib/nominaconnect/secrets/leftover"), false);
});

test("the interactive menu offers nuclear uninstall only when a project exists", () => {
  const withProject = {
    config: {
      baseLocalDomain: "bunny.internal",
      managedInventory: {
        platform: { dns: { id: "d", service: "technitium" }, reverseProxy: null, certificateAuthority: null, vpn: null },
        services: []
      }
    },
    state: { providerReferences: {} }
  };
  assert.equal(buildMenuOptions(withProject).some((option) => option.value === "nuclear-uninstall"), true);

  assert.equal(buildMenuOptions(undefined).some((option) => option.value === "nuclear-uninstall"), false);
});
