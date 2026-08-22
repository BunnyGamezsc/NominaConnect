import { createHash } from "node:crypto";

const TECHNITIUM_PORT = 5380;
const TECHNITIUM_USER = "admin";
const TECHNITIUM_INSTALL = Object.freeze([
  { binary: "/usr/bin/apt-get", args: ["update"] },
  { binary: "/usr/bin/apt-get", args: ["install", "--yes", "curl", "ca-certificates"] },
  {
    binary: "/usr/bin/curl",
    args: ["-fsSL", "-o", "/tmp/technitium-install.sh", "https://download.technitium.com/dns/install.sh"]
  },
  { binary: "/bin/bash", args: ["/tmp/technitium-install.sh"], timeoutMs: 180_000 }
]);

export function createTechnitiumAdapter({ httpClient, secretResolver }) {
  return Object.freeze({
    async setup(plan) {
      return { ...plan, lxcCommands: TECHNITIUM_INSTALL };
    },
    async upgrade(plan) {
      return { ...plan, lxcCommands: TECHNITIUM_INSTALL };
    },
    async configure(request) {
      const session = await authenticate(httpClient, secretResolver, request);
      await createAuthoritativeZone(httpClient, session, request.zone);
      return { zone: request.zone, endpoint: session.endpoint };
    },
    async inspect(request) {
      const session = await authenticate(httpClient, secretResolver, request);
      const zones = await listZones(httpClient, session);
      const resources = [];
      for (const zone of zones) {
        const records = await listRecords(httpClient, session, zone.name);
        for (const record of records) {
          resources.push(toManagedResource(zone.name, record));
        }
      }
      return { resources };
    },
    async adopt(request) {
      const locators = new Map();
      for (const resource of request.managed ?? []) {
        const key = locatorKey(resource.locator ?? locatorFromId(resource.id, request.zone));
        locators.set(key, (locators.get(key) ?? 0) + 1);
      }
      const ambiguous = [...locators.entries()].filter(([, count]) => count > 1).map(([key]) => key);
      if (ambiguous.length > 0) {
        return {
          managedInventoryUpdate: [],
          warnings: [`Ambiguous Technitium locator ${ambiguous[0]}; managed records were not adopted.`]
        };
      }
      return {
        managedInventoryUpdate: (request.managed ?? []).map((resource) => ({
          ...resource,
          fingerprint: resource.fingerprint ?? fingerprintFor(resource.locator, resource.rData)
        }))
      };
    },
    async healthCheck(request) {
      try {
        const session = await authenticate(httpClient, secretResolver, request);
        await apiGet(httpClient, session, "/api/user/session/get");
        return { process: "running", endpoint: "reachable" };
      } catch (error) {
        if (isUnreachable(error)) {
          return { process: "stopped", endpoint: "unreachable" };
        }
        return { process: "running", endpoint: "unreachable" };
      }
    },
    async publishRecord(request) {
      const session = await authenticate(httpClient, secretResolver, request);
      const zone = zoneForHostname(request.hostname, request.zone);
      await createAuthoritativeZone(httpClient, session, zone);
      const records = await listRecords(httpClient, session, zone);
      const existing = records.find((record) => record.name === request.hostname && record.type === "A");
      if (existing === undefined) {
        await apiGet(httpClient, session, "/api/zones/records/add", {
          domain: request.hostname,
          zone,
          type: "A",
          ipAddress: request.ip
        });
      } else if (existing.rData?.ipAddress !== request.ip) {
        await apiGet(httpClient, session, "/api/zones/records/update", {
          domain: request.hostname,
          zone,
          type: "A",
          ipAddress: existing.rData.ipAddress,
          newIpAddress: request.ip
        });
      }
      const locator = { zone, name: request.hostname, type: "A" };
      const rData = { ipAddress: request.ip };
      return {
        id: request.hostname,
        locator,
        fingerprint: fingerprintFor(locator, rData),
        record: formatRecord(request.hostname, "A", rData)
      };
    },
    async deleteRecord(request) {
      const session = await authenticate(httpClient, secretResolver, request);
      const zone = zoneForHostname(request.hostname, request.zone);
      const records = await listRecords(httpClient, session, zone);
      const existing = records.find((record) => record.name === request.hostname && record.type === "A");
      if (existing === undefined) {
        return { id: request.hostname };
      }
      const locator = { zone, name: request.hostname, type: "A" };
      const expectedFingerprint = request.fingerprint ?? fingerprintFor(locator, { ipAddress: request.ip });
      const actualFingerprint = fingerprintFor(locator, existing.rData);
      if (actualFingerprint !== expectedFingerprint) {
        throw new Error(`Record ${request.hostname} in zone ${zone} does not match managed fingerprint. Aborting deletion to preserve unrelated records.`);
      }
      await apiGet(httpClient, session, "/api/zones/records/delete", {
        domain: request.hostname,
        zone,
        type: "A",
        ipAddress: existing.rData.ipAddress
      });
      return { id: request.hostname };
    },
    async healthCheckExposure(request) {
      const observed = await this.inspect(request);
      const record = observed.resources.find((resource) => resource.id === request.hostname && resource.locator?.type === "A");
      if (record === undefined) {
        return { dns: "unreachable", status: "unhealthy" };
      }
      return { dns: "reachable", status: "healthy" };
    }
  });
}

