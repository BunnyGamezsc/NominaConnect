import { createHash } from "node:crypto";

const CADDY_ADMIN_PORT = 2019;
// Restarts of the distro unit reload only /etc/caddy/Caddyfile, wiping every
// admin-API route and TLS policy. This drop-in prefers a persisted JSON dump
// (/etc/caddy/caddy.json, refreshed after each publish/remove) when present.
const CADDY_PERSISTENCE_DROPIN = [
  "mkdir -p /etc/systemd/system/caddy.service.d",
  "cat > /etc/systemd/system/caddy.service.d/nomina-persistence.conf <<'EOS'",
  "[Service]",
  "ExecStart=",
  "ExecStart=/bin/sh -c 'if [ -s /etc/caddy/caddy.json ]; then exec /usr/bin/caddy run --config /etc/caddy/caddy.json; else exec /usr/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile; fi'",
  "EOS",
  "systemctl daemon-reload"
].join("\n");

const CADDY_INSTALL = Object.freeze([
  { binary: "/usr/bin/apt-get", args: ["update"] },
  { binary: "/usr/bin/apt-get", args: ["install", "--yes", "debian-keyring", "debian-archive-keyring", "apt-transport-https", "curl"] },
  { binary: "/usr/bin/curl", args: ["-1sLf", "https://dl.cloudsmith.io/public/caddy/stable/gpg.key", "-o", "/usr/share/keyrings/caddy-stable-archive-keyring.gpg"] },
  { binary: "/bin/bash", args: ["-c", "curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | tee /etc/apt/sources.list.d/caddy-stable.list"] },
  { binary: "/usr/bin/apt-get", args: ["update"] },
  { binary: "/usr/bin/apt-get", args: ["install", "--yes", "caddy"], timeoutMs: 180_000 },
  {
    binary: "/bin/bash",
    args: [
      "-c",
      [
        "printf '{\\n  admin 0.0.0.0:2019\\n}\\n:80 {\\n  respond \"OK\" 200\\n}\\n' > /etc/caddy/Caddyfile",
        CADDY_PERSISTENCE_DROPIN,
        "systemctl enable --now caddy && systemctl restart caddy"
      ].join("\n")
    ],
    timeoutMs: 30_000
  }
]);

