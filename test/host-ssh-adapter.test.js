import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHostSshAdapter, hostSshConfig, hostSshUnit, HOST_SSH_TERMINATE_SESSIONS } from "../src/host-ssh-adapter.js";

const execute = promisify(execFile);
const request = { ip: "192.168.1.10", user: "root" };

test("Linux revocation terminates daemon descendants outside its process group and preserves unrelated sessions", {
  skip: process.platform !== "linux" ? "Requires Linux pidfds; exercised by the live Proxmox harness." : false
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomina-session-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, "child.pid");
  const daemon = spawn("/usr/bin/python3", ["-c", "import subprocess,time,sys; p=subprocess.Popen(['sleep','60'],start_new_session=True); open(sys.argv[1],'w').write(str(p.pid)); time.sleep(60)", marker], { stdio: "ignore" });
  const unrelated = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => { daemon.kill("SIGKILL"); unrelated.kill("SIGKILL"); });
  for (let attempt = 0; attempt < 100 && !fs.existsSync(marker); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(marker));
  const child = Number(fs.readFileSync(marker, "utf8"));
  t.after(() => { try { process.kill(child, "SIGKILL"); } catch {} });
  await execute("/usr/bin/python3", ["-c", HOST_SSH_TERMINATE_SESSIONS, String(daemon.pid)]);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (!fs.existsSync(`/proc/${child}/stat`) || fs.readFileSync(`/proc/${child}/stat`, "utf8").split(") ")[1].startsWith("Z ")) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(!fs.existsSync(`/proc/${child}/stat`) || fs.readFileSync(`/proc/${child}/stat`, "utf8").split(") ")[1].startsWith("Z "));
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  assert.doesNotThrow(() => process.kill(daemon.pid, 0));
});

function lab(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomina-host-ssh-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "host-ssh");
  const unitDirectory = path.join(root, "units");
  fs.mkdirSync(unitDirectory);
  const calls = [];
  const state = { active: false, failStart: false, failStop: false, conflict: false, failLogin: false, failSessionTermination: false };
  const filesystem = { ...fs, lstatSync(target) {
    const stat = fs.lstatSync(target);
    return { ...stat, uid: 0, isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile(), isSymbolicLink: () => stat.isSymbolicLink() };
  } };
  const commandRunner = { async run(command) {
    calls.push(command);
    const { binary, args } = command;
    if (binary === "ssh-keygen") return execute(binary, args);
    if (binary === "getent") return { stdout: `${args[1]}:x:0:0::/root:/bin/bash\n` };
    if (binary === "ip") return { stdout: JSON.stringify(args.includes("route") ? [{ prefsrc: request.ip }] : [{ addr_info: [{ local: request.ip }] }]) };
    if (binary === "ss") return { stdout: state.conflict ? "LISTEN occupied" : "" };
    if (binary === "ssh" && state.failLogin) throw new Error("Key authentication failed");
    if (binary === "/usr/bin/python3" && state.failSessionTermination) throw new Error("session cleanup failed");
    if (binary === "systemctl") {
      if (args[0] === "enable") { if (state.failStart) throw new Error("start failed"); state.active = true; }
      if (args[0] === "disable") { if (state.failStop) throw new Error("stop failed"); state.active = false; }
      if (args[0] === "is-active" && !state.active) throw new Error("inactive");
    }
    return { stdout: "" };
  } };
  const adapter = createHostSshAdapter({ commandRunner, filesystem: /** @type {typeof fs} */ (/** @type {unknown} */ (filesystem)), directory, unitDirectory, isRoot: () => true });
  return { adapter, root, directory, unitDirectory, calls, state, commandRunner, filesystem };
}

