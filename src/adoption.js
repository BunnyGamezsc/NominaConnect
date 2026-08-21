import { getPlatformProvider } from "./providers.js";

export function collectPlatformServices(managedInventory) {
  const services = [];
  for (const [platformKey, managedItem] of Object.entries(managedInventory.platform)) {
    if (managedItem !== null) {
      services.push({ platformKey, managedItem });
    }
  }
  return services;
}

export function collectExposedServices(managedInventory) {
  return managedInventory.services.filter((service) => service.exposure !== undefined);
}

export function inspectPlatformService(adapter, managedItem, providerReferences) {
  if (adapter?.inspect === undefined) {
    return undefined;
  }
  const plugin = getPlatformProvider(managedItem.service);
  return plugin.inspect(adapter, managedItem, { providerReferences });
}

export function inspectExposedService(adapter, managedItem, providerReferences) {
  if (adapter?.inspect === undefined) {
    return undefined;
  }
  const plugin = getPlatformProvider(managedItem.service);
  return plugin.inspect(adapter, managedItem, { providerReferences });
}

export function detectPlatformChanges(observed, currentDeployment) {
  if (observed === undefined || observed.deployment === undefined) {
    return undefined;
  }
  if (currentDeployment === undefined) {
    return { kind: "platform-deployed", observed: observed.deployment };
  }
  const changes = {};
  for (const key of Object.keys(observed.deployment)) {
    if (key === "resources") {
      if (observed.deployment.resources === undefined) {
        continue;
      }
      const resourceChanges = {};
      let hasResourceChange = false;
      for (const rKey of Object.keys(observed.deployment.resources)) {
        if (observed.deployment.resources[rKey] !== currentDeployment.resources?.[rKey]) {
          resourceChanges[rKey] = observed.deployment.resources[rKey];
          hasResourceChange = true;
        }
      }
      if (hasResourceChange) {
        changes.resources = resourceChanges;
      }
    } else if (observed.deployment[key] !== currentDeployment[key]) {
      changes[key] = observed.deployment[key];
    }
  }
  if (Object.keys(changes).length === 0) {
    return undefined;
  }
  return { kind: "platform-changed", changes, observed: observed.deployment };
}

export function detectExposureChanges(observedResources, managedHostname, existingExposure) {
  if (observedResources === undefined) {
    return undefined;
  }
  const managedResource = observedResources.find((r) => r.id === managedHostname);
  if (managedResource === undefined) {
    return undefined;
  }
  if (existingExposure === undefined) {
    return { kind: "exposure-discovered", resource: managedResource };
  }
  return undefined;
}

export function adoptPlatformDeployment(config, platformKey, observedDeployment) {
  const service = config.managedInventory.platform[platformKey];
  if (service === null || service === undefined) {
    return config;
  }
  return {
    ...config,
    managedInventory: {
      ...config.managedInventory,
      platform: {
        ...config.managedInventory.platform,
        [platformKey]: { ...service, deployment: observedDeployment }
      }
    }
  };
}

export function createAdoptedChange(serviceName, platformKey, before, after, kind) {
  return {
    serviceName,
    platformKey,
    kind,
    before,
    after,
    verified: false,
    timestamp: new Date().toISOString()
  };
}

export async function withBoundedRetry(
  operation,
  {
    maxRetries = 2,
    baseDelayMs = 10,
    backoffFactor = 2,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}
) {
  let attempt = 0;
  let lastError;
  while (attempt <= maxRetries) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = baseDelayMs * Math.pow(backoffFactor, attempt);
        if (delay > 0) {
          await sleep(delay);
        }
      }
      attempt += 1;
    }
  }
  throw lastError;
}

export function adoptServiceExposure(config, serviceId, observedExposure) {
  return {
    ...config,
    managedInventory: {
      ...config.managedInventory,
      services: (config.managedInventory.services ?? []).map((service) => {
        if (service.id === serviceId) {
          return {
            ...service,
            exposure: {
              ...service.exposure,
              ...observedExposure
            }
          };
        }
        return service;
      })
    }
  };
}

