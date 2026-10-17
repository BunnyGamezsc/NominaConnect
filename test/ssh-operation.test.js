import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliInvocation, createSshOperationController, isManagedSshSession, runSshOperationWorker } from "../src/ssh-operation.js";

/** Isolate root-owned operation artifacts and capture commands without starting systemd. */
function lab(t, run = async (_command) => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomina-ssh-operation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filesystem = /** @type {typeof fs} */ (/** @type {unknown} */ ({ ...fs, lstatSync(target) { const stat = fs.lstatSync(target); return Object.assign(stat, { uid: 0 }); } }));
  const calls = [], notices = [];
  const controller = createSshOperationController({ filesystem, directory: path.join(root, "operations"),
    invocation: ["/usr/bin/node", "/opt/nomina/bin/nomina.js"], environment: { SSH_CONNECTION: "10.0.0.1 12345 192.168.1.10 22222" },
    commandRunner: { async run(command) { calls.push(command); return run(command); } }, announce: (message) => notices.push(message) });
  return { root, filesystem, controller, calls, notices };
}

/** Model a managed login whose sudo/su shell has lost SSH_CONNECTION. */
function elevatedSession({ managed = true, unreadable = false, cycle = false, missing = false, unsafe = false, malformed = false } = {}) {
  const files = {
    "/run/nomina-host-ssh.pid": "100\n",
    "/proc/500/stat": malformed ? "invalid" : "500 (nomina) R 400 500 500 0",
    "/proc/400/stat": `400 (sudo (or su)) S ${cycle ? 500 : 300} 400 400 0`,
    "/proc/300/stat": `300 (shell) S ${managed ? 200 : 1} 300 300 0`,
    "/proc/200/stat": "200 (sshd: user) S 100 200 200 0"
  };
  const filesystem = /** @type {typeof fs} */ (/** @type {unknown} */ ({
    ...fs,
    /** Supply owned PID-file metadata or simulate its absence before ancestry inspection. */
    lstatSync() {
      if (missing) throw Object.assign(new Error("No managed daemon"), { code: "ENOENT" });
      return { isSymbolicLink: () => false, isFile: () => true, uid: 0, mode: unsafe ? 0o666 : 0o644 };
    },
    /** Return deterministic daemon/parent records without consulting the host's processes. */
    readFileSync(file) {
      if (unreadable || files[file] === undefined) throw Object.assign(new Error("Process information unavailable"), { code: "EACCES" });
      return files[file];
    }
  }));
  return { filesystem, pid: 500, platform: /** @type {const} */ ("linux") };
}

test("sudo and su managed sessions still require handoff without SSH environment variables", () => {
  const options = elevatedSession();
  assert.equal(isManagedSshSession({}, options), true);
  assert.equal(isManagedSshSession({ SSH_CONNECTION: "10.0.0.1 12345 192.168.1.10 22" }, options), true);
  assert.equal(isManagedSshSession({ NOMINA_SSH_OPERATION_WORKER: "1" }, options), false);
  assert.equal(isManagedSshSession({}, elevatedSession({ managed: false })), false);
});

test("uncertain process ancestry blocks inline disruption instead of guessing it is safe", () => {
  assert.throws(() => isManagedSshSession({}, elevatedSession({ unreadable: true })), /SSH session/);
  assert.throws(() => isManagedSshSession({}, elevatedSession({ cycle: true })), /SSH session/);
  assert.throws(() => isManagedSshSession({}, elevatedSession({ malformed: true })), /SSH session/);
  assert.throws(() => isManagedSshSession({}, elevatedSession({ unsafe: true })), /SSH session/);
});

test("absent managed daemon and non-Linux consoles do not require handoff", () => {
  assert.equal(isManagedSshSession({}, elevatedSession({ missing: true })), false);
  assert.equal(isManagedSshSession({}, { ...elevatedSession({ unreadable: true }), platform: "darwin" }), false);
  assert.equal(isManagedSshSession({ NOMINA_SSH_OPERATION_WORKER: "1" }, elevatedSession({ unreadable: true })), false);
});

