import * as clack from "@clack/prompts";
import { INITIAL_PLATFORM_CATALOG } from "./catalog.js";
import { findProjectDirectory, loadProject } from "./config.js";
import { TECHNITIUM_DEPLOYMENT, CADDY_DEPLOYMENT } from "./provisioning.js";

export function getProjectContext(filesystem, cwd = ".") {
  const projectDirectory = findProjectDirectory(filesystem, cwd);
  if (projectDirectory === undefined) {
    return { projectDirectory: undefined, project: undefined };
  }
  try {
    return { projectDirectory, project: loadProject(filesystem, projectDirectory) };
  } catch {
    return { projectDirectory, project: undefined };
  }
}

export function canProvisionTechnitium(project) {
  const dnsService = project?.config.managedInventory.platform.dns;
  if (dnsService?.service !== "technitium") {
    return false;
  }
  return project.state.providerReferences[dnsService.id] === undefined;
}

export function canProvisionCaddy(project) {
  const dnsService = project?.config.managedInventory.platform.dns;
  const proxyService = project?.config.managedInventory.platform.reverseProxy;
  if (proxyService?.service !== "caddy") {
    return false;
  }
  if (project.state.providerReferences[dnsService?.id] === undefined) {
    return false;
  }
  return project.state.providerReferences[proxyService.id] === undefined;
}

export function canPublishExposure(project) {
  const dnsService = project?.config.managedInventory.platform.dns;
  const proxyService = project?.config.managedInventory.platform.reverseProxy;
  return dnsService?.service === "technitium"
    && proxyService?.service === "caddy"
    && project.state.providerReferences[dnsService.id] !== undefined
    && project.state.providerReferences[proxyService.id] !== undefined;
}

export function buildMenuOptions(project) {
  const options = [];
  if (project !== undefined && canProvisionTechnitium(project)) {
    options.push({
      value: "provision-technitium",
      label: "Provision Technitium DNS",
      hint: "create the DNS LXC"
    });
  }
  if (project !== undefined && canProvisionCaddy(project)) {
    options.push({
      value: "provision-caddy",
      label: "Provision Caddy reverse proxy",
      hint: "create the proxy LXC"
    });
  }
  if (project !== undefined && canPublishExposure(project)) {
    options.push({
      value: "publish-exposure",
      label: "Publish a web exposure",
      hint: "connect DNS and HTTPS routing"
    });
  }
  options.push({ value: "init", label: "Initialize a new project", hint: "first-time setup" });
  options.push({ value: "exit", label: "Exit", hint: "leave NominaConnect" });
  return options;
}

export async function runInteractiveApp(adapters) {
  clack.intro("NominaConnect");

  const { projectDirectory, project } = getProjectContext(adapters.filesystem, adapters.cwd ?? ".");
  const options = buildMenuOptions(project);
  const menuMessage = projectDirectory === undefined
    ? "No project found here yet. What would you like to do?"
    : project === undefined
      ? "Project files look incomplete. What would you like to do?"
      : "What would you like to do?";

  if (projectDirectory !== undefined && project !== undefined) {
    clack.log.info(`Using project at ${projectDirectory}`);
  }

  const action = adapters.interactive?.chooseAction
    ? await adapters.interactive.chooseAction({ projectDirectory, project, options })
    : await clack.select({ message: menuMessage, options });

  if (clack.isCancel(action)) {
    clack.cancel("Cancelled.");
    return { stdout: "", cancelled: true };
  }

  if (action === "exit") {
    clack.outro("Goodbye.");
    return { stdout: "", cancelled: true };
  }
  if (action === "init") {
    const result = await adapters.runCommand(["init"], adapters);
    clack.outro("Project initialized.");
    return result;
  }
  if (action === "provision-technitium") {
    const result = await adapters.runCommand(["service", "add", "technitium"], adapters);
    clack.outro("Technitium provisioning complete.");
    return result;
  }
  if (action === "provision-caddy") {
    const result = await adapters.runCommand(["service", "add", "caddy"], adapters);
    clack.outro("Caddy provisioning complete.");
    return result;
  }
  if (action === "publish-exposure") {
    const result = await adapters.runCommand(["exposure", "publish"], adapters);
    clack.outro("Exposure published.");
    return result;
  }

  throw new Error(`Unsupported action: ${action}.`);
}

