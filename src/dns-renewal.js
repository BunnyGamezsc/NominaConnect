import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { findProjectDirectory, loadProject } from "./config.js";
import { hasManagedDnsCertificate, renewDnsCertificate } from "./dns-certificate.js";
import { cliInvocation } from "./ssh-operation.js";

const unitHeader = "# Managed by NominaConnect DNS certificate renewal.\n";

function unitName(directory) {
  return `nomina-dns-renewal-${createHash("sha256").update(directory).digest("hex").slice(0, 16)}`;
}

// A root systemd job must never load configuration or launch code from a path
// that a non-root user can replace, including through writable ancestors.
function trustedPath(filesystem, target, directory = false) {
  let entry = target;
  while (true) {
    const stat = filesystem.lstatSync(entry);
    const isDirectory = entry !== target || directory;
    if (stat.uid !== 0 || (stat.mode & 0o022) || !(isDirectory ? stat.isDirectory() : stat.isFile()))
      throw new Error(`Automatic renewal requires a trusted root-owned path: ${entry}.`);
    const parent = path.dirname(entry);
    if (parent === entry) return;
    entry = parent;
  }
}

function systemdArgument(value) {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Automatic renewal paths cannot contain control characters.");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

export function createDnsRenewalScheduler({ commandRunner, filesystem = fs, unitsDirectory = "/etc/systemd/system", invocation = cliInvocation() }) {
  const unitPath = (unit, type) => path.join(unitsDirectory, `${unit}.${type}`);
  const systemctl = (...args) => commandRunner.run({ binary: "/usr/bin/systemctl", args, timeoutMs: 30_000 });
  const projectPath = projectDirectory => {
    const directory = filesystem.realpathSync(projectDirectory);
    trustedPath(filesystem, path.join(directory, "nomina.yaml"));
    trustedPath(filesystem, path.join(directory, ".nomina", "state.json"));
    return directory;
  };
  const isManaged = file => {
    if (!filesystem.existsSync(file)) return false;
    trustedPath(filesystem, file);
    if (!filesystem.readFileSync(file, "utf8").startsWith(unitHeader))
      throw new Error(`Preserving existing systemd unit ${file}.`);
    return true;
  };
  const serviceContents = directory => {
    const launcher = invocation.map(file => {
      const resolved = filesystem.realpathSync(file);
      trustedPath(filesystem, resolved);
      return resolved;
    });
    const args = [...launcher, "ca", "dns-renewal", "check", "--project-dir", directory].map(systemdArgument);
    return `${unitHeader}[Unit]\nDescription=Renew the Nomina DNS-over-TLS certificate\n\n[Service]\nType=oneshot\nUMask=0077\nTimeoutStartSec=5min\nExecStart=:${args.join(" ")}\n`;
  };
  const replaceService = (file, content) => {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      filesystem.writeFileSync(temporary, content, { flag: "wx", mode: 0o644 });
      filesystem.renameSync(temporary, file);
    } finally {
      if (filesystem.existsSync(temporary)) filesystem.unlinkSync(temporary);
    }
  };
  return {
    projectPath,
    isRegistered(projectDirectory) {
      const directory = filesystem.realpathSync(projectDirectory);
      const unit = unitName(directory);
      return isManaged(unitPath(unit, "service")) && isManaged(unitPath(unit, "timer")) &&
        filesystem.readFileSync(unitPath(unit, "service"), "utf8") === serviceContents(directory) &&
        filesystem.existsSync(path.join(unitsDirectory, "timers.target.wants", `${unit}.timer`));
    },
    async register(projectDirectory) {
      const directory = projectPath(projectDirectory);
      const unit = unitName(directory);
      if (this.isRegistered(directory)) return unit;
      trustedPath(filesystem, unitsDirectory, true);
      const service = unitPath(unit, "service");
      const timer = unitPath(unit, "timer");
      const hasTimer = isManaged(timer);
      const wanted = serviceContents(directory);
      if (isManaged(service)) {
        const previous = filesystem.readFileSync(service, "utf8");
        if (previous !== wanted) {
          replaceService(service, wanted);
          try {
            await systemctl("daemon-reload");
          } catch (error) {
            replaceService(service, previous);
            throw error;
          }
          if (this.isRegistered(directory)) return unit;
        }
      } else {
        filesystem.writeFileSync(service, wanted, { flag: "wx", mode: 0o644 });
      }
      if (!hasTimer) filesystem.writeFileSync(timer, `${unitHeader}[Unit]\nDescription=Check the Nomina DNS-over-TLS certificate\n\n[Timer]\nOnActiveSec=1min\nOnUnitInactiveSec=15min\n\n[Install]\nWantedBy=timers.target\n`, { flag: "wx", mode: 0o644 });
      try {
        await systemctl("enable", "--now", `${unit}.timer`);
      } catch (error) {
        // A retry can safely recreate these application-owned units.
        await this.remove(directory);
        throw error;
      }
      return unit;
    },
    async remove(projectDirectory) {
      const unit = unitName(filesystem.realpathSync(projectDirectory));
      const service = unitPath(unit, "service");
      const timer = unitPath(unit, "timer");
      const hasService = isManaged(service);
      const hasTimer = isManaged(timer);
      if (!hasService && !hasTimer) return;
      if (hasTimer) {
        await systemctl("disable", "--now", `${unit}.timer`);
        filesystem.unlinkSync(timer);
      }
      if (hasService) filesystem.unlinkSync(service);
      await systemctl("daemon-reload");
    },
  };
}

export async function migrateDnsRenewal(adapters, projectDirectory = undefined, includeRootProject = false) {
  const { filesystem, dnsRenewal, runtime } = adapters;
  if (!dnsRenewal || !runtime?.isRoot() || !runtime.isProxmoxHost()) return { stdout: "" };
  const candidates = new Set(projectDirectory ? [projectDirectory] : [
    findProjectDirectory(filesystem, adapters.cwd ?? "."),
    ...(includeRootProject ? [findProjectDirectory(filesystem, "/root")] : []),
  ]);
  const messages = [];
  for (const directory of candidates) {
    if (!directory || !filesystem.exists(path.join(directory, ".nomina", "state.json"))) continue;
    if (dnsRenewal.isRegistered(directory)) continue;
    const projectPath = dnsRenewal.projectPath(directory);
    const release = await filesystem.acquireProjectLock?.(projectPath);
    try {
      if (dnsRenewal.isRegistered(projectPath)) continue;
      const project = loadProject(filesystem, projectPath);
      if (await hasManagedDnsCertificate(project, adapters)) {
        const unit = await dnsRenewal.register(projectPath);
        messages.push(`Automatic DNS certificate renewal enabled for ${projectPath} through ${unit}.timer.`);
      }
    } finally {
      release?.();
    }
  }
  return { stdout: messages.length ? messages.join("\n") + "\n" : "" };
}

export async function checkDnsRenewal(adapters, projectDirectory) {
  if (!projectDirectory) throw new Error("Specify the renewal project with --project-dir.");
  const projectPath = adapters.dnsRenewal.projectPath(projectDirectory);
  return renewDnsCertificate(loadProject(adapters.filesystem, projectPath), adapters);
}
