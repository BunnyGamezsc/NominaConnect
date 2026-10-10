import test from "node:test";
import assert from "node:assert/strict";

import { createServer, createConnection } from "node:net";
import { parseProjectConfiguration } from "../src/config.js";
import { probeTcp } from "../src/tcp-adapter.js";
import { runAdoptionPass } from "../src/adoption.js";
import { runCli } from "../src/cli.js";

const proxmoxRootRuntime = () => ({ isRoot: () => true, isProxmoxHost: () => true });

function tcpFixture({ proxy = "caddy", tailscale = false, conflict = false, reachable = true } = {}) {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem, "/projects/bunnyhome", { proxyService: proxy });
  if (tailscale) {
    filesystem.writeFile("/projects/bunnyhome/nomina.yaml", filesystem.read("/projects/bunnyhome/nomina.yaml").replace("vpn: null", "vpn:\n      id: nc_vpn\n      service: tailscale"));
    const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
    state.providerReferences.nc_vpn = { vmid: 122, ip: "192.168.1.90" };
    filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", JSON.stringify(state));
  }
  const calls = [];
  const resources = [];
  const technitium = createTechnitiumAdapter();
  technitium.deleteRecord = (request) => { calls.push(["delete-dns", request]); };
  const web = proxy === "caddy" ? createCaddyAdapter() : createTraefikAdapter();
  const tcp = {
    async preflight(request) {
      calls.push(["preflight", request]);
      if (conflict) throw new Error("Listener conflict");
    },
    async publish(request) {
      calls.push(["publish", request]);
      const index = resources.findIndex((item) => item.hostname === request.hostname);
      if (index >= 0) resources.splice(index, 1);
      resources.push({ ...request, id: request.hostname });
    },
    async inspect() { return { resources }; },
    async healthCheckExposure() { return reachable ? { status: "healthy", tcp: "reachable", application: "not-verified" } : { status: "unhealthy", tcp: "unreachable", reason: "TCP backend is unreachable." }; },
    async remove(request) { calls.push(["remove", request]); resources.splice(resources.findIndex((item) => item.hostname === request.hostname), 1); }
  };
  const adapters = { filesystem, runtime: proxmoxRootRuntime(), providerAdapters: { technitium, [proxy]: web, tcp } };
  const publish = (extra = []) => runCli(["exposure", "publish", "--project-dir", "/projects/bunnyhome", "--name", "minecraft", "--hostname", "mc.bunnyhome.test", "--backend-ip", "192.168.1.50", "--backend-port", "25565", ...extra], adapters);
  const config = () => parseProjectConfiguration(filesystem.read("/projects/bunnyhome/nomina.yaml"));
  return { filesystem, adapters, tcp, web, technitium, calls, resources, publish, config };
}

for (const proxy of ["caddy", "traefik"]) {
  test(`TCP publishing with ${proxy} persists DNS and forwarding without a web route or certificate`, async () => {
    const fixture = tcpFixture({ proxy, tailscale: true });
    const result = await fixture.publish(["--protocol", "tcp"]);
    assert.equal(result.health.status, "healthy");
    assert.match(result.stdout, /TCP.*listener 25565; application join not verified/);
    const exposure = fixture.config().managedInventory.services[0].exposure;
    assert.equal(exposure.protocol, "tcp");
    assert.equal(exposure.listenerPort, "25565");
    assert.equal(exposure.tls, undefined);
    assert.equal(exposure.certificateAuthority, undefined);
    assert.equal(fixture.technitium.publishCalls[0].ip, "10.0.0.54");
    assert.equal(fixture.web.publishCalls.length, 0);
    assert.equal(fixture.calls[1][1].gatewayLanIp, "192.168.1.90");
    assert.equal(fixture.calls[1][1].tailnet, true);
    const service = fixture.config().managedInventory.services[0];
    const state = JSON.parse(fixture.filesystem.read("/projects/bunnyhome/.nomina/state.json"));
    assert.deepEqual(state.providerReferences[service.id].tcp, { ip: "10.0.0.54", port: 25565 });
  });
}

