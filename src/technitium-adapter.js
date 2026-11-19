import { createHash } from "node:crypto";
import { conflictingDnsRecords, sameHostname } from "./exposure-identity.js";

const TECHNITIUM_PORT = 5380;
const TECHNITIUM_USER = "admin";
const TECHNITIUM_INSTALL = Object.freeze([
  { binary: "/usr/bin/apt-get", args: ["update"], timeoutMs: 180_000 },
  { binary: "/usr/bin/apt-get", args: ["install", "--yes", "curl", "ca-certificates"], timeoutMs: 180_000 },
  {
    binary: "/usr/bin/curl",
    args: ["-fsSL", "-o", "/tmp/technitium-install.sh", "https://download.technitium.com/dns/install.sh"],
    timeoutMs: 180_000
  },
  { binary: "/bin/bash", args: ["/tmp/technitium-install.sh"], timeoutMs: 180_000 }
]);

// `enableNesting` is optional: it is only needed when setup has a vmid to
// grant nesting to, and callers that only build install plans omit it.
export function createTechnitiumAdapter({ httpClient, secretResolver, enableNesting = undefined }) {
  return Object.freeze({
    async setup(plan) {
      // Technitium's unit confines itself (PrivateTmp, ProtectSystem=strict,
      // ProtectHostname, ...), which needs userns inside the container. Grant
      // nesting before installing, or dns.service fails with 226/NAMESPACE.
      if (plan?.vmid !== undefined && typeof enableNesting === "function") {
        await enableNesting(plan.vmid);
      }
      return { ...plan, lxcCommands: TECHNITIUM_INSTALL };
    },
    async upgrade(plan) {
      return { ...plan, lxcCommands: TECHNITIUM_INSTALL };
    },
    async inspectTlsListener(request) {
      const session = await authenticate(httpClient, secretResolver, request);
      const {response} = await apiGet(httpClient, session, "/api/settings/get");
      const {version, clusterInitialized, dnsServerLocalEndPoints, dnsTlsCertificatePath, dnsOverTlsPort, enableDnsOverTls, enableDnsOverHttps, enableDnsOverHttpsUnixSocket, enableDnsOverQuic, recursion} = response;
      return {version, clusterInitialized, dnsServerLocalEndPoints, dnsTlsCertificatePath, dnsOverTlsPort, enableDnsOverTls, enableDnsOverHttps, enableDnsOverHttpsUnixSocket, enableDnsOverQuic, recursion};
    },
    async setTlsEnabled(request, enabled, endpoints = undefined) {
      const session = await authenticate(httpClient, secretResolver, request);
      await apiGet(httpClient, session, "/api/settings/set", {
        enableDnsOverTls: enabled, dnsServerLocalEndPoints: endpoints?.join(",")
      });
    },
    async setTlsCertificate(request, path) {
      const session = await authenticate(httpClient, secretResolver, request);
      await apiGet(httpClient, session, "/api/settings/set", {dnsTlsCertificatePath: path, dnsTlsCertificatePassword: ""});
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
      const hostname = normalizeName(request.hostname).toLowerCase();
      const matchingRecords = records.filter((record) => sameHostname(normalizeName(record.name), hostname));
      const existing = matchingRecords.find((record) => record.type === "A");
      const guarded = request.createOnly || request.matchExisting;
      if (guarded && conflictingDnsRecords(matchingRecords.map(record => toManagedResource(zone, record)),
        request.createOnly ? undefined : request.ip).length) {
        throw new Error(request.createOnly
          ? `DNS hostname ${request.hostname} already has an unmanaged ${existing ? "A record" : "address record"}; it was preserved.`
          : `DNS records for ${request.hostname} conflict with its shared listener address; they were preserved.`);
      }
      if (existing === undefined) {
        await apiGet(httpClient, session, "/api/zones/records/add", {
          domain: request.hostname,
          zone,
          type: "A",
          ipAddress: request.ip,
          overwrite: false
        });
        if (guarded) {
          try {
            const after = (await listRecords(httpClient, session, zone))
              .filter(record => sameHostname(normalizeName(record.name), hostname));
            const published = after.some(record => record.type === "A" && record.rData?.ipAddress === request.ip);
            if (!published || conflictingDnsRecords(after.map(record => toManagedResource(zone, record)), request.ip).length) {
              throw new Error(`DNS records for ${request.hostname} changed during publication.`);
            }
          } catch (error) {
            try {
              // Technitium appends records without overwrite. Delete only the
              // exact address sent by this successful add.
              await deleteAddress(httpClient, session, zone, request.hostname, request.ip);
            } catch (cleanup) {
              throw new Error(`${error.message} DNS rollback requires attention. ${cleanup.message}`, { cause: error });
            }
            throw error;
          }
        }
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
      const hostname = normalizeName(request.hostname).toLowerCase();
      const matchingAddresses = records.filter((record) => record.type === "A" && normalizeName(record.name).toLowerCase() === hostname);
      if (matchingAddresses.length === 0) {
        return { id: request.hostname };
      }
      const locator = { zone, name: request.hostname, type: "A" };
      const expectedFingerprint = request.fingerprint ?? fingerprintFor(locator, { ipAddress: request.ip });
      const existing = matchingAddresses.find(record => fingerprintFor(locator, record.rData) === expectedFingerprint);
      if (existing === undefined) {
        throw new Error(`Record ${request.hostname} in zone ${zone} does not match managed fingerprint. Aborting deletion to preserve unrelated records.`);
      }
      await deleteAddress(httpClient, session, zone, request.hostname, existing.rData.ipAddress);
      return { id: request.hostname };
    },
    async healthCheckExposure(request) {
      const observed = await this.inspect(request);
      const record = observed.resources.find((resource) => resource.id === request.hostname && resource.locator?.type === "A");
      if (record === undefined || (request.expectedIp !== undefined && record.record !== `${request.hostname} A ${request.expectedIp}`)) {
        return { dns: "unreachable", status: "unhealthy" };
      }
      return { dns: "reachable", status: "healthy" };
    }
  });
}

function deleteAddress(httpClient, session, zone, hostname, ipAddress) {
  return apiGet(httpClient, session, "/api/zones/records/delete", { domain: hostname, zone, type: "A", ipAddress });
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
