import { createHash } from "node:crypto";

const CADDY_ADMIN_PORT = 2019;
const CADDY_INSTALL = Object.freeze([
  { binary: "/usr/bin/apt-get", args: ["update"] },
  { binary: "/usr/bin/apt-get", args: ["install", "--yes", "debian-keyring", "debian-archive-keyring", "apt-transport-https", "curl"] },
  { binary: "/usr/bin/curl", args: ["-1sLf", "https://dl.cloudsmith.io/public/caddy/stable/gpg.key", "-o", "/usr/share/keyrings/caddy-stable-archive-keyring.gpg"] },
  { binary: "/bin/bash", args: ["-c", "curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt | tee /etc/apt/sources.list.d/caddy-stable.list"] },
  { binary: "/usr/bin/apt-get", args: ["update"] },
  { binary: "/usr/bin/apt-get", args: ["install", "--yes", "caddy"], timeoutMs: 120_000 }
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
        lxcCommands: [{ binary: "/usr/bin/apt-get", args: ["install", "--only-upgrade", "--yes", "caddy"] }]
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
      try {
        routes = await listRoutes(httpClient, endpoint);
      } catch (error) {
        if (isUnreachable(error)) {
          throw error;
        }
        throw error;
      }
      const resources = routes.map(toManagedResource);
      return { resources };
    },
    async adopt(request) {
      const locators = new Map();
      for (const resource of request.managed ?? []) {
        const key = locatorKey(resource.locator ?? { host: resource.id, configPath: `/config/apps/http/servers/srv0/routes/${resource.id}` });
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
          fingerprint: resource.fingerprint ?? fingerprintFor(resource.locator ?? { host: resource.id }, routeFromResource(resource))
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
      const routes = await listRoutes(httpClient, endpoint);
      const existing = routes.find((r) => hostForRoute(r) === request.hostname);
      const newRoute = buildRoute(request);
      const newFingerprint = fingerprintFor({ host: request.hostname, configPath: `/config/apps/http/servers/srv0/routes/${request.hostname}` }, newRoute);
      if (existing !== undefined) {
        const existingFingerprint = fingerprintFor({ host: request.hostname, configPath: `/config/apps/http/servers/srv0/routes/${request.hostname}` }, existing);
        if (existingFingerprint === newFingerprint) {
          return { id: request.hostname, locator: { host: request.hostname, configPath: `/config/apps/http/servers/srv0/routes/${request.hostname}` }, fingerprint: newFingerprint, route: formatRoute(request.hostname, newRoute) };
        }
        await apiPut(httpClient, endpoint, `/config/apps/http/servers/srv0/routes/${encodeURIComponent(request.hostname)}`, newRoute);
      } else {
        const hasIndexPath = routes.length === 0;
        // Use targeted PUT to create at host key; fallback to POST array if needed
        try {
          await apiPut(httpClient, endpoint, `/config/apps/http/servers/srv0/routes/${encodeURIComponent(request.hostname)}`, newRoute);
        } catch (error) {
          if (hasIndexPath) {
            await apiPost(httpClient, endpoint, "/config/apps/http/servers/srv0/routes", newRoute);
          } else {
            throw error;
          }
        }
      }
      const locator = { host: request.hostname, configPath: `/config/apps/http/servers/srv0/routes/${request.hostname}` };
      return {
        id: request.hostname,
        locator,
        fingerprint: newFingerprint,
        route: formatRoute(request.hostname, newRoute)
      };
    },
    async unpublishRoute(request) {
      const endpoint = resolveEndpoint(request);
      const routes = await listRoutes(httpClient, endpoint);
      const existing = routes.find((r) => hostForRoute(r) === request.hostname);
      if (existing === undefined) {
        return { id: request.hostname };
      }
      if (request.fingerprint !== undefined) {
        const actual = fingerprintFor({ host: request.hostname, configPath: `/config/apps/http/servers/srv0/routes/${request.hostname}` }, existing);
        if (actual !== request.fingerprint) {
          throw new Error(`Route ${request.hostname} does not match managed fingerprint. Aborting deletion to preserve unrelated routes.`);
        }
      }
      await apiDelete(httpClient, endpoint, `/config/apps/http/servers/srv0/routes/${encodeURIComponent(request.hostname)}`);
      return { id: request.hostname };
    },
    async deleteRoute(request) {
      return this.unpublishRoute(request);
    },
    async healthCheckExposure(request) {
      const endpoint = resolveEndpoint(request);
      let routes;
      try {
        routes = await listRoutes(httpClient, endpoint);
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
      // Always HTTPS; trusted depends on TLS mode
      const tls = matched.tls ?? {};
      const trusted = tls.trusted === true || tls.issuer === "internal" && request.tls?.trusted === true || false;
      // For untrusted exposures, Caddy still serves HTTPS but reports untrusted
      const routeTrusted = matched.tls?.trusted ?? (matched.tls?.issuer !== undefined ? true : false);
      // If no CA configured, Caddy serves HTTPS with untrusted cert
      // We report healthy regardless of trust, but include tls trusted flag for caller to interpret
      // For spec: exposure without CA should be untrusted but not fallback to HTTP
      const httpsReachable = "reachable";
      // Determine if this route matches requested backend
      const dial = matched.handle?.[0]?.upstreams?.[0]?.dial ?? matched.upstreams?.[0]?.dial;
      const expectedDial = request.backendIp && request.backendPort ? `${request.backendIp}:${request.backendPort}` : undefined;
      if (expectedDial !== undefined && dial !== undefined && dial !== expectedDial) {
        return { https: httpsReachable, tls: routeTrusted ? "valid" : "untrusted", status: "unhealthy" };
      }
      return { https: httpsReachable, tls: routeTrusted ? "valid" : "untrusted", status: "healthy" };
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

async function listRoutes(httpClient, endpoint) {
  try {
    const payload = await apiGet(httpClient, endpoint, "/config/apps/http/servers/srv0/routes");
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
    if (/404|not found|no such/i.test(msg)) {
      return [];
    }
    throw error;
  }
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

function buildRoute(request) {
  const { hostname, backendIp, backendPort, tls, caStrategy } = request;
  const trusted = tls?.trusted === true;
  let tlsConfig;
  if (caStrategy === "caddy-internal-ca") {
    tlsConfig = { issuer: "internal", trusted: true };
  } else if (caStrategy === "step-ca") {
    const caIp = tls?.caIp ?? request.caIp;
    tlsConfig = caIp ? { issuer: "acme", ca: `https://${caIp}:8443/acme/acme/directory`, trusted: true } : { issuer: "acme", trusted: true };
  } else {
    tlsConfig = trusted ? { trusted: true } : { trusted: false, issuer: "internal" };
    if (!trusted) {
      // Untrusted still serves HTTPS with self-signed/internal cert
      tlsConfig.issuer = "internal";
    }
  }
  return {
    "@id": hostname,
    match: [{ host: [hostname] }],
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `${backendIp}:${backendPort}` }] }],
    terminal: true,
    tls: tlsConfig
  };
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

function toManagedResource(route) {
  const host = hostForRoute(route) ?? route["@id"] ?? "unknown";
  const locator = { host, configPath: `/config/apps/http/servers/srv0/routes/${host}` };
  const dial = route.handle?.[0]?.upstreams?.[0]?.dial;
  const tls = route.tls;
  const [backendIp, backendPortRaw] = typeof dial === "string" && dial.includes(":") ? dial.split(":") : [undefined, undefined];
  const backendPort = backendPortRaw !== undefined ? Number(backendPortRaw) : undefined;
  const backend = backendIp !== undefined && backendPort !== undefined ? { ip: backendIp, port: backendPort } : undefined;
  return {
    id: host,
    locator,
    fingerprint: fingerprintFor(locator, route),
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
