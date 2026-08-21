import { spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;

export class CommandExecutionError extends Error {
  constructor({ command, result, timedOut = false }) {
    const status = timedOut ? "timed out" : `exited with status ${result.exitCode}`;
    super(`${command.binary} ${command.args.join(" ")} ${status}. ${result.stderr || result.stdout}`.trim());
    this.name = "CommandExecutionError";
    this.command = command;
    this.result = result;
    this.timedOut = timedOut;
  }
}

export function createCommandRunner({
  execute,
  spawn = spawnProcess,
  defaultTimeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  return Object.freeze({
    async run(command) {
      const normalized = normalizeCommand(command, defaultTimeoutMs);
      const result = redactResult(
        execute
          ? await execute({ binary: normalized.binary, args: normalized.args })
          : await executeCommand({ spawn, ...normalized }),
        normalized.redactions
      );
      const safeCommand = { binary: normalized.binary, args: normalized.args };
      if (result.timedOut || result.exitCode !== 0) {
        throw new CommandExecutionError({ command: safeCommand, result, timedOut: result.timedOut });
      }
      return result;
    }
  });
}

export function createLocalSecretResolver({
  filesystem = fs,
  secretsDirectory = "/var/lib/nominaconnect/secrets",
  isRoot = () => process.getuid?.() === 0
} = {}) {
  return Object.freeze({
    resolve(reference) {
      if (!isRoot()) {
        throw new Error("Connection secrets can only be resolved from the Proxmox root shell.");
      }
      const secretPath = resolveSecretPath(secretsDirectory, reference);
      const metadata = filesystem.statSync(secretPath);
      if (metadata.uid !== 0 || (metadata.mode & 0o077) !== 0) {
        throw new Error(`Connection secret ${reference} must be root-owned and mode 0600.`);
      }
      return String(filesystem.readFileSync(secretPath, "utf8")).replace(/[\r\n]+$/, "");
    }
  });
}

export function createProductionAdapters({
  commandRunner = createCommandRunner(),
  secretResolver = createLocalSecretResolver()
} = {}) {
  const proxmox = createProxmoxAdapter(commandRunner);
  const providerAdapters = Object.freeze(Object.fromEntries([
    "technitium", "caddy", "traefik", "step-ca", "caddy-internal-ca", "tailscale", "netbird"
  ].map((provider) => [provider, createProviderAdapter(provider, secretResolver)])));
  return Object.freeze({ proxmox, providerAdapters });
}

function createProxmoxAdapter(commandRunner) {
  return Object.freeze({
    async checkIpAvailability(ip) {
      const result = await commandRunner.run({ binary: "/usr/sbin/pct", args: ["list"] });
      const matchingLine = result.stdout.split("\n").find((line) => line.includes(ip));
      if (matchingLine === undefined) {
        return { status: "available" };
      }
      const vmid = matchingLine.trim().split(/\s+/)[0];
      return { status: "known-collision", conflictWith: `lxc/${vmid}` };
    },
    async createLxc(spec) {
      const nextId = await commandRunner.run({ binary: "/usr/bin/pvesh", args: ["get", "/cluster/nextid"] });
      const vmid = nextId.stdout.trim();
      if (!/^\d+$/.test(vmid)) {
        throw new Error("Proxmox did not return a valid next LXC ID.");
      }
      await commandRunner.run({
        binary: "/usr/sbin/pct",
        args: [
          "create", vmid, spec.template,
          "--hostname", spec.hostname,
          "--cores", String(spec.resources.cpus),
          "--memory", String(spec.resources.memoryMb),
          "--rootfs", `${spec.storage}:${spec.resources.diskGb}`,
          "--net0", `name=eth0,bridge=${spec.bridge},ip=${spec.ip}/24`,
          "--unprivileged", spec.unprivileged ? "1" : "0",
          "--start", "1"
        ]
      });
      return { vmid: Number(vmid), hostname: spec.hostname };
    },
    async pctExec(vmid, command) {
      const normalized = normalizeCommand(command, DEFAULT_TIMEOUT_MS);
      return commandRunner.run({
        binary: "/usr/sbin/pct",
        args: ["exec", String(vmid), "--", normalized.binary, ...normalized.args],
        timeoutMs: normalized.timeoutMs,
        redactions: normalized.redactions
      });
    },
    async supportsSnapshots() {
      return true;
    },
    async createSnapshot(vmid, snapshotName) {
      await commandRunner.run({ binary: "/usr/sbin/pct", args: ["snapshot", String(vmid), snapshotName] });
      return { vmid, snapshotName };
    },
    async stopLxc(vmid) {
      return commandRunner.run({ binary: "/usr/sbin/pct", args: ["stop", String(vmid)] });
    },
    async destroyLxc(vmid) {
      return commandRunner.run({ binary: "/usr/sbin/pct", args: ["destroy", String(vmid)] });
    }
  });
}

function createProviderAdapter(provider, secretResolver) {
  const packageName = provider === "caddy-internal-ca" ? "caddy" : provider;
  const installCommands = provider === "caddy-internal-ca"
    ? [{ binary: "/usr/bin/caddy", args: ["trust"] }]
    : [
        { binary: "/usr/bin/apt-get", args: ["update"] },
        { binary: "/usr/bin/apt-get", args: ["install", "--yes", packageName] }
      ];
  return Object.freeze({
    async setup(plan) {
      resolveConfiguredSecret(secretResolver, plan);
      return { ...plan, lxcCommands: installCommands };
    },
    async upgrade(plan) {
      resolveConfiguredSecret(secretResolver, plan);
      return {
        ...plan,
        lxcCommands: [{ binary: "/usr/bin/apt-get", args: ["install", "--only-upgrade", "--yes", packageName] }]
      };
    },
    async inspect() {
      return { resources: [] };
    },
    async adopt(request) {
      return { managedInventoryUpdate: request.managed };
    },
    async healthCheck() {
      return { process: "unknown", endpoint: "unknown" };
    }
  });
}

function resolveConfiguredSecret(secretResolver, plan) {
  if (plan.connectionSecretReference !== undefined) {
    secretResolver.resolve(plan.connectionSecretReference);
  }
}

function normalizeCommand(command, defaultTimeoutMs) {
  if (command === null || typeof command !== "object" || Array.isArray(command)) {
    throw new Error("Commands must be an object with a fixed binary and argument array.");
  }
  const { binary, args, timeoutMs = defaultTimeoutMs, redactions = [] } = command;
  if (typeof binary !== "string" || binary.length === 0 || binary.includes("\0")) {
    throw new Error("Command binary must be a non-empty string.");
  }
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
    throw new Error("Command arguments must be an array of strings.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Command timeout must be a positive number.");
  }
  return { binary, args: [...args], timeoutMs, redactions: [...redactions] };
}

function executeCommand({ spawn, binary, args, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode: exitCode ?? 1, stdout, stderr, timedOut });
    });
  });
}

function redactResult(result, redactions) {
  const redact = (value) => redactions.reduce(
    (output, secret) => secret === "" ? output : output.split(secret).join("[REDACTED]"),
    String(value ?? "")
  );
  return {
    exitCode: result.exitCode ?? 1,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
    ...(result.timedOut ? { timedOut: true } : {})
  };
}

function resolveSecretPath(secretsDirectory, reference) {
  if (typeof reference !== "string" || reference.length === 0 || path.isAbsolute(reference)) {
    throw new Error("Connection secret references must be relative secret references.");
  }
  const segments = reference.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Connection secret references must be relative secret references.");
  }
  return path.join(secretsDirectory, ...segments);
}
