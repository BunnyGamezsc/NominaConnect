import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";
import { createCaddyAdapter } from "../src/caddy-adapter.js";
import { stepCaCaHost } from "../src/exposure.js";

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

function createProjectYaml({ caService = "caddy-internal-ca" } = {}) {
  const caBlock = caService === null
    ? "    certificateAuthority: null"
    : `    certificateAuthority:
      id: nc_ca_test
      service: ${caService}`;
  return `apiVersion: nomina.connect/v0alpha1
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
${caBlock}
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test
`;
}

function seedProject(filesystem, { caService = "caddy-internal-ca" } = {}) {
  const providerReferences = {
    nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
    nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
  };
  if (caService !== null) {
    providerReferences.nc_ca_test = { vmid: 121, service: caService };
  }
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({ version: 1, providerReferences, tracking: { notices: [] } })
  );
}

function createTechnitiumAdapter() {
  return {
    inspect() {
      return { resources: [{ id: "bunnyhome.test", record: "bunnyhome.test NS localhost" }] };
    },
    publishRecord(request) {
      return { id: request.hostname, record: `${request.hostname} A ${request.ip}` };
    },
    healthCheckExposure() {
      return { dns: "reachable", status: "healthy" };
    },
    healthCheck() {
      return { process: "running", endpoint: "reachable" };
    }
  };
}

function createCaddyAdapterStub() {
  const state = { healthCheckCalls: [] };
  return {
    healthCheckCalls: state.healthCheckCalls,
    inspect() {
      return { resources: [] };
    },
    publishRoute(request) {
      return { id: request.hostname, route: `https://${request.hostname}` };
    },
    healthCheckExposure(request) {
      state.healthCheckCalls.push(request);
      return { https: "reachable", tls: "valid", status: "healthy" };
    },
    healthCheck() {
      return { process: "running", endpoint: "reachable" };
    }
  };
}

function createCaddyInternalCaAdapterStub() {
  return {
    inspect() {
      return { resources: [] };
    },
    healthCheckExposure() {
      return { tls: "valid", issuer: "caddy-internal-ca", status: "healthy" };
    },
    healthCheck() {
      return { process: "running", endpoint: "reachable" };
    }
  };
}

async function publishExposure({ caService }) {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem, { caService });
  const caddy = createCaddyAdapterStub();
  const adapters = {
    filesystem,
    runtime: proxmoxRootRuntime(),
    providerAdapters: { technitium: createTechnitiumAdapter(), caddy }
  };
  if (caService !== null) {
    adapters.providerAdapters[caService] = createCaddyInternalCaAdapterStub();
  }
  const result = await runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", "photos",
      "--hostname", "photos.bunnyhome.test",
      "--backend-ip", "10.0.0.100",
      "--backend-port", "8080"
    ],
    adapters
  );
  return { result, caddy };
}

// FIX-2: the proxy health check must know the CA strategy, otherwise a
// working caddy-internal-ca exposure is reported as untrusted. The adapter
// unit test cannot catch a missing pass-through in exposure.js, so assert the
// request shape end to end through `exposure publish`.
test("exposure publish threads the caddy-internal-ca strategy into the proxy health check", async () => {
  const { result, caddy } = await publishExposure({ caService: "caddy-internal-ca" });

  assert.equal(result.health.status, "healthy");
  assert.notEqual(caddy.healthCheckCalls.length, 0, "proxy health check must run on publish");
  for (const call of caddy.healthCheckCalls) {
    assert.equal(call.caStrategy, "caddy-internal-ca");
  }
});

test("exposure publish threads the none strategy into the proxy health check when no CA is selected", async () => {
  const { result, caddy } = await publishExposure({ caService: null });

  assert.equal(result.health.status, "healthy");
  assert.notEqual(caddy.healthCheckCalls.length, 0, "proxy health check must run on publish");
  for (const call of caddy.healthCheckCalls) {
    assert.equal(call.caStrategy, "none");
  }
});

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

function createWireAdapter(fake) {
  return createCaddyAdapter({
    httpClient: { async request(options) { return fake.request(options); } },
    secretResolver: () => {}
  });
}

// FIX-1: legacy single-server routes carrying the broken `protocol` matcher
// must have it stripped on migration; servers carry the scheme now.
test("migrating a legacy srv0 route strips the protocol matcher", async () => {
  const fake = new FakeCaddyAdmin({
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [":80", ":443"],
            routes: [{
              "@id": "legacy.bunny.internal",
              match: [{ host: ["legacy.bunny.internal"], protocol: "http://" }],
              handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "10.0.0.9:80" }] }],
              terminal: true
            }]
          }
        }
      }
    }
  });

  await createWireAdapter(fake).publishRoute({
    hostname: "dns.bunny.internal",
    backendIp: "192.168.4.90",
    backendPort: 5380,
    protocol: "https",
    caStrategy: "step-ca",
    tls: { mode: "step-ca", trusted: true, caHost: "step-ca.bunny.internal" },
    ip: "192.168.4.86"
  });

  const servers = fake.config.apps.http.servers;
  assert.equal(servers.srv0, undefined, "legacy server must be removed");
  const migrated = servers.srv_https.routes.find((route) => route["@id"] === "legacy.bunny.internal");
  assert.notEqual(migrated, undefined, "legacy route must survive migration");
  for (const matcher of migrated.match ?? []) {
    assert.equal("protocol" in matcher, false, "protocol matcher must be stripped on migration");
  }
});

// FIX-1: freshly published redirect routes must not carry the matcher that
// Caddy 2.11.x silently never matches.
test("published redirect routes carry no protocol matcher", async () => {
  const fake = new FakeCaddyAdmin();

  await createWireAdapter(fake).publishRoute({
    hostname: "dns.bunny.internal",
    backendIp: "192.168.4.90",
    backendPort: 5380,
    protocol: "https",
    caStrategy: "step-ca",
    tls: { mode: "step-ca", trusted: true, caHost: "step-ca.bunny.internal" },
    httpRedirect: true,
    ip: "192.168.4.86"
  });

  const redirect = (fake.config.apps.http.servers.srv_http?.routes ?? [])
    .find((route) => route["@id"] === "dns.bunny.internal-auto-http");
  assert.notEqual(redirect, undefined, "redirect route must be created");
  for (const matcher of redirect.match ?? []) {
    assert.equal("protocol" in matcher, false, "redirect route must not use a protocol matcher");
  }
});

// FIX-4: the single shared step-ca hostname helper falls back to the
// bare "step-ca" name and honors an explicitly deployed hostname.
test("stepCaCaHost falls back to step-ca and honors the deployed hostname", () => {
  const fallback = {
    config: {
      baseLocalDomain: "bunny.internal",
      managedInventory: { platform: { certificateAuthority: { service: "step-ca" } } }
    }
  };
  assert.equal(stepCaCaHost(fallback), "step-ca.bunny.internal");

  const custom = {
    config: {
      baseLocalDomain: "bunny.internal",
      managedInventory: {
        platform: {
          certificateAuthority: { service: "step-ca", deployment: { hostname: "ca-primary" } }
        }
      }
    }
  };
  assert.equal(stepCaCaHost(custom), "ca-primary.bunny.internal");

  const missing = {
    config: {
      baseLocalDomain: "bunny.internal",
      managedInventory: { platform: { certificateAuthority: null } }
    }
  };
  assert.equal(stepCaCaHost(missing), "step-ca.bunny.internal");
});
