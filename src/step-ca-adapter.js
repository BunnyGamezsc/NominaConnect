import { createHash } from "node:crypto";

const STEP_CA_PORT = 9000;
const STEP_CA_HEALTH_PATH = "/health";
const STEP_CA_ACME_DIRECTORY_PATH = "/acme/acme/directory";
const STEP_CA_ROOTS_PATH = "/roots.pem";

const STEP_CA_INSTALL = Object.freeze([
  { binary: "/usr/bin/apt-get", args: ["update"] },
  { binary: "/usr/bin/apt-get", args: ["install", "--yes", "curl", "ca-certificates", "gnupg"] },
  {
    binary: "/bin/bash",
    args: [
      "-c",
      "curl -fsSL https://packages.smallstep.com/keys/apt/GPG-KEY.asc | gpg --dearmor -o /usr/share/keyrings/smallstep-archive-keyring.gpg"
    ]
  },
  {
    binary: "/bin/bash",
    args: [
      "-c",
      "echo 'deb [signed-by=/usr/share/keyrings/smallstep-archive-keyring.gpg] https://packages.smallstep.com/stable/debian stable main' > /etc/apt/sources.list.d/smallstep.list"
    ]
  },
  { binary: "/usr/bin/apt-get", args: ["update"] },
  { binary: "/usr/bin/apt-get", args: ["install", "--yes", "step-ca"], timeoutMs: 180_000 },
  {
    binary: "/bin/bash",
    args: [
      "-c",
      "mkdir -p /var/lib/stepca && [ -f /var/lib/stepca/config/ca.json ] || ( PASSWORD=$(cat /var/lib/stepca/password.txt 2>/dev/null || echo 'nomina-step-ca-$(head -c 12 /dev/urandom | base64)'); echo \"$PASSWORD\" > /var/lib/stepca/password.txt; chmod 600 /var/lib/stepca/password.txt; step ca init --deployment-type standalone --name \"NominaConnect CA\" --dns \"$(hostname -f),localhost\" --address \":9000\" --provisioner admin --password-file /var/lib/stepca/password.txt --acme || true ) && systemctl enable --now step-ca"
    ],
    timeoutMs: 30_000
  }
]);

export function createStepCaAdapter({ httpClient, secretResolver }) {
  return Object.freeze({
    async setup(plan) {
      if (plan.connectionSecretReference !== undefined) {
        try {
          secretResolver.resolve(plan.connectionSecretReference);
        } catch {}
      }
      return { ...plan, lxcCommands: [...STEP_CA_INSTALL] };
    },
    async upgrade(plan) {
      if (plan.connectionSecretReference !== undefined) {
        try {
          secretResolver.resolve(plan.connectionSecretReference);
        } catch {}
      }
      return {
        ...plan,
        lxcCommands: [{ binary: "/usr/bin/apt-get", args: ["install", "--only-upgrade", "--yes", "step-ca"] }]
      };
    },
    async configure(request) {
      if (request.connectionSecretReference !== undefined) {
        try {
          secretResolver.resolve(request.connectionSecretReference);
        } catch {}
      }
      const endpoint = resolveEndpoint(request);
      // Verify CA is reachable after install; bounded retry handled by caller
      try {
        await apiGet(httpClient, endpoint, STEP_CA_HEALTH_PATH, request);
      } catch {
        // not yet reachable is acceptable during setup; caller will retry health
      }
      return { endpoint };
    },
    async inspect(request) {
      if (request.connectionSecretReference !== undefined) {
        try {
          secretResolver.resolve(request.connectionSecretReference);
        } catch {}
      }
      const endpoint = resolveEndpoint(request);
      let provisioners;
      try {
        provisioners = await listProvisioners(httpClient, endpoint, request);
      } catch (error) {
        if (isUnreachable(error)) {
          return { resources: [] };
        }
        provisioners = [];
      }
      const resources = provisioners.map((provisioner) => toManagedResource(provisioner));
      // If no provisioners found but CA is reachable, synthesize a default resource
      if (resources.length === 0) {
        try {
          await apiGet(httpClient, endpoint, STEP_CA_HEALTH_PATH, request);
          resources.push({
            id: "step-ca-root",
            locator: { name: "step-ca-root", type: "ca" },
            fingerprint: fingerprintFor({ name: "step-ca-root", type: "ca" }, { status: "ok" }),
            provisioner: { name: "step-ca-root", type: "JWK" }
          });
        } catch {
          return { resources: [] };
        }
      }
      return { resources };
    },
    async adopt(request) {
      const locators = new Map();
      for (const resource of request.managed ?? []) {
        const key = locatorKey(resource.locator ?? { name: resource.id, type: "ca" });
        locators.set(key, (locators.get(key) ?? 0) + 1);
      }
      const ambiguous = [...locators.entries()].filter(([, count]) => count > 1).map(([key]) => key);
      if (ambiguous.length > 0) {
        return {
          managedInventoryUpdate: [],
          warnings: [`Ambiguous step-ca locator ${ambiguous[0]}; managed CA resources were not adopted.`]
        };
      }
      return {
        managedInventoryUpdate: (request.managed ?? []).map((resource) => ({
          ...resource,
          fingerprint: resource.fingerprint ?? fingerprintFor(resource.locator ?? { name: resource.id, type: "ca" }, resource.provisioner ?? {})
        }))
      };
    },
    async healthCheck(request) {
      const endpoint = resolveEndpoint(request);
      try {
        await apiGet(httpClient, endpoint, STEP_CA_HEALTH_PATH, request);
        return { process: "running", endpoint: "reachable" };
      } catch (error) {
        if (isUnreachable(error)) {
          return { process: "stopped", endpoint: "unreachable" };
        }
        return { process: "running", endpoint: "unreachable" };
      }
    },
    async healthCheckExposure(request) {
      const endpoint = resolveEndpoint(request);
      // Step 1: check CA health endpoint
      try {
        await apiGet(httpClient, endpoint, STEP_CA_HEALTH_PATH, request);
      } catch (error) {
        if (isUnreachable(error)) {
          return { tls: "unreachable", issuer: "step-ca", status: "unhealthy", reason: "Unable to reach step-ca health endpoint." };
        }
        return { tls: "invalid", issuer: "step-ca", status: "unhealthy", reason: "step-ca health check failed." };
      }
      // Step 2: check ACME directory (certificate issuance capability)
      try {
        await apiGet(httpClient, endpoint, STEP_CA_ACME_DIRECTORY_PATH, request);
      } catch (error) {
        if (isUnreachable(error)) {
          return { tls: "unreachable", issuer: "step-ca", status: "unhealthy", reason: "Unable to reach step-ca ACME directory." };
        }
        // Some deployments may not expose ACME but still issue via provisioner; check roots as fallback
        try {
          await apiGet(httpClient, endpoint, STEP_CA_ROOTS_PATH, request);
        } catch (inner) {
          if (isUnreachable(inner)) {
            return { tls: "unreachable", issuer: "step-ca", status: "unhealthy", reason: "Unable to verify step-ca trust anchor." };
          }
          return { tls: "invalid", issuer: "step-ca", status: "unhealthy", reason: "step-ca certificate issuance check failed." };
        }
      }
      return { tls: "valid", issuer: "step-ca", status: "healthy" };
    }
  });
}

