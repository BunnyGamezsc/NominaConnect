import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HOST_SSH_PID_FILE } from "./host-ssh-adapter.js";

export const SSH_OPERATIONS_DIRECTORY = "/var/log/nominaconnect/ssh-operations";

/** Detect managed logins even when sudo/su clears SSH_CONNECTION or PAM changes cgroups. */
export function isManagedSshSession(environment = process.env, { filesystem = fs, pid = process.pid, platform = process.platform } = {}) {
  if (environment.NOMINA_SSH_OPERATION_WORKER === "1") return false;
  if (environment.SSH_CONNECTION?.trim().split(/\s+/)[3] === "22222") return true;
  if (platform !== "linux") return false;
  let daemon;
  try {
    const stat = filesystem.lstatSync(HOST_SSH_PID_FILE);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error("Unsafe managed daemon PID file.");
    daemon = Number(filesystem.readFileSync(HOST_SSH_PID_FILE, "utf8").trim());
    if (!Number.isSafeInteger(daemon) || daemon <= 1) throw new Error("Invalid managed daemon PID.");
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new Error(`Cannot determine managed SSH session: ${error.message}`);
  }
  // sudo/su keep process ancestry even when their child has a new environment
  // or session scope. A root-owned daemon PID avoids matching arbitrary names.
  const seen = new Set();
  while (pid > 1) {
    if (pid === daemon) return true;
    if (seen.has(pid) || seen.size >= 256) throw new Error("Cannot determine managed SSH session: invalid process ancestry.");
    seen.add(pid);
    try {
      const stat = filesystem.readFileSync(`/proc/${pid}/stat`, "utf8");
      // The command name may itself contain spaces and closing parentheses.
      const end = stat.lastIndexOf(")");
      const parent = Number(stat.slice(end + 1).trim().split(/\s+/)[1]);
      if (end < 0 || !Number.isSafeInteger(parent) || parent < 0) throw new Error("Invalid process parent.");
      pid = parent;
    } catch (error) {
      throw new Error(`Cannot determine managed SSH session: ${error.message}`);
    }
  }
  return false;
}

/** Bun embeds its entrypoint in $bunfs; Node and uncompiled Bun need the script. */
export function cliInvocation(execPath = process.execPath, argv = process.argv) {
  const entry = argv[1];
  return !entry || entry.includes("/$bunfs/") || path.resolve(entry) === path.resolve(execPath)
    ? [execPath] : [execPath, path.resolve(entry)];
}

/** Reject unsafe status/log directories before creating or replacing operation files. */
function assertPrivateDirectory(filesystem, directory, privateOnly = false) {
  const stat = filesystem.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== 0 || (stat.mode & (privateOnly ? 0o077 : 0o022))) {
    throw new Error(`SSH operation directory ${directory} must be a safe root-owned directory.`);
  }
}

/** Atomically persist worker progress in a root-private file outside project recovery state. */
export function writeSshOperationStatus(statusPath, state, detail = undefined, filesystem = fs) {
  assertPrivateDirectory(filesystem, path.dirname(statusPath), true);
  const stat = filesystem.lstatSync(statusPath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== 0 || (stat.mode & 0o077)) throw new Error("Unsafe SSH operation status file.");
  const temporary = `${statusPath}.${randomUUID()}.tmp`;
  try {
    filesystem.writeFileSync(temporary, `${JSON.stringify({ state, ...(detail ? { detail } : {}), updatedAt: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
    filesystem.renameSync(temporary, statusPath);
  } finally { filesystem.rmSync(temporary, { force: true }); }
}

/** systemd owns the entire operation, outside the SSH process tree and cgroup. */
export function createSshOperationController({ commandRunner, filesystem = fs, environment = process.env,
  directory = SSH_OPERATIONS_DIRECTORY, invocation = cliInvocation(), announce = (message) => { process.stdout.write(message); } }) {
  return Object.freeze({
    required: () => isManagedSshSession(environment, { filesystem }),
    /** Schedule a fully resolved CLI command with independent stdio and durable status paths. */
    async launch({ args, projectDirectory }) {
      const parent = path.dirname(directory);
      if (!filesystem.existsSync(parent)) filesystem.mkdirSync(parent, { mode: 0o700 });
      assertPrivateDirectory(filesystem, parent);
      if (!filesystem.existsSync(directory)) filesystem.mkdirSync(directory, { mode: 0o700 });
      assertPrivateDirectory(filesystem, directory, true);
      const id = randomUUID();
      const status = path.join(directory, `${id}.json`);
      const log = path.join(directory, `${id}.log`);
      const unit = `nomina-ssh-operation-${id}`;
      filesystem.writeFileSync(status, "{}\n", { flag: "wx", mode: 0o600 });
      filesystem.writeFileSync(log, "", { flag: "wx", mode: 0o600 });
      writeSshOperationStatus(status, "scheduled", undefined, filesystem);
      const stdout = `SSH operation scheduled independently of this connection; managed SSH sessions may disconnect.\nStatus: ${status}\nLog: ${log}\nFor key rotation, download the prepared replacement before activation.\n`;
      // Announce before starting: revocation may close stdout immediately.
      announce(stdout);
      try {
        await commandRunner.run({ binary: "systemd-run", args: ["--quiet", "--collect", `--unit=${unit}`,
          "--on-active=2s", "--timer-property=AccuracySec=100ms", "--property=Type=exec",
          "--property=StandardInput=null", `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`,
          `--working-directory=${path.resolve(projectDirectory)}`, "--setenv=NOMINA_SSH_OPERATION_WORKER=1",
          `--setenv=NOMINA_SSH_OPERATION_STATUS=${status}`, "--", ...invocation, ...args], timeoutMs: 30_000 });
      } catch (error) {
        writeSshOperationStatus(status, "failed", error.message, filesystem);
        throw error;
      }
      return { stdout: "", detached: true, operation: { unit, status, log } };
    }
  });
}

/** Always record completion, including CLI errors, after project/secret deletion. */
export async function runSshOperationWorker(run, { environment = process.env, filesystem = fs } = {}) {
  const status = environment.NOMINA_SSH_OPERATION_WORKER === "1" ? environment.NOMINA_SSH_OPERATION_STATUS : undefined;
  if (!status || !path.isAbsolute(status)) throw new Error("Detached SSH operation has no absolute status path.");
  writeSshOperationStatus(status, "running", undefined, filesystem);
  let failure;
  try { return await run(); }
  catch (error) { failure = error; throw error; }
  finally { writeSshOperationStatus(status, failure ? "failed" : "succeeded", failure?.message, filesystem); }
}