test("TCP guided setup takes protocol, hostname, backend IP and port without HTTPS questions", async () => {
  const fixture = tcpFixture();
  const questions = [];
  fixture.adapters.prompts = { ask: async (question, fallback) => {
    questions.push(question);
    return { "Service name": "minecraft", "Full hostname": "mc.bunnyhome.test", "Exposure protocol (https, tcp or smb)": "tcp", "Backend IP": "192.168.1.50", "Backend port": "25565" }[question] ?? fallback;
  } };
  const result = await runCli(["exposure", "publish", "--project-dir", "/projects/bunnyhome"], fixture.adapters);
  assert.equal(result.managedService.exposure.protocol, "tcp");
  assert.ok(!questions.some((question) => /redirect|HTTPS\/TLS/.test(question)));
});

test("TCP republish keeps identity, transport and client port while moving the backend", async () => {
  const fixture = tcpFixture({ tailscale: true });
  await fixture.publish(["--protocol", "tcp"]);
  const id = fixture.config().managedInventory.services[0].id;
  const result = await fixture.publish(["--backend-ip", "192.168.1.60", "--backend-port", "25566", "--tailnet", "false"]);
  assert.match(result.stdout, /updated/);
  const service = fixture.config().managedInventory.services[0];
  assert.equal(service.id, id);
  assert.equal(service.exposure.backend.port, "25566");
  assert.equal(service.exposure.listenerPort, "25565");
  assert.equal(service.exposure.tailnet, false);
  assert.equal(fixture.calls.at(-1)[1].tailnet, false);
  assert.equal(fixture.web.publishCalls.length, 0);
});

test("HTTPS and TCP coexist in saved inventory and publishing TCP preserves the HTTPS route", async () => {
  const fixture = tcpFixture();
  await fixture.publish(["--name", "photos", "--hostname", "photos.bunnyhome.test", "--backend-port", "8080"]);
  const webCalls = fixture.web.publishCalls.length;
  await fixture.publish(["--protocol", "tcp"]);
  const services = fixture.config().managedInventory.services;
  assert.equal(services.find((service) => service.name === "photos").exposure.protocol, "https");
  assert.equal(services.find((service) => service.name === "minecraft").exposure.protocol, "tcp");
  assert.equal(fixture.web.publishCalls.length, webCalls);
  assert.ok((await fixture.web.inspect()).resources.some((resource) => resource.id === "photos.bunnyhome.test"));
  await assert.rejects(fixture.publish(["--protocol", "https"]), /Remove the TCP exposure/);
});

test("TCP endpoint conflicts are rejected before DNS mutation or saved-state changes", async () => {
  const fixture = tcpFixture({ conflict: true });
  const saved = fixture.filesystem.read("/projects/bunnyhome/nomina.yaml");
  await assert.rejects(fixture.publish(["--protocol", "tcp"]), /conflict/);
  assert.equal(fixture.technitium.publishCalls.length, 0);
  assert.equal(fixture.calls.filter(([kind]) => kind === "publish").length, 0);
  assert.equal(fixture.filesystem.read("/projects/bunnyhome/nomina.yaml"), saved);
});

test("TCP cannot share a listener by using another hostname and reserves administration ports", async () => {
  const fixture = tcpFixture();
  await fixture.publish(["--protocol", "tcp"]);
  await assert.rejects(fixture.publish(["--protocol", "tcp", "--hostname", "other.bunnyhome.test"]), /cannot route by hostname/);
  for (const port of [22, 53, 80, 443, 2019, 5380, 8080, 9000]) {
    await assert.rejects(fixture.publish(["--protocol", "tcp", "--hostname", "other.bunnyhome.test", "--listener-port", String(port)]), /reserved/);
  }
  assert.equal(fixture.technitium.publishCalls.length, 1);
});

test("TCP validates ports and rejects HTTP options before mutation", async () => {
  const fixture = tcpFixture();
  for (const extra of [["--backend-port", "65536"], ["--listener-port", "65536"], ["--redirect-to", "home.bunnyhome.test"], ["--backend-tls"], ["--protocol", "udp"]]) {
    await assert.rejects(fixture.publish(["--protocol", "tcp", ...extra]));
  }
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.technitium.publishCalls.length, 0);
});

