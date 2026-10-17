import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProxySshAdapter } from "../src/proxy-ssh-adapter.js";

const execute = promisify(execFile);
const request = { vmid: 121, ip: "192.168.1.54" };
const SHIM = `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), name = path.basename(process.argv[1]);
const file = process.env.SSH_STATE, root = process.env.SSH_ROOT;
const state = JSON.parse(fs.readFileSync(file));
const service = root + '/systemd/system/ssh.service.d/nomina-host-ssh.conf';
const socket = root + '/systemd/system/ssh.socket.d/nomina-host-ssh.conf';
const moved = fs.existsSync(service);
let status = 0;
if (name === 'stat') console.log(args[1] === '%u' ? '0' : (fs.statSync(args[2]).mode & 511).toString(8));
if (name === 'ss') {
  const query = args.at(-1), port = moved ? 22223 : 22;
  if ((state.service || state.socket) && query.endsWith(':' + port)) console.log('LISTEN 0 4096 ' + (moved ? '192.168.1.54:' : '*:') + port + ' *:* users:(("' + (state.foreign ? 'python3' : 'sshd') + '",pid=154,fd=3))');
  if (state.occupied && query.endsWith(':22223')) console.log('LISTEN 0 128 *:22223 *:* users:(("other",pid=200,fd=3))');
}
if (name === 'sshd' && args.includes('-T')) console.log('listenaddress 192.168.1.54:22223');
if (name === 'systemctl') {
  state.calls.push(args);
  if (args[0] === 'cat') console.log('ExecStart=' + process.env.SSH_BINARY + ' -D $SSHD_OPTS');
  if (args[0] === 'show' && args.includes('--property=FragmentPath')) console.log('/lib/systemd/system/ssh.service');
  if (args[0] === 'show' && args.includes('--property=DropInPaths')) {
    for (const p of [service, socket]) if (fs.existsSync(p)) console.log(p);
    if (state.override) console.log('/operator/override.conf');
  }
  if (args[0] === 'is-active') status = state[args.at(-1).split('.')[1]] ? 0 : 1;
  if (args[0] === 'stop') for (const unit of args.slice(1)) state[unit.split('.')[1]] = false;
  if (args[0] === 'start') {
    if (state.failStart && moved) { state.failStart = false; status = 1; }
    else state[args[1].split('.')[1]] = true;
  }
}
fs.writeFileSync(file, JSON.stringify(state));
process.exit(status);
`;

function lab(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomina-proxy-ssh-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"), config = path.join(root, "etc"), stateFile = path.join(root, "state.json");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(config, "systemd/system"), { recursive: true });
  fs.mkdirSync(path.join(config, "default"));
  fs.mkdirSync(path.join(config, "ssh/sshd_config.d"), { recursive: true });
  fs.writeFileSync(path.join(config, "ssh/sshd_config"), `Include ${config}/ssh/sshd_config.d/*.conf\n#Match User anoncvs\n`);
  fs.writeFileSync(path.join(config, "default/ssh"), 'SSHD_OPTS=""\n');
  for (const name of ["sshd", "ss", "systemctl", "stat"]) fs.writeFileSync(path.join(bin, name), SHIM, { mode: 0o755 });
  fs.writeFileSync(stateFile, JSON.stringify({ service: true, socket: true, calls: [] }));
  const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const change = (values) => fs.writeFileSync(stateFile, JSON.stringify({ ...state(), ...values }));
  const adapter = createProxySshAdapter({ exec: async (_vmid, command) => {
    const script = command.args[1].replaceAll("/etc/nominaconnect", `${config}/nominaconnect`)
      .replaceAll("/etc/systemd/system", `${config}/systemd/system`)
      .replaceAll("/etc/default/ssh", `${config}/default/ssh`)
      .replaceAll("/etc/ssh", `${config}/ssh`)
      .replaceAll("/usr/sbin/sshd", `${bin}/sshd`);
    return execute("/bin/bash", ["-c", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SSH_STATE: stateFile, SSH_ROOT: config, SSH_BINARY: `${bin}/sshd` } });
  } });
  return { adapter, config, state, change };
}

