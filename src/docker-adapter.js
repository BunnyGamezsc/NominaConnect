import { withBoundedRetry } from "./adoption.js";
import { COMPOSE_LABELS, DOCKER_LIMITS, normalizeDockerDiscovery } from "./docker-discovery.js";

/** Accept only bounded absolute local Unix socket paths without traversal or shell metacharacters. */
export function validateDockerSocket(socketPath = "/var/run/docker.sock") {
  if (typeof socketPath !== "string" || socketPath.length > 200 || !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(socketPath)
    || socketPath.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("Docker socket must be an absolute local Unix socket path without traversal or shell characters. Rootless and remote Docker environments are unsupported; use manual exposure entry.");
  }
  return socketPath;
}

/** Return a numeric Proxmox LXC ID, rejecting malformed values and IDs outside the supported range. */
export function validateDockerVmid(vmid) {
  const number = Number(vmid);
  if (!/^\d+$/.test(String(vmid)) || !Number.isSafeInteger(number) || number < 100 || number > 999999999) throw new Error("LXC VMID must be an integer between 100 and 999999999.");
  return number;
}

const INSPECT_FORMAT = '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"status":{{json .State.Status}},"networkMode":{{json .HostConfig.NetworkMode}},"ports":{{json .NetworkSettings.Ports}},"exposedPorts":{{json .Config.ExposedPorts}},"labels":{' + COMPOSE_LABELS.map((label) => `"${label}":{{json (index .Config.Labels "${label}")}}`).join(",") + '}}';

/** Build bounded, read-only Docker verification and discovery operations for rootful local Unix sockets. */
export function createDockerAdapter(proxmox, retryOptions = {}) {
  /** Execute a bounded command in the LXC and replace provider failures with diagnostics that omit provider output. */
  async function exec(vmid, command) {
    validateDockerVmid(vmid);
    try { return await proxmox.pctExec(vmid, { timeoutMs: 10000, maxOutputBytes: DOCKER_LIMITS.outputBytes, ...command }); }
    catch (error) {
      // CommandExecutionError contains provider output. Never propagate that
      // output wholesale: it can contain operator data or credentials.
      throw new Error(`Docker inspection command ${command.binary.split("/").at(-1)} failed in LXC ${vmid}${error.timedOut ? " (timed out)" : ""}. Check the running CT, rootful Engine, and local Unix socket; use manual exposure entry if unsupported.`);
    }
  }
  /** Run Docker against the explicit socket with an isolated environment and no operator CLI configuration. */
  async function docker(vmid, socketPath, args, extra = {}) {
    validateDockerSocket(socketPath);
    return exec(vmid, {
      binary: "/usr/bin/env",
      // An existing, read-only directory is required for CLI plugin discovery.
      // /dev/null makes Docker skip Compose/Buildx. Kernel fd entries cannot
      // contain config.json, contexts or operator credential helpers.
      args: ["-i", "PATH=/usr/sbin:/usr/bin:/sbin:/bin", "/usr/bin/docker", "--config", "/proc/self/fd", "--host", `unix://${socketPath}`, ...args], ...extra
    });
  }
  const retry = (operation) => withBoundedRetry(operation, { maxRetries: 2, baseDelayMs: 100, ...retryOptions });
  return Object.freeze({
    /** Verify a running LXC and root-owned rootful Docker socket; optionally check Compose and Buildx without changing the CT. */
    async verify(vmid, socketPath, { compose = false } = {}) {
      validateDockerVmid(vmid);
      validateDockerSocket(socketPath);
      return retry(async () => {
        let ct;
        try { ct = await proxmox.inspectLxc(vmid); } catch { throw new Error(`LXC ${vmid} is missing or cannot be inspected. No replacement was created.`); }
        if (await proxmox.lxcStatus(vmid) !== "running") throw new Error(`LXC ${vmid} must already be running. Connect never starts or reconfigures it.`);
        await exec(vmid, { binary: "/usr/bin/test", args: ["-S", socketPath] });
        const owner = await exec(vmid, { binary: "/usr/bin/stat", args: ["-Lc", "%u", "--", socketPath] });
        if (owner.stdout.trim() !== "0") throw new Error("Only a root-owned local Unix socket and rootful Engine are supported. Rootless/remote setups require manual exposure entry.");
        const canonical = await exec(vmid, { binary: "/usr/bin/readlink", args: ["-f", "--", socketPath] });
        const canonicalSocketPath = validateDockerSocket(canonical.stdout.trim());
        const result = await docker(vmid, socketPath, ["info", "--format", '{{json .SecurityOptions}}']);
        const security = JSON.parse(result.stdout);
        if (!Array.isArray(security) || security.some((value) => String(value).includes("rootless"))) throw new Error("Rootless Docker is unsupported. Use a rootful local Engine or manual exposure entry.");
        if (compose) {
          await docker(vmid, socketPath, ["compose", "version", "--short"]);
          await docker(vmid, socketPath, ["buildx", "version"]);
        }
        return { status: "healthy", ip: ct.ip, hostname: ct.hostname, unprivileged: ct.unprivileged, canonicalSocketPath };
      });
    },
    /** Inspect allowlisted container fields within output, count and time budgets, returning endpoints and incomplete-discovery diagnostics. */
    async discover(vmid, socketPath) {
      const deadline = Date.now() + DOCKER_LIMITS.durationMs;
      const health = await this.verify(vmid, socketPath);
      const listed = await retry(() => docker(vmid, socketPath, ["ps", "--all", "--no-trunc", "--format", "{{.ID}}"], { truncateOutput: true }));
      const ids = listed.stdout.split("\n").filter((id) => /^[a-f0-9]{64}$/.test(id));
      const observations = [];
      const diagnostics = [];
      const networks = new Map();
      for (const id of ids.slice(0, DOCKER_LIMITS.containers)) {
        if (Date.now() >= deadline) { diagnostics.push("Discovery reached its time budget. Inspect again or use manual entry."); break; }
        try {
          const result = await retry(() => docker(vmid, socketPath, ["container", "inspect", "--format", INSPECT_FORMAT, id]));
          const observed = JSON.parse(result.stdout);
          if (observed.id !== id) throw new Error("Container identity changed during inspection.");
          const mode = observed.networkMode;
          if (mode && !["host", "none"].includes(mode)) {
            if (!networks.has(mode)) {
              try {
                const info = await docker(vmid, socketPath, ["network", "inspect", "--format", '{{json .Driver}} {{json (index .Options "com.docker.network.bridge.gateway_mode_ipv4")}} {{json (index .Options "com.docker.network.bridge.gateway_mode_ipv6")}}', mode === "default" ? "bridge" : mode]);
                networks.set(mode, info.stdout.trim());
              } catch { networks.set(mode, undefined); }
            }
            const info = networks.get(mode);
            observed.networkDriver = info?.includes('"macvlan"') ? "macvlan" : info?.includes('"ipvlan"') ? "ipvlan" : undefined;
            observed.directRouting = info?.includes('"routed"') || info?.includes('"nat-unprotected"');
            observed.networkUnknown = info === undefined;
          }
          observations.push(observed);
        } catch { diagnostics.push(`Container ${id} disappeared or could not be inspected within the output/time limits. Run inspect again; no identity was adopted.`); }
      }
      const result = normalizeDockerDiscovery(observations, health.ip);
      result.truncated ||= ids.length > DOCKER_LIMITS.containers || listed.truncated === true || diagnostics.length > 0;
      return { ...result, diagnostics, health, observedAt: new Date().toISOString() };
    }
  });
}