test("TCP preserves unmanaged DNS and reports unreachable backend as transport failure", async () => {
  const fixture = tcpFixture({ reachable: false });
  const result = await fixture.publish(["--protocol", "tcp"]);
  assert.equal(result.health.status, "unhealthy");
  assert.match(result.stdout, /TCP backend is unreachable/);
  assert.ok(result.dnsInspection.unmanaged.some((record) => record.id === "legacy.bunnyhome.test"));
  const another = tcpFixture();
  await another.technitium.publishRecord({ hostname: "mc.bunnyhome.test", ip: "10.0.0.99" });
  another.technitium.publishCalls.length = 0;
  await assert.rejects(another.publish(["--protocol", "tcp"]), /unmanaged records/);
  assert.equal(another.calls.filter(([kind]) => kind === "publish").length, 0);
});

test("TCP removal disconnects only the exposure's DNS and forwarding", async () => {
  const fixture = tcpFixture({ tailscale: true });
  await fixture.publish(["--protocol", "tcp"]);
  let webRemoval = false;
  fixture.web.unpublishRoute = () => { webRemoval = true; };
  await runCli(["service", "remove", "minecraft", "--project-dir", "/projects/bunnyhome"], fixture.adapters);
  assert.equal(webRemoval, false);
  assert.deepEqual(fixture.calls.slice(-2).map(([kind]) => kind), ["remove", "delete-dns"]);
  assert.equal(fixture.config().managedInventory.services.length, 0);
  assert.equal(fixture.resources.length, 0);
});

test("TCP tracking adopts inspected backend changes and avoids missing HTTP route warnings", async () => {
  const fixture = tcpFixture();
  await fixture.publish(["--protocol", "tcp"]);
  fixture.resources[0].backendIp = "192.168.1.60";
  const project = { config: fixture.config(), state: JSON.parse(fixture.filesystem.read("/projects/bunnyhome/.nomina/state.json")) };
  const result = await runAdoptionPass({ project, providerAdapters: fixture.adapters.providerAdapters, retryOptions: { maxAttempts: 1 } });
  const change = result.changes.find((item) => item.kind === "exposure-changed");
  assert.equal(change.after.backend.ip, "192.168.1.60");
  assert.equal(change.verified, true);
  assert.ok(!result.warnings.some((warning) => /no longer serves a route/.test(warning.message)));
});

const publishSmb = (fixture, extra = []) => runCli([
  "exposure", "publish", "--project-dir", "/projects/bunnyhome", "--name", "files",
  "--hostname", "files.bunnyhome.test", "--backend-ip", "198.51.100.21", ...extra
], fixture.adapters);

for (const proxy of ["caddy", "traefik"]) {
  test(`SMB with ${proxy} defaults backend and client ports to 445 without owning a server`, async () => {
    const fixture = tcpFixture({ proxy, tailscale: true });
    const result = await publishSmb(fixture, ["--protocol", "smb"]);
    const service = fixture.config().managedInventory.services[0];
    assert.equal(service.exposure.protocol, "tcp");
    assert.equal(service.exposure.preset, "smb");
    assert.equal(service.exposure.listenerPort, "445");
    assert.equal(service.exposure.backend.port, "445");
    assert.equal(service.deployment, undefined);
    assert.equal(fixture.calls[1][1].tailnet, true);
    assert.equal(fixture.calls[1][1].listenerPort, 445);
    assert.equal(fixture.technitium.publishCalls[0].ip, "10.0.0.54");
    assert.equal(fixture.web.publishCalls.length, 0);
    assert.equal(result.health.tcp.application, "not-verified");
    assert.match(result.stdout, /listener 445; SMB file access not verified/);
    assert.ok(result.stdout.includes("\\\\files.bunnyhome.test\\SHARE"));
    assert.match(result.stdout, /smb:\/\/files.bunnyhome.test\/SHARE/);
    assert.match(result.stdout, /hostname alias/);
    const state = JSON.parse(fixture.filesystem.read("/projects/bunnyhome/.nomina/state.json"));
    assert.deepEqual(state.providerReferences[service.id].tcp, { ip: "10.0.0.54", port: 445 });
  });
}

