import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";

const proxmoxRootRuntime = () => ({ isRoot: () => true, isProxmoxHost: () => true });

class FakeFilesystem {
  files = new Map();
  directories = new Set();

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

  chmod() {}

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
  tracking: { notices: [] }
};

function seedProvisionedProject(filesystem, projectDir = "/projects/bunnyhome") {
  filesystem.mkdir(projectDir);
  filesystem.mkdir(`${projectDir}/.nomina`);
  filesystem.writeFile(`${projectDir}/nomina.yaml`, PROVISIONED_PROJECT);
  filesystem.writeFile(`${projectDir}/.nomina/state.json`, `${JSON.stringify(PROVISIONED_STATE, null, 2)}\n`);
}

function createTechnitiumAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "bunnyhome.test", record: "bunnyhome.test NS localhost" },
      { id: "legacy.bunnyhome.test", record: "legacy.bunnyhome.test A 10.0.0.9" }
    ],
    publishCalls: []
  };
  return {
    publishCalls: state.publishCalls,
    inspect() {
      return { resources: state.resources.map((resource) => ({ ...resource })) };
    },
    publishRecord(request) {
      state.publishCalls.push(request);
      state.resources = state.resources.filter((resource) => resource.id !== request.hostname);
      state.resources.push({ id: request.hostname, record: `${request.hostname} A ${request.ip}` });
      return { id: request.hostname, record: `${request.hostname} A ${request.ip}` };
    },
    healthCheckExposure(request) {
      return overrides.exposureHealth?.(request) ?? { dns: "reachable", status: "healthy" };
    },
    healthCheck() {
      return { process: "running", endpoint: "reachable" };
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
    inspect() {
      return { resources: state.resources.map((resource) => ({ ...resource })) };
    },
    publishRoute(request) {
      state.publishCalls.push(request);
      state.resources = state.resources.filter((resource) => resource.id !== request.hostname);
      state.resources.push({
        id: request.hostname,
        route: `https://${request.hostname} -> ${request.backendIp}:${request.backendPort}`
      });
      return {
        id: request.hostname,
        route: `https://${request.hostname} -> ${request.backendIp}:${request.backendPort}`
      };
    },
    healthCheckExposure(request) {
      return overrides.exposureHealth?.(request) ?? { https: "reachable", status: "healthy" };
    },
    healthCheck() {
      return { process: "running", endpoint: "reachable" };
    }
  };
}

test("nomina exposure publish creates Technitium record and Caddy HTTPS route together", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const technitium = createTechnitiumAdapter();
  const caddy = createCaddyAdapter();

  const result = await runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", "photos",
      "--hostname", "photos.bunnyhome.test",
      "--backend-ip", "10.0.0.100",
      "--backend-port", "8080"
    ],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      providerAdapters: { technitium, caddy }
    }
  );

  assert.match(result.stdout, /photos\.bunnyhome\.test/i);
  assert.match(result.stdout, /published/i);
  assert.match(result.stdout, /healthy/i);
  assert.equal(technitium.publishCalls.length, 1);
  assert.equal(caddy.publishCalls.length, 1);
  assert.equal(technitium.publishCalls[0].hostname, "photos.bunnyhome.test");
  assert.equal(technitium.publishCalls[0].ip, "10.0.0.100");
  assert.equal(caddy.publishCalls[0].hostname, "photos.bunnyhome.test");
  assert.equal(caddy.publishCalls[0].backendIp, "10.0.0.100");
  assert.equal(caddy.publishCalls[0].backendPort, 8080);
  assert.equal(caddy.publishCalls[0].protocol, "https");

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /photos\.bunnyhome\.test/);
  assert.match(config, /10\.0\.0\.100/);

  const dnsInspection = technitium.inspect().resources;
  assert.deepEqual(
    dnsInspection.find((resource) => resource.id === "legacy.bunnyhome.test"),
    { id: "legacy.bunnyhome.test", record: "legacy.bunnyhome.test A 10.0.0.9" }
  );
  assert.ok(dnsInspection.some((resource) => resource.id === "photos.bunnyhome.test"));

  const proxyInspection = caddy.inspect().resources;
  assert.deepEqual(
    proxyInspection.find((resource) => resource.id === "existing.bunnyhome.test"),
    { id: "existing.bunnyhome.test", route: "https://existing.bunnyhome.test" }
  );
  assert.ok(proxyInspection.some((resource) => resource.id === "photos.bunnyhome.test"));
});

test("nomina exposure publish updates an existing managed hostname", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const technitium = createTechnitiumAdapter({
    resources: [
      { id: "bunnyhome.test", record: "bunnyhome.test NS localhost" },
      { id: "photos.bunnyhome.test", record: "photos.bunnyhome.test A 10.0.0.99" }
    ]
  });
  const caddy = createCaddyAdapter({
    resources: [
      { id: "photos.bunnyhome.test", route: "https://photos.bunnyhome.test -> 10.0.0.99:8080" }
    ]
  });

  await runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", "photos",
      "--hostname", "photos.bunnyhome.test",
      "--backend-ip", "10.0.0.100",
      "--backend-port", "8080"
    ],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      providerAdapters: { technitium, caddy }
    }
  );

  assert.equal(
    technitium.inspect().resources.find((resource) => resource.id === "photos.bunnyhome.test").record,
    "photos.bunnyhome.test A 10.0.0.100"
  );
  assert.match(
    caddy.inspect().resources.find((resource) => resource.id === "photos.bunnyhome.test").route,
    /10\.0\.0\.100:8080/
  );
});

test("nomina exposure publish requires Caddy and Technitium to be provisioned", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  delete state.providerReferences.nc_proxy_test;
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify(state, null, 2)}\n`);

  await assert.rejects(
    runCli(
      [
        "exposure", "publish",
        "--project-dir", "/projects/bunnyhome",
        "--name", "photos",
        "--hostname", "photos.bunnyhome.test",
        "--backend-ip", "10.0.0.100",
        "--backend-port", "8080"
      ],
      { filesystem, runtime: proxmoxRootRuntime(), providerAdapters: {} }
    ),
    /Caddy must be provisioned/i
  );
});

test("nomina exposure publish reports unhealthy connected exposure", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);

  const result = await runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", "photos",
      "--hostname", "photos.bunnyhome.test",
      "--backend-ip", "10.0.0.100",
      "--backend-port", "8080"
    ],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      providerAdapters: {
        technitium: createTechnitiumAdapter({
          exposureHealth: () => ({ dns: "unreachable", status: "unhealthy" })
        }),
        caddy: createCaddyAdapter({
          exposureHealth: () => ({ https: "unreachable", status: "unhealthy" })
        })
      }
    }
  );

  assert.equal(result.health.status, "unhealthy");
  assert.match(result.stdout, /unhealthy/i);
});