test("host SSH generates real isolated keys, exports securely and keeps the server identity through rotation", async (t) => {
  const fixture = lab(t);
  const { adapter, directory, root, calls } = fixture;
  assert.equal(await adapter.suggestAddress("192.168.1.86"), request.ip);
  assert.equal((await adapter.publish(request)).status, "healthy");
  const key = fs.readFileSync(path.join(directory, "client_ed25519"), "utf8");
  const hostKey = fs.readFileSync(path.join(directory, "host_ed25519"), "utf8");
  assert.match(key, /BEGIN OPENSSH PRIVATE KEY/);
  assert.notEqual(key, hostKey);
  const publicKey = (await execute("ssh-keygen", ["-y", "-f", path.join(directory, "client_ed25519")])).stdout.trim().split(" ").slice(0, 2).join(" ");
  assert.ok(fs.readFileSync(path.join(directory, "authorized_keys"), "utf8").startsWith(publicKey));
  const output = path.join(root, "download");
  await adapter.exportKey({ output });
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(output, "utf8"), key);
  await assert.rejects(adapter.exportKey({ output }), /EEXIST/);
  await adapter.publish(request);
  assert.equal(fs.readFileSync(path.join(directory, "client_ed25519"), "utf8"), key, "ordinary reconciliation retains the key");
  await adapter.replaceKey(request);
  assert.notEqual(fs.readFileSync(path.join(directory, "client_ed25519"), "utf8"), key);
  assert.equal(fs.readFileSync(path.join(directory, "host_ed25519"), "utf8"), hostKey);
  const login = calls.find((command) => command.binary === "ssh");
  assert.ok(login.args.includes("StrictHostKeyChecking=yes"));
  assert.ok(login.args.includes("IdentitiesOnly=yes"));
  assert.ok(!calls.some((command) => command.args.includes("ssh.service") || command.args.includes("sshd.service")));
});

test("disabling SSH revokes keys before stopping, and re-enabling requires a new key", async (t) => {
  const { adapter, directory, state } = lab(t);
  await adapter.publish(request);
  const oldKey = fs.readFileSync(path.join(directory, "client_ed25519"), "utf8");
  state.failStop = true;
  await assert.rejects(adapter.revoke(), /stop failed/);
  assert.equal(fs.readFileSync(path.join(directory, "authorized_keys"), "utf8"), "");
  assert.equal(fs.existsSync(path.join(directory, "client_ed25519")), false);
  await assert.rejects(adapter.exportKey({ output: path.join(directory, "export") }), /disabled/);
  state.failStop = false;
  await adapter.revoke();
  assert.equal(state.active, false);
  await adapter.publish(request);
  assert.notEqual(fs.readFileSync(path.join(directory, "client_ed25519"), "utf8"), oldKey);
});

test("startup and authentication failures leave no usable Nomina authorization", async (t) => {
  for (const failure of ["failStart", "failLogin"]) {
    const { adapter, directory, state } = lab(t);
    state[failure] = true;
    await assert.rejects(adapter.publish(request), /failed/i);
    assert.equal(fs.existsSync(path.join(directory, "client_ed25519")), false);
    assert.equal(fs.readFileSync(path.join(directory, "authorized_keys"), "utf8"), "");
    assert.equal(state.active, false);
  }
});

test("failed session termination still revokes keys and stops SSH while reporting incomplete cleanup", async (t) => {
  const { adapter, directory, state } = lab(t);
  await adapter.publish(request);
  state.failSessionTermination = true;
  await assert.rejects(adapter.revoke(), /session termination failed/);
  assert.equal(state.active, false);
  assert.equal(fs.readFileSync(path.join(directory, "authorized_keys"), "utf8"), "");
  assert.equal(fs.existsSync(path.join(directory, "client_ed25519")), false);
});

test("host SSH refuses public/nonlocal targets, injected accounts, occupied ports and foreign files", async (t) => {
  const { adapter, directory, state } = lab(t);
  for (const invalid of [{ ...request, ip: "8.8.8.8" }, { ...request, ip: "0.0.0.0" }, { ...request, ip: "127.0.0.1" }, { ...request, ip: "192.168.1.99" }, { ...request, user: "root\nPasswordAuthentication yes" }]) {
    await assert.rejects(adapter.publish(invalid));
    assert.equal(fs.existsSync(directory), false);
  }
  state.conflict = true;
  await assert.rejects(adapter.publish(request), /occupied/);
  state.conflict = false;
  fs.mkdirSync(directory);
  await assert.rejects(adapter.publish(request), /without a recovery record/);
});

