import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";
import { randomUUID } from "node:crypto";

export const HOST_SSH_DIRECTORY = "/var/lib/nominaconnect/host-ssh";
export const HOST_SSH_PORT = 22222;
const UNIT = "nomina-host-ssh.service";

// PAM can move authenticated shells into session scopes outside sshd's service
// cgroup. Capture their process identities while their daemon ancestry exists;
// pidfds prevent a recycled PID from ever targeting an unrelated process.
export const HOST_SSH_TERMINATE_SESSIONS = `import os, signal, sys
root = int(sys.argv[1] or "0")
if root <= 1:
    sys.exit(0)
parents = {}
started = {}
for name in os.listdir("/proc"):
    if not name.isdigit():
        continue
    try:
        stat = open("/proc/" + name + "/stat").read().rsplit(")", 1)[1].split()
        parents[int(name)] = int(stat[1])
        started[int(name)] = stat[19]
    except (FileNotFoundError, ProcessLookupError):
        pass
owned = {root}
while True:
    expanded = owned | {pid for pid, parent in parents.items() if parent in owned}
    if expanded == owned:
        break
    owned = expanded
handles = []
try:
    for pid in owned - {root}:
        handle = None
        try:
            handle = os.pidfd_open(pid)
            stat = open("/proc/" + str(pid) + "/stat").read().rsplit(")", 1)[1].split()
            if stat[19] == started[pid]:
                handles.append(handle)
                handle = None
            else:
                os.close(handle)
                handle = None
        except (FileNotFoundError, ProcessLookupError):
            if handle is not None:
                os.close(handle)
    for handle in handles:
        try:
            signal.pidfd_send_signal(handle, signal.SIGKILL)
        except ProcessLookupError:
            pass
finally:
    for handle in handles:
        os.close(handle)
`;

