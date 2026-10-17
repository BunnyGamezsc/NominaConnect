import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli.js";
import { loadProject, serializeProjectConfiguration } from "../src/config.js";
import { normalizeDockerDiscovery, dockerConnectionHint, usableAddress } from "../src/docker-discovery.js";
import { suggestDockerExposure } from "../src/docker-exposure.js";
import { runInteractiveApp } from "../src/tui.js";
import { createClackPrompts } from "../src/prompts.js";

const directory = "/docker-exposures";
const observed = (overrides = {}) => ({ id: "a".repeat(64), name: "/web", image: "nginx:alpine", status: "running", networkMode: "bridge", ports: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "18080" }] }, labels: {}, ...overrides });

/** Exercise the real CLI/lifecycle while recording provider/config mutations and proxy-context probes. */
function fixture(observations = [observed()], proxy = "caddy") {
  const files = new Map(), writes = [], mutations = [], probes = [], preflights = [], dns = [], routes = [], forwards = [];
  const filesystem = {
    exists: (path) => files.has(path), read: (path) => files.get(path),
    writeFile: (path, content) => { writes.push(path); files.set(path, content); },
    rename: (from, to) => { files.set(to, files.get(from)); files.delete(from); }, chmod: () => {}
  };
  const config = {
    proxmox: { node: "pve", defaultBridge: "vmbr0", defaultStorage: "local-lvm" }, baseLocalDomain: "home.test",
    managedInventory: {
      platform: { dns: { id: "dns", service: "technitium" }, reverseProxy: { id: "proxy", service: proxy }, certificateAuthority: null, vpn: { id: "vpn", service: "tailscale" } },
      services: [], dockerHosts: [{ id: "binding", name: "apps", socketPath: "/run/docker.sock", origin: "connected" }]
    }, connectionSecretReferences: {}
  };
  const state = { providerReferences: { dns: { vmid: 100, ip: "10.0.0.53" }, proxy: { vmid: 101, ip: "10.0.0.54" }, vpn: { vmid: 102, ip: "10.0.0.55" }, binding: { node: "pve", vmid: 106 } } };
  const save = () => { files.set(directory + "/nomina.yaml", serializeProjectConfiguration(config)); files.set(directory + "/.nomina/state.json", JSON.stringify(state)); };
  save();
  let discovery = { ...normalizeDockerDiscovery(observations, "10.0.0.88"), diagnostics: [] }, refreshed, discoveries = 0;
  const adapters = {
    filesystem, cwd: directory, runtime: { isRoot: () => true, isProxmoxHost: () => true },
    tracking: { start: () => { mutations.push("tracking"); } },
    docker: { discover: async (vmid, socket) => { assert.equal(vmid, 106); assert.equal(socket, "/run/docker.sock"); return ++discoveries > 1 && refreshed ? refreshed : discovery; } },
    proxmox: { assertLocalNode: async (node) => assert.equal(node, "pve"), pctExec: async (vmid, command) => { probes.push({ vmid, command }); return { stdout: "" }; } },
    providerAdapters: {
      technitium: { inspect: async () => ({ resources: dns }), publishRecord: async (request) => { mutations.push("dns"); dns.push({ id: request.hostname, record: request.hostname + " A " + request.ip }); }, healthCheckExposure: async () => ({ status: "healthy" }) },
      [proxy]: { inspect: async () => ({ resources: routes }), publishRoute: async (request) => { mutations.push("web"); routes.push({ ...request, id: request.hostname }); return {}; }, healthCheckExposure: async () => ({ status: "healthy", tls: "untrusted" }) },
      tcp: { preflight: async (request) => { preflights.push(request); }, publish: async (request) => { mutations.push("tcp"); forwards.push(request); }, inspect: async () => ({ resources: forwards }), healthCheckExposure: async () => ({ status: "healthy", application: "not-verified" }) }
    }
  };
  const base = (candidate = discovery.candidates[0]) => ["exposure", "publish", "--project-dir", directory, "--source", "docker", "--docker-binding", "apps", "--docker-application", candidate.application, "--docker-endpoint", candidate.endpointId];
  return { adapters, config, state, save, files, writes, mutations, probes, preflights, dns, routes, forwards, base,
    publish: (extra = []) => runCli([...base(), ...extra], adapters),
    project: () => loadProject(filesystem, directory), discovery: () => discovery,
    refresh: (observations) => { refreshed = { ...normalizeDockerDiscovery(observations, "10.0.0.88"), diagnostics: [] }; }
  };
}

