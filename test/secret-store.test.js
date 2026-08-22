import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";
import { createLocalSecretStore, createProductionAdapters } from "../src/adapter-runtime.js";

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

function createProxmoxAdapter() {
  return {
    checkIpAvailability() {
      return { status: "available" };
    },
    createLxc(spec) {
      return { vmid: 120, hostname: spec.hostname };
    },
    pctExec() {
      return { exitCode: 0, stdout: "ok" };
    }
  };
}

function createTechnitiumAdapter() {
  return {
    setup(plan) {
      return { ...plan, lxcCommands: ["install-technitium"] };
    },
    inspect() {
      return { resources: [] };
    },
    adopt(request) {
      return { managedInventoryUpdate: request.managed };
    },
    healthCheck() {
      return { process: "running", endpoint: "reachable" };
    }
  };
}

function createMemorySecretStore(initial = {}) {
  const secrets = new Map(Object.entries(initial));
  return {
    has: (reference) => secrets.has(reference),
    store: (reference, value) => {
      secrets.set(reference, value);
    },
    get: (reference) => secrets.get(reference)
  };
}

test("local secret store writes root-owned 0600 files inside a 0700 directory", () => {
  const ops = [];
  const store = createLocalSecretStore({
    isRoot: () => true,
    filesystem: {
      statSync: () => {
        throw Object.assign(new Error("no such file"), { code: "ENOENT" });
      },
      mkdirSync: (directory, options) => ops.push(["mkdir", directory, options]),
      writeFileSync: (path, content) => ops.push(["write", path, content]),
      chmodSync: (path, mode) => ops.push(["chmod", path, mode])
    }
  });

  const reference = "nominaconnect/provider/nc_dns";
  assert.equal(store.has(reference), false);
  store.store(reference, "top-secret");

  assert.equal(store.locate(reference), "/var/lib/nominaconnect/secrets/nominaconnect/provider/nc_dns");
  assert.deepEqual(ops, [
    ["mkdir", "/var/lib/nominaconnect/secrets/nominaconnect/provider", { recursive: true }],
    ["write", "/var/lib/nominaconnect/secrets/nominaconnect/provider/nc_dns", "top-secret\n"],
    ["chmod", "/var/lib/nominaconnect/secrets/nominaconnect/provider", 0o700],
    ["chmod", "/var/lib/nominaconnect/secrets/nominaconnect/provider/nc_dns", 0o600]
  ]);
});

test("local secret store reports existing references and rejects unsafe stores", () => {
  const store = createLocalSecretStore({
    filesystem: {
      statSync: () => ({ uid: 0, mode: 0o100600 }),
      mkdirSync: () => {},
      writeFileSync: () => {},
      chmodSync: () => {}
    },
    isRoot: () => false
  });

  assert.equal(store.has("nominaconnect/provider/nc_dns"), true);
  assert.throws(
    () => store.store("nominaconnect/provider/nc_dns", "top-secret"),
    /root shell/i
  );

  const rootedStore = createLocalSecretStore({ isRoot: () => true });
  assert.throws(() => rootedStore.store("../outside", "top-secret"), /relative secret reference/i);
  assert.throws(() => rootedStore.store("nominaconnect/provider/nc_dns", "   "), /non-empty string/i);
});

test("production composition includes the local secret store", () => {
  const { secretStore } = createProductionAdapters({
    commandRunner: { async run() { return { exitCode: 0, stdout: "", stderr: "" }; } }
  });
  assert.equal(typeof secretStore.has, "function");
  assert.equal(typeof secretStore.store, "function");
  assert.equal(secretStore.locate("nominaconnect/provider/nc_x"), "/var/lib/nominaconnect/secrets/nominaconnect/provider/nc_x");
});

test("nomina service add technitium prompts for and stores the missing connection secret", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const secretStore = createMemorySecretStore();
  const askedQuestions = [];

  const result = await runCli(
    ["service", "add", "technitium", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.53"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox: createProxmoxAdapter(),
      providerAdapters: { technitium: createTechnitiumAdapter() },
      secretStore,
      prompts: {
        secret: async (question) => {
          askedQuestions.push(question);
          return "s3cret-password";
        }
      }
    }
  );

  assert.match(result.stdout, /Technitium provisioned/i);
  assert.deepEqual(askedQuestions, ["Connection secret for Technitium"]);
  assert.equal(secretStore.get("nominaconnect/provider/nc_dns_test"), "s3cret-password");
});

test("nomina service add technitium does not re-prompt when the connection secret is stored", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const secretStore = createMemorySecretStore({
    "nominaconnect/provider/nc_dns_test": "existing-secret"
  });

  const result = await runCli(
    ["service", "add", "technitium", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.53"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox: createProxmoxAdapter(),
      providerAdapters: { technitium: createTechnitiumAdapter() },
      secretStore,
      prompts: {
        secret: async () => {
          throw new Error("should not prompt for an existing connection secret");
        }
      }
    }
  );

  assert.match(result.stdout, /Technitium provisioned/i);
});

test("nomina service add technitium rejects an unstored connection secret without an interactive prompt", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);

  await assert.rejects(
    runCli(
      ["service", "add", "technitium", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.53"],
      {
        filesystem,
        runtime: proxmoxRootRuntime(),
        proxmox: createProxmoxAdapter(),
        providerAdapters: { technitium: createTechnitiumAdapter() },
        secretStore: createMemorySecretStore()
      }
    ),
    /No connection secret is stored for Technitium/i
  );
});
