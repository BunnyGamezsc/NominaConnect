import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { loadProject, findProjectDirectory } from "./config.js";
import { updateProject } from "./project-write.js";
import { runIpPreflight, defaultGatewayFor } from "./provisioning.js";
import { createDockerAdapter, DOCKER_INSTALL_SCRIPT, validateDockerSocket, validateDockerVmid } from "./docker-adapter.js";
import { withBoundedRetry } from "./adoption.js";
import path from "node:path";

const SOCKET = "/var/run/docker.sock";
const AUTHORITY_NOTICE = "Docker socket access conveys full daemon authority. This workflow uses read-only inspection commands; it is not a permission-restricted connection.";
const DISCONNECT_NOTICE = "The LXC and its applications are retained. Existing exposures remain independently managed and keep their configured backends.";
const operations = new Map();

async function acquireOperation(filesystem, directory) {
  const key = path.resolve(directory);
  const previous = operations.get(key) ?? Promise.resolve();
  let finish = () => {};
  const hold = new Promise((resolve) => { finish = () => resolve(undefined); });
  const queued = previous.then(() => hold);
  operations.set(key, queued);
  await previous;
  let release;
  try { release = await filesystem.acquireProjectLock?.(directory, "docker-operation"); }
  catch (error) { finish(); if (operations.get(key) === queued) operations.delete(key); throw error; }
  return () => {
    try { release?.(); }
    finally { finish(); if (operations.get(key) === queued) operations.delete(key); }
  };
}

function bindings(project) { return project.config.managedInventory.dockerHosts ?? []; }
function hostByName(project, name) {
  const host = bindings(project).find((entry) => entry.name === name);
  if (!host) throw new Error(`Docker host binding ${name} was not found.`);
  return host;
}

function parseOptions(args) {
  const options = {};
  const flags = { "--name": "name", "--vmid": "vmid", "--socket": "socketPath", "--ip": "ip", "--hostname": "hostname", "--template": "template", "--bridge": "bridge", "--storage": "storage", "--gateway": "gateway", "--nameserver": "nameserver", "--cpus": "cpus", "--memory": "memoryMb", "--disk": "diskGb", "--prefix-length": "prefixLength", "--project-dir": "projectDir" };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (["--yes", "--json"].includes(flag)) { options[flag.slice(2)] = true; continue; }
    if (!(flag in flags) || args[index + 1] === undefined || args[index + 1].startsWith("--")) throw new Error(`Unknown Docker option or missing value: ${flag}.`);
    const key = flags[flag];
    if (options[key] !== undefined) throw new Error(`Repeated Docker option: ${flag}.`);
    options[key] = args[++index];
  }
  return options;
}

function validateName(name) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,62}$/.test(name) || name.endsWith("-")) throw new Error("Docker binding name must be 1-63 lowercase letters, digits or hyphens, starting with a letter and ending with a letter or digit.");
  return name;
}

function assertUnique(project, host, reference) {
  if (bindings(project).some((existing) => existing.id !== host.id && existing.name === host.name)) throw new Error(`Docker binding name ${host.name} is already in use.`);
  if (reference && bindings(project).some((existing) => {
    const ref = project.state.providerReferences?.[existing.id];
    return existing.id !== host.id && ref?.node === reference.node && Number(ref.vmid) === Number(reference.vmid)
      && (existing.socketPath === host.socketPath || ref.socketPath === reference.socketPath);
  })) throw new Error("This node/VMID/socket is already bound under another name.");
}

async function saveHost(adapters, directory, host, reference, setup) {
  return updateProject(adapters.filesystem, directory, (project) => {
    assertUnique(project, host, reference);
    project.config.managedInventory.dockerHosts = [...bindings(project).filter((entry) => entry.id !== host.id), host];
    if (reference) project.state.providerReferences = { ...project.state.providerReferences, [host.id]: reference };
    project.state.dockerHostStates = { ...project.state.dockerHostStates, [host.id]: { ...setup, updatedAt: new Date().toISOString() } };
    return project;
  });
}

