import test from "node:test";
import assert from "node:assert/strict";
import { parseProjectConfiguration, loadProject } from "../src/config.js";
import { runCli } from "../src/cli.js";
import { runAdoptionPass } from "../src/adoption.js";
import { createProductionAdapters } from "../src/adapter-runtime.js";
import { runTrackingJob, formatPendingNotices } from "../src/tracking.js";
import { createStepCaAdapter } from "../src/step-ca-adapter.js";

const directory = "/projects/production";
const yaml = `apiVersion: nomina.connect/v0alpha1
kind: NominaConnect
proxmox:
  node: pve
baseLocalDomain: bunny.internal
managedInventory:
  platform:
    dns:
      id: nc_dns
      service: technitium
    reverseProxy:
      id: nc_proxy
      service: caddy
    certificateAuthority: null
    vpn: null
  services:
    - id: nc_glance
      name: glance
      exposure:
        hostname: bunny.internal
        protocol: https
        redirect:
          to: "https://home.bunny.internal"
          code: 308
`;

class Filesystem {
  files = new Map([
    [`${directory}/nomina.yaml`, yaml],
    [`${directory}/.nomina/state.json`, JSON.stringify({
      version: 1, providerReferences: { nc_dns: { ip: "192.168.4.90" }, nc_proxy: { ip: "192.168.4.86" } },
      tracking: { notices: [] }
    })]
  ]);
  directories = new Set();
  exists(path) { return this.files.has(path) || this.directories.has(path); }
  read(path) { return this.files.get(path); }
  writeFile(path, value) { this.files.set(path, value); }
  mkdir(path) { this.directories.add(path); }
  chmod() {}
  rename(from, to) { this.files.set(to, this.files.get(from)); this.files.delete(from); }
}

function dnsResource(type, zone = "bunny.internal") {
  return { id: "bunny.internal", locator: { zone, name: "bunny.internal", type }, fingerprint: `dns-${zone}-${type}` };
}

function adapters(records = [dnsResource("A")]) {
  const healthy = () => ({ process: "running", endpoint: "reachable" });
  return {
    technitium: { inspect: () => ({ resources: records }), healthCheck: healthy,
      adopt: ({ managed }) => ({ managedInventoryUpdate: managed }) },
    caddy: { inspect: () => ({ resources: [{ id: "bunny.internal", redirectTo: "https://home.bunny.internal", redirectCode: 308 }] }),
      healthCheck: healthy, healthCheckExposure: () => ({ status: "healthy" }) }
  };
}

test("tracking adopts live Proxmox deployment changes and checks the provider at its observed address", async () => {
  const filesystem = new Filesystem();
  const configPath = `${directory}/nomina.yaml`;
  const statePath = `${directory}/.nomina/state.json`;
  filesystem.writeFile(configPath, yaml.replace("service: technitium\n", `service: technitium
      deployment:
        ip: 192.168.4.90
        hostname: technitium
        bridge: vmbr0
        storage: local-lvm
        template: local:vztmpl/debian.tar.zst
        gateway: 192.168.4.1
        nameserver: 1.1.1.1
        resources:
          cpus: 2
          memoryMb: 1024
          diskGb: 8
`));
  const state = JSON.parse(filesystem.read(statePath));
  state.providerReferences.nc_dns.vmid = 150;
  filesystem.writeFile(statePath, JSON.stringify(state));

  const { proxmox } = createProductionAdapters({ commandRunner: {
    async run({ binary, args }) {
      assert.equal(binary, "/usr/sbin/pct");
      assert.deepEqual(args, ["config", "150"]);
      return { stdout: [
        "hostname: dns-renamed", "unprivileged: 1", "cores: 4", "memory: 2048",
        "net0: name=eth0,bridge=vmbr1,ip=192.168.5.90/24,gw=192.168.5.1",
        "rootfs: zfs:vm-150-disk-0,size=12288M"
      ].join("\n") };
    }
  } });
  const providerAdapters = adapters();
  const inspectedIps = [];
  providerAdapters.technitium.healthCheck = ({ ip }) => {
    inspectedIps.push(ip);
    return { process: "running", endpoint: "reachable" };
  };

  const input = { filesystem, projectDir: directory, providerAdapters, proxmox };
  const result = await runTrackingJob(input);
  assert.equal(result.changes.find(({ kind }) => kind === "platform-changed")?.verified, true);
  assert.deepEqual(inspectedIps, ["192.168.5.90"]);
  const { config, state: updatedState } = loadProject(filesystem, directory);
  assert.deepEqual(config.managedInventory.platform.dns.deployment, {
    ip: "192.168.5.90", hostname: "dns-renamed", bridge: "vmbr1", storage: "zfs",
    template: "local:vztmpl/debian.tar.zst", gateway: "192.168.5.1",
    resources: { cpus: "4", memoryMb: "2048", diskGb: "12" }
  });
  assert.deepEqual(updatedState.providerReferences.nc_dns, { vmid: 150, ip: "192.168.5.90" });
  assert.equal((await runTrackingJob(input)).changes.some(({ kind }) => kind === "platform-changed"), false);
});

