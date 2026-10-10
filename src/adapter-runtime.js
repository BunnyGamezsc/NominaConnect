import { spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

import { createTcpAdapter } from "./tcp-adapter.js";
import { createCaddyAdapter } from "./caddy-adapter.js";
import { createNetBirdAdapter } from "./netbird-adapter.js";
import { createStepCaAdapter } from "./step-ca-adapter.js";
import { createTailscaleAdapter } from "./tailscale-adapter.js";
import { createTailnetController } from "./tailscale-tailnet.js";
import { createTechnitiumAdapter } from "./technitium-adapter.js";
import { createTraefikAdapter } from "./traefik-adapter.js";
import { createDockerAdapter } from "./docker-adapter.js";

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

export function createCommandRunner(options = {}) {
  const execute = options.execute;
  const spawn = options.spawn ?? spawnProcess;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Object.freeze({
    async run(command) {
      const normalized = normalizeCommand(command, defaultTimeoutMs);
      const result = redactResult(
        execute
          ? await execute({
              binary: normalized.binary,
              args: normalized.args,
              ...(normalized.stdin === undefined ? {} : { stdin: normalized.stdin })
            })
          : await executeCommand({ spawn, ...normalized }),
        normalized.redactions
      );
      const safeCommand = {
        binary: normalized.binary,
        args: normalized.args.map((argument) => redactValue(argument, normalized.redactions))
      };
      if (result.timedOut || result.exitCode !== 0) {
        throw new CommandExecutionError({ command: safeCommand, result, timedOut: result.timedOut });
      }
      return result;
    }
  });
}

export function createLocalSecretResolver(options = {}) {
  const filesystem = options.filesystem ?? fs;
  const secretsDirectory = options.secretsDirectory ?? "/var/lib/nominaconnect/secrets";
  const isRoot = options.isRoot ?? (() => process.getuid?.() === 0);
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

export function createLocalSecretStore(options = {}) {
  const filesystem = options.filesystem ?? fs;
  const secretsDirectory = options.secretsDirectory ?? "/var/lib/nominaconnect/secrets";
  const isRoot = options.isRoot ?? (() => process.getuid?.() === 0);
  const locate = (reference) => resolveSecretPath(secretsDirectory, reference);
  return Object.freeze({
    rootDirectory: path.dirname(secretsDirectory),
    locate,
    remove(reference) {
      if (!isRoot()) {
        throw new Error("Connection secrets can only be removed from the Proxmox root shell.");
      }
      filesystem.rmSync(locate(reference), { force: true });
    },
    has(reference) {
      try {
        filesystem.statSync(locate(reference));
        return true;
      } catch {
        return false;
      }
    },
    store(reference, content) {
      if (!isRoot()) {
        throw new Error("Connection secrets can only be stored from the Proxmox root shell.");
      }
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error("Connection secret values must be non-empty strings.");
      }
      const secretPath = locate(reference);
      const directory = path.dirname(secretPath);
      filesystem.mkdirSync(directory, { recursive: true });
      filesystem.writeFileSync(secretPath, content.endsWith("\n") ? content : `${content}\n`);
      filesystem.chmodSync(directory, 0o700);
      filesystem.chmodSync(secretPath, 0o600);
    }
  });
}

export class HttpRequestError extends Error {
  constructor({ url, result = undefined, timedOut = false }) {
    const status = timedOut ? "timed out" : `failed with status ${result?.status}`;
    super(`Request to ${url} ${status}.`.trim());
    this.name = "HttpRequestError";
    this.url = url;
    this.result = result;
    this.timedOut = timedOut;
  }
}

export function createHttpClient(options = {}) {
  const fetchImpl = options.fetch;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  return Object.freeze({
    async request(request) {
      const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
      const redactions = request.redactions ?? [];
      if (fetchImpl !== undefined) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetchImpl(request.url, {
            method: request.method ?? "GET",
            headers: request.headers,
            body: request.body,
            signal: controller.signal
          });
          const body = await response.text();
          return {
            status: response.status,
            body: redactValue(body, redactions)
          };
        } catch (error) {
          if (error.name === "AbortError") {
            throw new HttpRequestError({
              url: redactValue(request.url, redactions),
              timedOut: true
            });
          }
          throw error;
        } finally {
          clearTimeout(timer);
        }
      }
      // Default transport sends only the caller's headers. globalThis.fetch
      // injects browser headers (e.g. sec-fetch-mode: cors) that Caddy's
      // admin endpoint rejects with 403.
      try {
        const result = await requestViaNodeModules(
          { url: request.url, method: request.method, headers: request.headers, body: request.body, tls: request.tls },
          timeoutMs
        );
        return { status: result.status, body: redactValue(result.body, redactions) };
      } catch (error) {
        if ((/** @type {{timedOut?: boolean}} */ (error))?.timedOut === true) {
          throw new HttpRequestError({
            url: redactValue(request.url, redactions),
            timedOut: true
          });
        }
        throw error;
      }
    }
  });
}

