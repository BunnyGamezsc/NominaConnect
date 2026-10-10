import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../src/cli.js";
import { loadProject, parseProjectConfiguration, serializeProjectConfiguration } from "../src/config.js";
import { createProductionAdapters, createCommandRunner } from "../src/adapter-runtime.js";
import { createDockerAdapter, DOCKER_INSTALL_SCRIPT, validateDockerSocket, validateDockerVmid } from "../src/docker-adapter.js";
import { normalizeDockerDiscovery, DOCKER_LIMITS } from "../src/docker-discovery.js";
import { validateDockerDeployment } from "../src/docker-hosts.js";
import { updateProject } from "../src/project-write.js";
import { runTrackingJob } from "../src/tracking.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireProjectLock } from "../src/project-lock.js";

const directory = "/docker-test";
const id = "a".repeat(64);
class Filesystem {
  files = new Map();
  modes = new Map();
  exists = (path) => this.files.has(path);
  read = (path) => this.files.get(path);
  writeFile = (path, content) => { this.files.set(path, content); };
  rename = (from, to) => { this.files.set(to, this.files.get(from)); this.files.delete(from); if (this.modes.has(from)) { this.modes.set(to, this.modes.get(from)); this.modes.delete(from); } };
  chmod = (path, mode) => { this.modes.set(path, mode); };
}
function fixture() {
  const filesystem = new Filesystem();
  const config = {
    proxmox: { node: "pve", defaultBridge: "vmbr0", defaultStorage: "local-lvm" }, baseLocalDomain: "home.test",
    managedInventory: {
      platform: { dns: { id: "dns", service: "technitium" }, reverseProxy: null, certificateAuthority: null, vpn: null },
      services: [{ id: "exposure", name: "old", exposure: { hostname: "old.home.test", backend: { ip: "10.0.0.2", port: 80 }, protocol: "https" } }]
    }, connectionSecretReferences: {}
  };
  filesystem.writeFile(`${directory}/nomina.yaml`, serializeProjectConfiguration(config));
  filesystem.writeFile(`${directory}/.nomina/state.json`, JSON.stringify({ providerReferences: { dns: { ip: "10.0.0.53" }, exposure: { hostname: "old.home.test" } }, tracking: { notices: [] } }));
  const calls = [];
  let nextVmid = 120;
  const createdSpecs = new Map();
  const proxmox = {
    assertLocalNode: async (node) => { assert.equal(node, "pve"); },
    listTemplates: async () => ["local:vztmpl/debian-12-standard_12.tar.zst", "local:vztmpl/debian-13-standard_13.1-1_amd64.tar.zst"],
    validateProvisioningPrerequisites: async (spec) => { calls.push(["validate", spec]); },
    validateDockerResources: async (spec) => { calls.push(["resources", spec]); },
    checkIpAvailability: async () => ({ status: "uncertain", reason: "external devices unknown" }),
    createLxc: async (spec, hooks) => {
      calls.push(["create", spec]);
      const created = { vmid: nextVmid++ };
      createdSpecs.set(created.vmid, spec);
      await hooks.onAllocated(created);
      await hooks.onCreated(created);
      return created;
    },
    inspectLxc: async (vmid) => { calls.push(["config", vmid]); const spec = createdSpecs.get(vmid); return { ip: "10.0.0.88", hostname: spec?.hostname ?? "existing", unprivileged: spec ? true : false }; },
    listLxcs: async () => [{ vmid: 120, hostname: "existing", status: "running" }],
    lxcStatus: async () => "running",
    enableDockerFeatures: async (vmid) => { calls.push(["features", vmid]); },
    startLxc: async (vmid) => { calls.push(["start", vmid]); },
    pctExec: async (vmid, command) => {
      calls.push(["exec", vmid, command]);
      if (command.binary === "/usr/bin/stat") return { stdout: "0\n" };
      if (command.binary === "/usr/bin/readlink") return { stdout: command.args.at(-1).replace(/^\/var\/run\//, "/run/") };
      if (command.args.includes("info")) return { stdout: '["name=seccomp,profile=builtin"]' };
      if (command.args.includes("ps")) return { stdout: `${id}\n` };
      if (command.args.includes("container")) return { stdout: JSON.stringify(observation()) };
      if (command.args.includes("network")) return { stdout: '"bridge" null null' };
      return { stdout: "ok" };
    }
  };
  const adapters = { filesystem, cwd: directory, runtime: { isRoot: () => true, isProxmoxHost: () => true }, proxmox, retryOptions: { maxRetries: 0, baseDelayMs: 0 }, tracking: { start: () => {} } };
  return { adapters, filesystem, calls, project: () => loadProject(filesystem, directory), proxmox };
}
function observation(overrides = {}) {
  return {
    id, name: "/app", image: "nginx:stable", imageId: "sha256:" + "b".repeat(64), status: "running", networkMode: "default",
    labels: { "com.docker.compose.project": "suite", "com.docker.compose.service": "web", "com.docker.compose.container-number": "1", "secret": "do-not-show" },
    ports: { "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }] }, exposedPorts: { "80/tcp": {}, "443/tcp": {} }, ...overrides
  };
}
const createArgs = ["docker", "create", "--name", "apps", "--ip", "10.0.0.88", "--yes"];

test("old configuration loads unchanged; Docker visible configuration round trips without provider references", async () => {
  const f = fixture();
  const old = f.project().config;
  assert.equal(old.managedInventory.dockerHosts, undefined);
  assert.deepEqual(parseProjectConfiguration(serializeProjectConfiguration(old)), old);
  await runCli(createArgs, f.adapters);
  const project = f.project();
  const hosts = project.config.managedInventory.dockerHosts;
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].deployment.resources.diskGb, "32");
  assert.equal(hosts[0].deployment.nameserver, "10.0.0.53");
  assert.equal(hosts[0].deployment.prefixLength, "24");
  const yaml = f.filesystem.read(project.configPath);
  assert.doesNotMatch(yaml, /vmid|providerReference|containerId/);
  assert.deepEqual(parseProjectConfiguration(serializeProjectConfiguration(project.config)), project.config);
  assert.equal(f.filesystem.modes.get(project.statePath), 0o600);
});

test("creation enables features in its spec before install, with editable resources/networking", async () => {
  const f = fixture();
  const result = await runCli([...createArgs, "--cpus", "3", "--memory", "3072", "--disk", "40", "--prefix-length", "22", "--gateway", "10.0.0.1", "--nameserver", "10.0.0.9", "--bridge", "vmbr1", "--storage", "fast"], f.adapters);
  const spec = f.calls.find((call) => call[0] === "create")[1];
  assert.equal(spec.template, "local:vztmpl/debian-13-standard_13.1-1_amd64.tar.zst");
  assert.equal(spec.features, "nesting=1,keyctl=1");
  assert.equal(spec.deferStart, true);
  assert.equal(spec.unprivileged, true);
  assert.deepEqual(spec.resources, { cpus: 3, memoryMb: 3072, diskGb: 40 });
  assert.equal(spec.bridge, "vmbr1");
  assert.equal(spec.prefixLength, 22);
  assert.equal(result.health.status, "healthy");
  assert.match(result.stdout, /external devices unknown/);
  assert.ok(f.calls.some((call) => call[0] === "exec" && call[2].args.includes("compose")));
  assert.ok(f.calls.some((call) => call[0] === "exec" && call[2].args.includes("buildx")));
  assert.match(DOCKER_INSTALL_SCRIPT, /download\.docker\.com/);
  assert.doesNotMatch(DOCKER_INSTALL_SCRIPT, /apt-get (?:dist-)?upgrade|daemon\.json|apparmor|prune/);
});

test("installation failure persists VMID immediately and retry resumes it without duplicate creation", async () => {
  const f = fixture();
  const original = f.proxmox.pctExec;
  const setupError = new Error("PRIVATE ENV token=supersecret");
  f.proxmox.pctExec = async (vmid, command) => {
    if (command.binary === "/bin/sh") {
      const host = f.project().config.managedInventory.dockerHosts[0];
      assert.equal(f.project().state.providerReferences[host.id].vmid, vmid);
      throw setupError;
    }
    return original(vmid, command);
  };
  await assert.rejects(runCli(createArgs, f.adapters), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /pending.*Docker installation.*LXC 120/);
    assert.doesNotMatch(error.message, /supersecret/);
    assert.equal(error.cause, setupError);
    return true;
  });
  const host = f.project().config.managedInventory.dockerHosts[0];
  assert.equal(f.project().state.dockerHostStates[host.id].status, "pending");
  f.proxmox.pctExec = original;
  await runCli(["docker", "retry", "apps", "--yes"], f.adapters);
  assert.equal(f.calls.filter((call) => call[0] === "create").length, 1);
  assert.equal(f.project().config.managedInventory.dockerHosts[0].id, host.id);
  assert.equal(f.project().state.providerReferences[host.id].vmid, 120);
  assert.equal(f.project().state.dockerHostStates[host.id].status, "healthy");
  await assert.rejects(runCli(["docker", "retry", "apps", "--yes"], f.adapters), /already complete/);
});

