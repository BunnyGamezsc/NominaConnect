import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

async function installerSources() {
  if (process.versions.bun) {
    // @ts-ignore Bun embeds these files in standalone builds.
    const helper = await import("../clients/device-setup/device.ps1", {
      with: { type: "file" },
    });
    // @ts-ignore Bun file asset import.
    const script = await import("../clients/device-setup/setup.nsi", {
      with: { type: "file" },
    });
    return [helper, script].map((asset) => fs.readFileSync(asset.default));
  }
  return ["device.ps1", "setup.nsi"].map((name) =>
    fs.readFileSync(
      new URL("../clients/device-setup/" + name, import.meta.url),
    ),
  );
}

export function pngIcon(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = png.readUInt32BE(16) % 256;
  header[7] = png.readUInt32BE(20) % 256;
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

export async function buildWindows(pkg, id, cert, icons, destination) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))
    throw new Error("Invalid package identity.");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nomina-setup-"));
  try {
    const [helper, script] = await installerSources();
    const shortcuts = pkg.shortcuts.map((s, i) => {
      if (!icons[i]) return { name: s.name, url: s.url };
      const ico = "icon-" + i + ".ico";
      fs.writeFileSync(path.join(tmp, ico), pngIcon(icons[i]));
      return { name: s.name, url: s.url, ico };
    });
    fs.writeFileSync(path.join(tmp, "device.ps1"), helper);
    fs.writeFileSync(path.join(tmp, "root.cer"), cert.raw);
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({
        ...pkg,
        shortcuts,
        sha256: cert.fingerprint256.replaceAll(":", ""),
      }),
    );
    fs.writeFileSync(
      path.join(tmp, "review.txt"),
      "\uFEFF" +
        [
          pkg.displayName,
          pkg.description,
          "CA SHA-256: " + cert.fingerprint256,
          "Trust permits this CA to authenticate any HTTPS site.",
          "Home Wi-Fi: " + pkg.ssids.join(", "),
          ...(pkg.homeCheck?.dnsServers
            ? [
                "Expected Wi-Fi DNS servers: " +
                  pkg.homeCheck.dnsServers.join(", "),
              ]
            : []),
          ...(pkg.homeCheck?.probeUrl
            ? ["Home-only HTTPS check: " + pkg.homeCheck.probeUrl]
            : []),
          "DNS: " + pkg.mode + " " + (pkg.suffix ?? ""),
          "Resolver IPs: " + pkg.addresses.join(", "),
          "Windows uses port 53 DNS. Existing local name fallback and VPN policies still apply.",
          "Resolver outage at home may stop browsing.",
          "Shortcuts:",
          ...shortcuts.map((s) => s.name + " — " + s.url),
        ].join("\r\n"),
      "utf16le",
    );
    fs.writeFileSync(path.join(tmp, "setup.nsi"), script);
    const digest = createHash("sha256");
    for (const file of fs.readdirSync(tmp).sort())
      digest.update(file).update(fs.readFileSync(path.join(tmp, file)));
    const revision = digest
      .digest("hex")
      .slice(0, 32)
      .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
    try {
      execFileSync(
        "makensis",
        ["-V2", "-DPackageId=" + id, "-DRevision=" + revision, "setup.nsi"],
        {
          cwd: tmp,
          stdio: "pipe",
          timeout: 120000,
          // NSIS initializes its Unicode shell constants through the host locale.
          // Its macOS build aborts in the POSIX C locale.
          env: {
            ...process.env,
            LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
            SOURCE_DATE_EPOCH: "946684800",
          },
        },
      );
    } catch (e) {
      throw new Error(
        "Windows setup build requires NSIS 3.x (makensis): " +
          (e.stderr?.toString() || e.message),
      );
    }
    fs.copyFileSync(
      path.join(tmp, "NominaDeviceSetup.exe"),
      destination,
      fs.constants.COPYFILE_EXCL,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
