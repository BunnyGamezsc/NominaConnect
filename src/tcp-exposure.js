import { findExposure, assertExposureSlot, sameHostname, conflictingDnsRecords } from "./exposure-identity.js";
import { randomUUID } from "node:crypto";
import { getPlatformProvider } from "./providers.js";
import { validateTcpEndpoint } from "./tcp-adapter.js";

/** Resolve recorded proxy/VPN endpoints while preserving a stream exposure's transport purpose. */
export function tcpRequest(project, exposure) {
  const proxy = project.config.managedInventory.platform.reverseProxy;
  const proxyRef = project.state.providerReferences[proxy?.id];
  const vpn = project.config.managedInventory.platform.vpn;
  const vpnRef = vpn?.service === "tailscale" ? project.state.providerReferences[vpn.id] : undefined;
  return {
    hostname: exposure.hostname,
    ...(exposure.protocol === "ssh" ? { purpose: "host-ssh" } : {}),
    ip: proxyRef?.ip,
    vmid: proxyRef?.vmid,
    backendIp: exposure.backend?.ip,
    backendPort: Number(exposure.backend?.port),
    listenerPort: Number(exposure.listenerPort ?? exposure.backend?.port),
    tailnet: vpn?.service === "tailscale" && (exposure.tailnet ?? true),
    gatewayVmid: vpnRef?.vmid,
    gatewayLanIp: vpnRef?.ip
  };
}

/** Build and check a TCP exposure without mutations, including its listener, gateway and DNS conflicts. */
export async function preflightTcpExposure({ project, options, providerAdapters }) {
  const dns = project.config.managedInventory.platform.dns;
  const proxy = project.config.managedInventory.platform.reverseProxy;
  const dnsRef = project.state.providerReferences[dns?.id];
  const existing = findExposure(project, options);
  if (dns?.service !== "technitium" || !dnsRef || !["caddy", "traefik"].includes(proxy?.service)) {
    throw new Error("Provision Technitium and Caddy or Traefik before publishing TCP.");
  }
  const adapter = providerAdapters.tcp;
  if (!adapter?.preflight || !adapter?.publish) throw new Error("TCP forwarding adapter is unavailable.");
  const preset = options.preset ?? existing?.exposure.preset;
  if (preset !== undefined && preset !== "smb") throw new Error("Unsupported TCP preset.");
  if (preset === "smb" && options.listenerPort !== undefined && Number(options.listenerPort) !== 445) {
    throw new Error("SMB requires client-facing TCP listener port 445. The backend port can differ.");
  }
  const exposure = {
    hostname: options.hostname,
    protocol: options.protocol === "ssh" ? "ssh" : "tcp",
    ...(options.protocol === "ssh" ? { ssh: { user: options.sshUser ?? existing?.exposure.ssh?.user ?? "root" } } : {}),
    ...(preset !== undefined ? { preset } : {}),
    listenerPort: preset === "smb" ? 445 : options.listenerPort ?? Number(existing?.exposure.listenerPort ?? options.backendPort),
    backend: { ip: options.backendIp, port: options.backendPort },
    tailnet: options.tailnet ?? existing?.exposure.tailnet ?? true
  };
  const request = tcpRequest(project, exposure);
  // Keep the access preference even before the optional VPN is provisioned.
  assertExposureSlot(project, { ...options, listenerPort: request.listenerPort }, existing);
  validateTcpEndpoint(request);

  for (const service of project.config.managedInventory.services) {
    if (service.id !== existing?.id && service.exposure?.protocol === "tcp" &&
        Number(service.exposure.listenerPort ?? service.exposure.backend?.port) === request.listenerPort) {
      throw new Error(`TCP listener ${request.ip}:${request.listenerPort} conflicts with ${service.exposure.hostname}. Ordinary TCP cannot route by hostname.`);
    }
  }
  if (existing && Number(existing.exposure.listenerPort ?? existing.exposure.backend.port) !== request.listenerPort) {
    throw new Error("Remove the existing TCP exposure before changing its listener port.");
  }
  // All listener checks precede DNS and forwarding writes.
  await adapter.preflight(request);
  const dnsAdapter = providerAdapters.technitium;
  const dnsContext = {
    providerReferences: [options.hostname], zone: project.config.baseLocalDomain,
    ip: dnsRef.ip, endpoint: `http://${dnsRef.ip}:5380`,
    connectionSecretReference: project.config.connectionSecretReferences[dns.id]
  };
  const dnsPlugin = getPlatformProvider("technitium");
  const before = await dnsPlugin.inspect(dnsAdapter, dns, dnsContext);
  const sharedDns = project.config.managedInventory.services.some((service) => sameHostname(service.exposure?.hostname, options.hostname));
  if (!existing && !sharedDns && before.managed.length) throw new Error(`DNS hostname ${options.hostname} already has unmanaged records.`);
  if (conflictingDnsRecords(before.managed, request.ip).length) {
    throw new Error(`DNS records for ${options.hostname} conflict with the TCP listener address.`);
  }
  return { exposure, request, existing, dnsContext };
}

/** Publish a checked TCP exposure through the existing forwarding/DNS lifecycle and report transport health. */
export async function publishTcpExposure({ project, options, providerAdapters }) {
  const { exposure, request, existing, dnsContext } = await preflightTcpExposure({ project, options, providerAdapters });
  const dns = project.config.managedInventory.platform.dns;
  const adapter = providerAdapters.tcp;
  const dnsAdapter = providerAdapters.technitium;
  const dnsPlugin = getPlatformProvider("technitium");
  const forwarding = await adapter.publish(request);
  await dnsAdapter.publishRecord({ ...dnsContext, managedItemId: dns.id, hostname: options.hostname, ip: request.ip });
  const dnsInspection = await dnsPlugin.inspect(dnsAdapter, dns, dnsContext);
  const tcpInspection = await adapter.inspect(request);
  const dnsHealth = await dnsAdapter.healthCheckExposure({ ...dnsContext, hostname: options.hostname, expectedIp: request.ip });
  const tcpHealth = await adapter.healthCheckExposure(request);
  const managedService = { id: existing?.id ?? `nc_${randomUUID()}`, name: options.name, exposure };
  return {
    managedService, isUpdate: !!existing, warnings: forwarding?.warnings ?? [], dnsInspection, tcpInspection,
    health: { status: dnsHealth?.status === "healthy" && tcpHealth.status === "healthy" ? "healthy" : "unhealthy", dns: dnsHealth, tcp: tcpHealth },
    integrationReferences: { dns: options.hostname, tcp: { ip: request.ip, port: request.listenerPort } }
  };
}
