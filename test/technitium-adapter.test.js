import test from "node:test";
import assert from "node:assert/strict";

import { createProductionAdapters } from "../src/adapter-runtime.js";
import { createTechnitiumAdapter } from "../src/technitium-adapter.js";
import { runCli } from "../src/cli.js";

test("technitium install plan installs curl before downloading the installer", async () => {
  const adapter = createTechnitiumAdapter({ httpClient: {}, secretResolver: {} });
  const plan = await adapter.setup({});

  assert.deepEqual(plan.lxcCommands.slice(0, 2), [
    { binary: "/usr/bin/apt-get", args: ["update"] },
    { binary: "/usr/bin/apt-get", args: ["install", "--yes", "curl", "ca-certificates"] }
  ]);
  assert.equal(plan.lxcCommands[2].binary, "/usr/bin/curl");
  assert.equal(plan.lxcCommands[3].binary, "/bin/bash");

  const upgradePlan = await adapter.upgrade({});
  assert.deepEqual(upgradePlan.lxcCommands, plan.lxcCommands);
});

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

function seedProject(filesystem, projectDir = "/projects/bunnyhome") {
  filesystem.mkdir(projectDir);
  filesystem.mkdir(`${projectDir}/.nomina`);
  filesystem.writeFile(`${projectDir}/nomina.yaml`, INITIALIZED_PROJECT);
  filesystem.writeFile(`${projectDir}/.nomina/state.json`, `${JSON.stringify({
    version: 1,
    providerReferences: {},
    tracking: { notices: [] }
  }, null, 2)}\n`);
}