async function ask(prompts, options, key, message, fallback = undefined) {
  if (options[key] !== undefined) return options[key];
  if (options.yes || !prompts?.ask) {
    if (fallback === undefined) throw new Error(`${message} is required for scripted Docker operations.`);
    return fallback;
  }
  return prompts.ask(message, fallback);
}

async function selectBinding(project, options, prompts) {
  if (options.name) return hostByName(project, options.name);
  if (!prompts?.select || options.yes) throw new Error("Docker binding name is required.");
  const hosts = bindings(project);
  if (hosts.length === 0) throw new Error("No Docker hosts are bound. Create or connect one first.");
  const name = await prompts.select({ message: "Docker host binding", options: hosts.map((host) => ({ value: host.name, label: host.name, hint: project.state.dockerHostStates?.[host.id]?.status ?? "unknown" })) });
  return hostByName(project, name);
}

async function confirm(prompts, options, message) {
  if (options.yes) return true;
  if (!prompts?.confirm) throw new Error("Use --yes to confirm this scripted operation.");
  return prompts.confirm({ message, initialValue: false });
}

export function validateDockerDeployment(spec) {
  const token = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
  if (!token.test(spec.node) || !token.test(spec.bridge) || !token.test(spec.storage) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(spec.hostname)) throw new Error("Invalid Proxmox node, bridge, storage or Docker LXC hostname.");
  if (!/^(?:[A-Za-z0-9_.-]+:vztmpl\/)?debian-13-standard(?:_[A-Za-z0-9_.-]+\.tar\.(?:zst|gz|xz))?$/.test(spec.template)) throw new Error("Docker creation requires an available Debian 13 standard template.");
  for (const field of ["ip", "gateway", "nameserver"]) {
    if (isIP(spec[field] ?? "") !== 4 || /^0\.|^127\.|^169\.254\./.test(spec[field]) || Number(spec[field].split(".")[0]) >= 224) throw new Error(`Docker ${field} must be a usable static IPv4 address.`);
  }
  if (!Number.isInteger(spec.prefixLength) || spec.prefixLength < 1 || spec.prefixLength > 30) throw new Error("Docker IPv4 prefix length must be an integer between 1 and 30.");
  const integerIp = (ip) => ip.split(".").reduce((value, octet) => (value * 256 + Number(octet)) >>> 0, 0);
  const mask = (0xffffffff << (32 - spec.prefixLength)) >>> 0;
  const ip = integerIp(spec.ip);
  const gateway = integerIp(spec.gateway);
  const network = (ip & mask) >>> 0;
  const broadcast = (network | ~mask) >>> 0;
  if (ip === network || ip === broadcast || gateway === ip || gateway === network || gateway === broadcast || ((gateway & mask) >>> 0) !== network) throw new Error("Requested IP and gateway must be distinct usable addresses in the selected subnet.");
  for (const [field, amount] of Object.entries(spec.resources)) {
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error(`Docker resource ${field} must be a positive integer.`);
  }
  return spec;
}