for (const menu of [false, true]) {
  test(`SMB guided ${menu ? "menu" : "text"} setup selects port 445 and skips web options`, async () => {
    const fixture = tcpFixture();
    const questions = [];
    fixture.adapters.prompts = { ask: async (question, fallback) => {
      questions.push([question, fallback]);
      return { "Service name": "files", "Full hostname": "files.bunnyhome.test", "Exposure protocol (https, tcp or smb)": "smb", "Backend IP": "198.51.100.21" }[question] ?? fallback;
    } };
    if (menu) fixture.adapters.prompts.select = async (options) => {
      assert.ok(options.options.some((option) => option.value === "smb"));
      return "smb";
    };
    const result = await runCli(["exposure", "publish", "--project-dir", "/projects/bunnyhome"], fixture.adapters);
    assert.equal(result.managedService.exposure.preset, "smb");
    assert.equal(result.managedService.exposure.tailnet, false);
    assert.equal(result.managedService.exposure.backend.port, 445);
    assert.equal(result.managedService.exposure.listenerPort, 445);
    assert.ok(questions.some(([question, fallback]) => question === "Backend port" && fallback === "445"));
    assert.ok(!questions.some(([question]) => /redirect|HTTPS\/TLS/.test(question)));
  });
}

test("SMB republish after configuration reload keeps its preset and port, adopting backend edits", async () => {
  const fixture = tcpFixture({ tailscale: true });
  await publishSmb(fixture, ["--protocol", "smb", "--backend-port", "1445"]);
  const id = fixture.config().managedInventory.services[0].id;
  const result = await publishSmb(fixture, ["--backend-ip", "198.51.100.22", "--tailnet", "false"]);
  assert.match(result.stdout, /updated/);
  const service = fixture.config().managedInventory.services[0];
  assert.equal(service.id, id);
  assert.equal(service.exposure.preset, "smb");
  assert.equal(service.exposure.backend.port, "1445");
  assert.equal(service.exposure.listenerPort, "445");
  assert.equal(service.exposure.tailnet, false);
  assert.equal(fixture.calls.at(-1)[1].tailnet, false);
  fixture.resources[0].backendPort = 2445;
  const project = { config: fixture.config(), state: JSON.parse(fixture.filesystem.read("/projects/bunnyhome/.nomina/state.json")) };
  const adoption = await runAdoptionPass({ project, providerAdapters: fixture.adapters.providerAdapters, retryOptions: { maxAttempts: 1 } });
  const change = adoption.changes.find((item) => item.kind === "exposure-changed");
  assert.equal(change.after.preset, "smb");
  assert.equal(change.after.listenerPort, "445");
  assert.equal(change.after.backend.port, 2445);
  assert.equal(change.verified, true);
});

test("scripted SMB defaults its port without prompting when production prompts are installed", async () => {
  const fixture = tcpFixture({ tailscale: true });
  fixture.adapters.prompts = {
    ask: async () => { throw new Error("Unexpected scripted prompt"); },
    select: async () => { throw new Error("Unexpected scripted prompt"); },
    confirm: async () => { throw new Error("Unexpected scripted prompt"); }
  };
  const created = await publishSmb(fixture, ["--protocol", "smb", "--tailnet", "true"]);
  assert.equal(created.managedService.exposure.backend.port, 445);
  await publishSmb(fixture, ["--protocol", "smb", "--backend-port", "1445", "--tailnet", "true"]);
  const inherited = await publishSmb(fixture, ["--tailnet", "false"]);
  assert.equal(inherited.managedService.exposure.preset, "smb");
  assert.equal(inherited.managedService.exposure.backend.port, 1445);
  const updated = await publishSmb(fixture, ["--protocol", "tcp", "--tailnet", "false"]);
  assert.equal(updated.managedService.exposure.backend.port, 1445);
  assert.equal(updated.managedService.exposure.listenerPort, 445);
});

