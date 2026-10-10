import { randomUUID } from "node:crypto";
import { getPlatformProvider } from "./providers.js";
import { validateTcpEndpoint } from "./tcp-adapter.js";

export function tcpRequest(project, exposure) {
  const proxy = project.config.managedInventory.platform.reverseProxy;
  const proxyRef = project.state.providerReferences[proxy?.id];
  const vpn = project.config.managedInventory.platform.vpn;
  const vpnRef = vpn?.service === "tailscale" ? project.state.providerReferences[vpn.id] : undefined;
  return {
    hostname: exposure.hostname,
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

export async function publishTcpExposure({ project, options, providerAdapters }) {
  const dns = project.config.managedInventory.platform.dns;
  const proxy = project.config.managedInventory.platform.reverseProxy;
  const dnsRef = project.state.providerReferences[dns?.id];
  const existing = project.config.managedInventory.services.find((service) => service.exposure?.hostname === options.hostname);
  if (existing && (existing.exposure.protocol ?? "https") !== "tcp") {
    throw new Error("Remove the HTTPS exposure before changing its transport to TCP.");
  }
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
    protocol: "tcp",
    ...(preset !== undefined ? { preset } : {}),
    listenerPort: preset === "smb" ? 445 : options.listenerPort ?? Number(existing?.exposure.listenerPort ?? options.backendPort),
    backend: { ip: options.backendIp, port: options.backendPort },
    tailnet: options.tailnet ?? existing?.exposure.tailnet ?? true
  };
  const request = tcpRequest(project, exposure);
  exposure.tailnet = request.tailnet;
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
  if (!existing && before.managed.length) throw new Error(`DNS hostname ${options.hostname} already has unmanaged records.`);
  if (before.managed.some((record) => record.record && !record.record.includes(` A ${request.ip}`))) {
    throw new Error(`DNS records for ${options.hostname} conflict with the TCP listener address.`);
  }
  await adapter.publish(request);
  await dnsAdapter.publishRecord({ ...dnsContext, managedItemId: dns.id, hostname: options.hostname, ip: request.ip });
  const dnsInspection = await dnsPlugin.inspect(dnsAdapter, dns, dnsContext);
  const tcpInspection = await adapter.inspect(request);
  const dnsHealth = await dnsAdapter.healthCheckExposure({ ...dnsContext, hostname: options.hostname, expectedIp: request.ip });
  const tcpHealth = await adapter.healthCheckExposure(request);
  const managedService = { id: existing?.id ?? `nc_${randomUUID()}`, name: options.name, exposure };
  return {
    managedService, isUpdate: !!existing, warnings: [], dnsInspection, tcpInspection,
    health: { status: dnsHealth?.status === "healthy" && tcpHealth.status === "healthy" ? "healthy" : "unhealthy", dns: dnsHealth, tcp: tcpHealth },
    integrationReferences: { dns: options.hostname, tcp: { ip: request.ip, port: request.listenerPort } }
  };
}
