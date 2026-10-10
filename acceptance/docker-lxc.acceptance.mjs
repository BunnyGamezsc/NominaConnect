import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runCli } from "../src/cli.js";
import { createCommandRunner, createProductionAdapters } from "../src/adapter-runtime.js";
import { serializeProjectConfiguration, loadProject } from "../src/config.js";
import { acquireProjectLock } from "../src/project-lock.js";

const env = process.env;
const required = ["NOMINA_DOCKER_ACCEPTANCE_NODE", "NOMINA_DOCKER_ACCEPTANCE_IP", "NOMINA_DOCKER_ACCEPTANCE_GATEWAY", "NOMINA_DOCKER_ACCEPTANCE_RESOLVER", "NOMINA_DOCKER_ACCEPTANCE_STORAGE", "NOMINA_DOCKER_ACCEPTANCE_BRIDGE"];
const unavailable = env.NOMINA_DOCKER_ACCEPTANCE !== "1" ? "Set NOMINA_DOCKER_ACCEPTANCE=1 on the Ethernet test host. This creates and retains a separate Docker CT."
  : process.getuid?.() !== 0 || !fs.existsSync("/usr/sbin/pct") ? "Root Proxmox shell unavailable."
  : required.some((key) => !env[key]) ? `Missing required test environment: ${required.filter((key) => !env[key]).join(", ")}` : undefined;

