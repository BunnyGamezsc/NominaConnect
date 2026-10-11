import test from "node:test";
import assert from "node:assert/strict";
import { parseProjectConfiguration, loadProject } from "../src/config.js";
import { runAdoptionPass } from "../src/adoption.js";
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
