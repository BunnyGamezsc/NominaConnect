/** A hostname is shared DNS; inventory ID and transport/listener identify its services. */
export const isWebExposure = (exposure) => exposure !== undefined && (exposure.protocol ?? "https") === "https";
/** Identify TCP-based exposures that own a listener rather than an HTTP route. */
export const isStreamExposure = (exposure) => ["tcp", "ssh"].includes(exposure?.protocol);
/** Compare complete DNS names case-insensitively without treating missing values as equal. */
export const sameHostname = (left, right) => typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();

/** SOA/NS/TXT records can coexist with an A record; alternate address routes cannot. */
export function conflictingDnsRecords(records, ip) {
  return records.filter((record) => {
    const type = record.locator?.type ?? record.record?.split(/\s+/)[1];
    if (["SOA", "NS", "TXT", "MX", "SRV", "CAA"].includes(type)) return false;
    return type !== "A" || (record.rData?.ipAddress ?? record.record?.split(/\s+/)[2]) !== ip;
  });
}

/** Find a publication target by inventory identity or an unambiguous hostname/transport slot. */
export function findExposure(project, options) {
  const services = project.config.managedInventory.services.filter((service) => service.exposure);
  const explicit = services.find((service) => service.id === options.serviceId || service.name === options.name);
  if (explicit) {
    if (!sameHostname(explicit.exposure.hostname, options.hostname)) throw new Error("Remove the existing exposure before changing its hostname. Ordinary TCP cannot route by hostname.");
    return explicit;
  }
  const protocol = options.protocol === "smb" ? "tcp" : options.protocol;
  const matches = services.filter((service) => sameHostname(service.exposure.hostname, options.hostname)
    && (protocol === undefined || (service.exposure.protocol ?? "https") === protocol)
    && (options.listenerPort === undefined || Number(service.exposure.listenerPort ?? service.exposure.backend?.port) === Number(options.listenerPort)));
  if (options.name !== undefined && matches.every((service) => service.name !== options.name)) return undefined;
  if (matches.length > 1) throw new Error("Multiple exposures share this hostname. Select the exposure by its unique name or ID.");
  return matches[0];
}

/** Resolve a name/ID before trying a hostname, rejecting shared-hostname ambiguity. */
export function resolveExposure(services, selector) {
  const explicit = services.find((service) => service.id === selector) ?? services.find((service) => service.name === selector);
  if (explicit) return explicit;
  const matches = services.filter((service) => sameHostname(service.exposure?.hostname, selector));
  if (matches.length > 1) throw new Error("Multiple exposures share this hostname. Select the exposure by its unique name or ID.");
  return matches[0];
}

/** Reject duplicate names, web routes and TCP ports while allowing compatible hostname sharing. */
export function assertExposureSlot(project, options, existing) {
  const protocol = options.protocol ?? existing?.exposure.protocol ?? "https";
  if (existing && (existing.exposure.protocol ?? "https") !== protocol) {
    throw new Error(`Remove the ${existing.exposure.protocol === "tcp" ? "TCP" : existing.exposure.protocol === "ssh" ? "SSH" : "HTTPS"} exposure before changing its transport.`);
  }
  for (const service of project.config.managedInventory.services) {
    if (!service.exposure || service.id === existing?.id) continue;
    if (service.name === options.name) throw new Error("Exposure names must be unique.");
    if (protocol === "https" && isWebExposure(service.exposure) && sameHostname(service.exposure.hostname, options.hostname)) {
      throw new Error(`A web exposure already owns ${options.hostname}; choose its name to update it.`);
    }
    if (["tcp", "ssh"].includes(protocol) && isStreamExposure(service.exposure) &&
        Number(service.exposure.listenerPort ?? service.exposure.backend?.port) === Number(options.listenerPort)) {
      throw new Error(`TCP listener port ${options.listenerPort} conflicts with ${service.name}. Ordinary TCP cannot route by hostname.`);
    }
  }
}