// `tls` carries per-request trust material for providers that serve their API
// under their own private root (step-ca). Passing an explicit `ca` keeps the
// request fully validated against that root rather than disabling verification.
function requestViaNodeModules({ url, method = "GET", headers = {}, body, tls }, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === "https:" ? https : http;
    const requestOptions = { method, headers, ...(target.protocol === "https:" && tls !== undefined ? tls : {}) };
    const request = transport.request(target, requestOptions, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString("utf8")
        });
      });
    });
    const timer = setTimeout(() => {
      const timeoutError = /** @type {{timedOut?: boolean} & Error} */ (new Error(`Request to ${url} timed out.`));
      timeoutError.timedOut = true;
      request.destroy(timeoutError);
    }, timeoutMs);
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    request.on("close", () => clearTimeout(timer));
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

export function createProductionAdapters(options = {}) {
  const commandRunner = options.commandRunner ?? createCommandRunner();
  const secretResolver = options.secretResolver ?? createLocalSecretResolver();
  const secretStore = options.secretStore ?? createLocalSecretStore();
  const httpClient = options.httpClient ?? createHttpClient();
  const proxmox = createProxmoxAdapter(commandRunner);
  const caddyAdapter = createCaddyAdapter({ httpClient, secretResolver });
  // Everything but setup() is plain Caddy: the internal CA is a Caddy feature,
  // not a separate service.
  const caddyInternalCaAdapter = Object.freeze({
    ...caddyAdapter,
    deleteRoute: caddyAdapter.unpublishRoute,
    async setup(plan) {
      if (plan.connectionSecretReference !== undefined) {
        try { secretResolver.resolve(plan.connectionSecretReference); } catch {}
      }
      if (plan.provider === "caddy-internal-ca") {
        return { ...plan, lxcCommands: [{ binary: "/usr/bin/caddy", args: ["trust"] }] };
      }
      return caddyAdapter.setup(plan);
    }
  });
  const providerAdapters = Object.freeze({
    tcp: createTcpAdapter({ exec: (vmid, command) => proxmox.pctExec(vmid, command) }),
    technitium: createTechnitiumAdapter({
      httpClient,
      secretResolver,
      enableNesting: (vmid) => proxmox.enableNesting(vmid)
    }),
    caddy: caddyAdapter,
    // Traefik writes dynamic fragments inside its own LXC, so it needs the
    // same pct exec channel the Proxmox adapter uses (ADR-0032).
    traefik: createTraefikAdapter({
      httpClient,
      secretResolver,
      exec: (vmid, command) => proxmox.pctExec(vmid, command)
    }),
    "step-ca": createStepCaAdapter({ httpClient, secretResolver }),
    "caddy-internal-ca": caddyInternalCaAdapter,
    // Tailscale is driven entirely through its CLI inside the service LXC, and
    // it needs the Proxmox host to hand the container a TUN device before the
    // client can come up at all.
    tailscale: createTailscaleAdapter({
      secretResolver,
      exec: (vmid, command) => proxmox.pctExec(vmid, command),
      enableTunDevice: (vmid) => proxmox.enableTunDevice(vmid),
      tailnetController: createTailnetController({
        httpClient,
        secretResolver,
        exec: (vmid, command) => proxmox.pctExec(vmid, command)
      })
    }),
    // NetBird is driven entirely through its CLI inside the service LXC, and
    // like Tailscale it needs the Proxmox host to hand the container a TUN
    // device before the client can come up at all.
    netbird: createNetBirdAdapter({
      secretResolver,
      exec: (vmid, command) => proxmox.pctExec(vmid, command),
      enableTunDevice: (vmid) => proxmox.enableTunDevice(vmid)
    })
  });
  return Object.freeze({ proxmox, providerAdapters, secretStore, docker: createDockerAdapter(proxmox, options.retryOptions) });
}

