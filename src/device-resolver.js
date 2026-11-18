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

export function listenerPlan(settings, addresses) {
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
  const ips = settings.dnsServerLocalEndPoints.map((endpoint) =>
    endpoint
      .replace(/^\[([^\]]+)\]:53$/, "$1")
      .replace(/^(\d+\.\d+\.\d+\.\d+):53$/, "$1"),
  );
  if (
    !ips.every(
      (ip) =>
        net.isIP(ip) &&
        (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|f[cd][0-9a-f]{2}:)/i.test(
          ip,
        ) ||
          ip === "::1"),
    ) ||
    !addresses.every((ip) => ips.includes(ip))
  )
    throw new Error(
      "Explicitly bind Technitium to the selected private LAN addresses first. Wildcard or public binds are ineligible for automated setup.",
    );
  return {
    enabled: settings.enableDnsOverTls,
    version: settings.version,
    listeners: ips,
    certificate: settings.dnsTlsCertificatePath,
  };
}
