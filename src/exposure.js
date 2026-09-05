import { randomUUID } from "node:crypto";
import { withHealthyRetry } from "./adoption.js";
import { getPlatformProvider } from "./providers.js";

// Caddy is driven through its Admin API on :2019; Traefik is observed through
// its dashboard/API on :8080. Callers that build a proxy request must go
// through this so a Traefik project never gets pointed at Caddy's port.
export function proxyEndpointFor(proxyServiceName, ip) {
  if (ip === undefined) {
    return undefined;
  }
  return proxyServiceName === "traefik" ? `http://${ip}:8080` : `http://${ip}:2019`;
}

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
    tlsOptions = {
      mode: "step-ca",
      issuer: "step-ca",
      ...(caRef?.ip ? { caIp: caRef.ip } : {}),
      caHost: stepCaCaHost(project),
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
    backendTls: options.backendTls === true,
    protocol: "https",
    caStrategy,
    tls: tlsOptions,
    zone: project.config.baseLocalDomain,
    httpRedirect: proxyService.httpRedirect === true,
    ip: proxyRef?.ip,
    vmid: proxyRef?.vmid,
    endpoint: proxyEndpointFor(proxyService.service, proxyRef?.ip),
    connectionSecretReference: project.config.connectionSecretReferences[proxyService.id]
  };

  await technitiumAdapter.publishRecord(publishRequest);
  const publishedRoute = await proxyAdapter.publishRoute(routeRequest);
  // A proxy that could not complete the trusted-certificate wiring still
  // publishes the exposure over HTTPS; the reason it stayed untrusted is
  // reported rather than swallowed.
  const warnings = [...(publishedRoute?.warnings ?? [])];

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
    vmid: proxyRef?.vmid,
    endpoint: proxyEndpointFor(proxyService.service, proxyRef?.ip),
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
        ? (caService.service === "step-ca" ? `https://${caIp}:9000` : proxyEndpointFor(caService.service, caIp))
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
      caStrategy,
      ip: proxyRef?.ip,
      vmid: proxyRef?.vmid,
      endpoint: proxyEndpointFor(proxyService.service, proxyRef?.ip)
    }),
    healthRetryOptions
  )
    ?? { https: "reachable", status: "healthy" };
  const healthy = dnsExposureHealth.status === "healthy"
    && proxyExposureHealth.status === "healthy"
    && (caExposureHealth === undefined || caExposureHealth.status === "healthy");

  // A CA-backed project only records trusted TLS when the proxy actually
  // presents a trusted certificate. Persisting the intent while the exposure
  // is serving an untrusted one would claim a trust nothing verified.
  const observedTls = proxyExposureHealth?.tls;
  const trusted = tlsOptions.trusted
    && observedTls !== "untrusted"
    && observedTls !== "missing"
    && observedTls !== "unknown";

  const existingService = project.config.managedInventory.services.find(
    (service) => service.exposure?.hostname === hostname
  );
  const serviceId = existingService?.id ?? `nc_${randomUUID()}`;
  const managedService = {
    id: serviceId,
    name,
    exposure: {
      hostname,
      backend: {
        ip: backendIp,
        port: backendPort,
        ...(options.backendTls === true ? { tls: true } : {})
      },
      protocol: "https",
      certificateAuthority: caStrategy,
      tls: {
        mode: tlsOptions.mode,
        trusted
      }
    }
  };

  return {
    managedService,
    isUpdate: existingService !== undefined,
    warnings,
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

export function stepCaCaHost(project) {
  const caService = project.config.managedInventory.platform.certificateAuthority;
  const hostname = caService?.deployment?.hostname ?? "step-ca";
  return `${hostname}.${project.config.baseLocalDomain}`;
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
