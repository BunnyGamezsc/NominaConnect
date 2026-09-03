import test from "node:test";
import assert from "node:assert/strict";

import { createCaddyAdapter } from "../src/caddy-adapter.js";

const ROUTE_FIELDS = new Set(["@id", "match", "handle", "terminal", "group"]);
const POLICY_FIELDS = new Set(["subjects", "issuers"]);

class FakeCaddyAdmin {
  constructor(initialConfig = { admin: { listen: "0.0.0.0:2019" } }) {
    this.config = structuredClone(initialConfig);
    this.requests = [];
  }

  request({ method, url, body }) {
    const payload = typeof body === "string" && body.length > 0 ? JSON.parse(body) : body;
    this.requests.push({ method, url, body: payload });
    const path = new URL(url).pathname.replace(/\/$/, "");
    const segments = path.split("/").filter((segment) => segment.length > 0);
    if (segments[0] === "config") {
      segments.shift();
    }
    if (method === "GET") {
      const value = this.#traverse(segments);
      return { status: 200, body: JSON.stringify(value ?? null) };
    }
    if (method === "PUT") {
      const parentPath = segments.slice(0, -1);
      const last = segments[segments.length - 1];
      let parent;
      try {
        parent = this.#traverseToContainer(parentPath);
      } catch (error) {
        return { status: 400, body: JSON.stringify({ error: error.message }) };
      }
      if (Array.isArray(parent)) {
        const index = Number(last);
        if (!Number.isInteger(index)) {
          return { status: 500, body: JSON.stringify({ error: `[${path}] invalid array index '${last}'` }) };
        }
        this.#validate(parentPath.join("/"), payload);
        parent[index] = payload;
        return { status: 200, body: "" };
      }
      if (parent[last] !== undefined) {
        return { status: 409, body: JSON.stringify({ error: `[${path}] key already exists: ${last}` }) };
      }
      this.#validate(parentPath.join("/"), payload);
      parent[last] = structuredClone(payload);
      return { status: 200, body: "" };
    }
    if (method === "POST") {
      let parent;
      try {
        parent = this.#traverse(segments);
      } catch (error) {
        return { status: 400, body: JSON.stringify({ error: error.message }) };
      }
      this.#validate(segments.join("/"), payload);
      if (Array.isArray(parent)) {
        parent.push(structuredClone(payload));
      } else if (typeof payload === "object" && !Array.isArray(payload)) {
        Object.assign(parent, structuredClone(payload));
      } else {
        return { status: 400, body: JSON.stringify({ error: "cannot append non-object to map" }) };
      }
      return { status: 200, body: "" };
    }
    if (method === "DELETE") {
      const parentPath = segments.slice(0, -1);
      const last = segments[segments.length - 1];
      let parent;
      try {
        parent = this.#traverse(parentPath);
      } catch {
        return { status: 404, body: JSON.stringify({ error: "not found" }) };
      }
      if (parent === null || parent[last] === undefined) {
        return { status: 404, body: JSON.stringify({ error: "not found" }) };
      }
      if (Array.isArray(parent)) {
        parent.splice(Number(last), 1);
      } else {
        delete parent[last];
      }
      return { status: 200, body: "" };
    }
    return { status: 405, body: "" };
  }

  #traverse(segments) {
    let node = this.config;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (node === null || typeof node !== "object") {
        throw new Error(`invalid traversal path at: ${segments.slice(0, i + 1).join("/")}`);
      }
      if (Array.isArray(node)) {
        const index = Number(segment);
        if (!Number.isInteger(index) || node[index] === undefined) {
          throw new Error(`invalid traversal path at: ${segments.slice(0, i + 1).join("/")}`);
        }
        node = node[index];
        continue;
      }
      if (node[segment] === undefined) {
        throw new Error(`invalid traversal path at: ${segments.slice(0, i + 1).join("/")}`);
      }
      node = node[segment];
    }
    return node;
  }

  #traverseToContainer(segments) {
    let node = this.config;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      if (node === null || typeof node !== "object" || Array.isArray(node)) {
        throw new Error(`invalid traversal path at: ${segments.slice(0, i + 1).join("/")}`);
      }
      if (typeof node[segment] !== "object" || node[segment] === null) {
        node[segment] = {};
      }
      node = node[segment];
    }
    return node;
  }

  #validate(contextPath, value) {
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      if (entry === null || typeof entry !== "object") {
        continue;
      }
      if ("handle" in entry || "match" in entry || ("@id" in entry && "terminal" in entry)) {
        for (const key of Object.keys(entry)) {
          assert(
            ROUTE_FIELDS.has(key),
            `real Caddy rejects unknown Route field "${key}" (strict JSON decode)`
          );
        }
      }
      if ("subjects" in entry || "issuers" in entry) {
        for (const key of Object.keys(entry)) {
          assert(
            POLICY_FIELDS.has(key),
            `real Caddy rejects unknown automation policy field "${key}" (strict JSON decode)`
          );
        }
      }
    }
  }

  get(path) {
    const segments = path.split("/").filter((segment) => segment.length > 0);
    try {
      return this.#traverse(segments);
    } catch {
      return null;
    }
  }
}

