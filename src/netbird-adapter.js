import { createHash } from "node:crypto";

import { ensureTunDevice, VpnPrerequisiteError, describeTunRemediation as describeVpnTunRemediation } from "./vpn-lxc.js";

// NetBird ships a Debian repository, so the LXC install is apt-based: the
// `netbird` package installs the client and its systemd unit and starts it.
// Everything after that happens through the `netbird` CLI inside the service
// LXC over pct exec (ADR-0032). The client's local daemon socket is the only
// control surface; there is no local admin API, and NominaConnect never talks
// to the NetBird management API on the operator's behalf.
const NETBIRD_BIN = "/usr/bin/netbird";
const NETBIRD_UNIT = "netbird";

// The enrollment credential is piped into the LXC over standard input, written
// to a root-only file under /run, and handed to `netbird up --setup-key-file`.
// It never appears in an argument array, so it cannot reach the Proxmox host's
// process list, a diagnostic, or a change notice. The file is removed as soon
// as enrollment finishes; the client keeps its own peer key from then on.
const SETUP_KEY_PATH = "/run/nomina-netbird.setupkey";

// A NetBird setup key is an opaque token — a UUID from the dashboard on the
// current versions. Anything with quoting or whitespace in it is not a setup
// key, and a stored value of that shape is a misconfiguration worth reporting
// before it reaches the management server.
const SETUP_KEY_PATTERN = /^[A-Za-z0-9_.\-+/=]+$/;

// `daemonStatus` from `netbird status --json`. Connected is the only state in
// which the peer is actually on the network.
const CONNECTED = "Connected";

// Identifies NetBird in the shared VPN LXC prerequisite check (ADR-0038).
const CLIENT = Object.freeze({
  label: "NetBird",
  addCommand: "nomina service add netbird",
  errorName: "NetBirdPrerequisiteError"
});

export { VpnPrerequisiteError as NetBirdPrerequisiteError };

