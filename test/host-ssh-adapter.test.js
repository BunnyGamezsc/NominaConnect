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

/** Simulate host commands and root-owned files for isolated SSH lifecycle regressions. */
function lab(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomina-host-ssh-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "host-ssh");
  const unitDirectory = path.join(root, "units");
  fs.mkdirSync(unitDirectory);
  const calls = [];
  const state = { active: false, failStart: false, failStop: false, conflict: false, failLogin: false, failSessionTermination: false,
    addresses: [request.ip], dropins: "", fragment: "" };
  const filesystem = { ...fs, lstatSync(target) {
    const stat = fs.lstatSync(target);
    return { ...stat, uid: 0, isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile(), isSymbolicLink: () => stat.isSymbolicLink() };
  } };
  const commandRunner = { async run(command) {
    calls.push(command);
    const { binary, args } = command;
    if (binary === "ssh-keygen") return execute(binary, args);
    if (binary === "getent") return { stdout: `${args[1]}:x:0:0::/root:/bin/bash\n` };
    if (binary === "ip") return { stdout: JSON.stringify(args.includes("route") ? [{ prefsrc: request.ip }] : [{ addr_info: state.addresses.map((local) => ({ local })) }]) };
    if (binary === "ss") return { stdout: state.conflict ? "LISTEN occupied" : "" };
    if (binary === "ssh" && state.failLogin) throw new Error("Key authentication failed");
    if (binary === "/usr/bin/python3" && state.failSessionTermination) throw new Error("session cleanup failed");
    if (binary === "systemctl") {
      if (args.includes("--property=DropInPaths")) return { stdout: state.dropins };
      if (args.includes("--property=FragmentPath")) return { stdout: state.fragment };
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

test("first enable preserves preexisting systemd fragments and unloaded drop-ins", async (t) => {
  for (const conflict of ["dropins", "fragment", "unloaded-dropin"]) {
    const { adapter, directory, unitDirectory, state, calls } = lab(t);
    let dropin;
    if (conflict === "dropins") state.dropins = "/run/systemd/system/nomina-host-ssh.service.d/operator.conf";
    if (conflict === "fragment") state.fragment = "/usr/lib/systemd/system/nomina-host-ssh.service";
    if (conflict === "unloaded-dropin") {
      const parent = path.join(unitDirectory, "nomina-host-ssh.service.d");
      fs.mkdirSync(parent);
      dropin = path.join(parent, "operator.conf");
      fs.writeFileSync(dropin, "[Service]\nEnvironment=OPERATOR=1\n");
    }
    await assert.rejects(adapter.publish(request), /overrides|already exists outside Nomina/);
    assert.equal(fs.existsSync(directory), false, "no keys or recovery files are created");
    assert.equal(fs.existsSync(path.join(unitDirectory, "nomina-host-ssh.service")), false);
    assert.ok(!calls.some((command) => command.binary === "systemctl" && ["enable", "disable", "daemon-reload"].includes(command.args[0])));
    if (dropin) assert.equal(fs.readFileSync(dropin, "utf8"), "[Service]\nEnvironment=OPERATOR=1\n");
  }
});

test("disabled host SSH accepts a new account and local address while retaining server identity", async (t) => {
  const { adapter, directory, unitDirectory, state } = lab(t);
  await adapter.publish(request);
  const previousKey = fs.readFileSync(path.join(directory, "client_ed25519"), "utf8");
  const identity = fs.readFileSync(path.join(directory, "host_ed25519"), "utf8");
  const updated = { ip: "192.168.1.11", user: "operator" };
  state.addresses.push(updated.ip);
  await assert.rejects(adapter.publish(updated), /Remove host SSH/);
  assert.equal(fs.readFileSync(path.join(directory, "client_ed25519"), "utf8"), previousKey);
  await adapter.revoke();
  state.fragment = path.join(unitDirectory, "nomina-host-ssh.service");
  assert.equal((await adapter.publish(updated)).status, "healthy");
  assert.equal(fs.readFileSync(path.join(directory, "sshd_config"), "utf8"), hostSshConfig(updated, directory));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "record.json"), "utf8")), { ...updated, disabled: false });
  assert.equal(fs.readFileSync(path.join(directory, "host_ed25519"), "utf8"), identity);
  assert.notEqual(fs.readFileSync(path.join(directory, "client_ed25519"), "utf8"), previousKey);
  assert.ok(fs.readFileSync(path.join(directory, "known_hosts"), "utf8").startsWith(`[${updated.ip}]:22222 `));
});

