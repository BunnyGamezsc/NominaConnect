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
import { provisionPlatformService, resolveServiceDeployment } from "./provisioning.js";
import { ensureConnectionSecret, updateConnectionSecret } from "./secrets.js";
import { withBoundedRetry } from "./adoption.js";
import {
  runTrackingJob,
  formatPendingNotices,
  formatChangesDetail,
  clearPendingNotices
} from "./tracking.js";
import { getStepCaExportGuide, getStepCaTrustGuide } from "./ca-guide.js";
import { VERSION } from "./version.js";
import {
  promptCaddyOptions,
  promptExposureOptions,
  promptInitOptions,
  promptServiceName,
  promptStepCaOptions,
  promptTechnitiumOptions,
  promptTraefikOptions,
  promptTailscaleOptions,
  promptNetBirdOptions,
  promptUpgradeServiceName,
  promptRemoveServiceName,
  promptDestroyServiceName,
  promptSecretServiceName,
  confirmPrompt
} from "./tui.js";

export async function runCli(argumentsList, adapters) {
  if (argumentsList.length === 0) {
    if (adapters.interactive?.run === undefined) {
      throw new Error("Run nomina from an interactive terminal, or pass a command such as init or service add.");
    }
    return adapters.interactive.run(adapters);
  }

  const [command, ...rest] = argumentsList;
  const commandResult = await runCommand(command, rest, adapters);
  startTrackingJobInBackground(adapters);
  return commandResult;
}

async function runCommand(command, rest, adapters) {
  if (command === "--version" || command === "-v" || command === "version") {
    return { stdout: `${VERSION}\n` };
  }
  switch (command) {
    case "init":
      return initializeProject(parseInitOptions(rest), adapters);
    case "service":
      return handleServiceCommand(rest, adapters);
    case "exposure":
      return handleExposureCommand(rest, adapters);
    case "domain":
      return handleDomainCommand(rest, adapters);
    case "changes":
      return showChanges(rest, adapters);
    case "secret":
      return handleSecretCommand(rest, adapters);
    case "ca":
      return handleCaCommand(rest, adapters);
    default:
      throw new Error("Unknown command. Run nomina for the interactive menu.");
  }
}

async function handleServiceCommand(argumentsList, adapters) {
  const [subcommand, ...rest] = argumentsList;
  if (subcommand === "add") {
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
    if (resolvedServiceName === "step-ca") {
      return addStepCaService(options, adapters);
    }
    if (resolvedServiceName === "caddy-internal-ca") {
      return addCaddyInternalCaService(options, adapters);
    }
    if (resolvedServiceName === "tailscale") {
      return addTailscaleService(options, adapters);
    }
    if (resolvedServiceName === "netbird") {
      return addNetBirdService(options, adapters);
    }
    throw new Error(`Unsupported service: ${resolvedServiceName}.`);
  }

  if (subcommand === "upgrade") {
    const [serviceName, ...rawOptions] = rest[0]?.startsWith("--") ? [undefined, ...rest] : rest;
    return upgradeService(serviceName, rawOptions, adapters);
  }

  if (subcommand === "remove") {
    const [serviceName, ...rawOptions] = rest[0]?.startsWith("--") ? [undefined, ...rest] : rest;
    return removeService(serviceName, rawOptions, adapters);
  }

  if (subcommand === "destroy") {
    const [serviceName, ...rawOptions] = rest[0]?.startsWith("--") ? [undefined, ...rest] : rest;
    return destroyService(serviceName, rawOptions, adapters);
  }

  if (subcommand === "recheck") {
    const [serviceName, ...rawOptions] = rest[0]?.startsWith("--") ? [undefined, ...rest] : rest;
    return recheckService(serviceName, rawOptions, adapters);
  }

  throw new Error("Run nomina for the interactive menu, or use: nomina service add|upgrade|remove|destroy|recheck <name>");
}

async function handleExposureCommand(argumentsList, adapters) {
  const [subcommand, ...rest] = argumentsList;
  if (subcommand !== "publish") {
    throw new Error("Run nomina for the interactive menu, or use: nomina exposure publish");
  }
  return publishExposure(parseExposurePublishOptions(rest), adapters);
}

async function handleSecretCommand(argumentsList, adapters) {
  const [subcommand, ...rest] = argumentsList;
  if (subcommand !== "change") {
    throw new Error("Run nomina for the interactive menu, or use: nomina secret change");
  }
  return changeConnectionSecret(parseSecretChangeOptions(rest), adapters);
}

async function handleCaCommand(argumentsList, adapters) {
  const [subcommand, ...rest] = argumentsList;
  if (subcommand !== "guide" && subcommand !== "trust" && subcommand !== "cert" && subcommand !== "export" && subcommand !== undefined) {
    throw new Error("Run nomina for the interactive menu, or use: nomina ca guide|cert|export");
  }
  if (subcommand === undefined || subcommand === "guide" || subcommand === "trust") {
    return showCaTrustGuide(parseCaGuideOptions(rest), adapters);
  }
  if (subcommand === "cert") {
    return showCaCertificate(parseCaGuideOptions(rest), adapters);
  }
  if (subcommand === "export") {
    return exportCaCertificate(parseCaGuideOptions(rest), adapters);
  }
  throw new Error("Run nomina for the interactive menu, or use: nomina ca guide|cert|export");
}

async function showCaTrustGuide(options, adapters) {
  const { filesystem } = adapters;
  const project = loadProject(filesystem, options.projectDir);
  const caService = project.config.managedInventory.platform.certificateAuthority;
  if (caService?.service !== "step-ca") {
    throw new Error("step-ca is not selected as the certificate authority for this project. The trust guide is only for step-ca.");
  }
  if (project.state.providerReferences[caService.id] === undefined) {
    throw new Error("step-ca is not yet provisioned. Provision it first, then run nomina ca guide.");
  }
  const guide = getStepCaTrustGuide(project);
  return { stdout: guide + "\n" };
}

async function showCaCertificate(options, adapters) {
  const { filesystem } = adapters;
  const project = loadProject(filesystem, options.projectDir);
  const caService = project.config.managedInventory.platform.certificateAuthority;
  if (caService?.service !== "step-ca") {
    throw new Error("step-ca is not selected as the certificate authority for this project.");
  }
  return { stdout: await fetchStepCaRootPem(project, adapters) };
}