for (const proxy of ["caddy", "traefik"]) for (const protocol of ["https", "tcp", "smb"]) {
  test("Docker " + protocol + " reuses " + proxy + " lifecycle, host port, tailnet and persistence", async () => {
    const f = fixture(undefined, proxy);
    const result = await f.publish(["--yes", "--protocol", protocol, "--tailnet", "false", ...(protocol === "tcp" ? ["--listener-port", "15432"] : [])]);
    assert.equal(result.health.status, "healthy");
    const service = f.project().config.managedInventory.services[0];
    assert.equal(service.exposure.backend.ip, "10.0.0.88");
    assert.equal(Number(service.exposure.backend.port), 18080);
    assert.equal(service.exposure.protocol, protocol === "https" ? "https" : "tcp");
    assert.equal(service.exposure.tailnet, false);
    assert.ok(f.project().state.providerReferences[service.id]);
    assert.equal(f.project().config.managedInventory.dockerHosts.length, 1);
    assert.doesNotMatch(f.files.get(directory + "/nomina.yaml"), /containerId|endpointId|application:|networkMode/);
    assert.equal(f.probes[0].vmid, 101);
    assert.deepEqual(f.probes[0].command.args.slice(-2), ["10.0.0.88", "18080"]);
    assert.equal(f.probes[0].command.timeoutMs, 6000);
    assert.equal(f.routes.length, protocol === "https" ? 1 : 0);
    assert.equal(f.forwards.length, protocol === "https" ? 0 : 1);
    if (protocol === "smb") { assert.equal(Number(service.exposure.listenerPort), 445); assert.equal(service.exposure.preset, "smb"); assert.match(result.stdout, /Shares, credentials.*hostname alias.*Windows:/s); }
    if (protocol === "https") assert.equal(f.routes[0].backendTls, false);
  });
}

test("guided Compose and scripted selection have identical editable settings", async () => {
  const observations = [observed({ labels: { "com.docker.compose.project": "suite", "com.docker.compose.service": "web", "com.docker.compose.container-number": "2" } })];
  const guided = fixture(observations), questions = [], selections = [], messages = [];
  guided.adapters.prompts = {
    select: async ({ message, options }) => { selections.push({ message, options }); return message === "Exposure source" ? "docker" : message === "Exposure protocol" ? "tcp" : options[0].value; },
    ask: async (question, fallback) => { questions.push(question); return { "Service name": "SSH endpoint", "Full hostname": "ssh.home.test", "Backend IP": "10.0.0.99", "Backend port": "2222", "Client-facing TCP listener port": "12222" }[question] ?? fallback; },
    confirm: async ({ message }) => message === "Publish this reviewed exposure?", info: (message) => messages.push(message)
  };
  const result = await runCli(["exposure", "publish", "--project-dir", directory], guided.adapters);
  const scripted = fixture(observations);
  scripted.adapters.prompts = { ask: () => { throw new Error("Script prompted"); }, select: () => { throw new Error("Script prompted"); }, confirm: () => { throw new Error("Script prompted"); } };
  const other = await scripted.publish(["--yes", "--name", "SSH endpoint", "--hostname", "ssh.home.test", "--protocol", "tcp", "--backend-ip", "10.0.0.99", "--backend-port", "2222", "--listener-port", "12222", "--tailnet", "false"]);
  assert.deepEqual(result.managedService.exposure, other.managedService.exposure);
  assert.match(selections.find((entry) => entry.message === "Docker application").options[0].hint, /Compose/);
  assert.ok(questions.includes("Backend IP") && questions.includes("Backend port") && questions.includes("Client-facing TCP listener port"));
  assert.match(messages.join("\n"), /explicit override/);
  assert.equal(guided.probes[0].command.args.at(-2), "10.0.0.99");
});

