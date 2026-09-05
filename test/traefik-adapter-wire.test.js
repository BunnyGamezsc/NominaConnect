import test from "node:test";
import assert from "node:assert/strict";

import {
  createTraefikAdapter,
  buildFragment,
  fragmentPathFor,
  routerNameFor,
  applyStepCaResolver,
  stepCaResolverBlock
} from "../src/traefik-adapter.js";

const DYNAMIC_DIR = "/etc/traefik/dynamic";
const STATIC_CONFIG_PATH = "/etc/traefik/traefik.yml";
const ACME_STORAGE_PATH = "/etc/traefik/acme.json";
const STEP_CA_ROOT_CERT = "/usr/local/share/ca-certificates/step-ca-root.crt";
const noSleep = () => Promise.resolve();

// What `nomina service add traefik` leaves in the LXC, so trust configuration
// is exercised against the file it really edits.
const INSTALLED_STATIC_CONFIG = `entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
  traefik:
    address: ":8080"
api:
  dashboard: true
  insecure: true
providers:
  file:
    directory: ${DYNAMIC_DIR}
    watch: true
log:
  level: INFO
`;

// ---------------------------------------------------------------------------
// A stand-in for a Traefik LXC: it stores the files NominaConnect writes over
// pct exec, parses the watched dynamic directory the way Traefik's file
// provider does, and serves the result through the dashboard API. Parsing the
// emitted YAML rather than trusting it is the point — it proves the fragment
// NominaConnect writes is configuration Traefik can actually load.
// ---------------------------------------------------------------------------
class FakeTraefikLxc {
  constructor({ vmid = 121, reachable = true, stepCa = {} } = {}) {
    this.vmid = vmid;
    this.reachable = reachable;
    this.files = new Map();
    this.execCalls = [];
    this.requests = [];
    this.restarts = 0;
    // Traefik reads its static configuration and the system trust store once
    // at start, so issuance only works after a restart picked both up.
    this.pendingRestart = false;
    this.trustedRoots = [];
    this.stepCa = {
      reachable: true,
      issues: true,
      handshake: true,
      root: "-----BEGIN CERTIFICATE-----\nnomina-step-ca-root\n-----END CERTIFICATE-----",
      ...stepCa
    };
    this.files.set(STATIC_CONFIG_PATH, INSTALLED_STATIC_CONFIG);
  }

