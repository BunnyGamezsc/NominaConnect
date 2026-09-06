// ---------------------------------------------------------------------------
// Disposable live-Proxmox acceptance suite (issue #21).
//
// The conformance suite proves every catalog provider behaves through its real
// adapter against controlled fixtures. This file is the other half: it runs
// the same public commands against an actual Proxmox host, so a command plan
// or an HTTP fixture can never be mistaken for working infrastructure.
//
// It is deliberately NOT part of `npm test`. Its filename matches none of the
// node test runner's default patterns, so it only runs when named explicitly:
//
//   npm run test:acceptance
//
// See docs/live-proxmox-acceptance.md for the full environment reference.
//
// Safety rules this file holds itself to:
//   - It only ever destroys LXCs whose vmid it read back out of the project's
//     own state file. A pre-existing container is never a teardown target.
//   - It seeds one unmanaged DNS record and one unmanaged proxy route through
//     each provider's own interface, then asserts both survived the run.
//   - It never prints a resolved connection secret.
// ---------------------------------------------------------------------------

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { runCli } from "../src/cli.js";
import { loadProject } from "../src/config.js";
import { createHttpClient, createProductionAdapters } from "../src/adapter-runtime.js";

const REQUIRED = [
  "NOMINA_ACCEPTANCE_STORAGE",
  "NOMINA_ACCEPTANCE_BRIDGE",
  "NOMINA_ACCEPTANCE_TEMPLATE",
  "NOMINA_ACCEPTANCE_DNS_IP",
  "NOMINA_ACCEPTANCE_PROXY_IP",
  "NOMINA_ACCEPTANCE_BACKEND"
];

function skipReason() {
  if (process.env.NOMINA_ACCEPTANCE !== "1") {
    return "set NOMINA_ACCEPTANCE=1 to run the live Proxmox acceptance suite";
  }
  if (process.env.NOMINA_ACCEPTANCE_DISPOSABLE !== "yes") {
    return "set NOMINA_ACCEPTANCE_DISPOSABLE=yes to confirm this Proxmox host is disposable";
  }
  if (process.getuid?.() !== 0) {
    return "the acceptance suite runs from the Proxmox root shell (ADR-0031)";
  }
  if (!fs.existsSync("/usr/sbin/pct")) {
    return "no Proxmox pct command found on this host";
  }
  const missing = REQUIRED.filter((name) => (process.env[name] ?? "") === "");
  if (missing.length > 0) {
    return `missing environment: ${missing.join(", ")}`;
  }
  return undefined;
}

const skip = skipReason();
const proxy = process.env.NOMINA_ACCEPTANCE_PROXY ?? "caddy";
const ca = process.env.NOMINA_ACCEPTANCE_CA ?? "none";
const vpn = process.env.NOMINA_ACCEPTANCE_VPN ?? "none";
const [backendIp, backendPort] = (process.env.NOMINA_ACCEPTANCE_BACKEND ?? ":").split(":");
const domain = process.env.NOMINA_ACCEPTANCE_DOMAIN ?? "acceptance.test";
const exposedHostname = `photos.${domain}`;
const unmanagedHostname = `legacy.${domain}`;
const unmanagedRouteHost = `operator.${domain}`;
// A fresh Technitium install has the default admin password until an operator
// changes it. NominaConnect authenticates with whatever is in the secret
// store; it never sets the password itself.
const dnsPassword = process.env.NOMINA_ACCEPTANCE_DNS_PASSWORD ?? "admin";

const filesystem = {
  exists: fs.existsSync,
  read: (target) => fs.readFileSync(target, "utf8"),
  mkdir: (target) => fs.mkdirSync(target, { recursive: true }),
  writeFile: fs.writeFileSync,
  rename: fs.renameSync,
  chmod: fs.chmodSync,
  deletePath: (target) => fs.rmSync(target, { recursive: true, force: true })
};

const runtime = {
  isRoot: () => process.getuid?.() === 0,
  isProxmoxHost: () => fs.existsSync("/usr/sbin/pct")
};

// Only the secret prompt is supplied. Every other guided prompt falls back to
// the flags and plugin defaults, so the run is deterministic and the same code
// path an operator walks through still executes.
const prompts = {
  secret: async (question) => {
    if (/technitium/i.test(question)) {
      return dnsPassword;
    }
    if (/tailscale|netbird/i.test(question)) {
      const key = process.env.NOMINA_ACCEPTANCE_VPN_KEY;
      assert.ok(key, "a VPN acceptance run needs NOMINA_ACCEPTANCE_VPN_KEY");
      return key;
    }
    return process.env.NOMINA_ACCEPTANCE_PROXY_SECRET ?? "acceptance-unused";
  },
  warn: () => {},
  info: () => {}
};

