import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";
import { buildMenuOptions, runInteractiveApp } from "../src/tui.js";

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

function createProjectYaml() {
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
  services:
    - id: nc_exp_test
      name: dns
      exposure:
        hostname: dns.bunnyhome.test
        backend:
          ip: 10.0.0.53
          port: 5380
        protocol: https
        certificateAuthority: step-ca
        tls:
          mode: step-ca
          trusted: true
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test
  nc_ca_test: nominaconnect/provider/nc_ca_test
`;
}

function createState() {
  return {
    version: 1,
    providerReferences: {
      nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
      nc_proxy_test: { vmid: 121, ip: "10.0.0.54" },
      nc_ca_test: { vmid: 122, ip: "10.0.0.55" },
      nc_exp_test: { dns: "dns.bunnyhome.test", reverseProxy: "dns.bunnyhome.test", certificateAuthority: "dns.bunnyhome.test" }
    },
    tracking: { notices: [] }
  };
}

function seed(filesystem) {
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", createProjectYaml());
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify(createState(), null, 2)}\n`);
}

function createTechnitiumAdapter() {
  const state = { publishCalls: [], deleteCalls: [] };
  return {
    publishCalls: state.publishCalls,
    deleteCalls: state.deleteCalls,
    inspect() {
      return { resources: [] };
    },
    publishRecord(request) {
      state.publishCalls.push(request);
      return { id: request.hostname };
    },
    deleteRecord(request) {
      state.deleteCalls.push(request);
      return { id: request.hostname };
    },
    healthCheckExposure() {
      return { dns: "reachable", status: "healthy" };
    },
    healthCheck() {
      return { process: "running", endpoint: "reachable" };
    }
  };
}

function createCaddyAdapter() {
  const state = { publishCalls: [], unpublishCalls: [] };
  return {
    publishCalls: state.publishCalls,
    unpublishCalls: state.unpublishCalls,
    inspect() {
      return { resources: [] };
    },
    publishRoute(request) {
      state.publishCalls.push(request);
      return { id: request.hostname };
    },
    unpublishRoute(request) {
      state.unpublishCalls.push(request);
      return { id: request.hostname };
    },
    healthCheckExposure() {
      return { https: "reachable", tls: "valid", status: "healthy" };
    },
    healthCheck() {
      return { process: "running", endpoint: "reachable" };
    }
  };
}

function createProxmoxAdapter() {
  const execCalls = [];
  return {
    execCalls,
    pctExec(vmid, command) {
      execCalls.push({ vmid, command });
      return { exitCode: 0, stdout: "ok" };
    }
  };
}

test("nomina domain change migrates exposures, DNS records, routes, and step-ca SANs", async () => {
  const filesystem = new FakeFilesystem();
  seed(filesystem);
  const technitium = createTechnitiumAdapter();
  const caddy = createCaddyAdapter();
  const proxmox = createProxmoxAdapter();

  const result = await runCli(
    ["domain", "change", "bunny.home.arpa", "--project-dir", "/projects/bunnyhome"],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      providerAdapters: { technitium, caddy }
    }
  );

  assert.match(result.stdout, /bunny\.home\.arpa/i);

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /baseLocalDomain: bunny\.home\.arpa/);
  assert.match(config, /hostname: dns\.bunny\.home\.arpa/);
  assert.doesNotMatch(config, /baseLocalDomain: bunnyhome\.test/);

  assert.equal(
    technitium.publishCalls.at(-1)?.hostname,
    "dns.bunny.home.arpa",
    "a fresh A record must be published in the new domain"
  );
  assert.equal(technitium.publishCalls.at(-1)?.ip, "10.0.0.54", "A record must point at Caddy");
  assert.deepEqual(
    technitium.deleteCalls.map((call) => call.hostname),
    ["dns.bunnyhome.test"],
    "the old record must be cleaned up"
  );

  assert.equal(caddy.publishCalls.at(-1)?.hostname, "dns.bunny.home.arpa");
  assert.equal(caddy.publishCalls.at(-1)?.backendPort, 5380);
  assert.deepEqual(
    caddy.unpublishCalls.map((call) => call.hostname),
    ["dns.bunnyhome.test"],
    "the old route must be removed"
  );
  assert.equal(caddy.publishCalls.at(-1)?.tls.caHost, "step-ca.bunny.home.arpa");

  const scripts = proxmox.execCalls.map((call) => `${call.command.binary ?? ""} ${(call.command.args ?? []).join(" ")}`);
  assert.ok(
    scripts.some((script) => script.includes("step-ca.bunny.home.arpa") && script.includes("dnsNames")),
    "step-ca must be given a SAN for step-ca.<new-domain>"
  );
  assert.ok(
    scripts.some((script) => script.includes("echo '10.0.0.55 step-ca.bunny.home.arpa' >> /etc/hosts")),
    "the Caddy LXC hosts pin must use the new CA name"
  );
  assert.ok(
    scripts.some((script) => script.includes("curl -sf http://127.0.0.1:2019/config/ > /etc/caddy/caddy.json")),
    "live Caddy config must be persisted after the migration"
  );

  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.ok(state.providerReferences.nc_exp_test !== undefined);
});

test("nomina domain change rejects an invalid domain", async () => {
  const filesystem = new FakeFilesystem();
  seed(filesystem);

  await assert.rejects(
    runCli(["domain", "change", "bunny..arpa", "--project-dir", "/projects/bunnyhome"], {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox: createProxmoxAdapter(),
      providerAdapters: {}
    }),
    /invalid.*domain/i
  );
});

test("nomina domain change rejects the current domain", async () => {
  const filesystem = new FakeFilesystem();
  seed(filesystem);

  await assert.rejects(
    runCli(["domain", "change", "bunnyhome.test", "--project-dir", "/projects/bunnyhome"], {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox: createProxmoxAdapter(),
      providerAdapters: {}
    }),
    /already the local domain|same/i
  );
});

test("interactive menu offers domain change when exposures exist, and routes to it", async () => {
  const filesystem = new FakeFilesystem();
  seed(filesystem);
  const { loadProject } = await import("../src/config.js");
  const project = loadProject(filesystem, "/projects/bunnyhome");

  const optionValues = buildMenuOptions(project).map((option) => option.value);
  assert.ok(optionValues.includes("change-domain"));

  const commands = [];
  await runInteractiveApp({
    filesystem: {
      exists: (path) => path === "/projects/home/nomina.yaml",
      read: () => ""
    },
    cwd: "/projects/home",
    interactive: {
      chooseAction: async () => "change-domain"
    },
    runCommand: async (argumentsList) => {
      commands.push(argumentsList);
      return { stdout: "changed\n" };
    }
  });

  assert.deepEqual(commands, [["domain", "change"]]);
});