  exec = (vmid, command) => {
    this.execCalls.push({ vmid, command });
    assert.equal(vmid, this.vmid, "commands must target the managed Traefik LXC");
    assert.equal(typeof command.binary, "string");
    assert.ok(Array.isArray(command.args), "commands must use a fixed argument array");
    if (command.binary === "/bin/rm") {
      for (const target of command.args.filter((argument) => !argument.startsWith("-"))) {
        this.files.delete(target);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.binary === "/bin/cat") {
      return { exitCode: 0, stdout: this.#read(command.args[0]), stderr: "" };
    }
    if (command.binary === "/usr/bin/curl") {
      return this.#runCurl(command.args);
    }
    if (command.binary === "/bin/bash" && command.args[0] === "-c") {
      this.#runScript(command.args[1]);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  // pct exec surfaces a non-zero exit as a thrown CommandExecutionError, so a
  // missing file has to fail the same way here.
  #read(path) {
    if (path === ACME_STORAGE_PATH) {
      const issued = this.#issuedCertificates();
      if (issued.length === 0) {
        throw new Error(`/bin/cat ${path} exited with status 1. cat: ${path}: No such file or directory`);
      }
      return JSON.stringify({
        "nomina-stepca": {
          Account: { Email: "nomina@bunnyhome.test" },
          Certificates: issued.map((hostname) => ({ domain: { main: hostname }, certificate: "cert", key: "key" }))
        }
      });
    }
    if (!this.files.has(path)) {
      throw new Error(`/bin/cat ${path} exited with status 1. cat: ${path}: No such file or directory`);
    }
    return this.files.get(path);
  }

  // step-ca issues for a hostname once its router names a resolver that the
  // running static configuration actually defines.
  #issuedCertificates() {
    if (!this.stepCa.reachable || !this.stepCa.issues || this.pendingRestart) {
      return [];
    }
    if (!this.trustedRoots.includes(this.stepCa.root)) {
      return [];
    }
    const resolvers = this.#configuredResolvers();
    return this.routers()
      .filter((router) => resolvers.includes(router.tls?.certResolver))
      .map((router) => router.rule?.match(/Host\(`([^`]+)`\)/)?.[1])
      .filter((hostname) => hostname !== undefined);
  }

  #configuredResolvers() {
    const document = parseYaml(this.files.get(STATIC_CONFIG_PATH) ?? "");
    return Object.keys(document.certificatesResolvers ?? {});
  }

  #runCurl(args) {
    const url = args[args.length - 1];
    if (url.endsWith("/roots.pem")) {
      if (!this.stepCa.reachable) {
        throw new Error(`/usr/bin/curl ${args.join(" ")} exited with status 7. curl: (7) Failed to connect`);
      }
      return { exitCode: 0, stdout: `${this.stepCa.root}\n`, stderr: "" };
    }
    // The trusted-handshake probe: it succeeds only when the certificate
    // Traefik presents was issued by a CA the LXC trusts.
    const hostname = new URL(url).hostname;
    if (this.stepCa.handshake === false || !this.#issuedCertificates().includes(hostname)) {
      throw new Error(`/usr/bin/curl ${args.join(" ")} exited with status 60. curl: (60) SSL certificate problem: unable to get local issuer certificate`);
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  request = ({ method, url }) => {
    this.requests.push({ method, url });
    if (!this.reachable) {
      const error = new Error(`connect ECONNREFUSED ${url}`);
      error.cause = { code: "ECONNREFUSED" };
      throw error;
    }
    const path = new URL(url).pathname.replace(/\/$/, "");
    if (path === "/api/overview") {
      return { status: 200, body: JSON.stringify({ http: { routers: { total: this.routers().length } } }) };
    }
    if (path === "/api/http/routers") {
      return { status: 200, body: JSON.stringify(this.routers()) };
    }
    if (path === "/api/http/services") {
      return { status: 200, body: JSON.stringify(this.services()) };
    }
    return { status: 404, body: JSON.stringify({ error: "not found" }) };
  };

  // Everything the file provider loaded from the watched directory.
  #loaded() {
    const routers = [];
    const services = [];
    for (const [path, content] of this.files) {
      if (!path.startsWith(`${DYNAMIC_DIR}/`) || !/\.(ya?ml)$/.test(path)) {
        continue;
      }
      const document = parseYaml(content);
      for (const [name, configuration] of Object.entries(document.http?.routers ?? {})) {
        routers.push({
          ...configuration,
          name: `${name}@file`,
          provider: "file",
          status: "enabled",
          using: configuration.entryPoints ?? []
        });
      }
      for (const [name, configuration] of Object.entries(document.http?.services ?? {})) {
        services.push({
          ...configuration,
          name: `${name}@file`,
          provider: "file",
          status: "enabled",
          usedBy: [],
          serverStatus: { "http://backend": "UP" }
        });
      }
    }
    return { routers, services };
  }

  routers() {
    return this.#loaded().routers;
  }

  services() {
    return this.#loaded().services;
  }

  fragmentNames() {
    return [...this.files.keys()].filter((path) => path.startsWith(`${DYNAMIC_DIR}/`)).sort();
  }

  seed(path, content) {
    this.files.set(path, content);
  }

  // Interprets the shell NominaConnect emits: mkdir, heredoc writes, mv, rm.
  #runScript(script) {
    const lines = script.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      const heredoc = line.match(/^cat > (\S+) <<'(\w+)'$/);
      if (heredoc !== null) {
        const [, target, marker] = heredoc;
        const body = [];
        index += 1;
        while (index < lines.length && lines[index] !== marker) {
          body.push(lines[index]);
          index += 1;
        }
        assert.ok(index < lines.length, `heredoc ${marker} was never terminated`);
        this.files.set(target, `${body.join("\n")}\n`);
        continue;
      }
      const move = line.match(/^mv -f (\S+) (\S+)$/);
      if (move !== null) {
        const [, from, to] = move;
        assert.ok(this.files.has(from), `mv source ${from} does not exist`);
        if (to === STATIC_CONFIG_PATH && this.files.get(to) !== this.files.get(from)) {
          this.pendingRestart = true;
        }
        this.files.set(to, this.files.get(from));
        this.files.delete(from);
        continue;
      }
      const remove = line.match(/^rm -f (.+)$/);
      if (remove !== null) {
        for (const target of remove[1].split(/\s+/)) {
          this.files.delete(target);
        }
        continue;
      }
      if (line === "update-ca-certificates") {
        const root = this.files.get(STEP_CA_ROOT_CERT);
        assert.ok(root !== undefined, "update-ca-certificates ran without an installed root certificate");
        this.trustedRoots.push(root.trim());
        this.pendingRestart = true;
        continue;
      }
      if (line === "systemctl restart traefik") {
        this.restarts += 1;
        this.pendingRestart = false;
      }
    }
  }
}

// Indentation-based parser covering the subset of YAML the fragments use:
// nested maps, block sequences, quoted and bare scalars, and inline `{}`.
function parseYaml(text) {
  const lines = text
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  const [value] = parseBlock(lines, 0, indentOf(lines[0] ?? ""));
  return value ?? {};
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function parseBlock(lines, start, indent) {
  if (start >= lines.length) {
    return [undefined, start];
  }
  if (lines[start].trimStart().startsWith("- ")) {
    const items = [];
    let index = start;
    while (index < lines.length && indentOf(lines[index]) === indent && lines[index].trimStart().startsWith("- ")) {
      const entry = lines[index].trimStart().slice(2);
      const pair = entry.match(/^([\w.@-]+):\s*(.*)$/);
      items.push(pair === null ? parseScalar(entry) : { [pair[1]]: parseScalar(pair[2]) });
      index += 1;
    }
    return [items, index];
  }
  const map = {};
  let index = start;
  while (index < lines.length && indentOf(lines[index]) === indent) {
    const pair = lines[index].trim().match(/^(.+?):\s*(.*)$/);
    assert.ok(pair !== null, `unparsable YAML line: ${lines[index]}`);
    const [, key, inline] = pair;
    if (inline !== "") {
      map[key] = parseScalar(inline);
      index += 1;
      continue;
    }
    const childIndent = index + 1 < lines.length ? indentOf(lines[index + 1]) : indent;
    if (childIndent <= indent) {
      map[key] = null;
      index += 1;
      continue;
    }
    const [child, next] = parseBlock(lines, index + 1, childIndent);
    map[key] = child;
    index = next;
  }
  return [map, index];
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "{}") return {};
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^".*"$/.test(value)) return value.slice(1, -1);
  if (/^'.*'$/.test(value)) return value.slice(1, -1);
  return value;
}

function createAdapter(lxc, overrides = {}) {
  return createTraefikAdapter({
    httpClient: { request: lxc.request },
    secretResolver: { resolve: () => "unused" },
    exec: lxc.exec,
    sleep: noSleep,
    ...overrides
  });
}

const publishRequest = (overrides = {}) => ({
  hostname: "photos.bunnyhome.test",
  backendIp: "10.0.0.100",
  backendPort: 8080,
  protocol: "https",
  caStrategy: "none",
  vmid: 121,
  ip: "10.0.0.54",
  endpoint: "http://10.0.0.54:8080",
  ...overrides
});

const stepCaRequest = (overrides = {}) => publishRequest({
  caStrategy: "step-ca",
  zone: "bunnyhome.test",
  tls: {
    mode: "step-ca",
    issuer: "step-ca",
    caHost: "step-ca.bunnyhome.test",
    caIp: "10.0.0.55",
    trusted: true
  },
  ...overrides
});

const UNRELATED_FRAGMENT = `http:
  routers:
    operator-owned:
      rule: "Host(\`nas.bunnyhome.test\`)"
      entryPoints:
        - websecure
      service: operator-owned
      tls: {}
  services:
    operator-owned:
      loadBalancer:
        servers:
          - url: "http://10.0.0.200:5000"
`;

// ---------------------------------------------------------------------------
// The managed LXC uses a watched dynamic directory and reports real health
// ---------------------------------------------------------------------------

test("Traefik setup installs a watched dynamic configuration directory", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);

  const plan = await adapter.setup({ provider: "traefik", managedItemId: "nc_proxy_test" });

  for (const command of plan.lxcCommands) {
    assert.ok(command.binary.startsWith("/"), "install commands must use absolute binaries");
    assert.ok(Array.isArray(command.args), "install commands must use argument arrays");
  }
  for (const command of plan.lxcCommands) {
    await lxc.exec(121, command);
  }

  const staticConfig = parseYaml(lxc.files.get("/etc/traefik/traefik.yml"));
  assert.equal(staticConfig.providers.file.directory, DYNAMIC_DIR);
  assert.equal(staticConfig.providers.file.watch, true);
  assert.equal(staticConfig.entryPoints.websecure.address, ":443");
  assert.equal(staticConfig.entryPoints.web.address, ":80");

  const unit = lxc.files.get("/etc/systemd/system/traefik.service");
  assert.match(unit, /ExecStart=\/usr\/local\/bin\/traefik --configFile=\/etc\/traefik\/traefik\.yml/);

  const script = plan.lxcCommands.map((command) => command.args.join(" ")).join("\n");
  assert.match(script, /mkdir -p \/etc\/traefik\/dynamic/);
  assert.match(script, /systemctl enable --now traefik/);
});

test("Traefik install never clobbers an existing watched fragment", async () => {
  const lxc = new FakeTraefikLxc();
  lxc.seed(`${DYNAMIC_DIR}/operator-owned.yml`, UNRELATED_FRAGMENT);
  const adapter = createAdapter(lxc);

  const plan = await adapter.setup({ provider: "traefik" });
  for (const command of plan.lxcCommands) {
    await lxc.exec(121, command);
  }

  assert.equal(lxc.files.get(`${DYNAMIC_DIR}/operator-owned.yml`), UNRELATED_FRAGMENT);
});

test("Traefik health reports real process and endpoint state", async () => {
  const running = new FakeTraefikLxc();
  assert.deepEqual(
    await createAdapter(running).healthCheck({ ip: "10.0.0.54" }),
    { process: "running", endpoint: "reachable" }
  );

  const stopped = new FakeTraefikLxc({ reachable: false });
  assert.deepEqual(
    await createAdapter(stopped).healthCheck({ ip: "10.0.0.54" }),
    { process: "stopped", endpoint: "unreachable" }
  );
});

test("Traefik health checks reach the dashboard API on :8080 when only an IP is known", async () => {
  const lxc = new FakeTraefikLxc();
  await createAdapter(lxc).healthCheck({ ip: "10.0.0.54" });
  assert.equal(lxc.requests[0].url, "http://10.0.0.54:8080/api/overview");
});

// ---------------------------------------------------------------------------
// Publishing writes only the resolved managed fragment
// ---------------------------------------------------------------------------

test("publishing an exposure creates a live router and service from one dynamic fragment", async () => {
  const lxc = new FakeTraefikLxc();
  lxc.seed(`${DYNAMIC_DIR}/operator-owned.yml`, UNRELATED_FRAGMENT);
  const adapter = createAdapter(lxc);

  const published = await adapter.publishRoute(publishRequest());

  assert.equal(published.id, "photos.bunnyhome.test");
  assert.deepEqual(published.locator, {
    router: "nomina-photos.bunnyhome.test",
    fragmentPath: `${DYNAMIC_DIR}/nomina-photos.bunnyhome.test.yml`
  });
  assert.equal(published.route, "https://photos.bunnyhome.test -> http://10.0.0.100:8080");
  assert.ok(published.warnings === undefined, "a loaded fragment must not warn");

  assert.deepEqual(lxc.fragmentNames(), [
    `${DYNAMIC_DIR}/nomina-photos.bunnyhome.test.yml`,
    `${DYNAMIC_DIR}/operator-owned.yml`
  ]);

  const router = lxc.routers().find((entry) => entry.name === "nomina-photos.bunnyhome.test@file");
  assert.equal(router.rule, "Host(`photos.bunnyhome.test`)");
  assert.deepEqual(router.entryPoints, ["websecure"]);
  assert.deepEqual(router.tls, {});

  const service = lxc.services().find((entry) => entry.name === "nomina-photos.bunnyhome.test@file");
  assert.deepEqual(service.loadBalancer.servers, [{ url: "http://10.0.0.100:8080" }]);
});

test("republishing an exposure updates the same fragment instead of adding another", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);

  const first = await adapter.publishRoute(publishRequest());
  const second = await adapter.publishRoute(publishRequest({ backendPort: 9090 }));

  assert.deepEqual(lxc.fragmentNames(), [`${DYNAMIC_DIR}/nomina-photos.bunnyhome.test.yml`]);
  assert.equal(lxc.services()[0].loadBalancer.servers[0].url, "http://10.0.0.100:9090");
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test("publishing stages the fragment outside the watched directory before moving it into place", async () => {
  const lxc = new FakeTraefikLxc();
  await createAdapter(lxc).publishRoute(publishRequest());

  const script = lxc.execCalls.at(-1).command.args[1];
  const staged = script.match(/^cat > (\S+) <</m)[1];
  assert.ok(
    !staged.startsWith(`${DYNAMIC_DIR}/`),
    "a half-written fragment must not appear in the directory Traefik watches"
  );
  assert.match(script, /^mv -f \S+ \/etc\/traefik\/dynamic\/nomina-photos\.bunnyhome\.test\.yml$/m);
});

test("publishing requires the managed LXC id rather than guessing a target", async () => {
  const lxc = new FakeTraefikLxc();
  await assert.rejects(
    createAdapter(lxc).publishRoute(publishRequest({ vmid: undefined })),
    /requires the managed LXC id/i
  );
  assert.equal(lxc.execCalls.length, 0);
});

test("publishing rejects a hostname that is not a plain DNS name", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);
  for (const hostname of ["../../etc/passwd", "photos.test`whoami`", "a b.test", "photos.test/x"]) {
    await assert.rejects(adapter.publishRoute(publishRequest({ hostname })), /Invalid exposure hostname/i);
  }
  assert.equal(lxc.execCalls.length, 0);
});

test("publishing warns instead of claiming success when Traefik never loads the fragment", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createTraefikAdapter({
    // The file lands on disk but the watcher never reports it.
    httpClient: { request: () => ({ status: 200, body: "[]" }) },
    secretResolver: { resolve: () => "unused" },
    exec: lxc.exec,
    sleep: noSleep
  });

  const published = await adapter.publishRoute(publishRequest());

  assert.match(published.warnings[0], /did not load the dynamic fragment/i);
});

// ---------------------------------------------------------------------------
// HTTPS is never downgraded
// ---------------------------------------------------------------------------

test("an exposure without a configured CA is untrusted HTTPS, never HTTP", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);

  await adapter.publishRoute(publishRequest({ caStrategy: "none" }));

  const routers = lxc.routers();
  assert.equal(routers.length, 1);
  assert.deepEqual(routers[0].entryPoints, ["websecure"]);
  assert.deepEqual(routers[0].tls, {}, "TLS stays on so Traefik serves its generated certificate");

  const health = await adapter.healthCheckExposure(publishRequest({ caStrategy: "none" }));
  assert.deepEqual(health, {
    https: "reachable",
    tls: "untrusted",
    issuer: "traefik-default",
    status: "healthy"
  });
});

test("a managed router that lost its TLS block is unhealthy rather than a working HTTP route", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);
  await adapter.publishRoute(publishRequest());

  const path = fragmentPathFor("photos.bunnyhome.test");
  lxc.seed(path, lxc.files.get(path).replace("      tls: {}\n", "").replace("        - websecure", "        - web"));

  const health = await adapter.healthCheckExposure(publishRequest());
  assert.equal(health.status, "unhealthy");
  assert.equal(health.tls, "missing");
  assert.match(health.reason, /no TLS configuration/i);
});

test("a CA-backed project whose router lost its resolver is not told its certificate is trusted", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);
  await adapter.publishRoute(stepCaRequest());

  // The operator edited the resolver back out of the managed fragment.
  const path = fragmentPathFor("photos.bunnyhome.test");
  lxc.seed(path, lxc.files.get(path).replace("      tls:\n        certResolver: nomina-stepca", "      tls: {}"));

  const health = await adapter.healthCheckExposure(stepCaRequest());
  assert.equal(health.tls, "untrusted");
  assert.equal(health.status, "unhealthy");
  assert.match(health.reason, /step-ca trust is not configured/i);
});

// ---------------------------------------------------------------------------
// step-ca makes a Traefik exposure trusted
// ---------------------------------------------------------------------------

test("publishing with step-ca installs the CA root and adds the certificate resolver Traefik needs", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);

  const published = await adapter.publishRoute(stepCaRequest());

  assert.equal(published.certResolver, "nomina-stepca");
  assert.equal(published.warnings, undefined);

  // The root is installed in the LXC trust store, not just downloaded.
  assert.equal(lxc.files.get("/usr/local/share/ca-certificates/step-ca-root.crt").trim(), lxc.stepCa.root);
  assert.deepEqual(lxc.trustedRoots, [lxc.stepCa.root]);

  // A certificate resolver only takes effect from the static configuration.
  const staticConfig = parseYaml(lxc.files.get("/etc/traefik/traefik.yml"));
  const acme = staticConfig.certificatesResolvers["nomina-stepca"].acme;
  assert.equal(acme.caServer, "https://step-ca.bunnyhome.test:9000/acme/acme/directory");
  assert.equal(acme.storage, "/etc/traefik/acme.json");
  assert.equal(acme.certificatesDuration, "24", "step-ca issues 24h certificates; Traefik must renew on that window");
  assert.deepEqual(acme.tlsChallenge, {});
  assert.equal(lxc.restarts, 1, "Traefik reads the resolver and the trust store at start");

  // The managed fragment names the resolver, so the router asks for a
  // step-ca certificate instead of Traefik's generated one.
  const fragment = parseYaml(lxc.files.get(fragmentPathFor("photos.bunnyhome.test")));
  assert.equal(fragment.http.routers[routerNameFor("photos.bunnyhome.test")].tls.certResolver, "nomina-stepca");
});

test("configuring the resolver preserves the rest of the static configuration and unrelated fragments", async () => {
  const lxc = new FakeTraefikLxc();
  lxc.seed(`${DYNAMIC_DIR}/operator-owned.yml`, UNRELATED_FRAGMENT);
  lxc.seed("/etc/traefik/traefik.yml", `${INSTALLED_STATIC_CONFIG}accessLog:\n  filePath: /var/log/traefik-access.log\n`);

  await createAdapter(lxc).publishRoute(stepCaRequest());

  const staticConfig = lxc.files.get("/etc/traefik/traefik.yml");
  assert.match(staticConfig, /filePath: \/var\/log\/traefik-access\.log/, "operator static configuration must survive");
  assert.match(staticConfig, /directory: \/etc\/traefik\/dynamic/);
  assert.match(staticConfig, /certificatesResolvers:/);
  assert.equal(lxc.files.get(`${DYNAMIC_DIR}/operator-owned.yml`), UNRELATED_FRAGMENT);
});

test("re-publishing leaves one managed resolver block and does not restart Traefik again", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);

  await adapter.publishRoute(stepCaRequest());
  await adapter.publishRoute(stepCaRequest({ backendPort: 9090 }));

  const staticConfig = lxc.files.get("/etc/traefik/traefik.yml");
  assert.equal(staticConfig.match(/certificatesResolvers:/g).length, 1);
  assert.equal(lxc.restarts, 1, "an unchanged trust configuration must not bounce a live proxy");
});

test("moving step-ca rewrites the managed block instead of appending a second one", () => {
  const first = applyStepCaResolver(
    INSTALLED_STATIC_CONFIG,
    stepCaResolverBlock({ caHost: "step-ca.bunnyhome.test", email: "nomina@bunnyhome.test" })
  );
  const second = applyStepCaResolver(
    first.content,
    stepCaResolverBlock({ caHost: "step-ca.bunny.home.arpa", email: "nomina@bunny.home.arpa" })
  );

  assert.equal(second.conflict, false);
  assert.equal(second.content.match(/certificatesResolvers:/g).length, 1);
  assert.match(second.content, /step-ca\.bunny\.home\.arpa:9000/);
  assert.ok(!second.content.includes("step-ca.bunnyhome.test:9000"));
  assert.match(second.content, /directory: \/etc\/traefik\/dynamic/);
});

test("a step-ca exposure is healthy only once the certificate is issued and validates", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);
  await adapter.publishRoute(stepCaRequest());

  const health = await adapter.healthCheckExposure(stepCaRequest());
  assert.deepEqual(health, {
    https: "reachable",
    tls: "valid",
    issuer: "step-ca",
    status: "healthy"
  });
});

test("a certificate step-ca has not issued yet is reported as pending, not trusted", async () => {
  const lxc = new FakeTraefikLxc({ stepCa: { issues: false } });
  const adapter = createAdapter(lxc);
  await adapter.publishRoute(stepCaRequest());

  const health = await adapter.healthCheckExposure(stepCaRequest());
  assert.equal(health.status, "unhealthy");
  assert.equal(health.tls, "untrusted");
  assert.match(health.reason, /has not issued a certificate for photos\.bunnyhome\.test/i);
});

test("a certificate that does not validate against the installed root is reported as untrusted", async () => {
  const lxc = new FakeTraefikLxc({ stepCa: { handshake: false } });
  const adapter = createAdapter(lxc);
  await adapter.publishRoute(stepCaRequest());

  const health = await adapter.healthCheckExposure(stepCaRequest());
  assert.equal(health.status, "unhealthy");
  assert.equal(health.tls, "untrusted");
  assert.match(health.reason, /did not validate against the step-ca root/i);
});

test("trust cannot be verified without the managed LXC, and that is not reported as healthy", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);
  await adapter.publishRoute(stepCaRequest());

  const health = await adapter.healthCheckExposure(stepCaRequest({ vmid: undefined }));
  assert.equal(health.status, "unhealthy");
  assert.equal(health.tls, "unknown");
  assert.match(health.reason, /cannot reach the Traefik LXC/i);
});

test("an unreachable step-ca leaves the exposure on untrusted HTTPS with a warning", async () => {
  const lxc = new FakeTraefikLxc({ stepCa: { reachable: false } });
  const adapter = createAdapter(lxc);

  const published = await adapter.publishRoute(stepCaRequest());

  assert.equal(published.certResolver, undefined);
  assert.match(published.warnings[0], /Unable to fetch the step-ca root certificate/i);

  // The exposure is still served over HTTPS, and nothing in Traefik's static
  // configuration was changed on the way to that outcome.
  const fragment = parseYaml(lxc.files.get(fragmentPathFor("photos.bunnyhome.test")));
  assert.deepEqual(fragment.http.routers[routerNameFor("photos.bunnyhome.test")].tls, {});
  assert.deepEqual(fragment.http.routers[routerNameFor("photos.bunnyhome.test")].entryPoints, ["websecure"]);
  assert.equal(lxc.files.get("/etc/traefik/traefik.yml"), INSTALLED_STATIC_CONFIG);
  assert.equal(lxc.restarts, 0);
});

test("a certificate resolver NominaConnect did not write is never replaced", async () => {
  const lxc = new FakeTraefikLxc();
  const operatorConfig = `${INSTALLED_STATIC_CONFIG}certificatesResolvers:\n  operator-owned:\n    acme:\n      email: "ops@bunnyhome.test"\n`;
  lxc.seed("/etc/traefik/traefik.yml", operatorConfig);
  const adapter = createAdapter(lxc);

  const published = await adapter.publishRoute(stepCaRequest());

  assert.equal(published.certResolver, undefined);
  assert.match(published.warnings[0], /already defines certificatesResolvers/i);
  assert.equal(lxc.files.get("/etc/traefik/traefik.yml"), operatorConfig);
  assert.equal(lxc.restarts, 0);

  const fragment = parseYaml(lxc.files.get(fragmentPathFor("photos.bunnyhome.test")));
  assert.deepEqual(fragment.http.routers[routerNameFor("photos.bunnyhome.test")].tls, {});
});

test("a step-ca address that is not a plain hostname is refused rather than escaped", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);

  const published = await adapter.publishRoute(stepCaRequest({
    tls: { mode: "step-ca", caHost: "step-ca.bunnyhome.test; rm -rf /", caIp: "10.0.0.55", trusted: true }
  }));

  assert.equal(published.certResolver, undefined);
  assert.match(published.warnings[0], /unusable address/i);
  assert.equal(lxc.files.get("/etc/traefik/traefik.yml"), INSTALLED_STATIC_CONFIG);
  assert.deepEqual(lxc.execCalls.filter(({ command }) => command.binary === "/usr/bin/curl"), []);
});

test("the CA hostname is pinned in the LXC without disturbing other hosts entries", async () => {
  const lxc = new FakeTraefikLxc();
  await createAdapter(lxc).publishRoute(stepCaRequest());

  const script = lxc.execCalls
    .map(({ command }) => (command.binary === "/bin/bash" ? command.args[1] : ""))
    .join("\n");
  assert.match(script, /sed -i '\/\[\[:space:\]\]step-ca\\\.bunnyhome\\\.test\$\/d' \/etc\/hosts/);
  assert.match(script, /echo '10\.0\.0\.55 step-ca\.bunnyhome\.test' >> \/etc\/hosts/);
});

test("a TLS backend is dialled over HTTPS with the relaxed check scoped to that service", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);

  await adapter.publishRoute(publishRequest({ backendTls: true }));

  const document = parseYaml(lxc.files.get(fragmentPathFor("photos.bunnyhome.test")));
  const name = routerNameFor("photos.bunnyhome.test");
  assert.equal(document.http.services[name].loadBalancer.servers[0].url, "https://10.0.0.100:8080");
  assert.equal(document.http.services[name].loadBalancer.serversTransport, name);
  assert.equal(document.http.serversTransports[name].insecureSkipVerify, true);
});

test("an HTTP redirect adds a :80 router and is not reported as a second managed route", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);

  await adapter.publishRoute(publishRequest({ httpRedirect: true }));

  const redirect = lxc.routers().find((entry) => entry.name.startsWith("nomina-photos.bunnyhome.test-redirect"));
  assert.deepEqual(redirect.entryPoints, ["web"]);
  assert.equal(redirect.tls, undefined, "the redirect must not terminate TLS on :80");

  const document = parseYaml(lxc.files.get(fragmentPathFor("photos.bunnyhome.test")));
  const middleware = document.http.middlewares["nomina-photos.bunnyhome.test-redirect"];
  assert.equal(middleware.redirectScheme.scheme, "https");
  assert.equal(middleware.redirectScheme.permanent, true);

  const { resources } = await adapter.inspect({ ip: "10.0.0.54" });
  assert.deepEqual(resources.map((resource) => resource.id), ["photos.bunnyhome.test"]);
});

// ---------------------------------------------------------------------------
// Direct fragment edits are inspected and adopted
// ---------------------------------------------------------------------------

test("a direct edit to a managed fragment is inspected as the observed configuration", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);
  const published = await adapter.publishRoute(publishRequest());

  const path = fragmentPathFor("photos.bunnyhome.test");
  lxc.seed(path, lxc.files.get(path).replace("http://10.0.0.100:8080", "http://10.0.0.101:9443"));

  const { resources } = await adapter.inspect({ ip: "10.0.0.54" });
  const observed = resources.find((resource) => resource.id === "photos.bunnyhome.test");
  assert.equal(observed.backendIp, "10.0.0.101");
  assert.equal(observed.backendPort, 9443);
  assert.deepEqual(observed.backend, { ip: "10.0.0.101", port: 9443 });
  assert.notEqual(observed.fingerprint, published.fingerprint, "the edit must be visible as drift");
});

test("adoption keeps the observed fragment locator and fingerprint", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);
  await adapter.publishRoute(publishRequest());

  const { resources } = await adapter.inspect({ ip: "10.0.0.54" });
  const adopted = await adapter.adopt({ managed: resources });

  assert.equal(adopted.warnings, undefined);
  assert.deepEqual(adopted.managedInventoryUpdate[0].locator, {
    router: "nomina-photos.bunnyhome.test",
    fragmentPath: `${DYNAMIC_DIR}/nomina-photos.bunnyhome.test.yml`
  });
  assert.equal(adopted.managedInventoryUpdate[0].fingerprint, resources[0].fingerprint);
});

test("an ambiguous fragment locator is a warning rather than a guess", async () => {
  const adapter = createAdapter(new FakeTraefikLxc());

  const adopted = await adapter.adopt({
    managed: [
      { id: "photos.bunnyhome.test", locator: { router: "nomina-photos.bunnyhome.test", fragmentPath: "/a.yml" } },
      { id: "photos.bunnyhome.test", locator: { router: "nomina-photos.bunnyhome.test", fragmentPath: "/a.yml" } }
    ]
  });

  assert.deepEqual(adopted.managedInventoryUpdate, []);
  assert.match(adopted.warnings[0], /Ambiguous Traefik dynamic fragment/i);
});

test("a live status change alone is not reported as a direct edit", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);
  const published = await adapter.publishRoute(publishRequest());

  const { resources } = await adapter.inspect({ ip: "10.0.0.54" });
  assert.equal(resources[0].fingerprint, published.fingerprint);
});

test("routers Traefik loaded from another provider are not inspected as file fragments", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createTraefikAdapter({
    httpClient: {
      request: ({ url }) => {
        const path = new URL(url).pathname;
        if (path === "/api/http/routers") {
          return {
            status: 200,
            body: JSON.stringify([
              { name: "dashboard@internal", provider: "internal", rule: "PathPrefix(`/api`)", service: "api@internal" },
              { name: "nomina-photos.bunnyhome.test@file", provider: "file", rule: "Host(`photos.bunnyhome.test`)", service: "nomina-photos.bunnyhome.test@file", tls: {} }
            ])
          };
        }
        return { status: 200, body: "[]" };
      }
    },
    secretResolver: { resolve: () => "unused" },
    exec: lxc.exec,
    sleep: noSleep
  });

  const { resources } = await adapter.inspect({ ip: "10.0.0.54" });
  assert.deepEqual(resources.map((resource) => resource.id), ["photos.bunnyhome.test"]);
});

// ---------------------------------------------------------------------------
// Unrelated fragments stay untouched
// ---------------------------------------------------------------------------

test("removing an exposure deletes only its own fragment", async () => {
  const lxc = new FakeTraefikLxc();
  lxc.seed(`${DYNAMIC_DIR}/operator-owned.yml`, UNRELATED_FRAGMENT);
  const adapter = createAdapter(lxc);
  await adapter.publishRoute(publishRequest());
  await adapter.publishRoute(publishRequest({ hostname: "books.bunnyhome.test" }));

  await adapter.unpublishRoute({ hostname: "photos.bunnyhome.test", vmid: 121, ip: "10.0.0.54" });

  assert.deepEqual(lxc.fragmentNames(), [
    `${DYNAMIC_DIR}/nomina-books.bunnyhome.test.yml`,
    `${DYNAMIC_DIR}/operator-owned.yml`
  ]);
  assert.equal(lxc.files.get(`${DYNAMIC_DIR}/operator-owned.yml`), UNRELATED_FRAGMENT);
  assert.deepEqual(
    lxc.routers().map((entry) => entry.name).sort(),
    ["nomina-books.bunnyhome.test@file", "operator-owned@file"]
  );
});

test("removal is refused when the managed fragment no longer matches its fingerprint", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);
  const published = await adapter.publishRoute(publishRequest());

  const path = fragmentPathFor("photos.bunnyhome.test");
  lxc.seed(path, lxc.files.get(path).replace("http://10.0.0.100:8080", "http://10.0.0.111:8080"));

  await assert.rejects(
    adapter.unpublishRoute({
      hostname: "photos.bunnyhome.test",
      vmid: 121,
      ip: "10.0.0.54",
      fingerprint: published.fingerprint
    }),
    /does not match its managed fingerprint/i
  );
  assert.ok(lxc.files.has(path), "the directly edited fragment must survive");
});

test("removing an exposure that was already deleted is not an error", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);

  const result = await adapter.unpublishRoute({ hostname: "photos.bunnyhome.test", vmid: 121, ip: "10.0.0.54" });
  assert.equal(result.id, "photos.bunnyhome.test");
});

// ---------------------------------------------------------------------------
// The dashboard/API is observation only
// ---------------------------------------------------------------------------

test("the Traefik API is never used to write configuration", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);

  await adapter.configure(publishRequest());
  await adapter.publishRoute(publishRequest());
  await adapter.inspect({ ip: "10.0.0.54" });
  await adapter.healthCheck({ ip: "10.0.0.54" });
  await adapter.healthCheckExposure(publishRequest());
  await adapter.unpublishRoute({ hostname: "photos.bunnyhome.test", vmid: 121, ip: "10.0.0.54" });

  assert.ok(lxc.requests.length > 0);
  const writes = lxc.requests.filter((request) => (request.method ?? "GET") !== "GET");
  assert.deepEqual(writes, [], "every configuration change must go through the watched directory");
});

test("exposure health reports the observed backend rather than the requested one", async () => {
  const lxc = new FakeTraefikLxc();
  const adapter = createAdapter(lxc);
  await adapter.publishRoute(publishRequest());

  const health = await adapter.healthCheckExposure(publishRequest({ backendPort: 9999 }));
  assert.equal(health.status, "unhealthy");
  assert.match(health.reason, /points at http:\/\/10\.0\.0\.100:8080/);
});

test("exposure health is unhealthy when Traefik is unreachable", async () => {
  const lxc = new FakeTraefikLxc({ reachable: false });
  const health = await createAdapter(lxc).healthCheckExposure(publishRequest());
  assert.equal(health.https, "unreachable");
  assert.equal(health.status, "unhealthy");
  assert.match(health.reason, /unreachable/i);
});

test("exposure health is unhealthy when the managed router is gone", async () => {
  const lxc = new FakeTraefikLxc();
  const health = await createAdapter(lxc).healthCheckExposure(publishRequest());
  assert.equal(health.https, "unreachable");
  assert.equal(health.status, "unhealthy");
  assert.match(health.reason, /no router for photos\.bunnyhome\.test/i);
});

// ---------------------------------------------------------------------------
// Explicit upgrades
// ---------------------------------------------------------------------------

test("upgrading Traefik replaces the binary and restarts the service", async () => {
  const adapter = createAdapter(new FakeTraefikLxc());
  const plan = await adapter.upgrade({ provider: "traefik" });

  const script = plan.lxcCommands.map((command) => command.args.join(" ")).join("\n");
  assert.match(script, /releases\/download/);
  assert.match(script, /install -m 0755 \/tmp\/traefik \/usr\/local\/bin\/traefik/);
  assert.match(script, /systemctl restart traefik/);
  assert.ok(!/mkdir -p \/etc\/traefik\/dynamic/.test(script), "an upgrade must not rewrite operator configuration");
});

test("the emitted fragment is valid YAML for every supported exposure shape", () => {
  for (const options of [
    { hostname: "a.test", backendIp: "10.0.0.1", backendPort: 80 },
    { hostname: "b.test", backendIp: "10.0.0.2", backendPort: 443, backendTls: true },
    { hostname: "c.test", backendIp: "10.0.0.3", backendPort: 8080, httpRedirect: true },
    { hostname: "d.test", backendIp: "10.0.0.4", backendPort: 8443, backendTls: true, httpRedirect: true }
  ]) {
    const document = parseYaml(buildFragment(options));
    const name = routerNameFor(options.hostname);
    assert.equal(document.http.routers[name].rule, `Host(\`${options.hostname}\`)`);
    assert.deepEqual(document.http.routers[name].tls, {});
    assert.equal(
      document.http.services[name].loadBalancer.servers[0].url,
      `${options.backendTls ? "https" : "http"}://${options.backendIp}:${options.backendPort}`
    );
  }
});