test("live Docker creation, resumable setup, read-only connection/discovery and binding-only disconnect", { skip: unavailable, timeout: 1200000 }, async () => {
  const directory = env.NOMINA_DOCKER_ACCEPTANCE_PROJECT ?? fs.mkdtempSync(path.join(os.tmpdir(), "nomina-docker-acceptance-"));
  fs.chmodSync(directory, 0o700);
  const filesystem = {
    exists: fs.existsSync, read: (file) => fs.readFileSync(file, "utf8"),
    writeFile: fs.writeFileSync, rename: fs.renameSync, chmod: fs.chmodSync, acquireProjectLock
  };
  const trace = [];
  const runner = createCommandRunner();
  const commandRunner = { run: async (command) => { trace.push({ binary: command.binary, args: command.args }); return runner.run(command); } };
  const production = createProductionAdapters({ commandRunner });
  await production.proxmox.assertLocalNode(env.NOMINA_DOCKER_ACCEPTANCE_NODE);
  const initialLxcs = await production.proxmox.listLxcs();
  const resuming = fs.existsSync(path.join(directory, "nomina.yaml")) ? loadProject(filesystem, directory) : undefined;
  const existingBinding = resuming?.config.managedInventory.dockerHosts?.find((host) => host.name === "acceptance" && host.origin === "created");
  const existingVmid = existingBinding ? resuming.state.providerReferences[existingBinding.id]?.vmid : undefined;
  if (resuming && (!existingBinding || !existingVmid)) throw new Error("Acceptance project has no recorded created Docker CT to resume. Do not rerun creation blindly; inspect its evidence and state.");
  const digest = (content) => createHash("sha256").update(content).digest("hex");
  const baseline = new Map();
  for (const ct of initialLxcs) {
    if (ct.vmid === existingVmid) continue;
    const config = await runner.run({ binary: "/usr/sbin/pct", args: ["config", String(ct.vmid)] });
    baseline.set(ct.vmid, { status: ct.status, digest: digest(config.stdout) });
  }
  const seed = (projectDirectory) => {
    fs.mkdirSync(path.join(projectDirectory, ".nomina"), { recursive: true, mode: 0o700 });
    const config = {
      proxmox: { node: env.NOMINA_DOCKER_ACCEPTANCE_NODE, defaultBridge: env.NOMINA_DOCKER_ACCEPTANCE_BRIDGE, defaultStorage: env.NOMINA_DOCKER_ACCEPTANCE_STORAGE },
      baseLocalDomain: "docker-acceptance.test",
      managedInventory: {
        platform: { dns: { id: "existing-dns", service: "technitium" }, reverseProxy: null, certificateAuthority: null, vpn: null },
        services: [{ id: "independent-exposure", name: "independent", exposure: { hostname: "independent.docker-acceptance.test", backend: { ip: env.NOMINA_DOCKER_ACCEPTANCE_IP, port: 8080 }, protocol: "https" } }]
      }, connectionSecretReferences: {}
    };
    fs.writeFileSync(path.join(projectDirectory, "nomina.yaml"), serializeProjectConfiguration(config));
    fs.writeFileSync(path.join(projectDirectory, ".nomina/state.json"), JSON.stringify({ providerReferences: { "existing-dns": { ip: env.NOMINA_DOCKER_ACCEPTANCE_RESOLVER } }, tracking: { notices: [] } }), { mode: 0o600 });
  };
  if (!resuming) seed(directory);
  const adapters = {
    ...production, filesystem, cwd: directory,
    runtime: { isRoot: () => true, isProxmoxHost: () => true }, tracking: { start: () => {} }
  };
  let vmid;
  const report = { directory, host: env.NOMINA_DOCKER_ACCEPTANCE_NODE, ip: env.NOMINA_DOCKER_ACCEPTANCE_IP, priorVmids: [...baseline.keys()], retained: true, checks: {} };
  try {
    // Interrupt only our installation call, after the real pct create and
    // durable VMID write. Retry must use that actual CT, never another VMID.
    let interrupted = false;
    const interruptingProxmox = { ...production.proxmox, pctExec: async (ct, command) => {
      if (command.binary === "/bin/sh" && !interrupted) { interrupted = true; throw new Error("Acceptance fixture: setup interruption after CT creation"); }
      return production.proxmox.pctExec(ct, command);
    } };
    if (!resuming) await assert.rejects(runCli(["docker", "create", "--name", "acceptance", "--ip", env.NOMINA_DOCKER_ACCEPTANCE_IP, "--gateway", env.NOMINA_DOCKER_ACCEPTANCE_GATEWAY, "--prefix-length", env.NOMINA_DOCKER_ACCEPTANCE_PREFIX ?? "24", "--cpus", env.NOMINA_DOCKER_ACCEPTANCE_CPUS ?? "2", "--memory", env.NOMINA_DOCKER_ACCEPTANCE_MEMORY ?? "2048", "--disk", env.NOMINA_DOCKER_ACCEPTANCE_DISK ?? "32", "--yes"], { ...adapters, proxmox: interruptingProxmox }), /pending.*Docker installation/);
    let project = loadProject(filesystem, directory);
    const binding = project.config.managedInventory.dockerHosts[0];
    vmid = project.state.providerReferences[binding.id].vmid;
    report.vmid = vmid;
    assert.equal(baseline.has(vmid), false);
    if (project.state.dockerHostStates[binding.id].status !== "healthy") {
      assert.equal(project.state.dockerHostStates[binding.id].status, "pending");
      const resumed = await runCli(["docker", "retry", "acceptance", "--yes"], adapters);
      assert.equal(resumed.providerReference.vmid, vmid);
      assert.equal(resumed.health.status, "healthy");
    }
    assert.equal(trace.filter((command) => command.binary === "/usr/sbin/pct" && command.args[0] === "create").length, resuming ? 0 : 1);
    report.checks.resumableCreation = "passed";
    const config = await runner.run({ binary: "/usr/sbin/pct", args: ["config", String(vmid)] });
    assert.match(config.stdout, /^unprivileged: 1$/m);
    assert.match(config.stdout, /^features: .*keyctl=1/m);
    assert.match(config.stdout, /^features: .*nesting=1/m);
    assert.doesNotMatch(config.stdout, /lxc.apparmor.profile: unconfined/);
    report.checks.defaultConfinementAndFeatures = "passed";

    const docker = (args, stdin) => production.proxmox.pctExec(vmid, { binary: "/usr/bin/docker", args: ["--host", "unix:///var/run/docker.sock", ...args], timeoutMs: 180000, ...(stdin ? { stdin } : {}) });
    await docker(["volume", "create", "acceptance-data"]);
    await docker(["run", "--detach", "--name", "standalone", "--publish", "0.0.0.0:8080:80/tcp", "--publish", "127.0.0.1:8081:80/tcp", "--publish", "0.0.0.0:5353:53/udp", "--mount", "type=volume,src=acceptance-data,dst=/data", "--env", "ACCEPTANCE_PRIVATE_VALUE=must-not-appear-in-discovery", "nginx:alpine"]);
    await docker(["compose", "--project-name", "acceptance", "--file", "-", "up", "--detach"], "services:\n  web:\n    image: nginx:alpine\n    ports:\n      - '80'\n    deploy:\n      replicas: 2\n");
    await docker(["create", "--name", "stopped", "--publish", "8090:80", "nginx:alpine"]);
    await docker(["run", "--detach", "--name", "host-network", "--network", "host", "nginx:alpine", "sleep", "1800"]);
    const snapshot = async () => {
      const result = await production.proxmox.pctExec(vmid, { binary: "/bin/sh", args: ["-s"], stdin: "set -eu\n{ docker ps -aq --no-trunc | sort | xargs -r docker inspect; docker network ls -q --no-trunc | sort | xargs -r docker network inspect; docker volume ls -q | sort | xargs -r docker volume inspect; if [ -f /etc/docker/daemon.json ]; then cat /etc/docker/daemon.json; fi; } | sha256sum\n", timeoutMs: 30000, maxOutputBytes: 1024 });
      const ct = await runner.run({ binary: "/usr/sbin/pct", args: ["config", String(vmid)] });
      return { docker: result.stdout.trim(), ct: digest(ct.stdout) };
    };
    const before = await snapshot();
    const attachedDirectory = path.join(directory, "attachment");
    seed(attachedDirectory);
    const attached = { ...adapters, cwd: attachedDirectory };
    const start = trace.length;
    await runCli(["docker", "connect", "--name", "attached", "--vmid", String(vmid), "--yes"], attached);
    const discovery = (await runCli(["docker", "inspect", "attached", "--json"], attached)).discovery;
    assert.equal(discovery.truncated, false);
    assert.ok(discovery.candidates.some((candidate) => candidate.name === "standalone" && candidate.hostPort === 8080 && candidate.backendAddress === report.ip && candidate.selectable));
    assert.ok(discovery.candidates.some((candidate) => candidate.name === "standalone" && candidate.hostPort === 8081 && !candidate.selectable && candidate.reasons.some((reason) => reason.includes("Loopback"))));
    assert.ok(discovery.candidates.some((candidate) => candidate.transport === "udp" && !candidate.selectable));
    const replicas = discovery.containers.filter((container) => container.application === "acceptance/web");
    assert.equal(replicas.length, 2);
    assert.notEqual(replicas[0].instance, replicas[1].instance);
    assert.ok(discovery.candidates.some((candidate) => candidate.name === "stopped" && !candidate.selectable));
    assert.ok(discovery.candidates.some((candidate) => candidate.networkMode === "host" && !candidate.selectable));
    assert.doesNotMatch(JSON.stringify(discovery), /must-not-appear-in-discovery|ACCEPTANCE_PRIVATE_VALUE/);
    const exposureBefore = loadProject(filesystem, attachedDirectory).config.managedInventory.services;
    await runCli(["docker", "disconnect", "attached", "--yes"], attached);
    assert.deepEqual(loadProject(filesystem, attachedDirectory).config.managedInventory.services, exposureBefore);
    const readCommands = trace.slice(start);
    assert.ok(readCommands.every((command) => command.binary === "/usr/bin/hostname" || command.binary === "/usr/sbin/pct" && ["config", "status", "exec"].includes(command.args[0])));
    assert.ok(readCommands.filter((command) => command.args[0] === "exec").every((command) => ["/usr/bin/test", "/usr/bin/stat", "/usr/bin/readlink", "/usr/bin/env"].includes(command.args[3])));
    assert.deepEqual(await snapshot(), before);
    report.checks.readOnlyAttachmentAndDisconnect = "passed";
    report.checks.publishedEndpointsAndReplicas = "passed";
    await runCli(["docker", "disconnect", "acceptance", "--yes"], adapters);
    assert.equal(await production.proxmox.lxcStatus(vmid), "running");
    report.checks.retainedCreatedCT = "passed";
  } catch (error) {
    report.failure = error.message;
    throw error;
  } finally {
    // No cleanup destroys/stops a CT or removes an application. All created
    // resources and the project remain inspectable, including after failure.
    const after = await production.proxmox.listLxcs();
    for (const [ct, original] of baseline) {
      const current = await runner.run({ binary: "/usr/sbin/pct", args: ["config", String(ct)] });
      assert.equal(digest(current.stdout), original.digest, `Existing CT ${ct} configuration changed`);
      assert.equal(after.find((entry) => entry.vmid === ct)?.status, original.status, `Existing CT ${ct} status changed`);
    }
    report.checks.existingCTPreservation = "passed";
    fs.writeFileSync(path.join(directory, "evidence.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(`Docker acceptance evidence and retained project: ${directory}. LXC ${vmid ?? "not allocated"} retained.`);
  }
});