export function createCaddyAdapter({ httpClient, secretResolver }) {
  return Object.freeze({
    async setup(plan) {
      if (plan.connectionSecretReference !== undefined) {
        try { secretResolver.resolve(plan.connectionSecretReference); } catch {}
      }
      if (plan.provider === "caddy-internal-ca") {
        return { ...plan, lxcCommands: [{ binary: "/usr/bin/caddy", args: ["trust"] }] };
      }
      return { ...plan, lxcCommands: [...CADDY_INSTALL] };
    },
    async upgrade(plan) {
      if (plan.connectionSecretReference !== undefined) {
        try { secretResolver.resolve(plan.connectionSecretReference); } catch {}
      }
      return {
        ...plan,
        lxcCommands: [
          { binary: "/usr/bin/apt-get", args: ["install", "--only-upgrade", "--yes", "caddy"] },
          // Pre-existing installs lack the persistence drop-in; without it a
          // restart wipes all published routes/TLS policies.
          { binary: "/bin/bash", args: ["-c", `${CADDY_PERSISTENCE_DROPIN}\nsystemctl restart caddy`] }
        ]
      };
    },
    async configure(request) {
      if (request.connectionSecretReference !== undefined) {
        try { secretResolver.resolve(request.connectionSecretReference); } catch {}
      }
      const endpoint = resolveEndpoint(request);
      try {
        await apiGet(httpClient, endpoint, "/config/");
      } catch {
        // If admin API not yet reachable, treat as not-configured; setup will ensure install
      }
      return { endpoint };
    },
    async inspect(request) {
      if (request.connectionSecretReference !== undefined) {
        try { secretResolver.resolve(request.connectionSecretReference); } catch {}
      }
      const endpoint = resolveEndpoint(request);
      let routes;
      let policies;
      try {
        routes = await listRoutes(httpClient, endpoint, TLS_SERVER);
        policies = await listTlsPolicies(httpClient, endpoint);
      } catch (error) {
        if (isUnreachable(error)) {
          throw error;
        }
        throw error;
      }
      const resources = routes.filter((route) => !isRedirectRoute(route)).map((route) => toManagedResource(route, policies));
      return { resources };
    },
    async adopt(request) {
      const locators = new Map();
      for (const resource of request.managed ?? []) {
        const key = locatorKey(resource.locator ?? { host: resource.id, configPath: `/config/apps/http/servers/${TLS_SERVER}/routes/${resource.id}` });
        locators.set(key, (locators.get(key) ?? 0) + 1);
      }
      const ambiguous = [...locators.entries()].filter(([, count]) => count > 1).map(([key]) => key);
      if (ambiguous.length > 0) {
        return {
          managedInventoryUpdate: [],
          warnings: [`Ambiguous Caddy route locator ${ambiguous[0]}; managed routes were not adopted.`]
        };
      }
      return {
        managedInventoryUpdate: (request.managed ?? []).map((resource) => ({
          ...resource,
          fingerprint: resource.fingerprint ?? fingerprintFor(resource.locator ?? { host: resource.id }, { route: routeFromResource(resource), tls: resource.tls })
        }))
      };
    },
    async healthCheck(request) {
      const endpoint = resolveEndpoint(request);
      try {
        await apiGet(httpClient, endpoint, "/config/");
        return { process: "running", endpoint: "reachable" };
      } catch (error) {
        if (isUnreachable(error)) {
          return { process: "stopped", endpoint: "unreachable" };
        }
        return { process: "running", endpoint: "unreachable" };
      }
    },
    async publishRoute(request) {
      const endpoint = resolveEndpoint(request);
      if (request.connectionSecretReference !== undefined) {
        try { secretResolver.resolve(request.connectionSecretReference); } catch {}
      }
      await ensureServers(httpClient, endpoint);
      const newRoute = buildManagedRoute(request.hostname, request.backendIp, request.backendPort);
      const desiredPolicy = { subjects: [request.hostname], issuers: [issuerFor(request)] };
      await upsertRoute(httpClient, endpoint, TLS_SERVER, request.hostname, [newRoute]);
      if (request.httpRedirect === true) {
        await upsertRoute(httpClient, endpoint, HTTP_SERVER, request.hostname, [buildRedirectRoute(request.hostname)]);
      } else {
        await removeRedirect(httpClient, endpoint, request.hostname);
      }
      await upsertTlsPolicy(httpClient, endpoint, desiredPolicy);
      const locator = { host: request.hostname, configPath: `/config/apps/http/servers/${TLS_SERVER}/routes/${request.hostname}` };
      return {
        id: request.hostname,
        locator,
        fingerprint: fingerprintFor(locator, { route: newRoute, tls: desiredPolicy }),
        route: formatRoute(request.hostname, newRoute)
      };
    },
    async unpublishRoute(request) {
      const endpoint = resolveEndpoint(request);
      await ensureServers(httpClient, endpoint);
      const routes = await listRoutes(httpClient, endpoint);
      const existing = routes.find((r) => hostForRoute(r) === request.hostname);
      const existingRedirect = routes.find((r) => r["@id"] === `${request.hostname}${REDIRECT_SUFFIX}`);
      const policies = await listTlsPolicies(httpClient, endpoint);
      const existingPolicy = policies.find((policy) => policy.subjects?.includes(request.hostname));
      if (existing === undefined && existingPolicy === undefined) {
        return { id: request.hostname };
      }
      if (existing !== undefined || existingRedirect !== undefined) {
        if (request.fingerprint !== undefined) {
          const actual = await managedFingerprintFor(httpClient, endpoint, request.hostname);
          if (actual !== null && actual !== request.fingerprint) {
            throw new Error(`Route ${request.hostname} does not match managed fingerprint. Aborting deletion to preserve unrelated routes.`);
          }
        }
        const remaining = routes.filter((r) => !isManagedRouteFor(r, request.hostname));
        await replaceMapValue(httpClient, endpoint, tlsRoutesPath(), remaining);
        const httpRoutesNow = await listRoutes(httpClient, endpoint, HTTP_SERVER);
        const remainingHttp = httpRoutesNow.filter((r) => !isManagedRouteFor(r, request.hostname));
        if (remainingHttp.length !== httpRoutesNow.length) {
          await replaceMapValue(httpClient, endpoint, httpRoutesPath(), remainingHttp);
        }
      }
      if (existingPolicy !== undefined) {
        const remainingPolicies = policies.filter((policy) => !policy.subjects?.includes(request.hostname));
        await replaceMapValue(httpClient, endpoint, "/config/apps/tls/automation/policies", remainingPolicies);
      }
      return { id: request.hostname };
    },
    async deleteRoute(request) {
      return this.unpublishRoute(request);
    },
    async healthCheckExposure(request) {
      const endpoint = resolveEndpoint(request);
      let routes;
      let policies;
      try {
        routes = await listRoutes(httpClient, endpoint, TLS_SERVER);
        policies = await listTlsPolicies(httpClient, endpoint);
      } catch (error) {
        if (isUnreachable(error)) {
          return { https: "unreachable", status: "unhealthy" };
        }
        throw error;
      }
      const matched = routes.find((r) => hostForRoute(r) === request.hostname);
      if (matched === undefined) {
        return { https: "unreachable", status: "unhealthy" };
      }
      const policy = policies.find((entry) => entry.subjects?.includes(request.hostname));
      const tls = tlsSummaryFor(policy?.issuers?.[0]);
      const dial = matched.handle?.[0]?.upstreams?.[0]?.dial ?? matched.upstreams?.[0]?.dial;
      const expectedDial = request.backendIp && request.backendPort ? `${request.backendIp}:${request.backendPort}` : undefined;
      if (expectedDial !== undefined && dial !== undefined && dial !== expectedDial) {
        return { https: "reachable", tls: tls.trusted ? "valid" : "untrusted", status: "unhealthy" };
      }
      return { https: "reachable", tls: tls.trusted ? "valid" : "untrusted", status: "healthy" };
    }
  });
}

