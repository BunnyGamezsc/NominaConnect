import tls from "node:tls";
import net from "node:net";
import { Resolver } from "node:dns/promises";
import { randomInt } from "node:crypto";
import packet from "dns-packet";

// Bind transport to each reviewed IP, while authenticating the DNS hostname.
export function queryTls(ip, hostname, zone, ca, port = 853, fingerprint = undefined) {
  const id = randomInt(65536);
  const wire = packet.streamEncode({
    type: "query",
    id,
    flags: packet.RECURSION_DESIRED,
    questions: [{ type: "SOA", name: zone }],
  });
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: ip,
      port,
      servername: hostname,
      ca: [...tls.rootCertificates, ca],
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    const timer = setTimeout(
      () => socket.destroy(new Error("DNS-over-TLS deadline exceeded")),
      5000,
    );
    socket.once("close", () => {
      clearTimeout(timer);
      reject(new Error("Incomplete DNS-over-TLS response"));
    });
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      if (fingerprint && socket.getPeerCertificate().fingerprint256 !== fingerprint) {
        socket.destroy(new Error("The resolver did not present the new TLS certificate."));
        return;
      }
      socket.write(wire);
    });
    let bytes = Buffer.alloc(0);
    socket.on("data", (part) => {
      bytes = Buffer.concat([bytes, Buffer.from(part)]);
      if (bytes.length < 2 || bytes.length < 2 + bytes.readUInt16BE()) return;
      try {
        const answer = packet.streamDecode(bytes);
        if (
          answer.id !== id ||
          answer.type !== "response" ||
          answer.rcode !== "NOERROR" ||
          answer.flag_tc ||
          answer.questions.length !== 1 ||
          answer.questions[0].type !== "SOA" ||
          answer.questions[0].name.toLowerCase() !== zone ||
          !answer.answers.some(
            (a) => a.name.toLowerCase() === zone && a.type === "SOA",
          )
        )
          throw new Error(
            "Resolver did not return the requested SOA for " + zone,
          );
        resolve(true);
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
  });
}

export async function verifyResolver(pkg, zone, cert) {
  const zones = [
    ...new Set([
      zone,
      ...(pkg.mode === "private-domain" ? [pkg.suffix] : ["example.com"]),
    ]),
  ];
  for (const ip of pkg.addresses) {
    for (const probe of zones) {
      try {
        if (pkg.appleDns === "encrypted")
          await queryTls(ip, pkg.resolver, probe, cert.toString());
        if (pkg.targets.includes("windows")) await queryPlainDns(ip, probe);
      } catch (error) {
        throw new Error(
          "Resolver check failed at " +
            ip +
            " for " +
            probe +
            ": " +
            error.message,
        );
      }
    }
  }
}

export async function queryPlainDns(ip, zone) {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  resolver.setServers([ip]);
  await resolver.resolveSoa(zone);
}

const wildcard = { "0.0.0.0": 4, "::": 6 };

function listenerAddress(endpoint) {
  const ip = endpoint.match(/^\[([^\]]+)\]:53$/)?.[1] ?? endpoint.match(/^([\d.]+):53$/)?.[1];
  if (!ip || !net.isIP(ip)) throw new Error(`The existing listener ${endpoint} requires a separate review.`);
  const [address, scope] = ip.split("%");
  return address.toLowerCase() + (scope ? `%${scope}` : "");
}

function isPrivateListener(ip) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|f[cd][0-9a-f]{2}:)/i.test(ip) ||
    ip === "::1" || /^fe[89ab][0-9a-f]:.+%[a-z\d_.-]+$/i.test(ip);
}

function wildcardAddresses(ips, interfaces) {
  if (!Array.isArray(interfaces) || !interfaces.length)
    throw new Error("Could not identify the Technitium LXC's current DNS listening addresses safely.");
  const expanded = ips.flatMap(ip => {
    const family = wildcard[ip];
    if (!family) return [ip];
    return interfaces.flatMap(({ ifname, addr_info = [] }) => addr_info
      .filter(info => net.isIP(info.local) === family)
      .map(info => {
        const local = info.local.toLowerCase();
        if (family === 6 && /^fe[89ab][0-9a-f]:/.test(local)) {
          if (!/^[a-z\d_.-]+$/i.test(ifname)) throw new Error("Cannot keep a scoped IPv6 listener with an unknown interface name.");
          return `${local}%${ifname}`;
        }
        return local;
      }));
  });
  const unsafe = expanded.find(ip => !isPrivateListener(ip));
  if (unsafe) throw new Error(`DNS-over-TLS would also listen on ${unsafe}. Nomina kept the existing DNS listeners and needs a private-only resolver to continue.`);
  return [...new Set(expanded)].sort();
}

export function listenerPlan(settings, addresses, interfaces = undefined) {
  if (
    !/^15\.(?:4|6)(?:\.|$)/.test(settings.version) ||
    settings.clusterInitialized !== false
  )
    throw new Error(
      "Resolver setup requires standalone Technitium 15.4.x or 15.6.x.",
    );
  if (!settings.dnsTlsCertificatePath)
    throw new Error(
      "Use nomina ca dns-certificate with managed step-ca, or configure a PKCS#12 certificate in Technitium Settings > Optional Protocols, then review again.",
    );
  if (
    settings.dnsOverTlsPort !== 853 ||
    settings.recursion !== "AllowOnlyForPrivateNetworks"
  )
    throw new Error(
      "Require TCP 853 and private-network-only recursion. Review the existing settings in Technitium.",
    );
  const before = settings.dnsServerLocalEndPoints;
  const ips = before.map(listenerAddress);
  const hasWildcard = ips.some(ip => wildcard[ip]);
  if (hasWildcard && settings.enableDnsOverTls)
    throw new Error("The existing DNS-over-TLS listener uses wildcard addresses. Review the active listener before changing it.");
  const listeners = hasWildcard ? wildcardAddresses(ips, interfaces) : ips.slice().sort();
  if (
    !listeners.every(isPrivateListener) ||
    !addresses.every(ip => listeners.includes(ip.toLowerCase()))
  )
    throw new Error(
      "The selected resolver addresses must be present on private Technitium listeners. Check the DNS addresses in the package.",
    );
  return {
    enabled: settings.enableDnsOverTls,
    version: settings.version,
    listeners,
    certificate: settings.dnsTlsCertificatePath,
    ...(hasWildcard ? { bindings: {
      from: before, to: listeners.map(ip => net.isIP(ip) === 6 ? `[${ip}]:53` : `${ip}:53`),
    } } : {}),
  };
}