test("SMB coexists with Minecraft and HTTPS, and removal preserves both", async () => {
  const fixture = tcpFixture({ tailscale: true });
  await fixture.publish(["--protocol", "tcp"]);
  await fixture.publish(["--name", "photos", "--hostname", "photos.bunnyhome.test", "--backend-port", "8080"]);
  const webCalls = fixture.web.publishCalls.length;
  await publishSmb(fixture, ["--protocol", "smb", "--backend-port", "1445"]);
  assert.deepEqual(fixture.resources.map((record) => record.listenerPort), [25565, 445]);
  assert.equal(fixture.resources[1].backendPort, 1445);
  assert.equal(fixture.config().managedInventory.services.length, 3);
  assert.equal(fixture.web.publishCalls.length, webCalls);
  await runCli(["service", "remove", "files", "--project-dir", "/projects/bunnyhome"], fixture.adapters);
  assert.deepEqual(fixture.config().managedInventory.services.map((service) => service.name), ["minecraft", "photos"]);
  assert.equal(fixture.resources.length, 1);
  assert.equal(fixture.resources[0].listenerPort, 25565);
  assert.equal(fixture.web.publishCalls.length, webCalls);
  assert.deepEqual(fixture.calls.slice(-2).map(([kind]) => kind), ["remove", "delete-dns"]);
  assert.equal(fixture.calls.at(-1)[1].hostname, "files.bunnyhome.test");
});

test("SMB rejects conflicting endpoints and web options before mutation", async () => {
  const fixture = tcpFixture();
  const saved = fixture.filesystem.read("/projects/bunnyhome/nomina.yaml");
  for (const extra of [["--listener-port", "1445"], ["--backend-port", "0"], ["--backend-port", "65536"], ["--backend-tls"], ["--redirect-to", "home.bunnyhome.test"]]) {
    await assert.rejects(publishSmb(fixture, ["--protocol", "smb", ...extra]));
  }
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.filesystem.read("/projects/bunnyhome/nomina.yaml"), saved);
  await fixture.publish(["--protocol", "tcp", "--listener-port", "445"]);
  const dnsCalls = fixture.technitium.publishCalls.length;
  await assert.rejects(publishSmb(fixture, ["--protocol", "smb"]), /cannot route by hostname/);
  assert.equal(fixture.technitium.publishCalls.length, dnsCalls);
  const occupied = tcpFixture({ conflict: true });
  await assert.rejects(publishSmb(occupied, ["--protocol", "smb"]), /conflict/);
  assert.equal(occupied.technitium.publishCalls.length, 0);
});

test("SMB unreachable backend is unhealthy without claiming authenticated access", async () => {
  const fixture = tcpFixture({ reachable: false });
  const result = await publishSmb(fixture, ["--protocol", "smb"]);
  assert.equal(result.health.status, "unhealthy");
  assert.equal(result.health.tcp.tcp, "unreachable");
  assert.match(result.stdout, /TCP backend is unreachable/);
  assert.match(result.stdout, /SMB file access not verified/);
});

test("exposure help includes SMB client paths and server ownership", async () => {
  const result = await runCli(["--help"], {});
  assert.match(result.stdout, /https\|tcp\|smb/);
  assert.ok(result.stdout.includes("\\\\files.bunny.internal\\SHARE"));
  assert.match(result.stdout, /smb:\/\/files.bunny.internal\/SHARE/);
  assert.match(result.stdout, /credentials and permissions stay on the server/);
});

