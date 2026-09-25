import { isIP } from "node:net";

const API_BASE = "https://api.tailscale.com/api/v2";

export function createTailnetController({ httpClient, secretResolver, exec }) {
  return Object.freeze({
    async configure({ vmid, deviceId, dnsIp, proxyIp, adminSecretReference }) {
      if (!Number.isInteger(vmid) || !deviceId || !adminSecretReference) {
        throw new Error("Tailscale tailnet setup needs its managed LXC, device identity, and admin API token.");
      }
      if (isIP(dnsIp) !== 4 || isIP(proxyIp) !== 4) {
        throw new Error("Tailnet DNS and proxy routes require recorded IPv4 addresses.");
      }
      if (typeof exec !== "function" || typeof httpClient?.request !== "function") {
        throw new Error("Tailnet setup requires Proxmox execution and the Tailscale API client.");
      }
      const token = secretResolver?.resolve(adminSecretReference)?.trim();
      if (!token) throw new Error("A Tailscale admin API token is required to configure tailnet DNS and approve routes.");
      const routes = [...new Set([`${dnsIp}/32`, `${proxyIp}/32`])];
      const api = (method, path, body) => apiRequest(httpClient, token, method, path, body);
      const splitDns = await api("GET", "/tailnet/-/dns/split-dns");
      if (Object.values(splitDns).some((resolvers) =>
        !Array.isArray(resolvers) || resolvers.some((resolver) => resolver !== dnsIp))) {
        throw new Error("Tailnet split DNS uses another resolver. Remove or point those rules at Technitium before enabling the same filter for every domain.");
      }

      // A /32 route exposes every port on its target unless the gateway also
      // filters forwarding. Install the allowlist before advertising routes.
      await exec(vmid, { binary: "/usr/bin/apt-get", args: ["install", "--yes", "iptables"], timeoutMs: 180_000 });
      await exec(vmid, {
        binary: "/bin/bash",
        args: ["-c", firewallInstallScript(dnsIp, proxyIp)],
        timeoutMs: 30_000
      });
      // Prepare forwarding persistently, then advertise only the DNS and
      // reverse-proxy hosts. Backends are never routed directly into the tailnet.
      await exec(vmid, {
        binary: "/bin/bash",
        args: ["-c", "printf 'net.ipv4.ip_forward=1\\n' > /etc/sysctl.d/90-nomina-tailnet.conf && sysctl -w net.ipv4.ip_forward=1"],
        timeoutMs: 15_000
      });
      await exec(vmid, {
        binary: "/usr/bin/tailscale",
        args: ["set", "--snat-subnet-routes=true", `--advertise-routes=${routes.join(",")}`],
        timeoutMs: 30_000
      });

      const routePath = `/device/${encodeURIComponent(deviceId)}/routes`;
      const currentRoutes = await api("GET", routePath);
      for (const route of routes) {
        if (!currentRoutes.advertisedRoutes?.includes(route)) {
          throw new Error(`Tailscale did not advertise ${route}; tailnet DNS was left unchanged.`);
        }
      }
      const enabledRoutes = [...new Set([...(currentRoutes.enabledRoutes ?? []), ...routes])];
      if (routes.some((route) => !currentRoutes.enabledRoutes?.includes(route))) {
        await api("POST", routePath, { routes: enabledRoutes });
        const approved = await api("GET", routePath);
        if (routes.some((route) => !approved.enabledRoutes?.includes(route))) {
          throw new Error("Tailscale did not approve the DNS and proxy routes; tailnet DNS was left unchanged.");
        }
      }

      // A second global resolver could bypass Technitium's filtering. Replace
      // global nameservers only after its /32 route is enabled, preserving
      // MagicDNS and unrelated split-DNS settings.
      const nameserversPath = "/tailnet/-/dns/nameservers";
      const preferencesPath = "/tailnet/-/dns/preferences";
      const nameservers = await api("GET", nameserversPath);
      const preferences = await api("GET", preferencesPath);
      if (!Array.isArray(nameservers.dns) || typeof preferences !== "object") {
        throw new Error("Tailscale returned unexpected DNS settings; refusing to replace them.");
      }
      if (nameservers.dns.length !== 1 || nameservers.dns[0] !== dnsIp) {
        await api("POST", nameserversPath, { dns: [dnsIp] });
      }
      if (preferences.overrideLocalDNS !== true) {
        await api("POST", preferencesPath, { ...preferences, overrideLocalDNS: true });
      }
      const verifiedNameservers = await api("GET", nameserversPath);
      const verifiedPreferences = await api("GET", preferencesPath);
      if (verifiedNameservers.dns?.length !== 1 || verifiedNameservers.dns[0] !== dnsIp ||
          verifiedPreferences.overrideLocalDNS !== true) {
        throw new Error("Tailnet DNS did not retain Technitium as its sole global resolver.");
      }
      return { routes, nameserver: dnsIp };
    }
  });
}