test("allocation and recovery lock failures preserve both errors without claiming a saved VMID", async () => {
  const f = fixture();
  const setupError = new Error("allocation write lock timed out");
  const recoveryError = new Error("recovery write lock timed out");
  let writes = 0;
  const acquireProjectLock = async (_directory, operation) => {
    if (operation === "docker-operation") return () => {};
    writes += 1;
    if (writes === 2) throw setupError;
    if (writes === 3) throw recoveryError;
    return () => {};
  };
  const adapters = { ...f.adapters, filesystem: { ...f.filesystem, acquireProjectLock } };
  await assert.rejects(runCli(createArgs, adapters), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [setupError, recoveryError]);
    assert.match(error.message, /setup failed during creation; pending state could not be saved/);
    assert.match(error.message, /Check project storage and Proxmox manually/);
    assert.doesNotMatch(error.message, /uses the recorded VMID|nomina docker retry/);
    return true;
  });
  const host = f.project().config.managedInventory.dockerHosts[0];
  assert.equal(f.project().state.providerReferences[host.id], undefined);
  assert.equal(f.project().state.dockerHostStates[host.id].status, "pending");
  assert.equal(f.calls.filter((call) => call[0] === "create").length, 1);
  assert.equal(f.calls.some((call) => ["features", "start", "exec"].includes(call[0])), false);
});

