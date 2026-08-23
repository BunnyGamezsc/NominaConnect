import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";
import {
  buildMenuOptions,
  canProvisionCaddyInternalCa,
  canProvisionStepCa,
  canPublishExposure,
  runInteractiveApp
} from "../src/tui.js";
const proxmoxRootRuntime = () => ({ isRoot: () => true, isProxmoxHost: () => true });

class FakeFilesystem {
  files = new Map();
  directories = new Set();
  modes = new Map();

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

  chmod(path, mode) {
    this.modes.set(path, mode);
  }

  read(path) {
    return this.files.get(path);
  }
}

function createProjectYaml({ proxyService = "caddy", caService = "caddy-internal-ca", withCaDeployment = false } = {}) {
  const caBlock = caService === null
    ? "    certificateAuthority: null"
    : `    certificateAuthority:
      id: nc_ca_test
      service: ${caService}${withCaDeployment ? `
      deployment:
        ip: 10.0.0.55
        hostname: ${caService}` : ""}`;

  return `apiVersion: nomina.connect/v0alpha1
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
      service: ${proxyService}
      deployment:
        ip: 10.0.0.54
        hostname: ${proxyService}
${caBlock}
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test${caService ? `\n  nc_ca_test: nominaconnect/provider/nc_ca_test` : ""}
`;
}

function createProxmoxAdapter(overrides = {}) {
  const created = [];
  const execCalls = [];
  return {
    created,
    execCalls,
    checkIpAvailability(ip) {
      return overrides.ipAvailability?.(ip) ?? { status: "available" };
    },
    createLxc(spec) {
      created.push(spec);
      return { vmid: overrides.vmid ?? 122, hostname: spec.hostname };
    },
    pctExec(vmid, command) {
      execCalls.push({ vmid, command });
      return overrides.pctExec?.(vmid, command) ?? { exitCode: 0, stdout: "ok" };
    }
  };
}

function createTechnitiumAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "bunnyhome.test", record: "bunnyhome.test NS localhost" }
    ],
    publishCalls: []
  };
  return {
    publishCalls: state.publishCalls,
    inspect() {
      return { resources: state.resources.map((resource) => ({ ...resource })) };
    },
    publishRecord(request) {
      state.publishCalls.push(request);
      state.resources = state.resources.filter((resource) => resource.id !== request.hostname);
      state.resources.push({ id: request.hostname, record: `${request.hostname} A ${request.ip}` });
      return { id: request.hostname, record: `${request.hostname} A ${request.ip}` };
    },
    healthCheckExposure(request) {
      return overrides.exposureHealth?.(request) ?? { dns: "reachable", status: "healthy" };
    },
    healthCheck() {
      return { process: "running", endpoint: "reachable" };
    }
  };
}

function createCaddyAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "existing.bunnyhome.test", route: "https://existing.bunnyhome.test" }
    ],
    publishCalls: []
  };
  return {
    publishCalls: state.publishCalls,
    setup(plan) {
      return {
        ...plan,
        lxcCommands: ["install-caddy", "configure-https-routes"]
      };
    },
    inspect() {
      return { resources: state.resources.map((resource) => ({ ...resource })) };
    },
    publishRoute(request) {
      state.publishCalls.push(request);
      state.resources = state.resources.filter((resource) => resource.id !== request.hostname);
      state.resources.push({
        id: request.hostname,
        route: `https://${request.hostname} -> ${request.backendIp}:${request.backendPort}`
      });
      return {
        id: request.hostname,
        route: `https://${request.hostname} -> ${request.backendIp}:${request.backendPort}`
      };
    },
    healthCheckExposure(request) {
      return overrides.exposureHealth?.(request) ?? { https: "reachable", status: "healthy" };
    },
    healthCheck() {
      return { process: "running", endpoint: "reachable" };
    }
  };
}

function createStepCaAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "unmanaged-cert", issuer: "step-ca-legacy" }
    ],
    issueCalls: []
  };
  return {
    issueCalls: state.issueCalls,
    setup(plan) {
      return {
        ...plan,
        lxcCommands: ["install-step-ca", "configure-internal-pki"]
      };
    },
    inspect() {
      return { resources: state.resources.map((resource) => ({ ...resource })) };
    },
    adopt(request) {
      return { managedInventoryUpdate: request.managed };
    },
    healthCheckExposure(request) {
      return overrides.exposureHealth?.(request) ?? { tls: "valid", issuer: "step-ca", status: "healthy" };
    },
    healthCheck() {
      return overrides.health ?? { process: "running", endpoint: "reachable" };
    }
  };
}

function createCaddyInternalCaAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "unmanaged-issuer", issuer: "caddy-pki-legacy" }
    ],
    issueCalls: []
  };
  return {
    issueCalls: state.issueCalls,
    setup(plan) {
      return {
        ...plan,
        lxcCommands: ["configure-caddy-internal-ca"]
      };
    },
    inspect() {
      return { resources: state.resources.map((resource) => ({ ...resource })) };
    },
    adopt(request) {
      return { managedInventoryUpdate: request.managed };
    },
    healthCheckExposure(request) {
      return overrides.exposureHealth?.(request) ?? { tls: "valid", issuer: "caddy-internal-ca", status: "healthy" };
    },
    healthCheck() {
      return overrides.health ?? { process: "running", endpoint: "reachable" };
    }
  };
}

test("nomina service add step-ca provisions an unprivileged Debian LXC with defaults", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "step-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      },
      tracking: { notices: [] }
    })
  );

  const proxmox = createProxmoxAdapter();
  const stepCaAdapter = createStepCaAdapter();

  const result = await runCli(
    ["service", "add", "step-ca", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.55"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { "step-ca": stepCaAdapter }
    }
  );

  assert.match(result.stdout, /step-ca provisioned/i);
  assert.match(result.stdout, /10\.0\.0\.55/);
  assert.equal(proxmox.created.length, 1);
  assert.deepEqual(proxmox.created[0], {
    node: "pve-1",
    hostname: "step-ca",
    ip: "10.0.0.55",
    bridge: "vmbr0",
    storage: "local-lvm",
    unprivileged: true,
    template: "debian-12-standard",
    gateway: "10.0.0.1",
    nameserver: "10.0.0.53",
    resources: { cpus: 2, memoryMb: 512, diskGb: 4 }
  });
  assert.deepEqual(
    proxmox.execCalls.map((call) => call.command),
    ["install-step-ca", "configure-internal-pki"]
  );

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /ip: 10\.0\.0\.55/);
  assert.match(config, /hostname: step-ca/);

  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.deepEqual(state.providerReferences.nc_ca_test, { vmid: 122, ip: "10.0.0.55" });
  assert.equal(result.health.status, "healthy");
});

test("nomina service add step-ca requires Technitium and reverse proxy to be provisioned first", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "step-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" }
      },
      tracking: { notices: [] }
    })
  );

  await assert.rejects(
    runCli(
      ["service", "add", "step-ca", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.55"],
      {
        filesystem,
        runtime: proxmoxRootRuntime(),
        proxmox: createProxmoxAdapter(),
        providerAdapters: { "step-ca": createStepCaAdapter() }
      }
    ),
    /Caddy must be provisioned before step-ca/i
  );
});

test("nomina service add step-ca rejects a second provisioning attempt", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "step-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
        nc_ca_test: { vmid: 122, ip: "10.0.0.55" }
      },
      tracking: { notices: [] }
    })
  );

  await assert.rejects(
    runCli(
      ["service", "add", "step-ca", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.55"],
      { filesystem, runtime: proxmoxRootRuntime(), proxmox: createProxmoxAdapter() }
    ),
    /already provisioned/i
  );
});