test("CLI TCP wire fixture transfers bytes to the declared backend and follows republish", async (t) => {
  const sockets = new Set();
  const keep = (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); return socket; };
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const first = createServer((socket) => { keep(socket); socket.on("data", (data) => socket.end(`first:${data}`)); });
  const second = createServer((socket) => { keep(socket); socket.on("data", (data) => socket.end(`second:${data}`)); });
  await listen(first); await listen(second);
  const fixture = tcpFixture();
  let backendPort;
  const relay = createServer((client) => {
    keep(client);
    const backend = keep(createConnection({ host: "127.0.0.1", port: backendPort }));
    backend.on("error", () => client.destroy()); client.on("error", () => backend.destroy());
    client.pipe(backend); backend.pipe(client);
  });
  await listen(relay);
  t.after(() => { for (const socket of sockets) socket.destroy(); for (const server of [first, second, relay]) server.close(); });
  const port = (server) => /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  const secondPort = port(second);
  const publish = fixture.tcp.publish;
  fixture.tcp.publish = async (request) => { backendPort = request.backendPort; await publish(request); };
  fixture.tcp.healthCheckExposure = async () => ({ status: await probeTcp("127.0.0.1", backendPort) && await probeTcp("127.0.0.1", port(relay)) ? "healthy" : "unhealthy", tcp: "reachable", application: "not-verified" });
  const roundTrip = () => new Promise((resolve, reject) => {
    const client = keep(createConnection({ host: "127.0.0.1", port: port(relay) }, () => client.write("minecraft-wire")));
    client.setTimeout(3000, () => client.destroy(new Error("TCP wire timeout")));
    let response = "";
    client.on("data", (data) => { response += data; }); client.on("end", () => resolve(response)); client.on("error", reject);
  });
  await fixture.publish(["--protocol", "tcp", "--backend-ip", "127.0.0.1", "--backend-port", String(port(first)), "--listener-port", String(port(relay))]);
  assert.equal(await roundTrip(), "first:minecraft-wire");
  await fixture.publish(["--backend-ip", "127.0.0.1", "--backend-port", String(secondPort)]);
  assert.equal(await roundTrip(), "second:minecraft-wire");
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => second.close(resolve));
  const result = await fixture.publish(["--backend-ip", "127.0.0.1", "--backend-port", String(secondPort)]);
  assert.equal(result.health.status, "unhealthy");
});

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