export function createNetBirdAdapter({ secretResolver, exec, enableTunDevice, sleep = defaultSleep }) {
  const requireExec = (request) => {
    if (typeof exec !== "function") {
      throw new Error("NetBird requires Proxmox-shell execution, which is unavailable.");
    }
    if (request?.vmid === undefined) {
      throw new Error("NetBird requires the managed LXC id, which is not recorded for this project.");
    }
    return (command) => exec(request.vmid, command);
  };

  return Object.freeze({
    // Prerequisites are checked before any install command is returned, so an
    // LXC that cannot run a VPN fails with remediation instead of leaving a
    // half-installed client behind. The setup key is resolved here too — only
    // to fail fast on a missing or malformed credential. Enrollment itself
    // happens in configure(), so no returned command ever carries the key.
    async setup(plan) {
      // Plan-only context (e.g. `init`): no LXC exists yet, so there is
      // nothing to grant TUN to and no setup key to pre-check. Return the
      // install commands; the TUN grant and credential check run when
      // provisioning calls setup() again with the created vmid.
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
    // install, and an already-enrolled peer is left alone instead of being
    // re-registered on every attempt.
    async configure(request) {
      const run = requireExec(request);
      if (!isOperational(await readStatusOrUndefined(run))) {
        const setupKey = resolveEnrollmentCredential(secretResolver, request.connectionSecretReference);
        await enroll(run, setupKey);
      }
      const status = await readStatus(run);
      if (status.daemonStatus !== CONNECTED || !status.management.connected) {
        throw new Error(describeEnrollmentFailure(status));
      }
      if ((status.self?.netbirdIps.length ?? 0) === 0) {
        throw new Error("NetBird enrolled but has not been assigned a network address yet.");
      }
      return {
        daemonStatus: status.daemonStatus,
        netbirdIps: status.self?.netbirdIps ?? [],
        managementUrl: status.management.url
      };
    },
    // Inspection is read-only: it reports every peer the client can see. The
    // enrolled peer is flagged so provisioning can record its provider-native
    // locator; every other peer belongs to the NetBird network, not to
    // NominaConnect, and is preserved untouched.
    async inspect(request) {
      const run = requireExec(request);
      const status = await readStatus(run);
      const peers = [...(status.self === undefined ? [] : [status.self]), ...status.peers];
      return {
        resources: peers.map((peer) => toManagedResource(peer)),
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
          warnings: [`Ambiguous NetBird peer ${ambiguous[0]}; the managed VPN peer was not adopted.`]
        };
      }
      return {
        managedInventoryUpdate: (request.managed ?? []).map((resource) => ({
          ...resource,
          fingerprint: resource.fingerprint ?? fingerprintFor(resource.locator ?? locatorFor(resource), resource)
        }))
      };
    },
    // A running netbird daemon is not an operational VPN: a peer whose setup
    // key expired, or that lost its management server, keeps the process alive
    // while it sits in NeedsLogin or Disconnected.
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
      "No NetBird setup key reference is recorded for this project. Run nomina from an interactive terminal so the setup key can be stored securely."
    );
  }
  if (secretResolver?.resolve === undefined) {
    throw new Error("The secure local secret store is unavailable. Run nomina as root on the Proxmox host.");
  }
  let setupKey;
  try {
    setupKey = secretResolver.resolve(reference);
  } catch (error) {
    // The reference is a path in the secret store, never the key itself.
    throw new Error(`Unable to read the NetBird setup key from the secure local secret store: ${error.message}`);
  }
  const trimmed = String(setupKey ?? "").trim();
  if (trimmed === "") {
    throw new Error("The stored NetBird setup key is empty. Run 'nomina secret change' to store a setup key.");
  }
  if (!SETUP_KEY_PATTERN.test(trimmed)) {
    throw new Error(
      "The stored NetBird credential does not look like a setup key. Create one in the NetBird dashboard under Setup Keys and store it with 'nomina secret change'."
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
    "install -m 0755 -d /usr/share/keyrings",
    'curl -fsSL https://pkgs.netbird.io/debian/public.key | gpg --dearmor --yes --output /usr/share/keyrings/netbird-archive-keyring.gpg',
    "echo 'deb [signed-by=/usr/share/keyrings/netbird-archive-keyring.gpg] https://pkgs.netbird.io/debian stable main' > /etc/apt/sources.list.d/netbird.list"
  ].join("\n");
  return [
    { binary: "/usr/bin/apt-get", args: ["update"], timeoutMs: 180_000 },
    { binary: "/usr/bin/apt-get", args: ["install", "--yes", "curl", "ca-certificates", "gnupg"], timeoutMs: 180_000 },
    { binary: "/bin/bash", args: ["-c", repositoryScript], timeoutMs: 60_000 },
    { binary: "/usr/bin/apt-get", args: ["update"], timeoutMs: 180_000 },
    { binary: "/usr/bin/apt-get", args: ["install", "--yes", "netbird"], timeoutMs: 300_000 },
    { binary: "/bin/bash", args: ["-c", `systemctl enable --now ${NETBIRD_UNIT}`], timeoutMs: 60_000 }
  ];
}

// `--disable-dns` keeps the LXC pointed at the managed Technitium resolver
// instead of letting NetBird take over /etc/resolv.conf. The key file is
// removed even when `netbird up` fails, so a rejected key is never left on
// disk.
async function enroll(run, setupKey) {
  await run({
    binary: "/bin/bash",
    args: ["-c", `umask 077 && cat > ${SETUP_KEY_PATH}`],
    stdin: setupKey,
    redactions: [setupKey],
    timeoutMs: 15_000
  });
  try {
    await run({
      binary: NETBIRD_BIN,
      args: ["up", `--setup-key-file=${SETUP_KEY_PATH}`, "--disable-dns"],
      redactions: [setupKey],
      timeoutMs: 120_000
    });
  } catch (error) {
    // `netbird up` reports a refused key as a command failure. Translate it
    // into the remediation the operator needs, keeping the (already redacted)
    // client output for diagnosis.
    throw new Error(
      `${describeEnrollmentFailure({ daemonStatus: "NeedsLogin", management: {} })} NetBird reported: ${error.message}`
    );
  } finally {
    await run({ binary: "/bin/rm", args: ["-f", SETUP_KEY_PATH], timeoutMs: 15_000 }).catch(() => {});
  }
}

function upgradeCommands() {
  return [
    { binary: "/usr/bin/apt-get", args: ["update"], timeoutMs: 180_000 },
    { binary: "/usr/bin/apt-get", args: ["install", "--only-upgrade", "--yes", "netbird"], timeoutMs: 300_000 },
    { binary: "/bin/bash", args: ["-c", `systemctl restart ${NETBIRD_UNIT}`], timeoutMs: 60_000 }
  ];
}

// ---------------------------------------------------------------------------
// Client state
// ---------------------------------------------------------------------------

function isOperational(status) {
  return status?.daemonStatus === CONNECTED
    && status.management.connected
    && (status.self?.netbirdIps.length ?? 0) > 0;
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
    result = await run({ binary: NETBIRD_BIN, args: ["status", "--json"], timeoutMs: 30_000 });
  } catch (error) {
    // A client that is stopped or has never logged in still reports its state
    // and exits non-zero. That state is the answer, not a failure.
    const reported = error?.result?.stdout;
    if (typeof reported === "string" && reported.trim() !== "") {
      return parseNetBirdStatus(reported);
    }
    throw new Error(`NetBird status is unavailable in the managed LXC: ${error.message}`);
  }
  return parseNetBirdStatus(result?.stdout);
}

export function parseNetBirdStatus(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text.startsWith("{")) {
    // A client that has never been logged in prints a plain-text summary
    // rather than a status document (netbirdio/netbird#2780). Its daemon state
    // is still the answer NominaConnect needs.
    const reported = /daemon status:\s*(\S+)/i.exec(text);
    if (reported === null) {
      throw new Error("NetBird returned a malformed status document.");
    }
    return { daemonStatus: reported[1], management: { connected: false }, peers: [] };
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("NetBird returned a malformed status document.");
  }
  if (payload === null || typeof payload !== "object") {
    throw new Error("NetBird returned a malformed status document.");
  }
  return {
    daemonStatus: payload.daemonStatus,
    version: payload.daemonVersion ?? payload.cliVersion,
    management: {
      url: payload.management?.url,
      connected: payload.management?.connected === true,
      error: payload.management?.error
    },
    signalConnected: payload.signal?.connected === true,
    self: toSelf(payload),
    peers: (payload.peers?.details ?? []).map((peer) => toPeer(peer))
  };
}