test("unknown protocols require explicit choice; evidence-based hints and backend TLS remain editable", async () => {
  const f = fixture([observed({ image: "custom/server:latest" })]);
  await assert.rejects(f.publish(["--yes"]), /Unknown Docker application protocol/);
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.writes, []);
  for (const args of [["custom/nginx:latest", 80, "tcp"], ["nginx:latest", 8000, "tcp"], ["nginx:latest", 80, "udp"]]) assert.equal(dockerConnectionHint(...args).protocol, "unknown");
  assert.equal(dockerConnectionHint("lscr.io/linuxserver/openssh-server:latest", 2222, "tcp").protocol, "tcp");
  const tls = fixture([observed({ ports: { "443/tcp": [{ HostIp: "10.0.0.88", HostPort: "18443" }] } })]);
  const reviewed = await tls.publish(["--review-only"]);
  assert.equal(reviewed.options.protocol, "https"); assert.equal(reviewed.options.backendTls, true);
  assert.match(reviewed.stdout, /Application evidence: Allowlisted image nginx, application port 443\/tcp/);
  assert.match(reviewed.stdout, /Backend TLS: HTTPS; separate from client-facing HTTPS/);
  const changed = await tls.publish(["--yes", "--protocol", "tcp"]);
  assert.equal(changed.managedService.exposure.backend.tls, undefined);
});

test("duplicate tuples collapse; standalone ports and replicas retain distinct sanitized names", () => {
  const f = fixture([observed({ name: "/Odd App!!", ports: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "18080" }, { HostIp: "0.0.0.0", HostPort: "18080" }, { HostIp: "10.0.0.88", HostPort: "18080" }], "443/tcp": [{ HostIp: "0.0.0.0", HostPort: "18443" }] } }), observed({ id: "b".repeat(64), name: "/replica", labels: { "com.docker.compose.project": "suite", "com.docker.compose.service": "web" } })]);
  const candidates = f.discovery().candidates;
  assert.equal(candidates.length, 4);
  const names = candidates.map((candidate) => suggestDockerExposure(f.project(), candidate, candidates).hostname);
  assert.equal(new Set(names).size, 4);
  assert.ok(names.every((name) => name.endsWith(".home.test") && /^[a-z0-9.-]+$/.test(name)));
  const long = { ...candidates[0], application: "x".repeat(256) };
  assert.ok(suggestDockerExposure(f.project(), long, [long]).hostname.split(".")[0].length <= 63);
});

test("existing backend is advisory; distinct names work but implicit or explicit overwrite is blocked", async () => {
  const f = fixture();
  f.config.managedInventory.services.push({ id: "old", name: "old", exposure: { hostname: "web.home.test", protocol: "https", backend: { ip: "10.0.0.88", port: 18080 } } }); f.save();
  await assert.rejects(f.publish(["--yes", "--hostname", "WEB.home.test"]), /already exists/);
  assert.deepEqual(f.mutations, []);
  const next = await f.publish(["--yes"]);
  assert.equal(next.managedService.exposure.hostname, "web-2.home.test");
  assert.equal(f.project().config.managedInventory.services.length, 2);
  assert.equal(f.project().config.managedInventory.services[0].id, "old");
});

test("an explicitly selected Docker TCP exposure can share managed web DNS without replacing it", async () => {
  const f = fixture();
  f.config.managedInventory.services.push({ id: "web", name: "existing-ui", exposure: { hostname: "pve.home.test", protocol: "https", backend: { ip: "10.0.0.10", port: 8006 } } });
  f.dns.push({ id: "pve.home.test", record: "pve.home.test A 10.0.0.54" });
  f.save();
  const result = await f.publish(["--yes", "--name", "docker-files", "--hostname", "pve.home.test", "--protocol", "smb"]);
  assert.equal(result.managedService.exposure.preset, "smb");
  assert.equal(f.project().config.managedInventory.services.length, 2);
  assert.equal(f.project().config.managedInventory.services[0].id, "web");
  assert.equal(f.routes.length, 0);
});

test("Docker selections cannot enable host SSH even with explicit scripted flags", async () => {
  const f = fixture();
  await assert.rejects(f.publish(["--yes", "--protocol", "ssh"]), /Host SSH only targets/);
  assert.deepEqual(f.mutations, []);
});

test("review-only and cancellation do not mutate providers, configuration or tracking", async () => {
  const f = fixture(), reviewed = await f.publish(["--review-only"]);
  assert.equal(reviewed.reviewOnly, true); assert.match(reviewed.stdout, /No exposure published/);
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.writes, []);
  f.adapters.prompts = { ask: async (_question, fallback) => fallback, select: async ({ initialValue }) => initialValue, confirm: async () => false };
  const cancelled = await f.publish();
  assert.equal(cancelled.cancelled, true); assert.equal(f.probes.length, 1);
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.writes, []);
});