test("disabled reconfiguration preserves operator changes to managed configuration", async (t) => {
  const { adapter, directory } = lab(t);
  await adapter.publish(request);
  await adapter.revoke();
  const config = `${fs.readFileSync(path.join(directory, "sshd_config"), "utf8")}Banner /etc/issue\n`;
  fs.writeFileSync(path.join(directory, "sshd_config"), config);
  await assert.rejects(adapter.publish({ ...request, user: "operator" }), /changed outside/);
  assert.equal(fs.readFileSync(path.join(directory, "sshd_config"), "utf8"), config);
  assert.equal(fs.existsSync(path.join(directory, "client_ed25519")), false);
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

test("two-phase rotation leaves the old key usable for download and activates the exact downloaded replacement", async (t) => {
  const { adapter, directory, root, calls, state } = lab(t);
  await adapter.publish(request);
  const oldPrivate = fs.readFileSync(path.join(directory, "client_ed25519"), "utf8");
  const oldAuthorization = fs.readFileSync(path.join(directory, "authorized_keys"), "utf8");
  const hostIdentity = fs.readFileSync(path.join(directory, "host_ed25519"), "utf8");
  /** Count session-termination attempts separately from service stop commands. */
  const revocations = () => calls.filter((command) => command.binary === "/usr/bin/python3").length;
  const before = revocations();
  const output = path.join(root, "prepared-download");
  assert.deepEqual(await adapter.prepareKey({ output }), { output });
  const pending = fs.readFileSync(output, "utf8");
  assert.notEqual(pending, oldPrivate);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(directory, "pending_ed25519")).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(directory, "client_ed25519"), "utf8"), oldPrivate);
  assert.equal(fs.readFileSync(path.join(directory, "authorized_keys"), "utf8"), oldAuthorization);
  assert.equal(revocations(), before, "preparation does not disconnect the session used to download");
  assert.equal(state.active, true);
  assert.equal((await adapter.healthCheckExposure(request)).status, "healthy");
  // The downloaded copy, not a newly generated key, must authorize reconnection.
  const clientCopy = path.join(root, "client-downloaded-key");
  fs.copyFileSync(output, clientCopy);
  fs.chmodSync(clientCopy, 0o600);
  const downloadedPublic = (await execute("ssh-keygen", ["-y", "-f", clientCopy])).stdout.trim();
  const generated = calls.filter((command) => command.binary === "ssh-keygen" && command.args.includes("-t")).length;
  assert.equal((await adapter.activateKey(request)).status, "healthy");
  assert.equal(fs.readFileSync(path.join(directory, "client_ed25519"), "utf8"), pending);
  assert.equal(fs.readFileSync(path.join(directory, "authorized_keys"), "utf8").trim(), downloadedPublic);
  assert.notEqual(fs.readFileSync(path.join(directory, "authorized_keys"), "utf8"), oldAuthorization);
  assert.equal(fs.readFileSync(path.join(directory, "host_ed25519"), "utf8"), hostIdentity);
  assert.ok(revocations() > before, "activation terminates old sessions");
  assert.equal(calls.filter((command) => command.binary === "ssh-keygen" && command.args.includes("-t")).length, generated);
  assert.equal(fs.existsSync(path.join(directory, "pending_ed25519")), false);
  assert.equal(fs.existsSync(path.join(directory, "pending_ed25519.pub")), false);
  assert.equal(state.active, true);
});