export function isPrivateIpv4(ip) {
  if (isIP(ip) !== 4) return false;
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function hostSshConfig({ ip, user }, directory = HOST_SSH_DIRECTORY) {
  if (!isPrivateIpv4(ip)) throw new Error("Host SSH requires a private LAN IPv4 address.");
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error("Choose a valid existing OS account.");
  return `# Nomina host access; independent of /etc/ssh/sshd_config
Port ${HOST_SSH_PORT}
AddressFamily inet
ListenAddress ${ip}
HostKey ${directory}/host_ed25519
PidFile /run/nomina-host-ssh.pid
AllowUsers ${user}
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
HostbasedAuthentication no
GSSAPIAuthentication no
PermitRootLogin prohibit-password
AuthorizedKeysFile none
AuthorizedKeysCommand /bin/cat ${directory}/authorized_keys
AuthorizedKeysCommandUser root
TrustedUserCAKeys none
StrictModes yes
UsePAM yes
DisableForwarding yes
PermitUserRC no
X11Forwarding no
Subsystem sftp internal-sftp
`;
}

export function hostSshUnit(directory = HOST_SSH_DIRECTORY) {
  return `[Unit]
Description=Nomina host SSH access
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStartPre=/usr/bin/install -d -m 0755 /run/sshd
ExecStartPre=/usr/sbin/sshd -t -f ${directory}/sshd_config
ExecStart=/usr/sbin/sshd -D -e -f ${directory}/sshd_config
Restart=on-failure
KillMode=control-group
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
`;
}

/** Own only our dedicated daemon and keys; never edit the operating system SSH service. */
export function createHostSshAdapter({ commandRunner, filesystem = fs, directory = HOST_SSH_DIRECTORY,
  unitDirectory = "/etc/systemd/system", isRoot = () => process.getuid?.() === 0 }) {
  const file = (name) => path.join(directory, name);
  const unitPath = path.join(unitDirectory, UNIT);
  const run = (binary, args, timeoutMs = 30_000) => commandRunner.run({ binary, args, timeoutMs });
  function guard() {
    if (!isRoot()) throw new Error("Host SSH can only be managed from the Proxmox root shell.");
    for (const target of [directory, path.dirname(directory), unitDirectory]) {
      if (!filesystem.existsSync(target)) continue;
      const stat = filesystem.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== 0 || (stat.mode & 0o022)) {
        throw new Error(`Host SSH path ${target} must be a root-owned directory without group/world write access.`);
      }
    }
    if (filesystem.existsSync(directory)) {
      for (const name of ["record.json", "sshd_config", "authorized_keys", "client_ed25519", "client_ed25519.pub", "pending_ed25519", "pending_ed25519.pub", "host_ed25519", "host_ed25519.pub", "known_hosts"]) {
        const target = file(name);
        let stat;
        try { stat = filesystem.lstatSync(target); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error(`Unsafe host SSH file ${target}.`);
        if (["client_ed25519", "pending_ed25519", "host_ed25519"].includes(name) && (stat.mode & 0o077)) throw new Error("SSH private keys must have mode 0600.");
      }
    }
  }
  const readRecord = () => filesystem.existsSync(file("record.json")) ? JSON.parse(filesystem.readFileSync(file("record.json"), "utf8")) : undefined;
  function write(name, content, mode = 0o600) {
    // The parent is root-owned; exclusive temporary files also avoid following symlinks.
    const temporary = `${file(name)}.${randomUUID()}.tmp`;
    const fd = filesystem.openSync(temporary, "wx", mode);
    try {
      filesystem.writeFileSync(fd, content);
      filesystem.renameSync(temporary, file(name));
    } finally {
      filesystem.closeSync(fd);
      filesystem.rmSync(temporary, { force: true });
    }
  }
  function assertOwned(record) {
    if (!record) throw new Error("Host SSH is not managed by Nomina.");
    if (filesystem.readFileSync(file("sshd_config"), "utf8") !== hostSshConfig(record, directory)
      || filesystem.lstatSync(unitPath).isSymbolicLink()
      || filesystem.readFileSync(unitPath, "utf8") !== hostSshUnit(directory)) {
      throw new Error("Managed host SSH configuration changed outside Nomina; refusing to overwrite it.");
    }
  }
  async function validateEndpoint(request) {
    hostSshConfig(request, directory);
    const account = await run("getent", ["passwd", request.user]);
    const fields = String(account.stdout ?? "").trim().split(":");
    if (fields.length !== 7 || fields[0] !== request.user || /(?:nologin|false)$/.test(fields[6])) throw new Error("Choose an existing OS account with a login shell.");
    const addresses = JSON.parse(String((await run("ip", ["-j", "-4", "address", "show"])).stdout));
    if (!addresses.some((entry) => entry.addr_info?.some((address) => address.local === request.ip))) throw new Error("SSH host IP must be assigned to the machine running Nomina.");
    await run("/bin/bash", ["-c", "test -x /usr/sbin/sshd && test -x /usr/bin/python3 && command -v ssh-keygen >/dev/null && command -v ssh >/dev/null && command -v systemctl >/dev/null"]);
  }
  async function preflight(request) {
    guard();
    await validateEndpoint(request);
    const current = readRecord();
    if (current) {
      assertOwned(current);
      if (!current.disabled && (current.ip !== request.ip || current.user !== request.user)) throw new Error("Remove host SSH before changing its account or host address.");
    } else {
      if (filesystem.existsSync(unitPath) || filesystem.existsSync(directory)) throw new Error("Host SSH files already exist without a recovery record; inspect them before enabling SSH.");
      const listener = await run("ss", ["-H", "-ltn", `sport = :${HOST_SSH_PORT}`]);
      if (String(listener.stdout ?? "").trim()) throw new Error(`Host SSH port ${HOST_SSH_PORT} is already occupied.`);
    }
    // A drop-in can exist before the base unit is installed, when systemd may
    // not yet report it. Never inherit operator settings for our dedicated unit.
    if (filesystem.existsSync(`${unitPath}.d`)) throw new Error("Managed SSH has unsupported systemd overrides.");
    const dropins = await run("systemctl", ["show", "--property=DropInPaths", "--value", UNIT]);
    if (String(dropins.stdout ?? "").trim()) throw new Error("Managed SSH has unsupported systemd overrides.");
    const loadedUnit = await run("systemctl", ["show", "--property=FragmentPath", "--value", UNIT]);
    const fragment = String(loadedUnit.stdout ?? "").trim();
    if (fragment && (!current || fragment !== unitPath)) throw new Error("Host SSH systemd unit already exists outside Nomina; refusing to replace it.");
    return current;
  }
  async function keygen(name) {
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "Nomina host SSH", "-f", file(name)]);
    filesystem.chmodSync(file(name), 0o600);
  }
  function discardPendingKey() {
    filesystem.rmSync(file("pending_ed25519"), { force: true });
    filesystem.rmSync(file("pending_ed25519.pub"), { force: true });
  }
  async function revoke() {
    guard();
    const current = readRecord();
    if (!current) throw new Error("Host SSH has no recovery record; refusing unscoped removal.");
    // Revoke authorization before any service-manager operation that might fail.
    write("authorized_keys", "");
    filesystem.rmSync(file("client_ed25519"), { force: true });
    filesystem.rmSync(file("client_ed25519.pub"), { force: true });
    discardPendingKey();
    write("record.json", `${JSON.stringify({ ...current, disabled: true })}\n`);
    let sessionError;
    try {
      const daemon = await run("systemctl", ["show", "--property=MainPID", "--value", UNIT]);
      await run("/usr/bin/python3", ["-c", HOST_SSH_TERMINATE_SESSIONS, String(daemon.stdout ?? "").trim()]);
    } catch (error) { sessionError = error; }
    try { await run("systemctl", ["disable", "--now", UNIT]); }
    finally { await run("systemctl", ["kill", "--kill-whom=all", UNIT]).catch(() => {}); }
    await run("/bin/bash", ["-c", `! systemctl is-active --quiet ${UNIT}`]);
    if (sessionError) throw new Error(`SSH keys revoked and service stopped, but session termination failed: ${sessionError.message}`);
  }
  async function healthCheckExposure(request) {
    try {
      guard();
      const record = readRecord();
      assertOwned(record);
      if (record.disabled || record.ip !== request.ip || record.user !== request.user) throw new Error("Host SSH authorization is disabled or differs from inventory.");
      await run("/usr/sbin/sshd", ["-t", "-f", file("sshd_config")]);
      await run("systemctl", ["is-active", "--quiet", UNIT]);
      await run("ssh", ["-F", "/dev/null", "-i", file("client_ed25519"), "-p", String(HOST_SSH_PORT),
        "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", `UserKnownHostsFile=${file("known_hosts")}`, "-o", "ConnectTimeout=5", "-o", "LogLevel=ERROR",
        `${request.user}@${request.ip}`, "true"], 10_000);
      return { status: "healthy", ssh: "key-login-verified", password: "disabled" };
    } catch (error) {
      return { status: "unhealthy", ssh: "unverified", reason: error.message };
    }
  }
  async function publish(request, preparedKey = undefined) {
      const current = await preflight(request);
      if (current && !current.disabled && !preparedKey) return healthCheckExposure(request);
      if (current) await revoke();
      if (!current) {
        filesystem.mkdirSync(path.dirname(directory), { recursive: true, mode: 0o755 });
        filesystem.mkdirSync(directory, { mode: 0o700 });
        write("record.json", `${JSON.stringify({ ip: request.ip, user: request.user, disabled: true })}\n`);
        write("sshd_config", hostSshConfig(request, directory));
        filesystem.writeFileSync(unitPath, hostSshUnit(directory), { flag: "wx", mode: 0o644 });
      }
      try {
        if (current && (current.ip !== request.ip || current.user !== request.user)) {
          // Disabled access can be set up again for another account/address.
          // Revocation above stopped the old daemon; retain its server identity.
          write("sshd_config", hostSshConfig(request, directory));
          write("record.json", `${JSON.stringify({ ip: request.ip, user: request.user, disabled: true })}\n`);
        }
        if (!filesystem.existsSync(file("host_ed25519"))) await keygen("host_ed25519");
        filesystem.rmSync(file("client_ed25519"), { force: true });
        filesystem.rmSync(file("client_ed25519.pub"), { force: true });
        if (preparedKey) {
          write("client_ed25519", preparedKey.privateKey);
          write("client_ed25519.pub", preparedKey.publicKey);
        } else await keygen("client_ed25519");
        write("authorized_keys", filesystem.readFileSync(file("client_ed25519.pub"), "utf8"));
        write("known_hosts", `[${request.ip}]:${HOST_SSH_PORT} ${filesystem.readFileSync(file("host_ed25519.pub"), "utf8").trim()}\n`);
        await run("/bin/mkdir", ["-p", "/run/sshd"]);
        await run("/usr/sbin/sshd", ["-t", "-f", file("sshd_config")]);
        await run("systemctl", ["daemon-reload"]);
        await run("systemctl", ["enable", "--now", UNIT]);
        write("record.json", `${JSON.stringify({ ip: request.ip, user: request.user, disabled: false })}\n`);
        const health = await healthCheckExposure(request);
        if (health.status !== "healthy") throw new Error(health.reason);
        return health;
      } catch (error) {
        try { await revoke(); } catch (cleanup) { throw new Error(`SSH setup failed: ${error.message}; key revoked but service cleanup failed: ${cleanup.message}`); }
        throw error;
      }
  }
  return Object.freeze({
    preflight,
    async suggestAddress(proxyIp) {
      guard();
      if (isIP(proxyIp) !== 4) throw new Error("Provision the proxy before configuring host SSH.");
      const routes = JSON.parse(String((await run("ip", ["-j", "-4", "route", "get", proxyIp])).stdout));
      return routes[0]?.prefsrc;
    },
    publish: (request) => publish(request),
    revoke,
    async prepareKey({ output }) {
      guard();
      const current = readRecord();
      if (!current || current.disabled) throw new Error("Host SSH must be enabled before preparing a replacement key.");
      await preflight(current);
      if (filesystem.existsSync(file("pending_ed25519")) || filesystem.existsSync(file("pending_ed25519.pub"))) {
        throw new Error("An SSH replacement key is already prepared. Download its exported copy and activate it, or disable SSH to discard it.");
      }
      const fd = reserveExport(output);
      try {
        await keygen("pending_ed25519");
        filesystem.writeFileSync(fd, filesystem.readFileSync(file("pending_ed25519")));
        return { output };
      } catch (error) {
        discardPendingKey();
        filesystem.rmSync(output, { force: true });
        throw error;
      } finally {
        filesystem.closeSync(fd);
      }
    },
    async activateKey(request) {
      const current = await preflight(request);
      if (!current || current.disabled) throw new Error("Host SSH must be enabled before activating a replacement key.");
      if (!filesystem.existsSync(file("pending_ed25519")) || !filesystem.existsSync(file("pending_ed25519.pub"))) {
        throw new Error("No complete SSH replacement key is prepared. Run ssh prepare-key and download its exported copy first.");
      }
      // Validate the pair before touching working authorization. Derive the
      // sole authorization line instead of trusting extra lines in a public file.
      const derived = String((await run("ssh-keygen", ["-y", "-f", file("pending_ed25519")])).stdout).trim();
      const publicKey = filesystem.readFileSync(file("pending_ed25519.pub"), "utf8").trim();
      if (publicKey.split("\n").length !== 1 || publicKey.split(/\s+/).slice(0, 2).join(" ") !== derived.split(/\s+/).slice(0, 2).join(" ")) {
        throw new Error("Prepared SSH key pair does not match; working access was preserved.");
      }
      const preparedKey = { privateKey: filesystem.readFileSync(file("pending_ed25519")), publicKey: `${derived}\n` };
      return publish(request, preparedKey);
    },
    async replaceKey(request) {
      await preflight(request);
      // Reserve the export before revoking the working key. A bad destination
      // must not lock the user out, and an existing download is never overwritten.
      const fd = request.output === undefined ? undefined : reserveExport(request.output);
      try {
        await revoke();
        const result = await this.publish(request);
        if (fd !== undefined) filesystem.writeFileSync(fd, filesystem.readFileSync(file("client_ed25519")));
        return result;
      } catch (error) {
        if (fd !== undefined) filesystem.rmSync(request.output, { force: true });
        throw error;
      } finally {
        if (fd !== undefined) filesystem.closeSync(fd);
      }
    },
    async exportKey({ output }) {
      guard();
      const current = readRecord();
      assertOwned(current);
      if (current.disabled) throw new Error("SSH is disabled. Enable it to generate a new key.");
      const fd = reserveExport(output);
      try { filesystem.writeFileSync(fd, filesystem.readFileSync(file("client_ed25519"))); }
      catch (error) { filesystem.rmSync(output, { force: true }); throw error; }
      finally { filesystem.closeSync(fd); }
      return { output };
    },
    async uninstall() {
      guard();
      const current = readRecord();
      if (!current) return;
      await revoke();
      assertOwned(current);
      filesystem.rmSync(unitPath);
      await run("systemctl", ["daemon-reload"]);
      for (const name of ["record.json", "sshd_config", "authorized_keys", "client_ed25519", "client_ed25519.pub", "host_ed25519", "host_ed25519.pub", "known_hosts"]) filesystem.rmSync(file(name), { force: true });
      filesystem.rmdirSync(directory);
    },
    healthCheckExposure
  });

  function reserveExport(output) {
    if (typeof output !== "string" || !path.isAbsolute(output)) throw new Error("Choose an absolute output path for the downloaded private key.");
    return filesystem.openSync(output, "wx", 0o600);
  }
}