for (const change of [{ id: "b".repeat(64) }, { ports: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "18081" }] } }, { status: "exited" }, { networkMode: "host" }]) {
  test("stale " + JSON.stringify(change) + " preserves overrides and rejects publication", async () => {
    const f = fixture(); f.refresh([observed(change)]);
    await assert.rejects(f.publish(["--yes", "--backend-ip", "10.0.0.99", "--backend-port", "8888"]), /Refresh selection and review.*overrides were not retargeted/);
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.writes, []); assert.equal(f.probes.length, 0);
  });
}

test("disappeared endpoints and old scripted IDs require refreshed selection", async () => {
  const f = fixture(); f.refresh([]);
  await assert.rejects(f.publish(["--yes"]), /disappeared/);
  const next = fixture([observed({ id: "b".repeat(64) })]);
  await assert.rejects(runCli([...f.base(), "--yes"], next.adapters), /endpoint disappeared/);
  assert.deepEqual(next.mutations, []);
});

test("reachability failures and unavailable proxy context never claim readiness", async () => {
  const f = fixture(); f.adapters.proxmox.pctExec = async () => { throw new Error("PRIVATE diagnostics"); };
  await assert.rejects(f.publish(["--yes"]), (error) => { assert.ok(error instanceof Error); assert.match(error.message, /unreachable.*proxy LXC 101/); assert.doesNotMatch(error.message, /PRIVATE/); return true; });
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.writes, []);
  delete f.state.providerReferences.proxy.vmid; f.save();
  await assert.rejects(f.publish(["--yes"]), /reachability.*unavailable/);
});

for (const kind of ["dns", "route", "unmanaged route", "listener"]) test(kind + " conflicts precede all mutations", async () => {
  const f = fixture();
  if (kind === "dns") f.dns.push({ id: "WEB.home.test", record: "WEB.home.test CNAME other.home.test" });
  if (kind === "route") f.routes.push({ id: "web.home.test" });
  if (kind === "unmanaged route") f.routes.push({ id: "operator-route", match: [{ host: ["WEB.home.test"] }] });
  if (kind === "listener") f.adapters.providerAdapters.tcp.preflight = async () => { throw new Error("Listener collision"); };
  await assert.rejects(f.publish(["--yes", ...(kind === "listener" ? ["--protocol", "smb"] : [])]), /already has|collision/);
  assert.deepEqual(f.mutations, []); assert.deepEqual(f.writes, []);
});

for (const change of [{ ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] } }, { ports: { "53/udp": [{ HostIp: "0.0.0.0", HostPort: "5353" }] } }, { ports: {} }, { networkMode: "host" }, { networkDriver: "macvlan" }]) {
  test("unavailable " + JSON.stringify(change) + " explains manual fallback", async () => {
    const f = fixture([observed(change)]);
    await assert.rejects(f.publish(["--yes"]), /manual entry.*Docker networking will not be changed/is);
    assert.deepEqual(f.mutations, []); assert.deepEqual(f.writes, []);
  });
}

test("no bindings guides create/connect and permits cancellation or manual entry", async () => {
  const f = fixture(); f.config.managedInventory.dockerHosts = []; f.save();
  await assert.rejects(f.publish(["--yes"]), /nomina docker create.*nomina docker connect/);
  f.adapters.prompts = { info: () => {}, select: async () => "__cancel__" };
  const cancelled = await runCli(["exposure", "publish", "--source", "docker", "--project-dir", directory], f.adapters);
  assert.equal(cancelled.cancelled, true); assert.deepEqual(f.mutations, []);
  f.adapters.prompts = { select: async ({ message }) => message === "Exposure source" ? "manual" : "https", ask: async (question, fallback) => ({ "Service name": "manual", "Full hostname": "manual.home.test", "Backend IP": "10.0.0.9", "Backend port": "8080" }[question] ?? fallback), confirm: async () => false };
  const manual = await runCli(["exposure", "publish", "--project-dir", directory], f.adapters);
  assert.equal(manual.managedService.exposure.hostname, "manual.home.test"); assert.ok(!f.probes.some((probe) => probe.command.binary === "/usr/bin/timeout"));
});

