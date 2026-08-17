import { randomUUID } from "node:crypto";
import { INITIAL_PLATFORM_CATALOG, certificateAuthorityIsCompatible, hasCatalogOption } from "./catalog.js";
import {
  loadProject,
  serializeProjectConfiguration,
  updatePlatformDeployment
} from "./config.js";
import { getPlatformProvider } from "./providers.js";
import { provisionPlatformService } from "./provisioning.js";

const DEFAULTS = Object.freeze({ dns: "technitium", certificateAuthority: "none", vpn: "none" });

export async function runCli(argumentsList, adapters) {
  const [command, ...rest] = argumentsList;
  switch (command) {
    case "init":
      return initializeProject(parseInitOptions(rest), adapters);
    case "service":
      return handleServiceCommand(rest, adapters);
    default:
      throw new Error("Usage: nomina init | nomina service add <name>");
  }
}

async function handleServiceCommand(argumentsList, adapters) {
  const [subcommand, serviceName, ...rawOptions] = argumentsList;
  if (subcommand !== "add") {
    throw new Error("Usage: nomina service add <name>");
  }
  if (serviceName === "technitium") {
    return addTechnitiumService(parseServiceAddOptions(rawOptions), adapters);
  }
  throw new Error(`Unsupported service: ${serviceName}.`);
}

async function addTechnitiumService(options, adapters) {
  const { filesystem, runtime, proxmox, providerAdapters = {} } = adapters;
  assertProxmoxShell(runtime);

  const projectDirectory = options.projectDir ?? ".";
  const project = loadProject(filesystem, projectDirectory);
  const dnsService = project.config.managedInventory.platform.dns;
  if (dnsService?.service !== "technitium") {
    throw new Error("Technitium is not selected as the DNS provider for this project.");
  }
  if (project.state.providerReferences[dnsService.id] !== undefined) {
    throw new Error("Technitium is already provisioned for this project.");
  }
  if (options.ip === undefined) {
    throw new Error("Requested service IP is required (--ip).");
  }
  if (!isIpAddress(options.ip)) {
    throw new Error(`Invalid requested service IP: ${options.ip}.`);
  }

  const providerAdapter = providerAdapters.technitium;
  if (providerAdapter === undefined) {
    throw new Error("Technitium provider adapter is unavailable.");
  }
  if (proxmox === undefined) {
    throw new Error("Proxmox adapter is unavailable.");
  }

  const result = await provisionPlatformService({
    project,
    platformKey: "dns",
    serviceName: "technitium",
    managedItem: dnsService,
    options,
    proxmox,
    providerAdapter
  });

  const deployment = {
    ip: options.ip,
    hostname: result.lxcSpec.hostname,
    bridge: result.lxcSpec.bridge,
    storage: result.lxcSpec.storage,
    resources: result.lxcSpec.resources
  };
  const updatedConfig = updatePlatformDeployment(project.config, "dns", deployment);
  const updatedState = {
    ...project.state,
    providerReferences: {
      ...project.state.providerReferences,
      [dnsService.id]: result.providerReference
    }
  };

  writeAtomically(filesystem, project.configPath, serializeProjectConfiguration(updatedConfig));
  writeAtomically(filesystem, project.statePath, `${JSON.stringify(updatedState, null, 2)}\n`);
  filesystem.chmod(project.statePath, 0o600);

  const warningText = result.warnings.length > 0
    ? `\nWarning: ${result.warnings.join("\nWarning: ")}\n`
    : "";
  const healthLabel = result.health.status === "healthy" ? "healthy" : "unhealthy";
  const inspectedCount = result.inspection.managed.length;

  return {
    stdout: `${warningText}Technitium provisioned at ${options.ip} on ${result.lxcSpec.hostname} (vmid ${result.providerReference.vmid}). Inspected ${inspectedCount} managed DNS resource(s). Health: ${healthLabel}.\n`,
    warnings: result.warnings,
    health: result.health,
    inspection: result.inspection,
    lxcSpec: result.lxcSpec,
    providerReference: result.providerReference
  };
}