test("nomina service add caddy-internal-ca configures Caddy internal PKI", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "caddy-internal-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      },
      tracking: { notices: [] }
    })
  );

  const proxmox = createProxmoxAdapter();
  const caddyInternalCaAdapter = createCaddyInternalCaAdapter();

  const result = await runCli(
    ["service", "add", "caddy-internal-ca", "--project-dir", "/projects/bunnyhome"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { "caddy-internal-ca": caddyInternalCaAdapter }
    }
  );

  assert.match(result.stdout, /Caddy Internal CA/i);
  assert.equal(proxmox.created.length, 0);
  assert.deepEqual(
    proxmox.execCalls.map((call) => ({ vmid: call.vmid, command: call.command })),
    [{ vmid: 121, command: "configure-caddy-internal-ca" }]
  );

  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.equal(state.providerReferences.nc_ca_test.vmid, 121);
  assert.equal(result.health.status, "healthy");
});

test("nomina service add caddy-internal-ca requires Caddy to be provisioned first", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "caddy-internal-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" }
      },
      tracking: { notices: [] }
    })
  );

  await assert.rejects(
    runCli(
      ["service", "add", "caddy-internal-ca", "--project-dir", "/projects/bunnyhome"],
      {
        filesystem,
        runtime: proxmoxRootRuntime(),
        proxmox: createProxmoxAdapter(),
        providerAdapters: { "caddy-internal-ca": createCaddyInternalCaAdapter() }
      }
    ),
    /Caddy must be provisioned before Caddy Internal CA/i
  );
});

test("nomina exposure publish with Caddy Internal CA creates Technitium record, trusted Caddy route, and visible CA results", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "caddy-internal-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
        nc_ca_test: { vmid: 121, service: "caddy-internal-ca" }
      },
      tracking: { notices: [] }
    })
  );

  const technitium = createTechnitiumAdapter();
  const caddy = createCaddyAdapter();
  const caddyCa = createCaddyInternalCaAdapter();

  const result = await runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", "photos",
      "--hostname", "photos.bunnyhome.test",
      "--backend-ip", "10.0.0.100",
      "--backend-port", "8080"
    ],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      providerAdapters: { technitium, caddy, "caddy-internal-ca": caddyCa }
    }
  );

  assert.match(result.stdout, /photos\.bunnyhome\.test/i);
  assert.match(result.stdout, /published/i);
  assert.match(result.stdout, /healthy/i);

  assert.equal(caddy.publishCalls[0].protocol, "https");
  assert.equal(caddy.publishCalls[0].caStrategy, "caddy-internal-ca");
  assert.equal(caddy.publishCalls[0].tls.trusted, true);

  assert.equal(result.health.certificateAuthority?.status, "healthy");
  assert.equal(result.managedService.exposure.certificateAuthority, "caddy-internal-ca");
  assert.equal(result.managedService.exposure.tls.trusted, true);

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /certificateAuthority: caddy-internal-ca/);
  assert.match(config, /trusted: true/);
});

test("nomina exposure publish with step-ca creates Technitium record, trusted Caddy route, and visible CA results", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "step-ca", withCaDeployment: true }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
        nc_ca_test: { vmid: 122, ip: "10.0.0.55" }
      },
      tracking: { notices: [] }
    })
  );

  const technitium = createTechnitiumAdapter();
  const caddy = createCaddyAdapter();
  const stepCa = createStepCaAdapter();

  const result = await runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", "photos",
      "--hostname", "photos.bunnyhome.test",
      "--backend-ip", "10.0.0.100",
      "--backend-port", "8080"
    ],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      providerAdapters: { technitium, caddy, "step-ca": stepCa }
    }
  );

  assert.match(result.stdout, /photos\.bunnyhome\.test/i);
  assert.match(result.stdout, /published/i);
  assert.match(result.stdout, /healthy/i);

  assert.equal(caddy.publishCalls[0].protocol, "https");
  assert.equal(caddy.publishCalls[0].caStrategy, "step-ca");
  assert.equal(caddy.publishCalls[0].tls.trusted, true);
  assert.equal(
    caddy.publishCalls[0].tls.caHost,
    "step-ca.bunnyhome.test",
    "exposure publish must hand Caddy a DNS name for step-ca, not the bare IP (step-ca serving certs have no IP SANs)"
  );

  assert.equal(result.health.certificateAuthority?.status, "healthy");
  assert.equal(result.managedService.exposure.certificateAuthority, "step-ca");
  assert.equal(result.managedService.exposure.tls.trusted, true);

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /certificateAuthority: step-ca/);
  assert.match(config, /trusted: true/);
});

