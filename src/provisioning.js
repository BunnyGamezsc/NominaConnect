import { getPlatformProvider } from "./providers.js";

export const TECHNITIUM_DEPLOYMENT = Object.freeze({
  defaultHostname: "technitium",
  template: "debian-12-standard",
  resourceRecommendations: Object.freeze({ cpus: 2, memoryMb: 1024, diskGb: 8 })
});

export const CADDY_DEPLOYMENT = Object.freeze({
  defaultHostname: "caddy",
  template: "debian-12-standard",
  resourceRecommendations: Object.freeze({ cpus: 2, memoryMb: 512, diskGb: 4 })
});

const PLATFORM_DEPLOYMENTS = Object.freeze({
  technitium: TECHNITIUM_DEPLOYMENT,
  caddy: CADDY_DEPLOYMENT
});

export function runIpPreflight(proxmox, ip) {
  const result = proxmox.checkIpAvailability(ip);
  if (result.status === "known-collision") {
    const detail = result.conflictWith ? ` (${result.conflictWith})` : "";
    throw new Error(`Requested IP ${ip} is already in use${detail}.`);
  }
  const warnings = [];
  if (result.status === "uncertain") {
    const detail = result.reason ? `: ${result.reason}` : "";
    const message = `Requested IP ${ip} availability is uncertain${detail}`;
    warnings.push(message.endsWith(".") ? message : `${message}.`);
  }
  return warnings;
}

export function resolveServiceDeployment(project, serviceName, options) {
  const deploymentDefaults = PLATFORM_DEPLOYMENTS[serviceName];
  if (deploymentDefaults === undefined) {
    throw new Error(`Unsupported service deployment: ${serviceName}.`);
  }

  const resources = {
    cpus: options.cpus ?? deploymentDefaults.resourceRecommendations.cpus,
    memoryMb: options.memoryMb ?? deploymentDefaults.resourceRecommendations.memoryMb,
    diskGb: options.diskGb ?? deploymentDefaults.resourceRecommendations.diskGb
  };

  return {
    node: project.config.proxmox.node,
    hostname: options.hostname ?? deploymentDefaults.defaultHostname,
    ip: options.ip,
    bridge: options.bridge ?? project.config.proxmox.defaultBridge,
    storage: options.storage ?? project.config.proxmox.defaultStorage,
    unprivileged: true,
    template: deploymentDefaults.template,
    resources
  };
}

export async function provisionPlatformService({
  project,
  platformKey,
  serviceName,
  managedItem,
  options,
  proxmox,
  providerAdapter
}) {
  const warnings = runIpPreflight(proxmox, options.ip);
  const lxcSpec = resolveServiceDeployment(project, serviceName, options);
  const created = proxmox.createLxc(lxcSpec);

  const plugin = getPlatformProvider(serviceName);
  const setupPlan = plugin.setup(providerAdapter, managedItem);
  const commands = setupPlan.lxcCommands ?? setupPlan.operations ?? [];
  for (const command of commands) {
    proxmox.pctExec(created.vmid, command);
  }

  const providerReferences = serviceName === "technitium"
    ? [project.config.baseLocalDomain]
    : [];
  const inspection = plugin.inspect(providerAdapter, managedItem, { providerReferences });
  const health = plugin.healthCheck(providerAdapter, managedItem);

  return {
    created,
    lxcSpec,
    warnings,
    inspection,
    health,
    providerReference: { vmid: created.vmid, ip: options.ip }
  };
}