test("failed create retains reserved VMID and missing CT is never silently replaced", async () => {
  const f = fixture();
  f.proxmox.createLxc = async (spec, hooks) => { await hooks.onAllocated({ vmid: 125 }); throw new Error("interrupted"); };
  await assert.rejects(runCli(createArgs, f.adapters), /pending.*LXC 125/);
  const host = f.project().config.managedInventory.dockerHosts[0];
  assert.equal(f.project().state.providerReferences[host.id].vmid, 125);
  f.proxmox.inspectLxc = async () => { throw new Error("missing"); };
  f.proxmox.createLxc = async () => { assert.fail("must not create replacement"); };
  await assert.rejects(runCli(["docker", "retry", "apps", "--yes"], f.adapters), /LXC verification.*LXC 125/);
  assert.equal(f.project().state.dockerHostStates[host.id].status, "pending");
});

test("connect is a read-only rootful attachment that accepts an existing privileged LXC", async () => {
  const f = fixture();
  const result = await runCli(["docker", "connect", "--name", "existing", "--vmid", "120", "--socket", "/run/custom/docker.sock", "--yes"], f.adapters);
  assert.equal(result.health.unprivileged, false);
  assert.match(result.stdout, /full daemon authority/);
  assert.equal(f.calls.some((call) => ["create", "features", "start"].includes(call[0])), false);
  const commands = f.calls.filter((call) => call[0] === "exec").map((call) => call[2]);
  assert.ok(commands.every((command) => ["/usr/bin/test", "/usr/bin/stat", "/usr/bin/readlink", "/usr/bin/env"].includes(command.binary)));
  const info = commands.find((command) => command.args.includes("info"));
  assert.ok(info.args.includes("unix:///run/custom/docker.sock"));
  assert.deepEqual(info.args.slice(0, 2), ["-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin"]);
  await assert.rejects(runCli(["docker", "retry", "existing", "--yes"], f.adapters), /read-only/);
});

test("multiple unique bindings keep IDs stable, reject duplicate tuples and names", async () => {
  const f = fixture();
  await runCli(["docker", "connect", "--name", "one", "--vmid", "120", "--yes"], f.adapters);
  const first = f.project().config.managedInventory.dockerHosts[0].id;
  await runCli(["docker", "connect", "--name", "two", "--vmid", "121", "--yes"], f.adapters);
  await assert.rejects(runCli(["docker", "connect", "--name", "three", "--vmid", "120", "--yes"], f.adapters), /already bound/);
  await assert.rejects(runCli(["docker", "connect", "--name", "one", "--vmid", "122", "--yes"], f.adapters), /already in use/);
  const list = await runCli(["docker", "list", "--json"], f.adapters);
  assert.equal(list.hosts.length, 2);
  assert.equal(list.hosts.find((host) => host.name === "one").id, first);
});

