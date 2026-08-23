import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";
import { createCaddyAdapter } from "../src/caddy-adapter.js";
import { withHealthyRetry } from "../src/adoption.js";

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

function createProjectYaml({ dnsProvisioned }) {
  const state = {
    version: 1,
    providerReferences: {},
    tracking: { notices: [] }
  };
  if (dnsProvisioned) {
    state.providerReferences.nc_dns_test = { vmid: 120, ip: "10.0.0.53" };
  }
  return { yaml: `apiVersion: nomina.connect/v0alpha1
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
      service: caddy
    certificateAuthority: null
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
`, state };
}

function seed(filesystem, { dnsProvisioned }) {
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  const { yaml, state } = createProjectYaml({ dnsProvisioned });
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", yaml);
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify(state, null, 2)}\n`);
}

function createProxmoxAdapter() {
  const created = [];
  return {
    created,
    checkIpAvailability(ip) {
      return { status: "available" };
    },
    createLxc(spec) {
      created.push(spec);
      return { vmid: 130, hostname: spec.hostname };
    },
    pctExec() {
      return { exitCode: 0, stdout: "ok" };
    },
    listTemplates() {
      return ["local:vztmpl/debian-12-standard_20240207_amd64.tar.zst"];
    }
  };
}

test("service LXCs default their nameserver to the managed Technitium IP when DNS is provisioned", async () => {
  const filesystem = new FakeFilesystem();
  seed(filesystem, { dnsProvisioned: true });
  const proxmox = createProxmoxAdapter();

  await runCli(
    ["service", "add", "caddy", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.54"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: {
        caddy: {
          setup(plan) {
            return { ...plan, lxcCommands: [] };
          },
          inspect() {
            return { resources: [], unmanaged: [] };
          },
          healthCheck() {
            return { process: "running", endpoint: "reachable", status: "healthy" };
          }
        }
      }
    }
  );

  assert.equal(proxmox.created[0].nameserver, "10.0.0.53",
    "router resolvers answer local zones with junk (bogus AAAA), so service LXCs must use Technitium");
});

test("technitium itself still defaults to the gateway nameserver (it cannot use itself before it exists)", async () => {
  const filesystem = new FakeFilesystem();
  seed(filesystem, { dnsProvisioned: false });
  const proxmox = createProxmoxAdapter();

  await runCli(
    ["service", "add", "technitium", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.53"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: {
        technitium: {
          setup(plan) {
            return { ...plan, lxcCommands: [] };
          },
          configure() {
            return {};
          },
          inspect() {
            return { resources: [], managed: [] };
          },
          healthCheck() {
            return { process: "running", endpoint: "reachable", status: "healthy" };
          }
        }
      }
    }
  );

  assert.equal(proxmox.created[0].nameserver, "10.0.0.1");
});

test("an explicit --nameserver always wins over the Technitium default", async () => {
  const filesystem = new FakeFilesystem();
  seed(filesystem, { dnsProvisioned: true });
  const proxmox = createProxmoxAdapter();

  await runCli(
    ["service", "add", "caddy", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.54", "--nameserver", "10.9.9.9"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: {
        caddy: {
          setup(plan) {
            return { ...plan, lxcCommands: [] };
          },
          inspect() {
            return { resources: [], unmanaged: [] };
          },
          healthCheck() {
            return { process: "running", endpoint: "reachable", status: "healthy" };
          }
        }
      }
    }
  );

  assert.equal(proxmox.created[0].nameserver, "10.9.9.9");
});

test("withHealthyRetry retries until the health check reports healthy", async () => {
  let calls = 0;
  const result = await withHealthyRetry(() => {
    calls += 1;
    if (calls < 3) {
      return { https: "reachable", tls: "valid", status: "unhealthy" };
    }
    return { https: "reachable", tls: "valid", status: "healthy" };
  }, { baseDelayMs: 1 });

  assert.equal(calls, 3);
  assert.equal(result.status, "healthy");
});

test("withHealthyRetry returns the last unhealthy result once attempts are exhausted", async () => {
  let calls = 0;
  const result = await withHealthyRetry(() => {
    calls += 1;
    return { status: "unhealthy", reason: `attempt ${calls}` };
  }, { maxAttempts: 3, baseDelayMs: 1 });

  assert.equal(calls, 3);
  assert.equal(result.reason, "attempt 3");
});

test("publish waits for ACME issuance instead of reporting a false unhealthy", async () => {
  const filesystem = new FakeFilesystem();
  seed(filesystem, { dnsProvisioned: false });
  // re-seed with a fully provisioned project including step-ca and an exposure-capable platform
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", `apiVersion: nomina.connect/v0alpha1
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
      service: caddy
      deployment:
        ip: 10.0.0.54
        hostname: caddy
    certificateAuthority:
      id: nc_ca_test
      service: step-ca
      deployment:
        ip: 10.0.0.55
        hostname: step-ca
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
`);
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify({
    version: 1,
    providerReferences: {
      nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
      nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
      nc_ca_test: { vmid: 122, ip: "10.0.0.55" }
    },
    tracking: { notices: [] }
  }, null, 2)}
`);

  let proxyHealthCalls = 0;
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
        technitium: {
          publishRecord() {
            return { id: "photos.bunnyhome.test" };
          },
          deleteRecord() {
            return { id: "photos.bunnyhome.test" };
          },
          unpublishRecord() {
            return { id: "photos.bunnyhome.test" };
          },
          inspect() {
            return { resources: [] };
          },
          healthCheckExposure() {
            return { dns: "reachable", status: "healthy" };
          },
          healthCheck() {
            return { process: "running", endpoint: "reachable", status: "healthy" };
          }
        },
        caddy: {
          publishRoute() {
            return { id: "photos.bunnyhome.test" };
          },
          unpublishRoute() {
            return { id: "photos.bunnyhome.test" };
          },
          inspect() {
            return { resources: [] };
          },
          healthCheckExposure() {
            proxyHealthCalls += 1;
            // First call simulates the ACME-issuance window right after the route lands.
            if (proxyHealthCalls === 1) {
              return { https: "unreachable", status: "unhealthy" };
            }
            return { https: "reachable", tls: "valid", status: "healthy" };
          },
          healthCheck() {
            return { process: "running", endpoint: "reachable", status: "healthy" };
          }
        },
        "step-ca": {
          inspect() {
            return { resources: [] };
          },
          healthCheckExposure() {
            return { tls: "valid", issuer: "step-ca", status: "healthy" };
          },
          healthCheck() {
            return { process: "running", endpoint: "reachable", status: "healthy" };
          }
        }
      }
    }
  );

  assert.equal(proxyHealthCalls >= 2, true, "proxy health check must be retried during the issuance window");
  assert.equal(result.health.status, "healthy", "a transiently-unhealthy proxy must not fail the publish");
});

test("upgrading Caddy installs the persistence drop-in on pre-existing containers", async () => {
  const adapter = createCaddyAdapter({ httpClient: {}, secretResolver: () => {} });
  const plan = await adapter.upgrade({ connectionSecretReference: "nominaconnect/provider/x" });

  const scripts = plan.lxcCommands.map((command) => `${command.binary ?? ""} ${(command.args ?? []).join(" ")}`);
  assert.ok(
    scripts.some((script) => script.includes("nomina-persistence.conf") && script.includes("daemon-reload")),
    "upgrade must add the systemd drop-in that survives restarts"
  );
});

test("nomina --version prints the version", async () => {
  const result = await runCli(["--version"], {});
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);

  const short = await runCli(["version"], {});
  assert.match(short.stdout, /^\d+\.\d+\.\d+\n$/);
});