async function exportCaCertificate(options, adapters) {
  const { filesystem } = adapters;
  const project = loadProject(filesystem, options.projectDir);
  const caService = project.config.managedInventory.platform.certificateAuthority;
  if (caService?.service !== "step-ca") {
    throw new Error("step-ca is not selected as the certificate authority for this project.");
  }
  const pem = await fetchStepCaRootPem(project, adapters);
  const outputPath = options.output ?? "step-ca-root.crt";
  filesystem.writeFile(outputPath, pem);
  return { stdout: getStepCaExportGuide(project, outputPath) };
}

function parseCaGuideOptions(rawOptions) {
  const options = {};
  const optionNames = new Map([["--project-dir", "projectDir"], ["--output", "output"]]);
  parseFlagOptions(rawOptions, optionNames, options);
  return options;
}

async function fetchStepCaRootPem(project, adapters) {
  const { proxmox, providerAdapters = {} } = adapters;
  const caService = project.config.managedInventory.platform.certificateAuthority;
  const caRef = project.state.providerReferences[caService.id];
  if (caRef === undefined) {
    throw new Error("step-ca is not yet provisioned.");
  }
  const vmid = caRef.vmid;
  if (proxmox?.pctExec) {
    for (const path of ["/var/lib/stepca/certs/root_ca.crt", "/root/.step/certs/root_ca.crt"]) {
      try {
        const result = await proxmox.pctExec(vmid, { binary: "/bin/cat", args: [path] });
        if (result.stdout && result.stdout.includes("BEGIN CERTIFICATE")) {
          return result.stdout + (result.stdout.endsWith("\n") ? "" : "\n");
        }
      } catch {}
    }
  }
  const httpClient = providerAdapters["step-ca"]?.httpClient ?? adapters.httpClient;
  if (httpClient && caRef.ip) {
    try {
      const result = await httpClient.request({ method: "GET", url: `https://${caRef.ip}:9000/roots.pem`, headers: {}, redactions: [] });
      if (result.status === 200 && result.body.includes("BEGIN CERTIFICATE")) {
        return result.body + (result.body.endsWith("\n") ? "" : "\n");
      }
    } catch {}
  }
  throw new Error(`Could not fetch step-ca root certificate from LXC ${vmid}. Try: pct exec ${vmid} -- cat /var/lib/stepca/certs/root_ca.crt`);
}

async function changeConnectionSecret(options, adapters) {
  const { filesystem, runtime } = adapters;
  assertProxmoxShell(runtime);
  const project = loadProject(filesystem, options.projectDir);
  let serviceId = options.service;
  let reference;
  let label;
  if (serviceId !== undefined) {
    const platformEntries = Object.entries(project.config.managedInventory.platform);
    const matchedPlatform = platformEntries.find(
      ([key, item]) => item?.service === serviceId || item?.id === serviceId || key === serviceId
    );
    if (matchedPlatform) {
      serviceId = matchedPlatform[1].id;
      label = matchedPlatform[1].service;
      reference = project.config.connectionSecretReferences[serviceId];
    } else {
      const svc = (project.config.managedInventory.services ?? []).find(
        (s) => s.name === serviceId || s.id === serviceId || s.exposure?.hostname === serviceId
      );
      if (svc) {
        serviceId = svc.id;
        label = svc.name;
        reference = project.config.connectionSecretReferences[serviceId];
      } else {
        throw new Error(`Service ${serviceId} not found in managed inventory.`);
      }
    }
  } else {
    serviceId = await promptSecretServiceName(project, adapters.prompts);
    for (const [key, item] of Object.entries(project.config.managedInventory.platform)) {
      if (item?.id === serviceId) {
        label = item.service;
        break;
      }
    }
    if (!label) {
      const svc = (project.config.managedInventory.services ?? []).find((s) => s.id === serviceId);
      label = svc?.name ?? serviceId;
    }
    reference = project.config.connectionSecretReferences[serviceId];
  }
  if (!reference) {
    throw new Error(`No connection secret reference for ${label ?? serviceId}.`);
  }
  const displayLabel = label ? label.charAt(0).toUpperCase() + label.slice(1) : serviceId;
  await updateConnectionSecret(adapters, displayLabel, reference);
  return { stdout: `Connection secret for ${displayLabel} updated.\n` };
}

async function showChanges(rawOptions, adapters) {
  const { filesystem } = adapters;
  const options = {};
  const optionNames = new Map([["--project-dir", "projectDir"]]);
  parseFlagOptions(rawOptions, optionNames, options);

  const project = loadProject(filesystem, options.projectDir);
  const notices = project.state.tracking?.notices ?? [];

  if (notices.length === 0) {
    return { stdout: "No changes recorded.\n" };
  }

  const detail = formatChangesDetail(notices);
  const updatedState = clearPendingNotices(project.state);
  writeAtomically(filesystem, project.statePath, `${JSON.stringify(updatedState, null, 2)}\n`);
  filesystem.chmod(project.statePath, 0o600);

  return { stdout: detail };
}

function startTrackingJobInBackground(adapters) {
  const { filesystem, providerAdapters = {} } = adapters;
  let projectDir;
  try {
    const project = loadProject(filesystem);
    projectDir = project.projectDirectory;
  } catch {
    return;
  }

  runTrackingJob({ filesystem, projectDir, providerAdapters }).catch(() => {});
}

