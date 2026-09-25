import { createHash } from "node:crypto";

import { ensureTunDevice, VpnPrerequisiteError, describeTunRemediation as describeVpnTunRemediation } from "./vpn-lxc.js";

// Tailscale ships a Debian repository, so the LXC install is apt-based and the
// codename is read from the container rather than pinned to one Debian
// release. Everything else happens through the `tailscale` CLI inside the
// service LXC over pct exec (ADR-0032): there is no local admin API to talk to.
const TAILSCALE_BIN = "/usr/bin/tailscale";
const TAILSCALED_UNIT = "tailscaled";

// The enrollment credential is piped into the LXC over standard input, written
// to a root-only file under /run, and handed to `tailscale up
// --auth-key=file:`. It never appears in an argument array, so it cannot reach
// the Proxmox host's process list, a diagnostic, or a change notice. The file
// is removed as soon as enrollment finishes; tailscaled keeps its own node key
// from then on.
const AUTH_KEY_PATH = "/run/nomina-tailscale.authkey";

// A tailnet auth key is an opaque `tskey-...` token. Anything with quoting or
// whitespace in it is not an auth key, and a stored value of that shape is a
// misconfiguration worth reporting before it reaches the client.
const AUTH_KEY_PATTERN = /^[A-Za-z0-9_.\-+/=]+$/;

// Identifies Tailscale in the shared VPN LXC prerequisite check (ADR-0038).
const CLIENT = Object.freeze({
  label: "Tailscale",
  addCommand: "nomina service add tailscale",
  errorName: "TailscalePrerequisiteError"
});

export { VpnPrerequisiteError as TailscalePrerequisiteError };