function createProxmoxAdapter(commandRunner) {
  return Object.freeze({
    async checkIpAvailability(ip) {
      const result = await commandRunner.run({ binary: "/usr/sbin/pct", args: ["list"] });
      const matchingLine = result.stdout.split("\n").find((line) => line.includes(ip));
      if (matchingLine !== undefined) {
        const vmid = matchingLine.trim().split(/\s+/)[0];
        if (/^\d+$/.test(vmid)) {
          return { status: "known-collision", conflictWith: `lxc/${vmid}` };
        }
      }
      const vmids = result.stdout
        .split("\n")
        .slice(1)
        .map((line) => line.trim().split(/\s+/)[0])
        .filter((candidate) => /^\d+$/.test(candidate));
      for (const vmid of vmids) {
        try {
          const config = await runUnchecked(commandRunner, { binary: "/usr/sbin/pct", args: ["config", String(vmid)] });
          if (config.stdout.includes(ip)) {
            return { status: "known-collision", conflictWith: `lxc/${vmid}` };
          }
        } catch {}
      }
      return { status: "uncertain", reason: "No configured LXC collision was found; external devices and DHCP leases cannot be verified" };
    },
    async validateProvisioningPrerequisites(spec) {
      await assertStorageAvailable(commandRunner, spec.storage);
      const templateVolume = await resolveTemplateVolume(commandRunner, spec.template);
      await assertBridgeAvailable(commandRunner, spec.bridge);
      await assertUnprivilegedSupported(commandRunner, spec.unprivileged);
      const availability = await this.checkIpAvailability(spec.ip);
      if (availability.status === "known-collision") {
        throw new Error(`Requested IP ${spec.ip} is already in use (${availability.conflictWith}).`);
      }
      return { templateVolume };
    },
    async assertLocalNode(node) {
      const result = await commandRunner.run({ binary: "/usr/bin/hostname", args: ["-s"] });
      if (result.stdout.trim() !== node) throw new Error(`Configured Proxmox node ${node} is not this host. Run Nomina on the configured node.`);
    },
    async validateDockerResources(spec) {
      const storage = await commandRunner.run({ binary: "/usr/sbin/pvesm", args: ["status", "--content", "rootdir"] });
      const parts = storage.stdout.split("\n").map((line) => line.trim().split(/\s+/)).find((row) => row[0] === spec.storage);
      if (!parts || parts[2] !== "active" || !Number.isFinite(Number(parts[5])) || Number(parts[5]) < spec.resources.diskGb * 1024 * 1024) throw new Error("Selected storage must support rootdir and have enough available space for the requested Docker root disk.");
      const cpu = await commandRunner.run({ binary: "/usr/bin/nproc", args: [] });
      const memory = await commandRunner.run({ binary: "/usr/bin/awk", args: ["/MemAvailable:/ { print $2 }", "/proc/meminfo"] });
      const availableCpu = Number(cpu.stdout.trim());
      const availableMemory = Number(memory.stdout.trim());
      if (!Number.isInteger(availableCpu) || availableCpu < 1 || !Number.isFinite(availableMemory) || availableMemory <= 0 || spec.resources.cpus > availableCpu || spec.resources.memoryMb * 1024 > availableMemory) throw new Error("Requested Docker CPU/memory exceeds available host resources or host capacity could not be verified.");
      const bridge = await commandRunner.run({ binary: "/usr/bin/ip", args: ["-j", "-d", "link", "show", "dev", spec.bridge] });
      const links = JSON.parse(bridge.stdout);
      if (!links.some((link) => link.linkinfo?.info_kind === "bridge" && link.flags?.includes("UP"))) throw new Error("Docker networking requires an available, UP Linux bridge.");
    },
    async createLxc(spec, hooks = {}) {
      const { templateVolume } = await this.validateProvisioningPrerequisites(spec);
      const nextId = await commandRunner.run({ binary: "/usr/bin/pvesh", args: ["get", "/cluster/nextid"] });
      const vmid = nextId.stdout.trim();
      if (!/^\d+$/.test(vmid)) {
        throw new Error("Proxmox did not return a valid next LXC ID.");
      }
      await hooks.onAllocated?.({ vmid: Number(vmid), hostname: spec.hostname });
      const net0 = ["name=eth0", `bridge=${spec.bridge}`, `ip=${spec.ip}/${spec.prefixLength ?? 24}`];
      if (spec.gateway !== undefined) {
        net0.push(`gw=${spec.gateway}`);
      }
      await commandRunner.run({
        binary: "/usr/sbin/pct",
        args: [
          "create", vmid, templateVolume,
          "--hostname", spec.hostname,
          "--cores", String(spec.resources.cpus),
          "--memory", String(spec.resources.memoryMb),
          "--rootfs", `${spec.storage}:${spec.resources.diskGb}`,
          "--net0", net0.join(","),
          ...(spec.nameserver !== undefined ? ["--nameserver", spec.nameserver] : []),
          "--unprivileged", spec.unprivileged ? "1" : "0",
          ...(spec.features === undefined ? [] : ["--features", spec.features]),
          "--onboot", "1",
          "--start", spec.deferStart ? "0" : "1"
        ],
        // Template extraction plus first boot on slow (e.g. nested-virtualized)
        // storage routinely exceeds the 30s default; killing pct create
        // mid-extraction leaves a half-written rootfs ("received interrupt").
        timeoutMs: 600_000
      });
      await hooks.onCreated?.({ vmid: Number(vmid), hostname: spec.hostname });
      return { vmid: Number(vmid), hostname: spec.hostname };
    },
    async listTemplates() {
      return listTemplateVolumes(commandRunner);
    },
    async inspectLxc(vmid) {
      const result = await commandRunner.run({ binary: "/usr/sbin/pct", args: ["config", String(vmid)] });
      return parsePctConfig(result.stdout);
    },
    async lxcStatus(vmid) {
      const result = await commandRunner.run({ binary: "/usr/sbin/pct", args: ["status", String(vmid)] });
      return result.stdout.trim().replace(/^status:\s*/, "");
    },
    async listLxcs() {
      const result = await commandRunner.run({ binary: "/usr/sbin/pct", args: ["list"], maxOutputBytes: 65536 });
      return result.stdout.split("\n").slice(1).map((line) => line.trim().split(/\s+/))
        .filter((row) => /^\d+$/.test(row[0])).map((row) => ({ vmid: Number(row[0]), status: row[1], hostname: row.at(-1) }));
    },
    async startLxc(vmid) {
      return commandRunner.run({ binary: "/usr/sbin/pct", args: ["start", String(vmid)], timeoutMs: 180000 });
    },
    async enableDockerFeatures(vmid) {
      const config = await commandRunner.run({ binary: "/usr/sbin/pct", args: ["config", String(vmid)] });
      const current = config.stdout.match(/^features:\s*(.*)$/m)?.[1] ?? "";
      const features = new Map(current.split(",").filter(Boolean).map((entry) => entry.split("=")));
      if (features.get("nesting") === "1" && features.get("keyctl") === "1") return;
      features.set("nesting", "1");
      features.set("keyctl", "1");
      await commandRunner.run({ binary: "/usr/sbin/pct", args: ["set", String(vmid), "--features", [...features].map(([key, value]) => `${key}=${value}`).join(",")] });
      if (await this.lxcStatus(vmid) === "running") await commandRunner.run({ binary: "/usr/sbin/pct", args: ["reboot", String(vmid)], timeoutMs: 180000 });
    },
    async pctExec(vmid, command) {
      const normalized = normalizeCommand(command, DEFAULT_TIMEOUT_MS);
      return commandRunner.run({
        binary: "/usr/sbin/pct",
        args: ["exec", String(vmid), "--", normalized.binary, ...normalized.args],
        timeoutMs: normalized.timeoutMs,
        redactions: normalized.redactions,
        ...(normalized.stdin === undefined ? {} : { stdin: normalized.stdin }),
        ...(normalized.maxOutputBytes === undefined ? {} : { maxOutputBytes: normalized.maxOutputBytes, truncateOutput: normalized.truncateOutput })
      });
    },
    async supportsSnapshots() {
      return true;
    },
    async createSnapshot(vmid, snapshotName) {
      await commandRunner.run({ binary: "/usr/sbin/pct", args: ["snapshot", String(vmid), snapshotName] });
      return { vmid, snapshotName };
    },
    // Unprivileged LXCs get no TUN device by default, which every VPN client
    // needs. Proxmox 8.2+ exposes it as a device passthrough; keyctl/nesting
    // let the client's systemd unit start inside the container.
    async enableTunDevice(vmid) {
      await commandRunner.run({ binary: "/usr/sbin/pct", args: ["set", String(vmid), "--dev0", "/dev/net/tun"] });
      await commandRunner.run({ binary: "/usr/sbin/pct", args: ["set", String(vmid), "--features", "keyctl=1,nesting=1"] });
      await commandRunner.run({ binary: "/usr/sbin/pct", args: ["reboot", String(vmid)], timeoutMs: 180_000 });
      return { vmid, device: "/dev/net/tun" };
    },
    // Sandboxed systemd units (Technitium confines itself with PrivateTmp,
    // ProtectSystem=strict, ...) need userns inside the container. Without
    // nesting the unit fails with status=226/NAMESPACE on first boot.
    async enableNesting(vmid) {
      await commandRunner.run({ binary: "/usr/sbin/pct", args: ["set", String(vmid), "--features", "nesting=1"] });
      await commandRunner.run({ binary: "/usr/sbin/pct", args: ["reboot", String(vmid)], timeoutMs: 180_000 });
      return { vmid };
    },
    async stopLxc(vmid) {
      return commandRunner.run({ binary: "/usr/sbin/pct", args: ["stop", String(vmid)] });
    },
    async destroyLxc(vmid) {
      return commandRunner.run({ binary: "/usr/sbin/pct", args: ["destroy", String(vmid)] });
    }
  });
}