test("disconnect retains CT/applications and exposures and requires no Proxmox access", async () => {
  const f = fixture();
  await runCli(createArgs, f.adapters);
  const before = f.project();
  const count = f.calls.length;
  const result = await runCli(["docker", "disconnect", "apps", "--yes"], { ...f.adapters, proxmox: undefined, runtime: undefined });
  assert.match(result.stdout, /independently managed/);
  assert.equal(f.calls.length, count);
  assert.deepEqual(f.project().config.managedInventory.services, before.config.managedInventory.services);
  assert.deepEqual(f.project().state.providerReferences.exposure, before.state.providerReferences.exposure);
  assert.deepEqual(f.project().config.managedInventory.dockerHosts, []);
  assert.deepEqual(f.project().state.dockerHostStates, {});
});

test("guided create/connect/inspect/retry/disconnect use shared commands and cancellation never claims health", async () => {
  const f = fixture();
  const answers = { "Docker binding name": "guided", "Requested Docker LXC static IPv4 address": "10.0.0.88" };
  f.adapters.prompts = {
    ask: async (message, fallback) => answers[message] ?? fallback,
    select: async ({ options }) => options[0].value,
    confirm: async () => false, warn: () => {}
  };
  const result = await runCli(["docker", "create"], f.adapters);
  assert.equal(result.cancelled, true);
  assert.equal(f.calls.some((call) => call[0] === "create"), false);
  assert.equal(f.project().config.managedInventory.dockerHosts, undefined);
  f.adapters.prompts.confirm = async () => true;
  await runCli(["docker", "connect"], f.adapters);
  const inspection = await runCli(["docker", "inspect"], f.adapters);
  assert.equal(inspection.discovery.candidates[0].hostPort, 8080);
  f.adapters.prompts.confirm = async () => false;
  assert.equal((await runCli(["docker", "disconnect"], f.adapters)).cancelled, true);
  assert.equal(f.project().config.managedInventory.dockerHosts.length, 1);
});

test("stopped, rootless and non-root socket attachments fail without saving", async () => {
  for (const mode of ["stopped", "rootless", "nonroot"]) {
    const f = fixture();
    if (mode === "stopped") f.proxmox.lxcStatus = async () => "stopped";
    else {
      const original = f.proxmox.pctExec;
      f.proxmox.pctExec = async (vmid, command) => {
        if (mode === "rootless" && command.args.includes("info")) return { stdout: '["name=rootless"]' };
        if (mode === "nonroot" && command.binary === "/usr/bin/stat") return { stdout: "1000" };
        return original(vmid, command);
      };
    }
    await assert.rejects(runCli(["docker", "connect", "--name", "bad", "--vmid", "120", "--yes"], f.adapters), /running|rootful|Rootless/);
    assert.equal(f.project().config.managedInventory.dockerHosts, undefined);
    assert.equal(f.calls.some((call) => ["create", "start", "features"].includes(call[0])), false);
  }
});

test("discovery preserves effective tuples, EXPOSE distinction, replicas and safe fields", () => {
  const observed = observation({
    name: "/app\u001b[31m", ports: {
      "80/tcp": [{ HostIp: "0.0.0.0", HostPort: "8080" }, { HostIp: "192.168.1.8", HostPort: "8081" }, { HostIp: "::", HostPort: "8080" }],
      "53/udp": [{ HostIp: "0.0.0.0", HostPort: "5353" }], "22/tcp": [{ HostIp: "127.0.0.1", HostPort: "2222" }]
    }, environment: ["PASSWORD=secret"]
  });
  const replica = observation({ id: "c".repeat(64), labels: { ...observed.labels, "com.docker.compose.container-number": "2" } });
  const result = normalizeDockerDiscovery([observed, replica], "10.0.0.88");
  assert.equal(result.candidates.length, 6);
  assert.deepEqual(result.containers[0].exposedPorts, ["80/tcp", "443/tcp"]);
  assert.equal(result.candidates[0].backendAddress, "10.0.0.88");
  assert.equal(result.candidates[1].backendAddress, "192.168.1.8");
  assert.equal(result.candidates[2].selectable, false);
  assert.equal(result.candidates[2].backendAddress, undefined);
  assert.match(result.candidates[3].reasons.join(" "), /UDP/);
  assert.match(result.candidates[4].reasons.join(" "), /Loopback/);
  assert.equal(result.candidates[0].application, result.candidates[5].application);
  assert.notEqual(result.candidates[0].instance, result.candidates[5].instance);
  assert.equal(result.candidates[0].connectionTypeHint, "unknown");
  assert.doesNotMatch(JSON.stringify(result), /PASSWORD|secret|\u001b/);
});