test("unsupported backend addresses and SMB/listener settings cannot mutate providers", async () => {
  for (const ip of ["0.0.0.0", "::", "127.0.0.1", "224.0.0.1", "169.254.1.2", "fe80::1%eth0", "2001:db8::1%eth0", "0:0:0:0:0:ffff:192.168.1.2", "ff00::1"]) {
    const f = fixture(); assert.equal(usableAddress(ip), false);
    await assert.rejects(f.publish(["--yes", "--backend-ip", ip]), /Invalid backend|Backend address/);
    assert.deepEqual(f.mutations, []);
  }
  for (const flags of [["--protocol", "smb", "--listener-port", "1445"], ["--protocol", "tcp", "--listener-port", "22"], ["--protocol", "tcp", "--backend-tls"], ["--redirect-to", "home.test"]]) {
    const f = fixture(); await assert.rejects(f.publish(["--yes", ...flags])); assert.deepEqual(f.mutations, []); assert.deepEqual(f.writes, []);
  }
});

test("binding disconnection retains independent exposure identity and backend", async () => {
  const f = fixture(); await f.publish(["--yes"]);
  const exposure = f.project().config.managedInventory.services[0];
  await runCli(["docker", "disconnect", "apps", "--yes", "--project-dir", directory], f.adapters);
  assert.equal(f.project().config.managedInventory.dockerHosts.length, 0);
  assert.deepEqual(f.project().config.managedInventory.services[0], exposure);
});

test("unknown guided types have no default; web backend TLS can be edited independently", async () => {
  const f = fixture([observed({ image: "private/app" })]);
  let proposed;
  f.adapters.prompts = {
    ask: async (_question, fallback) => fallback,
    select: async ({ message, initialValue }) => {
      if (message === "Reviewed Docker exposure") return "publish";
      assert.equal(message, "Exposure protocol"); proposed = initialValue; return "https";
    },
    confirm: async ({ message }) => message.includes("HTTPS/TLS") || message === "Publish this reviewed exposure?"
  };
  const result = await f.publish();
  assert.equal(proposed, undefined);
  assert.equal(result.managedService.exposure.backend.tls, true);
  assert.equal(result.managedService.exposure.protocol, "https");
  const other = fixture([observed({ ports: { "443/tcp": [{ HostIp: "10.0.0.88", HostPort: "18443" }] } })]);
  const edited = await other.publish(["--yes", "--backend-tls", "false"]);
  assert.equal(edited.managedService.exposure.protocol, "https");
  assert.equal(edited.managedService.exposure.backend.tls, undefined);
});

test("truncated discovery is reported in scripted review and duplicate effective host ports collapse", async () => {
  const input = observed({ ports: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "18080" }, { HostIp: "0.0.0.0", HostPort: "018080" }] } });
  const f = fixture([input]);
  assert.equal(f.discovery().candidates.length, 1);
  f.discovery().truncated = true;
  f.discovery().diagnostics.push("Bounded discovery was incomplete.");
  const reviewed = await f.publish(["--review-only"]);
  assert.match(reviewed.stdout, /truncated or incomplete/);
  assert.match(reviewed.stdout, /Bounded discovery was incomplete/);
  assert.deepEqual(f.mutations, []);
});

test("guided SMB with explicit name/hostname/IP retains the Docker published backend port", async () => {
  const f = fixture([observed({ ports: { "445/tcp": [{ HostIp: "0.0.0.0", HostPort: "14445" }] } })]);
  f.adapters.prompts = {
    ask: async (_question, fallback) => fallback,
    confirm: async ({ message }) => message === "Publish this reviewed exposure?"
  };
  const result = await f.publish(["--protocol", "smb", "--name", "files", "--hostname", "files.home.test", "--backend-ip", "10.0.0.88"]);
  assert.equal(result.managedService.exposure.backend.port, 14445);
  assert.equal(result.managedService.exposure.listenerPort, 445);
});