test("nomina exposure publish with step-ca pins the CA host, trusts its root, and persists Caddy config in the proxy LXC", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "step-ca", withCaDeployment: true }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
        nc_ca_test: { vmid: 122, ip: "10.0.0.55" }
      },
      tracking: { notices: [] }
    })
  );

  const proxmox = createProxmoxAdapter();

  await runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", "photos",
      "--hostname", "photos.bunnyhome.test",
      "--backend-ip", "10.0.0.100",
      "--backend-port", "8080"
    ],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: {
        technitium: createTechnitiumAdapter(),
        caddy: createCaddyAdapter(),
        "step-ca": createStepCaAdapter()
      }
    }
  );

  const scripts = proxmox.execCalls
    .filter((call) => call.vmid === 121)
    .map((call) => `${call.command.binary ?? ""} ${(call.command.args ?? []).join(" ")}`);

  assert.ok(
    scripts.some((script) => script.includes("echo '10.0.0.55 step-ca.bunnyhome.test' >> /etc/hosts")),
    `Caddy LXC must be able to resolve the CA name before issuance; got:\n${scripts.join("\n---\n")}`
  );
  assert.ok(
    scripts.some((script) => script.includes("/usr/local/share/ca-certificates/step-ca-root.crt") && script.includes("update-ca-certificates")),
    "Caddy LXC must trust the step-ca root before ACME issuance"
  );
  assert.ok(
    scripts.some((script) => script.includes("curl -sf http://127.0.0.1:2019/config/ > /etc/caddy/caddy.json")),
    "published routes/policies must be persisted inside the LXC so a Caddy restart does not wipe them"
  );
});

test("nomina exposure publish without a CA retains HTTPS with untrusted TLS and never falls back to HTTP", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: null }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      },
      tracking: { notices: [] }
    })
  );

  const technitium = createTechnitiumAdapter();
  const caddy = createCaddyAdapter();

  const result = await runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", "photos",
      "--hostname", "photos.bunnyhome.test",
      "--backend-ip", "10.0.0.100",
      "--backend-port", "8080"
    ],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      providerAdapters: { technitium, caddy }
    }
  );

  assert.equal(caddy.publishCalls[0].protocol, "https");
  assert.notEqual(caddy.publishCalls[0].protocol, "http");
  assert.equal(caddy.publishCalls[0].tls.trusted, false);
  assert.equal(caddy.publishCalls[0].caStrategy, "none");

  assert.equal(result.managedService.exposure.protocol, "https");
  assert.equal(result.managedService.exposure.certificateAuthority, "none");
  assert.equal(result.managedService.exposure.tls.trusted, false);
  assert.equal(result.managedService.exposure.tls.mode, "untrusted");

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /protocol: https/);
  assert.doesNotMatch(config, /protocol:\s+http\b/);
  assert.match(config, /trusted: false/);
});

test("nomina exposure publish requires configured CA to be provisioned first", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "step-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      },
      tracking: { notices: [] }
    })
  );

  await assert.rejects(
    runCli(
      [
        "exposure", "publish",
        "--project-dir", "/projects/bunnyhome",
        "--name", "photos",
        "--hostname", "photos.bunnyhome.test",
        "--backend-ip", "10.0.0.100",
        "--backend-port", "8080"
      ],
      {
        filesystem,
        runtime: proxmoxRootRuntime(),
        providerAdapters: { technitium: createTechnitiumAdapter(), caddy: createCaddyAdapter() }
      }
    ),
    /step-ca must be provisioned before publishing an exposure/i
  );
});