export async function runAdoptionPass({ project, providerAdapters = {}, retryOptions = {} }) {
  const changes = [];
  const warnings = [];
  const platformServices = collectPlatformServices(project.config.managedInventory);

  for (const { platformKey, managedItem } of platformServices) {
    const providerRef = project.state.providerReferences[managedItem.id];
    if (providerRef === undefined) {
      continue;
    }
    const adapter = managedItem.service === "caddy-internal-ca"
      ? (providerAdapters["caddy-internal-ca"] ?? providerAdapters["caddy"])
      : providerAdapters[managedItem.service];

    if (adapter === undefined) {
      warnings.push({
        serviceName: managedItem.service,
        platformKey,
        message: `Provider adapter for ${managedItem.service} is unavailable for inspection.`
      });
      continue;
    }

    const providerReferences = platformKey === "dns"
      ? [project.config.baseLocalDomain, ...(project.config.managedInventory.services ?? []).map((s) => s.exposure?.hostname).filter(Boolean)]
      : platformKey === "reverseProxy" || platformKey === "certificateAuthority"
      ? (project.config.managedInventory.services ?? []).map((s) => s.exposure?.hostname).filter(Boolean)
      : [];

    try {
      const inspection = await withBoundedRetry(
        () => inspectPlatformService(adapter, managedItem, providerReferences),
        retryOptions
      );
      if (inspection === undefined) {
        continue;
      }

      const observedDeployment = inspection.deployment ?? (managedItem.deployment ? {
        ip: providerRef.ip ?? managedItem.deployment?.ip,
        hostname: managedItem.deployment?.hostname,
        bridge: managedItem.deployment?.bridge,
        storage: managedItem.deployment?.storage,
        resources: managedItem.deployment?.resources
      } : undefined);

      const observed = {
        deployment: observedDeployment
      };

      const health = await withBoundedRetry(
        () => getPlatformProvider(managedItem.service).healthCheck(adapter, managedItem),
        retryOptions
      );

      if (health.status === "unhealthy") {
        warnings.push({
          serviceName: managedItem.service,
          platformKey,
          message: `${managedItem.service} health check failed: process=${health.process}, endpoint=${health.endpoint}.`
        });
      }

      const change = detectPlatformChanges(observed, managedItem.deployment);
      if (change !== undefined) {
        const before = managedItem.deployment
          ? { ...managedItem.deployment }
          : undefined;
        const adoptedChange = createAdoptedChange(
          managedItem.service, platformKey, before, change.observed, change.kind
        );

        if (health.status === "healthy") {
          adoptedChange.verified = true;
        }

        changes.push(adoptedChange);
      }
    } catch (error) {
      warnings.push({
        serviceName: managedItem.service,
        platformKey,
        message: `Failed to inspect ${managedItem.service}: ${error.message}.`
      });
    }
  }

  // Inspect exposed services across reverse proxy (Caddy / Traefik)
  const proxyService = project.config.managedInventory.platform.reverseProxy;
  const proxyRef = proxyService ? project.state.providerReferences[proxyService.id] : undefined;
  const proxyAdapter = proxyService ? providerAdapters[proxyService.service] : undefined;

  for (const service of collectExposedServices(project.config.managedInventory)) {
    const hostname = service.exposure.hostname;
    if (proxyAdapter !== undefined && proxyRef !== undefined) {
      try {
        const proxyPlugin = getPlatformProvider(proxyService.service);
        const proxyInspection = await withBoundedRetry(
          () => proxyPlugin.inspect(proxyAdapter, proxyService, { providerReferences: [hostname] }),
          retryOptions
        );
        const matchedRoute = proxyInspection?.managed?.find((r) => r.id === hostname);
        if (matchedRoute !== undefined) {
          const observedBackendIp = matchedRoute.backendIp ?? matchedRoute.backend?.ip;
          const observedBackendPort = matchedRoute.backendPort ?? matchedRoute.backend?.port;
          const backendChanged = (observedBackendIp !== undefined && observedBackendIp !== service.exposure.backend?.ip) ||
            (observedBackendPort !== undefined && observedBackendPort !== service.exposure.backend?.port);

          if (backendChanged) {
            const newBackend = {
              ip: observedBackendIp ?? service.exposure.backend?.ip,
              port: observedBackendPort ?? service.exposure.backend?.port
            };
            const updatedExposure = {
              ...service.exposure,
              backend: newBackend
            };
            const health = proxyAdapter.healthCheckExposure
              ? await withBoundedRetry(
                  () => proxyAdapter.healthCheckExposure({ hostname, backendIp: newBackend.ip, backendPort: newBackend.port }),
                  retryOptions
                )
              : { status: "healthy" };

            const adoptedChange = {
              serviceId: service.id,
              serviceName: service.name ?? hostname,
              platformKey: "reverseProxy",
              kind: "exposure-changed",
              changes: { backend: newBackend },
              before: { ...service.exposure },
              after: updatedExposure,
              verified: health.status === "healthy",
              timestamp: new Date().toISOString()
            };

            if (health.status === "unhealthy") {
              warnings.push({
                serviceName: service.name ?? hostname,
                platformKey: "reverseProxy",
                message: `${service.name ?? hostname} exposure health check failed.`
              });
            }

            changes.push(adoptedChange);
          }
        }
      } catch (error) {
        warnings.push({
          serviceName: service.name ?? hostname,
          platformKey: "reverseProxy",
          message: `Failed to inspect exposure for ${service.name ?? hostname}: ${error.message}.`
        });
      }
    }
  }

  return { changes, warnings };
}
