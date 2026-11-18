import { createHash } from "node:crypto";

function plist(value) {
  if (Buffer.isBuffer(value))
    return "<data>" + value.toString("base64") + "</data>";
  if (Array.isArray(value))
    return "<array>" + value.map(plist).join("") + "</array>";
  if (typeof value === "object")
    return (
      "<dict>" +
      Object.entries(value)
        .map(([key, v]) => "<key>" + key + "</key>" + plist(v))
        .join("") +
      "</dict>"
    );
  if (typeof value === "boolean") return value ? "<true/>" : "<false/>";
  if (typeof value === "number") return "<integer>" + value + "</integer>";
  return (
    "<string>" +
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;") +
    "</string>"
  );
}

export function appleProfiles(pkg, identity, cert, icons) {
  function metadata(type, role, title) {
    const id = "org.nominaconnect.device." + identity + "." + role;
    const bytes = createHash("sha256").update(id).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 15) | 128;
    bytes[8] = (bytes[8] & 63) | 128;
    const uuid = bytes
      .toString("hex")
      .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
    return {
      PayloadType: type,
      PayloadIdentifier: id,
      PayloadUUID: uuid,
      PayloadVersion: 1,
      PayloadDisplayName: title,
    };
  }
  const root = {
    ...metadata("com.apple.security.root", "root", "Household CA"),
    PayloadContent: cert.raw,
  };
  const dns =
    pkg.appleDns === "encrypted"
      ? [
          {
            ...metadata("com.apple.dnsSettings.managed", "dns", pkg.mode),
            DNSSettings: {
              DNSProtocol: "TLS",
              ServerName: pkg.resolver,
              ServerAddresses: pkg.addresses,
              AllowFailover: false,
              ...(pkg.mode === "private-domain"
                ? { SupplementalMatchDomains: [pkg.suffix] }
                : {}),
            },
            OnDemandRules: [
              {
                Action: "Connect",
                InterfaceTypeMatch: "WiFi",
                SSIDMatch: pkg.ssids,
              },
              { Action: "Disconnect" },
            ],
          },
        ]
      : [];
  function clips(mobile) {
    return pkg.shortcuts.map((s, i) => ({
      ...metadata("com.apple.webClip.managed", "clip." + i, s.name),
      Label: s.name,
      URL: s.url,
      ...(icons[i] ? { Icon: icons[i] } : {}),
      ...(mobile
        ? { FullScreen: s.opening === "ios-fullscreen", IsRemovable: true }
        : {}),
    }));
  }
  function profile(role, scope, payloads) {
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">' +
      plist({
        ...metadata(
          "Configuration",
          role,
          pkg.displayName + (scope === "User" ? " shortcuts" : ""),
        ),
        PayloadDescription: pkg.description,
        PayloadRemovalDisallowed: false,
        PayloadScope: scope,
        PayloadContent: payloads,
      }) +
      "</plist>\n"
    );
  }
  return {
    "mac.mobileconfig": profile("mac", "System", [root, ...dns]),
    "mobile.mobileconfig": profile("mobile", "System", [
      root,
      ...dns,
      ...clips(true),
    ]),
    ...(pkg.shortcuts.length
      ? {
          "mac-shortcuts.mobileconfig": profile(
            "macclips",
            "User",
            clips(false),
          ),
        }
      : {}),
  };
}
