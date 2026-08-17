import { randomUUID } from "node:crypto";
import { INITIAL_PLATFORM_CATALOG, certificateAuthorityIsCompatible, hasCatalogOption } from "./catalog.js";
import {
  loadProject,
  serializeProjectConfiguration,
  updatePlatformDeployment,
  upsertManagedExposure
} from "./config.js";
import { publishManagedExposure } from "./exposure.js";
import { getPlatformProvider } from "./providers.js";
import { provisionPlatformService } from "./provisioning.js";
import {
  promptCaddyOptions,
  promptExposureOptions,
  promptInitOptions,
  promptServiceName,
  promptTechnitiumOptions,
  promptTraefikOptions
} from "./tui.js";

export async function runCli(argumentsList, adapters) {
  if (argumentsList.length === 0) {
    if (adapters.interactive?.run === undefined) {
      throw new Error("Run nomina from an interactive terminal, or pass a command such as init or service add.");
    }
    return adapters.interactive.run(adapters);
  }

  const [command, ...rest] = argumentsList;
  switch (command) {
    case "init":
      return initializeProject(parseInitOptions(rest), adapters);
    case "service":
      return handleServiceCommand(rest, adapters);
    case "exposure":
      return handleExposureCommand(rest, adapters);
    default:
      throw new Error("Unknown command. Run nomina for the interactive menu.");
  }
}

async function handleServiceCommand(argumentsList, adapters) {
  const [subcommand, ...rest] = argumentsList;
  if (subcommand !== "add") {
    throw new Error("Run nomina for the interactive menu, or use: nomina service add <name>");
  }

  const [serviceName, ...rawOptions] = rest[0]?.startsWith("--") ? [undefined, ...rest] : rest;
  const options = parseServiceAddOptions(rawOptions);
  let resolvedServiceName = serviceName;
  if (resolvedServiceName === undefined) {
    const project = loadProject(adapters.filesystem, options.projectDir);
    resolvedServiceName = await promptServiceName(project, adapters.prompts);
  }

  if (resolvedServiceName === "technitium") {
    return addTechnitiumService(options, adapters);
  }
  if (resolvedServiceName === "caddy") {
    return addCaddyService(options, adapters);
  }
  if (resolvedServiceName === "traefik") {
    return addTraefikService(options, adapters);
  }
  throw new Error(`Unsupported service: ${resolvedServiceName}.`);
}

async function handleExposureCommand(argumentsList, adapters) {
  const [subcommand, ...rest] = argumentsList;
  if (subcommand !== "publish") {
    throw new Error("Run nomina for the interactive menu, or use: nomina exposure publish");
  }
  return publishExposure(parseExposurePublishOptions(rest), adapters);
}

async function addTechnitiumService(options, adapters) {
  const { filesystem, runtime, proxmox, providerAdapters = {} } = adapters;
  assertProxmoxShell(runtime);

  const project = loadProject(filesystem, options.projectDir);
  const resolvedOptions = await promptTechnitiumOptions(project, options, adapters.prompts);
  const dnsService = project.config.managedInventory.platform.dns;
  if (dnsService?.service !== "technitium") {
    throw new Error("Technitium is not selected as the DNS provider for this project.");
  }
  if (project.state.providerReferences[dnsService.id] !== undefined) {
    throw new Error("Technitium is already provisioned for this project.");
  }
  if (resolvedOptions.ip === undefined) {
    throw new Error("Static IP is required.");
  }
  if (!isIpAddress(resolvedOptions.ip)) {
    throw new Error(`Invalid static IP: ${resolvedOptions.ip}.`);
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
    options: resolvedOptions,
    proxmox,
    providerAdapter
  });

  const deployment = {
    ip: resolvedOptions.ip,
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

  return {
    ...formatPlatformProvisionResult({
      serviceLabel: "Technitium",
      ip: resolvedOptions.ip,
      hostname: result.lxcSpec.hostname,
      providerReference: result.providerReference,
      warnings: result.warnings,
      health: result.health,
      inspectedCount: result.inspection.managed.length,
      inspectedLabel: "managed DNS resource(s)"
    }),
    inspection: result.inspection,
    lxcSpec: result.lxcSpec,
    providerReference: result.providerReference
  };
}