export async function promptServiceName(project, prompts) {
  const choices = [];
  if (canProvisionTechnitium(project)) {
    const description = INITIAL_PLATFORM_CATALOG.dns[0]?.description ?? "DNS service";
    choices.push({ value: "technitium", label: "Technitium DNS", hint: description });
  }
  if (canProvisionCaddy(project)) {
    const description = INITIAL_PLATFORM_CATALOG.reverseProxy.find((option) => option.name === "caddy")?.description
      ?? "reverse proxy";
    choices.push({ value: "caddy", label: "Caddy reverse proxy", hint: description });
  }
  if (choices.length === 0) {
    throw new Error("No platform services are waiting to be provisioned.");
  }
  if (choices.length === 1) {
    return choices[0].value;
  }

  if (prompts?.select) {
    const selected = await prompts.select({
      message: "Which service would you like to provision?",
      options: choices
    });
    if (selected === undefined) {
      throw new Error("Setup cancelled.");
    }
    return selected;
  }
  if (prompts?.ask) {
    const text = choices.map((choice) => `${choice.label} — ${choice.hint}`).join("; ");
    return prompts.ask(`Service to provision (${text})`, choices[0].value);
  }
  return choices[0].value;
}

export async function promptInitOptions(existingOptions, prompts) {
  if (prompts?.ask === undefined && prompts?.select === undefined) {
    return {
      dns: "technitium",
      certificateAuthority: "none",
      vpn: "none",
      ...existingOptions
    };
  }

  const node = existingOptions.node ?? await askPrompt(prompts, "Proxmox node");
  const bridge = existingOptions.bridge ?? await askPrompt(prompts, "Default network bridge");
  const storage = existingOptions.storage ?? await askPrompt(prompts, "Default storage target");
  const domain = existingOptions.domain ?? await askPrompt(prompts, "Base local domain");
  const dns = existingOptions.dns ?? await selectProvider(prompts, "DNS provider", "dns", "technitium");
  const reverseProxy = existingOptions.reverseProxy ?? await selectProvider(prompts, "Reverse proxy", "reverseProxy");
  const certificateAuthority = existingOptions.certificateAuthority
    ?? await selectOptionalProvider(prompts, "Certificate authority", "certificateAuthority", reverseProxy, "none");
  const vpn = existingOptions.vpn ?? await selectOptionalProvider(prompts, "VPN provider", "vpn", undefined, "none");

  return { ...existingOptions, node, bridge, storage, domain, dns, reverseProxy, certificateAuthority, vpn };
}

export async function promptTechnitiumOptions(project, existingOptions, prompts) {
  if (prompts?.ask === undefined && prompts?.confirm === undefined) {
    return existingOptions;
  }

  const recommendations = TECHNITIUM_DEPLOYMENT.resourceRecommendations;
  const ip = existingOptions.ip ?? await askRequired(prompts, "Static IP for Technitium", validateIp);
  const hostname = existingOptions.hostname
    ?? await askPrompt(prompts, "LXC hostname", TECHNITIUM_DEPLOYMENT.defaultHostname);
  const useRecommended = existingOptions.cpus !== undefined
    ? true
    : await confirmPrompt(
      prompts,
      `Use recommended resources (${recommendations.cpus} CPU, ${recommendations.memoryMb} MB RAM, ${recommendations.diskGb} GB disk)?`,
      true
    );

  let cpus = existingOptions.cpus;
  let memoryMb = existingOptions.memoryMb;
  let diskGb = existingOptions.diskGb;
  if (useRecommended === false) {
    cpus = Number(await askPrompt(prompts, "CPU cores", String(recommendations.cpus)));
    memoryMb = Number(await askPrompt(prompts, "Memory (MB)", String(recommendations.memoryMb)));
    diskGb = Number(await askPrompt(prompts, "Disk (GB)", String(recommendations.diskGb)));
  }

  logInfo(prompts, [
    `Bridge: ${existingOptions.bridge ?? project.config.proxmox.defaultBridge}`,
    `Storage: ${existingOptions.storage ?? project.config.proxmox.defaultStorage}`,
    `Domain: ${project.config.baseLocalDomain}`
  ].join("\n"));

  return {
    ...existingOptions,
    ip,
    hostname,
    ...(cpus === undefined ? {} : { cpus }),
    ...(memoryMb === undefined ? {} : { memoryMb }),
    ...(diskGb === undefined ? {} : { diskGb })
  };
}

