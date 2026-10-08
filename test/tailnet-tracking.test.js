import test from "node:test";
import assert from "node:assert/strict";

import { createCaddyAdapter } from "../src/caddy-adapter.js";
import { createTraefikAdapter, routerNameFor } from "../src/traefik-adapter.js";
import { loadProject, serializeProjectConfiguration } from "../src/config.js";
import { runTrackingJob } from "../src/tracking.js";

const HOST = "app.home.test";
const GATEWAY = "10.0.0.60";
const PROJECT_DIR = "/projects/home";

async function trackingFixture(provider, { vpnService = "tailscale", storedTailnet = true } = {}) {
  const files = new Map();
  const filesystem = {
    exists: (path) => files.has(path),
    read: (path) => files.get(path),
    writeFile: (path, content) => files.set(path, content),
    rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    chmod() {}
  };
  const config = {
    apiVersion: "nomina.connect/v0alpha1", kind: "NominaConnect",
    proxmox: { node: "pve", defaultBridge: "vmbr0", defaultStorage: "local-lvm" },
    baseLocalDomain: "home.test",
    managedInventory: {
      platform: {
        dns: null, reverseProxy: { id: "nc_proxy", service: provider },
        certificateAuthority: null, vpn: { id: "nc_vpn", service: vpnService }
      },
      services: [{ id: "nc_app", name: "app", exposure: {
        hostname: HOST, backend: { ip: "10.0.0.80", port: 8080 },
        protocol: "https", certificateAuthority: "none", tailnet: storedTailnet
      } }]
    },
    connectionSecretReferences: {}
  };
  /** @type {any[]} */
  let caddyRoutes = [];
  let httpRoutes = [];
  let routers = [];
  let services = [];
  const name = routerNameFor(HOST);
  function edit(tailnet, backendIp = "10.0.0.80", { partial = false } = {}) {
    caddyRoutes = [{ "@id": HOST, match: [{ host: [HOST],
      ...(tailnet ? {} : { not: [{ remote_ip: { ranges: [GATEWAY] } }] }) }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `${backendIp}:8080` }] }], terminal: true }];
    httpRoutes = [];
    if (!tailnet && !partial) {
      const deny = (suffix) => ({ "@id": `${HOST}${suffix}`,
        match: [{ host: [HOST], remote_ip: { ranges: [GATEWAY] } }],
        handle: [{ handler: "static_response", status_code: 404 }], terminal: true });
      caddyRoutes.unshift(deny("-tailnet-deny"));
      httpRoutes.push(deny("-tailnet-deny-auto-http"));
    }
    const rule = `Host(\`${HOST}\`)${tailnet ? "" : ` && !ClientIP(\`${GATEWAY}\`)`}`;
    routers = [
      { name: `${name}@file`, provider: "file", rule, entryPoints: ["websecure"], service: `${name}@file`, tls: {}, status: "enabled" },
      { name: `${name}-auto-http@file`, rule: partial ? `Host(\`${HOST}\`)` : rule,
        provider: "file", entryPoints: ["web"], service: `${name}@file`, status: "enabled" }
    ];
    services = [{ name: `${name}@file`, provider: "file", loadBalancer: { servers: [{ url: `http://${backendIp}:8080` }] } }];
  }
  edit(true);
  const httpClient = {
    async request({ url }) {
      const path = new URL(url).pathname;
      const body = path === "/config/" ? { apps: { http: { servers: {
        srv_https: { routes: caddyRoutes }, srv_http: { routes: httpRoutes }
      } } } }
        : path.endsWith("/srv_https/routes") ? caddyRoutes
        : path.endsWith("/srv_http/routes") ? httpRoutes
        : path.endsWith("/automation/policies") ? [{ subjects: [HOST], issuers: [{ module: "internal" }] }]
        : path === "/api/http/routers" ? routers
        : path === "/api/http/services" ? services
        : path === "/api/http/middlewares" ? [] : {};
      return { status: 200, body: JSON.stringify(body) };
    }
  };
  const proxy = provider === "caddy"
    ? createCaddyAdapter({ httpClient, secretResolver: { resolve() {} } })
    : createTraefikAdapter({ httpClient, secretResolver: { resolve() {} }, exec: async () => ({ stdout: "" }) });
  const tailnetGatewayIp = vpnService === "tailscale" ? GATEWAY : undefined;
  const observed = (await proxy.inspect({ ip: "10.0.0.54", tailnetGatewayIp })).resources[0];
  const state = { version: 1, providerReferences: {
    nc_proxy: { vmid: 121, ip: "10.0.0.54" }, nc_vpn: { vmid: 130, ip: GATEWAY },
    nc_app: { reverseProxy: observed }
  }, tracking: { notices: [] } };
  filesystem.writeFile(`${PROJECT_DIR}/nomina.yaml`, serializeProjectConfiguration(config));
  filesystem.writeFile(`${PROJECT_DIR}/.nomina/state.json`, JSON.stringify(state));
  return {
    filesystem, edit, inspect: () => proxy.inspect({ ip: "10.0.0.54", tailnetGatewayIp }),
    project: () => loadProject(filesystem, PROJECT_DIR),
    track: () => runTrackingJob({ filesystem, projectDir: PROJECT_DIR, providerAdapters: { [provider]: proxy },
      retryOptions: { baseDelayMs: 0 } })
  };
}

test("Caddy provider tailnet edits are adopted alongside a changed backend", async () => {
  const fixture = await trackingFixture("caddy");
  fixture.edit(false, "10.0.0.81");

  const tracked = await fixture.track();

  const exposure = fixture.project().config.managedInventory.services[0].exposure;
  assert.equal(exposure.tailnet, false);
  assert.equal(exposure.backend.ip, "10.0.0.81");
  assert.ok(tracked.changes.some((change) => change.kind === "exposure-changed" && change.verified));
});

test("Traefik inspection detects provider tailnet rules relative to the gateway IP", async () => {
  const fixture = await trackingFixture("traefik");
  fixture.edit(false, "10.0.0.81");
  assert.equal((await fixture.inspect()).resources[0]?.tailnet, false, JSON.stringify(await fixture.inspect()));
});

test("background tracking does not treat a non-Tailscale VPN IP as a tailnet gateway", async () => {
  const fixture = await trackingFixture("caddy", { vpnService: "netbird", storedTailnet: false });

  const tracked = await fixture.track();

  assert.equal(fixture.project().config.managedInventory.services[0].exposure.tailnet, false);
  assert.equal(tracked.changes.some((change) => change.kind === "exposure-changed"), false);
});