test("interactive menu offers step-ca and caddy-internal-ca in dependency order", () => {
  const projectStepCa = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium" },
          reverseProxy: { id: "nc_proxy_test", service: "caddy" },
          certificateAuthority: { id: "nc_ca_test", service: "step-ca" }
        }
      }
    },
    state: {
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      }
    }
  };

  assert.equal(canProvisionStepCa(projectStepCa), true);
  assert.equal(canPublishExposure(projectStepCa), false);
  assert.deepEqual(
    buildMenuOptions(projectStepCa).map((option) => option.value),
    ["provision-step-ca", "toggle-http-redirect", "upgrade-service", "remove-service", "destroy-service", "nuclear-uninstall", "init", "exit"]
  );

  const projectCaddyInternalCa = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium" },
          reverseProxy: { id: "nc_proxy_test", service: "caddy" },
          certificateAuthority: { id: "nc_ca_test", service: "caddy-internal-ca" }
        }
      }
    },
    state: {
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      }
    }
  };

  assert.equal(canProvisionCaddyInternalCa(projectCaddyInternalCa), true);
  assert.equal(canPublishExposure(projectCaddyInternalCa), false);
  assert.deepEqual(
    buildMenuOptions(projectCaddyInternalCa).map((option) => option.value),
    ["provision-caddy-internal-ca", "toggle-http-redirect", "upgrade-service", "remove-service", "destroy-service", "nuclear-uninstall", "init", "exit"]
  );
});

test("nomina service add step-ca blocks provisioning when the requested IP is known to collide", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "step-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      },
      tracking: { notices: [] }
    })
  );

  await assert.rejects(
    runCli(
      ["service", "add", "step-ca", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.53"],
      {
        filesystem,
        runtime: proxmoxRootRuntime(),
        proxmox: createProxmoxAdapter({
          ipAvailability: () => ({ status: "known-collision", conflictWith: "dns" })
        }),
        providerAdapters: { "step-ca": createStepCaAdapter() }
      }
    ),
    /already in use/i
  );
});

test("nomina service add step-ca accepts resource, bridge, storage, and hostname overrides", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "step-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      },
      tracking: { notices: [] }
    })
  );

  const proxmox = createProxmoxAdapter();
  await runCli(
    [
      "service", "add", "step-ca",
      "--project-dir", "/projects/bunnyhome",
      "--ip", "10.0.0.55",
      "--hostname", "custom-ca",
      "--bridge", "vmbr2",
      "--storage", "tank",
      "--cpus", "4",
      "--memory", "1024",
      "--disk", "16"
    ],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { "step-ca": createStepCaAdapter() }
    }
  );

  assert.deepEqual(proxmox.created[0], {
    node: "pve-1",
    hostname: "custom-ca",
    ip: "10.0.0.55",
    bridge: "vmbr2",
    storage: "tank",
    unprivileged: true,
    template: "debian-12-standard",
    gateway: "10.0.0.1",
    nameserver: "10.0.0.53",
    resources: { cpus: 4, memoryMb: 1024, diskGb: 16 }
  });
});

test("nomina service add step-ca reports unhealthy health checks", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "step-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      },
      tracking: { notices: [] }
    })
  );

  const result = await runCli(
    ["service", "add", "step-ca", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.55"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox: createProxmoxAdapter(),
      providerAdapters: {
        "step-ca": createStepCaAdapter({ health: { process: "stopped", endpoint: "unreachable" } })
      }
    }
  );

  assert.equal(result.health.status, "unhealthy");
  assert.match(result.stdout, /unhealthy/);
});

test("nomina service add caddy-internal-ca rejects when not selected as CA in project", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "step-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      },
      tracking: { notices: [] }
    })
  );

  await assert.rejects(
    runCli(
      ["service", "add", "caddy-internal-ca", "--project-dir", "/projects/bunnyhome"],
      {
        filesystem,
        runtime: proxmoxRootRuntime(),
        proxmox: createProxmoxAdapter(),
        providerAdapters: { "caddy-internal-ca": createCaddyInternalCaAdapter() }
      }
    ),
    /Caddy Internal CA is not selected/i
  );
});

test("nomina service add caddy-internal-ca rejects a second provisioning attempt", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "caddy-internal-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
        nc_ca_test: { vmid: 121, service: "caddy-internal-ca" }
      },
      tracking: { notices: [] }
    })
  );

  await assert.rejects(
    runCli(
      ["service", "add", "caddy-internal-ca", "--project-dir", "/projects/bunnyhome"],
      {
        filesystem,
        runtime: proxmoxRootRuntime(),
        proxmox: createProxmoxAdapter(),
        providerAdapters: { "caddy-internal-ca": createCaddyInternalCaAdapter() }
      }
    ),
    /already configured/i
  );
});

