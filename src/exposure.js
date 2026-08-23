import { randomUUID } from "node:crypto";
import { withHealthyRetry } from "./adoption.js";
import { getPlatformProvider } from "./providers.js";

export async function publishManagedExposure({
  project,
  options,
  providerAdapters,
  healthRetryOptions = {}
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
  const dnsRef = project.state.providerReferences[dnsService.id];
  const proxyRef = project.state.providerReferences[proxyService.id];
  const publishRequest = {
    managedItemId: dnsService.id,
    hostname,
    ip: proxyRef?.ip ?? backendIp,
    zone: project.config.baseLocalDomain,
    endpoint: dnsRef?.ip ? `http://${dnsRef.ip}:5380` : undefined,
    ipForEndpoint: dnsRef?.ip,
    connectionSecretReference: project.config.connectionSecretReferences[dnsService.id]
  };
  // Provide both endpoint and ip for Technitium: endpoint is server, ip is record value. Preserve 'ip' as record IP for backwards compat; add endpoint.
  // Technitium adapter resolves endpoint via explicit endpoint or ip fallback, so we set endpoint explicitly.

  const caStrategy = caService?.service ?? "none";
  let tlsOptions;
  if (caStrategy === "caddy-internal-ca") {
    tlsOptions = { mode: "caddy-internal-ca", issuer: "caddy-internal-ca", trusted: true };
  } else if (caStrategy === "step-ca") {
    const caRef = project.state.providerReferences[caService?.id];
    const caHostname = caService.deployment?.hostname ?? "step-ca";
    tlsOptions = {
      mode: "step-ca",
      issuer: "step-ca",
      ...(caRef?.ip ? { caIp: caRef.ip } : {}),
      caHost: `${caHostname}.${project.config.baseLocalDomain}`,
      trusted: true
    };
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
    tls: tlsOptions,
    ip: proxyRef?.ip,
    endpoint: proxyRef?.ip ? `http://${proxyRef.ip}:2019` : undefined,
    connectionSecretReference: project.config.connectionSecretReferences[proxyService.id]
  };

  await technitiumAdapter.publishRecord(publishRequest);
  await proxyAdapter.publishRoute(routeRequest);

  const dnsPlugin = getPlatformProvider("technitium");
  const proxyPlugin = getPlatformProvider(proxyService.service);
  const dnsInspection = await dnsPlugin.inspect(technitiumAdapter, dnsService, {
    providerReferences: collectManagedDnsReferences(project, hostname),
    zone: project.config.baseLocalDomain,
    ip: dnsRef?.ip,
    endpoint: dnsRef?.ip ? `http://${dnsRef.ip}:5380` : undefined,
    connectionSecretReference: project.config.connectionSecretReferences[dnsService.id]
  });
  const proxyInspection = await proxyPlugin.inspect(proxyAdapter, proxyService, {
    providerReferences: collectManagedProxyReferences(project, hostname),
    ip: proxyRef?.ip,
    endpoint: proxyRef?.ip ? `http://${proxyRef.ip}:2019` : undefined,
    connectionSecretReference: project.config.connectionSecretReferences[proxyService.id]
  });

  let caInspection;
  let caExposureHealth;
  if (caService !== null && caService !== undefined) {
    const caAdapter = providerAdapters[caService.service] ?? providerAdapters[proxyService.service];
    if (caAdapter !== undefined) {
      const caPlugin = getPlatformProvider(caService.service);
      const caRef = project.state.providerReferences[caService.id];
      const caIp = caRef?.ip ?? proxyRef?.ip;
      const caEndpoint = caIp
        ? (caService.service === "step-ca" ? `https://${caIp}:9000` : `http://${caIp}:2019`)
        : undefined;
      caInspection = await caPlugin.inspect(caAdapter, caService, {
        providerReferences: collectManagedCaReferences(project, hostname),
        ip: caIp,
        endpoint: caEndpoint,
        connectionSecretReference: project.config.connectionSecretReferences[caService.id]
      });
      caExposureHealth = await caAdapter.healthCheckExposure?.({
        hostname,
        backendIp,
        backendPort,
        ip: caIp,
        endpoint: caEndpoint
      })
        ?? { tls: "valid", issuer: caService.service, status: "healthy" };
      if (caExposureHealth?.status !== "healthy") {
        caExposureHealth = await withHealthyRetry(
          () => caAdapter.healthCheckExposure({
            hostname,
            backendIp,
            backendPort,
            ip: caIp,
            endpoint: caEndpoint
          }),
          healthRetryOptions
        );
      }
    }
  }

  const dnsExposureHealth = await withHealthyRetry(
    () => technitiumAdapter.healthCheckExposure({
      hostname,
      backendIp,
      backendPort,
      zone: project.config.baseLocalDomain,
      ip: dnsRef?.ip,
      endpoint: dnsRef?.ip ? `http://${dnsRef.ip}:5380` : undefined,
      connectionSecretReference: project.config.connectionSecretReferences[dnsService.id]
    }),
    healthRetryOptions
  )
    ?? { dns: "reachable", status: "healthy" };
  const proxyExposureHealth = await withHealthyRetry(
    () => proxyAdapter.healthCheckExposure({
      hostname,
      backendIp,
      backendPort,
      ip: proxyRef?.ip,
      endpoint: proxyRef?.ip ? `http://${proxyRef.ip}:2019` : undefined
    }),
    healthRetryOptions
  )
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