function createProvisionedProjectYaml(proxyService = "caddy", proxyHostname = "caddy") {
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
        hostname: ${proxyHostname}
    certificateAuthority: null
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test
`;
}

const PROVISIONED_STATE = {
  version: 1,
  providerReferences: {
    nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
    nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
  },
  tracking: { notices: [] }
};

function seedProvisionedProject(filesystem, projectDir = "/projects/bunnyhome", { proxyService = "caddy", proxyHostname = "caddy" } = {}) {
  filesystem.mkdir(projectDir);
  filesystem.mkdir(`${projectDir}/.nomina`);
  filesystem.writeFile(`${projectDir}/nomina.yaml`, createProvisionedProjectYaml(proxyService, proxyHostname));
  filesystem.writeFile(`${projectDir}/.nomina/state.json`, `${JSON.stringify(PROVISIONED_STATE, null, 2)}\n`);
}

function createTechnitiumAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "bunnyhome.test", record: "bunnyhome.test NS localhost" },
      { id: "legacy.bunnyhome.test", record: "legacy.bunnyhome.test A 10.0.0.9" }
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

function createTraefikAdapter(overrides = {}) {
  const state = {
    resources: overrides.resources ?? [
      { id: "existing.bunnyhome.test", route: "https://existing.bunnyhome.test" }
    ],
    publishCalls: []
  };
  return {
    publishCalls: state.publishCalls,
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

test("nomina exposure publish creates Technitium record and Caddy HTTPS route together", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
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

  assert.match(result.stdout, /photos\.bunnyhome\.test/i);
  assert.match(result.stdout, /published/i);
  assert.match(result.stdout, /healthy/i);
  assert.equal(technitium.publishCalls.length, 1);
  assert.equal(caddy.publishCalls.length, 1);
  assert.equal(technitium.publishCalls[0].hostname, "photos.bunnyhome.test");
  assert.equal(technitium.publishCalls[0].ip, "10.0.0.54");
  assert.equal(caddy.publishCalls[0].hostname, "photos.bunnyhome.test");
  assert.equal(caddy.publishCalls[0].backendIp, "10.0.0.100");
  assert.equal(caddy.publishCalls[0].backendPort, 8080);
  assert.equal(caddy.publishCalls[0].protocol, "https");

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /photos\.bunnyhome\.test/);
  assert.match(config, /10\.0\.0\.100/);

  const dnsInspection = technitium.inspect().resources;
  assert.deepEqual(
    dnsInspection.find((resource) => resource.id === "legacy.bunnyhome.test"),
    { id: "legacy.bunnyhome.test", record: "legacy.bunnyhome.test A 10.0.0.9" }
  );
  assert.ok(dnsInspection.some((resource) => resource.id === "photos.bunnyhome.test"));

  const proxyInspection = caddy.inspect().resources;
  assert.deepEqual(
    proxyInspection.find((resource) => resource.id === "existing.bunnyhome.test"),
    { id: "existing.bunnyhome.test", route: "https://existing.bunnyhome.test" }
  );
  assert.ok(proxyInspection.some((resource) => resource.id === "photos.bunnyhome.test"));
});

test("an opted-out Tailscale exposure stays opted out on edit and can be enabled later", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const configPath = "/projects/bunnyhome/nomina.yaml";
  filesystem.writeFile(configPath, filesystem.read(configPath).replace("    vpn: null", `    vpn:
      id: nc_vpn_test
      service: tailscale`));
  const statePath = "/projects/bunnyhome/.nomina/state.json";
  const state = JSON.parse(filesystem.read(statePath));
  state.providerReferences.nc_vpn_test = { vmid: 122, ip: "10.0.0.55" };
  filesystem.writeFile(statePath, JSON.stringify(state));
  const technitium = createTechnitiumAdapter();
  const checked = [];
  const caddy = createCaddyAdapter({ exposureHealth(request) {
    checked.push(request);
    return { https: "reachable", status: "healthy" };
  } });
  const adapters = { filesystem, runtime: proxmoxRootRuntime(), providerAdapters: { technitium, caddy } };
  const command = ["exposure", "publish", "--project-dir", "/projects/bunnyhome", "--name", "photos",
    "--hostname", "photos.bunnyhome.test", "--backend-ip", "10.0.0.100", "--backend-port", "8080"];

  await runCli([...command, "--tailnet", "false"], adapters);
  assert.equal(caddy.publishCalls.at(-1).tailnet, false);
  assert.equal(caddy.publishCalls.at(-1).tailnetGatewayIp, "10.0.0.55");
  assert.equal(checked.at(-1).tailnet, false);
  assert.equal(checked.at(-1).tailnetGatewayIp, "10.0.0.55");
  assert.match(filesystem.read(configPath), /tailnet: false/);

  await runCli(command, adapters);
  assert.equal(caddy.publishCalls.at(-1).tailnet, false, "omitting the flag on edit keeps the saved choice");
  await runCli([...command, "--tailnet", "true"], adapters);
  assert.equal(caddy.publishCalls.at(-1).tailnet, true);
  assert.match(filesystem.read(configPath), /tailnet: true/);
});

test("nomina exposure publish updates an existing managed hostname", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const technitium = createTechnitiumAdapter({
    resources: [
      { id: "bunnyhome.test", record: "bunnyhome.test NS localhost" },
      { id: "photos.bunnyhome.test", record: "photos.bunnyhome.test A 10.0.0.99" }
    ]
  });
  const caddy = createCaddyAdapter({
    resources: [
      { id: "photos.bunnyhome.test", route: "https://photos.bunnyhome.test -> 10.0.0.99:8080" }
    ]
  });

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
      providerAdapters: { technitium, caddy }
    }
  );

  assert.equal(
    technitium.inspect().resources.find((resource) => resource.id === "photos.bunnyhome.test").record,
    "photos.bunnyhome.test A 10.0.0.54"
  );
  assert.match(
    caddy.inspect().resources.find((resource) => resource.id === "photos.bunnyhome.test").route,
    /10\.0\.0\.100:8080/
  );
});

test("nomina exposure publish requires Caddy and Technitium to be provisioned", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);
  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  delete state.providerReferences.nc_proxy_test;
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify(state, null, 2)}\n`);

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
      { filesystem, runtime: proxmoxRootRuntime(), providerAdapters: {} }
    ),
    /Caddy must be provisioned/i
  );
});

test("nomina exposure publish reports unhealthy connected exposure", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem);

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
        technitium: createTechnitiumAdapter({
          exposureHealth: () => ({ dns: "unreachable", status: "unhealthy" })
        }),
        caddy: createCaddyAdapter({
          exposureHealth: () => ({ https: "unreachable", status: "unhealthy" })
        })
      }
    }
  );

  assert.equal(result.health.status, "unhealthy");
  assert.match(result.stdout, /unhealthy/i);
});

