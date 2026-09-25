import { isIP } from "node:net";

const API_BASE = "https://api.tailscale.com/api/v2";

export function createTailnetController({ httpClient, secretResolver, exec }) {
  return Object.freeze({
    async configure({ vmid, dnsIp, proxyIp, zone, adminSecretReference }) {
      if (!Number.isInteger(vmid) || !adminSecretReference || !validZone(zone)) {
        throw new Error("Tailscale tailnet setup needs its managed LXC, local domain, and admin API token.");
      }
      if (isIP(dnsIp) !== 4 || isIP(proxyIp) !== 4) {
        throw new Error("Tailnet DNS and proxy forwarding require recorded IPv4 addresses.");
      }
      if (typeof exec !== "function" || typeof httpClient?.request !== "function") {
        throw new Error("Tailnet setup requires Proxmox execution and the Tailscale API client.");
      }
      const token = secretResolver?.resolve(adminSecretReference)?.trim();
      if (!token) throw new Error("A Tailscale admin API token is required to configure tailnet DNS.");
      const api = (method, path, body) => apiRequest(httpClient, token, method, path, body);
      const addressResult = await exec(vmid, {
        binary: "/usr/bin/tailscale", args: ["ip", "-4"], timeoutMs: 30_000
      });
      const gatewayIp = String(addressResult?.stdout ?? "").trim();
      const octets = gatewayIp.split(".").map(Number);
      if (isIP(gatewayIp) !== 4 || octets[0] !== 100 || octets[1] < 64 || octets[1] > 127) {
        throw new Error("Tailscale did not report a usable IPv4 gateway address.");
      }
      const splitDns = await api("GET", "/tailnet/-/dns/split-dns");
      if (Object.values(splitDns).some((resolvers) =>
        !Array.isArray(resolvers) || resolvers.some((resolver) => resolver !== gatewayIp))) {
        throw new Error("Tailnet split DNS uses another resolver. Remove or point those rules at this gateway before enabling the same Technitium filter for every domain.");
      }

      await exec(vmid, {
        binary: "/usr/bin/apt-get", args: ["install", "--yes", "iptables", "python3"],
        timeoutMs: 180_000
      });
      // The DNS service asks Technitium before translating successful managed
      // proxy answers. A blocked response is returned untouched.
      await exec(vmid, {
        binary: "/bin/bash",
        args: ["-c", dnsInstallScript({ dnsIp, proxyIp, gatewayIp, zone })],
        timeoutMs: 30_000
      });
      await exec(vmid, {
        binary: "/bin/bash",
        args: ["-c", firewallInstallScript(dnsIp, proxyIp, gatewayIp)],
        timeoutMs: 30_000
      });
      // Clear routes left by an earlier version. There is no LAN subnet route
      // for clients to accept; they connect only to this node's Tailscale IP.
      await exec(vmid, {
        binary: "/usr/bin/tailscale",
        args: ["set", "--advertise-routes="],
        timeoutMs: 30_000
      });

      const nameserversPath = "/tailnet/-/dns/nameservers";
      const preferencesPath = "/tailnet/-/dns/preferences";
      const nameservers = await api("GET", nameserversPath);
      const preferences = await api("GET", preferencesPath);
      if (!Array.isArray(nameservers.dns) || typeof preferences !== "object" || preferences === null) {
        throw new Error("Tailscale returned unexpected DNS settings; refusing to replace them.");
      }
      if (nameservers.dns.length !== 1 || nameservers.dns[0] !== gatewayIp) {
        await api("POST", nameserversPath, { dns: [gatewayIp] });
      }
      if (preferences.overrideLocalDNS !== true) {
        await api("POST", preferencesPath, { ...preferences, overrideLocalDNS: true });
      }
      const verifiedNameservers = await api("GET", nameserversPath);
      const verifiedPreferences = await api("GET", preferencesPath);
      if (verifiedNameservers.dns?.length !== 1 || verifiedNameservers.dns[0] !== gatewayIp ||
          verifiedPreferences.overrideLocalDNS !== true) {
        throw new Error("Tailnet DNS did not retain the gateway as its sole global resolver.");
      }
      return { nameserver: gatewayIp };
    }
  });
}

function validZone(zone) {
  return typeof zone === "string" && /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i.test(zone);
}

