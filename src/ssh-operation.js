import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const SSH_OPERATIONS_DIRECTORY = "/var/log/nominaconnect/ssh-operations";

/** SSH_CONNECTION records the accepted socket, including the destination port. */
export function isManagedSshSession(environment = process.env) {
  return environment.NOMINA_SSH_OPERATION_WORKER !== "1"
    && environment.SSH_CONNECTION?.trim().split(/\s+/)[3] === "22222";
}

/** Bun embeds its entrypoint in $bunfs; Node and uncompiled Bun need the script. */
export function cliInvocation(execPath = process.execPath, argv = process.argv) {
  const entry = argv[1];
  return !entry || entry.includes("/$bunfs/") || path.resolve(entry) === path.resolve(execPath)
    ? [execPath] : [execPath, path.resolve(entry)];
}

function assertPrivateDirectory(filesystem, directory, privateOnly = false) {
  const stat = filesystem.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== 0 || (stat.mode & (privateOnly ? 0o077 : 0o022))) {
    throw new Error(`SSH operation directory ${directory} must be a safe root-owned directory.`);
  }
}

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
    required: () => isManagedSshSession(environment),
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
