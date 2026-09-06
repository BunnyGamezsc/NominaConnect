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

export async function inspectPlatformService(adapter, managedItem, providerReferences) {
  if (adapter?.inspect === undefined) {
    return undefined;
  }
  const plugin = getPlatformProvider(managedItem.service);
  return await plugin.inspect(adapter, managedItem, { providerReferences });
}

export async function inspectExposedService(adapter, managedItem, providerReferences) {
  if (adapter?.inspect === undefined) {
    return undefined;
  }
  const plugin = getPlatformProvider(managedItem.service);
  return await plugin.inspect(adapter, managedItem, { providerReferences });
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

// Retries a health check until it reports healthy or attempts run out.
// Covers the window where a just-published exposure is still waiting on
// ACME issuance, so publish does not report a false "unhealthy".
export async function withHealthyRetry(
  operation,
  {
    maxAttempts = 3,
    baseDelayMs = 2000,
    backoffFactor = 1.5,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}
) {
  let attempt = 0;
  let result;
  let delayMs = baseDelayMs;
  while (attempt < maxAttempts) {
    result = await operation();
    if (result?.status === "healthy") {
      return result;
    }
    attempt += 1;
    if (attempt < maxAttempts) {
      await sleep(delayMs);
      delayMs = delayMs * backoffFactor;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Provider-native identity (ADR-0002, ADR-0005)
//
// A provider reference is a provider-native locator plus a last-known
// structural fingerprint. Background tracking resolves the stored locator
// first and only then falls back to a constrained semantic match, so a direct
// edit that makes a managed resource unrecognisable becomes a verification
// warning instead of a guess that claims someone else's configuration.
// ---------------------------------------------------------------------------

export function locatorsEqual(left, right) {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return JSON.stringify(sortedEntries(left)) === JSON.stringify(sortedEntries(right));
}

// A locator survives a provider-side rename. Technitium, Caddy, Traefik and
// step-ca address a resource by its whole locator — zone/name/type, a config
// path, a fragment and router — and a direct edit moves the fingerprint rather
// than the locator, so those match exactly. Tailscale and NetBird carry a
// provider-native `id` alongside the renameable hostname and DNS name, so a
// stable id is the one field allowed to carry a match on its own. Anything
// else is a different resource, not a renamed one.
export function locatorMatches(observed, stored) {
  if (observed === undefined || stored === undefined) {
    return false;
  }
  if (locatorsEqual(observed, stored)) {
    return true;
  }
  return stored.id !== undefined && stored.id !== "" && observed.id === stored.id;
}

/**
 * @param {any[]} resources
 * @param {{ locator?: any, id?: string }} reference
 */
export function resolveProviderResource(resources = [], reference = {}) {
  const { locator, id } = reference;
  const candidates = resources.filter((resource) => resource !== undefined && resource !== null);
  for (const [via, matches] of [
    ["locator", locator === undefined ? [] : candidates.filter((resource) => locatorMatches(resource.locator, locator))],
    ["self", candidates.filter((resource) => resource.self === true)],
    ["id", id === undefined ? [] : candidates.filter((resource) => resource.id === id)]
  ]) {
    if (matches.length === 1) {
      return { status: "resolved", resource: matches[0], via };
    }
    if (matches.length > 1) {
      return { status: "ambiguous", matches, via };
    }
  }
  return { status: "missing" };
}

export function providerIdentityOf(resource) {
  if (resource === undefined) {
    return undefined;
  }
  return {
    ...(resource.locator === undefined ? {} : { locator: resource.locator }),
    ...(resource.fingerprint === undefined ? {} : { fingerprint: resource.fingerprint })
  };
}

export function providerIdentityDrifted(observed, stored) {
  if (observed === undefined) {
    return false;
  }
  if (stored === undefined) {
    return observed.locator !== undefined || observed.fingerprint !== undefined;
  }
  return !locatorsEqual(observed.locator, stored.locator) || observed.fingerprint !== stored.fingerprint;
}

function sortedEntries(value) {
  return Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => [key, value[key]]);
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

// Adopts one provider-native identity into local state. It is the background
// counterpart of `nomina service recheck`: the adapter resolves its own
// resource, `plugin.adopt()` decides whether the match is safe, and only
// NominaConnect's provider reference is rewritten (ADR-0003, ADR-0004).
//
// Providers with nothing self-identifying to track — a Technitium server, a
// Caddy instance — are skipped silently. Their managed resources are the
// records and routes of individual exposures, which are adopted separately.
async function adoptProviderIdentity({
  plugin,
  adapter,
  managedItem,
  inspection,
  storedIdentity,
  context,
  retryOptions,
  health,
  describe,
  trackWithoutStoredIdentity = false
}) {
  const changes = [];
  const warnings = [];
  const resources = [...(inspection?.managed ?? []), ...(inspection?.unmanaged ?? [])];
  const trackable = trackWithoutStoredIdentity
    || storedIdentity?.locator !== undefined
    || resources.some((resource) => resource?.self === true);
  if (!trackable) {
    return { changes, warnings };
  }

  const resolution = resolveProviderResource(resources, {
    locator: storedIdentity?.locator,
    id: describe.resourceId
  });
  if (resolution.status === "ambiguous") {
    warnings.push({
      ...warningTarget(describe),
      message: `${describe.label ?? describe.serviceName} matched ${resolution.matches.length} provider resources by ${resolution.via}; its provider reference was not adopted.`
    });
    return { changes, warnings };
  }
  if (resolution.status === "missing") {
    warnings.push({
      ...warningTarget(describe),
      message: `${describe.label ?? describe.serviceName} no longer has a matching resource in ${managedItem.service}; its managed configuration was preserved and not adopted.`
    });
    return { changes, warnings };
  }

  const observedIdentity = providerIdentityOf(resolution.resource);
  if (!providerIdentityDrifted(observedIdentity, storedIdentity)) {
    return { changes, warnings };
  }

  // The resource the locator still resolves is one this provider now reports
  // as unmanaged: NominaConnect's own reference set no longer recognises it.
  // Adopting it would claim configuration that has drifted out of the managed
  // inventory, so the conflict is reported instead.
  if ((inspection?.unmanaged ?? []).includes(resolution.resource)) {
    warnings.push({
      ...warningTarget(describe),
      message: `${describe.label ?? describe.serviceName} now resolves to a resource ${managedItem.service} reports as unmanaged; it was preserved and not adopted.`
    });
    return { changes, warnings };
  }

  const adopted = await withBoundedRetry(
    () => plugin.adopt(adapter, managedItem, { managed: [resolution.resource] }, context),
    retryOptions
  );
  for (const message of adopted?.warnings ?? []) {
    warnings.push({ ...warningTarget(describe), message });
  }
  const updated = adopted?.managedInventoryUpdate?.[0];
  if (updated === undefined) {
    return { changes, warnings };
  }

  changes.push({
    ...warningTarget(describe),
    managedItemId: describe.managedItemId,
    ...(describe.integration === undefined ? {} : { integration: describe.integration }),
    kind: "provider-reference-changed",
    before: storedIdentity,
    after: providerIdentityOf(updated),
    verified: health?.status === "healthy",
    timestamp: new Date().toISOString()
  });
  return { changes, warnings };
}

function samePort(left, right) {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return Number(left) === Number(right);
}

function warningTarget({ serviceName, platformKey, serviceId }) {
  return {
    serviceName,
    ...(platformKey === undefined ? {} : { platformKey }),
    ...(serviceId === undefined ? {} : { serviceId })
  };
}

export async function runAdoptionPass({ project, providerAdapters = {}, retryOptions = {} }) {
  const changes = [];
  const warnings = [];
  const platformServices = collectPlatformServices(project.config.managedInventory);
  // The DNS pass already reads every managed record, so exposure adoption
  // reuses that observation instead of asking Technitium once per exposure.
  let dnsObservation;

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
      // A VPN's managed resource is the node NominaConnect enrolled. Its
      // provider-native locator is the only way to tell it apart from the
      // unmanaged peers the same client reports.
      : providerRef.locator?.id !== undefined
      ? [providerRef.locator.id]
      : [];

    const inspectionContext = {
      providerReferences,
      connectionSecretReference: project.config.connectionSecretReferences?.[managedItem.id],
      // Adapters that inspect a provider through its own LXC (Tailscale's CLI)
      // need the LXC id in tracking, not only in foreground commands.
      vmid: providerRef.vmid,
      ip: providerRef.ip ?? (managedItem.service === "caddy-internal-ca" ? project.state.providerReferences?.[project.config.managedInventory.platform.reverseProxy?.id]?.ip : undefined),
      zone: project.config.baseLocalDomain
    };

    try {
      const inspection = await withBoundedRetry(
        () => {
          const plugin = getPlatformProvider(managedItem.service);
          return plugin.inspect(adapter, managedItem, inspectionContext);
        },
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
        () => {
          const plugin = getPlatformProvider(managedItem.service);
          return plugin.healthCheck(adapter, managedItem, inspectionContext);
        },
        retryOptions
      );

      if (health.status === "unhealthy") {
        warnings.push({
          serviceName: managedItem.service,
          platformKey,
          message: `${managedItem.service} health check failed: process=${health.process}, endpoint=${health.endpoint}.`
        });
      }

      // Provider-precedence adoption for the managed platform item itself.
      // Only providers that can identify their own resource take part: a
      // Technitium server or a Caddy instance has no "self" record, so its
      // provider-native drift is tracked per exposure instead.
      if (platformKey === "dns") {
        dnsObservation = { inspection, context: inspectionContext, adapter, managedItem };
      }

      const identityAdoption = await adoptProviderIdentity({
        plugin: getPlatformProvider(managedItem.service),
        adapter,
        managedItem,
        inspection,
        storedIdentity: providerIdentityOf(providerRef),
        context: inspectionContext,
        retryOptions,
        health,
        describe: { serviceName: managedItem.service, platformKey, managedItemId: managedItem.id }
      });
      changes.push(...identityAdoption.changes);
      warnings.push(...identityAdoption.warnings);

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

      if (inspection.availableUpgrade !== undefined) {
        changes.push({
          serviceName: managedItem.service,
          platformKey,
          kind: "upgrade-available",
          before: managedItem.deployment?.version,
          after: inspection.availableUpgrade,
          verified: true,
          timestamp: new Date().toISOString()
        });
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
  const proxyLabel = proxyService?.service === "traefik" ? "Traefik" : "Caddy";

  for (const service of collectExposedServices(project.config.managedInventory)) {
    const hostname = service.exposure.hostname;
    // The DNS adoption runs before the proxy block on purpose: an ambiguous
    // proxy route must not suppress the DNS refusal warning for the same
    // exposure (the proxy block used to `continue` past it).
    if (dnsObservation !== undefined) {
      const dnsAdoption = await adoptProviderIdentity({
        plugin: getPlatformProvider(dnsObservation.managedItem.service),
        adapter: dnsObservation.adapter,
        managedItem: dnsObservation.managedItem,
        inspection: dnsObservation.inspection,
        storedIdentity: exposureIdentity(project.state, service.id, "dns"),
        context: dnsObservation.context,
        retryOptions,
        health: { status: "healthy" },
        trackWithoutStoredIdentity: true,
        describe: {
          serviceName: service.name ?? hostname,
          serviceId: service.id,
          platformKey: "dns",
          integration: "dns",
          resourceId: hostname,
          label: `The DNS record for ${hostname}`
        }
      });
      changes.push(...dnsAdoption.changes);
      warnings.push(...dnsAdoption.warnings);
    }
    if (proxyAdapter !== undefined && proxyRef !== undefined) {
      try {
        const proxyPlugin = getPlatformProvider(proxyService.service);
        const proxyInspectionContext = {
          providerReferences: [hostname],
          connectionSecretReference: project.config.connectionSecretReferences?.[proxyService.id],
          ip: proxyRef.ip,
          zone: project.config.baseLocalDomain
        };
        const proxyInspection = await withBoundedRetry(
          () => proxyPlugin.inspect(proxyAdapter, proxyService, proxyInspectionContext),
          retryOptions
        );
        const matchedRoutes = proxyInspection?.managed?.filter((r) => r.id === hostname) ?? [];
        if (matchedRoutes.length > 1) {
          warnings.push({
            serviceName: service.name ?? hostname,
            platformKey: "reverseProxy",
            message: `Ambiguous ${proxyLabel} route for ${hostname} (${matchedRoutes.length} matches); managed route was not adopted.`
          });
          continue;
        }
        const matchedRoute = matchedRoutes[0];
        if (matchedRoute === undefined) {
          warnings.push({
            serviceId: service.id,
            serviceName: service.name ?? hostname,
            platformKey: "reverseProxy",
            message: `${proxyLabel} no longer serves a route for ${hostname}; the managed exposure was preserved and not adopted.`
          });
        } else {
          const observedBackendIp = matchedRoute.backendIp ?? matchedRoute.backend?.ip;
          const observedBackendPort = matchedRoute.backendPort ?? matchedRoute.backend?.port;
          // A port read back from nomina.yaml is a string while a provider
          // reports a number. Comparing them as written would make every pass
          // report a backend change that never happened.
          const backendChanged = (observedBackendIp !== undefined && observedBackendIp !== service.exposure.backend?.ip) ||
            (observedBackendPort !== undefined && !samePort(observedBackendPort, service.exposure.backend?.port));
          const newBackend = {
            ip: observedBackendIp ?? service.exposure.backend?.ip,
            port: observedBackendPort ?? service.exposure.backend?.port
          };
          const storedProxyIdentity = exposureIdentity(project.state, service.id, "reverseProxy");
          const proxyIdentityDrifted = providerIdentityDrifted(providerIdentityOf(matchedRoute), storedProxyIdentity);

          // One health check answers both adoptions: an adopted route and an
          // adopted provider reference are only "verified" once the exposure
          // itself still serves (ADR-0029).
          let health = { status: "healthy" };
          if ((backendChanged || proxyIdentityDrifted) && proxyAdapter.healthCheckExposure !== undefined) {
            // vmid travels with the request so a proxy that verifies
            // certificates inside its LXC can still do so from tracking.
            health = await withBoundedRetry(
              () => proxyAdapter.healthCheckExposure({ hostname, backendIp: newBackend.ip, backendPort: newBackend.port, caStrategy: service.exposure.certificateAuthority, ip: proxyRef.ip, vmid: proxyRef.vmid }),
              retryOptions
            );
            if (health.status === "unhealthy") {
              warnings.push({
                serviceName: service.name ?? hostname,
                platformKey: "reverseProxy",
                message: `${service.name ?? hostname} exposure health check failed.`
              });
            }
          }

          if (backendChanged) {
            const updatedExposure = {
              ...service.exposure,
              backend: newBackend
            };

            changes.push({
              serviceId: service.id,
              serviceName: service.name ?? hostname,
              platformKey: "reverseProxy",
              kind: "exposure-changed",
              changes: { backend: newBackend },
              before: { ...service.exposure },
              after: updatedExposure,
              verified: health.status === "healthy",
              timestamp: new Date().toISOString()
            });
          }

          // A direct edit in the proxy — a rewritten route, a moved dynamic
          // fragment — moves the provider-native locator and fingerprint that
          // identify this exposure. Adopting them keeps the managed inventory
          // able to find the same route on the next pass.
          const proxyAdoption = await adoptProviderIdentity({
            plugin: proxyPlugin,
            adapter: proxyAdapter,
            managedItem: proxyService,
            inspection: proxyInspection,
            storedIdentity: storedProxyIdentity,
            context: proxyInspectionContext,
            retryOptions,
            health,
            trackWithoutStoredIdentity: true,
            describe: {
              serviceName: service.name ?? hostname,
              serviceId: service.id,
              platformKey: "reverseProxy",
              integration: "reverseProxy",
              resourceId: hostname,
              label: `The ${proxyLabel} route for ${hostname}`
            }
          });
          changes.push(...proxyAdoption.changes);
          warnings.push(...proxyAdoption.warnings);
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

// The provider-native identity NominaConnect last recorded for one integration
// of an exposed service. Projects published before provider references carried
// a locator have only the hostname, which the next pass fills in.
export function exposureIdentity(state, serviceId, integration) {
  return state?.providerReferences?.[serviceId]?.integrations?.[integration];
}

// Merges an adopted provider reference into local state. Platform items keep
// their flat `{ vmid, ip, locator, fingerprint }` shape; an exposed service
// records one identity per integration alongside the hostnames publish stored.
export function applyProviderReferenceChange(providerReferences, change) {
  if (change.serviceId !== undefined && change.integration !== undefined) {
    const existing = providerReferences[change.serviceId] ?? {};
    return {
      ...providerReferences,
      [change.serviceId]: {
        ...existing,
        integrations: {
          ...existing.integrations,
          [change.integration]: change.after
        }
      }
    };
  }
  if (change.managedItemId === undefined) {
    return providerReferences;
  }
  return {
    ...providerReferences,
    [change.managedItemId]: {
      ...providerReferences[change.managedItemId],
      ...change.after
    }
  };
}