export function firewallInstallScript(dnsIp, proxyIp) {
  if (isIP(dnsIp) !== 4 || isIP(proxyIp) !== 4) {
    throw new Error("Tailnet firewall requires IPv4 DNS and proxy addresses.");
  }
  const script = [
    "#!/bin/sh",
    "set -eu",
    "iptables -I FORWARD 1 -i tailscale0 -j REJECT",
    "iptables -N NOMINA_TAILNET 2>/dev/null || true",
    "iptables -F NOMINA_TAILNET",
    `iptables -A NOMINA_TAILNET -d ${dnsIp} -p udp --dport 53 -j ACCEPT`,
    `iptables -A NOMINA_TAILNET -d ${dnsIp} -p tcp --dport 53 -j ACCEPT`,
    `iptables -A NOMINA_TAILNET -d ${proxyIp} -p tcp --dport 80 -j ACCEPT`,
    `iptables -A NOMINA_TAILNET -d ${proxyIp} -p tcp --dport 443 -j ACCEPT`,
    "iptables -A NOMINA_TAILNET -j REJECT",
    "iptables -C FORWARD -i tailscale0 -j NOMINA_TAILNET 2>/dev/null || iptables -I FORWARD 1 -i tailscale0 -j NOMINA_TAILNET",
    "iptables -D FORWARD -i tailscale0 -j REJECT"
  ].join("\n");
  return [
    "set -eu",
    "install -m 0700 -d /usr/local/sbin",
    "cat > /usr/local/sbin/nomina-tailnet-firewall <<'NOMINA_FIREWALL'",
    script,
    "NOMINA_FIREWALL",
    "chmod 0700 /usr/local/sbin/nomina-tailnet-firewall",
    "cat > /etc/systemd/system/nomina-tailnet-firewall.service <<'NOMINA_UNIT'",
    "[Unit]",
    "Description=NominaConnect tailnet forwarding policy",
    "Before=tailscaled.service",
    "[Service]",
    "Type=oneshot",
    "ExecStart=/usr/local/sbin/nomina-tailnet-firewall",
    "RemainAfterExit=yes",
    "[Install]",
    "WantedBy=multi-user.target",
    "NOMINA_UNIT",
    "install -m 0755 -d /etc/systemd/system/tailscaled.service.d",
    "cat > /etc/systemd/system/tailscaled.service.d/nomina-firewall.conf <<'NOMINA_DROPIN'",
    "[Unit]",
    "Requires=nomina-tailnet-firewall.service",
    "After=nomina-tailnet-firewall.service",
    "NOMINA_DROPIN",
    "systemctl daemon-reload",
    "/usr/local/sbin/nomina-tailnet-firewall",
    "systemctl enable nomina-tailnet-firewall.service"
  ].join("\n");
}

async function apiRequest(httpClient, token, method, path, body) {
  const result = await httpClient.request({
    url: `${API_BASE}${path}`,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redactions: [token],
    timeoutMs: 30_000
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Tailscale admin API ${method} ${path} failed with HTTP ${result.status}. Check the token's dns and devices:routes permissions.`);
  }
  try {
    return result.body ? JSON.parse(result.body) : {};
  } catch {
    throw new Error(`Tailscale admin API ${method} ${path} returned malformed JSON.`);
  }
}