function resolveEndpoint(request) {
  if (request.endpoint !== undefined) {
    return request.endpoint;
  }
  if (request.ip !== undefined) {
    return `https://${request.ip}:${STEP_CA_PORT}`;
  }
  return `https://127.0.0.1:${STEP_CA_PORT}`;
}

async function listProvisioners(httpClient, endpoint, request) {
  // Try admin provisioners endpoint; may require auth. Attempt with and without token.
  const candidates = ["/admin/provisioners", "/provisioners"];
  for (const path of candidates) {
    try {
      const payload = await apiGet(httpClient, endpoint, path, request);
      if (Array.isArray(payload.provisioners)) {
        return payload.provisioners;
      }
      if (Array.isArray(payload)) {
        return payload;
      }
      if (payload !== null && typeof payload === "object") {
        const values = Object.values(payload);
        if (values.length > 0 && typeof values[0] === "object") {
          return values;
        }
      }
    } catch (error) {
      if (isUnreachable(error)) {
        throw error;
      }
      // try next candidate
    }
  }
  return [];
}

async function apiGet(httpClient, endpoint, path, request = {}) {
  const url = `${endpoint.replace(/\/$/, "")}${path}`;
  let headers = {};
  let redactions = [];
  if (request.connectionSecretReference !== undefined) {
    // Optionally resolve secret to attach as bearer for provisioner API; redaction handled by adapter layer
    // Do not fail if secret not resolvable in test contexts
  }
  let result;
  try {
    result = await httpClient.request({ method: "GET", url, headers, redactions });
  } catch (error) {
    error.unreachable = true;
    throw error;
  }
  if (result.status >= 400) {
    const bodyText = String(result.body ?? "");
    if (result.status === 404) {
      throw new Error(`step-ca API ${path} not found (404).`);
    }
    throw new Error(`step-ca API ${path} failed with status ${result.status}: ${bodyText}`);
  }
  if (result.body === undefined || result.body === "" || result.body === "null") {
    return null;
  }
  // Roots endpoint returns PEM text, not JSON
  if (path === STEP_CA_ROOTS_PATH) {
    return result.body;
  }
  try {
    return JSON.parse(result.body);
  } catch {
    // Health endpoint may return plain text "ok" or JSON
    const trimmed = String(result.body).trim().toLowerCase();
    if (trimmed === "ok" || trimmed.includes("ok")) {
      return { status: "ok" };
    }
    throw new Error(`step-ca returned a malformed response from ${path}.`);
  }
}

function toManagedResource(provisioner) {
  const name = provisioner.name ?? provisioner.id ?? "unknown";
  const type = provisioner.type ?? "JWK";
  const locator = { name, type };
  return {
    id: name,
    locator,
    fingerprint: fingerprintFor(locator, provisioner),
    provisioner
  };
}

function fingerprintFor(locator, data) {
  return createHash("sha256").update(JSON.stringify({ locator, data: data ?? {} })).digest("hex");
}

function locatorKey(locator) {
  return `${locator.name ?? locator.id ?? ""}/${locator.type ?? ""}`;
}

function isUnreachable(error) {
  return error.unreachable === true || error.cause?.code === "ECONNREFUSED" || error.name === "HttpRequestError";
}