test("failed Proxmox inspection leaves the deployment intact and reports a verification warning", async () => {
  const project = { config: parseProjectConfiguration(yaml), state: {
    providerReferences: { nc_dns: { vmid: 150, ip: "192.168.4.90" } }
  } };
  let attempts = 0;
  const proxmox = { inspectLxc() { attempts += 1; throw new Error("configuration unavailable"); } };
  const result = await runAdoptionPass({ project, providerAdapters: adapters(), proxmox, retryOptions: { maxRetries: 1, baseDelayMs: 0 } });
  assert.equal(attempts, 2);
  assert.equal(result.changes.some(({ kind }) => kind === "platform-changed"), false);
  assert.match(result.warnings[0].message, /failed to inspect LXC 150.+configuration unavailable/i);
});

test("production apex DNS adopts only its A record among SOA and NS records", async () => {
  const filesystem = new Filesystem();
  const records = [dnsResource("SOA"), dnsResource("NS"), dnsResource("A")];
  const result = await runTrackingJob({ filesystem, projectDir: directory, providerAdapters: adapters(records) });
  assert.deepEqual(result.warnings, []);
  const identity = loadProject(filesystem, directory).state.providerReferences.nc_glance.integrations.dns;
  assert.deepEqual(identity.locator, records[2].locator);
  const next = await runTrackingJob({ filesystem, projectDir: directory, providerAdapters: adapters(records) });
  assert.deepEqual(next.changes, []);
  assert.deepEqual(next.warnings, []);
});

test("a command with --project-dir starts provider inspection for the selected project", async () => {
  const filesystem = new Filesystem();
  const inspected = [];
  const providerAdapters = adapters();
  providerAdapters.technitium.inspect = (request) => {
    inspected.push(request.ip);
    return { resources: [] };
  };
  await runCli(["changes", "--project-dir", directory], { filesystem, providerAdapters });
  assert.deepEqual(inspected, ["192.168.4.90"]);
});

test("repeated project flags are rejected before locking or inspecting a project", async () => {
  const filesystem = Object.assign(new Filesystem(), {
    acquireProjectLock() { throw new Error("Unexpected lock acquisition"); }
  });
  const providerAdapters = adapters();
  providerAdapters.technitium.inspect = () => { throw new Error("Unexpected inspection"); };
  for (const duplicate of [["--project-dir", "/projects/other"], ["--project-dir=/projects/other"]]) {
    await assert.rejects(runCli(["changes", "--project-dir", directory, ...duplicate],
      { filesystem, providerAdapters }), /Specify --project-dir only once/);
  }
});