function normalizeCommand(command, defaultTimeoutMs) {
  if (command === null || typeof command !== "object" || Array.isArray(command)) {
    throw new Error("Commands must be an object with a fixed binary and argument array.");
  }
  const { binary, args, timeoutMs = defaultTimeoutMs, redactions = [], stdin = undefined, maxOutputBytes = undefined, truncateOutput = false } = command;
  if (typeof binary !== "string" || binary.length === 0 || binary.includes("\0")) {
    throw new Error("Command binary must be a non-empty string.");
  }
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string" || argument.includes("\0"))) {
    throw new Error("Command arguments must be an array of strings.");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Command timeout must be a positive number.");
  }
  if (stdin !== undefined && typeof stdin !== "string") {
    throw new Error("Command standard input must be a string.");
  }
  // Standard input is the only channel that carries a resolved connection
  // secret into a command: an argument array would expose it to the host
  // process list (ADR-0019).
  if (maxOutputBytes !== undefined && (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)) throw new Error("Command output limit must be a positive integer.");
  return { binary, args: [...args], timeoutMs, redactions: [...redactions], ...(stdin === undefined ? {} : { stdin }), maxOutputBytes, truncateOutput };
}

function executeCommand({ spawn, binary, args, timeoutMs, stdin = undefined, maxOutputBytes = undefined, truncateOutput = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputBytes = 0;
    let truncated = false;
    let killTimer;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    }, timeoutMs);
    function append(chunk, channel) {
      if (truncated) return;
      const bytes = Buffer.from(chunk);
      const remaining = maxOutputBytes === undefined ? bytes.length : Math.max(0, maxOutputBytes - outputBytes);
      const value = bytes.subarray(0, remaining).toString();
      if (channel === "stdout") stdout += value; else stderr += value;
      outputBytes += bytes.length;
      if (maxOutputBytes !== undefined && outputBytes > maxOutputBytes) {
        truncated = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      }
    }
    child.stdout?.on("data", (chunk) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk) => append(chunk, "stderr"));
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve({ exitCode: truncated ? (truncateOutput ? 0 : 1) : exitCode ?? 1, stdout, stderr, timedOut, truncated });
    });
    if (stdin !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(stdin);
    } else {
      child.stdin?.end();
    }
  });
}