test("no-binding and unavailable endpoint fallback can continue through manual publication", async () => {
  for (const bindings of [true, false]) {
    const f = fixture([observed({ ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] } })]);
    if (!bindings) { f.config.managedInventory.dockerHosts = []; f.save(); }
    f.adapters.prompts = {
      select: async ({ message }) => message === "Exposure protocol" ? "https" : "__manual__",
      ask: async (question, fallback) => ({ "Service name": "manual", "Full hostname": "manual.home.test", "Backend IP": "10.0.0.9", "Backend port": "8080" }[question] ?? fallback),
      confirm: async () => false, info: () => {}
    };
    const result = await f.publish();
    assert.equal(result.managedService.exposure.backend.ip, "10.0.0.9");
    assert.equal(result.managedService.exposure.hostname, "manual.home.test");
  }
});

/** Drive the real menu route through the production Clack adapter, including string-only text defaults. */
function exposureMenu(f, {
  source = "docker", protocol = "https", name = "Edited app", hostname = "edited.home.test",
  backendIp = "10.0.0.99", backendPort = "18888", backendTls = false, listenerPort = "15555",
  tailnet = false, redirectTo = undefined, redirectCode = 308, action = "publish"
} = {}) {
  const questions = [];
  f.adapters.prompts = createClackPrompts({
    isCancel: () => false,
    text: async ({ message, defaultValue }) => {
      assert.ok(defaultValue === undefined || typeof defaultValue === "string", "Clack text default must be a string");
      questions.push(message);
      const answers = { "Service name": name, "Full hostname": hostname, "Backend IP": backendIp, "Backend port": backendPort, "Client-facing TCP listener port": listenerPort, "Redirect target (e.g. home.bunny.internal)": redirectTo };
      return answers[message] ?? defaultValue ?? "";
    },
    select: async ({ message, options, initialValue }) => {
      questions.push(message);
      if (message === "Reviewed Docker exposure") assert.equal(initialValue, "cancel");
      const value = { "Exposure source": source, "Exposure protocol": protocol, "Redirect status code": redirectCode, "Reviewed Docker exposure": action }[message] ?? options[0].value;
      assert.ok(options.some((option) => option.value === value));
      return value;
    },
    confirm: async ({ message }) => {
      questions.push(message);
      return message.includes("Tailscale") ? tailnet : message.includes("HTTPS/TLS") ? backendTls : message.startsWith("Is this a redirect") ? redirectTo !== undefined : false;
    },
    log: { info: () => {}, warn: () => {} }
  });
  f.adapters.interactive = { chooseAction: async () => "publish-exposure" };
  f.adapters.runCommand = (args, adapters) => runCli(args, adapters);
  f.adapters.tracking.run = () => { f.mutations.push("menu-tracking"); };
  return { run: () => runInteractiveApp(f.adapters), questions };
}

const parityCases = [
  { label: "Docker HTTP backend defaults", backendIp: "", backendPort: "" },
  { label: "Docker HTTPS backend and tailnet", privatePort: 443, backendTls: true, tailnet: true },
  { label: "Docker HTTPS hint changed to HTTP", privatePort: 443, backendTls: false },
  { label: "Docker generic TCP listener and tailnet", protocol: "tcp", tailnet: true },
  { label: "Docker unknown HTTPS", image: "custom/server", backendTls: true },
  { label: "Docker unknown TCP", image: "custom/server", protocol: "tcp" },
  { label: "Docker unknown SMB nonstandard host port", image: "custom/server", protocol: "smb", privatePort: 445, hostPort: 14445 },
  { label: "Docker hinted SMB", image: "ghcr.io/servercontainers/samba", protocol: "smb", privatePort: 445, hostPort: 14445 },
  { label: "manual HTTPS from a nested project directory", source: "manual", nestedProject: true },
  { label: "manual backend TLS and tailnet", source: "manual", backendTls: true, tailnet: true },
  { label: "manual generic TCP custom listener", source: "manual", protocol: "tcp" },
  { label: "manual SMB nonstandard backend", source: "manual", protocol: "smb", backendPort: "14445" },
  { label: "manual 307 redirect", source: "manual", redirectTo: "target.home.test", redirectCode: 307 },
  { label: "manual 308 redirect", source: "manual", redirectTo: "target.home.test", redirectCode: 308 }
];

