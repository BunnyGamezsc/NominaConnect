import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";
import { createCaddyAdapter } from "../src/caddy-adapter.js";

const proxmoxRootRuntime = () => ({ isRoot: () => true, isProxmoxHost: () => true });

class FakeFilesystem {
  files = new Map();
  directories = new Set();
  exists(path) { return this.files.has(path) || this.directories.has(path); }
  mkdir(path) { this.directories.add(path); }
  writeFile(path, content) { this.files.set(path, content); }
  rename(from, to) { this.files.set(to, this.files.get(from)); this.files.delete(from); }
  chmod() {}
  read(path) { return this.files.get(path); }
  deletePath(path) {
    for (const file of [...this.files.keys()]) {
      if (file === path || file.startsWith(`${path}/`)) this.files.delete(file);
    }
    this.directories.delete(path);
  }
}

// --- Wire level ---

class FakeCaddyAdmin {
  constructor(config = {}) {
    this.config = JSON.parse(JSON.stringify(config));
  }
  #traverse(segments) {
    let node = this.config;
    for (const segment of segments) {
      node = node?.[segment];
      if (node === undefined) throw new Error(`missing ${segment}`);
    }
    return node;
  }
  #set(segments, value) {
    let node = this.config;
    for (const segment of segments.slice(0, -1)) {
      if (typeof node[segment] !== "object" || node[segment] === null) node[segment] = {};
      node = node[segment];
    }
    const last = segments.at(-1);
    if (value === undefined) delete node[last]; else node[last] = value;
  }
  async request({ method, url, body }) {
    const path = new URL(url).pathname.replace(/^\/config\/?/, "");
    const segments = path.split("/").filter(Boolean);
    try {
      if (method === "GET") return { status: 200, headers: {}, body: JSON.stringify(this.#traverse(segments)) };
      if (method === "PUT") {
        const parsed = body === undefined || body === "" ? undefined : JSON.parse(body);
        if (segments.length === 0) this.config = parsed ?? {};
        else this.#set(segments, parsed);
        return { status: 200, headers: {}, body: "null" };
      }
      if (method === "DELETE") {
        this.#set(segments, undefined);
        return { status: 200, headers: {}, body: "null" };
      }
      return { status: 405, headers: {}, body: "unsupported" };
    } catch (error) {
      return { status: 404, headers: {}, body: `not found: ${error.message}` };
    }
  }
}

function createAdapter(fake) {
  return createCaddyAdapter({ httpClient: { async request(options) { return fake.request(options); } }, secretResolver: () => {} });
}

test("routes dial TLS backends through Caddy's http transport with skip-verify when backendTls is set", async () => {
  const fake = new FakeCaddyAdmin();
  await createAdapter(fake).publishRoute({
    hostname: "pve.bunny.internal",
    backendIp: "192.168.4.85",
    backendPort: 8006,
    caStrategy: "step-ca",
    tls: { mode: "step-ca", trusted: true },
    backendTls: true,
    ip: "192.168.4.86"
  });

  const route = fake.config.apps.http.servers.srv_https.routes.find((r) => r["@id"] === "pve.bunny.internal");
  assert.equal(route.handle[0].handler, "reverse_proxy");
  assert.deepEqual(route.handle[0].transport, {
    protocol: "http",
    tls: { insecure_skip_verify: true }
  });
});

test("plain HTTP backends get no transport block", async () => {
  const fake = new FakeCaddyAdmin();
  await createAdapter(fake).publishRoute({
    hostname: "app.bunny.internal",
    backendIp: "192.168.4.90",
    backendPort: 8080,
    caStrategy: "none",
    tls: { mode: "untrusted", trusted: false },
    ip: "192.168.4.86"
  });

  const route = fake.config.apps.http.servers.srv_https.routes.find((r) => r["@id"] === "app.bunny.internal");
  assert.equal(route.handle[0].transport, undefined);
});

// --- CLI level ---

function seedProject(filesystem) {
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", `apiVersion: nomina.connect/v0alpha1
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
    certificateAuthority: null
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
`);
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify({
    version: 1,
    providerReferences: {
      nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
      nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
    },
    tracking: { notices: [] }
  }, null, 2)}
`);
}

function createFakes() {
  const calls = [];
  return {
    calls,
    technitium: {
      publishRecord(request) {
        calls.push(["dns", request]);
        return { id: request.hostname };
      },
      inspect() {
        return { resources: [] };
      },
      healthCheckExposure() {
        return { dns: "reachable", status: "healthy" };
      },
      healthCheck() {
        return { process: "running", endpoint: "reachable", status: "healthy" };
      }
    },
    caddy: {
      publishRoute(request) {
        calls.push(["proxy", request]);
        return { id: request.hostname };
      },
      unpublishRoute() {
        return { id: "x" };
      },
      inspect() {
        return { resources: [] };
      },
      healthCheckExposure() {
        return { https: "reachable", status: "healthy" };
      },
      healthCheck() {
        return { process: "running", endpoint: "reachable", status: "healthy" };
      }
    }
  };
}

test("nomina exposure publish --backend-tls stores the flag and dials TLS upstream", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const fakes = createFakes();

  const result = await runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", "pve",
      "--hostname", "pve.bunny.internal",
      "--backend-ip", "10.0.0.1",
      "--backend-port", "8006",
      "--backend-tls"
    ],
    { filesystem, runtime: proxmoxRootRuntime(), providerAdapters: { technitium: fakes.technitium, caddy: fakes.caddy } }
  );

  assert.match(result.stdout, /published/i);

  const proxyCall = fakes.calls.filter(([kind]) => kind === "proxy").at(-1)?.[1];
  assert.equal(proxyCall.backendTls, true);

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /tls: true/, "the backend TLS flag must persist in nomina.yaml");

  // Round-trip: reloading the project keeps the flag.
  const { loadProject } = await import("../src/config.js");
  const reloaded = loadProject(filesystem, "/projects/bunnyhome");
  const stored = reloaded.config.managedInventory.services.find((service) => service.name === "pve");
  assert.equal(stored.exposure.backend.tls, true);
});

test("republish flows (domain change, caddy redirect) preserve the backend TLS flag", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const fakes = createFakes();

  await runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", "pve",
      "--hostname", "pve.bunny.internal",
      "--backend-ip", "10.0.0.1",
      "--backend-port", "8006",
      "--backend-tls"
    ],
    { filesystem, runtime: proxmoxRootRuntime(), providerAdapters: { technitium: fakes.technitium, caddy: fakes.caddy } }
  );

  fakes.calls.length = 0;

  const result = await runCli(
    ["caddy", "redirect", "on", "--project-dir", "/projects/bunnyhome"],
    { filesystem, runtime: proxmoxRootRuntime(), providerAdapters: { technitium: fakes.technitium, caddy: fakes.caddy } }
  );
  assert.match(result.stdout, /enabled/i);

  const proxyCall = fakes.calls.filter(([kind]) => kind === "proxy").at(-1)?.[1];
  assert.equal(proxyCall.backendTls, true, "redirect toggle republish must keep the backend TLS flag");
});
