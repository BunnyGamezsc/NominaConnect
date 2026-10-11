import { isIP } from "node:net";
import { createDockerAdapter } from "./docker-adapter.js";
import { dockerEndpointId, usableAddress } from "./docker-discovery.js";
import { promptExposureOptions } from "./tui.js";
import { getPlatformProvider } from "./providers.js";

const MANUAL = "__manual__";
const CANCEL = "__cancel__";
const NO_BINDINGS = "No Docker host bindings. Run nomina docker create or nomina docker connect, then publish again; you can also continue with Manual entry.";

/** Select a value through the shared prompt adapter, never interpreting cancellation as a default. */
async function select(prompts, message, options, initialValue = undefined) {
  if (!prompts?.select) throw new Error(`${message} requires an explicit scripted selection. Use --docker-binding, --docker-application and --docker-endpoint, or Manual entry.`);
  const value = await prompts.select({ message, options, initialValue });
  if (value === undefined || !options.some((option) => option.value === value)) throw new Error("Exposure selection cancelled.");
  return value;
}

/** Generate a valid application-derived DNS label, capped after adding endpoint/collision suffixes. */
function label(value, suffix = "") {
  const base = String(value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "docker-app";
  return `${base.slice(0, 63 - suffix.length).replace(/-+$/, "")}${suffix}`;
}

/** Suggest a distinct hostname for multiple endpoints and existing exposures without changing any inventory. */
export function suggestDockerExposure(project, candidate, candidates) {
  const endpoints = new Set(candidates.filter((entry) => entry.application === candidate.application && entry.hostPort !== undefined).map((entry) => entry.endpointId ?? dockerEndpointId(entry)));
  const samePort = candidates.filter((entry) => entry.application === candidate.application && entry.hostPort === candidate.hostPort);
  const suffix = endpoints.size > 1 ? `-${candidate.hostPort}${samePort.length > 1 ? `-${(candidate.endpointId ?? dockerEndpointId(candidate)).slice(0, 6)}` : ""}` : "";
  const names = new Set(project.config.managedInventory.services.map((service) => service.exposure?.hostname?.toLowerCase()));
  let hostname = `${label(candidate.application, suffix)}.${project.config.baseLocalDomain}`;
  for (let count = 2; names.has(hostname.toLowerCase()); count += 1) hostname = `${label(candidate.application, `${suffix}-${count}`)}.${project.config.baseLocalDomain}`;
  const hint = candidate.connectionHint;
  return {
    name: candidate.application, hostname, backendIp: candidate.backendAddress, backendPort: candidate.hostPort,
    ...(hint?.protocol && hint.protocol !== "unknown" ? { protocol: hint.protocol, backendTls: hint.backendTls } : {})
  };
}

/** Format a bounded endpoint label with instance, status, effective mapping and availability explanation. */
function endpointChoice(candidate) {
  const tuple = candidate.hostPort === undefined ? "no published port" : `${candidate.bindAddress}:${candidate.hostPort} -> ${candidate.containerPort}/${candidate.transport}`;
  return {
    value: candidate.endpointId ?? dockerEndpointId(candidate),
    label: `${candidate.name} [${candidate.containerId.slice(0, 12)}] ${candidate.status}: ${tuple}`,
    hint: candidate.selectable ? `Proposed backend ${candidate.backendAddress}:${candidate.hostPort}; reachability not yet verified` : candidate.reasons.join(" ")
  };
}

/** Collect a Docker source and editable exposure through the existing HTTPS/TCP/SMB prompts, without writes. */
export async function prepareDockerExposure(project, options, adapters) {
  const prompts = options.yes || options.reviewOnly ? undefined : adapters.prompts;
  const { source: _source, dockerBinding: _binding, dockerApplication: _application, dockerEndpoint: _endpoint, ...manualOptions } = options;
  let source = options.source ?? (options.dockerBinding || options.dockerApplication || options.dockerEndpoint ? "docker" : undefined);
  if (source === undefined && prompts?.select && ![options.name, options.hostname, options.backendIp, options.redirectTo].some((value) => value !== undefined)) {
    source = await select(prompts, "Exposure source", [{ value: "manual", label: "Manual entry" }, { value: "docker", label: "From Docker", hint: "select and review a published endpoint" }]);
  }
  source ??= "manual";
  if (!["manual", "docker"].includes(source)) throw new Error("Exposure source must be manual or docker.");
  if (source === "manual") {
    if (options.dockerBinding || options.dockerApplication || options.dockerEndpoint || options.reviewOnly) throw new Error("Docker selection/review options require --source docker.");
    return { options: await promptExposureOptions(project, options, prompts) };
  }
  if (options.redirectTo !== undefined || options.redirectCode !== undefined) throw new Error("Docker endpoints need a backend; use Manual entry for URL redirects.");
  const hosts = project.config.managedInventory.dockerHosts ?? [];
  if (!hosts.length) {
    prompts?.info?.(NO_BINDINGS);
    if (!prompts?.select) throw new Error(NO_BINDINGS);
    const next = await select(prompts, "Create/connect a Docker LXC or continue manually", [{ value: MANUAL, label: "Continue with Manual entry" }, { value: CANCEL, label: "Cancel to create/connect a Docker LXC" }]);
    return next === MANUAL ? { options: await promptExposureOptions(project, manualOptions, prompts) } : { cancelled: true, stdout: `${NO_BINDINGS}\nExposure publication cancelled.\n` };
  }
  const bindingName = options.dockerBinding ?? await select(prompts, "Docker host binding", hosts.map((host) => ({ value: host.name, label: host.name, hint: project.state.dockerHostStates?.[host.id]?.status ?? "unknown" })));
  const binding = hosts.find((host) => host.name === bindingName);
  if (!binding) throw new Error(`Docker host binding ${bindingName} was not found. Create/connect a binding or use Manual entry.`);
  const reference = project.state.providerReferences[binding.id];
  if (!reference?.vmid || reference.node !== project.config.proxmox.node) throw new Error("Docker binding has no matching node/VMID reference. Reconnect it or use Manual entry.");
  await adapters.proxmox?.assertLocalNode?.(reference.node);
  const docker = adapters.docker ?? createDockerAdapter(adapters.proxmox, adapters.retryOptions);
  const discovery = await docker.discover(reference.vmid, binding.socketPath);
  if (discovery.truncated) prompts?.warn?.("Discovery is truncated or incomplete. Only observed endpoints are available; inspect again or use Manual entry.");
  for (const diagnostic of discovery.diagnostics ?? []) prompts?.warn?.(diagnostic);
  const candidates = discovery.candidates.map((candidate) => ({ ...candidate, endpointId: candidate.endpointId ?? dockerEndpointId(candidate) }));
  const applications = [...new Set(candidates.map((candidate) => candidate.application))];
  let application = options.dockerApplication;
  if (!application) {
    application = await select(prompts, "Docker application", [...applications.map((app) => {
      const containers = discovery.containers.filter((container) => container.application === app);
      return { value: app, label: app, hint: `${containers.some((container) => container.compose?.["com.docker.compose.project"]) ? "Compose service" : "Standalone container"}; ${containers.length} instance(s)` };
    }), { value: MANUAL, label: "Manual entry" }, { value: CANCEL, label: "Cancel" }]);
  }
  if (application === CANCEL) return { cancelled: true, stdout: "Exposure publication cancelled.\n" };
  if (application === MANUAL) return { options: await promptExposureOptions(project, manualOptions, prompts) };
  if (!applications.includes(application)) throw new Error("Docker application disappeared or was not found. Refresh discovery and selection; no exposure was published.");
  const endpoints = candidates.filter((candidate) => candidate.application === application);
  const endpoint = options.dockerEndpoint ?? await select(prompts, "Published Docker endpoint", endpoints.map(endpointChoice));
  const candidate = endpoints.find((entry) => entry.endpointId === endpoint);
  if (!candidate) throw new Error("Docker endpoint disappeared, was recreated or changed. Refresh discovery, selection and review; no exposure was published.");
  if (!candidate.selectable) {
    const reason = `${candidate.reasons.join(" ")} Docker networking will not be changed.`;
    prompts?.info?.(reason);
    if (!prompts?.select) throw new Error(reason);
    const next = await select(prompts, "Endpoint unavailable", [{ value: MANUAL, label: "Continue with Manual entry", hint: "explicitly enter a reachable backend" }, { value: CANCEL, label: "Cancel and refresh selection" }]);
    return next === MANUAL ? { options: await promptExposureOptions(project, manualOptions, prompts) } : { cancelled: true, stdout: `Exposure publication cancelled. ${reason}\n` };
  }
  const defaults = suggestDockerExposure(project, candidate, candidates);
  prompts?.info?.(`${endpointChoice(candidate).label}\n${candidate.connectionHint?.evidence ?? "Application protocol unknown. Choose the connection type explicitly."}\nClient-facing web access uses HTTPS; backend HTTP/HTTPS is chosen separately. Every proposed field is editable.`);
  const existing = project.config.managedInventory.services.filter((service) => service.exposure?.backend?.ip === candidate.backendAddress && Number(service.exposure?.backend?.port) === candidate.hostPort);
  const advisory = existing.length ? `Existing exposure(s) for this backend: ${existing.map((service) => service.exposure.hostname).join(", ")}. This is advisory; you can publish an additional, distinct hostname.\n` : "";
  if (advisory) prompts?.info?.(advisory);
  if (!prompts && !options.protocol && !defaults.protocol) throw new Error("Unknown Docker application protocol. Select --protocol https, tcp or smb explicitly; TCP transport alone does not identify HTTP, SSH or SMB.");
  const resolved = await promptExposureOptions(project, options, prompts, defaults);
  return { options: resolved, selection: { binding, reference, candidate }, docker, discovery, advisory };
}

/** Reject invalid or already-managed names before a Docker-created exposure can reach provider mutations. */
export function validateDockerExposure(project, options) {
  const hostname = options.hostname;
  if (typeof hostname !== "string" || hostname.length > 253 || !hostname.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))) throw new Error("Invalid exposure hostname. Use valid DNS labels of at most 63 characters.");
  if (project.config.managedInventory.services.some((service) => service.exposure?.hostname?.toLowerCase() === hostname.toLowerCase())) throw new Error(`Exposure ${hostname} already exists. Choose an additional hostname; Docker selection never overwrites an existing exposure. Use Edit an exposure to update it.`);
  if (!usableAddress(options.backendIp)) throw new Error("Backend address is wildcard, loopback, multicast, link-local or unsupported. Enter an explicit reachable address or use Manual entry.");
}