test("nomina exposure publish reports unhealthy when CA health check fails", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "caddy-internal-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
        nc_ca_test: { vmid: 121, service: "caddy-internal-ca" }
      },
      tracking: { notices: [] }
    })
  );

  const result = await runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", "photos",
      "--hostname", "photos.bunnyhome.test",
      "--backend-ip", "10.0.0.100",
      "--backend-port", "8080"
    ],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      providerAdapters: {
        technitium: createTechnitiumAdapter(),
        caddy: createCaddyAdapter(),
        "caddy-internal-ca": createCaddyInternalCaAdapter({
          exposureHealth: () => ({ tls: "invalid", status: "unhealthy" })
        })
      }
    }
  );

  assert.equal(result.health.status, "unhealthy");
  assert.equal(result.health.certificateAuthority.status, "unhealthy");
});

test("interactive menu can route to service add step-ca and caddy-internal-ca", async () => {
  const commands = [];
  await runInteractiveApp({
    filesystem: {
      exists: (path) => path === "/projects/home/nomina.yaml",
      read: () => ""
    },
    cwd: "/projects/home",
    interactive: {
      chooseAction: async () => "provision-step-ca"
    },
    runCommand: async (argumentsList) => {
      commands.push(argumentsList);
      return { stdout: "provisioned\n" };
    }
  });

  assert.deepEqual(commands, [["service", "add", "step-ca"]]);

  commands.length = 0;
  await runInteractiveApp({
    filesystem: {
      exists: (path) => path === "/projects/home/nomina.yaml",
      read: () => ""
    },
    cwd: "/projects/home",
    interactive: {
      chooseAction: async () => "provision-caddy-internal-ca"
    },
    runCommand: async (argumentsList) => {
      commands.push(argumentsList);
      return { stdout: "configured\n" };
    }
  });

  assert.deepEqual(commands, [["service", "add", "caddy-internal-ca"]]);
});

test("nomina service add without a service name auto-selects step-ca when step-ca is the only provisionable service", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "step-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      },
      tracking: { notices: [] }
    })
  );

  const result = await runCli(
    ["service", "add", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.55"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox: createProxmoxAdapter(),
      providerAdapters: { "step-ca": createStepCaAdapter() }
    }
  );

  assert.match(result.stdout, /step-ca provisioned/);
});

test("nomina service add without a service name auto-selects caddy-internal-ca when it is the only provisionable service", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "caddy-internal-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      },
      tracking: { notices: [] }
    })
  );

  const result = await runCli(
    ["service", "add", "--project-dir", "/projects/bunnyhome"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox: createProxmoxAdapter(),
      providerAdapters: { "caddy-internal-ca": createCaddyInternalCaAdapter() }
    }
  );

  assert.match(result.stdout, /Caddy Internal CA/);
});

function createTraefikAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "existing.bunnyhome.test", route: "https://existing.bunnyhome.test" }
    ],
    publishCalls: []
  };
  return {
    publishCalls: state.publishCalls,
    setup(plan) {
      return {
        ...plan,
        lxcCommands: ["install-traefik", "configure-https-routes"]
      };
    },
    inspect() {
      return { resources: state.resources.map((resource) => ({ ...resource })) };
    },
    publishRoute(request) {
      state.publishCalls.push(request);
      state.resources = state.resources.filter((resource) => resource.id !== request.hostname);
      state.resources.push({
        id: request.hostname,
        route: `https://${request.hostname} -> ${request.backendIp}:${request.backendPort}`
      });
      return {
        id: request.hostname,
        route: `https://${request.hostname} -> ${request.backendIp}:${request.backendPort}`
      };
    },
    healthCheckExposure(request) {
      return overrides.exposureHealth?.(request) ?? { https: "reachable", status: "healthy" };
    },
    healthCheck() {
      return overrides.health ?? { process: "running", endpoint: "reachable" };
    }
  };
}