export function createTailscaleAdapter({ secretResolver, exec, enableTunDevice, tailnetController = undefined, sleep = defaultSleep }) {
  const requireExec = (request) => {
    if (typeof exec !== "function") {
      throw new Error("Tailscale requires Proxmox-shell execution, which is unavailable.");
    }
    if (request?.vmid === undefined) {
      throw new Error("Tailscale requires the managed LXC id, which is not recorded for this project.");
    }
    return (command) => exec(request.vmid, command);
  };

  return Object.freeze({
    ...(tailnetController === undefined ? {} : {
      configureTailnet: (request) => tailnetController.configure(request)
    }),
    // Prerequisites are checked before any install command is returned, so an
    // LXC that cannot run a VPN fails with remediation instead of leaving a
    // half-installed client behind. The auth key is resolved here too — only to
    // fail fast on a missing or malformed credential. Enrollment itself happens
    // in configure(), so no returned command ever carries the key.
    async setup(plan) {
      // Plan-only context (e.g. `init`): no LXC exists yet, so there is
      // nothing to grant TUN to and no enrollment secret to pre-check.
      // Return the install commands; the TUN grant and credential check
      // run when provisioning calls setup() again with the created vmid.
      if (plan?.vmid === undefined) {
        return { ...plan, lxcCommands: installCommands() };
      }
      const run = requireExec(plan);
      await ensureTunDevice(run, plan.vmid, { enableTunDevice, sleep, client: CLIENT });
      resolveEnrollmentCredential(secretResolver, plan.connectionSecretReference);
      return { ...plan, lxcCommands: installCommands() };
    },
    async upgrade(plan) {
      return { ...plan, lxcCommands: upgradeCommands() };
    },
    // Enrollment. Provisioning calls configure() under bounded retry, so a
    // client that is still starting is a retryable failure rather than a failed
    // install, and an already-enrolled node is left alone instead of being
    // re-registered on every attempt.
    async configure(request) {
      const run = requireExec(request);
      if (!isOperational(await readStatusOrUndefined(run))) {
        const authKey = resolveEnrollmentCredential(secretResolver, request.connectionSecretReference);
        await enroll(run, authKey);
      }
      const status = await readStatus(run);
      if (status.backendState !== "Running") {
        throw new Error(describeEnrollmentFailure(status));
      }
      if ((status.self?.tailscaleIps.length ?? 0) === 0) {
        throw new Error("Tailscale enrolled but has not been assigned a tailnet address yet.");
      }
      return {
        backendState: status.backendState,
        tailnetIps: status.self?.tailscaleIps ?? [],
        tailnet: status.tailnet
      };
    },
    // Inspection is read-only: it reports every device the client can see. The
    // enrolled node is flagged so provisioning can record its provider-native
    // locator; every other peer is an unmanaged resource that NominaConnect
    // preserves and never touches.
    async inspect(request) {
      const run = requireExec(request);
      const status = await readStatus(run);
      const devices = [...(status.self === undefined ? [] : [status.self]), ...status.peers];
      return {
        resources: devices.map((device) => toManagedResource(device)),
        ...(status.version === undefined ? {} : { version: status.version })
      };
    },
    async adopt(request) {
      const locators = new Map();
      for (const resource of request.managed ?? []) {
        const key = locatorKey(resource.locator ?? locatorFor(resource));
        locators.set(key, (locators.get(key) ?? 0) + 1);
      }
      const ambiguous = [...locators.entries()].filter(([, count]) => count > 1).map(([key]) => key);
      if (ambiguous.length > 0) {
        return {
          managedInventoryUpdate: [],
          warnings: [`Ambiguous Tailscale node ${ambiguous[0]}; the managed VPN node was not adopted.`]
        };
      }
      return {
        managedInventoryUpdate: (request.managed ?? []).map((resource) => ({
          ...resource,
          fingerprint: resource.fingerprint ?? fingerprintFor(resource.locator ?? locatorFor(resource), resource)
        }))
      };
    },
    // A running tailscaled is not an operational VPN: a node whose key expired
    // keeps the process alive while the backend sits in NeedsLogin.
    async healthCheck(request) {
      let run;
      try {
        run = requireExec(request);
      } catch {
        return { process: "unknown", endpoint: "unknown" };
      }
      const process = (await isUnitActive(run)) ? "running" : "stopped";
      try {
        const status = await readStatus(run);
        return { process, endpoint: isOperational(status) ? "reachable" : "unreachable" };
      } catch {
        return { process, endpoint: "unreachable" };
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Enrollment credential
// ---------------------------------------------------------------------------

function resolveEnrollmentCredential(secretResolver, reference) {
  if (reference === undefined) {
    throw new Error(
      "No Tailscale auth key reference is recorded for this project. Run nomina from an interactive terminal so the tailnet auth key can be stored securely."
    );
  }
  if (secretResolver?.resolve === undefined) {
    throw new Error("The secure local secret store is unavailable. Run nomina as root on the Proxmox host.");
  }
  let authKey;
  try {
    authKey = secretResolver.resolve(reference);
  } catch (error) {
    // The reference is a path in the secret store, never the key itself.
    throw new Error(`Unable to read the Tailscale auth key from the secure local secret store: ${error.message}`);
  }
  const trimmed = String(authKey ?? "").trim();
  if (trimmed === "") {
    throw new Error("The stored Tailscale auth key is empty. Run 'nomina secret change' to store a tailnet auth key.");
  }
  if (!AUTH_KEY_PATTERN.test(trimmed)) {
    throw new Error(
      "The stored Tailscale credential does not look like a tailnet auth key. Generate one in the Tailscale admin console and store it with 'nomina secret change'."
    );
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function installCommands() {
  const repositoryScript = [
    "set -e",
    ". /etc/os-release",
    "install -m 0755 -d /usr/share/keyrings",
    'curl -fsSL "https://pkgs.tailscale.com/stable/debian/${VERSION_CODENAME}.noarmor.gpg" -o /usr/share/keyrings/tailscale-archive-keyring.gpg',
    'curl -fsSL "https://pkgs.tailscale.com/stable/debian/${VERSION_CODENAME}.tailscale-keyring.list" -o /etc/apt/sources.list.d/tailscale.list'
  ].join("\n");
  return [
    { binary: "/usr/bin/apt-get", args: ["update"], timeoutMs: 180_000 },
    { binary: "/usr/bin/apt-get", args: ["install", "--yes", "curl", "ca-certificates"], timeoutMs: 180_000 },
    { binary: "/bin/bash", args: ["-c", repositoryScript], timeoutMs: 60_000 },
    { binary: "/usr/bin/apt-get", args: ["update"], timeoutMs: 180_000 },
    { binary: "/usr/bin/apt-get", args: ["install", "--yes", "tailscale"], timeoutMs: 300_000 },
    { binary: "/bin/bash", args: ["-c", `systemctl enable --now ${TAILSCALED_UNIT}`], timeoutMs: 60_000 }
  ];
}

// `--accept-dns=false` keeps the LXC pointed at the managed Technitium
// resolver instead of replacing it with MagicDNS. The key file is removed even
// when `tailscale up` fails, so a rejected key is never left on disk.
async function enroll(run, authKey) {
  await run({
    binary: "/bin/bash",
    args: ["-c", `umask 077 && cat > ${AUTH_KEY_PATH}`],
    stdin: authKey,
    redactions: [authKey],
    timeoutMs: 15_000
  });
  try {
    await run({
      binary: TAILSCALE_BIN,
      args: ["up", `--auth-key=file:${AUTH_KEY_PATH}`, "--accept-dns=false"],
      redactions: [authKey],
      timeoutMs: 120_000
    });
  } catch (error) {
    // `tailscale up` reports a refused key as a command failure. Translate it
    // into the remediation the operator needs, keeping the (already redacted)
    // client output for diagnosis.
    throw new Error(`${describeEnrollmentFailure({ backendState: "NeedsLogin" })} Tailscale reported: ${error.message}`);
  } finally {
    await run({ binary: "/bin/rm", args: ["-f", AUTH_KEY_PATH], timeoutMs: 15_000 }).catch(() => {});
  }
}

function upgradeCommands() {
  return [
    { binary: "/usr/bin/apt-get", args: ["update"], timeoutMs: 180_000 },
    { binary: "/usr/bin/apt-get", args: ["install", "--only-upgrade", "--yes", "tailscale"], timeoutMs: 300_000 },
    { binary: "/bin/bash", args: ["-c", `systemctl restart ${TAILSCALED_UNIT}`], timeoutMs: 60_000 }
  ];
}

// ---------------------------------------------------------------------------
// Client state
// ---------------------------------------------------------------------------

function isOperational(status) {
  return status?.backendState === "Running" && (status.self?.tailscaleIps.length ?? 0) > 0;
}

async function readStatusOrUndefined(run) {
  try {
    return await readStatus(run);
  } catch {
    return undefined;
  }
}

async function readStatus(run) {
  let result;
  try {
    result = await run({ binary: TAILSCALE_BIN, args: ["status", "--json"], timeoutMs: 30_000 });
  } catch (error) {
    // A client that is stopped or logged out still prints its state document
    // and exits non-zero. That state is the answer, not a failure.
    const reported = error?.result?.stdout;
    if (typeof reported === "string" && reported.trim().startsWith("{")) {
      return parseTailscaleStatus(reported);
    }
    throw new Error(`Tailscale status is unavailable in the managed LXC: ${error.message}`);
  }
  return parseTailscaleStatus(result?.stdout);
}

export function parseTailscaleStatus(stdout) {
  let payload;
  try {
    payload = JSON.parse(String(stdout ?? ""));
  } catch {
    throw new Error("Tailscale returned a malformed status document.");
  }
  if (payload === null || typeof payload !== "object") {
    throw new Error("Tailscale returned a malformed status document.");
  }
  return {
    backendState: payload.BackendState,
    version: payload.Version,
    authUrl: payload.AuthURL,
    tailnet: payload.CurrentTailnet?.Name,
    self: payload.Self === undefined ? undefined : toDevice(payload.Self, true),
    peers: Object.values(payload.Peer ?? {}).map((peer) => toDevice(peer, false))
  };
}

function toDevice(node, isSelf) {
  return {
    id: node.ID ?? node.PublicKey ?? node.DNSName ?? node.HostName,
    hostname: node.HostName,
    dnsName: typeof node.DNSName === "string" ? node.DNSName.replace(/\.$/, "") : undefined,
    tailscaleIps: Array.isArray(node.TailscaleIPs) ? [...node.TailscaleIPs] : [],
    online: node.Online === true,
    tags: Array.isArray(node.Tags) ? [...node.Tags] : [],
    self: isSelf
  };
}

function toManagedResource(device) {
  const locator = locatorFor(device);
  return {
    id: locator.id,
    locator,
    fingerprint: fingerprintFor(locator, device),
    hostname: device.hostname,
    tailscaleIps: device.tailscaleIps,
    online: device.online,
    ...(device.self ? { self: true } : {})
  };
}

function locatorFor(device) {
  return {
    id: device.id ?? device.locator?.id ?? device.hostname,
    dnsName: device.dnsName ?? device.locator?.dnsName,
    hostname: device.hostname ?? device.locator?.hostname
  };
}

function locatorKey(locator) {
  return `${locator.id ?? ""}/${locator.dnsName ?? ""}`;
}

function fingerprintFor(locator, device) {
  return createHash("sha256")
    .update(JSON.stringify({
      locator,
      device: {
        hostname: device.hostname,
        tailscaleIps: device.tailscaleIps ?? [],
        online: device.online === true,
        tags: device.tags ?? []
      }
    }))
    .digest("hex");
}

async function isUnitActive(run) {
  try {
    const result = await run({
      binary: "/bin/bash",
      args: ["-c", `systemctl is-active ${TAILSCALED_UNIT} || true`],
      timeoutMs: 20_000
    });
    return String(result?.stdout ?? "").trim().split("\n").pop() === "active";
  } catch {
    return false;
  }
}

function describeEnrollmentFailure(status) {
  if (status.backendState === "NeedsLogin") {
    return "Tailscale is installed but not enrolled: the tailnet auth key was rejected, already used, or expired. Store a fresh key with 'nomina secret change' and run this command again.";
  }
  if (status.backendState === "Stopped") {
    return "Tailscale is installed but the tunnel is stopped. Start it with 'tailscale up' in the managed LXC and run this command again.";
  }
  return `Tailscale has not finished enrolling (backend state: ${status.backendState ?? "unknown"}).`;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function describeTunRemediation(vmid) {
  return describeVpnTunRemediation(vmid, CLIENT);
}

export { AUTH_KEY_PATH };