function redactResult(result, redactions) {
  return {
    exitCode: result.exitCode ?? 1,
    stdout: redactValue(result.stdout, redactions),
    stderr: redactValue(result.stderr, redactions),
    ...(result.timedOut ? { timedOut: true } : {}),
    ...(result.truncated ? { truncated: true } : {})
  };
}

function redactValue(value, redactions) {
  return redactions.reduce(
    (output, secret) => secret === "" ? output : output.split(secret).join("[REDACTED]"),
    String(value ?? "")
  );
}

async function assertStorageAvailable(commandRunner, storage) {
  const result = await commandRunner.run({ binary: "/usr/sbin/pvesm", args: ["status"] });
  const match = result.stdout.split("\n").map((line) => line.trim().split(/\s+/)).find((parts) => parts[0] === storage);
  if (match === undefined) {
    throw new Error(`Storage ${storage} was not found. Select a storage shown by pvesm status.`);
  }
  if (match[2] !== "active") {
    throw new Error(`Storage ${storage} is not active. Repair the storage or choose another target.`);
  }
}

async function listVztmplStorages(commandRunner) {
  const status = await runUnchecked(commandRunner, { binary: "/usr/sbin/pvesm", args: ["status", "--content", "vztmpl"] });
  return (status.exitCode === 0 ? status.stdout : "")
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name !== "" && name !== "Name");
}

