import test from "node:test";
import assert from "node:assert/strict";

import { createStepCaAdapter } from "../src/step-ca-adapter.js";

function noopSecretResolver() {}

test("step-ca install requests a SAN for step-ca.<baseLocalDomain> so Caddy can reach the ACME directory by name", async () => {
  const adapter = createStepCaAdapter({ httpClient: {}, secretResolver: noopSecretResolver });

  const plan = await adapter.setup({ zone: "bunnyhome.test" });
  const commands = plan.lxcCommands.map((command) =>
    typeof command === "string" ? command : `${command.binary} ${command.args.join(" ")}`
  );
  const initScript = commands.find((command) => command.includes("step ca init"));

  assert.notEqual(initScript, undefined, "install plan must contain step ca init");
  assert.match(
    initScript,
    /--dns "\$\(hostname -f\),localhost,step-ca\.bunnyhome\.test"/,
    "init must request a DNS SAN for step-ca.<zone>; bare IPs are not valid SAN targets for the ACME directory URL"
  );
});

test("step-ca install omits the extra SAN when no zone is provided (backwards compatible)", async () => {
  const adapter = createStepCaAdapter({ httpClient: {}, secretResolver: noopSecretResolver });

  const plan = await adapter.setup({});
  const commands = plan.lxcCommands.map((command) =>
    typeof command === "string" ? command : `${command.binary} ${command.args.join(" ")}`
  );
  const initScript = commands.find((command) => command.includes("step ca init"));

  assert.notEqual(initScript, undefined);
  assert.doesNotMatch(initScript, /step-ca\.undefined/);
});

test("every step-ca install command is time-bounded for VM-hosted Proxmox", async () => {
  const adapter = createStepCaAdapter({ httpClient: {}, secretResolver: noopSecretResolver });

  const plan = await adapter.setup({ zone: "bunnyhome.test" });

  assert.ok(plan.lxcCommands.length > 0);
  assert.ok(
    plan.lxcCommands.every((command) => Number.isFinite(command.timeoutMs) && command.timeoutMs >= 60_000),
    "apt/curl steps need more than the 30 s default on slow storage"
  );
});

// Live Proxmox run (2026-09-06): every step-ca API call failed TLS validation
// (curl rc=60) because the CA serves its own API with a certificate issued by
// its own self-signed root. The adapter used a validating HTTPS client with no
// trust anchor, so health/inspect always reported "unreachable". Bootstrap the
// root the way `step ca bootstrap` does: fetch /roots.pem once unvalidated,
// then pin every later request to that root.
const ROOT_PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";

function recordingHttpClient(responses = {}) {
  const requests = [];
  return {
    requests,
    async request(request) {
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/roots.pem") {
        return { status: 200, body: ROOT_PEM };
      }
      return responses[path] ?? { status: 200, body: JSON.stringify({ status: "ok" }) };
    }
  };
}

test("step-ca bootstraps its own root before validating any other request", async () => {
  const httpClient = recordingHttpClient();
  const adapter = createStepCaAdapter({ httpClient, secretResolver: noopSecretResolver });

  const health = await adapter.healthCheck({ ip: "10.0.0.56" });

  assert.deepEqual(health, { process: "running", endpoint: "reachable" });

  const roots = httpClient.requests.find((request) => request.url.endsWith("/roots.pem"));
  assert.notEqual(roots, undefined, "the root must be fetched to bootstrap trust");
  assert.equal(
    roots.tls?.rejectUnauthorized,
    false,
    "the bootstrap fetch is the one request that cannot validate — nothing is trusted yet"
  );

  const healthRequest = httpClient.requests.find((request) => request.url.endsWith("/health"));
  assert.equal(healthRequest.tls?.ca, ROOT_PEM, "the health probe must be validated against the CA's own root");
  assert.notEqual(healthRequest.tls?.rejectUnauthorized, false, "only the bootstrap fetch may skip validation");
});

test("step-ca fetches its trust anchor once and reuses it across calls", async () => {
  const httpClient = recordingHttpClient();
  const adapter = createStepCaAdapter({ httpClient, secretResolver: noopSecretResolver });

  await adapter.healthCheck({ ip: "10.0.0.56" });
  await adapter.healthCheck({ ip: "10.0.0.56" });

  const rootFetches = httpClient.requests.filter((request) => request.url.endsWith("/roots.pem"));
  assert.equal(rootFetches.length, 1, "the bootstrap must be cached, not repeated on every probe");
});

// Live Proxmox run (2026-09-06): `step ca init` requested SANs for the
// hostname, localhost and step-ca.<zone> only, but every adapter call reaches
// the CA at its IP. Validation against the CA's own root still failed hostname
// verification (curl rc=60 by IP, rc=0 by name), so the IP needs a SAN too.
test("step-ca install requests a SAN for the address the adapter actually connects to", async () => {
  const adapter = createStepCaAdapter({ httpClient: {}, secretResolver: noopSecretResolver });

  const plan = await adapter.setup({ zone: "bunnyhome.test", ip: "10.0.0.56" });
  const commands = plan.lxcCommands.map((command) =>
    typeof command === "string" ? command : `${command.binary} ${command.args.join(" ")}`
  );
  const initScript = commands.find((command) => command.includes("step ca init"));

  assert.match(initScript, /--dns "[^"]*10\.0\.0\.56[^"]*"/, "the CA is reached by IP; that IP needs a SAN");
});

test("step-ca install omits the IP SAN when no address is known", async () => {
  const adapter = createStepCaAdapter({ httpClient: {}, secretResolver: noopSecretResolver });

  const plan = await adapter.setup({ zone: "bunnyhome.test" });
  const initScript = plan.lxcCommands
    .map((command) => (typeof command === "string" ? command : `${command.binary} ${command.args.join(" ")}`))
    .find((command) => command.includes("step ca init"));

  assert.doesNotMatch(initScript, /,undefined/);
});