test("native config edits are preserved but cannot prevent revoking the managed authorization", async (t) => {
  const { adapter, directory } = lab(t);
  await adapter.publish(request);
  fs.appendFileSync(path.join(directory, "sshd_config"), "Banner /etc/issue\n");
  await assert.rejects(adapter.publish(request), /changed outside/);
  assert.match(fs.readFileSync(path.join(directory, "sshd_config"), "utf8"), /Banner/);
  await adapter.revoke();
  assert.equal(fs.readFileSync(path.join(directory, "authorized_keys"), "utf8"), "");
});

test("SSH policy has a single key source, key-only root access and session termination", () => {
  const config = hostSshConfig(request);
  for (const line of ["AuthenticationMethods publickey", "PasswordAuthentication no", "KbdInteractiveAuthentication no", "PermitRootLogin prohibit-password", "AuthorizedKeysFile none", "AuthorizedKeysCommandUser root", "TrustedUserCAKeys none", "AllowUsers root", "DisableForwarding yes", "UsePAM yes"]) assert.ok(config.includes(`${line}\n`));
  assert.match(config, /^AuthorizedKeysCommand \/bin\/cat \/var\/lib\/nominaconnect\/host-ssh\/authorized_keys$/m);
  assert.ok(!config.includes("Include "));
  assert.ok(!config.includes(".ssh/authorized_keys"));
  assert.match(hostSshUnit(), /KillMode=control-group/);
});

test("replacement refuses an occupied download path before revoking the working key", async (t) => {
  const { adapter, directory, root } = lab(t);
  await adapter.publish(request);
  const previous = fs.readFileSync(path.join(directory, "client_ed25519"), "utf8");
  const output = path.join(root, "existing-key");
  fs.writeFileSync(output, "do not replace");
  await assert.rejects(adapter.replaceKey({ ...request, output }), /EEXIST/);
  assert.equal(fs.readFileSync(path.join(directory, "client_ed25519"), "utf8"), previous);
  assert.equal(fs.readFileSync(output, "utf8"), "do not replace");
  assert.equal((await adapter.healthCheckExposure(request)).status, "healthy");
});

test("uninstall removes only the managed unit and keys after revocation", async (t) => {
  const { adapter, directory, unitDirectory, state } = lab(t);
  fs.writeFileSync(path.join(unitDirectory, "ssh.service"), "existing host administrator service");
  await adapter.publish(request);
  await adapter.uninstall();
  assert.equal(state.active, false);
  assert.equal(fs.existsSync(directory), false);
  assert.equal(fs.existsSync(path.join(unitDirectory, "nomina-host-ssh.service")), false);
  assert.equal(fs.readFileSync(path.join(unitDirectory, "ssh.service"), "utf8"), "existing host administrator service");
});

test("the installed OpenSSH binary accepts the generated key-only configuration", { skip: !fs.existsSync("/usr/sbin/sshd") }, async (t) => {
  const { adapter, directory } = lab(t);
  await adapter.publish(request);
  let effective;
  try { effective = (await execute("/usr/sbin/sshd", ["-T", "-f", path.join(directory, "sshd_config")])).stdout.toLowerCase(); }
  catch (error) {
    if (/Missing privilege separation directory|Operation not permitted|no hostkeys available/i.test(error.stderr ?? "")) {
      t.skip("The local OS cannot run sshd validation; validate on the Proxmox host."); return;
    }
    throw error;
  }
  const settings = new Map(effective.trim().split("\n").map((line) => {
    const separator = line.indexOf(" ");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  assert.equal(settings.get("authenticationmethods"), "publickey");
  assert.equal(settings.get("passwordauthentication"), "no");
  assert.equal(settings.get("kbdinteractiveauthentication"), "no");
  assert.equal(settings.get("allowusers"), "root");
  // OpenSSH versions either omit an empty key-file list or print "none".
  assert.equal(settings.get("authorizedkeysfile") ?? "none", "none");
  assert.match(settings.get("authorizedkeyscommand"), /^\/bin\/cat .*\/authorized_keys$/);
  assert.equal(settings.get("authorizedkeyscommanduser"), "root");
  assert.equal(settings.get("listenaddress"), "192.168.1.10:22222");
});