function createHttpClient(fake) {
  return {
    async request(options) {
      return fake.request(options);
    }
  };
}

function stepCaRequest(overrides = {}) {
  return {
    hostname: "dns.bunny.home",
    backendIp: "192.168.4.90",
    backendPort: 5380,
    protocol: "https",
    caStrategy: "step-ca",
    tls: { mode: "step-ca", trusted: true, caIp: "192.168.4.87" },
    ip: "192.168.4.101",
    ...overrides
  };
}

const INSTALLER_CADDYFILE_CONFIG = {
  admin: { listen: "0.0.0.0:2019" },
  apps: {
    http: {
      servers: {
        srv_https: {
          listen: [":443"],
          routes: []
        },
        srv_http: {
          listen: [":80"],
          routes: [{ handle: [{ body: "OK", handler: "static_response", status_code: 200 }] }]
        }
      }
    }
  }
};

test("publishRoute bootstraps an empty Caddy config with a valid route and step-ca automation policy", async () => {
  const fake = new FakeCaddyAdmin();
  const adapter = createCaddyAdapter({ httpClient: createHttpClient(fake), secretResolver: () => {} });

  await adapter.publishRoute(stepCaRequest());

  const routes = fake.get("apps/http/servers/srv_https/routes");
  assert.equal(Array.isArray(routes), true, "routes must remain an array");
  const published = routes.find((route) => route["@id"] === "dns.bunny.home");
  assert.notEqual(published, undefined);
  assert.equal("tls" in published, false, "route must not carry a tls field (unknown field for Caddy Route)");
  assert.deepEqual(published.match, [{ host: ["dns.bunny.home"] }]);
  assert.deepEqual(published.handle[0].upstreams[0].dial, "192.168.4.90:5380");

  const policies = fake.get("apps/tls/automation/policies");
  assert.notEqual(policies, undefined, "apps.tls automation policy must be created");
  const policy = policies.find((entry) => entry.subjects?.includes("dns.bunny.home"));
  assert.notEqual(policy, undefined);
  assert.deepEqual(policy.issuers, [
    { module: "acme", ca: "https://192.168.4.87:9000/acme/acme/directory" }
  ]);
});

test("publishRoute prefers the step-ca hostname over the bare IP for the ACME directory URL", async () => {
  const fake = new FakeCaddyAdmin();
  const adapter = createCaddyAdapter({ httpClient: createHttpClient(fake), secretResolver: () => {} });

  await adapter.publishRoute(stepCaRequest({
    tls: { mode: "step-ca", trusted: true, caIp: "192.168.4.87", caHost: "step-ca.bunnyhome.test" }
  }));

  const policies = fake.get("apps/tls/automation/policies");
  const policy = policies.find((entry) => entry.subjects?.includes("dns.bunny.home"));
  assert.deepEqual(policy.issuers, [
    { module: "acme", ca: "https://step-ca.bunnyhome.test:9000/acme/acme/directory" }
  ]);
});

test("publishRoute falls back to the CA IP for the ACME directory URL when no hostname is known", async () => {
  const fake = new FakeCaddyAdmin();
  const adapter = createCaddyAdapter({ httpClient: createHttpClient(fake), secretResolver: () => {} });

  await adapter.publishRoute(stepCaRequest());

  const policies = fake.get("apps/tls/automation/policies");
  const policy = policies.find((entry) => entry.subjects?.includes("dns.bunny.home"));
  assert.deepEqual(policy.issuers, [
    { module: "acme", ca: "https://192.168.4.87:9000/acme/acme/directory" }
  ]);
});