test("live Proxmox acceptance", { skip, timeout: 45 * 60 * 1000 }, async (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomina-acceptance-"));
  const production = createProductionAdapters();
  const adapters = { filesystem, cwd: projectDir, runtime, ...production, prompts };
  const cli = (argumentsList) => runCli([...argumentsList, "--project-dir", projectDir], adapters);

  const project = () => loadProject(filesystem, projectDir);
  const platformId = (key) => project().config.managedInventory.platform[key]?.id;
  const referenceFor = (key) => project().state.providerReferences[platformId(key)];
  const createdVmids = () => Object.values(project().state.providerReferences ?? {})
    .map((reference) => reference?.vmid)
    .filter((vmid) => vmid !== undefined);

  // Teardown destroys only what this run recorded in its own state file.
  t.after(async () => {
    for (const vmid of createdVmids()) {
      try {
        await production.proxmox.stopLxc(vmid);
      } catch {}
      try {
        await production.proxmox.destroyLxc(vmid);
      } catch {}
    }
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  await t.test("initialises a project against this node", async () => {
    await cli([
      "init",
      "--node", process.env.NOMINA_ACCEPTANCE_NODE ?? os.hostname(),
      "--bridge", process.env.NOMINA_ACCEPTANCE_BRIDGE,
      "--storage", process.env.NOMINA_ACCEPTANCE_STORAGE,
      "--domain", domain,
      "--dns", "technitium",
      "--reverse-proxy", proxy,
      "--ca", ca,
      "--vpn", vpn
    ]);

    const config = project().config;
    assert.equal(config.managedInventory.platform.reverseProxy.service, proxy);
    assert.equal(config.baseLocalDomain, domain);
  });

  let dnsVmid;

  await t.test("creates a real unprivileged Debian LXC for Technitium", async () => {
    await cli(["service", "add", "technitium", "--ip", process.env.NOMINA_ACCEPTANCE_DNS_IP, ...templateFlags()]);

    dnsVmid = referenceFor("dns").vmid;
    assert.ok(Number.isFinite(dnsVmid), "the created LXC id was recorded in local state");

    const observed = await production.proxmox.inspectLxc(dnsVmid);
    assert.equal(observed.ip, process.env.NOMINA_ACCEPTANCE_DNS_IP, "the LXC has the requested static IP");
    assert.equal(observed.unprivileged, true, "service LXCs stay unprivileged (ADR-0030)");
    assert.equal(observed.bridge, process.env.NOMINA_ACCEPTANCE_BRIDGE);
  });

  await t.test("blocks a requested IP that is already in use", async () => {
    const availability = await production.proxmox.checkIpAvailability(process.env.NOMINA_ACCEPTANCE_DNS_IP);
    assert.equal(availability.status, "known-collision", "IP preflight sees the LXC it just created");

    await assert.rejects(
      () => cli(["service", "add", proxy, "--ip", process.env.NOMINA_ACCEPTANCE_DNS_IP, ...templateFlags()]),
      /already in use/i,
      "a known collision blocks provisioning instead of creating a second LXC"
    );
  });

  await t.test(`creates a real LXC for ${proxy}`, async () => {
    await cli(["service", "add", proxy, "--ip", process.env.NOMINA_ACCEPTANCE_PROXY_IP, ...templateFlags()]);

    const observed = await production.proxmox.inspectLxc(referenceFor("reverseProxy").vmid);
    assert.equal(observed.ip, process.env.NOMINA_ACCEPTANCE_PROXY_IP);
    assert.equal(observed.unprivileged, true);
  });

  if (ca !== "none") {
    await t.test(`provisions ${ca}`, async () => {
      const flags = ca === "step-ca"
        ? ["--ip", requireEnv("NOMINA_ACCEPTANCE_CA_IP"), ...templateFlags()]
        : [];
      const result = await cli(["service", "add", ca, ...flags]);
      assert.match(result.stdout, /healthy/i, "a CA that is not reachable is not a successful install");
    });
  }

  await t.test("preserves provider configuration NominaConnect did not create", async () => {
    // Seeded through each provider's own interface, exactly as an operator
    // would, before NominaConnect publishes anything of its own.
    await seedUnmanagedRecord(referenceFor("dns").ip);
    await seedUnmanagedRoute(production, referenceFor("reverseProxy"));

    const published = await cli([
      "exposure", "publish",
      "--name", "photos",
      "--hostname", exposedHostname,
      "--backend-ip", backendIp,
      "--backend-port", backendPort
    ]);

    assert.match(published.stdout, /published|updated/i);
    assert.match(published.stdout, /healthy/i, "a published exposure must actually serve");
    assert.doesNotMatch(published.stdout, /http:\/\//, "an exposure is never downgraded to HTTP");

    const records = await technitiumRecords(referenceFor("dns").ip);
    assert.ok(
      records.some((record) => record.name?.replace(/\.$/, "") === unmanagedHostname),
      "the operator's own DNS record survived the run"
    );
    assert.ok(
      records.some((record) => record.name?.replace(/\.$/, "") === exposedHostname),
      "the managed record was published"
    );

    const routeHosts = await proxyRouteHosts(referenceFor("reverseProxy").ip);
    assert.ok(routeHosts.includes(unmanagedRouteHost), "the operator's own proxy route survived the run");
    assert.ok(routeHosts.includes(exposedHostname), "the managed route was published");
  });

  await t.test("records a provider-native locator that background tracking can resolve", async () => {
    const exposureReference = Object.values(project().state.providerReferences)
      .find((reference) => reference?.reverseProxy === exposedHostname);
    assert.ok(
      exposureReference?.integrations?.reverseProxy?.locator !== undefined,
      "publishing recorded a provider-native locator and fingerprint for the route"
    );
    assert.ok(
      exposureReference?.integrations?.dns?.locator !== undefined,
      "publishing recorded a provider-native locator and fingerprint for the record"
    );

    // `nomina changes` reports whatever the background tracking pass observed.
    const changes = await cli(["changes"]);
    assert.doesNotMatch(changes.stdout, /health check failed/i, "a settled platform reports no health warnings");
  });

  if (vpn !== "none") {
    await t.test(`enrols ${vpn} and reports an operational client`, async () => {
      const key = requireEnv("NOMINA_ACCEPTANCE_VPN_KEY");
      const result = await cli([
        "service", "add", vpn,
        "--ip", requireEnv("NOMINA_ACCEPTANCE_VPN_IP"),
        ...templateFlags()
      ]);
      assert.match(result.stdout, /healthy/i, "a VPN that did not enrol is not a successful install");
      assert.doesNotMatch(
        result.stdout,
        new RegExp(escapeRegExp(key)),
        "an enrollment credential must never reach command output"
      );
    });
  }
});

function templateFlags() {
  const flags = ["--template", process.env.NOMINA_ACCEPTANCE_TEMPLATE];
  if (process.env.NOMINA_ACCEPTANCE_GATEWAY) {
    flags.push("--gateway", process.env.NOMINA_ACCEPTANCE_GATEWAY);
  }
  return flags;
}

function requireEnv(name) {
  const value = process.env[name];
  assert.ok(value, `${name} must be set for this part of the acceptance run`);
  return value;
}

// ---------------------------------------------------------------------------
// Provider-native seeding and verification
//
// These talk to each provider through its own documented interface rather than
// through NominaConnect, so "unmanaged configuration was preserved" means what
// it says.
// ---------------------------------------------------------------------------

async function technitiumSession(ip) {
  const login = await technitiumCall(ip, "/api/user/login", { user: "admin", pass: dnsPassword });
  assert.ok(login.token, "could not authenticate against Technitium with the stored admin password");
  return login.token;
}

async function technitiumCall(ip, apiPath, params = {}, token = undefined) {
  const url = new URL(apiPath, `http://${ip}:5380/`);
  for (const [name, value] of Object.entries(params)) {
    url.searchParams.set(name, String(value));
  }
  const response = await fetch(url, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` }
  });
  const payload = await response.json();
  assert.equal(payload.status, "ok", `Technitium ${apiPath} failed: ${payload.errorMessage ?? response.status}`);
  return payload;
}

async function seedUnmanagedRecord(ip) {
  const token = await technitiumSession(ip);
  await technitiumCall(ip, "/api/zones/create", { zone: domain, type: "Primary" }, token).catch(() => {});
  await technitiumCall(ip, "/api/zones/records/add", {
    domain: unmanagedHostname,
    zone: domain,
    type: "A",
    ttl: 3600,
    ipAddress: "10.99.99.99"
  }, token);
}

async function technitiumRecords(ip) {
  const token = await technitiumSession(ip);
  const payload = await technitiumCall(ip, "/api/zones/records/get", {
    domain,
    zone: domain,
    listZone: "true"
  }, token);
  return payload.response?.records ?? [];
}

// Caddy's admin endpoint rejects requests carrying browser headers (notably
// from global fetch), so provider-native Caddy calls use the same raw
// transport the product adapter uses instead of globalThis.fetch.
const adminClient = createHttpClient();

async function seedUnmanagedRoute(production, proxyReference) {
  if (proxy === "traefik") {
    // A dynamic fragment the operator dropped into the watched directory.
    const fragment = [
      "http:",
      "  routers:",
      "    operator-owned:",
      `      rule: "Host(\`${unmanagedRouteHost}\`)"`,
      "      entryPoints: [websecure]",
      "      service: operator-owned",
      "      tls: {}",
      "  services:",
      "    operator-owned:",
      "      loadBalancer:",
      "        servers:",
      `          - url: "http://${backendIp}:${backendPort}"`
    ].join("\n");
    await production.proxmox.pctExec(proxyReference.vmid, {
      binary: "/bin/bash",
      args: ["-c", `mkdir -p /etc/traefik/dynamic && cat > /etc/traefik/dynamic/operator-owned.yml <<'EOY'\n${fragment}\nEOY`]
    });
    return;
  }

  // A route the operator added through Caddy's own admin API. An operator
  // first needs the server to exist, so create it with the same shape the
  // product's ensureServers uses when it is missing; a later publish leaves
  // an existing server and its routes alone.
  const adminBase = `http://${proxyReference.ip}:2019`;
  const serverProbe = await adminClient.request({
    method: "GET",
    url: `${adminBase}/config/apps/http/servers/srv_https`,
    headers: {}
  });
  assert.ok(serverProbe.status < 500, `could not read the Caddy config: ${serverProbe.status} ${serverProbe.body}`);
  if (serverProbe.status === 404) {
    const created = await adminClient.request({
      method: "PUT",
      url: `${adminBase}/config/apps/http/servers/srv_https`,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listen: [":443"], routes: [] })
    });
    assert.ok(created.status >= 200 && created.status < 300, `could not create the Caddy srv_https server: ${created.status} ${created.body}`);
  }
  // Routes are replaced as a whole array (PUT), the same way the product
  // publishes: Caddy rejects POST traversal for a fresh server's routes.
  const unmanagedRoute = {
    "@id": unmanagedRouteHost,
    match: [{ host: [unmanagedRouteHost] }],
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `${backendIp}:${backendPort}` }] }],
    terminal: true
  };
  const routesProbe = await adminClient.request({
    method: "GET",
    url: `${adminBase}/config/apps/http/servers/srv_https/routes`,
    headers: {}
  });
  // A fresh server has no traversable routes path; like the product's
  // listRoutes, treat that as an empty route table rather than an error.
  const routesProbeBody = String(routesProbe.body ?? "");
  const noRoutesYet = routesProbe.status === 404
    || /invalid traversal|no such|not found|cannot unmarshal|invalid array index/i.test(routesProbeBody);
  assert.ok(
    (routesProbe.status >= 200 && routesProbe.status < 300) || (routesProbe.status === 400 && noRoutesYet),
    `could not read Caddy routes: ${routesProbe.status} ${routesProbe.body}`
  );
  const existingRoutes = noRoutesYet || routesProbe.status === 404 ? [] : (JSON.parse(routesProbe.body || "null") ?? []);
  const seeded = await adminClient.request({
    method: "PUT",
    url: `${adminBase}/config/apps/http/servers/srv_https/routes`,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([...existingRoutes, unmanagedRoute])
  });
  assert.ok(seeded.status >= 200 && seeded.status < 300, `could not seed an unmanaged Caddy route: ${seeded.status} ${seeded.body}`);
}

async function proxyRouteHosts(ip) {
  if (proxy === "traefik") {
    const response = await fetch(`http://${ip}:8080/api/http/routers`);
    const routers = await response.json();
    return routers
      .map((router) => router.rule?.match(/Host\(`([^`]+)`\)/)?.[1])
      .filter((host) => host !== undefined);
  }
  const probed = await adminClient.request({
    method: "GET",
    url: `http://${ip}:2019/config/apps/http/servers/srv_https/routes`,
    headers: {}
  });
  const probedBody = String(probed.body ?? "");
  if (
    probed.status === 404
    || (probed.status === 400 && /invalid traversal|no such|not found|cannot unmarshal|invalid array index/i.test(probedBody))
  ) {
    return [];
  }
  assert.ok(probed.status >= 200 && probed.status < 300, `could not read Caddy routes: ${probed.status} ${probed.body}`);
  const routes = JSON.parse(probed.body || "null") ?? [];
  return routes
    .map((route) => route.match?.[0]?.host?.[0])
    .filter((host) => host !== undefined);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