test("only managed SSH connections require handoff and workers never recurse", () => {
  const options = elevatedSession({ missing: true });
  assert.equal(isManagedSshSession({ SSH_CONNECTION: "10.0.0.1 12345 192.168.1.10 22222" }, options), true);
  assert.equal(isManagedSshSession({ SSH_CONNECTION: "10.0.0.1 12345 192.168.1.10 22" }, options), false);
  assert.equal(isManagedSshSession({}, options), false);
  assert.equal(isManagedSshSession({ SSH_CONNECTION: "10.0.0.1 12345 192.168.1.10 22222", NOMINA_SSH_OPERATION_WORKER: "1" }, options), false);
  assert.deepEqual(cliInvocation("/usr/bin/node", ["node", "/opt/nomina/bin/nomina.js"]), ["/usr/bin/node", "/opt/nomina/bin/nomina.js"]);
  assert.deepEqual(cliInvocation("/usr/local/bin/nomina", ["nomina", "/$bunfs/root/bin/nomina.js"]), ["/usr/local/bin/nomina"]);
});

test("controller schedules the complete command with independent stdio and private durable status", async (t) => {
  const { controller, calls, notices } = lab(t);
  const args = ["ssh", "replace-key", "--output", "/root/replacement key", "--project-dir", "/root/project"];
  const result = await controller.launch({ args, projectDirectory: "/root/project" });
  assert.equal(result.detached, true);
  assert.equal(calls[0].binary, "systemd-run");
  assert.deepEqual(calls[0].args.slice(-args.length), args);
  for (const flag of ["--on-active=2s", "--property=StandardInput=null", "--setenv=NOMINA_SSH_OPERATION_WORKER=1"]) assert.ok(calls[0].args.includes(flag));
  assert.ok(calls[0].args.includes(`--property=StandardOutput=append:${result.operation.log}`));
  for (const file of [result.operation.status, result.operation.log]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(result.operation.status, "utf8")).state, "scheduled");
  assert.match(notices[0], /managed SSH sessions may disconnect/);
});

test("worker records success and failure even after the command removes its project", async (t) => {
  for (const fail of [false, true]) {
    const { controller, filesystem, root } = lab(t);
    const { operation } = await controller.launch({ args: ["uninstall", "--yes"], projectDirectory: root });
    const project = path.join(root, "project");
    fs.mkdirSync(project);
    /** Simulate a command that deletes its project before either succeeding or failing. */
    const run = async () => { fs.rmdirSync(project); if (fail) throw new Error("provider removal failed"); return { stdout: "done" }; };
    const options = { filesystem, environment: { NOMINA_SSH_OPERATION_WORKER: "1", NOMINA_SSH_OPERATION_STATUS: operation.status } };
    if (fail) await assert.rejects(runSshOperationWorker(run, options), /provider removal failed/);
    else assert.equal((await runSshOperationWorker(run, options)).stdout, "done");
    const status = JSON.parse(fs.readFileSync(operation.status, "utf8"));
    assert.equal(status.state, fail ? "failed" : "succeeded");
    if (fail) assert.match(status.detail, /provider removal failed/);
  }
});

test("launch failure is recorded and unsafe operation directories are preserved", async (t) => {
  const fixture = lab(t, async () => { throw new Error("systemd unavailable"); });
  await assert.rejects(fixture.controller.launch({ args: ["ssh", "disable"], projectDirectory: fixture.root }), /systemd unavailable/);
  const status = fs.readdirSync(path.join(fixture.root, "operations")).find((name) => name.endsWith(".json"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.root, "operations", status), "utf8")).state, "failed");
  const unsafe = lab(t);
  fs.mkdirSync(path.join(unsafe.root, "foreign"));
  fs.symlinkSync(path.join(unsafe.root, "foreign"), path.join(unsafe.root, "operations"));
  await assert.rejects(unsafe.controller.launch({ args: ["ssh", "disable"], projectDirectory: unsafe.root }), /safe root-owned directory/);
  assert.equal(unsafe.calls.length, 0);
  assert.deepEqual(fs.readdirSync(path.join(unsafe.root, "foreign")), []);
});