for (const options of parityCases) test(options.label + " has menu/flag parity through Clack and the real CLI", async () => {
  const protocol = options.protocol ?? "https", source = options.source ?? "docker";
  const observation = observed({ image: options.image ?? "nginx:alpine", ports: { [(options.privatePort ?? 80) + "/tcp"]: [{ HostIp: "0.0.0.0", HostPort: String(options.hostPort ?? 18080) }] } });
  const guided = fixture([observation]), scripted = fixture([observation]);
  if (options.nestedProject) guided.adapters.cwd = directory + "/nested/child";
  const menu = exposureMenu(guided, options);
  const result = await menu.run();
  const args = source === "docker" ? scripted.base() : ["exposure", "publish", "--source", "manual", "--project-dir", directory];
  args.push("--yes", "--protocol", protocol, "--name", "Edited app", "--hostname", "edited.home.test", "--tailnet", String(options.tailnet ?? false));
  if (options.redirectTo) args.push("--redirect-to", options.redirectTo, "--redirect-code", String(options.redirectCode));
  else {
    args.push("--backend-ip", options.backendIp === "" ? "10.0.0.88" : "10.0.0.99", "--backend-port", options.backendPort === "" ? String(options.hostPort ?? 18080) : options.backendPort ?? "18888", "--backend-tls", String(options.backendTls ?? false));
    if (protocol !== "https") args.push("--listener-port", protocol === "smb" ? "445" : "15555");
  }
  const other = await runCli(args, scripted.adapters);
  assert.deepEqual(result.managedService.exposure, other.managedService.exposure);
  assert.deepEqual(guided.probes, scripted.probes);
  assert.deepEqual(guided.preflights, scripted.preflights);
  assert.deepEqual(guided.mutations.filter((entry) => entry !== "menu-tracking"), scripted.mutations);
  if (source === "docker") assert.ok(menu.questions.includes("Docker host binding") && menu.questions.includes("Docker application") && menu.questions.includes("Published Docker endpoint") && menu.questions.includes("Reviewed Docker exposure"));
  if (protocol === "tcp") assert.ok(menu.questions.includes("Client-facing TCP listener port"));
  if (protocol === "smb") assert.ok(!menu.questions.includes("Client-facing TCP listener port"));
});

for (const protocol of ["https", "tcp", "smb"]) for (const action of ["review-only", "cancel"]) test("menu Docker " + protocol + " " + action + " preserves providers/configuration/tracking", async () => {
  const f = fixture();
  const before = new Map(f.files);
  const menu = exposureMenu(f, { action, protocol });
  const result = await menu.run();
  assert.equal(action === "review-only" ? result.reviewOnly : result.cancelled, true);
  assert.deepEqual(f.files, before);
  assert.deepEqual(f.mutations, []);
  assert.equal(f.probes.length, action === "review-only" ? 1 : 0);
  if (action === "review-only") {
    const scripted = fixture();
    const other = await scripted.publish(["--review-only", "--protocol", protocol, "--name", "Edited app", "--hostname", "edited.home.test", "--backend-ip", "10.0.0.99", "--backend-port", "18888", "--backend-tls", "false", "--tailnet", "false", ...(protocol !== "https" ? ["--listener-port", protocol === "smb" ? "445" : "15555"] : [])]);
    for (const key of ["name", "hostname", "protocol", "backendIp", "backendPort", "backendTls", "listenerPort", "preset", "tailnet"]) assert.equal(result.options[key], other.options[key], key);
    assert.deepEqual(f.probes, scripted.probes);
    assert.deepEqual(f.preflights, scripted.preflights);
    assert.equal(f.preflights.length, protocol === "https" ? 0 : 1);
  }
});

for (const path of ["no binding", "unavailable endpoint", "application fallback"]) test(path + " keeps supplied manual fields", async () => {
  const f = fixture([observed({ ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] } })]);
  if (path === "no binding") { f.config.managedInventory.dockerHosts = []; f.save(); }
  f.adapters.prompts = {
    select: async () => "__manual__",
    ask: async () => { throw new Error("Supplied field was prompted again"); },
    confirm: async () => false, info: () => {}
  };
  const args = path === "application fallback" ? ["exposure", "publish", "--source", "docker", "--docker-binding", "apps", "--project-dir", directory] : f.base();
  const result = await runCli([...args, "--name", "Manual override", "--hostname", "override.home.test", "--protocol", "tcp", "--backend-ip", "10.0.0.99", "--backend-port", "12222", "--listener-port", "13333", "--tailnet", "false"], f.adapters);
  assert.equal(result.managedService.name, "Manual override");
  assert.equal(result.managedService.exposure.hostname, "override.home.test");
  assert.deepEqual(result.managedService.exposure.backend, { ip: "10.0.0.99", port: 12222 });
  assert.equal(result.managedService.exposure.listenerPort, 13333);
  assert.equal(result.managedService.exposure.tailnet, false);
  assert.equal(f.probes.length, 0);
});