test("init in a nested directory skips the ancestor project lock and tracking", async () => {
  const filesystem = Object.assign(new Filesystem(), {
    acquireProjectLock() { throw new Error("Unexpected lock acquisition"); }
  });
  const providerAdapters = adapters();
  Object.assign(providerAdapters.technitium, { setup: () => ({}) });
  Object.assign(providerAdapters.caddy, { setup: () => ({}) });
  const inspected = [];
  providerAdapters.technitium.inspect = (request) => { inspected.push(request.ip); return { resources: [] }; };
  const cwd = `${directory}/nested`;
  const result = await runCli(["init", "--node", "pve", "--bridge", "vmbr0", "--storage", "local",
    "--domain", "nested.internal", "--dns", "technitium", "--reverse-proxy", "caddy", "--ca", "none", "--vpn", "none"],
    { filesystem, cwd, runtime: { isRoot: () => true, isProxmoxHost: () => true }, providerAdapters });
  assert.equal(result.configPath, `${cwd}/nomina.yaml`);
  assert.deepEqual(inspected, []);
});

test("tracking drops DNS verification when the reverse proxy changes during inspection", async () => {
  const filesystem = new Filesystem();
  const statePath = `${directory}/.nomina/state.json`;
  const providerAdapters = adapters();
  providerAdapters.technitium.healthCheckExposure = () => {
    const state = JSON.parse(filesystem.read(statePath));
    state.providerReferences.nc_proxy.ip = "192.168.4.89";
    filesystem.writeFile(statePath, JSON.stringify(state));
    return { status: "healthy" };
  };
  const result = await runTrackingJob({ filesystem, projectDir: directory, providerAdapters });
  assert.equal(result.changes.some(change => change.integration === "dns"), false);
  assert.equal(loadProject(filesystem, directory).state.providerReferences.nc_glance, undefined);
});

test("tracking drops proxy access changes observed against a previous VPN gateway", async () => {
  const filesystem = new Filesystem();
  const configPath = `${directory}/nomina.yaml`;
  const statePath = `${directory}/.nomina/state.json`;
  filesystem.writeFile(configPath, yaml.replace("vpn: null", "vpn:\n      id: nc_vpn\n      service: tailscale"));
  const state = JSON.parse(filesystem.read(statePath));
  state.providerReferences.nc_vpn = { ip: "192.168.4.88" };
  filesystem.writeFile(statePath, JSON.stringify(state));
  const providerAdapters = adapters();
  const inspect = providerAdapters.caddy.inspect;
  providerAdapters.caddy.inspect = () => ({
    resources: inspect().resources.map(route => ({ ...route, tailnet: false }))
  });
  const checkedGateways = [];
  Object.assign(providerAdapters.caddy, { healthCheckExposure: ({ tailnetGatewayIp }) => {
    checkedGateways.push(tailnetGatewayIp);
    state.providerReferences.nc_vpn.ip = "192.168.4.89";
    filesystem.writeFile(statePath, JSON.stringify(state));
    return { status: "healthy" };
  } });
  const result = await runTrackingJob({ filesystem, projectDir: directory, providerAdapters });
  assert.deepEqual(checkedGateways, ["192.168.4.88"]);
  assert.equal(result.changes.some(change => change.kind === "exposure-changed"), false);
  assert.equal(loadProject(filesystem, directory).config.managedInventory.services[0].exposure.tailnet, undefined);
});

test("DNS reference adoption checks the record against the managed proxy before reporting verification", async () => {
  const providerAdapters = adapters();
  const requests = [];
  providerAdapters.technitium.healthCheckExposure = (options) => {
    requests.push(options);
    return { status: "unhealthy" };
  };
  const result = await runTrackingJob({ filesystem: new Filesystem(), projectDir: directory, providerAdapters });
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.equal(request.hostname, "bunny.internal");
  assert.equal(request.expectedIp, "192.168.4.86");
  assert.equal(request.ip, "192.168.4.90");
  assert.equal(result.changes.find((change) => change.integration === "dns").verified, false);
  assert.ok(result.warnings.some((warning) => warning.platformKey === "dns" && warning.serviceId === "nc_glance"));
});