export function firewallInstallScript(dnsIp, proxyIp, gatewayIp) {
  if ([dnsIp, proxyIp, gatewayIp].some((ip) => isIP(ip) !== 4)) {
    throw new Error("Tailnet firewall requires IPv4 DNS, proxy, and gateway addresses.");
  }
  const script = [
    "#!/bin/sh",
    "set -eu",
    "iptables -N NOMINA_TAILNET_INPUT 2>/dev/null || true",
    "iptables -F NOMINA_TAILNET_INPUT",
    `iptables -A NOMINA_TAILNET_INPUT -d ${gatewayIp} -p udp --dport 53 -j ACCEPT`,
    `iptables -A NOMINA_TAILNET_INPUT -d ${gatewayIp} -p tcp --dport 53 -j ACCEPT`,
    "iptables -A NOMINA_TAILNET_INPUT -j REJECT",
    "iptables -C INPUT -i tailscale0 -j NOMINA_TAILNET_INPUT 2>/dev/null || iptables -I INPUT 1 -i tailscale0 -j NOMINA_TAILNET_INPUT",
    "iptables -N NOMINA_TAILNET_FORWARD 2>/dev/null || true",
    "iptables -F NOMINA_TAILNET_FORWARD",
    `iptables -A NOMINA_TAILNET_FORWARD -d ${proxyIp} -p tcp -m multiport --dports 80,443 -j ACCEPT`,
    "iptables -A NOMINA_TAILNET_FORWARD -j REJECT",
    "iptables -C FORWARD -i tailscale0 -j NOMINA_TAILNET_FORWARD 2>/dev/null || iptables -I FORWARD 1 -i tailscale0 -j NOMINA_TAILNET_FORWARD",
    `iptables -t nat -C PREROUTING -i tailscale0 -d ${gatewayIp} -p tcp -m multiport --dports 80,443 -j DNAT --to-destination ${proxyIp} 2>/dev/null || iptables -t nat -A PREROUTING -i tailscale0 -d ${gatewayIp} -p tcp -m multiport --dports 80,443 -j DNAT --to-destination ${proxyIp}`,
    `iptables -t nat -C POSTROUTING -d ${proxyIp} -p tcp -m multiport --dports 80,443 -j MASQUERADE 2>/dev/null || iptables -t nat -A POSTROUTING -d ${proxyIp} -p tcp -m multiport --dports 80,443 -j MASQUERADE`
  ];
  return [
    "set -eu",
    "install -m 0700 -d /usr/local/sbin",
    "cat > /usr/local/sbin/nomina-tailnet-firewall <<'NOMINA_FIREWALL'",
    script.join("\n"),
    "NOMINA_FIREWALL",
    "chmod 0700 /usr/local/sbin/nomina-tailnet-firewall",
    "cat > /etc/systemd/system/nomina-tailnet-firewall.service <<'NOMINA_UNIT'",
    "[Unit]",
    "Description=NominaConnect tailnet gateway firewall",
    "Before=tailscaled.service",
    "[Service]",
    "Type=oneshot",
    "ExecStart=/usr/local/sbin/nomina-tailnet-firewall",
    "RemainAfterExit=yes",
    "[Install]",
    "WantedBy=multi-user.target",
    "NOMINA_UNIT",
    "systemctl daemon-reload",
    "printf 'net.ipv4.ip_forward=1\\n' > /etc/sysctl.d/90-nomina-tailnet.conf",
    "sysctl -w net.ipv4.ip_forward=1",
    "/usr/local/sbin/nomina-tailnet-firewall",
    "systemctl enable nomina-tailnet-firewall.service"
  ].join("\n");
}

export function dnsInstallScript({ dnsIp, proxyIp, gatewayIp, zone }) {
  if ([dnsIp, proxyIp, gatewayIp].some((ip) => isIP(ip) !== 4) || !validZone(zone)) {
    throw new Error("Tailnet DNS relay requires IPv4 addresses and a valid domain.");
  }
  return [
    "set -eu",
    "install -m 0755 -d /usr/local/lib/nomina",
    "cat > /usr/local/lib/nomina/tailnet-dns.py <<'NOMINA_DNS'",
    DNS_RELAY,
    "NOMINA_DNS",
    "chmod 0644 /usr/local/lib/nomina/tailnet-dns.py",
    "cat > /etc/systemd/system/nomina-tailnet-dns.service <<'NOMINA_UNIT'",
    "[Unit]",
    "Description=NominaConnect Technitium tailnet DNS relay",
    "After=tailscaled.service",
    "Requires=tailscaled.service",
    "[Service]",
    `ExecStart=/usr/bin/python3 /usr/local/lib/nomina/tailnet-dns.py ${gatewayIp} ${dnsIp} ${proxyIp} ${zone}`,
    "Restart=on-failure",
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "[Install]",
    "WantedBy=multi-user.target",
    "NOMINA_UNIT",
    "systemctl daemon-reload",
    "systemctl enable --now nomina-tailnet-dns.service",
    "systemctl restart nomina-tailnet-dns.service",
    "systemctl is-active --quiet nomina-tailnet-dns.service"
  ].join("\n");
}