test("prepared SSH keys cannot overwrite downloads or another pending key, and invalid activation preserves access", async (t) => {
  const { adapter, directory, root } = lab(t);
  await adapter.publish(request);
  const active = fs.readFileSync(path.join(directory, "client_ed25519"), "utf8");
  await assert.rejects(adapter.activateKey(request), /No complete SSH replacement key/);
  const occupied = path.join(root, "occupied-download");
  fs.writeFileSync(occupied, "preserve this file");
  await assert.rejects(adapter.prepareKey({ output: occupied }), /EEXIST/);
  assert.equal(fs.readFileSync(occupied, "utf8"), "preserve this file");
  assert.equal(fs.existsSync(path.join(directory, "pending_ed25519")), false);
  await adapter.prepareKey({ output: path.join(root, "prepared-download") });
  const pending = fs.readFileSync(path.join(directory, "pending_ed25519"), "utf8");
  const anotherOutput = path.join(root, "second-download");
  await assert.rejects(adapter.prepareKey({ output: anotherOutput }), /already prepared/);
  assert.equal(fs.existsSync(anotherOutput), false);
  assert.equal(fs.readFileSync(path.join(directory, "pending_ed25519"), "utf8"), pending);
  fs.appendFileSync(path.join(directory, "pending_ed25519.pub"), fs.readFileSync(path.join(directory, "client_ed25519.pub")));
  await assert.rejects(adapter.activateKey(request), /does not match/);
  assert.equal(fs.readFileSync(path.join(directory, "client_ed25519"), "utf8"), active);
  assert.equal((await adapter.healthCheckExposure(request)).status, "healthy");
});

test("pending SSH key permissions, ownership and symlinks are checked before rotation", async (t) => {
  for (const unsafe of ["permissions", "owner", "symlink"]) {
    const { adapter, directory, root, filesystem } = lab(t);
    await adapter.publish(request);
    await adapter.prepareKey({ output: path.join(root, "prepared-download") });
    const active = fs.readFileSync(path.join(directory, "client_ed25519"), "utf8");
    const pendingPath = path.join(directory, "pending_ed25519");
    if (unsafe === "permissions") fs.chmodSync(pendingPath, 0o644);
    if (unsafe === "symlink") {
      fs.rmSync(pendingPath);
      fs.symlinkSync(path.join(root, "missing-key"), pendingPath);
    }
    if (unsafe === "owner") {
      const stat = filesystem.lstatSync;
      filesystem.lstatSync = (target) => ({ ...stat(target), ...(target === pendingPath ? { uid: 1000 } : {}) });
    }
    await assert.rejects(adapter.activateKey(request), /Unsafe host SSH file|private keys must have mode/);
    assert.equal(fs.readFileSync(path.join(directory, "client_ed25519"), "utf8"), active);
  }
});

test("failed preparation cleans only pending material and its new export, preserving the working key", async (t) => {
  for (const failure of ["generation", "export"]) {
    const { adapter, directory, root, commandRunner, filesystem, state } = lab(t);
    await adapter.publish(request);
    const active = fs.readFileSync(path.join(directory, "client_ed25519"), "utf8");
    const output = path.join(root, "failed-download");
    if (failure === "generation") {
      const run = commandRunner.run;
      commandRunner.run = async (command) => {
        if (command.binary === "ssh-keygen" && command.args.includes(path.join(directory, "pending_ed25519"))) throw new Error("generation interrupted");
        return run(command);
      };
    } else {
      const write = filesystem.writeFileSync;
      filesystem.writeFileSync = (target, content) => {
        if (typeof target === "number") throw new Error("export interrupted");
        return write(target, content);
      };
    }
    await assert.rejects(adapter.prepareKey({ output }), /interrupted/);
    assert.equal(fs.existsSync(output), false);
    assert.equal(fs.existsSync(path.join(directory, "pending_ed25519")), false);
    assert.equal(fs.existsSync(path.join(directory, "pending_ed25519.pub")), false);
    assert.equal(fs.readFileSync(path.join(directory, "client_ed25519"), "utf8"), active);
    assert.equal(state.active, true);
  }
});

test("disable and uninstall discard prepared keys; failed activation leaves no usable authorization", async (t) => {
  for (const action of ["disable", "uninstall", "failed-activation"]) {
    const { adapter, directory, root, state } = lab(t);
    await adapter.publish(request);
    await adapter.prepareKey({ output: path.join(root, "prepared-download") });
    if (action === "disable") await adapter.revoke();
    else if (action === "uninstall") await adapter.uninstall();
    else {
      state.failStart = true;
      await assert.rejects(adapter.activateKey(request), /start failed/);
    }
    assert.equal(fs.existsSync(path.join(directory, "pending_ed25519")), false);
    assert.equal(fs.existsSync(path.join(directory, "pending_ed25519.pub")), false);
    assert.equal(fs.existsSync(path.join(directory, "client_ed25519")), false);
    assert.equal(state.active, false);
    if (action !== "uninstall") assert.equal(fs.readFileSync(path.join(directory, "authorized_keys"), "utf8"), "");
  }
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