test("nomina exposure publish with Traefik and step-ca creates Technitium record, trusted Traefik route, and visible CA results", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ proxyService: "traefik", caService: "step-ca", withCaDeployment: true }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
        nc_ca_test: { vmid: 122, ip: "10.0.0.55" }
      },
      tracking: { notices: [] }
    })
  );

  const technitium = createTechnitiumAdapter();
  const traefik = createTraefikAdapter();
  const stepCa = createStepCaAdapter();

  const result = await runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", "photos",
      "--hostname", "photos.bunnyhome.test",
      "--backend-ip", "10.0.0.100",
      "--backend-port", "8080"
    ],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      providerAdapters: { technitium, traefik, "step-ca": stepCa }
    }
  );

  assert.match(result.stdout, /photos\.bunnyhome\.test/i);
  assert.match(result.stdout, /published/i);
  assert.match(result.stdout, /healthy/i);

  assert.equal(traefik.publishCalls[0].protocol, "https");
  assert.equal(traefik.publishCalls[0].caStrategy, "step-ca");
  assert.equal(traefik.publishCalls[0].tls.trusted, true);

  assert.equal(result.health.certificateAuthority?.status, "healthy");
  assert.equal(result.managedService.exposure.certificateAuthority, "step-ca");
  assert.equal(result.managedService.exposure.tls.trusted, true);

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /certificateAuthority: step-ca/);
  assert.match(config, /trusted: true/);
});

test("nomina exposure publish with Traefik and no CA retains HTTPS with untrusted TLS and never falls back to HTTP", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ proxyService: "traefik", caService: null }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      },
      tracking: { notices: [] }
    })
  );

  const technitium = createTechnitiumAdapter();
  const traefik = createTraefikAdapter();

  const result = await runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", "photos",
      "--hostname", "photos.bunnyhome.test",
      "--backend-ip", "10.0.0.100",
      "--backend-port", "8080"
    ],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      providerAdapters: { technitium, traefik }
    }
  );

  assert.equal(traefik.publishCalls[0].protocol, "https");
  assert.notEqual(traefik.publishCalls[0].protocol, "http");
  assert.equal(traefik.publishCalls[0].tls.trusted, false);
  assert.equal(traefik.publishCalls[0].caStrategy, "none");

  assert.equal(result.managedService.exposure.protocol, "https");
  assert.equal(result.managedService.exposure.certificateAuthority, "none");
  assert.equal(result.managedService.exposure.tls.trusted, false);
  assert.equal(result.managedService.exposure.tls.mode, "untrusted");

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /protocol: https/);
  assert.doesNotMatch(config, /protocol:\s+http\b/);
  assert.match(config, /trusted: false/);
});

test("nomina exposure publish with Traefik requires configured CA to be provisioned first", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ proxyService: "traefik", caService: "step-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      },
      tracking: { notices: [] }
    })
  );

  await assert.rejects(
    runCli(
      [
        "exposure", "publish",
        "--project-dir", "/projects/bunnyhome",
        "--name", "photos",
        "--hostname", "photos.bunnyhome.test",
        "--backend-ip", "10.0.0.100",
        "--backend-port", "8080"
      ],
      {
        filesystem,
        runtime: proxmoxRootRuntime(),
        providerAdapters: { technitium: createTechnitiumAdapter(), traefik: createTraefikAdapter() }
      }
    ),
    /step-ca must be provisioned before publishing an exposure/i
  );
});

test("nomina exposure publish reports unhealthy when CA health check fails with Traefik", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ proxyService: "traefik", caService: "step-ca", withCaDeployment: true }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
        nc_ca_test: { vmid: 122, ip: "10.0.0.55" }
      },
      tracking: { notices: [] }
    })
  );

  const result = await runCli(
    [
      "exposure", "publish",
      "--project-dir", "/projects/bunnyhome",
      "--name", "photos",
      "--hostname", "photos.bunnyhome.test",
      "--backend-ip", "10.0.0.100",
      "--backend-port", "8080"
    ],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      providerAdapters: {
        technitium: createTechnitiumAdapter(),
        traefik: createTraefikAdapter(),
        "step-ca": createStepCaAdapter({
          exposureHealth: () => ({ tls: "invalid", status: "unhealthy" })
        })
      }
    }
  );

  assert.equal(result.health.status, "unhealthy");
  assert.equal(result.health.certificateAuthority.status, "unhealthy");
});