test("stock socket-activated proxy SSH relocates privately and restores its original active states", async (t) => {
  const { adapter, config, state } = lab(t);
  assert.equal(await adapter.preflight(request), "relocate");
  assert.ok(!fs.existsSync(path.join(config, "nominaconnect")), "preflight makes no writes");
  await adapter.prepare(request);
  assert.equal(await adapter.preflight(request), "managed");
  assert.match(fs.readFileSync(path.join(config, "systemd/system/ssh.socket.d/nomina-host-ssh.conf"), "utf8"), /ListenStream=192.168.1.54:22223/);
  assert.ok(state().service && state().socket);
  assert.ok(!state().calls.some((args) => ["enable", "disable", "mask"].includes(args[0])));
  await adapter.restore(request);
  await adapter.restore(request);
  assert.equal(await adapter.preflight(request), "relocate");
  assert.ok(!fs.existsSync(path.join(config, "nominaconnect/proxy-ssh")));
  assert.ok(state().service && state().socket);
});

test("proxy SSH preserves inactive socket state and leaves an empty port untouched", async (t) => {
  const { adapter, state, change } = lab(t);
  change({ socket: false });
  await adapter.prepare(request);
  await adapter.restore(request);
  assert.ok(state().service);
  assert.equal(state().socket, false);
  change({ service: false });
  assert.equal(await adapter.preflight(request), "clear");
  assert.equal(await adapter.prepare(request), false);
});

test("proxy SSH refuses operator overrides, other processes, occupied administration and custom options before writes", async (t) => {
  for (const conflict of [{ foreign: true }, { occupied: true }, { override: true }, { customOptions: true }]) {
    const fixture = lab(t);
    fixture.change(conflict);
    if (conflict.customOptions) fs.writeFileSync(path.join(fixture.config, "default/ssh"), 'SSHD_OPTS="-p 22"\n');
    await assert.rejects(fixture.adapter.prepare(request));
    assert.ok(!fs.existsSync(path.join(fixture.config, "nominaconnect")));
    assert.ok(fixture.state().service && fixture.state().socket);
  }
});

test("failed proxy SSH migration restores administration and edited owned drop-ins are preserved", async (t) => {
  const { adapter, config, state, change } = lab(t);
  change({ failStart: true });
  await assert.rejects(adapter.prepare(request));
  assert.equal(await adapter.preflight(request), "relocate");
  assert.ok(state().service && state().socket);
  await adapter.prepare(request);
  const file = path.join(config, "systemd/system/ssh.service.d/nomina-host-ssh.conf");
  fs.appendFileSync(file, "Environment=OPERATOR=1\n");
  await assert.rejects(adapter.restore(request));
  assert.match(fs.readFileSync(file, "utf8"), /OPERATOR=1/);
});

test("proxy SSH rejects conditional authentication and custom includes before relocation writes", async (t) => {
  for (const [filename, content] of [
    ["sshd_config", "Match LocalPort 22\n  PasswordAuthentication no\n"],
    ["sshd_config.d/conditional.conf", "mAtCh LocalAddress 192.168.1.54\n  PermitRootLogin prohibit-password\n"],
    ["sshd_config", "Include /operator/ssh.conf\n"],
    ["sshd_config.d/nested.conf", "Include /etc/ssh/sshd_config.d/*.conf\n"]
  ]) {
    const fixture = lab(t);
    fs.writeFileSync(path.join(fixture.config, "ssh", filename), content);
    await assert.rejects(fixture.adapter.prepare(request), /Custom SSH Match or Include rules/);
    assert.ok(!fs.existsSync(path.join(fixture.config, "nominaconnect")));
    assert.ok(fixture.state().service && fixture.state().socket);
    assert.ok(!fixture.state().calls.some((args) => ["stop", "start"].includes(args[0])));
    assert.equal(fs.readFileSync(path.join(fixture.config, "ssh", filename), "utf8"), content);
  }
});
