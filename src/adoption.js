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

export async function runAdoptionPass({ project, providerAdapters }) {
  const changes = [];
  const warnings = [];
  const platformServices = collectPlatformServices(project.config.managedInventory);

  for (const { platformKey, managedItem } of platformServices) {
    const providerRef = project.state.providerReferences[managedItem.id];
    if (providerRef === undefined) {
      continue;
    }
    const adapter = providerAdapters[managedItem.service];
    if (adapter === undefined) {
      warnings.push({
        serviceName: managedItem.service,
        platformKey,
        message: `Provider adapter for ${managedItem.service} is unavailable for inspection.`
      });
      continue;
    }

    const providerReferences = platformKey === "dns"
      ? [project.config.baseLocalDomain]
      : [];

    try {
      const inspection = inspectPlatformService(adapter, managedItem, providerReferences);
      if (inspection === undefined) {
        continue;
      }

      const observed = {
        deployment: {
          ip: providerRef.ip,
          hostname: managedItem.deployment?.hostname,
          resources: managedItem.deployment?.resources
        }
      };

      const health = getPlatformProvider(managedItem.service).healthCheck(adapter, managedItem);

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

  return { changes, warnings };
}