test("nomina service add step-ca requires Traefik to be provisioned first when Traefik is the reverse proxy", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ proxyService: "traefik", caService: "step-ca" }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" }
      },
      tracking: { notices: [] }
    })
  );

  await assert.rejects(
    runCli(
      ["service", "add", "step-ca", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.55"],
      {
        filesystem,
        runtime: proxmoxRootRuntime(),
        proxmox: createProxmoxAdapter(),
        providerAdapters: { "step-ca": createStepCaAdapter() }
      }
    ),
    /Traefik must be provisioned before step-ca/i
  );
});

test("interactive menu offers step-ca when Traefik is the reverse proxy and CA needs provisioning", () => {
  const projectStepCaTraefik = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium" },
          reverseProxy: { id: "nc_proxy_test", service: "traefik" },
          certificateAuthority: { id: "nc_ca_test", service: "step-ca" }
        }
      }
    },
    state: {
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      }
    }
  };

  assert.equal(canProvisionStepCa(projectStepCaTraefik), true);
  assert.equal(canPublishExposure(projectStepCaTraefik), false);
  assert.deepEqual(
    buildMenuOptions(projectStepCaTraefik).map((option) => option.value),
    ["provision-step-ca", "upgrade-service", "remove-service", "destroy-service", "nuclear-uninstall", "init", "exit"]
  );
});

test("interactive menu offers step-ca root export when step-ca is provisioned", () => {
  const project = {
    config: {
      baseLocalDomain: "bunnyhome.test",
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium" },
          reverseProxy: { id: "nc_proxy_test", service: "caddy" },
          certificateAuthority: { id: "nc_ca_test", service: "step-ca" }
        }
      }
    },
    state: {
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
        nc_ca_test: { vmid: 122, ip: "10.0.0.55" }
      }
    }
  };

  const optionValues = buildMenuOptions(project).map((option) => option.value);
  assert.ok(optionValues.includes("view-ca-guide"));
  assert.ok(optionValues.includes("export-ca-cert"));
});

test("nomina ca export writes the root cert and prints scp + per-device install steps", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml({ caService: "step-ca", withCaDeployment: true }));
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    JSON.stringify({
      version: 1,
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
        nc_ca_test: { vmid: 122, ip: "10.0.0.55" }
      },
      tracking: { notices: [] }
    })
  );

  const pem = "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n";
  const proxmox = createProxmoxAdapter({
    pctExec: (vmid, command) => {
      if (String(command.args?.join(" ")).includes("root_ca.crt")) {
        return { exitCode: 0, stdout: pem };
      }
      return { exitCode: 0, stdout: "ok" };
    }
  });

  const result = await runCli(
    ["ca", "export", "--project-dir", "/projects/bunnyhome", "--output", "/tmp-out/step-ca-root.crt"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: {}
    }
  );

  assert.equal(filesystem.read("/tmp-out/step-ca-root.crt"), pem, "export must write the PEM to --output");
  assert.match(result.stdout, /scp root@<proxmox-host>:/, "guide must include scp retrieval from the Proxmox host");
  assert.match(result.stdout, /security add-trusted-cert/, "guide must include macOS trust install");
  assert.match(result.stdout, /update-ca-certificates/, "guide must include Linux trust install");
});

test("interactive menu can route to export-ca-cert", async () => {
  const commands = [];
  await runInteractiveApp({
    filesystem: {
      exists: (path) => path === "/projects/home/nomina.yaml",
      read: () => ""
    },
    cwd: "/projects/home",
    interactive: {
      chooseAction: async () => "export-ca-cert"
    },
    runCommand: async (argumentsList) => {
      commands.push(argumentsList);
      return { stdout: "exported\n" };
    }
  });

  assert.deepEqual(commands, [["ca", "export"]]);
});
