import { randomUUID } from "node:crypto";
import { getPlatformProvider } from "./providers.js";

export function publishManagedExposure({
  project,
  options,
  providerAdapters
}) {
  const dnsService = project.config.managedInventory.platform.dns;
  const proxyService = project.config.managedInventory.platform.reverseProxy;

  if (dnsService?.service !== "technitium") {
    throw new Error("Technitium is not selected as the DNS provider for this project.");
  }
  if (proxyService?.service !== "caddy") {
    throw new Error("Caddy is not selected as the reverse proxy for this project.");
  }
  if (project.state.providerReferences[dnsService.id] === undefined) {
    throw new Error("Technitium must be provisioned before publishing an exposure.");
  }
  if (project.state.providerReferences[proxyService.id] === undefined) {
    throw new Error("Caddy must be provisioned before publishing an exposure.");
  }

  const technitiumAdapter = providerAdapters.technitium;
  const caddyAdapter = providerAdapters.caddy;
  if (technitiumAdapter?.publishRecord === undefined) {
    throw new Error("Technitium provider adapter is unavailable.");
  }
  if (caddyAdapter?.publishRoute === undefined) {
    throw new Error("Caddy provider adapter is unavailable.");
  }

  const { name, hostname, backendIp, backendPort } = options;
  const publishRequest = {
    managedItemId: dnsService.id,
    hostname,
    ip: backendIp
  };
  const routeRequest = {
    managedItemId: proxyService.id,
    hostname,
    backendIp,
    backendPort,
    protocol: "https"
  };

  technitiumAdapter.publishRecord(publishRequest);
  caddyAdapter.publishRoute(routeRequest);

  const dnsPlugin = getPlatformProvider("technitium");
  const caddyPlugin = getPlatformProvider("caddy");
  const dnsInspection = dnsPlugin.inspect(technitiumAdapter, dnsService, {
    providerReferences: collectManagedDnsReferences(project, hostname)
  });
  const proxyInspection = caddyPlugin.inspect(caddyAdapter, proxyService, {
    providerReferences: collectManagedProxyReferences(project, hostname)
  });

  const dnsExposureHealth = technitiumAdapter.healthCheckExposure?.({ hostname, backendIp, backendPort })
    ?? { dns: "reachable", status: "healthy" };
  const proxyExposureHealth = caddyAdapter.healthCheckExposure?.({ hostname, backendIp, backendPort })
    ?? { https: "reachable", status: "healthy" };
  const healthy = dnsExposureHealth.status === "healthy" && proxyExposureHealth.status === "healthy";

  const existingService = project.config.managedInventory.services.find(
    (service) => service.exposure?.hostname === hostname
  );
  const serviceId = existingService?.id ?? `nc_${randomUUID()}`;
  const managedService = {
    id: serviceId,
    name,
    exposure: {
      hostname,
      backend: { ip: backendIp, port: backendPort },
      protocol: "https"
    }
  };

  return {
    managedService,
    isUpdate: existingService !== undefined,
    dnsInspection,
    proxyInspection,
    health: {
      status: healthy ? "healthy" : "unhealthy",
      dns: dnsExposureHealth,
      reverseProxy: proxyExposureHealth
    },
    integrationReferences: {
      dns: hostname,
      reverseProxy: hostname
    }
  };
}

function collectManagedDnsReferences(project, hostname) {
  const references = [project.config.baseLocalDomain];
  for (const service of project.config.managedInventory.services) {
    if (service.exposure?.hostname !== undefined) {
      references.push(service.exposure.hostname);
    }
  }
  if (!references.includes(hostname)) {
    references.push(hostname);
  }
  return references;
}

function collectManagedProxyReferences(project, hostname) {
  const references = project.config.managedInventory.services
    .map((service) => service.exposure?.hostname)
    .filter((value) => value !== undefined);
  if (!references.includes(hostname)) {
    references.push(hostname);
  }
  return references;
}