test("stopped/no-public-port/host/direct-network remain visible with explicit reasons", () => {
  /** @type {Array<[object, RegExp]>} */
  const cases = [
    [{ status: "exited", ports: { "80/tcp": null } }, /exited.*No public port/s],
    [{ networkMode: "host", ports: {} }, /Host networking/],
    [{ networkMode: "none", ports: {} }, /EXPOSE metadata/],
    [{ networkDriver: "macvlan" }, /Directly addressed/],
    [{ directRouting: true }, /Directly addressed/],
    [{ networkUnknown: true }, /reachability could not be inspected/]
  ];
  for (const [overrides, reason] of cases) {
    const result = normalizeDockerDiscovery([observation(overrides)], "10.0.0.88");
    assert.equal(result.candidates[0].selectable, false);
    assert.match(result.candidates[0].reasons.join(" "), reason);
  }
  const standalone = normalizeDockerDiscovery([observation({ labels: {}, name: "/standalone" })], "10.0.0.88");
  assert.equal(standalone.candidates[0].application, "standalone");
});

test("normalization bounds fields, container count and total endpoints", () => {
  const result = normalizeDockerDiscovery(Array.from({ length: 101 }, () => observation({ name: "x".repeat(400) })), "10.0.0.88");
  assert.equal(result.containers.length, 100);
  assert.equal(result.containers[0].name.length, 256);
  assert.equal(result.truncated, true);
  const many = observation({ ports: { "80/tcp": Array.from({ length: 501 }, () => ({ HostIp: "0.0.0.0", HostPort: "8080" })) } });
  assert.equal(normalizeDockerDiscovery([many], "10.0.0.88").candidates.length, 500);
  assert.equal(normalizeDockerDiscovery([many], "10.0.0.88").truncated, true);
});

test("command input rejects injection/traversal, invalid VMIDs, templates and networking", async () => {
  for (const socket of ["tcp://host:2375", "relative.sock", "/run/../docker.sock", "/run/docker.sock;id", "/run/a$(id).sock", "/run/a\n.sock", "/run//docker.sock"]) assert.throws(() => validateDockerSocket(socket), /absolute/);
  for (const vmid of ["120;id", "-1", "1e3", "NaN", "12.5", "99"]) assert.throws(() => validateDockerVmid(vmid), /VMID/);
  const f = fixture();
  for (const extra of [["--cpus", "NaN"], ["--disk", "0"], ["--bridge", "vmbr0,tag=2"], ["--ip", "10.0.0.0"], ["--gateway", "10.1.0.1"], ["--prefix-length", "32"], ["--template", "debian-12-standard"], ["--hostname", "a;id"]]) {
    const replaced = createArgs.filter((value, index, array) => !extra.includes(value) && !extra.includes(array[index - 1]));
    await assert.rejects(runCli([...replaced, ...extra], f.adapters));
  }
  assert.equal(f.calls.some((call) => call[0] === "create"), false);
  assert.equal(f.project().config.managedInventory.dockerHosts, undefined);
});

test("production feature setup preserves unrelated feature flags and is never used by connect", async () => {
  const commands = [];
  const { proxmox } = createProductionAdapters({ commandRunner: { run: async (command) => {
    commands.push(command);
    if (command.args[0] === "config") return { stdout: "features: fuse=1,mount=nfs;ext4,nesting=0,keyctl=0\nunprivileged: 0\n" };
    if (command.args[0] === "status") return { stdout: "status: running" };
    return { stdout: "ok" };
  } } });
  await proxmox.enableDockerFeatures(120);
  const set = commands.find((command) => command.args[0] === "set");
  assert.equal(set.args.at(-1), "fuse=1,mount=nfs;ext4,nesting=1,keyctl=1");
  assert.equal(commands.some((command) => command.args.includes("--unprivileged")), false);
});

