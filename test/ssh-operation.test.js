import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliInvocation, createSshOperationController, isManagedSshSession, runSshOperationWorker } from "../src/ssh-operation.js";

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

test("only managed SSH connections require handoff and workers never recurse", () => {
  assert.equal(isManagedSshSession({ SSH_CONNECTION: "10.0.0.1 12345 192.168.1.10 22222" }), true);
  assert.equal(isManagedSshSession({ SSH_CONNECTION: "10.0.0.1 12345 192.168.1.10 22" }), false);
  assert.equal(isManagedSshSession({}), false);
  assert.equal(isManagedSshSession({ SSH_CONNECTION: "10.0.0.1 12345 192.168.1.10 22222", NOMINA_SSH_OPERATION_WORKER: "1" }), false);
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