async function authenticate(httpClient, secretResolver, request) {
  const endpoint = resolveEndpoint(request);
  const password = secretResolver.resolve(request.connectionSecretReference);
  const payload = await apiGet(httpClient, { endpoint, token: undefined, redactions: [password] }, "/api/user/login", {
    user: TECHNITIUM_USER,
    pass: password
  });
  if (typeof payload.token !== "string" || payload.token.length === 0) {
    throw new Error("Technitium login did not return a session token.");
  }
  return { endpoint, token: payload.token, redactions: [password, payload.token] };
}

async function createAuthoritativeZone(httpClient, session, zone) {
  if (zone === undefined || zone === "") {
    throw new Error("Technitium authoritative zone is required.");
  }
  try {
    await apiGet(httpClient, session, "/api/zones/create", { zone, type: "Primary" });
  } catch (error) {
    if (!/already exists/i.test(error.message)) {
      throw error;
    }
  }
}

async function listZones(httpClient, session) {
  const payload = await apiGet(httpClient, session, "/api/zones/list");
  return (payload.response?.zones ?? []).map((zone) => ({
    name: normalizeName(zone.name),
    type: zone.type
  })).filter((zone) => zone.name !== "");
}

async function listRecords(httpClient, session, zone) {
  const payload = await apiGet(httpClient, session, "/api/zones/records/get", {
    domain: zone,
    zone,
    listZone: "true"
  });
  return payload.response?.records ?? [];
}

async function apiGet(httpClient, session, path, params = {}) {
  const url = new URL(path, `${session.endpoint.replace(/\/$/, "")}/`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(name, String(value));
    }
  }
  const headers = {};
  if (session.token !== undefined) {
    headers.Authorization = `Bearer ${session.token}`;
  }
  let result;
  try {
    result = await httpClient.request({
      method: "GET",
      url: url.toString(),
      headers,
      redactions: session.redactions ?? []
    });
  } catch (error) {
    error.unreachable = true;
    throw error;
  }
  let payload;
  try {
    payload = JSON.parse(result.body);
  } catch {
    throw new Error(`Technitium returned a malformed response from ${path}.`);
  }
  if (payload.status !== "ok") {
    throw new Error(payload.errorMessage ?? `Technitium API ${path} failed.`);
  }
  return payload;
}

function resolveEndpoint(request) {
  if (request.endpoint !== undefined) {
    return request.endpoint;
  }
  if (request.ip !== undefined) {
    return `http://${request.ip}:${TECHNITIUM_PORT}`;
  }
  throw new Error("Technitium API endpoint is required.");
}

function toManagedResource(zone, record) {
  const name = normalizeName(record.name);
  const locator = { zone: normalizeName(zone), name, type: record.type };
  return {
    id: name,
    locator,
    fingerprint: fingerprintFor(locator, record.rData),
    record: formatRecord(name, record.type, record.rData),
    rData: record.rData
  };
}

function formatRecord(name, type, rData = {}) {
  const value = rData.ipAddress ?? rData.nameServer ?? rData.primaryNameServer ?? "";
  return `${name} ${type} ${value}`.trim();
}

function fingerprintFor(locator, rData) {
  return createHash("sha256").update(JSON.stringify({ locator, rData: rData ?? {} })).digest("hex");
}

function locatorKey(locator) {
  return `${locator.zone}/${locator.name}/${locator.type}`;
}

function locatorFromId(id, zone) {
  return { zone, name: id, type: "A" };
}

function zoneForHostname(hostname, zone) {
  if (zone !== undefined) {
    return zone;
  }
  const parts = String(hostname).split(".");
  return parts.slice(-2).join(".");
}

function normalizeName(name) {
  return String(name ?? "").replace(/\.$/, "");
}

function isUnreachable(error) {
  return error.unreachable === true || error.cause?.code === "ECONNREFUSED" || error.name === "HttpRequestError";
}