async function addTechnitiumService(options, adapters) {
  const { filesystem, runtime, proxmox, providerAdapters = {} } = adapters;
  assertProxmoxShell(runtime);

  const project = loadProject(filesystem, options.projectDir);
  const availableTemplates = await listAvailableTemplates(proxmox);
  const resolvedOptions = await promptTechnitiumOptions(project, options, adapters.prompts, availableTemplates);
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

  await ensureConnectionSecret(adapters, "Technitium", project.config.connectionSecretReferences[dnsService.id]);

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
    template: result.lxcSpec.template,
    gateway: result.lxcSpec.gateway,
    nameserver: result.lxcSpec.nameserver,
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
  const availableTemplates = await listAvailableTemplates(proxmox);
  const resolvedOptions = await promptOptions(project, options, adapters.prompts, availableTemplates);
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

  await ensureConnectionSecret(adapters, serviceLabel, project.config.connectionSecretReferences[proxyService.id]);

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
    template: result.lxcSpec.template,
    gateway: result.lxcSpec.gateway,
    nameserver: result.lxcSpec.nameserver,
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

async function addStepCaService(options, adapters) {
  const { filesystem, runtime, proxmox, providerAdapters = {} } = adapters;
  assertProxmoxShell(runtime);

  const project = loadProject(filesystem, options.projectDir);
  const availableTemplates = await listAvailableTemplates(proxmox);
  const resolvedOptions = await promptStepCaOptions(project, options, adapters.prompts, availableTemplates);
  const dnsService = project.config.managedInventory.platform.dns;
  const proxyService = project.config.managedInventory.platform.reverseProxy;
  const caService = project.config.managedInventory.platform.certificateAuthority;

  if (caService?.service !== "step-ca") {
    throw new Error("step-ca is not selected as the certificate authority for this project.");
  }
  if (project.state.providerReferences[dnsService?.id] === undefined) {
    throw new Error("Technitium must be provisioned before step-ca.");
  }
  if (project.state.providerReferences[proxyService?.id] === undefined) {
    const proxyLabel = proxyService?.service === "traefik" ? "Traefik" : "Caddy";
    throw new Error(`${proxyLabel} must be provisioned before step-ca.`);
  }
  if (project.state.providerReferences[caService.id] !== undefined) {
    throw new Error("step-ca is already provisioned for this project.");
  }
  if (resolvedOptions.ip === undefined) {
    throw new Error("Static IP is required.");
  }
  if (!isIpAddress(resolvedOptions.ip)) {
    throw new Error(`Invalid static IP: ${resolvedOptions.ip}.`);
  }

  const providerAdapter = providerAdapters["step-ca"];
  if (providerAdapter === undefined) {
    throw new Error("step-ca provider adapter is unavailable.");
  }
  if (proxmox === undefined) {
    throw new Error("Proxmox adapter is unavailable.");
  }

  await ensureConnectionSecret(adapters, "step-ca", project.config.connectionSecretReferences[caService.id]);

  const result = await provisionPlatformService({
    project,
    platformKey: "certificateAuthority",
    serviceName: "step-ca",
    managedItem: caService,
    options: resolvedOptions,
    proxmox,
    providerAdapter
  });

  const deployment = {
    ip: resolvedOptions.ip,
    hostname: result.lxcSpec.hostname,
    bridge: result.lxcSpec.bridge,
    storage: result.lxcSpec.storage,
    template: result.lxcSpec.template,
    gateway: result.lxcSpec.gateway,
    nameserver: result.lxcSpec.nameserver,
    resources: result.lxcSpec.resources
  };
  const updatedConfig = updatePlatformDeployment(project.config, "certificateAuthority", deployment);
  const updatedState = {
    ...project.state,
    providerReferences: {
      ...project.state.providerReferences,
      [caService.id]: result.providerReference
    }
  };

  writeAtomically(filesystem, project.configPath, serializeProjectConfiguration(updatedConfig));
  writeAtomically(filesystem, project.statePath, `${JSON.stringify(updatedState, null, 2)}\n`);
  filesystem.chmod(project.statePath, 0o600);

  return {
    ...formatPlatformProvisionResult({
      serviceLabel: "step-ca",
      ip: resolvedOptions.ip,
      hostname: result.lxcSpec.hostname,
      providerReference: result.providerReference,
      warnings: result.warnings,
      health: result.health,
      inspectedCount: result.inspection.unmanaged.length,
      inspectedLabel: "unmanaged CA resource(s) preserved"
    }),
    inspection: result.inspection,
    lxcSpec: result.lxcSpec,
    providerReference: result.providerReference
  };
}

async function addCaddyInternalCaService(options, adapters) {
  const { filesystem, runtime, proxmox, providerAdapters = {} } = adapters;
  assertProxmoxShell(runtime);

  const project = loadProject(filesystem, options.projectDir);
  const dnsService = project.config.managedInventory.platform.dns;
  const proxyService = project.config.managedInventory.platform.reverseProxy;
  const caService = project.config.managedInventory.platform.certificateAuthority;

  if (caService?.service !== "caddy-internal-ca") {
    throw new Error("Caddy Internal CA is not selected as the certificate authority for this project.");
  }
  if (project.state.providerReferences[dnsService?.id] === undefined) {
    throw new Error("Technitium must be provisioned before Caddy Internal CA.");
  }
  if (project.state.providerReferences[proxyService?.id] === undefined) {
    throw new Error("Caddy must be provisioned before Caddy Internal CA.");
  }
  if (project.state.providerReferences[caService.id] !== undefined) {
    throw new Error("Caddy Internal CA is already configured for this project.");
  }

  const caddyRef = project.state.providerReferences[proxyService.id];
  const providerAdapter = providerAdapters["caddy-internal-ca"] ?? providerAdapters.caddy;
  if (providerAdapter === undefined) {
    throw new Error("Caddy Internal CA provider adapter is unavailable.");
  }

  const plugin = getPlatformProvider("caddy-internal-ca");
  await ensureConnectionSecret(adapters, "Caddy Internal CA", project.config.connectionSecretReferences[caService.id]);
  const setupPlan = await plugin.setup(providerAdapter, caService, {
    connectionSecretReference: project.config.connectionSecretReferences[caService.id]
  });
  const commands = setupPlan.lxcCommands ?? setupPlan.operations ?? [];
  if (proxmox?.pctExec) {
    for (const command of commands) {
      await proxmox.pctExec(caddyRef.vmid, command);
    }
  }

  const connectionSecretReference = project.config.connectionSecretReferences[caService.id];
  const inspection = await plugin.inspect(providerAdapter, caService, { providerReferences: [], connectionSecretReference });
  const health = await plugin.healthCheck(providerAdapter, caService, { connectionSecretReference });
  const providerReference = { vmid: caddyRef.vmid, service: "caddy-internal-ca" };

  const updatedState = {
    ...project.state,
    providerReferences: {
      ...project.state.providerReferences,
      [caService.id]: providerReference
    }
  };

  writeAtomically(filesystem, project.statePath, `${JSON.stringify(updatedState, null, 2)}\n`);
  filesystem.chmod(project.statePath, 0o600);

  const healthLabel = health.status === "healthy" ? "healthy" : "unhealthy";
  return {
    stdout: `Caddy Internal CA configured in Caddy (vmid ${caddyRef.vmid}). Inspected ${inspection.managed.length} managed CA resource(s). Health: ${healthLabel}.\n`,
    health,
    inspection,
    providerReference
  };
}

async function addVpnService(serviceName, serviceLabel, promptOptions, options, adapters) {
  const { filesystem, runtime, proxmox, providerAdapters = {} } = adapters;
  assertProxmoxShell(runtime);

  const project = loadProject(filesystem, options.projectDir);
  const availableTemplates = await listAvailableTemplates(proxmox);
  const resolvedOptions = await promptOptions(project, options, adapters.prompts, availableTemplates);
  const vpnService = project.config.managedInventory.platform.vpn;
  if (vpnService?.service !== serviceName) {
    throw new Error(`${serviceLabel} is not selected as the VPN provider for this project.`);
  }
  if (project.state.providerReferences[vpnService.id] !== undefined) {
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

  await ensureConnectionSecret(adapters, serviceLabel, project.config.connectionSecretReferences[vpnService.id]);

  const result = await provisionPlatformService({
    project,
    platformKey: "vpn",
    serviceName,
    managedItem: vpnService,
    options: resolvedOptions,
    proxmox,
    providerAdapter
  });

  const deployment = {
    ip: resolvedOptions.ip,
    hostname: result.lxcSpec.hostname,
    bridge: result.lxcSpec.bridge,
    storage: result.lxcSpec.storage,
    template: result.lxcSpec.template,
    gateway: result.lxcSpec.gateway,
    nameserver: result.lxcSpec.nameserver,
    resources: result.lxcSpec.resources
  };
  const updatedConfig = updatePlatformDeployment(project.config, "vpn", deployment);
  const updatedState = {
    ...project.state,
    providerReferences: {
      ...project.state.providerReferences,
      [vpnService.id]: result.providerReference
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
      inspectedLabel: "unmanaged VPN resource(s) preserved"
    }),
    inspection: result.inspection,
    lxcSpec: result.lxcSpec,
    providerReference: result.providerReference
  };
}

async function addTailscaleService(options, adapters) {
  return addVpnService("tailscale", "Tailscale", promptTailscaleOptions, options, adapters);
}

async function addNetBirdService(options, adapters) {
  return addVpnService("netbird", "NetBird", promptNetBirdOptions, options, adapters);
}

async function upgradeService(serviceName, rawOptions, adapters) {
  const { filesystem, runtime, proxmox, providerAdapters = {}, prompts } = adapters;
  assertProxmoxShell(runtime);

  const options = parseServiceUpgradeOptions(rawOptions);
  const project = loadProject(filesystem, options.projectDir);

  let resolvedServiceName = serviceName;
  if (resolvedServiceName === undefined) {
    resolvedServiceName = await promptUpgradeServiceName(project, prompts);
  }

  const platformEntries = Object.entries(project.config.managedInventory.platform);
  const matchedPlatform = platformEntries.find(
    ([key, item]) => item?.service === resolvedServiceName || key === resolvedServiceName
  );

  if (!matchedPlatform || !matchedPlatform[1]) {
    throw new Error(`Service ${resolvedServiceName} is not configured in this project.`);
  }

  const [platformKey, managedItem] = matchedPlatform;
  const providerRef = project.state.providerReferences?.[managedItem.id];
  if (!providerRef) {
    throw new Error(`Service ${resolvedServiceName} is not provisioned in this project.`);
  }

  const vmid = providerRef.vmid;
  const storage = managedItem.deployment?.storage ?? project.config.proxmox.defaultStorage;
  const snapshotSupported = proxmox?.supportsSnapshots
    ? (typeof proxmox.supportsSnapshots === "function" ? await proxmox.supportsSnapshots(storage) : proxmox.supportsSnapshots)
    : true;

  let shouldTakeSnapshot = false;
  if (snapshotSupported) {
    if (options.snapshot !== undefined) {
      shouldTakeSnapshot = options.snapshot;
    } else if (prompts !== undefined) {
      shouldTakeSnapshot = await confirmPrompt(
        prompts,
        `Take a Proxmox snapshot before upgrading ${resolvedServiceName}?`,
        true
      );
    }
  }

  let snapshotResult;
  if (shouldTakeSnapshot && proxmox?.createSnapshot && vmid !== undefined) {
    const snapshotName = options.snapshotName ?? `pre-upgrade-${resolvedServiceName}-${Date.now()}`;
    snapshotResult = await proxmox.createSnapshot(vmid, snapshotName);
  }

  const plugin = getPlatformProvider(managedItem.service);
  const adapter = providerAdapters[managedItem.service] ?? providerAdapters.caddy;
  if (adapter === undefined) {
    throw new Error(`${resolvedServiceName} provider adapter is unavailable.`);
  }

  const connectionSecretReference = project.config.connectionSecretReferences[managedItem.id];
  await ensureConnectionSecret(
    adapters,
    resolvedServiceName.charAt(0).toUpperCase() + resolvedServiceName.slice(1),
    connectionSecretReference
  );
  const upgradePlan = await plugin.upgrade(adapter, managedItem, { connectionSecretReference });
  const commands = upgradePlan.lxcCommands ?? upgradePlan.operations ?? [];
  if (proxmox?.pctExec && vmid !== undefined) {
    for (const command of commands) {
      await proxmox.pctExec(vmid, command);
    }
  }

  const providerReferences = platformKey === "dns"
    ? [project.config.baseLocalDomain]
    : [];
  const inspection = await plugin.inspect(adapter, managedItem, { providerReferences, connectionSecretReference });
  const health = await plugin.healthCheck(adapter, managedItem, { connectionSecretReference });

  const snapshotText = snapshotResult ? `Snapshot ${snapshotResult.snapshotName ?? snapshotResult.name} created. ` : "";
  const healthLabel = health.status === "healthy" ? "healthy" : "unhealthy";
  const hostname = managedItem.deployment?.hostname ?? resolvedServiceName;
  const serviceLabel = resolvedServiceName.charAt(0).toUpperCase() + resolvedServiceName.slice(1);

  return {
    stdout: `${snapshotText}${serviceLabel} upgraded on ${hostname} (vmid ${vmid}). Health: ${healthLabel}.\n`,
    health,
    inspection,
    snapshot: snapshotResult,
    vmid
  };
}

async function removeService(serviceName, rawOptions, adapters) {
  const { filesystem, runtime, proxmox, providerAdapters = {}, prompts } = adapters;
  assertProxmoxShell(runtime);

  const options = parseServiceRemoveOptions(rawOptions);
  const project = loadProject(filesystem, options.projectDir);

  let resolvedServiceName = serviceName;
  if (resolvedServiceName === undefined) {
    resolvedServiceName = await promptRemoveServiceName(project, prompts);
  }

  const platformEntries = Object.entries(project.config.managedInventory.platform);
  const matchedPlatform = platformEntries.find(
    ([key, item]) => item?.service === resolvedServiceName || key === resolvedServiceName
  );

  if (matchedPlatform && matchedPlatform[1]) {
    const [platformKey, managedItem] = matchedPlatform;
    const providerRef = project.state.providerReferences?.[managedItem.id];
    if (!providerRef) {
      throw new Error(`Service ${resolvedServiceName} is not provisioned in this project.`);
    }

    if (proxmox?.stopLxc && providerRef.vmid !== undefined) {
      await proxmox.stopLxc(providerRef.vmid);
    }

    const updatedConfig = {
      ...project.config,
      managedInventory: {
        ...project.config.managedInventory,
        platform: {
          ...project.config.managedInventory.platform,
          [platformKey]: {
            id: managedItem.id,
            service: managedItem.service
          }
        }
      }
    };

    const updatedProviderRefs = { ...project.state.providerReferences };
    delete updatedProviderRefs[managedItem.id];

    const updatedState = {
      ...project.state,
      providerReferences: updatedProviderRefs,
      retainedServices: {
        ...(project.state.retainedServices ?? {}),
        [managedItem.id]: {
          ...providerRef,
          service: managedItem.service,
          removedAt: new Date().toISOString()
        }
      }
    };

    writeAtomically(filesystem, project.configPath, serializeProjectConfiguration(updatedConfig));
    writeAtomically(filesystem, project.statePath, `${JSON.stringify(updatedState, null, 2)}\n`);
    filesystem.chmod(project.statePath, 0o600);

    return {
      stdout: `Service ${resolvedServiceName} removed. LXC ${providerRef.vmid} stopped and data retained. Platform integrations disconnected.\n`,
      vmid: providerRef.vmid,
      service: resolvedServiceName
    };
  }

  const matchedService = (project.config.managedInventory.services ?? []).find(
    (s) => s.id === resolvedServiceName || s.name === resolvedServiceName || s.exposure?.hostname === resolvedServiceName
  );

  if (matchedService) {
    const hostname = matchedService.exposure?.hostname;
    if (hostname) {
      if (providerAdapters.technitium?.unpublishRecord) {
        await providerAdapters.technitium.unpublishRecord({ hostname });
      }
      const proxyService = project.config.managedInventory.platform.reverseProxy;
      if (proxyService && providerAdapters[proxyService.service]?.unpublishRoute) {
        await providerAdapters[proxyService.service].unpublishRoute({ hostname });
      }
      if (proxyService?.service === "caddy") {
        persistCaddyLiveConfig(proxmox, project.state.providerReferences[proxyService.id]?.vmid);
      }
    }

    const updatedServices = (project.config.managedInventory.services ?? []).filter(
      (s) => s.id !== matchedService.id
    );
    const updatedConfig = {
      ...project.config,
      managedInventory: {
        ...project.config.managedInventory,
        services: updatedServices
      }
    };

    const updatedProviderRefs = { ...project.state.providerReferences };
    delete updatedProviderRefs[matchedService.id];

    const updatedState = {
      ...project.state,
      providerReferences: updatedProviderRefs
    };

    writeAtomically(filesystem, project.configPath, serializeProjectConfiguration(updatedConfig));
    writeAtomically(filesystem, project.statePath, `${JSON.stringify(updatedState, null, 2)}\n`);
    filesystem.chmod(project.statePath, 0o600);

    return {
      stdout: `Exposure ${matchedService.name} (${hostname}) removed. DNS and proxy routes disconnected.\n`,
      service: matchedService.name
    };
  }

  throw new Error(`Service ${resolvedServiceName} not found in managed inventory.`);
}

async function destroyService(serviceName, rawOptions, adapters) {
  const { filesystem, runtime, proxmox, prompts } = adapters;
  assertProxmoxShell(runtime);

  const options = parseServiceDestroyOptions(rawOptions);
  const project = loadProject(filesystem, options.projectDir);

  let resolvedServiceName = serviceName;
  if (resolvedServiceName === undefined) {
    resolvedServiceName = await promptDestroyServiceName(project, prompts);
  }

  const platformEntries = Object.entries(project.config.managedInventory.platform);
  const matchedPlatform = platformEntries.find(
    ([key, item]) => item?.service === resolvedServiceName || key === resolvedServiceName
  );

  let managedItemId;
  let vmid;
  let platformKey;

  if (matchedPlatform && matchedPlatform[1]) {
    platformKey = matchedPlatform[0];
    managedItemId = matchedPlatform[1].id;
    vmid = project.state.providerReferences?.[managedItemId]?.vmid ??
      project.state.retainedServices?.[managedItemId]?.vmid;
  } else {
    const retainedEntry = Object.entries(project.state.retainedServices ?? {}).find(
      ([, ref]) => ref.service === resolvedServiceName
    );
    if (retainedEntry) {
      managedItemId = retainedEntry[0];
      vmid = retainedEntry[1].vmid;
    }
  }

  if (vmid === undefined) {
    throw new Error(`Service ${resolvedServiceName} not found or not provisioned/retained.`);
  }

  let confirmed = options.confirm || options.yes;
  if (!confirmed) {
    confirmed = await confirmPrompt(
      prompts,
      `Are you sure you want to permanently destroy LXC ${vmid} for ${resolvedServiceName} and delete all data?`,
      false
    );
  }

  if (!confirmed) {
    return {
      stdout: "Destruction cancelled. No resources were deleted.\n",
      cancelled: true
    };
  }

  if (proxmox?.stopLxc) {
    await proxmox.stopLxc(vmid);
  }
  if (proxmox?.destroyLxc) {
    await proxmox.destroyLxc(vmid);
  }

  let updatedConfig = project.config;
  if (platformKey && updatedConfig.managedInventory.platform[platformKey]?.deployment) {
    updatedConfig = {
      ...project.config,
      managedInventory: {
        ...project.config.managedInventory,
        platform: {
          ...project.config.managedInventory.platform,
          [platformKey]: {
            id: managedItemId,
            service: project.config.managedInventory.platform[platformKey].service
          }
        }
      }
    };
  }

  const updatedProviderRefs = { ...project.state.providerReferences };
  delete updatedProviderRefs[managedItemId];

  const updatedRetainedServices = { ...(project.state.retainedServices ?? {}) };
  delete updatedRetainedServices[managedItemId];

  const updatedState = {
    ...project.state,
    providerReferences: updatedProviderRefs,
    retainedServices: updatedRetainedServices
  };

  writeAtomically(filesystem, project.configPath, serializeProjectConfiguration(updatedConfig));
  writeAtomically(filesystem, project.statePath, `${JSON.stringify(updatedState, null, 2)}\n`);
  filesystem.chmod(project.statePath, 0o600);

  return {
    stdout: `Service ${resolvedServiceName} destroyed. LXC ${vmid} and all persistent data deleted.\n`,
    vmid,
    service: resolvedServiceName
  };
}

async function recheckService(serviceName, rawOptions, adapters) {
  const { filesystem, runtime, proxmox, providerAdapters = {}, prompts } = adapters;
  assertProxmoxShell(runtime);
  const options = parseServiceRecheckOptions(rawOptions);
  const project = loadProject(filesystem, options.projectDir);
  let resolvedServiceName = serviceName;
  if (resolvedServiceName === undefined) {
    const loaded = loadProject(filesystem, options.projectDir);
    resolvedServiceName = await promptServiceName(loaded, prompts);
  }
  const platformEntries = Object.entries(project.config.managedInventory.platform);
  const matchedPlatform = platformEntries.find(
    ([key, item]) => item?.service === resolvedServiceName || key === resolvedServiceName || item?.id === resolvedServiceName
  );
  if (!matchedPlatform || !matchedPlatform[1]) {
    throw new Error(`Service ${resolvedServiceName} is not configured in this project.`);
  }
  const [platformKey, managedItem] = matchedPlatform;
  const existingRef = project.state.providerReferences?.[managedItem.id];
  if (existingRef !== undefined) {
    throw new Error(`Service ${resolvedServiceName} is already provisioned (vmid ${existingRef.vmid}). Use 'nomina service upgrade' or check health.`);
  }
  let ip = options.ip;
  if (ip === undefined) {
    if (prompts?.ask === undefined) {
      throw new Error("Static IP is required. Pass --ip <address> or run from an interactive terminal.");
    }
    ip = await (async () => {
      while (true) {
        const answer = await prompts.ask(`Static IP for ${resolvedServiceName} to recheck`, undefined);
        if (answer && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(answer.trim())) return answer.trim();
        if (prompts?.warn) prompts.warn("Enter a valid IPv4 address, for example 10.0.0.53.");
      }
    })();
  }
  if (!isIpAddress(ip)) {
    throw new Error(`Invalid static IP: ${ip}.`);
  }
  if (proxmox === undefined || typeof proxmox.checkIpAvailability !== "function") {
    throw new Error("Proxmox adapter is unavailable.");
  }
  const availability = await proxmox.checkIpAvailability(ip);
  if (availability.status !== "known-collision") {
    throw new Error(`No existing LXC found at ${ip}. Run 'nomina service add ${resolvedServiceName} --ip ${ip}' to create a new one.`);
  }
  const vmid = Number(String(availability.conflictWith).split("/")[1] ?? String(availability.conflictWith).replace(/\D/g, ""));
  if (!Number.isFinite(vmid)) {
    throw new Error(`Could not determine vmid for ${ip} (${availability.conflictWith}).`);
  }
  const lxcInfo = typeof proxmox.inspectLxc === "function" ? await proxmox.inspectLxc(vmid) : {};
  const providerAdapter = providerAdapters[managedItem.service] ?? providerAdapters.caddy;
  if (providerAdapter === undefined) {
    throw new Error(`${resolvedServiceName} provider adapter is unavailable.`);
  }
  const connectionSecretReference = project.config.connectionSecretReferences[managedItem.id];
  // Ensure secret exists (for Technitium etc.)
  await ensureConnectionSecret(adapters, resolvedServiceName.charAt(0).toUpperCase() + resolvedServiceName.slice(1), connectionSecretReference);
  const providerContext = {
    connectionSecretReference,
    ip,
    zone: project.config.baseLocalDomain
  };
  const plugin = getPlatformProvider(managedItem.service);
  const health = await withBoundedRetry(
    () => plugin.healthCheck(providerAdapter, managedItem, providerContext),
    { maxRetries: 6, baseDelayMs: 2000, backoffFactor: 1.5 }
  );
  if (health.status !== "healthy") {
    throw new Error(`LXC ${vmid} at ${ip} is not healthy (process=${health.process}, endpoint=${health.endpoint}). Check 'pct exec ${vmid} -- systemctl status' and try again.`);
  }
  const inspection = await withBoundedRetry(
    () => plugin.inspect(providerAdapter, managedItem, { ...providerContext, providerReferences: platformKey === "dns" ? [project.config.baseLocalDomain] : [] }),
    { maxRetries: 6, baseDelayMs: 2000, backoffFactor: 1.5 }
  );
  const deployment = {
    ip,
    hostname: lxcInfo.hostname ?? `${resolvedServiceName}`,
    bridge: lxcInfo.bridge ?? project.config.proxmox.defaultBridge,
    storage: lxcInfo.storage ?? project.config.proxmox.defaultStorage,
    template: lxcInfo.template ?? project.config.proxmox.defaultStorage,
    resources: managedItem.deployment?.resources ?? { cpus: 2, memoryMb: 512, diskGb: 4 }
  };
  // Prefer actual lxcSpec-like deployment if inspection provides it, but keep our constructed one
  const updatedConfig = updatePlatformDeployment(project.config, platformKey, deployment);
  const updatedState = {
    ...project.state,
    providerReferences: {
      ...project.state.providerReferences,
      [managedItem.id]: { vmid, ip }
    }
  };
  writeAtomically(filesystem, project.configPath, serializeProjectConfiguration(updatedConfig));
  writeAtomically(filesystem, project.statePath, `${JSON.stringify(updatedState, null, 2)}\n`);
  filesystem.chmod(project.statePath, 0o600);
  const healthLabel = health.status === "healthy" ? "healthy" : "unhealthy";
  return {
    stdout: `Rechecked ${resolvedServiceName}: LXC ${vmid} at ${ip} (${deployment.hostname}) is ${healthLabel} and adopted. Inspected ${inspection?.managed?.length ?? 0} managed resource(s).\n`,
    health,
    inspection,
    vmid,
    ip
  };
}

function stepCaCaHost(project) {
  const caService = project.config.managedInventory.platform.certificateAuthority;
  const hostname = caService?.deployment?.hostname ?? "step-ca";
  return `${hostname}.${project.config.baseLocalDomain}`;
}

async function ensureCaddyTrustsStepCa(project, adapters) {
  const { proxmox } = adapters;
  const caService = project.config.managedInventory.platform.certificateAuthority;
  const proxyService = project.config.managedInventory.platform.reverseProxy;
  if (proxmox?.pctExec === undefined || caService?.service !== "step-ca" || proxyService === undefined) {
    return;
  }
  const caRef = project.state.providerReferences[caService.id];
  const proxyRef = project.state.providerReferences[proxyService.id];
  if (typeof caRef?.ip !== "string" || !isIpAddress(caRef.ip) || proxyRef?.vmid === undefined) {
    return;
  }
  const caHost = stepCaCaHost(project);
  await proxmox.pctExec(proxyRef.vmid, {
    binary: "/bin/bash",
    args: ["-c", `grep -q '${caHost}' /etc/hosts || echo '${caRef.ip} ${caHost}' >> /etc/hosts`]
  });
  await proxmox.pctExec(proxyRef.vmid, {
    binary: "/bin/bash",
    args: ["-c", `mkdir -p /usr/local/share/ca-certificates && curl -skf https://${caHost}:9000/roots.pem -o /usr/local/share/ca-certificates/step-ca-root.crt && update-ca-certificates`]
  });
}

function persistCaddyLiveConfig(proxmox, vmid) {
  if (proxmox?.pctExec === undefined || vmid === undefined) {
    return undefined;
  }
  return proxmox.pctExec(vmid, {
    binary: "/bin/bash",
    args: ["-c", "curl -sf http://127.0.0.1:2019/config/ > /etc/caddy/caddy.json"]
  });
}

async function handleDomainCommand(argumentsList, adapters) {
  const [subcommand, ...rest] = argumentsList;
  if (subcommand !== "change") {
    throw new Error("Run nomina for the interactive menu, or use: nomina domain change <new-domain>");
  }
  const [maybeDomain, ...rawOptions] = rest[0]?.startsWith("--") ? [undefined, ...rest] : rest;
  const options = parseDomainChangeOptions(rawOptions);
  if (options.domain === undefined && maybeDomain !== undefined) {
    options.domain = maybeDomain;
  }
  return changeBaseDomain(options, adapters);
}

function isValidLocalDomain(domain) {
  return typeof domain === "string" && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(domain);
}

function parseDomainChangeOptions(rawOptions) {
  const options = {};
  const optionNames = new Map([["--project-dir", "projectDir"], ["--domain", "domain"]]);
  parseFlagOptions(rawOptions, optionNames, options);
  return options;
}

async function changeBaseDomain(options, adapters) {
  const { filesystem, proxmox, providerAdapters = {}, prompts } = adapters;
  assertProxmoxShell(adapters.runtime);

  const project = loadProject(filesystem, options.projectDir);
  let newDomain = typeof options.domain === "string" ? options.domain.trim() : undefined;
  if ((newDomain === undefined || newDomain === "") && prompts?.ask !== undefined) {
    newDomain = (await prompts.ask(`New local domain (current: ${project.config.baseLocalDomain})`, undefined))?.trim();
  }
  if (!isValidLocalDomain(newDomain)) {
    throw new Error(`Invalid domain: ${newDomain}. Example: bunny.home.arpa`);
  }

  const oldDomain = project.config.baseLocalDomain;
  if (newDomain.toLowerCase() === oldDomain.toLowerCase()) {
    throw new Error(`${newDomain} is already the local domain.`);
  }
  newDomain = newDomain.toLowerCase();

  const dnsService = project.config.managedInventory.platform.dns;
  const proxyService = project.config.managedInventory.platform.reverseProxy;
  const caService = project.config.managedInventory.platform.certificateAuthority;
  if (proxyService?.service !== "caddy" && proxyService?.service !== "traefik") {
    throw new Error("A supported reverse proxy must be provisioned before changing the local domain.");
  }
  const technitiumAdapter = providerAdapters.technitium;
  const proxyAdapter = providerAdapters[proxyService.service];
  if (technitiumAdapter?.publishRecord === undefined || proxyAdapter?.publishRoute === undefined) {
    throw new Error("Provider adapter is unavailable.");
  }

  const state = project.state;
  const dnsRef = state.providerReferences[dnsService.id];
  const proxyRef = state.providerReferences[proxyService.id];
  const swapHost = (hostname) => hostname.endsWith(`.${oldDomain}`)
    ? `${hostname.slice(0, -(oldDomain.length + 1))}.${newDomain}`
    : hostname;

  const warnings = [];
  const exposures = (project.config.managedInventory.services ?? []).filter(
    (service) => service.exposure?.hostname !== undefined
  );

  for (const service of exposures) {
    const oldHost = service.exposure.hostname;
    try {
      if (technitiumAdapter.deleteRecord !== undefined) {
        await technitiumAdapter.deleteRecord({
          hostname: oldHost,
          ip: proxyRef?.ip,
          endpoint: dnsRef?.ip ? `http://${dnsRef.ip}:5380` : undefined,
          connectionSecretReference: project.config.connectionSecretReferences[dnsService.id]
        });
      }
      await proxyAdapter.unpublishRoute({
        hostname: oldHost,
        ip: proxyRef?.ip,
        endpoint: proxyRef?.ip ? `http://${proxyRef.ip}:2019` : undefined
      });
    } catch (error) {
      warnings.push(`Could not clean up old record/route for ${oldHost}: ${error.message}`);
    }
  }

  const renamedServices = (project.config.managedInventory.services ?? []).map((service) =>
    service.exposure?.hostname !== undefined
      ? { ...service, exposure: { ...service.exposure, hostname: swapHost(service.exposure.hostname) } }
      : service
  );
  const workingProject = {
    ...project,
    config: {
      ...project.config,
      baseLocalDomain: newDomain,
      managedInventory: {
        ...project.config.managedInventory,
        services: renamedServices
      }
    }
  };

  if (caService?.service === "step-ca") {
    const caRef = state.providerReferences[caService.id];
    if (proxmox?.pctExec !== undefined && caRef?.vmid !== undefined) {
      await proxmox.pctExec(caRef.vmid, {
        binary: "/bin/bash",
        args: ["-c", `sed -i 's/"dnsNames": \\[/&\\n    "step-ca.${newDomain}",/' /var/lib/stepca/config/ca.json && rm -f /var/lib/stepca/certs/localhost.crt && systemctl restart step-ca`]
      });
    }
    await ensureCaddyTrustsStepCa(workingProject, adapters);
  }

  for (const service of renamedServices) {
    if (service.exposure === undefined) {
      continue;
    }
      await publishManagedExposure({
        project: workingProject,
        options: {
          name: service.name,
          hostname: service.exposure.hostname,
          backendIp: service.exposure.backend.ip,
          backendPort: Number(service.exposure.backend.port)
        },
        providerAdapters
      });
  }

  persistCaddyLiveConfig(proxmox, proxyRef?.vmid);

  writeAtomically(filesystem, project.configPath, serializeProjectConfiguration(workingProject.config));

  return {
    stdout: `Local domain changed to ${newDomain}. Migrated ${exposures.length} exposure(s). Health checks passed per exposure.${warnings.length > 0 ? `\nWarning: ${warnings.join("\nWarning: ")}` : ""}\n`,
    domain: newDomain,
    migratedExposures: exposures.length,
    warnings
  };
}

async function publishExposure(options, adapters) {
  const { filesystem, providerAdapters = {} } = adapters;
  assertProxmoxShell(adapters.runtime);

  const project = loadProject(filesystem, options.projectDir);
  const resolvedOptions = await promptExposureOptions(project, options, adapters.prompts);
  validateExposureOptions(resolvedOptions);

  await ensureCaddyTrustsStepCa(project, adapters);

  const result = await publishManagedExposure({
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

  const proxyServiceForPersistence = project.config.managedInventory.platform.reverseProxy;
  if (proxyServiceForPersistence?.service === "caddy") {
    persistCaddyLiveConfig(adapters.proxmox, project.state.providerReferences[proxyServiceForPersistence.id]?.vmid);
  }

  const actionLabel = result.isUpdate ? "updated" : "published";
  const healthLabel = result.health.status === "healthy" ? "healthy" : "unhealthy";

  return {
    stdout: `Exposure ${actionLabel} for ${resolvedOptions.hostname} via HTTPS at ${resolvedOptions.backendIp}:${resolvedOptions.backendPort}. Health: ${healthLabel}.\n`,
    health: result.health,
    dnsInspection: result.dnsInspection,
    proxyInspection: result.proxyInspection,
    ...(result.caInspection !== undefined ? { caInspection: result.caInspection } : {}),
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
  const setupPlan = await createSetupPlan(managedInventory, adapters.providerAdapters);
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
    ["--template", "template"],
    ["--gateway", "gateway"],
    ["--nameserver", "nameserver"],
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

function parseSecretChangeOptions(rawOptions) {
  const options = {};
  const optionNames = new Map([
    ["--project-dir", "projectDir"],
    ["--service", "service"]
  ]);
  parseFlagOptions(rawOptions, optionNames, options);
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

function parseServiceUpgradeOptions(rawOptions) {
  const options = {};
  const optionNames = new Map([
    ["--project-dir", "projectDir"],
    ["--snapshot", "snapshot"],
    ["--no-snapshot", "noSnapshot"],
    ["--snapshot-name", "snapshotName"]
  ]);
  const booleanFlags = new Set(["--snapshot", "--no-snapshot"]);
  parseFlagOptions(rawOptions, optionNames, options, booleanFlags);
  if (options.noSnapshot) {
    options.snapshot = false;
  }
  return options;
}

function parseServiceRemoveOptions(rawOptions) {
  const options = {};
  const optionNames = new Map([
    ["--project-dir", "projectDir"],
    ["--force", "force"]
  ]);
  const booleanFlags = new Set(["--force"]);
  parseFlagOptions(rawOptions, optionNames, options, booleanFlags);
  return options;
}

function parseServiceDestroyOptions(rawOptions) {
  const options = {};
  const optionNames = new Map([
    ["--project-dir", "projectDir"],
    ["--confirm", "confirm"],
    ["--yes", "yes"],
    ["-y", "yes"]
  ]);
  const booleanFlags = new Set(["--confirm", "--yes", "-y"]);
  parseFlagOptions(rawOptions, optionNames, options, booleanFlags);
  return options;
}

function parseServiceRecheckOptions(rawOptions) {
  const options = {};
  const optionNames = new Map([
    ["--project-dir", "projectDir"],
    ["--ip", "ip"]
  ]);
  parseFlagOptions(rawOptions, optionNames, options);
  return options;
}

function parseFlagOptions(rawOptions, optionNames, options, booleanFlags = new Set()) {
  for (let index = 0; index < rawOptions.length;) {
    const rawFlag = rawOptions[index];
    const key = optionNames.get(rawFlag);
    if (!key) {
      throw new Error(`Unknown or incomplete option: ${rawFlag ?? ""}`);
    }
    if (booleanFlags.has(rawFlag)) {
      const nextValue = rawOptions[index + 1];
      if (nextValue === "true") {
        options[key] = true;
        index += 2;
      } else if (nextValue === "false") {
        options[key] = false;
        index += 2;
      } else {
        options[key] = true;
        index += 1;
      }
    } else {
      const value = rawOptions[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Unknown or incomplete option: ${rawFlag ?? ""}`);
      }
      options[key] = value;
      index += 2;
    }
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

async function createSetupPlan(inventory, providerAdapters = {}) {
  const selectedProviders = Object.values(inventory.platform).filter((item) => item !== null);
  return await Promise.all(selectedProviders.map(async (managedItem) => {
    const plugin = getPlatformProvider(managedItem.service);
    const adapter = providerAdapters[managedItem.service] ?? PLAN_ONLY_ADAPTER;
    return await plugin.setup(adapter, managedItem);
  }));
}

function assertProxmoxShell(runtime) {
  if (!runtime.isRoot()) {
    throw new Error("nomina must run as root from the Proxmox shell.");
  }
  if (!runtime.isProxmoxHost()) {
    throw new Error("nomina must run on a Proxmox host with local pct control.");
  }
}

async function listAvailableTemplates(proxmox) {
  if (typeof proxmox?.listTemplates !== "function") {
    return undefined;
  }
  try {
    const templates = await proxmox.listTemplates();
    return Array.isArray(templates) && templates.length > 0 ? templates : undefined;
  } catch {
    return undefined;
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
