import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";
import { createCaddyAdapter } from "../src/caddy-adapter.js";
import { buildMenuOptions, runInteractiveApp } from "../src/tui.js";

const proxmoxRootRuntime = () => ({ isRoot: () => true, isProxmoxHost: () => true });

// --- Minimal admin-API fake mirroring Caddy's strict JSON traversal ---
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

function stepCaRequest(overrides) {
  return {
    hostname: "dns.bunny.internal",
    backendIp: "192.168.4.90",
    backendPort: 5380,
    protocol: "https",
    caStrategy: "step-ca",
    tls: { mode: "step-ca", trusted: true, caIp: "192.168.4.87", caHost: "step-ca.bunny.internal" },
    ip: "192.168.4.86",
    ...overrides
  };
}

function createAdapter(fake) {
  return createCaddyAdapter({ httpClient: { async request(options) { return fake.request(options); } }, secretResolver: () => {} });
}

test("publishRoute adds an HTTP->HTTPS redirect route when httpRedirect is enabled", async () => {
  const fake = new FakeCaddyAdmin();
  await createAdapter(fake).publishRoute(stepCaRequest({ httpRedirect: true }));

  const routes = fake.config.apps.http.servers.srv0.routes;
  const tlsRoute = routes.find((route) => route["@id"] === "dns.bunny.internal");
  const redirectRoute = routes.find((route) => route["@id"] === "dns.bunny.internal-auto-http");

  assert.notEqual(tlsRoute, undefined, "TLS route must still exist");
  assert.notEqual(redirectRoute, undefined, "redirect route must be created");
  assert.deepEqual(redirectRoute.match, [{ host: ["dns.bunny.internal"], protocol: "http://" }]);
  assert.equal(redirectRoute.handle[0].handler, "static_response");
  assert.equal(String(redirectRoute.handle[0].status_code), "308");
  assert.match(redirectRoute.handle[0].headers.Location[0], /^https:\/\/\{http\.request\.host\}/);

  const policies = fake.config.apps.tls.automation.policies;
  assert.equal(policies.length, 1, "redirect route must not create a TLS policy");
});

test("publishRoute does not add a redirect route by default", async () => {
  const fake = new FakeCaddyAdmin();
  await createAdapter(fake).publishRoute(stepCaRequest());

  const routes = fake.config.apps.http.servers.srv0.routes;
  assert.equal(routes.some((route) => route["@id"] === "dns.bunny.internal-auto-http"), false);
});

test("republishing with the redirect stays idempotent and preserves unrelated routes", async () => {
  const fake = new FakeCaddyAdmin({
    apps: { http: { servers: { srv0: { listen: [":80", ":443"], routes: [
      { "@id": "other.bunny.internal", match: [{ host: ["other.bunny.internal"] }], handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "10.0.0.9:80" }] }], terminal: true }
    ] } } } }
  });
  const adapter = createAdapter(fake);
  await adapter.publishRoute(stepCaRequest({ httpRedirect: true }));
  await adapter.publishRoute(stepCaRequest({ httpRedirect: true }));

  const routes = fake.config.apps.http.servers.srv0.routes;
  assert.equal(routes.filter((route) => route["@id"] === "dns.bunny.internal").length, 1);
  assert.equal(routes.filter((route) => route["@id"] === "dns.bunny.internal-auto-http").length, 1);
  assert.notEqual(routes.find((route) => route["@id"] === "other.bunny.internal"), undefined);
});

test("unpublishRoute removes both the TLS and redirect routes", async () => {
  const fake = new FakeCaddyAdmin();
  const adapter = createAdapter(fake);
  await adapter.publishRoute(stepCaRequest({ httpRedirect: true }));
  await adapter.unpublishRoute({ hostname: "dns.bunny.internal", ip: "192.168.4.86" });

  const routes = fake.config.apps.http.servers.srv0.routes ?? [];
  assert.equal(routes.some((route) => route["@id"] === "dns.bunny.internal"), false);
  assert.equal(routes.some((route) => route["@id"] === "dns.bunny.internal-auto-http"), false);
});

test("inspect does not report the redirect route as a separate managed resource", async () => {
  const fake = new FakeCaddyAdmin();
  const adapter = createAdapter(fake);
  await adapter.publishRoute(stepCaRequest({ httpRedirect: true }));

  const { resources } = await adapter.inspect({ ip: "192.168.4.86" });
  assert.equal(resources.length, 1, "redirect implementation detail must stay invisible to inspection");
  assert.equal(resources[0].id, "dns.bunny.internal");
});

test("healthCheckExposure still matches the TLS route when a redirect exists", async () => {
  const fake = new FakeCaddyAdmin();
  const adapter = createAdapter(fake);
  await adapter.publishRoute(stepCaRequest({ httpRedirect: true }));

  const health = await adapter.healthCheckExposure({
    hostname: "dns.bunny.internal",
    backendIp: "192.168.4.90",
    backendPort: 5380,
    ip: "192.168.4.86"
  });

  assert.equal(health.status, "healthy");
  assert.equal(health.tls, "valid");
});