// Static script only, executed in a newly created CT. Operator input is never
// interpolated. Retry skips installation entirely once all required packages
// are configured, preventing a retry from upgrading an existing installation.
export const DOCKER_INSTALL_SCRIPT = `set -eu
. /etc/os-release
test "$ID" = debian && test "$VERSION_ID" = 13
export DEBIAN_FRONTEND=noninteractive
if dpkg-query -W -f='\${Status}\\n' docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>/dev/null | grep -v 'install ok installed' >/dev/null; then
  installed=no
else
  installed=$(dpkg-query -W -f='\${Status}\\n' docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>/dev/null | wc -l)
fi
if [ "$installed" != 5 ]; then
  apt-get update
  apt-get install -y --no-upgrade ca-certificates python3
  install -m 0755 -d /etc/apt/keyrings
  python3 - <<'PY'
import urllib.request
from pathlib import Path
Path('/etc/apt/keyrings/docker.asc').write_bytes(urllib.request.urlopen('https://download.docker.com/linux/debian/gpg', timeout=30).read(65536))
PY
  chmod a+r /etc/apt/keyrings/docker.asc
  architecture=$(dpkg --print-architecture)
  printf 'Types: deb\\nURIs: https://download.docker.com/linux/debian\\nSuites: trixie\\nComponents: stable\\nArchitectures: %s\\nSigned-By: /etc/apt/keyrings/docker.asc\\n' "$architecture" > /etc/apt/sources.list.d/docker.sources
  apt-get update
  apt-get install -y --no-upgrade docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
`;