// Kept in the compiled CLI so installation does not depend on source files.
// Wire data is forwarded unchanged except eligible A answers.
export const DNS_RELAY = String.raw`import ipaddress
import socket
import socketserver
import struct
import sys

bind_ip, upstream_ip, proxy_ip, zone = sys.argv[1:]
replacement = ipaddress.IPv4Address(bind_ip).packed
proxy = ipaddress.IPv4Address(proxy_ip).packed
zone = zone.lower().rstrip(".")

def name_end(data, pos):
    while True:
        if pos >= len(data):
            raise ValueError("short DNS name")
        size = data[pos]
        if size & 0xc0 == 0xc0:
            if pos + 1 >= len(data):
                raise ValueError("short DNS pointer")
            return pos + 2
        if size & 0xc0:
            raise ValueError("invalid DNS label")
        pos += 1
        if size == 0:
            return pos
        pos += size

def question_name(data):
    pos = 12
    labels = []
    while True:
        if pos >= len(data):
            raise ValueError("short DNS question")
        size = data[pos]
        pos += 1
        if size == 0:
            return b".".join(labels).decode("ascii").lower()
        if size > 63 or pos + size > len(data):
            raise ValueError("invalid DNS question")
        labels.append(data[pos:pos + size])
        pos += size

def rewrite(query, response):
    if len(query) < 12 or len(response) < 12 or response[:2] != query[:2]:
        return response
    if response[3] & 0x0f or response[2] & 0x02:
        return response
    name = question_name(query)
    if name != zone and not name.endswith("." + zone):
        return response
    pos = 12
    for _ in range(struct.unpack_from("!H", response, 4)[0]):
        pos = name_end(response, pos) + 4
        if pos > len(response):
            return response
    result = bytearray(response)
    for _ in range(struct.unpack_from("!H", response, 6)[0]):
        pos = name_end(response, pos)
        if pos + 10 > len(response):
            return response
        kind, cls, _, length = struct.unpack_from("!HHIH", response, pos)
        pos += 10
        if pos + length > len(response):
            return response
        if kind == 1 and cls == 1 and length == 4 and response[pos:pos + 4] == proxy:
            result[pos:pos + 4] = replacement
        pos += length
    return bytes(result)

def upstream(query, tcp):
    if tcp:
        with socket.create_connection((upstream_ip, 53), timeout=5) as peer:
            peer.sendall(struct.pack("!H", len(query)) + query)
            size = peer.recv(2)
            if len(size) != 2:
                raise ValueError("short TCP DNS length")
            remaining = struct.unpack("!H", size)[0]
            chunks = []
            while remaining:
                part = peer.recv(remaining)
                if not part:
                    raise ValueError("short TCP DNS answer")
                chunks.append(part)
                remaining -= len(part)
            return b"".join(chunks)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as peer:
        peer.settimeout(5)
        peer.sendto(query, (upstream_ip, 53))
        return peer.recv(65535)

class UDP(socketserver.ThreadingUDPServer):
    allow_reuse_address = True

class UDPHandler(socketserver.BaseRequestHandler):
    def handle(self):
        query, peer = self.request
        try:
            peer.sendto(rewrite(query, upstream(query, False)), self.client_address)
        except (OSError, ValueError, UnicodeError):
            pass

class TCP(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

class TCPHandler(socketserver.BaseRequestHandler):
    def handle(self):
        try:
            header = self.request.recv(2)
            if len(header) != 2:
                return
            remaining = struct.unpack("!H", header)[0]
            chunks = []
            while remaining:
                part = self.request.recv(remaining)
                if not part:
                    return
                chunks.append(part)
                remaining -= len(part)
            answer = rewrite(b"".join(chunks), upstream(b"".join(chunks), True))
            self.request.sendall(struct.pack("!H", len(answer)) + answer)
        except (OSError, ValueError, UnicodeError):
            pass

import threading
udp = UDP((bind_ip, 53), UDPHandler)
tcp = TCP((bind_ip, 53), TCPHandler)
threading.Thread(target=udp.serve_forever, daemon=True).start()
tcp.serve_forever()`;

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
    throw new Error(`Tailscale admin API ${method} ${path} failed with HTTP ${result.status}. Check the token's dns permission.`);
  }
  try {
    return result.body ? JSON.parse(result.body) : {};
  } catch {
    throw new Error(`Tailscale admin API ${method} ${path} returned malformed JSON.`);
  }
}