function resolveEndpoint(request) {
  if (request.endpoint !== undefined) {
    return request.endpoint;
  }
  if (request.ip !== undefined) {
    return `http://${request.ip}:${CADDY_ADMIN_PORT}`;
  }
  return `http://127.0.0.1:${CADDY_ADMIN_PORT}`;
}

const TLS_SERVER = "srv_https";
const HTTP_SERVER = "srv_http";

// Caddy 2.11.x silently never matches the "protocol" request matcher, so
// scheme separation is done with two servers instead: srv_https (:443) holds
// the TLS routes, srv_http (:80) holds the 308 redirects.
function tlsRoutesPath() {
  return `/config/apps/http/servers/${TLS_SERVER}/routes`;
}

function httpRoutesPath() {
  return `/config/apps/http/servers/${HTTP_SERVER}/routes`;
}

async function listRoutes(httpClient, endpoint, server = TLS_SERVER) {
  try {
    const payload = await apiGet(httpClient, endpoint, `/config/apps/http/servers/${server}/routes`);
    if (Array.isArray(payload)) {
      return payload;
    }
    if (payload === null || payload === undefined) {
      return [];
    }
    if (typeof payload === "object" && !Array.isArray(payload)) {
      // Config may be object keyed by @id or index
      const values = Object.values(payload);
      if (values.length > 0 && typeof values[0] === "object") {
        return values;
      }
      return [payload];
    }
    return [];
  } catch (error) {
    const msg = error.message ?? "";
    if (/404|not found|no such|invalid traversal|cannot unmarshal|invalid array index/i.test(msg) || /400/.test(msg)) {
      return [];
    }
    throw error;
  }
}

async function listTlsPolicies(httpClient, endpoint) {
  try {
    const payload = await apiGet(httpClient, endpoint, "/config/apps/tls/automation/policies");
    if (Array.isArray(payload)) {
      return payload;
    }
    return [];
  } catch (error) {
    const msg = error.message ?? "";
    if (/404|not found|no such|invalid traversal|cannot unmarshal|invalid array index/i.test(msg) || /400/.test(msg)) {
      return [];
    }
    throw error;
  }
}

