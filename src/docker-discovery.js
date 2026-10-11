import { isIP } from "node:net";
import { createHash } from "node:crypto";

/** Identify the exact observation reviewed by an operator, including current container identity and effective backend. */
export function dockerEndpointId(candidate) {
  return createHash("sha256").update(JSON.stringify([
    candidate.containerId, candidate.application, candidate.instance, candidate.status, candidate.networkMode,
    candidate.containerPort, candidate.bindAddress, candidate.hostPort, candidate.transport,
    candidate.backendAddress, candidate.selectable, candidate.reasons
  ])).digest("hex");
}

/** Offer protocol hints only for allowlisted image names and the image's documented application port. */
export function dockerConnectionHint(image, containerPort, transport) {
  const repository = image.toLowerCase().split("@")[0].replace(/:[^/]*$/, "").replace(/^(?:docker\.io\/)?library\//, "");
  const rules = [
    { images: ["nginx", "httpd", "caddy", "traefik"], port: 80, protocol: "https", backendTls: false },
    { images: ["nginx", "httpd", "caddy", "traefik"], port: 443, protocol: "https", backendTls: true },
    { images: ["dperson/samba", "ghcr.io/servercontainers/samba"], port: 445, protocol: "smb", backendTls: false },
    { images: ["lscr.io/linuxserver/openssh-server", "linuxserver/openssh-server"], port: 2222, protocol: "tcp", backendTls: false }
  ];
  const rule = transport === "tcp" ? rules.find((entry) => entry.images.includes(repository) && entry.port === containerPort) : undefined;
  return rule ? { protocol: rule.protocol, backendTls: rule.backendTls, evidence: `Allowlisted image ${repository}, application port ${containerPort}/tcp. Verify the application's configuration; this is an editable hint.` }
    : { protocol: "unknown", evidence: "Published TCP/UDP transport and port numbers do not identify the application protocol. Choose the connection type." };
}

export const DOCKER_LIMITS = Object.freeze({ containers: 100, endpoints: 500, fieldLength: 256, outputBytes: 65536, durationMs: 60000 });
export const COMPOSE_LABELS = Object.freeze([
  "com.docker.compose.project", "com.docker.compose.service",
  "com.docker.compose.container-number", "com.docker.compose.oneoff"
]);

/** Strip terminal control characters and cap observation fields before returning them to the caller. */
function bounded(value, max = Number(DOCKER_LIMITS.fieldLength)) {
  return String(value ?? "").replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, max);
}

/** Check whether a valid IP can represent a backend, excluding wildcard, loopback, link-local and IPv6 multicast addresses. */
export function usableAddress(address) {
  if (!isIP(address ?? "")) return false;
  if (isIP(address) === 6) {
    try { address = new URL(`http://[${address}]`).hostname.slice(1, -1); }
    catch { return false; } // Scoped IPv6 addresses need explicit manual correction.
  }
  // IPv4-mapped IPv6 needs an explicit ordinary address for current adapters.
  if (address.toLowerCase().startsWith("::ffff:")) return false;
  if (isIP(address) === 4 && (Number(address.split(".")[0]) === 0 || Number(address.split(".")[0]) >= 224)) return false;
  const lower = address.toLowerCase();
  return !["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::1", "0:0:0:0:0:0:0:1"].includes(lower)
    && !/^127\./.test(lower) && !/^169\.254\./.test(lower)
    && !/^(fe[89ab]|ff)/.test(lower) && !/^::ffff:127\./.test(lower);
}