// --- CLI + TUI ---

class FakeFilesystem {
  files = new Map();
  directories = new Set();
  exists(path) { return this.files.has(path) || this.directories.has(path); }
  mkdir(path) { this.directories.add(path); }
  writeFile(path, content) { this.files.set(path, content); }
  rename(from, to) { this.files.set(to, this.files.get(from)); this.files.delete(from); }
  chmod() {}
  read(path) { return this.files.get(path); }
}

/**
 * @param {{ httpRedirect?: boolean }} [options]
 */
function seedProject(filesystem, options = {}) {
  const { httpRedirect } = options;
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
        hostname: caddy${httpRedirect === undefined ? "" : `\n      httpRedirect: ${httpRedirect}`}
    certificateAuthority: null
    vpn: null
  services:
    - id: nc_exp_test
      name: dns
      exposure:
        hostname: dns.bunny.internal
        backend:
          ip: 10.0.0.53
          port: 5380
        protocol: https
        certificateAuthority: none
        tls:
          mode: untrusted
          trusted: false
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
`);
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify({
    version: 1,
    providerReferences: {
      nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
      nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
      nc_exp_test: { dns: "dns.bunny.internal", reverseProxy: "dns.bunny.internal" }
    },
    tracking: { notices: [] }
  }, null, 2)}
`);
}

function createFakes() {
  const publishCalls = [];
  return {
    publishCalls,
    technitium: {
      publishRecord(request) {
        publishCalls.push(["dns", request]);
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
        publishCalls.push(["proxy", request]);
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

test("nomina caddy redirect on persists the flag and republishes exposures with redirects", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const fakes = createFakes();

  const result = await runCli(
    ["caddy", "redirect", "on", "--project-dir", "/projects/bunnyhome"],
    { filesystem, runtime: proxmoxRootRuntime(), providerAdapters: { technitium: fakes.technitium, caddy: fakes.caddy } }
  );

  assert.match(result.stdout, /redirect/i);
  assert.match(result.stdout, /enabled/i);

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /httpRedirect: true/);

  const proxyPublish = fakes.publishCalls.filter(([kind]) => kind === "proxy").at(-1)?.[1];
  assert.equal(proxyPublish?.httpRedirect, true, "republished exposures must carry the redirect flag");
});

test("nomina caddy redirect off removes the flag and the redirect from exposures", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem, { httpRedirect: true });
  const fakes = createFakes();

  await runCli(
    ["caddy", "redirect", "off", "--project-dir", "/projects/bunnyhome"],
    { filesystem, runtime: proxmoxRootRuntime(), providerAdapters: { technitium: fakes.technitium, caddy: fakes.caddy } }
  );

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /httpRedirect: false/);
  const proxyPublish = fakes.publishCalls.filter(([kind]) => kind === "proxy").at(-1)?.[1];
  assert.equal(proxyPublish?.httpRedirect, false);
});

test("nomina caddy redirect rejects an unknown state", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  await assert.rejects(
    runCli(
      ["caddy", "redirect", "maybe", "--project-dir", "/projects/bunnyhome"],
      { filesystem, runtime: proxmoxRootRuntime(), providerAdapters: {} }
    ),
    /on|off/i
  );
});

test("interactive menu shows a state-aware toggle only for provisioned Caddy, and routes it", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem, { httpRedirect: false });
  const { loadProject } = await import("../src/config.js");
  const project = loadProject(filesystem, "/projects/bunnyhome");

  const options = buildMenuOptions(project);
  const toggle = options.find((option) => option.value === "toggle-http-redirect");
  assert.notEqual(toggle, undefined, "provisioned Caddy must expose the redirect toggle");
  assert.match(toggle.label, /ON/, "label reflects current OFF state");

  // Without Caddy provisioned there must be no toggle.
  const bare = {
    config: { managedInventory: { platform: { dns: null, reverseProxy: { id: "p", service: "caddy" }, certificateAuthority: null } } },
    state: { providerReferences: {} }
  };
  assert.equal(buildMenuOptions(bare).some((option) => option.value === "toggle-http-redirect"), false);

  const commands = [];
  await runInteractiveApp({
    filesystem: {
      exists: (path) => path === "/projects/home/nomina.yaml",
      read: () => ""
    },
    cwd: "/projects/home",
    interactive: {
      chooseAction: async () => "toggle-http-redirect"
    },
    runCommand: async (argumentsList) => {
      commands.push(argumentsList);
      return { stdout: "ok\n" };
    }
  });
  assert.deepEqual(commands, [["caddy", "redirect", "on"]]);
});
