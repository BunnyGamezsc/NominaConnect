import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { PNG } from "pngjs";
import { appleProfiles } from "./device-apple.js";
import { buildWindows } from "./device-windows.js";

export function readIcons(pkg, directory) {
  return pkg.shortcuts.map((s) => {
    if (!s.icon) return null;
    const fd = fs.openSync(
      path.resolve(directory, s.icon),
      fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW,
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 1048576)
        throw new Error("Select a regular PNG under 1 MiB.");
      const bytes = fs.readFileSync(fd);
      if (
        bytes.length < 33 ||
        !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ||
        bytes.readUInt32BE(16) > 256 ||
        bytes.readUInt32BE(20) > 256
      )
        throw new Error("Select a PNG no larger than 256 by 256.");
      return PNG.sync.write(PNG.sync.read(bytes));
    } finally {
      fs.closeSync(fd);
    }
  });
}

export async function exportBundle({
  pkg,
  id,
  cert,
  output,
  projectDirectory,
}) {
  if (
    !output ||
    output.split(/[\\/]/).some((x) => ["..", ".nomina", ".git"].includes(x))
  )
    throw new Error(
      "Choose a fresh output directory outside project metadata.",
    );
  const dest = path.resolve(output),
    parent = path.dirname(dest);
  const physicalParent = fs.realpathSync(parent);
  const expected =
    process.platform === "darwin"
      ? parent.replace(/^\/(var|tmp|etc)(?=\/|$)/, "/private/$1")
      : parent;
  if (physicalParent !== expected)
    throw new Error("Choose an export parent without symbolic links.");
  const physicalDest = path.join(physicalParent, path.basename(dest));
  if (
    physicalParent.split(path.sep).some((x) => [".nomina", ".git"].includes(x))
  )
    throw new Error("Unsafe export directory.");
  if (fs.lstatSync(dest, { throwIfNoEntry: false }))
    throw new Error(
      "Destination exists. Choose a new export directory for this revision.",
    );
  const icons = readIcons(pkg, projectDirectory);
  const stage = fs.mkdtempSync(path.join(physicalParent, ".nomina-export-"));
  const platforms = [];
  const instructions = [
    pkg.displayName,
    pkg.description,
    "CA SHA-256: " + cert.fingerprint256,
    "Verify this fingerprint separately with the operator before installation. The trusted root can authenticate any website.",
    "Install only one revision of this package per device. Changing the root requires a new installation. Ordinary leaf renewal under the same CA does not.",
    "Distribute selected files manually over a trusted channel. The packages are unsigned.",
  ];
  if (pkg.mode) {
    const policy = pkg.suffix ? pkg.mode + " (" + pkg.suffix + ")" : pkg.mode;
    instructions.push(
      "Managed DNS policy: " +
        policy +
        ". Home Wi-Fi: " +
        pkg.ssids.join(", ") +
        ". SSIDs identify a network but do not authenticate it.",
      "At home a resolver outage can interrupt browsing. VPNs, browser secure DNS, multicast names and applications using their own resolvers may behave differently.",
    );
    if (pkg.homeCheck)
      instructions.push(
        "Home Wi-Fi must also pass each configured network check. If the HTTPS check is unavailable, the device will treat Wi-Fi as off-network.",
      );
  }
  try {
    const write = (name, content) =>
      fs.writeFileSync(path.join(stage, name), content, { flag: "wx" });
    if (pkg.targets.includes("apple")) {
      for (const [name, xml] of Object.entries(
        appleProfiles(pkg, id, cert, icons),
      ))
        write(name, xml);
      platforms.push("macOS / iOS / iPadOS 26 or newer");
      instructions.push(
        "Apple 26+: on Mac install mac.mobileconfig in System Settings > General > Device Management. Install mac-shortcuts.mobileconfig for this user if supplied. Remove the old shortcuts profile when replacing with zero clips.",
        "On iPhone/iPad install mobile.mobileconfig via Settings > General > VPN & Device Management. Enable the reviewed root under General > About > Certificate Trust Settings. On Mac check TLS trust in Keychain Access.",
        pkg.appleDns === "encrypted"
          ? "Apple uses DNS over TLS on port 853 with explicit bootstrap IPs when the primary Wi-Fi matches."
          : "Apple uses the device's existing DNS. Access to private hostnames depends on the DNS already available through your network or VPN.",
        "Mobile full-screen clips open in standalone mode. Mac clips open in the browser. Remove each installed profile in Device Management.",
      );
    }
    if (pkg.targets.includes("windows")) {
      await buildWindows(
        pkg,
        id,
        cert,
        icons,
        path.join(stage, "NominaDeviceSetup.exe"),
      );
      platforms.push("Windows 11 x64");
      instructions.push(
        "On Windows 11 x64, double-click NominaDeviceSetup.exe, verify its origin and fingerprint, review the license-page summary, and approve elevation. Organization signing or script policies may prevent installation.",
        "Windows uses the system DNS client and NRPT over ordinary DNS on port 53. Both IPv4 and IPv6 server addresses are supported. The catch-all rule selects ordinary DNS names. Local name resolution and VPN or application overrides remain system-controlled.",
        "Open Installed apps > Nomina device setup to modify/repair or uninstall. Run the new installer to replace the same package. See status.txt in Program Files/Nomina Device Setup/" +
          id +
          " for DNS state or conflicts. Shortcuts appear in the Start menu.",
      );
    }
    write("root.cer", cert.raw);
    write("INSTALL.txt", instructions.join("\n\n") + "\n");
    const manifest = {
      id,
      name: pkg.name,
      displayName: pkg.displayName,
      appleDns: pkg.appleDns,
      mode: pkg.mode,
      suffix: pkg.suffix,
      platforms,
      ssids: pkg.ssids,
      homeCheck: pkg.homeCheck,
      resolver: pkg.resolver,
      addresses: pkg.addresses,
      rootSHA256: cert.fingerprint256,
      shortcuts: pkg.shortcuts.map(({ name, url, opening }) => ({
        name,
        url,
        opening,
      })),
      files: fs.readdirSync(stage).sort(),
    };
    const hashes = Object.fromEntries(
      manifest.files.map((name) => [
        name,
        createHash("sha256")
          .update(fs.readFileSync(path.join(stage, name)))
          .digest("hex"),
      ]),
    );
    Object.assign(manifest, {
      revision: createHash("sha256")
        .update(JSON.stringify(hashes))
        .digest("hex"),
      sha256: hashes,
    });
    write("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    if (fs.lstatSync(physicalDest, { throwIfNoEntry: false }))
      throw new Error("Destination already exists.");
    fs.renameSync(stage, physicalDest);
    return { dest, manifest };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
