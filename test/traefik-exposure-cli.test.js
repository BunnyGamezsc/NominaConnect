import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";
import { createProductionAdapters } from "../src/adapter-runtime.js";
import { createTraefikAdapter, fragmentPathFor } from "../src/traefik-adapter.js";
import { proxyEndpointFor } from "../src/exposure.js";

const DYNAMIC_DIR = "/etc/traefik/dynamic";
const STATIC_CONFIG_PATH = "/etc/traefik/traefik.yml";
const ACME_STORAGE_PATH = "/etc/traefik/acme.json";
const STEP_CA_ROOT = "-----BEGIN CERTIFICATE-----\nnomina-step-ca-root\n-----END CERTIFICATE-----";
const INSTALLED_STATIC_CONFIG = `entryPoints:
  web:
    address: ":80"
  websecure:
    address: ":443"
  traefik:
    address: ":8080"
providers:
  file:
    directory: ${DYNAMIC_DIR}
    watch: true
`;
const proxmoxRootRuntime = () => ({ isRoot: () => true, isProxmoxHost: () => true });

class FakeFilesystem {
  files = new Map();
  directories = new Set();

  exists(path) {
    return this.files.has(path) || this.directories.has(path);
  }

  mkdir(path) {
    this.directories.add(path);
  }

  writeFile(path, content) {
    this.files.set(path, content);
  }

  rename(from, to) {
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
  }

  chmod() {}

  read(path) {
    return this.files.get(path);
  }
}

// A Traefik LXC that keeps the files written into it and answers the dashboard
// API from the watched directory, so a CLI command is verified by what Traefik
// would actually serve rather than by which adapter method was called.
class TraefikHost {
  constructor(vmid = 121, stepCa = {}) {
    this.vmid = vmid;
    this.files = new Map();
    this.execCalls = [];
    this.restarts = 0;
    this.trustedRoots = [];
    this.stepCa = { reachable: true, ...stepCa };
    this.files.set(STATIC_CONFIG_PATH, INSTALLED_STATIC_CONFIG);
  }