/** Reinspect the exact selected identity/mapping and verify the reviewed backend from the forwarding LXC, never retargeting overrides. */
export async function verifyDockerExposure(selection, docker, options, project, adapters) {
  const fresh = await docker.discover(selection.reference.vmid, selection.binding.socketPath);
  if (!fresh.candidates.some((candidate) => candidate.selectable && dockerEndpointId(candidate) === dockerEndpointId(selection.candidate))) throw new Error("Selected Docker endpoint disappeared, was recreated or changed. Refresh selection and review before publication. Explicit backend overrides were not retargeted.");
  const proxy = project.config.managedInventory.platform.reverseProxy;
  const reference = project.state.providerReferences[proxy?.id];
  if (!Number.isInteger(reference?.vmid) || !adapters.proxmox?.pctExec) throw new Error("Backend reachability from the proxy LXC is unavailable. Provision/record the proxy LXC and retry; no exposure was published.");
  // Values are independently validated and passed as argv, never interpolated.
  if (!isIP(options.backendIp) || !Number.isInteger(options.backendPort) || options.backendPort < 1 || options.backendPort > 65535) throw new Error("Invalid reviewed backend address or port.");
  try {
    await adapters.proxmox.pctExec(reference.vmid, { binary: "/usr/bin/timeout", args: ["4", "/bin/bash", "-c", 'exec 3<>/dev/tcp/"$1"/"$2"', "nomina-backend-probe", options.backendIp, String(options.backendPort)], timeoutMs: 6000, maxOutputBytes: 1024 });
  } catch {
    throw new Error(`Backend ${options.backendIp}:${options.backendPort} is unreachable or cannot be verified from proxy LXC ${reference.vmid}. Correct the backend or networking explicitly; no exposure was published.`);
  }
  // DNS and existing proxy routes must be checked before TLS setup or publishing.
  const dns = project.config.managedInventory.platform.dns;
  const dnsRef = project.state.providerReferences[dns?.id];
  const dnsAdapter = adapters.providerAdapters?.technitium;
  if (!dnsRef?.ip || !dnsAdapter?.inspect) throw new Error("DNS conflict inspection is unavailable; no exposure was published.");
  const observedDns = await getPlatformProvider("technitium").inspect(dnsAdapter, dns, { providerReferences: [options.hostname], zone: project.config.baseLocalDomain, ip: dnsRef.ip, endpoint: `http://${dnsRef.ip}:5380`, connectionSecretReference: project.config.connectionSecretReferences[dns.id] });
  if ([...observedDns.managed, ...observedDns.unmanaged].some((record) => record.id?.toLowerCase() === options.hostname.toLowerCase())) throw new Error(`DNS hostname ${options.hostname} already has records. Choose a distinct hostname; no exposure was published.`);
  if (options.protocol === "https") {
    const proxyAdapter = adapters.providerAdapters?.[proxy?.service];
    if (!proxyAdapter?.inspect) throw new Error("Proxy route conflict inspection is unavailable; no exposure was published.");
    const observed = await proxyAdapter.inspect({ vmid: reference.vmid, ip: reference.ip, endpoint: proxy.service === "caddy" ? `http://${reference.ip}:2019` : `http://${reference.ip}:8080`, connectionSecretReference: project.config.connectionSecretReferences[proxy.id] });
    const hostname = options.hostname.toLowerCase();
    if ((observed.resources ?? []).some((resource) => resource.id?.toLowerCase() === hostname
      || resource.match?.some((matcher) => (Array.isArray(matcher.host) ? matcher.host : [matcher.host]).some((host) => typeof host === "string" && host.toLowerCase() === hostname)))) throw new Error(`Proxy hostname ${options.hostname} already has a route. Choose a distinct hostname; no exposure was published.`);
  }
  return { vmid: reference.vmid, status: "reachable", application: "not-verified" };
}

