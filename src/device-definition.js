import { isIP } from "node:net";
import { X509Certificate } from "node:crypto";

function string(value, label, limit = 255) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    Buffer.byteLength(value) > limit ||
    /[\p{Cc}\p{Cs}\uFFFE\uFFFF]/u.test(value)
  )
    throw new Error("Invalid " + label);
  return value;
}

export function domain(value) {
  const name = string(value, "DNS hostname", 254)
    .toLowerCase()
    .replace(/\.$/, "");
  if (
    isIP(name) ||
    !name.includes(".") ||
    name.length > 253 ||
    !name
      .split(".")
      .every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new Error("Use a fully qualified DNS hostname.");
  }
  return name;
}

function list(items, label, validate) {
  if (!Array.isArray(items) || !items.length)
    throw new Error("Select at least one " + label);
  return [...new Set(items.map(validate))];
}

function validateHomeCheck(check) {
  if (check === undefined) return {};
  if (
    check === null ||
    typeof check !== "object" ||
    Array.isArray(check) ||
    Object.keys(check).some((key) => !["dnsServers", "probeUrl"].includes(key))
  )
    throw new Error("Home Wi-Fi checks accept dnsServers and probeUrl.");

  const homeCheck = {};
  if (check.dnsServers !== undefined) {
    homeCheck.dnsServers = list(
      check.dnsServers,
      "expected DNS server",
      (ip) => {
        if (!isIP(ip) || ip.includes("%"))
          throw new Error(
            "Use an exact IPv4 or IPv6 address for each expected DNS server.",
          );
        return isIP(ip) === 6
          ? new URL("http://[" + ip + "]").hostname.slice(1, -1)
          : ip;
      },
    );
  }
  if (check.probeUrl !== undefined) {
    const value = string(check.probeUrl, "home HTTPS check URL", 2048);
    const url = new URL(value);
    if (
      !/^https:\/\//i.test(value) ||
      value.includes("\\") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        "Use an HTTPS check URL without credentials, query parameters, or a fragment.",
      );
    homeCheck.probeUrl = url.href;
  }
  return Object.keys(homeCheck).length ? { homeCheck } : {};
}

export function validateHomeSsid(value) {
  return string(value, "SSID", 32);
}

function validateDnsPolicy(input) {
  const mode = input.mode;
  if (!["private-domain", "whole-system"].includes(mode))
    throw new Error("Select private-domain or whole-system DNS.");
  const addresses = list(input.addresses, "bootstrap IP address", (ip) => {
    if (!isIP(ip) || ip.includes("%"))
      throw new Error("Invalid resolver IP address.");
    if (isIP(ip) === 6) {
      const address = new URL("http://[" + ip + "]").hostname.slice(1, -1);
      if (/^(::($|1$|ffff:)|ff|fe[89ab])/.test(address))
        throw new Error("Use a routable resolver address on the LAN.");
      return address;
    }
    const first = Number(ip.split(".")[0]);
    if (!first || first === 127 || first >= 224 || ip.startsWith("169.254."))
      throw new Error("Use a routable resolver address on the LAN.");
    return ip;
  });
  return {
    ssids: list(input.ssids, "home SSID", validateHomeSsid),
    mode,
    ...(mode === "private-domain" ? { suffix: domain(input.suffix) } : {}),
    addresses,
    ...validateHomeCheck(input.homeCheck),
  };
}

export function validateDefinition(input) {
  const name = string(input.name, "package name", 64);
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    throw new Error("Use a lowercase package slug.");
  const targets = list(input.targets, "target", (value) => {
    if (!["apple", "windows"].includes(value))
      throw new Error("Select apple or windows.");
    return value;
  });
  const appleDns = targets.includes("apple")
    ? (input.appleDns ?? "existing")
    : undefined;
  if (appleDns !== undefined && !["existing", "encrypted"].includes(appleDns))
    throw new Error("Select existing or encrypted Apple DNS.");
  const encrypted = appleDns === "encrypted";
  /** @type {Partial<ReturnType<typeof validateDnsPolicy>>} */
  const dns =
    encrypted || targets.includes("windows") ? validateDnsPolicy(input) : {};
  const shortcuts = (input.shortcuts ?? []).map((item) => {
    const label = string(item.name, "shortcut label", 80);
    if (
      targets.includes("windows") &&
      (/[<>:"/\\|?*]|[. ]$/.test(label) ||
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i.test(label))
    )
      throw new Error("Invalid Windows shortcut filename.");
    const rawUrl = string(item.url, "shortcut URL", 2048);
    if (!/^https?:\/\//i.test(rawUrl) || rawUrl.includes("\\"))
      throw new Error("Use a complete HTTP or HTTPS URL.");
    const url = new URL(rawUrl);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Use a web URL without credentials.");
    const opening = item.opening ?? "browser";
    if (
      !["browser", "ios-fullscreen"].includes(opening) ||
      (opening === "ios-fullscreen" && !targets.includes("apple"))
    )
      throw new Error("Unsupported opening behavior.");
    return {
      name: label,
      url: url.href,
      opening,
      ...(item.icon ? { icon: string(item.icon, "local PNG path", 1024) } : {}),
    };
  });
  if (
    new Set(shortcuts.map((x) => x.name.toLowerCase())).size !==
    shortcuts.length
  )
    throw new Error("Duplicate shortcut label.");
  return {
    name,
    displayName: string(input.displayName ?? name, "display name"),
    description: string(
      input.description ?? "Home network device setup",
      "description",
    ),
    targets,
    ...(appleDns ? { appleDns } : {}),
    ...dns,
    ...(encrypted ? { resolver: domain(input.resolver) } : {}),
    shortcuts,
  };
}

export function validateRoot(pem, now = Date.now()) {
  const match =
    typeof pem === "string" &&
    pem
      .trim()
      .match(
        /^-----BEGIN CERTIFICATE-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END CERTIFICATE-----$/,
      );
  if (!match)
    throw new Error("Expected exactly one public PEM root certificate.");
  const encoded = match[1].replace(/\s/g, "");
  const der = Buffer.from(encoded, "base64");
  if (der.toString("base64") !== encoded)
    throw new Error("Invalid PEM certificate encoding.");
  const cert = new X509Certificate(der);
  if (
    !cert.raw.equals(der) ||
    !cert.ca ||
    cert.subject !== cert.issuer ||
    !cert.verify(cert.publicKey) ||
    now < Date.parse(cert.validFrom) ||
    now >= Date.parse(cert.validTo)
  )
    throw new Error("Expected a currently valid self-signed CA root.");
  return cert;
}

export async function fetchProfileRoot(project, proxmox) {
  const ca = project.config.managedInventory.platform.certificateAuthority;
  const ref = project.state.providerReferences[ca?.id];
  if (!ref?.vmid || ref.provisioningPending || !proxmox?.pctExec)
    throw new Error("Provision the CA and run on its trusted Proxmox host.");
  const location = {
    "step-ca": "/var/lib/stepca/certs/root_ca.crt",
    "caddy-internal-ca":
      "/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt",
  }[ca.service];
  if (!location) throw new Error("Unsupported CA provider for device setup.");
  let root;
  try {
    root = await proxmox.pctExec(ref.vmid, {
      binary: "/bin/cat",
      args: [location],
    });
  } catch {
    throw new Error(
      "Cannot read " +
        location +
        " in CA LXC " +
        ref.vmid +
        ". Check host permissions, CA storage and initial certificate issuance.",
    );
  }
  return validateRoot(root.stdout);
}