for (const mode of ["menu", "flags"]) for (const conflict of ["reserved port", "existing exposure", "provider listener"]) test(mode + " readiness review rejects " + conflict + " without writes", async () => {
  const f = fixture();
  let listenerPort = "15555";
  if (conflict === "reserved port") listenerPort = "22";
  if (conflict === "existing exposure") {
    f.config.managedInventory.services.push({ id: "old-tcp", name: "old", exposure: { hostname: "old.home.test", protocol: "tcp", listenerPort: 15555, backend: { ip: "10.0.0.88", port: 18080 } } }); f.save();
  }
  if (conflict === "provider listener") f.adapters.providerAdapters.tcp.preflight = async () => { throw new Error("Listener collision"); };
  const before = new Map(f.files);
  const run = mode === "menu" ? exposureMenu(f, { protocol: "tcp", listenerPort, action: "review-only" }).run : () => f.publish(["--review-only", "--protocol", "tcp", "--listener-port", listenerPort]);
  await assert.rejects(run(), /reserved|conflicts|collision/);
  assert.deepEqual(f.files, before);
  assert.deepEqual(f.mutations, []);
});

for (const protocol of ["https", "tcp", "smb"]) for (const source of [undefined, "manual"]) test("manual " + protocol + " --yes suppresses installed prompts with " + (source ?? "inferred source"), async () => {
  const f = fixture();
  f.adapters.prompts = { ask: () => { throw new Error("Unexpected text prompt"); }, select: () => { throw new Error("Unexpected selection"); }, confirm: () => { throw new Error("Unexpected confirmation"); } };
  const args = ["exposure", "publish", "--project-dir", directory, "--yes", "--name", "manual", "--hostname", "manual.home.test", "--protocol", protocol, "--backend-ip", "10.0.0.99"];
  if (source) args.push("--source", source);
  if (protocol !== "smb") args.push("--backend-port", "18888");
  const result = await runCli(args, f.adapters);
  assert.equal(result.managedService.exposure.protocol, protocol === "smb" ? "tcp" : protocol);
  assert.equal(result.managedService.exposure.backend.port, protocol === "smb" ? 445 : 18888);
  assert.equal(result.managedService.exposure.tailnet, true);
  assert.ok(!f.probes.some((probe) => probe.command.binary === "/usr/bin/timeout"));
});

for (const field of ["name", "hostname", "backend-ip", "backend-port"]) test("manual --yes reports missing " + field + " without prompts or mutations", async () => {
  const f = fixture();
  f.adapters.prompts = { ask: () => { throw new Error("Unexpected text prompt"); }, select: () => { throw new Error("Unexpected selection"); }, confirm: () => { throw new Error("Unexpected confirmation"); } };
  const fields = { name: "manual", hostname: "manual.home.test", "backend-ip": "10.0.0.99", "backend-port": "18888" };
  const args = ["exposure", "publish", "--project-dir", directory, "--source", "manual", "--yes"];
  for (const [key, value] of Object.entries(fields)) if (key !== field) args.push("--" + key, value);
  await assert.rejects(runCli(args, f.adapters), /is required/);
  assert.deepEqual(f.mutations, []);
  assert.deepEqual(f.writes, []);
});

test("manual --yes supports redirects without prompting for a backend", async () => {
  const f = fixture();
  f.adapters.prompts = { ask: () => { throw new Error("Unexpected text prompt"); }, select: () => { throw new Error("Unexpected selection"); }, confirm: () => { throw new Error("Unexpected confirmation"); } };
  const result = await runCli(["exposure", "publish", "--project-dir", directory, "--source", "manual", "--yes", "--name", "redirect", "--hostname", "redirect.home.test", "--redirect-to", "target.home.test", "--redirect-code", "307", "--tailnet", "false"], f.adapters);
  assert.deepEqual(result.managedService.exposure.redirect, { to: "https://target.home.test", code: 307 });
  assert.equal(result.managedService.exposure.backend, undefined);
});