// Only a projected inspect result enters this function. No environment, mounts,
// credentials, or arbitrary labels are returned to the caller or persisted.
/** Convert projected observations into bounded containers and endpoint candidates. Return only allowlisted metadata and explicit selection rejection reasons. */
export function normalizeDockerDiscovery(observations, hostAddress, limits = DOCKER_LIMITS) {
  const containers = [];
  const candidates = [];
  let truncated = observations.length > limits.containers;
  for (const observed of observations.slice(0, limits.containers)) {
    if (!/^[a-f0-9]{64}$/.test(observed.id ?? "")) continue;
    const compose = {};
    for (const label of COMPOSE_LABELS) {
      if (observed.labels?.[label] !== undefined && observed.labels[label] !== null) compose[label] = bounded(observed.labels[label]);
    }
    const name = bounded(observed.name).replace(/^\//, "");
    const status = bounded(observed.status, 32);
    const networkMode = bounded(observed.networkMode);
    const application = compose[COMPOSE_LABELS[0]] && compose[COMPOSE_LABELS[1]]
      ? `${compose[COMPOSE_LABELS[0]]}/${compose[COMPOSE_LABELS[1]]}` : name;
    const container = {
      containerId: observed.id, name, application, image: bounded(observed.image), imageId: bounded(observed.imageId),
      compose, instance: compose[COMPOSE_LABELS[2]] ? `${compose[COMPOSE_LABELS[2]]}:${observed.id}` : observed.id,
      status, networkMode,
      exposedPorts: Object.keys(observed.exposedPorts ?? {}).filter((port) => /^\d{1,5}\/(tcp|udp|sctp)$/.test(port)).slice(0, 100)
    };
    if (Object.keys(observed.exposedPorts ?? {}).length > 100 || [observed.name, observed.image, observed.imageId, ...COMPOSE_LABELS.map((label) => observed.labels?.[label])].some((value) => String(value ?? "").length > limits.fieldLength)) truncated = true;
    containers.push(container);
    const commonReasons = [];
    if (status !== "running") commonReasons.push(`Container is ${status || "not running"}; no active backend is verified.`);
    if (networkMode === "host") commonReasons.push("Host networking has no supported published-port mapping. Use manual entry.");
    if (["macvlan", "ipvlan"].includes(observed.networkDriver) || observed.directRouting === true) commonReasons.push("Directly addressed Docker networks require manual entry.");
    if (observed.networkUnknown === true) commonReasons.push("Docker network reachability could not be inspected. Use manual entry.");
    let bindingCount = 0;
    const seenBindings = new Set();
    for (const [portKey, bindings] of Object.entries(observed.ports ?? {})) {
      const match = portKey.match(/^(\d{1,5})\/(tcp|udp|sctp)$/);
      if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535 || !Array.isArray(bindings)) continue;
      for (const binding of bindings) {
        const tuple = JSON.stringify([portKey, bounded(binding.HostIp, 64), Number(binding.HostPort)]);
        if (seenBindings.has(tuple)) continue;
        seenBindings.add(tuple);
        bindingCount += 1;
        if (candidates.length >= limits.endpoints) { truncated = true; continue; }
        const hostPort = Number(binding.HostPort);
        const bindAddress = bounded(binding.HostIp, 64);
        const transport = match[2];
        const reasons = [...commonReasons];
        let backendAddress;
        if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) reasons.push("No effective published host port.");
        if (transport !== "tcp") reasons.push(`${transport.toUpperCase()} transport is outside supported exposure scope. Use manual entry.`);
        if (["0.0.0.0", "::"].includes(bindAddress)) {
          if (usableAddress(hostAddress) && isIP(hostAddress) === isIP(bindAddress)) backendAddress = hostAddress;
          else reasons.push("Wildcard binding has no verified LXC address in this address family. Use manual entry.");
        } else if (usableAddress(bindAddress)) backendAddress = bindAddress;
        else reasons.push("Loopback, unspecified, or invalid bind address is not a reachable backend. Use manual entry.");
        const connectionHint = dockerConnectionHint(container.image, Number(match[1]), transport);
        candidates.push({
          containerId: observed.id, application, name, instance: container.instance,
          status, networkMode, containerPort: Number(match[1]), bindAddress,
          hostPort: Number.isInteger(hostPort) && hostPort > 0 && hostPort <= 65535 ? hostPort : undefined,
          transport, backendAddress, selectable: reasons.length === 0, reasons,
          connectionTypeHint: connectionHint.protocol, connectionHint,
          suggestedHostnameLabel: name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "") || "docker-app"
        });
      }
    }
    if (bindingCount === 0) {
      if (candidates.length < limits.endpoints) candidates.push({
        containerId: observed.id, application, name, instance: container.instance, status, networkMode,
        selectable: false, reasons: [...commonReasons, "No public port binding. EXPOSE metadata does not publish a port; use manual entry."]
      });
      else truncated = true;
    }
  }
  return { containers, candidates: candidates.map((candidate) => ({ ...candidate, endpointId: dockerEndpointId(candidate) })), truncated };
}