async function initializeProject(options, adapters) {
  const { filesystem, runtime } = adapters;
  assertProxmoxShell(runtime);

  const projectDirectory = options.projectDir ?? ".";
  const configPath = joinPath(projectDirectory, "nomina.yaml");
  if (filesystem.exists(configPath)) {
    throw new Error(`A NominaConnect project already exists at ${configPath}.`);
  }

  const answers = await resolveAnswers(options, adapters.prompts);
  validateAnswers(answers);

  const stateDirectory = joinPath(projectDirectory, ".nomina");
  filesystem.mkdir(projectDirectory);
  filesystem.mkdir(stateDirectory);
  filesystem.chmod(stateDirectory, 0o700);

  const managedInventory = createManagedInventory(answers);
  const setupPlan = createSetupPlan(managedInventory, adapters.providerAdapters);
  const secretReferences = createSecretReferences(managedInventory);
  const state = {
    version: 1,
    providerReferences: {},
    tracking: { notices: [] }
  };
  writeAtomically(filesystem, joinPath(stateDirectory, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  filesystem.chmod(joinPath(stateDirectory, "state.json"), 0o600);
  writeAtomically(
    filesystem,
    configPath,
    serializeProjectConfiguration({
      proxmox: {
        node: answers.node,
        defaultBridge: answers.bridge,
        defaultStorage: answers.storage
      },
      baseLocalDomain: answers.domain,
      managedInventory,
      connectionSecretReferences: secretReferences
    })
  );

  return {
    stdout: `NominaConnect project initialized at ${configPath}.\n`,
    managedInventory,
    setupPlan,
    configPath,
    statePath: joinPath(stateDirectory, "state.json")
  };
}

function parseInitOptions(rawOptions) {
  const options = {};
  const optionNames = new Map([
    ["--project-dir", "projectDir"], ["--node", "node"], ["--bridge", "bridge"],
    ["--storage", "storage"], ["--domain", "domain"], ["--dns", "dns"],
    ["--reverse-proxy", "reverseProxy"], ["--ca", "certificateAuthority"], ["--vpn", "vpn"]
  ]);
  parseFlagOptions(rawOptions, optionNames, options);
  return options;
}

function parseServiceAddOptions(rawOptions) {
  const options = {};
  const optionNames = new Map([
    ["--project-dir", "projectDir"],
    ["--ip", "ip"],
    ["--bridge", "bridge"],
    ["--storage", "storage"],
    ["--hostname", "hostname"],
    ["--cpus", "cpus"],
    ["--memory", "memoryMb"],
    ["--disk", "diskGb"]
  ]);
  parseFlagOptions(rawOptions, optionNames, options);
  if (options.cpus !== undefined) options.cpus = Number(options.cpus);
  if (options.memoryMb !== undefined) options.memoryMb = Number(options.memoryMb);
  if (options.diskGb !== undefined) options.diskGb = Number(options.diskGb);
  return options;
}

function parseFlagOptions(rawOptions, optionNames, options) {
  for (let index = 0; index < rawOptions.length; index += 2) {
    const key = optionNames.get(rawOptions[index]);
    const value = rawOptions[index + 1];
    if (!key || value === undefined || value.startsWith("--")) {
      throw new Error(`Unknown or incomplete option: ${rawOptions[index] ?? ""}`);
    }
    options[key] = value;
  }
}

async function resolveAnswers(options, prompts) {
  const ask = async (field, question, fallback) => {
    if (options[field] !== undefined) return options[field];
    if (prompts?.ask) return prompts.ask(question, fallback);
    return fallback;
  };

  const node = await ask("node", "Proxmox node", undefined);
  const bridge = await ask("bridge", "Default network bridge", undefined);
  const storage = await ask("storage", "Default storage target", undefined);
  const domain = await ask("domain", "Base local domain", undefined);
  const dns = await ask("dns", choicePrompt("DNS provider", "dns"), DEFAULTS.dns);
  const reverseProxy = await ask("reverseProxy", choicePrompt("Reverse proxy", "reverseProxy"), undefined);
  const certificateAuthority = await ask(
    "certificateAuthority",
    choicePrompt("Certificate authority", "certificateAuthority", reverseProxy),
    DEFAULTS.certificateAuthority
  );
  const vpn = await ask("vpn", choicePrompt("VPN provider", "vpn"), DEFAULTS.vpn);

  return { node, bridge, storage, domain, dns, reverseProxy, certificateAuthority, vpn };
}

function choicePrompt(label, category, reverseProxy = undefined) {
  const options = INITIAL_PLATFORM_CATALOG[category]
    .filter((option) => option.compatibleWith === undefined || option.compatibleWith.includes(reverseProxy))
    .map((option) => `${option.name} — ${option.description}`);
  if (category === "certificateAuthority" || category === "vpn") {
    options.unshift("none — skip this optional platform layer");
  }
  return `${label} (${options.join("; ")})`;
}

function validateAnswers(answers) {
  for (const [field, value] of Object.entries(answers)) {
    if (value === undefined || value === "") throw new Error(`${field} is required.`);
  }
  if (!hasCatalogOption("dns", answers.dns)) throw new Error(`Unsupported DNS provider: ${answers.dns}.`);
  if (!hasCatalogOption("reverseProxy", answers.reverseProxy)) throw new Error(`Unsupported reverse proxy: ${answers.reverseProxy}.`);
  if (!hasCatalogOption("vpn", answers.vpn) && answers.vpn !== "none") throw new Error(`Unsupported VPN provider: ${answers.vpn}.`);
  if (!certificateAuthorityIsCompatible(answers.certificateAuthority, answers.reverseProxy)) {
    throw new Error(`${answers.certificateAuthority} is not compatible with ${answers.reverseProxy}.`);
  }
  if (!isDomain(answers.domain)) throw new Error("base local domain must be a valid local DNS suffix.");
}

function createManagedInventory(answers) {
  const service = (name) => ({ id: `nc_${randomUUID()}`, service: name });
  return {
    platform: {
      dns: service(answers.dns),
      reverseProxy: service(answers.reverseProxy),
      certificateAuthority: answers.certificateAuthority === "none" ? null : service(answers.certificateAuthority),
      vpn: answers.vpn === "none" ? null : service(answers.vpn)
    },
    services: []
  };
}

function createSecretReferences(inventory) {
  return Object.values(inventory.platform)
    .filter((item) => item !== null)
    .reduce((references, item) => ({
      ...references,
      [item.id]: `nominaconnect/provider/${item.id}`
    }), {});
}

const PLAN_ONLY_ADAPTER = Object.freeze({
  setup: (plan) => plan
});

function createSetupPlan(inventory, providerAdapters = {}) {
  const selectedProviders = Object.values(inventory.platform).filter((item) => item !== null);
  return selectedProviders.map((managedItem) => {
    const plugin = getPlatformProvider(managedItem.service);
    const adapter = providerAdapters[managedItem.service] ?? PLAN_ONLY_ADAPTER;
    return plugin.setup(adapter, managedItem);
  });
}

function assertProxmoxShell(runtime) {
  if (!runtime.isRoot()) {
    throw new Error("nomina must run as root from the Proxmox shell.");
  }
  if (!runtime.isProxmoxHost()) {
    throw new Error("nomina must run on a Proxmox host with local pct control.");
  }
}

function isDomain(value) {
  return /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(value);
}

function isIpAddress(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value);
}

function writeAtomically(filesystem, destination, content) {
  const temporaryPath = `${destination}.tmp-${randomUUID()}`;
  filesystem.writeFile(temporaryPath, content);
  filesystem.rename(temporaryPath, destination);
}

function joinPath(...parts) {
  return parts.join("/").replaceAll(/\/{2,}/g, "/");
}

export { INITIAL_PLATFORM_CATALOG, getPlatformProvider };