test("nomina exposure publish creates Technitium record and Traefik HTTPS route together", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem, "/projects/bunnyhome", { proxyService: "traefik", proxyHostname: "traefik" });
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

  assert.match(result.stdout, /photos\.bunnyhome\.test/i);
  assert.match(result.stdout, /published/i);
  assert.match(result.stdout, /healthy/i);
  assert.equal(technitium.publishCalls.length, 1);
  assert.equal(traefik.publishCalls.length, 1);
  assert.equal(technitium.publishCalls[0].hostname, "photos.bunnyhome.test");
  assert.equal(technitium.publishCalls[0].ip, "10.0.0.54");
  assert.equal(traefik.publishCalls[0].hostname, "photos.bunnyhome.test");
  assert.equal(traefik.publishCalls[0].backendIp, "10.0.0.100");
  assert.equal(traefik.publishCalls[0].backendPort, 8080);
  assert.equal(traefik.publishCalls[0].protocol, "https");

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /photos\.bunnyhome\.test/);
  assert.match(config, /10\.0\.0\.100/);

  const dnsInspection = technitium.inspect().resources;
  assert.deepEqual(
    dnsInspection.find((resource) => resource.id === "legacy.bunnyhome.test"),
    { id: "legacy.bunnyhome.test", record: "legacy.bunnyhome.test A 10.0.0.9" }
  );
  assert.ok(dnsInspection.some((resource) => resource.id === "photos.bunnyhome.test"));

  const proxyInspection = traefik.inspect().resources;
  assert.deepEqual(
    proxyInspection.find((resource) => resource.id === "existing.bunnyhome.test"),
    { id: "existing.bunnyhome.test", route: "https://existing.bunnyhome.test" }
  );
  assert.ok(proxyInspection.some((resource) => resource.id === "photos.bunnyhome.test"));
});

test("nomina exposure publish updates an existing managed hostname with Traefik", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem, "/projects/bunnyhome", { proxyService: "traefik", proxyHostname: "traefik" });
  const technitium = createTechnitiumAdapter({
    resources: [
      { id: "bunnyhome.test", record: "bunnyhome.test NS localhost" },
      { id: "photos.bunnyhome.test", record: "photos.bunnyhome.test A 10.0.0.99" }
    ]
  });
  const traefik = createTraefikAdapter({
    resources: [
      { id: "photos.bunnyhome.test", route: "https://photos.bunnyhome.test -> 10.0.0.99:8080" }
    ]
  });

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
      providerAdapters: { technitium, traefik }
    }
  );

  assert.equal(
    technitium.inspect().resources.find((resource) => resource.id === "photos.bunnyhome.test").record,
    "photos.bunnyhome.test A 10.0.0.54"
  );
  assert.match(
    traefik.inspect().resources.find((resource) => resource.id === "photos.bunnyhome.test").route,
    /10\.0\.0\.100:8080/
  );
});

test("nomina exposure publish requires Traefik and Technitium to be provisioned", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem, "/projects/bunnyhome", { proxyService: "traefik", proxyHostname: "traefik" });
  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  delete state.providerReferences.nc_proxy_test;
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", `${JSON.stringify(state, null, 2)}\n`);

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
      { filesystem, runtime: proxmoxRootRuntime(), providerAdapters: {} }
    ),
    /Traefik must be provisioned/i
  );
});

test("nomina exposure publish reports unhealthy connected exposure with Traefik", async () => {
  const filesystem = new FakeFilesystem();
  seedProvisionedProject(filesystem, "/projects/bunnyhome", { proxyService: "traefik", proxyHostname: "traefik" });

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
        technitium: createTechnitiumAdapter({
          exposureHealth: () => ({ dns: "unreachable", status: "unhealthy" })
        }),
        traefik: createTraefikAdapter({
          exposureHealth: () => ({ https: "unreachable", status: "unhealthy" })
        })
      }
    }
  );

  assert.equal(result.health.status, "unhealthy");
  assert.match(result.stdout, /unhealthy/i);
});