async function listTemplateVolumes(commandRunner) {
  const storages = await listVztmplStorages(commandRunner);
  const volumes = [];
  for (const storage of storages.length > 0 ? storages : ["local"]) {
    const listed = await runUnchecked(commandRunner, { binary: "/usr/bin/pveam", args: ["list", storage] });
    if (listed.exitCode !== 0) {
      continue;
    }
    for (const line of listed.stdout.split("\n")) {
      const volume = line.trim().split(/\s+/)[0];
      if (volume !== "") {
        volumes.push(volume);
      }
    }
  }
  return volumes;
}

async function resolveTemplateVolume(commandRunner, template) {
  const storages = await listVztmplStorages(commandRunner);
  const search = storages.length > 0 ? storages : ["local"];
  for (const storage of search) {
    const listed = await runUnchecked(commandRunner, { binary: "/usr/bin/pveam", args: ["list", storage] });
    if (listed.exitCode !== 0) {
      continue;
    }
    const volume = listed.stdout.split("\n").map((line) => line.trim().split(/\s+/)[0]).find((name) => name.includes(template));
    if (volume !== undefined) {
      return volume;
    }
  }
  throw new Error(`Template ${template} was not found on any vztmpl storage. Choose an available template during service setup, or download one with pveam.`);
}

async function assertBridgeAvailable(commandRunner, bridge) {
  const result = await runUnchecked(commandRunner, { binary: "/usr/bin/ip", args: ["-o", "link", "show", "dev", bridge] });
  if (result.exitCode !== 0) {
    throw new Error(`Bridge ${bridge} was not found. Create the bridge or choose another default network bridge.`);
  }
}

async function assertUnprivilegedSupported(commandRunner, unprivileged) {
  if (unprivileged !== true) {
    throw new Error("Dedicated service LXCs must remain unprivileged unless a plugin declares an exception.");
  }
  for (const file of ["/etc/subuid", "/etc/subgid"]) {
    const result = await runUnchecked(commandRunner, { binary: "/usr/bin/grep", args: ["^root:", file] });
    if (result.exitCode !== 0 || !result.stdout.includes("root:")) {
      throw new Error(`Unprivileged LXC prerequisites are missing: ${file} must map root subordinate IDs.`);
    }
  }
}

async function runUnchecked(commandRunner, command) {
  try {
    return await commandRunner.run(command);
  } catch (error) {
    if (error instanceof CommandExecutionError) {
      return { exitCode: error.result?.exitCode ?? 1, stdout: error.result?.stdout ?? "", stderr: error.result?.stderr ?? "" };
    }
    throw error;
  }
}

function parsePctConfig(stdout) {
  const values = {};
  for (const line of stdout.split("\n")) {
    const index = line.indexOf(":");
    if (index === -1) {
      continue;
    }
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  const net0 = values.net0 ?? "";
  return {
    hostname: values.hostname,
    unprivileged: values.unprivileged === "1",
    ip: net0.match(/ip=([^/,]+)/)?.[1],
    bridge: net0.match(/bridge=([^,]+)/)?.[1],
    nameserver: values.nameserver,
    storage: values.rootfs?.split(":")[0]
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