test("production adapter records allocation/creation before later execution and preserves security defaults", async () => {
  const commands = [];
  const events = [];
  const { proxmox } = createProductionAdapters({ commandRunner: { run: async (command) => {
    commands.push(command);
    if (command.binary === "/usr/bin/pvesh") return { stdout: "130" };
    if (command.binary === "/usr/sbin/pvesm") return { stdout: "Name Type Status\nlocal-lvm lvmthin active\nlocal dir active\n" };
    if (command.binary === "/usr/bin/pveam") return { stdout: "local:vztmpl/debian-13-standard_13.1-1_amd64.tar.zst\n", exitCode: 0 };
    if (command.binary === "/usr/bin/grep") return { stdout: "root:100000:65536", exitCode: 0 };
    if (command.args[0] === "create") events.push("create");
    return { stdout: "", exitCode: 0 };
  } } });
  await proxmox.createLxc({ node: "pve", hostname: "docker-apps", ip: "10.0.0.88", gateway: "10.0.0.1", nameserver: "10.0.0.53", prefixLength: 22, bridge: "vmbr0", storage: "local-lvm", template: "debian-13-standard", resources: { cpus: 2, memoryMb: 2048, diskGb: 32 }, unprivileged: true, features: "nesting=1,keyctl=1", deferStart: true }, {
    onAllocated: async () => { events.push("allocated"); }, onCreated: async () => { events.push("recorded"); }
  });
  assert.deepEqual(events, ["allocated", "create", "recorded"]);
  const create = commands.find((command) => command.args[0] === "create");
  assert.equal(create.args.at(-1), "0");
  assert.ok(create.args.includes("nesting=1,keyctl=1"));
  assert.ok(create.args.some((value) => value.includes("ip=10.0.0.88/22")));
  assert.equal(create.args[create.args.indexOf("--unprivileged") + 1], "1");
  assert.doesNotMatch(JSON.stringify(commands), /apparmor|unconfined|upgrade/);
});

test("production discovery uses only allowlisted inspect projection and bounds retries/truncation", async () => {
  const f = fixture();
  let attempts = 0;
  const original = f.proxmox.pctExec;
  f.proxmox.pctExec = async (vmid, command) => {
    if (command.args.includes("ps")) return { stdout: `${id}\n` + Array.from({ length: 100 }, () => "c".repeat(64)).join("\n"), truncated: true };
    if (command.args.includes("container") && command.args.at(-1) !== id) { attempts += 1; throw new Error("CREDENTIAL=secret"); }
    return original(vmid, command);
  };
  const docker = createDockerAdapter(f.proxmox, { maxRetries: 1, baseDelayMs: 0 });
  const result = await docker.discover(120, "/var/run/docker.sock");
  assert.equal(result.truncated, true);
  assert.equal(attempts, 99 * 2);
  assert.doesNotMatch(JSON.stringify(result), /CREDENTIAL|secret/);
  const inspect = f.calls.find((call) => call[0] === "exec" && call[2].args.includes("container"))[2];
  assert.doesNotMatch(inspect.args.join(" "), /\.Env|\.Mounts|\.Config\.Labels}}/);
  assert.equal(inspect.maxOutputBytes, DOCKER_LIMITS.outputBytes);
  assert.equal(inspect.timeoutMs, 10000);
});

test("command runner caps real output and explicitly reports discovery truncation", async () => {
  const runner = createCommandRunner();
  const command = { binary: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(10000))"], maxOutputBytes: 1000 };
  await assert.rejects(runner.run(command), /exited/);
  const result = await runner.run({ ...command, truncateOutput: true });
  assert.equal(result.stdout.length, 1000);
  assert.equal(result.truncated, true);
});

test("concurrent queued configuration updates retain independent managed inventory fields", async () => {
  const f = fixture();
  await Promise.all([
    updateProject(f.filesystem, directory, (project) => { project.config.managedInventory.dockerHosts = [{ id: "docker", name: "apps", origin: "connected", socketPath: "/run/docker.sock" }]; return project; }),
    updateProject(f.filesystem, directory, (project) => { project.state.tracking.notices.push({ summary: "tracking" }); return project; })
  ]);
  assert.equal(f.project().config.managedInventory.dockerHosts[0].id, "docker");
  assert.equal(f.project().state.tracking.notices[0].summary, "tracking");
});

