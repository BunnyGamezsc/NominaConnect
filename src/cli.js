import { randomUUID } from "node:crypto";
import { INITIAL_PLATFORM_CATALOG, certificateAuthorityIsCompatible, getPlatformProvider, hasCatalogOption } from "./catalog.js";

const DEFAULTS = Object.freeze({ dns: "technitium", certificateAuthority: "none", vpn: "none" });

export async function runCli(argumentsList, adapters) {
  const [command, ...rawOptions] = argumentsList;
  if (command !== "init") {
    throw new Error("Usage: nomina init");
  }

  return initializeProject(parseOptions(rawOptions), adapters);
}

async function initializeProject(options, adapters) {
  const { filesystem, runtime } = adapters;
  if (!runtime.isRoot()) {
    throw new Error("nomina init must run as root from the Proxmox shell.");
  }
  if (!runtime.isProxmoxHost()) {
    throw new Error("nomina init must run on a Proxmox host with local pct control.");
  }

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
  const state = {
    version: 1,
    secretReferences: {},
    providerReferences: {},
    tracking: { notices: [] }
  };
  writeAtomically(filesystem, configPath, serializeConfiguration(answers, managedInventory));
  writeAtomically(filesystem, joinPath(stateDirectory, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  filesystem.chmod(joinPath(stateDirectory, "state.json"), 0o600);

  return {
    stdout: `NominaConnect project initialized at ${configPath}.\n`,
    managedInventory,
    setupPlan,
    configPath,
    statePath: joinPath(stateDirectory, "state.json")
  };
}

function parseOptions(rawOptions) {
  const options = {};
  const optionNames = new Map([
    ["--project-dir", "projectDir"], ["--node", "node"], ["--bridge", "bridge"],
    ["--storage", "storage"], ["--domain", "domain"], ["--dns", "dns"],
    ["--reverse-proxy", "reverseProxy"], ["--ca", "certificateAuthority"], ["--vpn", "vpn"]
  ]);

  for (let index = 0; index < rawOptions.length; index += 2) {
    const key = optionNames.get(rawOptions[index]);
    const value = rawOptions[index + 1];
    if (!key || value === undefined || value.startsWith("--")) {
      throw new Error(`Unknown or incomplete option: ${rawOptions[index] ?? ""}`);
    }
    options[key] = value;
  }
  return options;
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

function createSetupPlan(inventory, providerAdapters = {}) {
  const selectedProviders = Object.values(inventory.platform).filter((item) => item !== null);
  return selectedProviders.map((managedItem) => {
    const plugin = getPlatformProvider(managedItem.service);
    const adapter = providerAdapters[managedItem.service] ?? {
      setup: ({ provider, managedItem: item }) => ({ action: "setup", provider, managedItemId: item.id })
    };
    return plugin.setup(adapter, managedItem);
  });
}

function serializeConfiguration(answers, inventory) {
  const lines = [
    "apiVersion: nomina.connect/v0alpha1",
    "kind: NominaConnect",
    "proxmox:",
    `  node: ${yamlScalar(answers.node)}`,
    `  defaultBridge: ${yamlScalar(answers.bridge)}`,
    `  defaultStorage: ${yamlScalar(answers.storage)}`,
    `baseLocalDomain: ${yamlScalar(answers.domain)}`,
    "managedInventory:",
    "  platform:"
  ];
  appendService(lines, "    dns", inventory.platform.dns);
  appendService(lines, "    reverseProxy", inventory.platform.reverseProxy);
  appendService(lines, "    certificateAuthority", inventory.platform.certificateAuthority);
  appendService(lines, "    vpn", inventory.platform.vpn);
  lines.push("  services: []", "");
  return lines.join("\n");
}

function appendService(lines, field, service) {
  if (service === null) {
    lines.push(`${field}: null`);
    return;
  }
  lines.push(`${field}:`, `      id: ${service.id}`, `      service: ${service.service}`);
}

function yamlScalar(value) {
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : JSON.stringify(value);
}

function isDomain(value) {
  return /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(value);
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