async function creationOptions(project, options, adapters) {
  const prompts = adapters.prompts;
  const name = validateName(await ask(prompts, options, "name", "Docker binding name"));
  const host = { id: `nc_${randomUUID()}`, name, origin: "created", socketPath: SOCKET };
  if (options.socketPath !== undefined && options.socketPath !== SOCKET) throw new Error("Created Docker hosts use /var/run/docker.sock. Custom socket paths are supported by connect.");
  assertUnique(project, host, undefined);
  const ip = await ask(prompts, options, "ip", "Requested Docker LXC static IPv4 address");
  const gateway = await ask(prompts, options, "gateway", "Gateway", defaultGatewayFor(ip));
  const dns = project.state.providerReferences?.[project.config.managedInventory.platform.dns?.id]?.ip ?? gateway;
  const templates = (await adapters.proxmox.listTemplates()).filter((value) => /(?:^|\/)debian-13-standard(?:_|$)/.test(value));
  if (templates.length === 0) throw new Error("No Debian 13 standard template is available. Download one with pveam before creating a Docker host.");
  let template = options.template;
  if (!template && !options.yes && prompts?.select) template = await prompts.select({ message: "Debian 13 standard template", options: templates.map((value) => ({ value, label: value })) });
  template ??= templates[0];
  if (!templates.some((value) => value === template || value.split("/").at(-1) === template || value.split("/").at(-1).startsWith(`${template}_`))) throw new Error("Requested Debian 13 standard template is not available.");
  const spec = validateDockerDeployment({
    node: project.config.proxmox.node, template, ip,
    gateway, nameserver: await ask(prompts, options, "nameserver", "Resolver", dns),
    hostname: await ask(prompts, options, "hostname", "Docker LXC hostname", `docker-${name}`.slice(0, 63).replace(/-$/, "")),
    bridge: await ask(prompts, options, "bridge", "Bridge", project.config.proxmox.defaultBridge),
    storage: await ask(prompts, options, "storage", "Storage", project.config.proxmox.defaultStorage),
    prefixLength: Number(await ask(prompts, options, "prefixLength", "IPv4 prefix length", 24)),
    resources: {
      cpus: Number(await ask(prompts, options, "cpus", "CPU cores", 2)),
      memoryMb: Number(await ask(prompts, options, "memoryMb", "Memory MiB", 2048)),
      diskGb: Number(await ask(prompts, options, "diskGb", "Root disk GiB", 32))
    }, unprivileged: true, features: "nesting=1,keyctl=1", deferStart: true
  });
  const { node, unprivileged, features, deferStart, ...deployment } = spec;
  host.deployment = deployment;
  return { host, spec };
}

async function setupCreatedHost(project, host, spec, adapters, retry = false) {
  const directory = project.projectDirectory;
  let reference = project.state.providerReferences?.[host.id];
  let phase = "creation";
  try {
    if (!retry) {
      await saveHost(adapters, directory, host, undefined, { status: "pending", phase });
      const created = await adapters.proxmox.createLxc(spec, {
        onAllocated: async (allocated) => {
          reference = { node: spec.node, vmid: validateDockerVmid(allocated.vmid), socketPath: host.socketPath };
          await saveHost(adapters, directory, host, reference, { status: "pending", phase });
        },
        onCreated: async (created) => {
          reference = { node: spec.node, vmid: validateDockerVmid(created.vmid), socketPath: host.socketPath };
          await saveHost(adapters, directory, host, reference, { status: "pending", phase: "installation" });
        }
      });
      reference = { node: spec.node, vmid: validateDockerVmid(created.vmid), socketPath: host.socketPath };
      // Required even for an injected adapter that does not implement hooks.
      await saveHost(adapters, directory, host, reference, { status: "pending", phase: "installation" });
    }
    if (!reference) throw new Error("No VMID was recorded; inspect Proxmox before disconnecting this pending binding and creating again.");
    phase = "LXC verification";
    const ct = await adapters.proxmox.inspectLxc(reference.vmid);
    if (ct.hostname !== host.deployment.hostname || ct.ip !== host.deployment.ip || ct.unprivileged !== true) throw new Error("The CT no longer matches the created host. Inspect it manually; no setup changes were made.");
    phase = "Docker feature setup";
    await adapters.proxmox.enableDockerFeatures(reference.vmid);
    if (await adapters.proxmox.lxcStatus(reference.vmid) !== "running") await adapters.proxmox.startLxc(reference.vmid);
    phase = "Docker installation";
    await withBoundedRetry(() => adapters.proxmox.pctExec(reference.vmid, { binary: "/usr/bin/true", args: [], timeoutMs: 10000 }), { maxRetries: 4, baseDelayMs: 500, ...adapters.retryOptions });
    await adapters.proxmox.pctExec(reference.vmid, { binary: "/bin/sh", args: ["-s"], stdin: DOCKER_INSTALL_SCRIPT, timeoutMs: 600000, maxOutputBytes: 131072 });
    phase = "Engine/Compose/Buildx verification";
    const health = await adapters.docker.verify(reference.vmid, host.socketPath, { compose: true });
    if (health.status !== "healthy") throw new Error("Engine and Compose verification did not complete.");
    reference = { ...reference, socketPath: health.canonicalSocketPath };
    await saveHost(adapters, directory, host, reference, { status: "healthy", phase: "complete" });
    return { stdout: `Docker host ${host.name} is ready on ${reference.node}/LXC ${reference.vmid}.\n`, host, providerReference: reference, health };
  } catch {
    await saveHost(adapters, directory, host, reference, { status: "pending", phase, diagnostic: `Setup did not complete during ${phase}.` });
    throw new Error(`Docker host ${host.name} is pending during ${phase}${reference ? ` on LXC ${reference.vmid}` : " with no recorded VMID"}. The CT and applications were retained. Check Proxmox/CT logs and correct this step, then run 'nomina docker retry ${host.name}'. Retry uses the recorded VMID and never creates a replacement; if no VMID exists, inspect Proxmox manually before disconnecting the pending binding.`);
  }
}