test("publishRoute keeps the installer catch-all in srv_http and lands managed routes in srv_https", async () => {
  const fake = new FakeCaddyAdmin(INSTALLER_CADDYFILE_CONFIG);
  const adapter = createCaddyAdapter({ httpClient: createHttpClient(fake), secretResolver: () => {} });

  await adapter.publishRoute(stepCaRequest());

  const httpsRoutes = fake.get("apps/http/servers/srv_https/routes");
  const managedIndex = httpsRoutes.findIndex((route) => route["@id"] === "dns.bunny.home");
  assert.notEqual(managedIndex, -1, "managed route must live in the :443 server");
  assert.equal(fake.get("apps/http/servers/srv_http/routes").length >= 1, true,
    "installer catch-all must remain untouched in srv_http");
});

test("publishRoute is idempotent and preserves unrelated routes and policies on re-publish", async () => {
  const fake = new FakeCaddyAdmin({
    admin: { listen: "0.0.0.0:2019" },
    apps: {
      http: {
        servers: {
          srv_https: {
            listen: [":80", ":443"],
            routes: [
              {
                "@id": "photos.bunnyhome.test",
                match: [{ host: ["photos.bunnyhome.test"] }],
                handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "10.0.0.100:8080" }] }],
                terminal: true
              },
              { handle: [{ body: "OK", handler: "static_response", status_code: 200 }] }
            ]
          }
        }
      },
      tls: {
        automation: {
          policies: [{ subjects: ["photos.bunnyhome.test"], issuers: [{ module: "internal" }] }]
        }
      }
    }
  });
  const adapter = createCaddyAdapter({ httpClient: createHttpClient(fake), secretResolver: () => {} });

  await adapter.publishRoute(stepCaRequest());
  await adapter.publishRoute(stepCaRequest());

  const routes = fake.get("apps/http/servers/srv_https/routes");
  assert.equal(routes.filter((route) => route["@id"] === "dns.bunny.home").length, 1, "duplicate routes must not be appended");
  assert.equal(routes.filter((route) => route["@id"] === "photos.bunnyhome.test").length, 1);

  const photosRoute = routes.find((route) => route["@id"] === "photos.bunnyhome.test");
  assert.deepEqual(photosRoute.handle[0].upstreams[0].dial, "10.0.0.100:8080", "unrelated route must be preserved verbatim");

  const policies = fake.get("apps/tls/automation/policies");
  assert.equal(policies.length, 2);
  assert.equal(
    policies.filter((policy) => policy.subjects?.includes("dns.bunny.home")).length,
    1,
    "duplicate policies must not be appended"
  );
  const photosPolicy = policies.find((policy) => policy.subjects?.includes("photos.bunnyhome.test"));
  assert.deepEqual(photosPolicy.issuers, [{ module: "internal" }]);
});

test("publishRoute republishes an updated backend by replacing the managed route", async () => {
  const fake = new FakeCaddyAdmin();
  const adapter = createCaddyAdapter({ httpClient: createHttpClient(fake), secretResolver: () => {} });

  await adapter.publishRoute(stepCaRequest());
  await adapter.publishRoute(stepCaRequest({ backendIp: "192.168.4.91", backendPort: 5380 }));

  const routes = fake.get("apps/http/servers/srv_https/routes");
  const published = routes.find((route) => route["@id"] === "dns.bunny.home");
  assert.equal(routes.length, 1);
  assert.deepEqual(published.handle[0].upstreams[0].dial, "192.168.4.91:5380");
});

test("publishRoute with no CA serves HTTPS through the internal issuer (untrusted)", async () => {
  const fake = new FakeCaddyAdmin();
  const adapter = createCaddyAdapter({ httpClient: createHttpClient(fake), secretResolver: () => {} });

  await adapter.publishRoute(stepCaRequest({
    caStrategy: "none",
    tls: { mode: "untrusted", trusted: false }
  }));

  const policies = fake.get("apps/tls/automation/policies");
  const policy = policies.find((entry) => entry.subjects?.includes("dns.bunny.home"));
  assert.deepEqual(policy.issuers, [{ module: "internal" }]);
});

