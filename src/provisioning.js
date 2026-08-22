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

export const TRAEFIK_DEPLOYMENT = Object.freeze({
  defaultHostname: "traefik",
  template: "debian-12-standard",
  resourceRecommendations: Object.freeze({ cpus: 2, memoryMb: 512, diskGb: 4 })
});

export const STEP_CA_DEPLOYMENT = Object.freeze({
  defaultHostname: "step-ca",
  template: "debian-12-standard",
  resourceRecommendations: Object.freeze({ cpus: 2, memoryMb: 512, diskGb: 4 })
});

export const TAILSCALE_DEPLOYMENT = Object.freeze({
  defaultHostname: "tailscale",
  template: "debian-12-standard",
  resourceRecommendations: Object.freeze({ cpus: 1, memoryMb: 256, diskGb: 2 })
});

export const NETBIRD_DEPLOYMENT = Object.freeze({
  defaultHostname: "netbird",
  template: "debian-12-standard",
  resourceRecommendations: Object.freeze({ cpus: 1, memoryMb: 256, diskGb: 2 })
});

const PLATFORM_DEPLOYMENTS = Object.freeze({
  technitium: TECHNITIUM_DEPLOYMENT,
  caddy: CADDY_DEPLOYMENT,
  traefik: TRAEFIK_DEPLOYMENT,
  "step-ca": STEP_CA_DEPLOYMENT,
  tailscale: TAILSCALE_DEPLOYMENT,
  netbird: NETBIRD_DEPLOYMENT
});

export async function runIpPreflight(proxmox, ip) {
  const result = await proxmox.checkIpAvailability(ip);
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
  const warnings = await runIpPreflight(proxmox, options.ip);
  const lxcSpec = resolveServiceDeployment(project, serviceName, options);
  const created = await proxmox.createLxc(lxcSpec);
  if (typeof proxmox.inspectLxc === "function") {
    await proxmox.inspectLxc(created.vmid);
  }

  const plugin = getPlatformProvider(serviceName);
  const providerContext = {
    connectionSecretReference: project.config.connectionSecretReferences[managedItem.id],
    ip: options.ip,
    zone: project.config.baseLocalDomain
  };
  const setupPlan = await plugin.setup(providerAdapter, managedItem, providerContext);
  const commands = setupPlan.lxcCommands ?? setupPlan.operations ?? [];
  for (const command of commands) {
    await proxmox.pctExec(created.vmid, command);
  }

  if (typeof providerAdapter.configure === "function") {
    await providerAdapter.configure({
      provider: serviceName,
      managedItemId: managedItem.id,
      ...providerContext
    });
  }

  const providerReferences = serviceName === "technitium"
    ? [project.config.baseLocalDomain]
    : [];
  const inspection = await plugin.inspect(providerAdapter, managedItem, { ...providerContext, providerReferences });
  const health = await plugin.healthCheck(providerAdapter, managedItem, providerContext);

  return {
    created,
    lxcSpec,
    warnings,
    inspection,
    health,
    providerReference: { vmid: created.vmid, ip: options.ip }
  };
}