async function addReverseProxyService(serviceName, serviceLabel, promptOptions, options, adapters) {
  const { filesystem, runtime, proxmox, providerAdapters = {} } = adapters;
  assertProxmoxShell(runtime);

  const project = loadProject(filesystem, options.projectDir);
  const resolvedOptions = await promptOptions(project, options, adapters.prompts);
  const dnsService = project.config.managedInventory.platform.dns;
  const proxyService = project.config.managedInventory.platform.reverseProxy;
  if (proxyService?.service !== serviceName) {
    throw new Error(`${serviceLabel} is not selected as the reverse proxy for this project.`);
  }
  if (project.state.providerReferences[dnsService?.id] === undefined) {
    throw new Error(`Technitium must be provisioned before ${serviceLabel}.`);
  }
  if (project.state.providerReferences[proxyService.id] !== undefined) {
    throw new Error(`${serviceLabel} is already provisioned for this project.`);
  }
  if (resolvedOptions.ip === undefined) {
    throw new Error("Static IP is required.");
  }
  if (!isIpAddress(resolvedOptions.ip)) {
    throw new Error(`Invalid static IP: ${resolvedOptions.ip}.`);
  }

  const providerAdapter = providerAdapters[serviceName];
  if (providerAdapter === undefined) {
    throw new Error(`${serviceLabel} provider adapter is unavailable.`);
  }
  if (proxmox === undefined) {
    throw new Error("Proxmox adapter is unavailable.");
  }

  const result = await provisionPlatformService({
    project,
    platformKey: "reverseProxy",
    serviceName,
    managedItem: proxyService,
    options: resolvedOptions,
    proxmox,
    providerAdapter
  });

  const deployment = {
    ip: resolvedOptions.ip,
    hostname: result.lxcSpec.hostname,
    bridge: result.lxcSpec.bridge,
    storage: result.lxcSpec.storage,
    resources: result.lxcSpec.resources
  };
  const updatedConfig = updatePlatformDeployment(project.config, "reverseProxy", deployment);
  const updatedState = {
    ...project.state,
    providerReferences: {
      ...project.state.providerReferences,
      [proxyService.id]: result.providerReference
    }
  };

  writeAtomically(filesystem, project.configPath, serializeProjectConfiguration(updatedConfig));
  writeAtomically(filesystem, project.statePath, `${JSON.stringify(updatedState, null, 2)}\n`);
  filesystem.chmod(project.statePath, 0o600);

  return {
    ...formatPlatformProvisionResult({
      serviceLabel,
      ip: resolvedOptions.ip,
      hostname: result.lxcSpec.hostname,
      providerReference: result.providerReference,
      warnings: result.warnings,
      health: result.health,
      inspectedCount: result.inspection.unmanaged.length,
      inspectedLabel: "unmanaged proxy route(s) preserved"
    }),
    inspection: result.inspection,
    lxcSpec: result.lxcSpec,
    providerReference: result.providerReference
  };
}

async function addCaddyService(options, adapters) {
  return addReverseProxyService("caddy", "Caddy", promptCaddyOptions, options, adapters);
}

async function addTraefikService(options, adapters) {
  return addReverseProxyService("traefik", "Traefik", promptTraefikOptions, options, adapters);
}

async function publishExposure(options, adapters) {
  const { filesystem, providerAdapters = {} } = adapters;
  assertProxmoxShell(adapters.runtime);

  const project = loadProject(filesystem, options.projectDir);
  const resolvedOptions = await promptExposureOptions(project, options, adapters.prompts);
  validateExposureOptions(resolvedOptions);

  const result = publishManagedExposure({
    project,
    options: resolvedOptions,
    providerAdapters
  });

  const updatedConfig = upsertManagedExposure(project.config, result.managedService);
  const updatedState = {
    ...project.state,
    providerReferences: {
      ...project.state.providerReferences,
      [result.managedService.id]: result.integrationReferences
    }
  };

  writeAtomically(filesystem, project.configPath, serializeProjectConfiguration(updatedConfig));
  writeAtomically(filesystem, project.statePath, `${JSON.stringify(updatedState, null, 2)}\n`);
  filesystem.chmod(project.statePath, 0o600);

  const actionLabel = result.isUpdate ? "updated" : "published";
  const healthLabel = result.health.status === "healthy" ? "healthy" : "unhealthy";

  return {
    stdout: `Exposure ${actionLabel} for ${resolvedOptions.hostname} via HTTPS at ${resolvedOptions.backendIp}:${resolvedOptions.backendPort}. Health: ${healthLabel}.\n`,
    health: result.health,
    dnsInspection: result.dnsInspection,
    proxyInspection: result.proxyInspection,
    managedService: result.managedService
  };
}

async function initializeProject(options, adapters) {
  const { filesystem, runtime } = adapters;
  assertProxmoxShell(runtime);

  const projectDirectory = options.projectDir ?? adapters.cwd ?? ".";
  const configPath = joinPath(projectDirectory, "nomina.yaml");
  if (filesystem.exists(configPath)) {
    throw new Error(`A NominaConnect project already exists at ${configPath}.`);
  }

  const answers = await promptInitOptions(options, adapters.prompts);
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

function parseExposurePublishOptions(rawOptions) {
  const options = {};
  const optionNames = new Map([
    ["--project-dir", "projectDir"],
    ["--name", "name"],
    ["--hostname", "hostname"],
    ["--backend-ip", "backendIp"],
    ["--backend-port", "backendPort"]
  ]);
  parseFlagOptions(rawOptions, optionNames, options);
  if (options.backendPort !== undefined) {
    options.backendPort = Number(options.backendPort);
  }
  return options;
}

function validateExposureOptions(options) {
  for (const field of ["name", "hostname", "backendIp", "backendPort"]) {
    if (options[field] === undefined || options[field] === "") {
      throw new Error(`${field} is required.`);
    }
  }
  if (!isIpAddress(options.backendIp)) {
    throw new Error(`Invalid backend IP: ${options.backendIp}.`);
  }
  if (!Number.isInteger(options.backendPort) || options.backendPort <= 0) {
    throw new Error(`Invalid backend port: ${options.backendPort}.`);
  }
}

function formatPlatformProvisionResult({
  serviceLabel,
  ip,
  hostname,
  providerReference,
  warnings,
  health,
  inspectedCount,
  inspectedLabel
}) {
  const warningText = warnings.length > 0
    ? `\nWarning: ${warnings.join("\nWarning: ")}\n`
    : "";
  const healthLabel = health.status === "healthy" ? "healthy" : "unhealthy";
  return {
    stdout: `${warningText}${serviceLabel} provisioned at ${ip} on ${hostname} (vmid ${providerReference.vmid}). Inspected ${inspectedCount} ${inspectedLabel}. Health: ${healthLabel}.\n`,
    warnings,
    health
  };
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