export async function handleDockerCommand(argumentsList, adapters) {
  let [action, ...args] = argumentsList;
  if (["help", "--help", "-h"].includes(action)) return { stdout: "nomina docker create --name NAME --ip IPv4 [--gateway IPv4] [--prefix-length 24] [--cpus 2] [--memory 2048] [--disk 32] [--yes]\nnomina docker connect --name NAME --vmid VMID [--socket /var/run/docker.sock] [--yes]\nnomina docker list [--json]\nnomina docker inspect NAME [--json]\nnomina docker retry NAME [--yes]\nnomina docker disconnect NAME [--yes]\nOmit values for guided prompts. Socket access grants full daemon authority; attachment uses read-only commands. Disconnect retains LXCs, applications and independent exposures. See docs/docker-hosts.md.\n" };
  if (!action) {
    if (!adapters.prompts?.select) throw new Error("Use nomina docker create|connect|list|inspect|retry|disconnect.");
    action = await adapters.prompts.select({ message: "Docker hosts", options: ["create", "connect", "list", "inspect", "retry", "disconnect"].map((value) => ({ value, label: value })) });
  }
  if (!["create", "connect", "list", "inspect", "retry", "disconnect"].includes(action)) throw new Error("Use nomina docker create|connect|list|inspect|retry|disconnect.");
  let positionalName;
  if (["inspect", "retry", "disconnect"].includes(action) && args[0] && !args[0].startsWith("--")) [positionalName, ...args] = args;
  const options = parseOptions(args);
  const allowed = {
    create: ["name", "socketPath", "ip", "hostname", "template", "bridge", "storage", "gateway", "nameserver", "cpus", "memoryMb", "diskGb", "prefixLength", "projectDir", "yes"],
    connect: ["name", "vmid", "socketPath", "projectDir", "yes"],
    list: ["projectDir", "json"], inspect: ["name", "projectDir", "json"],
    retry: ["name", "projectDir", "yes"], disconnect: ["name", "projectDir", "yes"]
  };
  for (const key of Object.keys(options)) if (!allowed[action].includes(key)) throw new Error(`Option ${key} is not supported by docker ${action}.`);
  if (positionalName && options.name) throw new Error("Specify a binding name once.");
  options.name ??= positionalName;
  const project = loadProject(adapters.filesystem, options.projectDir ?? findProjectDirectory(adapters.filesystem, adapters.cwd ?? "."));
  if (action === "list") {
    const hosts = bindings(project).map((host) => ({ ...host, providerReference: project.state.providerReferences?.[host.id], setup: project.state.dockerHostStates?.[host.id] }));
    return { hosts, stdout: options.json ? `${JSON.stringify(hosts, null, 2)}\n` : hosts.map((host) => `${host.name}: ${host.providerReference?.node ?? "?"}/LXC ${host.providerReference?.vmid ?? "unallocated"}, setup: ${host.setup?.status ?? "unknown"}${host.setup?.phase ? ` (${host.setup.phase})` : ""}, ${host.socketPath}`).join("\n") + (hosts.length ? "\n" : "No Docker hosts are bound.\n") };
  }
  if (action === "disconnect") {
    const host = await selectBinding(project, options, adapters.prompts);
    if (!await confirm(adapters.prompts, options, `Disconnect ${host.name}? ${DISCONNECT_NOTICE}`)) return { stdout: "Docker disconnection cancelled.\n", cancelled: true };
    const release = await acquireOperation(adapters.filesystem, project.projectDirectory);
    try {
      await updateProject(adapters.filesystem, project.projectDirectory, (current) => {
        const latest = hostByName(current, host.name);
        if (latest.id !== host.id) throw new Error("Binding changed during confirmation. Select it again.");
        current.config.managedInventory.dockerHosts = bindings(current).filter((entry) => entry.id !== host.id);
        delete current.state.providerReferences?.[host.id];
        delete current.state.dockerHostStates?.[host.id];
        return current;
      });
    } finally { release?.(); }
    return { stdout: `Disconnected ${host.name}. ${DISCONNECT_NOTICE}\n` };
  }
  if (!adapters.runtime?.isRoot() || !adapters.runtime?.isProxmoxHost()) throw new Error("Docker operations require the root shell on the configured Proxmox node.");
  if (!adapters.proxmox) throw new Error("Proxmox adapter is unavailable.");
  await adapters.proxmox.assertLocalNode(project.config.proxmox.node);
  adapters = { ...adapters, docker: adapters.docker ?? createDockerAdapter(adapters.proxmox, adapters.retryOptions) };
  if (action === "inspect") {
    const host = await selectBinding(project, options, adapters.prompts);
    const reference = project.state.providerReferences?.[host.id];
    if (!reference || reference.node !== project.config.proxmox.node) throw new Error("Docker binding has no provider reference on the configured node. Inspect project state before retrying.");
    const discovery = await adapters.docker.discover(reference.vmid, host.socketPath);
    return {
      discovery, host,
      stdout: options.json ? `${JSON.stringify(discovery, null, 2)}\n` : formatDiscovery(host.name, discovery)
    };
  }
  const release = await acquireOperation(adapters.filesystem, project.projectDirectory);
  try {
    const current = loadProject(adapters.filesystem, project.projectDirectory);
    if (action === "retry") {
      const host = await selectBinding(current, options, adapters.prompts);
      if (host.origin !== "created") throw new Error("Connected Docker hosts are read-only attachments. Retry setup is only for Nomina-created hosts.");
      if (current.state.dockerHostStates?.[host.id]?.status === "healthy") throw new Error("Docker host setup is already complete. Use inspect; no automatic upgrade is performed.");
      const ref = current.state.providerReferences?.[host.id];
      if (!ref || ref.node !== current.config.proxmox.node) throw new Error("No recorded VMID on this node. Inspect Proxmox manually; retry will not create a new host.");
      if (!await confirm(adapters.prompts, options, `Resume setup on existing LXC ${ref.vmid}?`)) return { stdout: "Docker retry cancelled.\n", cancelled: true };
      return await setupCreatedHost(current, host, { ...host.deployment, node: ref.node }, adapters, true);
    }
    if (action === "connect") {
      const name = validateName(await ask(adapters.prompts, options, "name", "Docker binding name"));
      const host = { id: `nc_${randomUUID()}`, name, origin: "connected", socketPath: validateDockerSocket(await ask(adapters.prompts, options, "socketPath", "Local Docker Unix socket", SOCKET)) };
      let vmid = options.vmid;
      if (!vmid && !options.yes && adapters.prompts?.select) {
        const lxcs = (await adapters.proxmox.listLxcs()).filter((ct) => ct.status === "running");
        if (!lxcs.length) throw new Error("No running LXCs are available to connect.");
        vmid = await adapters.prompts.select({ message: "Existing running Docker LXC", options: lxcs.map((ct) => ({ value: ct.vmid, label: `${ct.vmid}: ${ct.hostname}` })) });
      }
      let reference = { node: current.config.proxmox.node, vmid: validateDockerVmid(vmid), socketPath: host.socketPath };
      assertUnique(current, host, reference);
      const health = await adapters.docker.verify(reference.vmid, host.socketPath);
      if (health.status !== "healthy") throw new Error("Docker Engine verification did not complete; binding was not saved.");
      reference = { ...reference, socketPath: health.canonicalSocketPath };
      assertUnique(current, host, reference);
      if (!await confirm(adapters.prompts, options, `Connect ${name} to LXC ${reference.vmid}? ${AUTHORITY_NOTICE}`)) return { stdout: "Docker connection cancelled.\n", cancelled: true };
      await saveHost(adapters, current.projectDirectory, host, reference, { status: "healthy", phase: "connected" });
      return { stdout: `Connected ${name} to ${reference.node}/LXC ${reference.vmid}. ${AUTHORITY_NOTICE}\n`, host, providerReference: reference, health };
    }
    const { host, spec } = await creationOptions(current, options, adapters);
    await adapters.proxmox.validateProvisioningPrerequisites(spec);
    await adapters.proxmox.validateDockerResources(spec);
    const warnings = await runIpPreflight(adapters.proxmox, spec.ip);
    for (const warning of warnings) adapters.prompts?.warn?.(warning);
    if (!await confirm(adapters.prompts, options, `Create unprivileged Debian 13 Docker LXC ${spec.hostname} at ${spec.ip}/${spec.prefixLength}, gateway ${spec.gateway}, DNS ${spec.nameserver}, ${spec.resources.cpus} cores, ${spec.resources.memoryMb} MiB, ${spec.resources.diskGb} GiB on ${spec.storage}/${spec.bridge}? Nesting/keyctl will be enabled. ${AUTHORITY_NOTICE}`)) return { stdout: "Docker creation cancelled.\n", cancelled: true };
    const result = await setupCreatedHost(current, host, spec, adapters);
    return { ...result, stdout: warnings.map((warning) => `Warning: ${warning}\n`).join("") + result.stdout + `${AUTHORITY_NOTICE}\n`, warnings };
  } finally { release?.(); }
}

function formatDiscovery(name, discovery) {
  const lines = [`Docker endpoints for ${name}. ${AUTHORITY_NOTICE}`, "Container IDs are current observations. No container identity is adopted and no exposure is retargeted."];
  for (const candidate of discovery.candidates) {
    const tuple = candidate.hostPort === undefined ? "no published endpoint" : `${candidate.bindAddress}:${candidate.hostPort} -> ${candidate.containerPort}/${candidate.transport}`;
    lines.push(`${candidate.application} [${candidate.instance}] ${candidate.status}, network=${candidate.networkMode}: ${tuple}`);
    lines.push(candidate.selectable ? `  Backend ${candidate.backendAddress}:${candidate.hostPort}; application protocol requires explicit choice.` : `  ${candidate.reasons.join(" ")}`);
  }
  if (discovery.candidates.length === 0) lines.push("No container endpoints observed.");
  if (discovery.truncated) lines.push("Discovery is truncated or incomplete. Only bounded observations are shown; inspect again or use manual entry.");
  lines.push(...discovery.diagnostics);
  return lines.join("\n") + "\n";
}