function createProxmoxCommandFixture(overrides = {}) {
  const commands = [];
  return {
    commands,
    async run(command) {
      commands.push({ binary: command.binary, args: [...command.args] });
      if (overrides.run) {
        const overridden = await overrides.run(command, commands);
        if (overridden !== undefined) {
          return overridden;
        }
      }
      if (command.binary === "/usr/sbin/pvesm" && command.args[0] === "status") {
        return { exitCode: 0, stdout: "Name             Type     Status\nlocal            dir      active\nlocal-lvm        lvmthin  active\n", stderr: "" };
      }
      if (command.binary === "/usr/bin/pveam" && command.args[0] === "list") {
        return {
          exitCode: 0,
          stdout: "NAME                                                         SIZE\nlocal:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst        117.77MB\n",
          stderr: ""
        };
      }
      if (command.binary === "/usr/bin/ip") {
        if (overrides.missingBridge) {
          return { exitCode: 1, stdout: "", stderr: "Device \"vmbr0\" does not exist.\n" };
        }
        return { exitCode: 0, stdout: "2: vmbr0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n", stderr: "" };
      }
      if (command.binary === "/usr/bin/grep") {
        if (overrides.missingUnprivileged) {
          return { exitCode: 1, stdout: "", stderr: "" };
        }
        return { exitCode: 0, stdout: "root:100000:65536\n", stderr: "" };
      }
      if (command.binary === "/usr/sbin/pct" && command.args[0] === "list") {
        const ip = overrides.collisionIp;
        const stdout = ip === undefined
          ? "VMID STATUS LOCK NAME\n100 running - pve\n"
          : `VMID STATUS LOCK NAME\n115 running - existing  ${ip}\n`;
        return { exitCode: 0, stdout, stderr: "" };
      }
      if (command.binary === "/usr/bin/pvesh" && command.args[0] === "get") {
        return { exitCode: 0, stdout: "120\n", stderr: "" };
      }
      if (command.binary === "/usr/sbin/pct" && command.args[0] === "create") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.binary === "/usr/sbin/pct" && command.args[0] === "config") {
        return {
          exitCode: 0,
          stdout: [
            "hostname: technitium",
            "cores: 2",
            "memory: 1024",
            "net0: name=eth0,bridge=vmbr0,ip=10.0.0.53/24",
            "rootfs: local-lvm:vm-120-disk-0,size=8G",
            "unprivileged: 1",
            ""
          ].join("\n"),
          stderr: ""
        };
      }
      if (command.binary === "/usr/sbin/pct" && command.args[0] === "exec") {
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    }
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function createTechnitiumHttpFixture({ password = "top-secret" } = {}) {
  const zones = new Map();
  const recordsByZone = new Map();
  const requests = [];
  let token = "session-token";

  function zoneRecords(zone) {
    const name = zone.replace(/\.$/, "");
    if (!recordsByZone.has(name)) {
      recordsByZone.set(name, []);
    }
    return recordsByZone.get(name);
  }

  function seedZone(zone, records = []) {
    const name = zone.replace(/\.$/, "");
    zones.set(name, { name, type: "Primary" });
    recordsByZone.set(name, records.map((record) => ({ ...record })));
  }

  seedZone("bunnyhome.test", [
    { name: "bunnyhome.test", type: "SOA", rData: { primaryNameServer: "technitium" } },
    { name: "legacy.bunnyhome.test", type: "A", rData: { ipAddress: "10.0.0.9" } }
  ]);

  async function fetch(url, options = {}) {
    const parsed = new URL(url);
    const params = parsed.searchParams;
    const authorization = options.headers?.Authorization ?? options.headers?.authorization;
    requests.push({
      method: options.method ?? "GET",
      path: parsed.pathname,
      query: Object.fromEntries(params.entries()),
      authorization,
      url
    });

    if (parsed.pathname === "/api/user/login") {
      if (params.get("user") === "admin" && params.get("pass") === password) {
        return jsonResponse({ status: "ok", token });
      }
      return jsonResponse({ status: "error", errorMessage: "Invalid username or password." });
    }

    if (authorization !== `Bearer ${token}`) {
      return jsonResponse({ status: "invalid-token", errorMessage: "Invalid token or session expired." });
    }

    if (parsed.pathname === "/api/user/session/get") {
      return jsonResponse({ status: "ok", username: "admin" });
    }

    if (parsed.pathname === "/api/zones/list") {
      return jsonResponse({
        status: "ok",
        response: { zones: [...zones.values()] }
      });
    }

    if (parsed.pathname === "/api/zones/create") {
      const zone = params.get("zone");
      if (zones.has(zone)) {
        return jsonResponse({ status: "error", errorMessage: "Zone already exists." });
      }
      seedZone(zone, [{ name: zone, type: "SOA", rData: { primaryNameServer: "technitium" } }]);
      return jsonResponse({ status: "ok", response: { domain: zone } });
    }

    if (parsed.pathname === "/api/zones/records/get") {
      const zone = params.get("zone") ?? params.get("domain");
      return jsonResponse({
        status: "ok",
        response: {
          zone: zones.get(zone) ?? { name: zone, type: "Primary" },
          records: zoneRecords(zone).map((record) => ({ ...record, rData: { ...record.rData } }))
        }
      });
    }

    if (parsed.pathname === "/api/zones/records/add") {
      const zone = params.get("zone");
      const name = params.get("domain");
      const type = params.get("type");
      const record = { name, type, rData: { ipAddress: params.get("ipAddress") } };
      const records = zoneRecords(zone);
      if (params.get("overwrite") === "true") {
        recordsByZone.set(zone, records.filter((existing) => !(existing.name === name && existing.type === type)));
      }
      zoneRecords(zone).push(record);
      return jsonResponse({ status: "ok" });
    }

    if (parsed.pathname === "/api/zones/records/update") {
      const zone = params.get("zone");
      const name = params.get("domain");
      const current = zoneRecords(zone).find((record) => record.name === name && record.type === params.get("type"));
      if (current === undefined) {
        return jsonResponse({ status: "error", errorMessage: "Record not found." });
      }
      current.rData.ipAddress = params.get("newIpAddress") ?? current.rData.ipAddress;
      return jsonResponse({ status: "ok" });
    }

    if (parsed.pathname === "/api/zones/records/delete") {
      const zone = params.get("zone");
      const name = params.get("domain");
      const type = params.get("type");
      const ipAddress = params.get("ipAddress");
      recordsByZone.set(zone, zoneRecords(zone).filter((record) => {
        return !(record.name === name && record.type === type && record.rData.ipAddress === ipAddress);
      }));
      return jsonResponse({ status: "ok" });
    }

    return jsonResponse({ status: "error", errorMessage: `Unknown path ${parsed.pathname}` }, 404);
  }

  return { fetch, requests, zones, recordsByZone, seedZone };
}

test("production Proxmox adapter validates template, storage, bridge, IP, and unprivileged LXC before create", async () => {
  const runner = createProxmoxCommandFixture();
  const { proxmox } = createProductionAdapters({ commandRunner: runner });

  await assert.rejects(
    proxmox.createLxc({
      hostname: "technitium",
      ip: "10.0.0.53",
      bridge: "vmbr0",
      storage: "missing-store",
      unprivileged: true,
      template: "debian-12-standard",
      gateway: "10.0.0.1",
      nameserver: "10.0.0.1",
      resources: { cpus: 2, memoryMb: 1024, diskGb: 8 }
    }),
    /storage.*missing-store/i
  );
  assert.equal(runner.commands.some((command) => command.args[0] === "create"), false);

  const missingTemplate = createProxmoxCommandFixture({
    run: async (command) => {
      if (command.binary === "/usr/bin/pveam") {
        return { exitCode: 0, stdout: "NAME SIZE\n", stderr: "" };
      }
      return undefined;
    }
  });
  await assert.rejects(
    createProductionAdapters({ commandRunner: missingTemplate }).proxmox.createLxc({
      hostname: "technitium",
      ip: "10.0.0.53",
      bridge: "vmbr0",
      storage: "local-lvm",
      unprivileged: true,
      template: "debian-12-standard",
      gateway: "10.0.0.1",
      nameserver: "10.0.0.1",
      resources: { cpus: 2, memoryMb: 1024, diskGb: 8 }
    }),
    /template.*debian-12-standard/i
  );

  await assert.rejects(
    createProductionAdapters({ commandRunner: createProxmoxCommandFixture({ missingBridge: true }) }).proxmox.createLxc({
      hostname: "technitium",
      ip: "10.0.0.53",
      bridge: "vmbr0",
      storage: "local-lvm",
      unprivileged: true,
      template: "debian-12-standard",
      gateway: "10.0.0.1",
      nameserver: "10.0.0.1",
      resources: { cpus: 2, memoryMb: 1024, diskGb: 8 }
    }),
    /bridge.*vmbr0/i
  );

  await assert.rejects(
    createProductionAdapters({ commandRunner: createProxmoxCommandFixture({ missingUnprivileged: true }) }).proxmox.createLxc({
      hostname: "technitium",
      ip: "10.0.0.53",
      bridge: "vmbr0",
      storage: "local-lvm",
      unprivileged: true,
      template: "debian-12-standard",
      gateway: "10.0.0.1",
      nameserver: "10.0.0.1",
      resources: { cpus: 2, memoryMb: 1024, diskGb: 8 }
    }),
    /unprivileged/i
  );

  await assert.rejects(
    createProductionAdapters({ commandRunner: createProxmoxCommandFixture({ collisionIp: "10.0.0.53" }) }).proxmox.createLxc({
      hostname: "technitium",
      ip: "10.0.0.53",
      bridge: "vmbr0",
      storage: "local-lvm",
      unprivileged: true,
      template: "debian-12-standard",
      gateway: "10.0.0.1",
      nameserver: "10.0.0.1",
      resources: { cpus: 2, memoryMb: 1024, diskGb: 8 }
    }),
    /already in use|known-collision|lxc\/115/i
  );
});

test("production Proxmox adapter creates, inspects, and controls LXCs with local pct commands", async () => {
  const runner = createProxmoxCommandFixture();
  const { proxmox } = createProductionAdapters({ commandRunner: runner });
  const spec = {
    hostname: "technitium",
    ip: "10.0.0.53",
    bridge: "vmbr0",
    storage: "local-lvm",
    unprivileged: true,
    template: "debian-12-standard",
    gateway: "10.0.0.1",
    nameserver: "10.0.0.1",
    resources: { cpus: 2, memoryMb: 1024, diskGb: 8 }
  };

  const created = await proxmox.createLxc(spec);
  const inspected = await proxmox.inspectLxc(created.vmid);
  await proxmox.pctExec(created.vmid, { binary: "/usr/bin/systemctl", args: ["is-active", "dns"] });

  assert.deepEqual(created, { vmid: 120, hostname: "technitium" });
  assert.equal(inspected.unprivileged, true);
  assert.equal(inspected.hostname, "technitium");
  assert.equal(inspected.ip, "10.0.0.53");
  assert.equal(inspected.bridge, "vmbr0");

  const createCommand = runner.commands.find((command) => command.args[0] === "create");
  assert.equal(createCommand.binary, "/usr/sbin/pct");
  assert.ok(createCommand.args.includes("local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst"));
  assert.ok(createCommand.args.includes("--unprivileged"));
  assert.equal(createCommand.args[createCommand.args.indexOf("--unprivileged") + 1], "1");
  assert.equal(
    runner.commands.findIndex((command) => command.args[0] === "create") >
      runner.commands.findIndex((command) => command.binary === "/usr/sbin/pvesm"),
    true
  );
  assert.deepEqual(
    runner.commands.find((command) => command.args[0] === "exec").args.slice(0, 6),
    ["exec", "120", "--", "/usr/bin/systemctl", "is-active", "dns"]
  );
});

test("Technitium adapter sets up a zone, inspects, adopts, health-checks, and preserves unrelated records", async () => {
  const http = createTechnitiumHttpFixture();
  http.seedZone("other.test", [
    { name: "keep.other.test", type: "A", rData: { ipAddress: "10.0.0.8" } }
  ]);
  const { providerAdapters } = createProductionAdapters({
    httpClient: { request: async (request) => {
      const response = await http.fetch(request.url, { method: request.method, headers: request.headers });
      return { status: response.status, body: await response.text() };
    } },
    secretResolver: { resolve: () => "top-secret" }
  });
  const adapter = providerAdapters.technitium;
  const context = {
    endpoint: "http://10.0.0.53:5380",
    zone: "bunnyhome.test",
    connectionSecretReference: "nominaconnect/provider/nc_dns_test"
  };

  await adapter.configure({ ...context, managedItemId: "nc_dns_test" });
  const published = await adapter.publishRecord({
    ...context,
    hostname: "photos.bunnyhome.test",
    ip: "10.0.0.10"
  });
  assert.equal(published.locator.zone, "bunnyhome.test");
  assert.equal(published.locator.name, "photos.bunnyhome.test");
  assert.equal(published.locator.type, "A");

  const observed = await adapter.inspect(context);
  assert.ok(observed.resources.some((resource) => resource.id === "photos.bunnyhome.test"));
  assert.deepEqual(
    observed.resources.find((resource) => resource.id === "legacy.bunnyhome.test").locator,
    { zone: "bunnyhome.test", name: "legacy.bunnyhome.test", type: "A" }
  );
  assert.ok(observed.resources.some((resource) => resource.id === "keep.other.test"));

  const managed = observed.resources.filter((resource) => resource.id === "photos.bunnyhome.test");
  const record = http.recordsByZone.get("bunnyhome.test").find((item) => item.name === "photos.bunnyhome.test");
  record.rData.ipAddress = "10.0.0.11";
  const afterEdit = await adapter.inspect(context);
  const adopted = await adapter.adopt({
    ...context,
    managed: afterEdit.resources.filter((resource) => resource.id === "photos.bunnyhome.test")
  });
  assert.equal(adopted.managedInventoryUpdate[0].record, "photos.bunnyhome.test A 10.0.0.11");
  assert.notEqual(adopted.managedInventoryUpdate[0].fingerprint, managed[0].fingerprint);

  const updated = await adapter.publishRecord({ ...context, hostname: "photos.bunnyhome.test", ip: "10.0.0.12" });
  await adapter.deleteRecord({ ...context, hostname: "photos.bunnyhome.test", ip: "10.0.0.12", fingerprint: updated.fingerprint });
  const afterDelete = await adapter.inspect(context);
  assert.equal(afterDelete.resources.some((resource) => resource.id === "photos.bunnyhome.test"), false);
  assert.ok(afterDelete.resources.some((resource) => resource.id === "legacy.bunnyhome.test"));
  assert.ok(afterDelete.resources.some((resource) => resource.id === "keep.other.test"));

  await assert.rejects(
    adapter.deleteRecord({ ...context, hostname: "legacy.bunnyhome.test", ip: "10.0.0.9", fingerprint: "wrong-fingerprint" }),
    /does not match managed fingerprint|Aborting deletion to preserve unrelated records/i
  );
  const afterFailedDelete = await adapter.inspect(context);
  assert.ok(afterFailedDelete.resources.some((resource) => resource.id === "legacy.bunnyhome.test"));

  const health = await adapter.healthCheck(context);
  assert.deepEqual(health, { process: "running", endpoint: "reachable" });
  const afterLogin = http.requests.filter((request) => request.path !== "/api/user/login");
  assert.equal(JSON.stringify(afterLogin).includes("top-secret"), false);
  assert.ok(afterLogin.every((request) => request.authorization === "Bearer session-token"));
  assert.equal(http.requests.some((request) => /nc_/.test(JSON.stringify(request.query))), false);
});

test("nomina service add technitium uses production adapters against Proxmox commands and the Technitium API", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const runner = createProxmoxCommandFixture();
  const http = createTechnitiumHttpFixture();
  const adapters = createProductionAdapters({
    commandRunner: runner,
    httpClient: {
      request: async (request) => {
        const response = await http.fetch(request.url, { method: request.method, headers: request.headers });
        return { status: response.status, body: await response.text() };
      }
    },
    secretResolver: { resolve: () => "top-secret" }
  });

  const result = await runCli(
    ["service", "add", "technitium", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.53"],
    { filesystem, runtime: proxmoxRootRuntime(), ...adapters }
  );

  assert.match(result.stdout, /Technitium provisioned/i);
  assert.equal(result.health.status, "healthy");
  assert.ok(runner.commands.some((command) => command.binary === "/usr/sbin/pct" && command.args[0] === "create"));
  assert.ok(runner.commands.some((command) => command.binary === "/usr/sbin/pct" && command.args[0] === "exec"));
  assert.ok(runner.commands.some((command) => command.binary === "/usr/sbin/pct" && command.args[0] === "config"));
  assert.ok(http.requests.some((request) => request.path === "/api/zones/create"));
  assert.ok(http.zones.has("bunnyhome.test"));
  assert.ok(result.inspection.unmanaged.some((resource) => resource.id === "legacy.bunnyhome.test"));
  assert.equal(JSON.stringify(runner.commands).includes("top-secret"), false);
  assert.doesNotMatch(filesystem.read("/projects/bunnyhome/nomina.yaml"), /top-secret/);
});