export async function promptCaddyOptions(project, existingOptions, prompts) {
  if (prompts?.ask === undefined && prompts?.confirm === undefined) {
    return existingOptions;
  }

  const recommendations = CADDY_DEPLOYMENT.resourceRecommendations;
  const ip = existingOptions.ip ?? await askRequired(prompts, "Static IP for Caddy", validateIp);
  const hostname = existingOptions.hostname
    ?? await askPrompt(prompts, "LXC hostname", CADDY_DEPLOYMENT.defaultHostname);
  const useRecommended = existingOptions.cpus !== undefined
    ? true
    : await confirmPrompt(
      prompts,
      `Use recommended resources (${recommendations.cpus} CPU, ${recommendations.memoryMb} MB RAM, ${recommendations.diskGb} GB disk)?`,
      true
    );

  let cpus = existingOptions.cpus;
  let memoryMb = existingOptions.memoryMb;
  let diskGb = existingOptions.diskGb;
  if (useRecommended === false) {
    cpus = Number(await askPrompt(prompts, "CPU cores", String(recommendations.cpus)));
    memoryMb = Number(await askPrompt(prompts, "Memory (MB)", String(recommendations.memoryMb)));
    diskGb = Number(await askPrompt(prompts, "Disk (GB)", String(recommendations.diskGb)));
  }

  logInfo(prompts, [
    `Bridge: ${existingOptions.bridge ?? project.config.proxmox.defaultBridge}`,
    `Storage: ${existingOptions.storage ?? project.config.proxmox.defaultStorage}`
  ].join("\n"));

  return {
    ...existingOptions,
    ip,
    hostname,
    ...(cpus === undefined ? {} : { cpus }),
    ...(memoryMb === undefined ? {} : { memoryMb }),
    ...(diskGb === undefined ? {} : { diskGb })
  };
}

export async function promptExposureOptions(project, existingOptions, prompts) {
  if (prompts?.ask === undefined) {
    return existingOptions;
  }

  const name = existingOptions.name ?? await askPrompt(prompts, "Service name", "app");
  const suggestedHostname = `${name}.${project.config.baseLocalDomain}`;
  const hostname = existingOptions.hostname ?? await askPrompt(prompts, "Full hostname", suggestedHostname);
  const backendIp = existingOptions.backendIp
    ?? await askRequired(prompts, "Backend IP", validateIp);
  const backendPort = existingOptions.backendPort
    ?? Number(await askPrompt(prompts, "Backend port", "8080"));

  return { ...existingOptions, name, hostname, backendIp, backendPort };
}

async function askPrompt(prompts, question, fallback = undefined) {
  if (prompts?.ask === undefined) {
    return fallback;
  }
  return prompts.ask(question, fallback);
}

async function confirmPrompt(prompts, message, initialValue) {
  if (prompts?.confirm) {
    return prompts.confirm({ message, initialValue });
  }
  if (prompts?.ask) {
    const answer = await prompts.ask(`${message} (y/n)`, initialValue ? "y" : "n");
    return answer.toLowerCase().startsWith("y");
  }
  return initialValue;
}

function logInfo(prompts, message) {
  if (prompts?.info) {
    prompts.info(message);
    return;
  }
  if (prompts?.warn) {
    prompts.warn(message);
  }
}

async function selectProvider(prompts, label, category, fallback = undefined) {
  const choices = INITIAL_PLATFORM_CATALOG[category].map((option) => ({
    value: option.name,
    label: option.name,
    hint: option.description
  }));
  if (prompts?.select) {
    const selected = await prompts.select({ message: label, options: choices, initialValue: fallback });
    if (selected === undefined) {
      throw new Error("Setup cancelled.");
    }
    return selected;
  }
  if (prompts?.ask) {
    const text = choices.map((choice) => `${choice.label} — ${choice.hint}`).join("; ");
    return prompts.ask(`${label} (${text})`, fallback);
  }
  return fallback;
}

async function selectOptionalProvider(prompts, label, category, reverseProxy, fallback) {
  const choices = INITIAL_PLATFORM_CATALOG[category]
    .filter((option) => option.compatibleWith === undefined || option.compatibleWith.includes(reverseProxy))
    .map((option) => ({
      value: option.name,
      label: option.name,
      hint: option.description
    }));
  choices.unshift({ value: "none", label: "none", hint: "skip this optional platform layer" });

  if (prompts?.select) {
    const selected = await prompts.select({ message: label, options: choices, initialValue: fallback });
    if (selected === undefined) {
      throw new Error("Setup cancelled.");
    }
    return selected;
  }
  if (prompts?.ask) {
    const text = choices.map((choice) => `${choice.label} — ${choice.hint}`).join("; ");
    return prompts.ask(`${label} (${text})`, fallback);
  }
  return fallback;
}

async function askRequired(prompts, question, validate) {
  while (true) {
    const answer = await askPrompt(prompts, question);
    const error = validate(answer);
    if (error === undefined) {
      return answer?.trim();
    }
    if (prompts?.warn) {
      prompts.warn(error);
    }
  }
}

function validateIp(value) {
  if (value === undefined || value.trim() === "") {
    return "Static IP is required.";
  }
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value.trim())) {
    return "Enter a valid IPv4 address, for example 10.0.0.53.";
  }
  return undefined;
}