test("production redirect loaded from YAML does not report a change on every pass", async () => {
  for (const code of [307, 308]) {
    const project = { config: parseProjectConfiguration(yaml.replace("code: 308", `code: ${code}`)), state: { providerReferences: { nc_proxy: { ip: "192.168.4.86" } } } };
    const providerAdapters = adapters();
    providerAdapters.caddy.inspect = () => ({ resources: [{ id: "bunny.internal", redirectTo: "https://home.bunny.internal", redirectCode: code }] });
    const result = await runAdoptionPass({ project, providerAdapters: { caddy: providerAdapters.caddy } });
    assert.deepEqual(result.changes, []);
    assert.deepEqual(result.warnings, []);
  }
});

test("production apex DNS still refuses multiple A records", async () => {
  const result = await runTrackingJob({ filesystem: new Filesystem(), projectDir: directory,
    providerAdapters: adapters([dnsResource("SOA"), dnsResource("NS"), dnsResource("A"), dnsResource("A")]) });
  assert.ok(result.warnings.some((warning) => /matched 2 provider resources/.test(warning.message)));
  assert.ok(!result.changes.some((change) => change.integration === "dns"));
});

test("production apex DNS preserves SOA/NS when its A record is missing or in another zone", async () => {
  const filesystem = new Filesystem();
  const result = await runTrackingJob({ filesystem, projectDir: directory,
    providerAdapters: adapters([dnsResource("SOA"), dnsResource("NS"), dnsResource("A", "other.internal")]) });
  assert.ok(result.warnings.some((warning) => /no longer has a matching resource/.test(warning.message)));
  assert.ok(!result.changes.some((change) => change.integration === "dns"));
  assert.equal(loadProject(filesystem, directory).state.providerReferences.nc_glance, undefined);
});

test("production tracking retains one pending warning across repeated jobs", async () => {
  const filesystem = new Filesystem();
  const providerAdapters = adapters([]);
  for (let i = 0; i < 3; i++) await runTrackingJob({ filesystem, projectDir: directory, providerAdapters });
  const notices = loadProject(filesystem, directory).state.tracking.notices;
  const warnings = notices.filter((notice) => notice.kind === "verification-warning");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].occurrences, 3);
});

test("production pending notice summary groups warnings saved by older versions", () => {
  const warnings = Array.from({ length: 9 }, (_, i) => ({ id: `nc_${i}`, kind: "verification-warning", platformKey: "certificateAuthority",
    serviceName: "step-ca", verified: false, summary: "step-ca health check failed: process=stopped, endpoint=unreachable." }));
  const formatted = formatPendingNotices(warnings);
  assert.equal(formatted.split("step-ca health check failed").length - 1, 1);
  assert.match(formatted, /reported 9 times/);
});

test("production pending notices keep distinct warnings and verified changes separate", () => {
  const warning = { kind: "verification-warning", serviceName: "glance", platformKey: "dns", verified: false, summary: "missing record" };
  const changes = Array.from({ length: 2 }, () => ({ kind: "exposure-changed", verified: true, summary: "redirect changed" }));
  const formatted = formatPendingNotices([warning, { ...warning, serviceId: "nc_glance" },
    { ...warning, serviceName: "other" }, ...changes]);
  assert.match(formatted, /2 verified change\(s\)/);
  assert.match(formatted, /2 unverified change\(s\) or warning\(s\)/);
  assert.match(formatted, /reported 2 times/);
});

test("production step-ca TLS validation failure does not claim the process is stopped", async () => {
  const adapter = createStepCaAdapter({ httpClient: { request: async ({ url }) => {
    if (url.endsWith("/roots.pem")) return { status: 200, body: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----" };
    throw Object.assign(new Error("certificate hostname mismatch"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  } }, secretResolver: {} });
  const health = await adapter.healthCheck({ ip: "192.168.4.87" });
  assert.equal(health.process, "unknown");
  assert.equal(health.endpoint, "unreachable");
  assert.match(health.reason, /TLS certificate validation failed/);
});