test("publishRoute with caddy-internal-ca uses the internal issuer", async () => {
  const fake = new FakeCaddyAdmin();
  const adapter = createCaddyAdapter({ httpClient: createHttpClient(fake), secretResolver: () => {} });

  await adapter.publishRoute(stepCaRequest({
    caStrategy: "caddy-internal-ca",
    tls: { mode: "caddy-internal-ca", trusted: true }
  }));

  const policies = fake.get("apps/tls/automation/policies");
  const policy = policies.find((entry) => entry.subjects?.includes("dns.bunny.home"));
  assert.deepEqual(policy.issuers, [{ module: "internal" }]);
});

test("healthCheckExposure reports caddy-internal-ca as trusted but no-CA as untrusted", async () => {
  const fake = new FakeCaddyAdmin();
  const adapter = createCaddyAdapter({ httpClient: createHttpClient(fake), secretResolver: () => {} });

  await adapter.publishRoute(stepCaRequest({
    caStrategy: "caddy-internal-ca",
    tls: { mode: "caddy-internal-ca", trusted: true }
  }));

  const trusted = await adapter.healthCheckExposure({
    hostname: "dns.bunny.home",
    backendIp: "192.168.4.90",
    backendPort: 5380,
    caStrategy: "caddy-internal-ca",
    ip: "192.168.4.101"
  });
  assert.equal(trusted.status, "healthy");
  assert.equal(trusted.tls, "valid");

  const untrusted = await adapter.healthCheckExposure({
    hostname: "dns.bunny.home",
    backendIp: "192.168.4.90",
    backendPort: 5380,
    caStrategy: "none",
    ip: "192.168.4.101"
  });
  assert.equal(untrusted.status, "healthy");
  assert.equal(untrusted.tls, "untrusted");
});

test("unpublishRoute removes the managed route and its policy while preserving unrelated ones", async () => {
  const fake = new FakeCaddyAdmin();
  const adapter = createCaddyAdapter({ httpClient: createHttpClient(fake), secretResolver: () => {} });

  await adapter.publishRoute(stepCaRequest());
  await adapter.publishRoute(stepCaRequest({ hostname: "photos.bunnyhome.test" }));

  await adapter.unpublishRoute({ hostname: "dns.bunny.home", ip: "192.168.4.101" });

  const routes = fake.get("apps/http/servers/srv_https/routes");
  assert.equal(routes.some((route) => route["@id"] === "dns.bunny.home"), false);
  assert.equal(routes.some((route) => route["@id"] === "photos.bunnyhome.test"), true);

  const policies = fake.get("apps/tls/automation/policies");
  assert.equal(policies.some((policy) => policy.subjects?.includes("dns.bunny.home")), false);
  assert.equal(policies.some((policy) => policy.subjects?.includes("photos.bunnyhome.test")), true);
});

test("healthCheckExposure validates the route and derives TLS trust from the automation policy", async () => {
  const fake = new FakeCaddyAdmin();
  const adapter = createCaddyAdapter({ httpClient: createHttpClient(fake), secretResolver: () => {} });

  await adapter.publishRoute(stepCaRequest());

  const healthy = await adapter.healthCheckExposure({
    hostname: "dns.bunny.home",
    backendIp: "192.168.4.90",
    backendPort: 5380,
    ip: "192.168.4.101"
  });
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.https, "reachable");
  assert.equal(healthy.tls, "valid");

  await adapter.unpublishRoute({ hostname: "dns.bunny.home", ip: "192.168.4.101" });
  const missing = await adapter.healthCheckExposure({
    hostname: "dns.bunny.home",
    backendIp: "192.168.4.90",
    backendPort: 5380,
    ip: "192.168.4.101"
  });
  assert.equal(missing.status, "unhealthy");
});

test("inspect reports managed resources with TLS summaries derived from automation policies", async () => {
  const fake = new FakeCaddyAdmin();
  const adapter = createCaddyAdapter({ httpClient: createHttpClient(fake), secretResolver: () => {} });

  await adapter.publishRoute(stepCaRequest());

  const { resources } = await adapter.inspect({ ip: "192.168.4.101" });
  const resource = resources.find((entry) => entry.id === "dns.bunny.home");
  assert.notEqual(resource, undefined);
  assert.equal(resource.backendIp, "192.168.4.90");
  assert.equal(resource.backendPort, 5380);
  assert.equal(resource.tls.issuer, "acme");
  assert.equal(resource.tls.trusted, true);
});