test("tracking adoption retains binding written while provider inspection is in flight", async () => {
  const f = fixture();
  let inspected = () => {};
  const inFlight = new Promise((resolve) => { inspected = () => resolve(undefined); });
  let resume = () => {};
  const wait = new Promise((resolve) => { resume = () => resolve(undefined); });
  const tracking = runTrackingJob({ filesystem: f.filesystem, projectDir: directory, providerAdapters: { technitium: {
    inspect: async () => { inspected(); await wait; throw new Error("unavailable"); }
  } }, retryOptions: { maxRetries: 0 } });
  await inFlight;
  await runCli(["docker", "connect", "--name", "apps", "--vmid", "120", "--yes"], f.adapters);
  resume();
  await tracking;
  assert.equal(f.project().config.managedInventory.dockerHosts[0].name, "apps");
  assert.ok(f.project().state.tracking.notices.length > 0);
});

test("concurrent creates cannot allocate duplicate hosts with the same binding name", async () => {
  const f = fixture();
  const results = await Promise.allSettled([runCli(createArgs, f.adapters), runCli(createArgs, f.adapters)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(f.calls.filter((call) => call[0] === "create").length, 1);
  assert.equal(f.project().config.managedInventory.dockerHosts.length, 1);
});

test("Unix socket aliases cannot produce duplicate node/VMID/socket bindings", async () => {
  const f = fixture();
  await runCli(["docker", "connect", "--name", "original", "--vmid", "120", "--yes"], f.adapters);
  await assert.rejects(runCli(["docker", "connect", "--name", "alias", "--vmid", "120", "--socket", "/run/docker.sock", "--yes"], f.adapters), /already bound/);
});

test("retry refuses a VMID reused for a different CT without modifying it", async () => {
  const f = fixture();
  const exec = f.proxmox.pctExec;
  f.proxmox.pctExec = async (vmid, command) => { if (command.binary === "/bin/sh") throw new Error("partial install"); return exec(vmid, command); };
  await assert.rejects(runCli(createArgs, f.adapters));
  const count = f.calls.length;
  f.proxmox.inspectLxc = async () => ({ hostname: "unrelated", ip: "10.0.0.99", unprivileged: false });
  await assert.rejects(runCli(["docker", "retry", "apps", "--yes"], f.adapters), /LXC verification/);
  assert.equal(f.calls.length, count);
});

test("project locks serialize processes and recover a recorded dead owner after interruption", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "nomina-lock-test-"));
  fs.mkdirSync(path.join(temporary, ".nomina"));
  try {
    const lock = path.join(temporary, ".nomina/write.lock");
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 2147483647, token: "dead" }));
    const release = await acquireProjectLock(temporary);
    assert.equal(JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).pid, process.pid);
    let secondEntered = false;
    const second = acquireProjectLock(temporary).then((unlock) => { secondEntered = true; unlock(); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(secondEntered, false);
    release();
    await second;
    assert.equal(fs.existsSync(lock), false);
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});

test("nuclear uninstall never stops or destroys connected or created Docker-bound CTs", async () => {
  const f = fixture();
  await runCli(createArgs, f.adapters);
  await runCli(["docker", "connect", "--name", "existing", "--vmid", "121", "--yes"], f.adapters);
  await updateProject(f.filesystem, directory, (project) => {
    project.state.providerReferences.dns.vmid = 101;
    project.state.retainedServices = { alias: { vmid: 120 } };
    // Model a config/state replacement interrupted after config was written.
    project.config.managedInventory.dockerHosts = project.config.managedInventory.dockerHosts.filter((host) => host.name !== "existing");
    return project;
  });
  const stopped = [];
  const destroyed = [];
  const adapters = {
    ...f.adapters, proxmox: {
      ...f.proxmox, stopLxc: async (vmid) => { stopped.push(vmid); }, destroyLxc: async (vmid) => { destroyed.push(vmid); }
    }, filesystem: {
      ...f.filesystem, deletePath: (target) => { for (const key of f.filesystem.files.keys()) if (key === target || key.startsWith(`${target}/`)) f.filesystem.files.delete(key); }
    }
  };
  const result = await runCli(["uninstall", "--project-dir", directory, "--yes"], adapters);
  assert.deepEqual(stopped, [101]);
  assert.deepEqual(destroyed, [101]);
  assert.match(result.stdout, /Retained Docker LXC\(s\): 120, 121/);
});