/** Present the same final review in scripted output and guided confirmation, making backend overrides explicit. */
export function formatDockerExposureReview(options, selection) {
  const candidate = selection.candidate;
  const override = options.backendIp !== candidate.backendAddress || options.backendPort !== candidate.hostPort;
  const connection = options.preset === "smb" ? "SMB over TCP" : options.protocol === "tcp" ? "generic TCP" : "client HTTPS";
  return `Docker exposure review: ${selection.binding.name} / ${candidate.application} / ${candidate.endpointId ?? dockerEndpointId(candidate)}\nApplication evidence: ${candidate.connectionHint?.evidence ?? "Application protocol unknown; connection type must be selected explicitly."}\nDisplay name: ${options.name}\nHostname: ${options.hostname}\nConnection: ${connection}\nBackend: ${options.backendIp}:${options.backendPort}${override ? " (explicit override of discovered backend)" : " (effective published host port)"}\n${options.protocol === "tcp" ? `Listener port: ${options.listenerPort ?? options.backendPort}. Ordinary TCP selects by listener address and port, not hostname.\n` : `Backend TLS: ${options.backendTls === true ? "HTTPS" : "HTTP"}; separate from client-facing HTTPS.\n`}Tailscale access: ${options.tailnet === true ? "allowed" : "disabled/not configured"}\n${options.preset === "smb" ? `SMB uses client port 445. Shares, credentials and permissions remain on the server; configure its hostname alias for ${options.hostname}. Windows: \\\\${options.hostname}\\SHARE. macOS: smb://${options.hostname}/SHARE.\n` : ""}Only this exposure will be managed. Docker applications/networking stay independently managed; disconnecting the binding retains exposures.\n`;
}
