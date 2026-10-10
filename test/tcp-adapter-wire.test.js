import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer, createConnection } from "node:net";
import { createTcpAdapter, tcpTailnetScript, tcpUnits } from "../src/tcp-adapter.js";
import { firewallInstallScript } from "../src/tailscale-tailnet.js";

const execute = promisify(execFile);
const request = { hostname: "mc.home.test", ip: "192.168.1.86", vmid: 121, backendIp: "192.168.1.50", backendPort: 25565, listenerPort: 25565, gatewayVmid: 122, gatewayLanIp: "192.168.1.90", gatewayIp: undefined, tailnet: true };

// Execute the actual generated scripts on disk. Only platform executables are
// replaced; their rule state is retained across calls to exercise persistence.
const COMMAND_SHIM = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const statePath = process.env.SHIM_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { rules: {}, active: {}, calls: [] };
state.calls.push([name, ...args]);
let status = 0;
if (name === 'ss') { if (state.conflict) console.log('LISTEN 0 128 0.0.0.0:25565 0.0.0.0:*'); }
if (name === 'systemctl') {
  if (args[0] === 'enable' || args[0] === 'restart') state.active[args[1]] = true;
  if (args[0] === 'stop') state.active[args[1]] = false;
  if (args[0] === 'show' && args.includes('--property=ExecStart')) {
    const content = fs.readFileSync(path.join(process.env.SHIM_CONFIG, 'systemd/system', args.at(-1)), 'utf8');
    console.log(content.split('\\n').find(line => line.startsWith('ExecStart='))?.slice(10) ?? '');
  }
  if (args[0] === 'disable') state.active[args.at(-1)] = false;
  if (args[0] === 'is-active' || args[0] === 'is-enabled') status = state.active[args.at(-1)] ? 0 : 1;
}
if (name === 'iptables-save') {
  for (const [key, rules] of Object.entries(state.rules)) if (key.startsWith('nat:')) for (const rule of rules) console.log(rule);
}
if (name === 'iptables-restore') {
  let table;
  for (const line of fs.readFileSync(0, 'utf8').trim().split('\\n')) {
    if (line.startsWith('*')) table = line.slice(1);
    else if (line.startsWith(':')) state.rules[table + ':' + line.split(' ')[0].slice(1)] = [];
    else if (line.startsWith('-A ')) { const key = table + ':' + line.split(' ')[1]; (state.rules[key] ??= []).push(line); }
  }
}
if (name === 'iptables') {
  const tableIndex = args.indexOf('-t');
  const table = tableIndex < 0 ? 'filter' : args[tableIndex + 1];
  const opIndex = args.findIndex(arg => ['-C', '-A', '-I', '-D'].includes(arg));
  const op = args[opIndex];
  const chain = args[opIndex + 1];
  const key = table + ':' + chain;
  const rules = state.rules[key] ??= [];
  const offset = args[opIndex + 2] === '1' ? 3 : 2;
  const rule = ['-A', chain, ...args.slice(opIndex + offset)].join(' ');
  const index = rules.indexOf(rule);
  if (op === '-C') status = index >= 0 ? 0 : 1;
  if (op === '-D') { if (index < 0) status = 1; else rules.splice(index, 1); }
  if (op === '-A') rules.push(rule);
  if (op === '-I') rules.unshift(rule);
}
fs.writeFileSync(statePath, JSON.stringify(state));
process.exit(status);
`;

function scriptLab(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomina-tcp-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  for (const name of ["ss", "systemctl", "iptables", "iptables-save", "iptables-restore"]) fs.writeFileSync(path.join(bin, name), COMMAND_SHIM, { mode: 0o755 });
  const locations = (vmid) => ({ config: path.join(root, String(vmid), "etc"), scripts: path.join(root, String(vmid), "sbin"), state: path.join(root, `${vmid}.json`) });
  for (const vmid of [121, 122]) {
    const location = locations(vmid);
    fs.mkdirSync(path.join(location.config, "systemd/system"), { recursive: true });
    fs.mkdirSync(location.scripts, { recursive: true });
  }
  fs.writeFileSync(path.join(locations(122).scripts, "nomina-tailnet-firewall"), "#!/bin/sh\ntrue\n", { mode: 0o700 });
  const exec = async (vmid, command) => {
    if (command.binary === "/usr/bin/tailscale") return { stdout: "100.70.80.90\n" };
    const location = locations(vmid);
    const script = command.args[1].replaceAll("/etc/nominaconnect", `${location.config}/nominaconnect`)
      .replaceAll("/etc/systemd/system", `${location.config}/systemd/system`)
      .replaceAll("/usr/local/sbin", location.scripts)
      .replace("test -x /lib/systemd/systemd-socket-proxyd", "true");
    return execute("/bin/bash", ["-c", script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SHIM_STATE: location.state, SHIM_CONFIG: location.config } });
  };
  const state = (vmid) => JSON.parse(fs.readFileSync(locations(vmid).state, "utf8"));
  const setState = (vmid, value) => fs.writeFileSync(locations(vmid).state, JSON.stringify(value));
  return { exec, state, setState, locations };
}

test("TCP generated scripts persist forwarding, update backend and scope tailnet opt-out/removal", async (t) => {
  const lab = scriptLab(t);
  const adapter = createTcpAdapter({ exec: lab.exec });
  const first = { ...request };
  await adapter.preflight(first);
  assert.equal(first.gatewayIp, "100.70.80.90");
  await adapter.publish(first);
  const other = { ...request, hostname: "other.home.test", listenerPort: 28000, backendPort: 28001 };
  await adapter.preflight(other); await adapter.publish(other);
  const gateway = lab.state(122);
  gateway.rules["nat:UNMANAGED"] = ["-A UNMANAGED -p tcp --dport 9999 -j DNAT --to-destination 192.168.1.99"];
  lab.setState(122, gateway);
  const rules = lab.state(122).rules;
  assert.ok(rules["raw:NOMINA_TCP_INGRESS"].some((line) => line.includes("-d 100.70.80.90 -p tcp --dport 25565 -j ACCEPT")));
  assert.ok(rules["nat:NOMINA_TCP_DNAT"].some((line) => line.includes("--to-destination 192.168.1.86:25565")));
  const moved = { ...first, backendIp: "192.168.1.60", backendPort: 25566, tailnet: false };
  await adapter.preflight(moved); await adapter.publish(moved);
  const inspection = await adapter.inspect(moved);
  assert.equal(inspection.resources.find((resource) => resource.hostname === first.hostname).backendPort, 25566);
  assert.equal(inspection.resources.find((resource) => resource.hostname === first.hostname).tailnet, false);
  const afterOptOut = lab.state(122).rules;
  for (const chain of ["raw:NOMINA_TCP_INGRESS", "filter:NOMINA_TCP_FORWARD", "nat:NOMINA_TCP_DNAT", "nat:NOMINA_TCP_SNAT"]) {
    assert.ok(!afterOptOut[chain].some((line) => line.includes("25565")));
    assert.ok(afterOptOut[chain].some((line) => line.includes("28000")));
  }
  // Replay the installed boot hook with the persisted port files.
  await lab.exec(122, { binary: "/bin/bash", args: ["-c", "/usr/local/sbin/nomina-tailnet-firewall"] });
  assert.deepEqual(lab.state(122).rules["nat:NOMINA_TCP_DNAT"], afterOptOut["nat:NOMINA_TCP_DNAT"]);
  await adapter.remove(moved);
  assert.equal((await adapter.inspect(other)).resources.length, 1);
  assert.deepEqual(lab.state(122).rules["nat:UNMANAGED"], gateway.rules["nat:UNMANAGED"]);
  assert.equal(fs.existsSync(path.join(lab.locations(121).config, "systemd/system/nomina-tcp-25565.socket")), false);
});

test("TCP preflight rejects process listeners, unmanaged forwarding and edited units without writes", async (t) => {
  const lab = scriptLab(t);
  const adapter = createTcpAdapter({ exec: lab.exec });
  await adapter.preflight({ ...request });
  const state = lab.state(121); state.conflict = true; lab.setState(121, state);
  await assert.rejects(adapter.preflight({ ...request }), /conflicts with an existing listener/);
  assert.equal(fs.existsSync(path.join(lab.locations(121).config, "nominaconnect")), false);
  state.conflict = false; lab.setState(121, state);
  const gateway = lab.state(122); gateway.rules["nat:PREROUTING"] = ["-A PREROUTING -p tcp --dport 25560:25570 -j DNAT --to-destination 192.168.1.99"]; lab.setState(122, gateway);
  await assert.rejects(adapter.preflight({ ...request }), /unmanaged forwarding/);
  gateway.rules["nat:PREROUTING"] = []; lab.setState(122, gateway);
  const published = { ...request }; await adapter.preflight(published); await adapter.publish(published);
  const file = path.join(lab.locations(121).config, "systemd/system/nomina-tcp-25565.service");
  fs.appendFileSync(file, "ExecStartPost=/bin/true\n");
  await assert.rejects(adapter.preflight(published));
  await assert.rejects(adapter.remove(published));
  assert.match(fs.readFileSync(file, "utf8"), /ExecStartPost/);
});

test("SMB port 445 persists with Minecraft and its tailnet opt-out preserves the Minecraft rules", async (t) => {
  const lab = scriptLab(t);
  const adapter = createTcpAdapter({ exec: lab.exec });
  const minecraft = { ...request };
  await adapter.preflight(minecraft); await adapter.publish(minecraft);
  const smb = { ...request, hostname: "files.home.test", listenerPort: 445, backendPort: 1445 };
  await adapter.preflight(smb); await adapter.publish(smb);
  const socket = path.join(lab.locations(121).config, "systemd/system/nomina-tcp-445.socket");
  const service = path.join(lab.locations(121).config, "systemd/system/nomina-tcp-445.service");
  assert.match(fs.readFileSync(socket, "utf8"), /ListenStream=192.168.1.86:445/);
  assert.match(fs.readFileSync(service, "utf8"), /systemd-socket-proxyd 192.168.1.50:1445/);
  assert.equal(lab.state(121).active["nomina-tcp-445.socket"], true);
  // Recreate the adapter and replay the gateway boot hook from persisted files.
  const restarted = createTcpAdapter({ exec: lab.exec });
  await lab.exec(122, { binary: "/bin/bash", args: ["-c", "/usr/local/sbin/nomina-tailnet-firewall"] });
  assert.equal((await restarted.inspect(smb)).resources.find((record) => record.hostname === smb.hostname).listenerPort, 445);
  assert.ok(lab.state(122).rules["nat:NOMINA_TCP_DNAT"].some((line) => line.includes("--to-destination 192.168.1.86:445")));
  const moved = { ...smb, backendIp: "198.51.100.22", backendPort: 2445, tailnet: false };
  await restarted.preflight(moved); await restarted.publish(moved);
  assert.match(fs.readFileSync(service, "utf8"), /systemd-socket-proxyd 198.51.100.22:2445/);
  for (const chain of ["raw:NOMINA_TCP_INGRESS", "filter:NOMINA_TCP_FORWARD", "nat:NOMINA_TCP_DNAT", "nat:NOMINA_TCP_SNAT"]) {
    const rules = lab.state(122).rules[chain];
    assert.ok(!rules.some((line) => /(?:--dport |--ctorigdstport |:)445\b/.test(line)));
    assert.ok(rules.some((line) => line.includes("25565")));
  }
  await restarted.remove(moved);
  assert.equal(fs.existsSync(socket), false);
  assert.equal(fs.existsSync(service), false);
  assert.equal((await restarted.inspect(minecraft)).resources.length, 1);
});

test("TCP inspection observes native backend edits for provider-precedence adoption", async (t) => {
  const lab = scriptLab(t);
  const adapter = createTcpAdapter({ exec: lab.exec });
  const published = { ...request }; await adapter.preflight(published); await adapter.publish(published);
  const file = path.join(lab.locations(121).config, "systemd/system/nomina-tcp-25565.service");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("192.168.1.50:25565", "192.168.1.60:25566"));
  const observed = (await adapter.inspect(published)).resources[0];
  assert.equal(observed.backendIp, "192.168.1.60");
  assert.equal(observed.backendPort, 25566);
  await adapter.preflight({ ...published, backendIp: observed.backendIp, backendPort: observed.backendPort });
});

test("TCP transport health tests the backend from the proxy and leaves application access unverified", async (t) => {
  const lab = scriptLab(t);
  const backend = createServer((socket) => socket.destroy());
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(() => backend.close());
  const backendPort = /** @type {import("node:net").AddressInfo} */ (backend.address()).port;
  const published = { ...request, backendIp: "127.0.0.1", backendPort, gatewayVmid: undefined };
  const adapter = createTcpAdapter({ exec: lab.exec, probe: async () => true });
  await adapter.preflight(published); await adapter.publish(published);
  const state = lab.state(121); state.active["nomina-tcp-25565.service"] = true; lab.setState(121, state);
  const healthy = await adapter.healthCheckExposure(published);
  assert.equal(healthy.status, "healthy");
  assert.equal(healthy.application, "not-verified");
  await new Promise((resolve) => backend.close(() => resolve(undefined)));
  const failed = await adapter.healthCheckExposure(published);
  assert.equal(failed.status, "unhealthy");
  assert.match(failed.reason, /backend is unreachable from the proxy/);
});

test("TCP and base gateway scripts are valid shell and retain reboot integration", () => {
  for (const script of [tcpTailnetScript("100.70.80.90"), firewallInstallScript("192.168.1.90", "192.168.1.86", "100.70.80.90")]) {
    const result = spawnSync("/bin/bash", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  assert.match(firewallInstallScript("192.168.1.90", "192.168.1.86", "100.70.80.90"), /nomina-tailnet-tcp/);
});

const binary = "/lib/systemd/systemd-socket-proxyd";
test("Linux systemd-socket-proxyd transfers real TCP bytes through the emitted service target", {
  skip: process.platform !== "linux" || !fs.existsSync(binary) ? "Needs Linux with systemd-socket-proxyd; run this check in the Proxmox lab." : false
}, async (t) => {
  const backend = createServer((socket) => socket.on("data", (data) => socket.end(Buffer.concat([Buffer.from("forwarded:"), Buffer.from(data)]))));
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", () => resolve(undefined)));
  const backendPort = /** @type {import("node:net").AddressInfo} */ (backend.address()).port;
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", () => resolve(undefined)));
  const listenerPort = /** @type {import("node:net").AddressInfo} */ (listener.address()).port;
  const units = tcpUnits({ ...request, backendIp: "127.0.0.1", backendPort });
  const target = units.service.match(/^ExecStart=\S+ (\S+)$/m)[1];
  const process = spawn("/bin/sh", ["-c", 'export LISTEN_PID=$$; exec "$1" "$2"', "nomina-wire", binary, target], {
    env: { ...globalThis.process.env, LISTEN_FDS: "1" }, stdio: ["ignore", "pipe", "pipe", /** @type {any} */ (listener)._handle.fd]
  });
  listener.close();
  t.after(() => { process.kill(); backend.close(); });
  const response = await new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: listenerPort }, () => socket.write("minecraft"));
    socket.setTimeout(3000, () => socket.destroy(new Error("Forwarding timed out")));
    let data = "";
    socket.on("data", (chunk) => { data += chunk; }); socket.on("end", () => resolve(data)); socket.on("error", reject);
  });
  assert.equal(response, "forwarded:minecraft");
});