  pctExec = (vmid, command) => {
    this.execCalls.push({ vmid, command });
    if (vmid !== this.vmid) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.binary === "/bin/cat") {
      return { exitCode: 0, stdout: this.#read(command.args[0]), stderr: "" };
    }
    if (command.binary === "/usr/bin/curl") {
      return this.#runCurl(command.args);
    }
    if (command.binary === "/bin/rm") {
      for (const target of command.args.filter((argument) => !argument.startsWith("-"))) {
        this.files.delete(target);
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (command.binary === "/bin/bash" && command.args[0] === "-c") {
      const lines = command.args[1].split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const heredoc = lines[index].trim().match(/^cat > (\S+) <<'(\w+)'$/);
        if (heredoc !== null) {
          const body = [];
          index += 1;
          while (index < lines.length && lines[index] !== heredoc[2]) {
            body.push(lines[index]);
            index += 1;
          }
          this.files.set(heredoc[1], `${body.join("\n")}\n`);
          continue;
        }
        const move = lines[index].trim().match(/^mv -f (\S+) (\S+)$/);
        if (move !== null && this.files.has(move[1])) {
          this.files.set(move[2], this.files.get(move[1]));
          this.files.delete(move[1]);
          continue;
        }
        if (lines[index].trim() === "update-ca-certificates") {
          this.trustedRoots.push((this.files.get("/usr/local/share/ca-certificates/step-ca-root.crt") ?? "").trim());
          continue;
        }
        if (lines[index].trim() === "systemctl restart traefik") {
          this.restarts += 1;
        }
      }
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  request = ({ method, url }) => {
    const path = new URL(url).pathname;
    assert.equal(method ?? "GET", "GET", "the Traefik API must only be read");
    assert.equal(new URL(url).port, "8080", "Traefik is observed on its dashboard port");
    if (path === "/api/overview") {
      return { status: 200, body: JSON.stringify({ http: {} }) };
    }
    if (path === "/api/http/routers") {
      return { status: 200, body: JSON.stringify(this.#entries("routers")) };
    }
    if (path === "/api/http/services") {
      return { status: 200, body: JSON.stringify(this.#entries("services")) };
    }
    return { status: 404, body: "{}" };
  };

  fragments() {
    return [...this.files.keys()].filter((path) => path.startsWith(`${DYNAMIC_DIR}/`)).sort();
  }

  staticConfig() {
    return this.files.get(STATIC_CONFIG_PATH);
  }

  // pct exec turns a non-zero exit into a thrown error, and step-ca only has a
  // certificate for a hostname whose router names a configured resolver.
  #read(path) {
    if (path === ACME_STORAGE_PATH) {
      const issued = this.#issued();
      if (issued.length === 0) {
        throw new Error(`cat: ${path}: No such file or directory`);
      }
      return JSON.stringify({
        "nomina-stepca": { Certificates: issued.map((hostname) => ({ domain: { main: hostname } })) }
      });
    }
    if (!this.files.has(path)) {
      throw new Error(`cat: ${path}: No such file or directory`);
    }
    return this.files.get(path);
  }

  #issued() {
    if (!this.stepCa.reachable || !this.trustedRoots.includes(STEP_CA_ROOT)) {
      return [];
    }
    const resolvers = [...(this.staticConfig() ?? "").matchAll(/^ {2}([\w-]+):$/gm)]
      .map(([, name]) => name);
    return this.#entries("routers")
      .filter((router) => resolvers.includes(router.tls?.certResolver))
      .map((router) => router.rule?.match(/Host\(`([^`]+)`\)/)?.[1])
      .filter((hostname) => hostname !== undefined);
  }

  #runCurl(args) {
    const url = args[args.length - 1];
    if (url.endsWith("/roots.pem")) {
      if (!this.stepCa.reachable) {
        throw new Error("curl: (7) Failed to connect to step-ca");
      }
      return { exitCode: 0, stdout: `${STEP_CA_ROOT}\n`, stderr: "" };
    }
    if (!this.#issued().includes(new URL(url).hostname)) {
      throw new Error("curl: (60) SSL certificate problem: unable to get local issuer certificate");
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  // Reads the router/service names and backend URL straight out of the
  // fragments, which is all the API contract these tests depend on.
  #entries(kind) {
    const entries = [];
    for (const [path, content] of this.files) {
      if (!path.startsWith(`${DYNAMIC_DIR}/`)) {
        continue;
      }
      const section = content.split(`  ${kind}:`)[1];
      if (section === undefined) {
        continue;
      }
      const block = section.split(/\n {2}\w/)[0];
      for (const [, name] of block.matchAll(/^ {4}([\w.@-]+):$/gm)) {
        const body = block.split(`    ${name}:`)[1].split(/\n {4}\S/)[0];
        const entry = { name: `${name}@file`, provider: "file", status: "enabled" };
        if (kind === "routers") {
          entry.rule = body.match(/rule: "(.+)"/)?.[1];
          entry.entryPoints = [...body.matchAll(/^ {8}- (\S+)$/gm)].map(([, value]) => value);
          entry.service = body.match(/service: (\S+)/)?.[1];
          const resolver = body.match(/certResolver: (\S+)/)?.[1];
          if (resolver !== undefined) {
            entry.tls = { certResolver: resolver };
          } else if (/tls: \{\}/.test(body)) {
            entry.tls = {};
          }
        } else {
          entry.loadBalancer = { servers: [{ url: body.match(/url: "(.+)"/)?.[1] }] };
        }
        entries.push(entry);
      }
    }
    return entries;
  }
}

const PROJECT_YAML = `apiVersion: nomina.connect/v0alpha1
kind: NominaConnect
proxmox:
  node: pve-1
  defaultBridge: vmbr0
  defaultStorage: local-lvm
baseLocalDomain: bunnyhome.test
managedInventory:
  platform:
    dns:
      id: nc_dns_test
      service: technitium
      deployment:
        ip: 10.0.0.53
        hostname: technitium
    reverseProxy:
      id: nc_proxy_test
      service: traefik
      deployment:
        ip: 10.0.0.54
        hostname: traefik
    certificateAuthority: null
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test
`;

const PROVISIONED_STATE = {
  version: 1,
  providerReferences: {
    nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
    nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
  },
  tracking: { notices: [] }
};

function seedProject(filesystem, projectDir = "/projects/bunnyhome") {
  filesystem.mkdir(projectDir);
  filesystem.mkdir(`${projectDir}/.nomina`);
  filesystem.writeFile(`${projectDir}/nomina.yaml`, PROJECT_YAML);
  filesystem.writeFile(`${projectDir}/.nomina/state.json`, `${JSON.stringify(PROVISIONED_STATE, null, 2)}\n`);
}

function createTechnitiumAdapter() {
  const records = new Map([["bunnyhome.test", { id: "bunnyhome.test", record: "bunnyhome.test NS localhost" }]]);
  return {
    records,
    inspect: () => ({ resources: [...records.values()] }),
    publishRecord(request) {
      records.set(request.hostname, { id: request.hostname, record: `${request.hostname} A ${request.ip}` });
      return { id: request.hostname };
    },
    deleteRecord(request) {
      records.delete(request.hostname);
      return { id: request.hostname };
    },
    unpublishRecord(request) {
      records.delete(request.hostname);
      return { id: request.hostname };
    },
    healthCheckExposure: () => ({ dns: "reachable", status: "healthy" }),
    healthCheck: () => ({ process: "running", endpoint: "reachable" })
  };
}

function createAdapters(filesystem, host) {
  return {
    filesystem,
    runtime: proxmoxRootRuntime(),
    proxmox: { pctExec: host.pctExec },
    providerAdapters: {
      technitium: createTechnitiumAdapter(),
      traefik: createTraefikAdapter({
        httpClient: { request: host.request },
        secretResolver: { resolve: () => "unused" },
        exec: host.pctExec,
        sleep: () => Promise.resolve()
      })
    }
  };
}

const STEP_CA_PROJECT_YAML = PROJECT_YAML
  .replace("    certificateAuthority: null\n", `    certificateAuthority:
      id: nc_ca_test
      service: step-ca
      deployment:
        ip: 10.0.0.55
        hostname: step-ca
`)
  .replace(
    "  nc_proxy_test: nominaconnect/provider/nc_proxy_test\n",
    "  nc_proxy_test: nominaconnect/provider/nc_proxy_test\n  nc_ca_test: nominaconnect/provider/nc_ca_test\n"
  );

const STEP_CA_STATE = {
  version: 1,
  providerReferences: {
    nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
    nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
    nc_ca_test: { vmid: 122, ip: "10.0.0.55" }
  },
  tracking: { notices: [] }
};

// The CA service itself is healthy in these tests; what is under test is
// whether the Traefik exposure ends up with a trusted certificate.
function createStepCaAdapter() {
  return {
    inspect: () => ({ resources: [{ id: "step-ca-root", locator: { name: "step-ca-root", type: "ca" } }] }),
    healthCheck: () => ({ process: "running", endpoint: "reachable" }),
    healthCheckExposure: () => ({ tls: "valid", issuer: "step-ca", status: "healthy" })
  };
}

function seedStepCaProject(filesystem, projectDir = "/projects/bunnyhome") {
  filesystem.mkdir(projectDir);
  filesystem.mkdir(`${projectDir}/.nomina`);
  filesystem.writeFile(`${projectDir}/nomina.yaml`, STEP_CA_PROJECT_YAML);
  filesystem.writeFile(`${projectDir}/.nomina/state.json`, `${JSON.stringify(STEP_CA_STATE, null, 2)}\n`);
}

const publishPhotos = (adapters) => runCli(
  [
    "exposure", "publish",
    "--project-dir", "/projects/bunnyhome",
    "--name", "photos",
    "--hostname", "photos.bunnyhome.test",
    "--backend-ip", "10.0.0.100",
    "--backend-port", "8080"
  ],
  adapters
);

test("nomina exposure publish with step-ca serves a trusted Traefik exposure", async () => {
  const filesystem = new FakeFilesystem();
  seedStepCaProject(filesystem);
  const host = new TraefikHost();
  host.files.set(`${DYNAMIC_DIR}/operator-owned.yml`, "http:\n  routers:\n    operator-owned:\n      rule: \"Host(`nas.bunnyhome.test`)\"\n");
  const adapters = createAdapters(filesystem, host);
  adapters.providerAdapters["step-ca"] = createStepCaAdapter();

  const result = await publishPhotos(adapters);

  assert.match(result.stdout, /Exposure published for photos\.bunnyhome\.test via HTTPS/);
  assert.equal(result.health.status, "healthy");
  assert.equal(result.health.reverseProxy.tls, "valid");
  assert.equal(result.health.reverseProxy.issuer, "step-ca");
  assert.equal(result.health.certificateAuthority.status, "healthy");
  assert.deepEqual(result.warnings, []);

  // The certificate came from step-ca through Traefik's own ACME resolver.
  assert.match(host.staticConfig(), /caServer: "https:\/\/step-ca\.bunnyhome\.test:9000\/acme\/acme\/directory"/);
  assert.match(host.files.get(fragmentPathFor("photos.bunnyhome.test")), /certResolver: nomina-stepca/);
  assert.deepEqual(host.trustedRoots, [STEP_CA_ROOT]);
  assert.equal(host.restarts, 1);

  // Unrelated Traefik configuration is untouched.
  assert.deepEqual(host.fragments(), [
    `${DYNAMIC_DIR}/nomina-photos.bunnyhome.test.yml`,
    `${DYNAMIC_DIR}/operator-owned.yml`
  ]);
  assert.match(host.staticConfig(), /directory: \/etc\/traefik\/dynamic/);

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /certificateAuthority: step-ca/);
  assert.match(config, /trusted: true/);
});

test("a step-ca failure leaves the Traefik exposure on untrusted HTTPS and says why", async () => {
  const filesystem = new FakeFilesystem();
  seedStepCaProject(filesystem);
  const host = new TraefikHost(121, { reachable: false });
  const adapters = createAdapters(filesystem, host);
  adapters.providerAdapters["step-ca"] = createStepCaAdapter();

  const result = await publishPhotos(adapters);

  assert.equal(result.health.status, "unhealthy");
  assert.match(result.stdout, /Warning: Unable to fetch the step-ca root certificate/i);
  assert.ok(result.warnings.some((warning) => /untrusted HTTPS/i.test(warning)));

  // Still HTTPS, still published, and Traefik's own configuration is unchanged.
  assert.match(host.files.get(fragmentPathFor("photos.bunnyhome.test")), /tls: \{\}/);
  assert.match(host.files.get(fragmentPathFor("photos.bunnyhome.test")), /- websecure/);
  assert.equal(host.staticConfig(), INSTALLED_STATIC_CONFIG);
  assert.equal(host.restarts, 0);
  assert.ok(adapters.providerAdapters.technitium.records.has("photos.bunnyhome.test"));

  // The managed inventory records the trust it actually has.
  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /certificateAuthority: step-ca/);
  assert.match(config, /trusted: false/);
});

test("nomina exposure publish creates the DNS record and the Traefik dynamic fragment", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const host = new TraefikHost();
  host.files.set(`${DYNAMIC_DIR}/operator-owned.yml`, "http:\n  routers:\n    operator-owned:\n      rule: \"Host(`nas.bunnyhome.test`)\"\n");
  const adapters = createAdapters(filesystem, host);

  const result = await runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", "photos",
      "--hostname", "photos.bunnyhome.test",
      "--backend-ip", "10.0.0.100",
      "--backend-port", "8080"
    ],
    adapters
  );

  assert.match(result.stdout, /Exposure published for photos\.bunnyhome\.test via HTTPS/);
  assert.equal(result.health.status, "healthy");
  assert.equal(result.health.reverseProxy.tls, "untrusted");

  assert.deepEqual(host.fragments(), [
    `${DYNAMIC_DIR}/nomina-photos.bunnyhome.test.yml`,
    `${DYNAMIC_DIR}/operator-owned.yml`
  ]);
  assert.match(
    host.files.get(fragmentPathFor("photos.bunnyhome.test")),
    /url: "http:\/\/10\.0\.0\.100:8080"/
  );
  assert.ok(adapters.providerAdapters.technitium.records.has("photos.bunnyhome.test"));

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /hostname: photos\.bunnyhome\.test/);
  assert.match(config, /protocol: https/);
});

test("removing a Traefik exposure removes only its fragment and its DNS record", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const host = new TraefikHost();
  const adapters = createAdapters(filesystem, host);

  const publish = (name, hostname, port) => runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", name, "--hostname", hostname,
      "--backend-ip", "10.0.0.100", "--backend-port", String(port)
    ],
    adapters
  );
  await publish("photos", "photos.bunnyhome.test", 8080);
  await publish("books", "books.bunnyhome.test", 8081);

  await runCli(["service", "remove", "photos", "--project-dir", "/projects/bunnyhome"], adapters);

  assert.deepEqual(host.fragments(), [`${DYNAMIC_DIR}/nomina-books.bunnyhome.test.yml`]);
  assert.ok(!adapters.providerAdapters.technitium.records.has("photos.bunnyhome.test"));
  assert.ok(adapters.providerAdapters.technitium.records.has("books.bunnyhome.test"));
});

test("changing the local domain migrates Traefik fragments to the new hostnames", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const host = new TraefikHost();
  const adapters = createAdapters(filesystem, host);

  await runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", "photos", "--hostname", "photos.bunnyhome.test",
      "--backend-ip", "10.0.0.100", "--backend-port", "8080"
    ],
    adapters
  );

  const result = await runCli(
    ["domain", "change", "bunny.home.arpa", "--project-dir", "/projects/bunnyhome"],
    adapters
  );

  assert.equal(result.migratedExposures, 1);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(host.fragments(), [`${DYNAMIC_DIR}/nomina-photos.bunny.home.arpa.yml`]);
});

test("nomina service add traefik installs the watched directory through pct exec", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", PROJECT_YAML.replace(
    "      deployment:\n        ip: 10.0.0.54\n        hostname: traefik\n",
    ""
  ));
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify({
    version: 1,
    providerReferences: { nc_dns_test: { vmid: 120, ip: "10.0.0.53" } },
    tracking: { notices: [] }
  }, null, 2)}\n`);

  const host = new TraefikHost();
  const adapters = createAdapters(filesystem, host);
  adapters.proxmox = {
    pctExec: host.pctExec,
    checkIpAvailability: () => ({ status: "available" }),
    createLxc: () => ({ vmid: 121, hostname: "traefik" }),
    inspectLxc: () => ({ hostname: "traefik" })
  };

  const result = await runCli(
    ["service", "add", "traefik", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.54"],
    adapters
  );

  assert.match(result.stdout, /Traefik provisioned/i);
  assert.equal(result.health.status, "healthy");
  const staticConfig = host.files.get("/etc/traefik/traefik.yml");
  assert.match(staticConfig, /directory: \/etc\/traefik\/dynamic/);
  assert.match(staticConfig, /watch: true/);
  assert.match(host.files.get("/etc/systemd/system/traefik.service"), /traefik --configFile/);
});

test("the installed CLI composes a real Traefik adapter that writes through pct exec", async () => {
  const executed = [];
  const { providerAdapters } = createProductionAdapters({
    commandRunner: {
      run: (command) => {
        executed.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
    },
    secretResolver: { resolve: () => "unused" },
    secretStore: { has: () => true, store: () => {}, locate: () => "/dev/null" },
    httpClient: {
      request: ({ url }) => new URL(url).pathname === "/api/http/routers"
        ? { status: 200, body: JSON.stringify([{ name: "nomina-photos.bunnyhome.test@file", provider: "file", rule: "Host(`photos.bunnyhome.test`)", service: "nomina-photos.bunnyhome.test@file", tls: {} }]) }
        : { status: 200, body: "[]" }
    }
  });

  const published = await providerAdapters.traefik.publishRoute({
    hostname: "photos.bunnyhome.test",
    backendIp: "10.0.0.100",
    backendPort: 8080,
    vmid: 121,
    ip: "10.0.0.54"
  });

  assert.equal(published.id, "photos.bunnyhome.test");
  assert.equal(executed.length, 1);
  assert.equal(executed[0].binary, "/usr/sbin/pct");
  assert.deepEqual(executed[0].args.slice(0, 4), ["exec", "121", "--", "/bin/bash"]);
  assert.match(executed[0].args.at(-1), /mv -f \S+ \/etc\/traefik\/dynamic\/nomina-photos\.bunnyhome\.test\.yml/);
});

test("nomina service upgrade traefik replaces the binary and rechecks real health", async () => {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const host = new TraefikHost();
  const adapters = createAdapters(filesystem, host);
  adapters.proxmox = {
    pctExec: host.pctExec,
    supportsSnapshots: () => false
  };

  const result = await runCli(
    ["service", "upgrade", "traefik", "--project-dir", "/projects/bunnyhome", "--no-snapshot"],
    adapters
  );

  assert.match(result.stdout, /Traefik upgraded on traefik \(vmid 121\)/);
  assert.equal(result.health.status, "healthy", "health must be read from the LXC, not the Proxmox loopback");
  const script = host.execCalls.map(({ command }) => command.args.join(" ")).join("\n");
  assert.match(script, /install -m 0755 \/tmp\/traefik \/usr\/local\/bin\/traefik/);
  assert.match(script, /systemctl restart traefik/);
});

test("proxy endpoints follow the selected reverse proxy", () => {
  assert.equal(proxyEndpointFor("traefik", "10.0.0.54"), "http://10.0.0.54:8080");
  assert.equal(proxyEndpointFor("caddy", "10.0.0.54"), "http://10.0.0.54:2019");
  assert.equal(proxyEndpointFor("traefik", undefined), undefined);
});