// The local peer is reported at the top level of the status document rather
// than in the peer list.
function toSelf(payload) {
  // Before the peer logs in, the client reports empty strings rather than
  // omitting these fields: there is no local peer to inspect yet.
  const id = present(payload.publicKey) ?? present(payload.fqdn);
  if (id === undefined) {
    return undefined;
  }
  return {
    id,
    publicKey: payload.publicKey,
    fqdn: normalizeFqdn(payload.fqdn),
    hostname: hostnameOf(payload.fqdn),
    netbirdIps: addressesOf(payload.netbirdIp, payload.netbirdIpv6),
    connected: payload.daemonStatus === CONNECTED,
    self: true
  };
}

function toPeer(peer) {
  return {
    id: present(peer.publicKey) ?? present(peer.fqdn),
    publicKey: peer.publicKey,
    fqdn: normalizeFqdn(peer.fqdn),
    hostname: hostnameOf(peer.fqdn),
    netbirdIps: addressesOf(peer.netbirdIp, peer.netbirdIpv6),
    connected: peer.status === CONNECTED,
    ...(peer.connectionType === undefined ? {} : { connectionType: peer.connectionType }),
    self: false
  };
}

// NetBird reports the local address with its prefix length (`100.64.0.10/16`);
// the address is what an operator connects to.
function addressesOf(...values) {
  return values.filter((value) => present(value) !== undefined).map((value) => value.split("/")[0]);
}

function present(value) {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function normalizeFqdn(fqdn) {
  return typeof fqdn === "string" ? fqdn.replace(/\.$/, "") : undefined;
}

function hostnameOf(fqdn) {
  return typeof fqdn === "string" ? fqdn.replace(/\.$/, "").split(".")[0] : undefined;
}

function toManagedResource(peer) {
  const locator = locatorFor(peer);
  return {
    id: locator.id,
    locator,
    fingerprint: fingerprintFor(locator, peer),
    hostname: peer.hostname,
    netbirdIps: peer.netbirdIps,
    online: peer.connected === true,
    ...(peer.self ? { self: true } : {})
  };
}

// The WireGuard public key is NetBird's stable provider-native identifier: it
// survives a peer being renamed in the dashboard.
function locatorFor(peer) {
  return {
    id: peer.id ?? peer.locator?.id ?? peer.publicKey ?? peer.fqdn,
    fqdn: peer.fqdn ?? peer.locator?.fqdn,
    hostname: peer.hostname ?? peer.locator?.hostname
  };
}

function locatorKey(locator) {
  return `${locator.id ?? ""}/${locator.fqdn ?? ""}`;
}

function fingerprintFor(locator, peer) {
  return createHash("sha256")
    .update(JSON.stringify({
      locator,
      peer: {
        fqdn: peer.fqdn,
        netbirdIps: peer.netbirdIps ?? [],
        online: peer.connected === true || peer.online === true,
        connectionType: peer.connectionType
      }
    }))
    .digest("hex");
}

async function isUnitActive(run) {
  try {
    const result = await run({
      binary: "/bin/bash",
      args: ["-c", `systemctl is-active ${NETBIRD_UNIT} || true`],
      timeoutMs: 20_000
    });
    return String(result?.stdout ?? "").trim().split("\n").pop() === "active";
  } catch {
    return false;
  }
}

function describeEnrollmentFailure(status) {
  if (status.daemonStatus === "NeedsLogin" || status.daemonStatus === "LoginFailed") {
    return "NetBird is installed but not enrolled: the setup key was rejected, already used, or expired. Store a fresh key with 'nomina secret change' and run this command again.";
  }
  if (status.daemonStatus === "SessionExpired") {
    return "NetBird is installed but its session has expired. Store a fresh setup key with 'nomina secret change' and run this command again.";
  }
  if (status.daemonStatus === "Idle" || status.daemonStatus === "Disconnected") {
    return "NetBird is installed but the tunnel is down. Start it with 'netbird up' in the managed LXC and run this command again.";
  }
  if (status.daemonStatus === CONNECTED && status.management?.connected === false) {
    const detail = status.management?.error ? `: ${status.management.error}` : ".";
    const url = status.management?.url === undefined ? "its management server" : status.management.url;
    return `NetBird cannot reach ${url}${detail} Check the LXC's network and DNS, then run this command again.`;
  }
  return `NetBird has not finished enrolling (daemon status: ${status.daemonStatus ?? "unknown"}).`;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function describeTunRemediation(vmid) {
  return describeVpnTunRemediation(vmid, CLIENT);
}

export { SETUP_KEY_PATH };