// Creates the dedicated :443/:80 servers when missing, and migrates any
// legacy single-server config (srv0) into them: host routes belong to the
// HTTPS server, hostless catch-alls to the HTTP server. srv0 is then removed.
//
// Ordering matters: srv0 must be deleted BEFORE its routes land in the new
// servers, because Caddy enforces globally-unique @id values across the whole
// config at write time ("duplicate ID found at ...").
async function ensureServers(httpClient, endpoint) {
  let servers = {};
  try {
    servers = await apiGet(httpClient, endpoint, "/config/apps/http/servers") ?? {};
  } catch (error) {
    if (!/404|400|invalid traversal|not found/i.test(error.message)) {
      throw error;
    }
  }

  const existingHttps = servers[TLS_SERVER];
  const existingHttp = servers[HTTP_SERVER];

  const legacyRoutes = Array.isArray(servers.srv0?.routes) ? servers.srv0.routes : [];
  if (legacyRoutes.length > 0) {
    // Drop stale scheme pins from older publishes; servers carry the scheme now.
    for (const route of legacyRoutes) {
      for (const matcher of route.match ?? []) {
        delete matcher.protocol;
      }
    }
    // Remove srv0 first so its @ids are free to be recreated in the new servers.
    await apiDelete(httpClient, endpoint, "/config/apps/http/servers/srv0");
    servers.srv0 = undefined;

    const seen = new Set(
      [...(existingHttps?.routes ?? []), ...(existingHttp?.routes ?? [])]
        .map((route) => route["@id"])
        .filter(Boolean)
    );
    const httpsRoutes = existingHttps?.routes ?? [];
    const httpRoutes = existingHttp?.routes ?? [];
    for (const route of legacyRoutes) {
      if (route["@id"] !== undefined && seen.has(route["@id"])) {
        continue;
      }
      if (route["@id"] !== undefined) {
        seen.add(route["@id"]);
      }
      (hasHostMatcher(route) ? httpsRoutes : httpRoutes).push(route);
    }

    if (existingHttps === undefined) {
      await apiPut(httpClient, endpoint, `/config/apps/http/servers/${TLS_SERVER}`, { listen: [":443"], routes: httpsRoutes });
    } else {
      await replaceMapValue(httpClient, endpoint, tlsRoutesPath(), httpsRoutes);
    }
    if (existingHttp === undefined) {
      await apiPut(httpClient, endpoint, `/config/apps/http/servers/${HTTP_SERVER}`, { listen: [":80"], routes: httpRoutes });
    } else {
      await replaceMapValue(httpClient, endpoint, httpRoutesPath(), httpRoutes);
    }
    return;
  }

  if (existingHttps === undefined) {
    await apiPut(httpClient, endpoint, `/config/apps/http/servers/${TLS_SERVER}`, { listen: [":443"], routes: [] });
  }
  if (existingHttp === undefined) {
    await apiPut(httpClient, endpoint, `/config/apps/http/servers/${HTTP_SERVER}`, { listen: [":80"], routes: [] });
  }
}

async function upsertRoute(httpClient, endpoint, server, hostname, additions) {
  const path = `/config/apps/http/servers/${server}/routes`;
  const routes = await listRoutes(httpClient, endpoint, server);
  const remaining = routes.filter((r) => !isManagedRouteFor(r, hostname));
  const catchAllIndex = remaining.findIndex((r) => !hasHostMatcher(r));
  if (catchAllIndex === -1) {
    remaining.push(...additions);
  } else {
    // Host-specific routes must precede hostless catch-alls or they are shadowed
    remaining.splice(catchAllIndex, 0, ...additions);
  }
  await replaceMapValue(httpClient, endpoint, path, remaining);
}

async function removeRedirect(httpClient, endpoint, hostname) {
  const routes = await listRoutes(httpClient, endpoint, HTTP_SERVER);
  const filtered = routes.filter((r) => r["@id"] !== `${hostname}${REDIRECT_SUFFIX}`);
  if (filtered.length !== routes.length) {
    await replaceMapValue(httpClient, endpoint, httpRoutesPath(), filtered);
  }
}

async function upsertTlsPolicy(httpClient, endpoint, desiredPolicy) {
  const policies = await listTlsPolicies(httpClient, endpoint);
  const hasTlsApp = await tlsAppExists(httpClient, endpoint);
  if (policies.length === 0 && !hasTlsApp) {
    await apiPut(httpClient, endpoint, "/config/apps/tls", { automation: { policies: [desiredPolicy] } });
    return;
  }
  const remaining = policies.filter((policy) => !policy.subjects?.includes(desiredPolicy.subjects[0]));
  remaining.push(desiredPolicy);
  await replaceMapValue(httpClient, endpoint, "/config/apps/tls/automation/policies", remaining);
}

