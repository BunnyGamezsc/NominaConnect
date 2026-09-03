import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";
import { createCaddyAdapter } from "../src/caddy-adapter.js";

// Independent regression tests derived from docs/todo-fixes.md (FIX-1..FIX-7)
// against docs/review-context.md invariants. Observable behavior only, through
// runCli and createCaddyAdapter with fake seams. No src/ modifications.

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
    for (const dir of [...this.directories]) {
      if (dir === path || dir.startsWith(`${path}/`)) {
        this.directories.delete(dir);
      }
    }
  }
}

// Minimal admin-API fake: strict traversal, 404 on missing paths (like Caddy).
class FakeCaddyAdmin {
  constructor(config = {}) {
    this.config = JSON.parse(JSON.stringify(config));
  }
  #traverse(segments) {
    let node = this.config;
    for (const segment of segments) {
      if (node === undefined || node === null || typeof node !== "object") {
        throw new Error(`missing ${segment}`);
      }
      node = node[segment];
      if (node === undefined) {
        throw new Error(`missing ${segment}`);
      }
    }
    return node;
  }
  #set(segments, value) {
    let node = this.config;
    for (const segment of segments.slice(0, -1)) {
      if (typeof node[segment] !== "object" || node[segment] === null) {
        node[segment] = {};
      }
      node = node[segment];
    }
    const last = segments.at(-1);
    if (value === undefined) {
      delete node[last];
    } else {
      node[last] = value;
    }
  }
  async request({ method, url, body }) {
    const path = new URL(url).pathname.replace(/^\/config\/?/, "");
    const segments = path.split("/").filter(Boolean);
    try {
      if (method === "GET") {
        return { status: 200, headers: {}, body: JSON.stringify(this.#traverse(segments)) };
      }
      if (method === "PUT") {
        const parsed = body === undefined || body === "" ? undefined : JSON.parse(body);
        if (segments.length === 0) {
          this.config = parsed ?? {};
        } else {
          this.#set(segments, parsed);
        }
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

function wireCaddy(fake) {
  return createCaddyAdapter({
    httpClient: { async request(options) { return fake.request(options); } },
    secretResolver: () => {}
  });
}

function technitiumStub() {
  return {
    publishRecord(request) {
      return { id: request.hostname, record: `${request.hostname} A ${request.ip}` };
    },
    deleteRecord(request) {
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
  };
}

function caddyInternalCaStub() {
  return {
    inspect() {
      return { resources: [] };
    },
    healthCheckExposure() {
      return { tls: "valid", issuer: "caddy-internal-ca", status: "healthy" };
    },
    healthCheck() {
      return { process: "running", endpoint: "reachable", status: "healthy" };
    }
  };
}

function serviceYaml({ name = "app", hostname = "app.bunny.internal", backendTls = false, ca = "none", tlsMode = "untrusted", tlsTrusted = false } = {}) {
  return `    - id: nc_exp_test
      name: ${name}
      exposure:
        hostname: ${hostname}
        backend:
          ip: 10.0.0.9
          port: 8006${backendTls ? "\n          tls: true" : ""}
        protocol: https
        certificateAuthority: ${ca}
        tls:
          mode: ${tlsMode}
          trusted: ${tlsTrusted}`;
}

function seedRedirectProject(filesystem, { backendTls = false } = {}) {
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
  services:
${serviceYaml({ backendTls })}
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test
`);
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", JSON.stringify({
    version: 1,
    providerReferences: {
      nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
      nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
    },
    tracking: { notices: [] }
  }));
}

function seedPublishProject(filesystem, { caService = null, domain = "bunnyhome.test" } = {}) {
  const caBlock = caService === null
    ? "    certificateAuthority: null"
    : `    certificateAuthority:
      id: nc_ca_test
      service: ${caService}`;
  const caRefLine = caService === null ? "" : "\n  nc_ca_test: nominaconnect/provider/nc_ca_test";
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", `apiVersion: nomina.connect/v0alpha1
kind: NominaConnect
proxmox:
  node: pve-1
  defaultBridge: vmbr0
  defaultStorage: local-lvm
baseLocalDomain: ${domain}
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
${caBlock}
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test${caRefLine}
`);
  const providerReferences = {
    nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
    nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
  };
  if (caService !== null) {
    providerReferences.nc_ca_test = { vmid: 121, service: caService };
  }
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", JSON.stringify({
    version: 1, providerReferences, tracking: { notices: [] }
  }));
}

function seedDomainProject(filesystem, { caService = "caddy-internal-ca" } = {}) {
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", `apiVersion: nomina.connect/v0alpha1
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
    certificateAuthority:
      id: nc_ca_test
      service: ${caService}
    vpn: null
  services:
${serviceYaml({ hostname: "app.bunnyhome.test", backendTls: true, ca: caService, tlsMode: caService, tlsTrusted: true })}
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test
  nc_ca_test: nominaconnect/provider/nc_ca_test
`);
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", JSON.stringify({
    version: 1,
    providerReferences: {
      nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
      nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
      nc_ca_test: { vmid: 121, service: caService }
    },
    tracking: { notices: [] }
  }));
}

// (a) redirect on end-to-end: -auto-http route lands on srv_http with no
// protocol matcher, TLS route stays intact.
test("redirect on creates the auto-http route on srv_http without a protocol matcher", async () => {
  const filesystem = new FakeFilesystem();
  seedRedirectProject(filesystem);
  const fake = new FakeCaddyAdmin();
  const adapters = {
    filesystem,
    runtime: proxmoxRootRuntime(),
    providerAdapters: { technitium: technitiumStub(), caddy: wireCaddy(fake) }
  };

  const result = await runCli(["caddy", "redirect", "on", "--project-dir", "/projects/bunnyhome"], adapters);
  assert.match(result.stdout, /enabled/i);

  const tlsRoute = (fake.config.apps.http.servers.srv_https?.routes ?? [])
    .find((route) => route["@id"] === "app.bunny.internal");
  const redirect = (fake.config.apps.http.servers.srv_http?.routes ?? [])
    .find((route) => route["@id"] === "app.bunny.internal-auto-http");
  assert.notEqual(tlsRoute, undefined, "TLS route must exist on srv_https");
  assert.notEqual(redirect, undefined, "redirect route must exist on srv_http");
  assert.deepEqual(redirect.match, [{ host: ["app.bunny.internal"] }]);
  for (const matcher of redirect.match ?? []) {
    assert.equal("protocol" in matcher, false, "redirect must not use a protocol matcher");
  }
  assert.equal(redirect.handle[0].status_code, 308);
});

// (a) redirect off end-to-end: -auto-http route removed, TLS route intact.
test("redirect off removes the auto-http route while keeping the TLS route", async () => {
  const filesystem = new FakeFilesystem();
  seedRedirectProject(filesystem);
  const fake = new FakeCaddyAdmin();
  const adapters = {
    filesystem,
    runtime: proxmoxRootRuntime(),
    providerAdapters: { technitium: technitiumStub(), caddy: wireCaddy(fake) }
  };

  await runCli(["caddy", "redirect", "on", "--project-dir", "/projects/bunnyhome"], adapters);
  assert.notEqual(
    (fake.config.apps.http.servers.srv_http?.routes ?? []).find((r) => r["@id"] === "app.bunny.internal-auto-http"),
    undefined
  );

  const result = await runCli(["caddy", "redirect", "off", "--project-dir", "/projects/bunnyhome"], adapters);
  assert.match(result.stdout, /disabled/i);

  const httpRoutes = fake.config.apps.http.servers.srv_http?.routes ?? [];
  const tlsRoutes = fake.config.apps.http.servers.srv_https?.routes ?? [];
  assert.equal(httpRoutes.some((r) => r["@id"] === "app.bunny.internal-auto-http"), false);
  assert.equal(tlsRoutes.some((r) => r["@id"] === "app.bunny.internal"), true);
});

// (b) caddy-internal-ca exposure published end-to-end reports trusted TLS.
test("caddy-internal-ca exposure publishes healthy with trusted TLS in health and persisted service", async () => {
  const filesystem = new FakeFilesystem();
  seedPublishProject(filesystem, { caService: "caddy-internal-ca" });
  const fake = new FakeCaddyAdmin();
  const adapters = {
    filesystem,
    runtime: proxmoxRootRuntime(),
    providerAdapters: {
      technitium: technitiumStub(),
      caddy: wireCaddy(fake),
      "caddy-internal-ca": caddyInternalCaStub()
    }
  };

  const result = await runCli([
    "exposure", "publish",
    "--project-dir", "/projects/bunnyhome",
    "--name", "photos",
    "--hostname", "photos.bunnyhome.test",
    "--backend-ip", "10.0.0.100",
    "--backend-port", "8080"
  ], adapters);

  assert.equal(result.health.status, "healthy");
  assert.equal(result.health.reverseProxy.tls, "valid");
  assert.equal(result.health.reverseProxy.status, "healthy");
  assert.equal(result.managedService.exposure.certificateAuthority, "caddy-internal-ca");
  assert.equal(result.managedService.exposure.tls.trusted, true);

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /certificateAuthority: caddy-internal-ca/);
  assert.match(config, /trusted: true/);
});

// Contrast guard: a no-CA exposure must still report untrusted TLS.
test("no-CA exposure publishes with untrusted TLS rather than collapsing into trusted", async () => {
  const filesystem = new FakeFilesystem();
  seedPublishProject(filesystem, { caService: null });
  const fake = new FakeCaddyAdmin();
  const adapters = {
    filesystem,
    runtime: proxmoxRootRuntime(),
    providerAdapters: { technitium: technitiumStub(), caddy: wireCaddy(fake) }
  };

  const result = await runCli([
    "exposure", "publish",
    "--project-dir", "/projects/bunnyhome",
    "--name", "plain",
    "--hostname", "plain.bunnyhome.test",
    "--backend-ip", "10.0.0.100",
    "--backend-port", "8080"
  ], adapters);

  assert.equal(result.health.reverseProxy.tls, "untrusted");
  assert.equal(result.managedService.exposure.tls.trusted, false);
});

// (c) toggling the redirect republishes while preserving backend TLS.
test("redirect toggle republish preserves the TLS-backend dial options", async () => {
  const filesystem = new FakeFilesystem();
  seedRedirectProject(filesystem, { backendTls: true });
  const fake = new FakeCaddyAdmin();
  const adapters = {
    filesystem,
    runtime: proxmoxRootRuntime(),
    providerAdapters: { technitium: technitiumStub(), caddy: wireCaddy(fake) }
  };

  await runCli(["caddy", "redirect", "on", "--project-dir", "/projects/bunnyhome"], adapters);

  const route = (fake.config.apps.http.servers.srv_https?.routes ?? [])
    .find((r) => r["@id"] === "app.bunny.internal");
  assert.notEqual(route, undefined);
  assert.deepEqual(route.handle[0].transport, { protocol: "http", tls: { insecure_skip_verify: true } });

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /tls: true/);
});

// (d) domain change preserves backend TLS and the CA trust mode.
test("domain change preserves backend TLS and the internal-CA trust mode", async () => {
  const filesystem = new FakeFilesystem();
  seedDomainProject(filesystem, { caService: "caddy-internal-ca" });
  const fake = new FakeCaddyAdmin();
  const adapters = {
    filesystem,
    runtime: proxmoxRootRuntime(),
    providerAdapters: {
      technitium: technitiumStub(),
      caddy: wireCaddy(fake),
      "caddy-internal-ca": caddyInternalCaStub()
    }
  };

  const result = await runCli(
    ["domain", "change", "bunny.home.arpa", "--project-dir", "/projects/bunnyhome"],
    adapters
  );
  assert.match(result.stdout, /bunny\.home\.arpa/i);

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /hostname: app\.bunny\.home\.arpa/);
  assert.match(config, /tls: true/);
  assert.match(config, /certificateAuthority: caddy-internal-ca/);
  assert.match(config, /trusted: true/);

  const route = (fake.config.apps.http.servers.srv_https?.routes ?? [])
    .find((r) => r["@id"] === "app.bunny.home.arpa");
  assert.notEqual(route, undefined, "renamed route must be republished");
  assert.deepEqual(route.handle[0].transport, { protocol: "http", tls: { insecure_skip_verify: true } });
});

// (e) nuclear uninstall removes exactly the config, state dir, and secret store.
test("nuclear uninstall destroys managed LXCs and removes exactly config, state, and secret store", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.mkdir("/var/lib/nominaconnect/secrets");
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
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", JSON.stringify({
    version: 1,
    providerReferences: {
      nc_dns_test: { vmid: 100, ip: "10.0.0.53" },
      nc_proxy_test: { vmid: 101, ip: "10.0.0.54" }
    },
    tracking: { notices: [] }
  }));
  filesystem.writeFile("/var/lib/nominaconnect/secrets/nc_dns_test", "secret");

  const calls = [];
  const proxmox = {
    async stopLxc(vmid) { calls.push(["stop", vmid]); },
    async destroyLxc(vmid) { calls.push(["destroy", vmid]); }
  };

  const result = await runCli(
    ["uninstall", "--yes", "--project-dir", "/projects/bunnyhome"],
    { filesystem, runtime: proxmoxRootRuntime(), proxmox }
  );

  assert.deepEqual(calls.filter(([k]) => k === "destroy").map(([, v]) => v).sort((a, b) => a - b), [100, 101]);
  assert.deepEqual(
    [...filesystem.deleted].sort(),
    ["/projects/bunnyhome/.nomina", "/projects/bunnyhome/nomina.yaml", "/var/lib/nominaconnect"].sort(),
    "only the config file, state dir, and secret store may be deleted"
  );
  assert.deepEqual(
    result.removedPaths,
    ["/projects/bunnyhome/nomina.yaml", "/projects/bunnyhome/.nomina/state.json", "/var/lib/nominaconnect"]
  );
  assert.equal(filesystem.exists("/projects/bunnyhome/nomina.yaml"), false);
  assert.equal(filesystem.exists("/projects/bunnyhome/.nomina/state.json"), false);
  assert.equal(filesystem.exists("/var/lib/nominaconnect/secrets/nc_dns_test"), false);
});
