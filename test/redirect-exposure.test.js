import test from "node:test";
import assert from "node:assert/strict";

import { createCaddyAdapter } from "../src/caddy-adapter.js";
import { buildFragment } from "../src/traefik-adapter.js";
import { runAdoptionPass } from "../src/adoption.js";
import { promptExposureServiceName } from "../src/tui.js";
import { normalizeRedirectCode, normalizeRedirectTarget } from "../src/redirect.js";

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
    } catch {
      return { status: 404, headers: {}, body: "not found" };
    }
  }
}

function caddyAdapter(fake) {
  return createCaddyAdapter({ httpClient: { async request(options) { return fake.request(options); } }, secretResolver: () => {} });
}

test("redirect targets accept a bare hostname and default to 308", () => {
  assert.equal(normalizeRedirectTarget("home.bunny.internal"), "https://home.bunny.internal");
  assert.equal(normalizeRedirectTarget("https://home.bunny.internal/"), "https://home.bunny.internal");
  assert.equal(normalizeRedirectCode(undefined), 308);
  assert.equal(normalizeRedirectCode(307), 307);
  assert.throws(() => normalizeRedirectTarget("not a host!!"));
  assert.throws(() => normalizeRedirectCode(302));
});

test("caddy publishes a redirect on both servers with a TLS policy", async () => {
  const fake = new FakeCaddyAdmin();
  await caddyAdapter(fake).publishRoute({
    hostname: "bunny.internal",
    redirectTo: "home.bunny.internal",
    redirectCode: 308,
    caStrategy: "step-ca",
    tls: { mode: "step-ca", trusted: true },
    ip: "192.168.4.86"
  });

  const https = fake.config.apps.http.servers.srv_https.routes.find((r) => r["@id"] === "bunny.internal");
  assert.equal(https.handle[0].handler, "static_response");
  assert.equal(https.handle[0].status_code, 308);
  assert.deepEqual(https.handle[0].headers.Location, ["https://home.bunny.internal{http.request.uri}"]);

  const http = fake.config.apps.http.servers.srv_http.routes.find((r) => r["@id"] === "bunny.internal-auto-http");
  assert.equal(http.handle[0].status_code, 308);
  assert.deepEqual(http.handle[0].headers.Location, ["https://home.bunny.internal{http.request.uri}"]);

  const policies = fake.config.apps.tls.automation.policies;
  assert.ok(policies.some((p) => p.subjects.includes("bunny.internal")));
});

test("caddy health check verifies redirect target and code", async () => {
  const fake = new FakeCaddyAdmin();
  const adapter = caddyAdapter(fake);
  await adapter.publishRoute({
    hostname: "bunny.internal",
    redirectTo: "home.bunny.internal",
    redirectCode: 307,
    caStrategy: "step-ca",
    ip: "192.168.4.86"
  });

  const ok = await adapter.healthCheckExposure({ hostname: "bunny.internal", redirectTo: "home.bunny.internal", redirectCode: 307, caStrategy: "step-ca", ip: "192.168.4.86" });
  assert.equal(ok.status, "healthy");

  const wrong = await adapter.healthCheckExposure({ hostname: "bunny.internal", redirectTo: "other.bunny.internal", redirectCode: 307, caStrategy: "step-ca", ip: "192.168.4.86" });
  assert.equal(wrong.status, "unhealthy");
});

test("traefik redirect fragments use redirectRegex with noop and honor 307 vs 308", () => {
  const permanent = buildFragment({ hostname: "bunny.internal", redirectTo: "home.bunny.internal", redirectCode: 308 });
  assert.ok(permanent.includes("redirectRegex"));
  assert.ok(permanent.includes("noop@internal"));
  assert.ok(permanent.includes("replacement: \"https://home.bunny.internal/${1}\""));
  assert.ok(permanent.includes("permanent: true"));

  const temporary = buildFragment({ hostname: "bunny.internal", redirectTo: "home.bunny.internal", redirectCode: 307 });
  assert.ok(temporary.includes("permanent: false"));
});

test("the exposure selector lists redirect exposures without a backend", async () => {
  const project = {
    config: {
      managedInventory: {
        services: [
          { id: "nc_app", name: "app", exposure: { hostname: "app.bunny.internal", backend: { ip: "10.0.0.1", port: 3000 } } },
          { id: "nc_root", name: "root", exposure: { hostname: "bunny.internal", redirect: { to: "https://home.bunny.internal", code: 308 } } }
        ]
      }
    }
  };
  const selected = await promptExposureServiceName(project, undefined);
  assert.equal(selected, "nc_app");
});

function adoptionProject(exposure) {
  return {
    config: {
      managedInventory: {
        platform: {
          dns: null,
          reverseProxy: { id: "nc_caddy_test", service: "caddy", deployment: { ip: "10.0.0.86", hostname: "caddy" } },
          certificateAuthority: null,
          vpn: null
        },
        services: [{ id: "nc_svc_root", name: "root", exposure }]
      },
      baseLocalDomain: "bunny.internal"
    },
    state: { providerReferences: { nc_caddy_test: { vmid: 120, ip: "10.0.0.86" } } }
  };
}

function stubCaddy(resources) {
  return {
    async inspect() { return { resources: resources.map((r) => ({ ...r })) }; },
    async healthCheckExposure() { return { https: "reachable", status: "healthy" }; }
  };
}

test("adoption drops the redirect when the provider route becomes a backend", async () => {
  const project = adoptionProject({
    hostname: "bunny.internal",
    redirect: { to: "https://home.bunny.internal", code: 308 },
    protocol: "https"
  });
  const result = await runAdoptionPass({
    project,
    providerAdapters: {
      caddy: stubCaddy([{ id: "bunny.internal", backendIp: "10.0.0.10", backendPort: 3000, backend: { ip: "10.0.0.10", port: 3000 } }])
    },
    retryOptions: { sleep: () => Promise.resolve() }
  });
  const redirectRemoval = result.changes.find((c) => c.kind === "exposure-changed" && c.changes.redirectRemoved === true);
  assert.ok(redirectRemoval, "expected a change removing the stale redirect");
  assert.equal(redirectRemoval.after.redirect, undefined);
});

test("adoption drops the backend when the provider route becomes a redirect", async () => {
  const project = adoptionProject({
    hostname: "bunny.internal",
    backend: { ip: "10.0.0.10", port: 3000 },
    protocol: "https"
  });
  const result = await runAdoptionPass({
    project,
    providerAdapters: {
      caddy: stubCaddy([{ id: "bunny.internal", redirectTo: "https://home.bunny.internal", redirectCode: 308, redirect: { to: "https://home.bunny.internal", code: 308 } }])
    },
    retryOptions: { sleep: () => Promise.resolve() }
  });
  const redirectAdoption = result.changes.find((c) => c.kind === "exposure-changed" && c.changes.redirect !== undefined);
  assert.ok(redirectAdoption, "expected a change adopting the observed redirect");
  assert.deepEqual(redirectAdoption.after.redirect, { to: "https://home.bunny.internal", code: 308 });
  assert.equal(redirectAdoption.after.backend, undefined);
});