// Caddy's admin API refuses to PUT over an existing key (409), so replacing a
// value requires deleting it first and putting the new value back.
async function replaceMapValue(httpClient, endpoint, path, value) {
  await apiDelete(httpClient, endpoint, path);
  await apiPut(httpClient, endpoint, path, value);
}

async function tlsAppExists(httpClient, endpoint) {
  try {
    await apiGet(httpClient, endpoint, "/config/apps/tls/automation/policies");
    return true;
  } catch (error) {
    if (/404|not found|no such|invalid traversal|cannot unmarshal|invalid array index|400/.test(error.message)) {
      return false;
    }
    throw error;
  }
}

async function managedFingerprintFor(httpClient, endpoint, hostname) {
  const [routes, policies] = await Promise.all([
    listRoutes(httpClient, endpoint, TLS_SERVER),
    listTlsPolicies(httpClient, endpoint)
  ]);
  const route = routes.find((r) => hostForRoute(r) === hostname);
  if (route === undefined) {
    return null;
  }
  const policy = policies.find((entry) => entry.subjects?.includes(hostname));
  const locator = { host: hostname, configPath: `/config/apps/http/servers/${TLS_SERVER}/routes/${hostname}` };
  return fingerprintFor(locator, { route, tls: policy });
}

async function apiGet(httpClient, endpoint, path) {
  const url = `${endpoint.replace(/\/$/, "")}${path}`;
  let result;
  try {
    result = await httpClient.request({ method: "GET", url, headers: {}, redactions: [] });
  } catch (error) {
    error.unreachable = true;
    throw error;
  }
  if (result.status >= 400) {
    const bodyText = String(result.body ?? "");
    if (result.status === 404) {
      throw new Error(`Caddy Admin API ${path} not found (404).`);
    }
    throw new Error(`Caddy Admin API ${path} failed with status ${result.status}: ${bodyText}`);
  }
  if (result.body === undefined || result.body === "" || result.body === "null") {
    return null;
  }
  try {
    return JSON.parse(result.body);
  } catch {
    throw new Error(`Caddy returned a malformed response from ${path}.`);
  }
}

async function apiPut(httpClient, endpoint, path, body) {
  const url = `${endpoint.replace(/\/$/, "")}${path}`;
  let result;
  try {
    result = await httpClient.request({ method: "PUT", url, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redactions: [] });
  } catch (error) {
    error.unreachable = true;
    throw error;
  }
  if (result.status >= 400) {
    throw new Error(`Caddy Admin API PUT ${path} failed with status ${result.status}: ${result.body}`);
  }
  if (result.body && result.body !== "null") {
    try { return JSON.parse(result.body); } catch { return result.body; }
  }
  return null;
}

async function apiPost(httpClient, endpoint, path, body) {
  const url = `${endpoint.replace(/\/$/, "")}${path}`;
  let result;
  try {
    result = await httpClient.request({ method: "POST", url, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redactions: [] });
  } catch (error) {
    error.unreachable = true;
    throw error;
  }
  if (result.status >= 400) {
    throw new Error(`Caddy Admin API POST ${path} failed with status ${result.status}: ${result.body}`);
  }
  if (result.body && result.body !== "null") {
    try { return JSON.parse(result.body); } catch { return result.body; }
  }
  return null;
}

async function apiDelete(httpClient, endpoint, path) {
  const url = `${endpoint.replace(/\/$/, "")}${path}`;
  let result;
  try {
    result = await httpClient.request({ method: "DELETE", url, headers: {}, redactions: [] });
  } catch (error) {
    error.unreachable = true;
    throw error;
  }
  if (result.status >= 400 && result.status !== 404) {
    throw new Error(`Caddy Admin API DELETE ${path} failed with status ${result.status}: ${result.body}`);
  }
  return null;
}

function buildManagedRoute(hostname, backendIp, backendPort) {
  return {
    "@id": hostname,
    match: [{ host: [hostname] }],
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `${backendIp}:${backendPort}` }] }],
    terminal: true
  };
}

