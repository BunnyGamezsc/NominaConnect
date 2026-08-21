import { randomUUID } from "node:crypto";
import { getPlatformProvider } from "./providers.js";

export async function publishManagedExposure({
  project,
  options,
  providerAdapters
}) {
  const dnsService = project.config.managedInventory.platform.dns;
  const proxyService = project.config.managedInventory.platform.reverseProxy;
  const caService = project.config.managedInventory.platform.certificateAuthority;

  if (dnsService?.service !== "technitium") {
    throw new Error("Technitium is not selected as the DNS provider for this project.");
  }
  if (proxyService?.service !== "caddy" && proxyService?.service !== "traefik") {
    throw new Error("A supported reverse proxy (Caddy or Traefik) is not selected for this project.");
  }
  const proxyLabel = proxyService.service === "traefik" ? "Traefik" : "Caddy";
  if (project.state.providerReferences[dnsService.id] === undefined) {
    throw new Error("Technitium must be provisioned before publishing an exposure.");
  }
  if (project.state.providerReferences[proxyService.id] === undefined) {
    throw new Error(`${proxyLabel} must be provisioned before publishing an exposure.`);
  }
  if (caService !== null && caService !== undefined) {
    const caLabel = caService.service === "caddy-internal-ca" ? "Caddy Internal CA" : caService.service;
    if (project.state.providerReferences[caService.id] === undefined) {
      throw new Error(`${caLabel} must be provisioned before publishing an exposure.`);
    }
  }

  const technitiumAdapter = providerAdapters.technitium;
  const proxyAdapter = providerAdapters[proxyService.service];
  if (technitiumAdapter?.publishRecord === undefined) {
    throw new Error("Technitium provider adapter is unavailable.");
  }
  if (proxyAdapter?.publishRoute === undefined) {
    throw new Error(`${proxyLabel} provider adapter is unavailable.`);
  }

  const { name, hostname, backendIp, backendPort } = options;
  const publishRequest = {
    managedItemId: dnsService.id,
    hostname,
    ip: backendIp
  };

  const caStrategy = caService?.service ?? "none";
  let tlsOptions;
  if (caStrategy === "caddy-internal-ca") {
    tlsOptions = { mode: "caddy-internal-ca", issuer: "caddy-internal-ca", trusted: true };
  } else if (caStrategy === "step-ca") {
    const caIp = project.state.providerReferences[caService?.id]?.ip;
    tlsOptions = { mode: "step-ca", issuer: "step-ca", ...(caIp ? { caIp } : {}), trusted: true };
  } else {
    tlsOptions = { mode: "untrusted", trusted: false };
  }

  const routeRequest = {
    managedItemId: proxyService.id,
    hostname,
    backendIp,
    backendPort,
    protocol: "https",
    caStrategy,
    tls: tlsOptions
  };

  await technitiumAdapter.publishRecord(publishRequest);
  await proxyAdapter.publishRoute(routeRequest);

  const dnsPlugin = getPlatformProvider("technitium");
  const proxyPlugin = getPlatformProvider(proxyService.service);
  const dnsInspection = await dnsPlugin.inspect(technitiumAdapter, dnsService, {
    providerReferences: collectManagedDnsReferences(project, hostname)
  });
  const proxyInspection = await proxyPlugin.inspect(proxyAdapter, proxyService, {
    providerReferences: collectManagedProxyReferences(project, hostname)
  });

  let caInspection;
  let caExposureHealth;
  if (caService !== null && caService !== undefined) {
    const caAdapter = providerAdapters[caService.service] ?? providerAdapters[proxyService.service];
    if (caAdapter !== undefined) {
      const caPlugin = getPlatformProvider(caService.service);
      caInspection = await caPlugin.inspect(caAdapter, caService, {
        providerReferences: collectManagedCaReferences(project, hostname)
      });
      caExposureHealth = await caAdapter.healthCheckExposure?.({ hostname, backendIp, backendPort })
        ?? { tls: "valid", issuer: caService.service, status: "healthy" };
    }
  }

  const dnsExposureHealth = await technitiumAdapter.healthCheckExposure?.({ hostname, backendIp, backendPort })
    ?? { dns: "reachable", status: "healthy" };
  const proxyExposureHealth = await proxyAdapter.healthCheckExposure?.({ hostname, backendIp, backendPort })
    ?? { https: "reachable", status: "healthy" };
  const healthy = dnsExposureHealth.status === "healthy"
    && proxyExposureHealth.status === "healthy"
    && (caExposureHealth === undefined || caExposureHealth.status === "healthy");

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
      protocol: "https",
      certificateAuthority: caStrategy,
      tls: {
        mode: tlsOptions.mode,
        trusted: tlsOptions.trusted
      }
    }
  };

  return {
    managedService,
    isUpdate: existingService !== undefined,
    dnsInspection,
    proxyInspection,
    ...(caInspection !== undefined ? { caInspection } : {}),
    health: {
      status: healthy ? "healthy" : "unhealthy",
      dns: dnsExposureHealth,
      reverseProxy: proxyExposureHealth,
      ...(caExposureHealth !== undefined ? { certificateAuthority: caExposureHealth } : {})
    },
    integrationReferences: {
      dns: hostname,
      reverseProxy: hostname,
      ...(caService ? { certificateAuthority: hostname } : {})
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

function collectManagedCaReferences(project, hostname) {
  const references = project.config.managedInventory.services
    .map((service) => service.exposure?.hostname)
    .filter((value) => value !== undefined);
  if (!references.includes(hostname)) {
    references.push(hostname);
  }
  return references;
}