const REDIRECT_SUFFIX = "-auto-http";

// Plain-HTTP hits for an exposure are redirected to HTTPS instead of served.
// The route matches only cleartext requests (protocol matcher) so it never
// shadows the TLS route; @id carries the suffix so inspection/adoption treat
// it as implementation detail rather than a second managed resource.
function buildRedirectRoute(hostname) {
  return {
    "@id": `${hostname}${REDIRECT_SUFFIX}`,
    match: [{ host: [hostname], protocol: "http://" }],
    handle: [{
      handler: "static_response",
      status_code: 308,
      headers: { Location: ["https://{http.request.host}{http.request.uri}"] }
    }],
    terminal: true
  };
}

function isRedirectRoute(route) {
  return typeof route["@id"] === "string" && route["@id"].endsWith(REDIRECT_SUFFIX);
}

function isManagedRouteFor(route, hostname) {
  return hostForRoute(route) === hostname || route["@id"] === `${hostname}${REDIRECT_SUFFIX}`;
}

function issuerFor(request) {
  if (request.caStrategy === "step-ca") {
    // step-ca serving certs carry DNS SANs only (no IP SANs), so the ACME
    // directory must be reached by hostname; fall back to the IP for older projects.
    const caHost = request.tls?.caHost ?? request.tls?.caIp;
    const issuer = { module: "acme" };
    if (caHost) {
      issuer.ca = `https://${caHost}:9000/acme/acme/directory`;
    }
    return issuer;
  }
  return { module: "internal" };
}

function tlsSummaryFor(issuer) {
  if (issuer?.module === "acme") {
    return { issuer: "acme", trusted: true, ...(issuer.ca ? { ca: issuer.ca } : {}) };
  }
  return { issuer: "internal", trusted: false };
}

function hasHostMatcher(route) {
  return route.match?.some((matcher) => matcher.host !== undefined);
}

function hostForRoute(route) {
  if (typeof route["@id"] === "string" && route["@id"] !== "") {
    return route["@id"];
  }
  const host = route.match?.[0]?.host?.[0] ?? route.match?.[0]?.host;
  if (Array.isArray(host)) {
    return host[0];
  }
  if (typeof host === "string") {
    return host;
  }
  return undefined;
}

function toManagedResource(route, policies = []) {
  const host = hostForRoute(route) ?? route["@id"] ?? "unknown";
  const locator = { host, configPath: `/config/apps/http/servers/${TLS_SERVER}/routes/${host}` };
  const dial = route.handle?.[0]?.upstreams?.[0]?.dial;
  const policy = policies.find((entry) => entry.subjects?.includes(host));
  const tls = tlsSummaryFor(policy?.issuers?.[0]);
  const [backendIp, backendPortRaw] = typeof dial === "string" && dial.includes(":") ? dial.split(":") : [undefined, undefined];
  const backendPort = backendPortRaw !== undefined ? Number(backendPortRaw) : undefined;
  const backend = backendIp !== undefined && backendPort !== undefined ? { ip: backendIp, port: backendPort } : undefined;
  return {
    id: host,
    locator,
    fingerprint: fingerprintFor(locator, { route, tls: policy }),
    route: formatRoute(host, route),
    handle: route.handle,
    match: route.match,
    tls,
    dial,
    backendIp,
    backendPort,
    backend,
    rData: { dial, tls }
  };
}

function formatRoute(host, route) {
  const dial = route.handle?.[0]?.upstreams?.[0]?.dial ?? "unknown";
  return `https://${host} -> ${dial}`;
}

function routeFromResource(resource) {
  if (resource.handle !== undefined || resource.match !== undefined) {
    return { handle: resource.handle, match: resource.match, tls: resource.tls };
  }
  return {};
}

function fingerprintFor(locator, route) {
  return createHash("sha256").update(JSON.stringify({ locator, route: route ?? {} })).digest("hex");
}

function locatorKey(locator) {
  return `${locator.configPath ?? locator.host ?? locator.zone ?? ""}/${locator.host ?? locator.name ?? ""}`;
}

function isUnreachable(error) {
  return error.unreachable === true || error.cause?.code === "ECONNREFUSED" || error.name === "HttpRequestError";
}
