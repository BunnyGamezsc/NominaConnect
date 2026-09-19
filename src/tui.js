import * as clack from "@clack/prompts";
import { INITIAL_PLATFORM_CATALOG } from "./catalog.js";
import { canShowCaTrustGuide } from "./ca-guide.js";
import { findProjectDirectory, loadProject } from "./config.js";
import { TECHNITIUM_DEPLOYMENT, CADDY_DEPLOYMENT, TRAEFIK_DEPLOYMENT, STEP_CA_DEPLOYMENT, TAILSCALE_DEPLOYMENT, NETBIRD_DEPLOYMENT, defaultGatewayFor } from "./provisioning.js";
import { formatPendingNotices } from "./tracking.js";

// The managed Technitium resolver a service LXC will default its nameserver
// to once DNS is provisioned (mirrors resolveServiceDeployment). Shown in
// setup summaries so the operator sees the effective default, not the
// gateway fallback.
function managedTechnitiumIp(project) {
  return project?.state?.providerReferences?.[project?.config?.managedInventory?.platform?.dns?.id]?.ip;
}

export function getProjectContext(filesystem, cwd = ".") {
  const projectDirectory = findProjectDirectory(filesystem, cwd);
  if (projectDirectory === undefined) {
    return { projectDirectory: undefined, project: undefined };
  }
  try {
    return { projectDirectory, project: loadProject(filesystem, projectDirectory) };
  } catch {
    return { projectDirectory, project: undefined };
  }
}

export function canProvisionTechnitium(project) {
  const dnsService = project?.config.managedInventory.platform.dns;
  if (dnsService?.service !== "technitium") {
    return false;
  }
  return project.state.providerReferences[dnsService.id] === undefined;
}

export function canProvisionReverseProxy(project, serviceName) {
  const dnsService = project?.config.managedInventory.platform.dns;
  const proxyService = project?.config.managedInventory.platform.reverseProxy;
  if (proxyService?.service !== serviceName) {
    return false;
  }
  if (project.state.providerReferences[dnsService?.id] === undefined) {
    return false;
  }
  return project.state.providerReferences[proxyService.id] === undefined;
}



export function canProvisionCertificateAuthority(project, serviceName) {
  const dnsService = project?.config.managedInventory.platform.dns;
  const proxyService = project?.config.managedInventory.platform.reverseProxy;
  const caService = project?.config.managedInventory.platform.certificateAuthority;
  if (caService?.service !== serviceName) {
    return false;
  }
  if (project.state.providerReferences[dnsService?.id] === undefined) {
    return false;
  }
  if (project.state.providerReferences[proxyService?.id] === undefined) {
    return false;
  }
  return project.state.providerReferences[caService.id] === undefined;
}



export function canProvisionVpn(project, serviceName) {
  const vpnService = project?.config.managedInventory.platform.vpn;
  if (vpnService?.service !== serviceName) {
    return false;
  }
  return project.state.providerReferences[vpnService.id] === undefined;
}



export function canUpdateConnectionSecret(project) {
  if (!project?.config?.connectionSecretReferences || !project?.state?.providerReferences) {
    return false;
  }
  const hasSecret = Object.keys(project.config.connectionSecretReferences).length > 0;
  const hasProvisioned = Object.keys(project.state.providerReferences).length > 0;
  return hasSecret && hasProvisioned;
}

export function canRecheckProvisioning(project) {
  if (!project?.config?.connectionSecretReferences || !project?.state) {
    return false;
  }
  for (const item of Object.values(project.config.managedInventory.platform ?? {})) {
    if (item && project.config.connectionSecretReferences[item.id] !== undefined && project.state.providerReferences?.[item.id] === undefined) {
      return true;
    }
  }
  return false;
}

export function canPublishExposure(project) {
  const dnsService = project?.config.managedInventory.platform.dns;
  const proxyService = project?.config.managedInventory.platform.reverseProxy;
  const caService = project?.config.managedInventory.platform.certificateAuthority;
  const caProvisioned = caService === null || caService === undefined
    || project.state.providerReferences[caService.id] !== undefined;

  return dnsService?.service === "technitium"
    && (proxyService?.service === "caddy" || proxyService?.service === "traefik")
    && project.state.providerReferences[dnsService.id] !== undefined
    && project.state.providerReferences[proxyService.id] !== undefined
    && caProvisioned;
}

export function hasExposures(project) {
  return (project?.config.managedInventory.services ?? []).some((s) => s.exposure?.hostname !== undefined);
}

export function canEditExposure(project) {
  return canPublishExposure(project) && hasExposures(project);
}

export function canRemoveExposure(project) {
  return hasExposures(project);
}

export function canToggleHttpRedirect(project) {
  const proxy = project?.config?.managedInventory?.platform?.reverseProxy;
  if (proxy?.service !== "caddy") {
    return false;
  }
  return project?.state?.providerReferences?.[proxy.id] !== undefined;
}

export function hasProvisionedServices(project) {
  if (!project?.state?.providerReferences) return false;
  return Object.keys(project.state.providerReferences).length > 0;
}

export function hasProvisionedOrRetainedServices(project) {
  if (!project?.state) return false;
  const activeCount = Object.keys(project.state.providerReferences ?? {}).length;
  const retainedCount = Object.keys(project.state.retainedServices ?? {}).length;
  return activeCount > 0 || retainedCount > 0;
}

// One row per menu entry, in display order. `when` decides whether the entry
// is offered for the loaded project; `label` may be a function when the entry
// renames itself with state.
const MENU_ENTRIES = Object.freeze([
  { value: "provision-technitium", label: "Provision Technitium DNS", hint: "create the DNS LXC", when: canProvisionTechnitium },
  { value: "provision-caddy", label: "Provision Caddy reverse proxy", hint: "create the proxy LXC", when: (project) => canProvisionReverseProxy(project, "caddy") },
  { value: "provision-traefik", label: "Provision Traefik reverse proxy", hint: "create the proxy LXC", when: (project) => canProvisionReverseProxy(project, "traefik") },
  { value: "provision-step-ca", label: "Provision step-ca certificate authority", hint: "create the step-ca LXC", when: (project) => canProvisionCertificateAuthority(project, "step-ca") },
  { value: "provision-caddy-internal-ca", label: "Configure Caddy Internal CA", hint: "configure internal certificates in Caddy", when: (project) => canProvisionCertificateAuthority(project, "caddy-internal-ca") },
  { value: "provision-tailscale", label: "Provision Tailscale VPN", hint: "create the Tailscale LXC", when: (project) => canProvisionVpn(project, "tailscale") },
  { value: "provision-netbird", label: "Provision NetBird VPN", hint: "create the NetBird LXC", when: (project) => canProvisionVpn(project, "netbird") },
  { value: "publish-exposure", label: "Publish a web exposure", hint: "connect DNS and HTTPS routing", when: canPublishExposure },
  { value: "edit-exposure", label: "Edit an exposure", hint: "update backend IP or port", when: canEditExposure },
  { value: "remove-exposure", label: "Remove an exposure", hint: "disconnect DNS and HTTPS routing", when: canRemoveExposure },
  { value: "change-domain", label: "Change the local domain", hint: "migrate exposures to a new TLD", when: hasExposures },
  {
    value: "toggle-http-redirect",
    label: (project) => project.config.managedInventory.platform.reverseProxy.httpRedirect === true
      ? "Turn OFF HTTP→HTTPS auto-redirect"
      : "Turn ON HTTP→HTTPS auto-redirect",
    hint: "redirect plain :80 hits to HTTPS (308)",
    when: canToggleHttpRedirect
  },
  { value: "view-ca-guide", label: "View step-ca trust guide", hint: "install CA root on devices", when: canShowCaTrustGuide },
  { value: "export-ca-cert", label: "Export step-ca root certificate", hint: "save cert + scp/install steps", when: canShowCaTrustGuide },
  { value: "upgrade-service", label: "Upgrade a managed service", hint: "explicit service upgrade with snapshot", when: hasProvisionedServices },
  { value: "remove-service", label: "Remove a managed service", hint: "disconnect integrations and retain data", when: hasProvisionedServices },
  { value: "destroy-service", label: "Destroy a service LXC", hint: "permanently delete LXC container and data", when: hasProvisionedOrRetainedServices },
  { value: "update-secret", label: "Update connection secret", hint: "change stored provider password", when: canUpdateConnectionSecret },
  { value: "recheck-service", label: "Recheck provisioning", hint: "adopt existing LXC if healthy", when: canRecheckProvisioning },
  {
    value: "view-changes",
    label: "View changes",
    hint: (project) => `${pendingNoticeCount(project)} pending change(s)`,
    when: (project) => pendingNoticeCount(project) > 0
  },
  { value: "nuclear-uninstall", label: "Nuclear uninstall", hint: "destroy ALL managed LXC(s), config, and secrets", when: () => true }
]);

function pendingNoticeCount(project) {
  return (project.state?.tracking?.notices ?? []).length;
}

function resolve(field, project) {
  return typeof field === "function" ? field(project) : field;
}

export function buildMenuOptions(project) {
  const options = project === undefined
    ? []
    : MENU_ENTRIES.filter((entry) => entry.when(project)).map((entry) => ({
        value: entry.value,
        label: resolve(entry.label, project),
        hint: resolve(entry.hint, project)
      }));
  options.push({ value: "init", label: "Initialize a new project", hint: "first-time setup" });
  options.push({ value: "exit", label: "Exit", hint: "leave NominaConnect" });
  return options;
}

export async function runInteractiveApp(adapters) {
  clack.intro("NominaConnect");

  const { projectDirectory, project } = getProjectContext(adapters.filesystem, adapters.cwd ?? ".");
  const options = buildMenuOptions(project);
  const menuMessage = projectDirectory === undefined
    ? "No project found here yet. What would you like to do?"
    : project === undefined
      ? "Project files look incomplete. What would you like to do?"
      : "What would you like to do?";

  if (projectDirectory !== undefined && project !== undefined) {
    clack.log.info(`Using project at ${projectDirectory}`);
    const pendingNotices = project.state?.tracking?.notices ?? [];
    if (pendingNotices.length > 0) {
      const noticeSummary = formatPendingNotices(pendingNotices);
      if (noticeSummary) {
        clack.log.info(`Pending changes from background tracking:\n${noticeSummary}`);
      }
    }
  }

  const action = adapters.interactive?.chooseAction
    ? await adapters.interactive.chooseAction({ projectDirectory, project, options })
    : await clack.select({ message: menuMessage, options });

  if (clack.isCancel(action)) {
    clack.cancel("Cancelled.");
    return { stdout: "", cancelled: true };
  }

  if (action === "exit") {
    clack.outro("Goodbye.");
    return { stdout: "", cancelled: true };
  }
  if (action === "view-changes") {
    const result = await adapters.runCommand(["changes"], adapters);
    if (result.stdout) {
      clack.log.info(result.stdout.trim());
    }
    clack.outro("Changes displayed.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "nuclear-uninstall") {
    const result = await adapters.runCommand(["uninstall"], adapters);
    clack.outro(result.cancelled ? "Nuclear uninstall cancelled." : "Nuclear uninstall complete.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "init") {
    const result = await adapters.runCommand(["init"], adapters);
    clack.outro("Project initialized.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "provision-technitium") {
    const result = await adapters.runCommand(["service", "add", "technitium"], adapters);
    clack.outro("Technitium provisioning complete.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "provision-caddy") {
    const result = await adapters.runCommand(["service", "add", "caddy"], adapters);
    clack.outro("Caddy provisioning complete.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "provision-traefik") {
    const result = await adapters.runCommand(["service", "add", "traefik"], adapters);
    clack.outro("Traefik provisioning complete.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "provision-step-ca") {
    const result = await adapters.runCommand(["service", "add", "step-ca"], adapters);
    clack.outro("step-ca provisioning complete.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "provision-caddy-internal-ca") {
    const result = await adapters.runCommand(["service", "add", "caddy-internal-ca"], adapters);
    clack.outro("Caddy Internal CA configuration complete.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "provision-tailscale") {
    const result = await adapters.runCommand(["service", "add", "tailscale"], adapters);
    clack.outro("Tailscale provisioning complete.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "provision-netbird") {
    const result = await adapters.runCommand(["service", "add", "netbird"], adapters);
    clack.outro("NetBird provisioning complete.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "publish-exposure") {
    const result = await adapters.runCommand(["exposure", "publish"], adapters);
    clack.outro("Exposure published.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "edit-exposure") {
    const serviceName = await promptExposureServiceName(project, adapters.prompts);
    const projectForEdit = loadProject(adapters.filesystem, projectDirectory);
    const svc = (projectForEdit.config.managedInventory.services ?? []).find(
      (s) => s.name === serviceName || s.exposure?.hostname === serviceName || s.id === serviceName
    );
    if (!svc?.exposure) {
      throw new Error(`Exposure ${serviceName} not found.`);
    }
    // The edit wizard can convert between backend and redirect exposures, so
    // ask for the desired type first and default every later prompt from the
    // stored values of that type (which may not exist yet after a conversion).
    let wantRedirect = svc.exposure.redirect !== undefined;
    if (adapters.prompts !== undefined) {
      wantRedirect = await confirmPrompt(
        adapters.prompts,
        "Is this a redirect to another URL? (no backend, e.g. apex bunny.internal -> home.bunny.internal)",
        wantRedirect
      );
    }
    if (wantRedirect) {
      let target = svc.exposure.redirect?.to ?? `home.${projectForEdit.config.baseLocalDomain}`;
      let code = svc.exposure.redirect?.code ?? 308;
      if (adapters.prompts?.ask) {
        const answer = await adapters.prompts.ask("Redirect target", target);
        if (answer && answer.trim() !== "") {
          target = answer.trim();
        }
      }
      if (adapters.prompts !== undefined) {
        code = await promptRedirectCode(adapters.prompts, code);
      }
      const result = await adapters.runCommand(
        ["exposure", "publish", "--name", svc.name, "--hostname", svc.exposure.hostname,
          "--redirect-to", target, "--redirect-code", String(code)],
        adapters
      );
      clack.outro("Exposure updated.");
      if (adapters.tracking) {
        adapters.tracking.run(adapters);
      }
      return result;
    }
    let backendIp = svc.exposure.backend?.ip ?? "";
    let backendPortRaw = svc.exposure.backend?.port !== undefined ? String(svc.exposure.backend.port) : "";
    if (adapters.prompts?.ask) {
      const answerIp = await adapters.prompts.ask("Backend IP", backendIp || undefined);
      if (answerIp && answerIp.trim() !== "") {
        const err = validateIp(answerIp);
        if (err) throw new Error(err);
        backendIp = answerIp.trim();
      }
      const answerPort = await adapters.prompts.ask("Backend port", backendPortRaw || undefined);
      if (answerPort && answerPort.trim() !== "") {
        backendPortRaw = answerPort.trim();
      }
    }
    const backendPort = Number(backendPortRaw);
    if (!Number.isInteger(backendPort) || backendPort <= 0) {
      throw new Error(`Invalid backend port: ${backendPortRaw}.`);
    }
    // Ask with the stored value as default so edits can flip the TLS setting.
    let backendTls = svc.exposure.backend?.tls === true;
    if (adapters.prompts !== undefined) {
      backendTls = await confirmPrompt(
        adapters.prompts,
        "Does the backend serve HTTPS/TLS itself? (e.g. Proxmox :8006, OPNsense)",
        backendTls
      );
    }
    const publishArgs = ["exposure", "publish", "--name", svc.name, "--hostname", svc.exposure.hostname, "--backend-ip", backendIp, "--backend-port", String(backendPort)];
    if (backendTls) {
      publishArgs.push("--backend-tls");
    }
    const result = await adapters.runCommand(publishArgs, adapters);
    clack.outro("Exposure updated.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "remove-exposure") {
    const serviceName = await promptExposureServiceName(project, adapters.prompts);
    const result = await adapters.runCommand(["service", "remove", serviceName], adapters);
    clack.outro("Exposure removed.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "view-ca-guide") {
    const result = await adapters.runCommand(["ca", "guide"], adapters);
    if (result.stdout) {
      clack.log.info(result.stdout.trim());
    }
    clack.outro("Trust guide displayed.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "change-domain") {
    const result = await adapters.runCommand(["domain", "change"], adapters);
    clack.outro("Local domain changed. Exposures migrated.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "toggle-http-redirect") {
    const currentlyEnabled = project?.config?.managedInventory?.platform?.reverseProxy?.httpRedirect === true;
    const result = await adapters.runCommand(
      ["caddy", "redirect", currentlyEnabled ? "off" : "on"],
      adapters
    );
    clack.outro(currentlyEnabled ? "HTTP→HTTPS auto-redirect disabled." : "HTTP→HTTPS auto-redirect enabled.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "export-ca-cert") {
    const result = await adapters.runCommand(["ca", "export"], adapters);
    if (result.stdout) {
      clack.log.info(result.stdout.trim());
    }
    clack.outro("Certificate exported. Follow the steps above to trust it on your devices.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "upgrade-service") {
    const result = await adapters.runCommand(["service", "upgrade"], adapters);
    clack.outro("Service upgrade complete.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "remove-service") {
    const result = await adapters.runCommand(["service", "remove"], adapters);
    clack.outro("Service removal complete.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "destroy-service") {
    const result = await adapters.runCommand(["service", "destroy"], adapters);
    clack.outro("Service destruction complete.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "update-secret") {
    const result = await adapters.runCommand(["secret", "change"], adapters);
    clack.outro("Connection secret updated.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }
  if (action === "recheck-service") {
    const result = await adapters.runCommand(["service", "recheck"], adapters);
    clack.outro("Recheck complete.");
    if (adapters.tracking) {
      adapters.tracking.run(adapters);
    }
    return result;
  }

  throw new Error(`Unsupported action: ${action}.`);
}

// The platform services `service add` can still provision, in prompt order.
// The hint is the catalog's own description so the two never drift apart.
const PROVISIONABLE_SERVICES = Object.freeze([
  { value: "technitium", label: "Technitium DNS", category: "dns", fallback: "DNS service", when: canProvisionTechnitium },
  { value: "caddy", label: "Caddy reverse proxy", category: "reverseProxy", fallback: "reverse proxy", when: (project) => canProvisionReverseProxy(project, "caddy") },
  { value: "traefik", label: "Traefik reverse proxy", category: "reverseProxy", fallback: "reverse proxy", when: (project) => canProvisionReverseProxy(project, "traefik") },
  { value: "step-ca", label: "step-ca certificate authority", category: "certificateAuthority", fallback: "certificate authority", when: (project) => canProvisionCertificateAuthority(project, "step-ca") },
  { value: "caddy-internal-ca", label: "Caddy Internal CA", category: "certificateAuthority", fallback: "internal certificate authority", when: (project) => canProvisionCertificateAuthority(project, "caddy-internal-ca") },
  { value: "tailscale", label: "Tailscale VPN", category: "vpn", fallback: "VPN service", when: (project) => canProvisionVpn(project, "tailscale") },
  { value: "netbird", label: "NetBird VPN", category: "vpn", fallback: "VPN service", when: (project) => canProvisionVpn(project, "netbird") }
]);

export async function promptServiceName(project, prompts) {
  const choices = PROVISIONABLE_SERVICES.filter((service) => service.when(project)).map((service) => ({
    value: service.value,
    label: service.label,
    hint: INITIAL_PLATFORM_CATALOG[service.category].find((option) => option.name === service.value)?.description
      ?? service.fallback
  }));
  if (choices.length === 0) {
    throw new Error("No platform services are waiting to be provisioned.");
  }
  if (choices.length === 1) {
    return choices[0].value;
  }

  if (prompts?.select) {
    const selected = await prompts.select({
      message: "Which service would you like to provision?",
      options: choices
    });
    if (selected === undefined) {
      throw new Error("Setup cancelled.");
    }
    return selected;
  }
  if (prompts?.ask) {
    const text = choices.map((choice) => `${choice.label} — ${choice.hint}`).join("; ");
    return prompts.ask(`Service to provision (${text})`, choices[0].value);
  }
  return choices[0].value;
}

export async function promptInitOptions(existingOptions, prompts) {
  if (prompts?.ask === undefined && prompts?.select === undefined) {
    return {
      dns: "technitium",
      certificateAuthority: "none",
      vpn: "none",
      ...existingOptions
    };
  }

  const node = existingOptions.node ?? await askPrompt(prompts, "Proxmox node");
  const bridge = existingOptions.bridge ?? await askPrompt(prompts, "Default network bridge");
  const storage = existingOptions.storage ?? await askPrompt(prompts, "Default storage target");
  const domain = existingOptions.domain ?? await askPrompt(prompts, "Base local domain");
  const dns = existingOptions.dns ?? await selectProvider(prompts, "DNS provider", "dns", "technitium");
  const reverseProxy = existingOptions.reverseProxy ?? await selectProvider(prompts, "Reverse proxy", "reverseProxy");
  const certificateAuthority = existingOptions.certificateAuthority
    ?? await selectOptionalProvider(prompts, "Certificate authority", "certificateAuthority", reverseProxy, "none");
  const vpn = existingOptions.vpn ?? await selectOptionalProvider(prompts, "VPN provider", "vpn", undefined, "none");

  return { ...existingOptions, node, bridge, storage, domain, dns, reverseProxy, certificateAuthority, vpn };
}

export async function selectLxcTemplate(prompts, availableTemplates, fallback) {
  const choices = [...new Set(availableTemplates ?? [])].map((volume) => ({ value: volume, label: volume }));
  if (prompts?.select && choices.length > 0) {
    const initialValue = (choices.find((choice) => choice.value.includes(fallback)) ?? choices[0]).value;
    const selected = await prompts.select({ message: "LXC template", options: choices, initialValue });
    if (selected === undefined || selected === "") {
      throw new Error("Setup cancelled.");
    }
    return selected;
  }
  return askPrompt(prompts, "LXC template", fallback);
}

export async function promptTechnitiumOptions(project, existingOptions, prompts, availableTemplates) {
  if (prompts?.ask === undefined && prompts?.confirm === undefined) {
    return existingOptions;
  }

  const recommendations = TECHNITIUM_DEPLOYMENT.resourceRecommendations;
  const ip = existingOptions.ip ?? await askRequired(prompts, "Static IP for Technitium", validateIp);
  const hostname = existingOptions.hostname
    ?? await askPrompt(prompts, "LXC hostname", TECHNITIUM_DEPLOYMENT.defaultHostname);
  const template = existingOptions.template
    ?? await selectLxcTemplate(prompts, availableTemplates, TECHNITIUM_DEPLOYMENT.template);
  const useRecommended = existingOptions.cpus !== undefined
    ? true
    : await confirmPrompt(
      prompts,
      `Use recommended resources (${recommendations.cpus} CPU, ${recommendations.memoryMb} MB RAM, ${recommendations.diskGb} GB disk)?`,
      true
    );

  let cpus = existingOptions.cpus;
  let memoryMb = existingOptions.memoryMb;
  let diskGb = existingOptions.diskGb;
  if (useRecommended === false) {
    cpus = Number(await askPrompt(prompts, "CPU cores", String(recommendations.cpus)));
    memoryMb = Number(await askPrompt(prompts, "Memory (MB)", String(recommendations.memoryMb)));
    diskGb = Number(await askPrompt(prompts, "Disk (GB)", String(recommendations.diskGb)));
  }

  logInfo(prompts, [
    `Bridge: ${existingOptions.bridge ?? project.config.proxmox.defaultBridge}`,
    `Storage: ${existingOptions.storage ?? project.config.proxmox.defaultStorage}`,
    `Gateway: ${existingOptions.gateway ?? defaultGatewayFor(ip)}`,
    `Nameserver: ${existingOptions.nameserver ?? existingOptions.gateway ?? defaultGatewayFor(ip)}`,
    `Domain: ${project.config.baseLocalDomain}`
  ].join("\n"));

  return {
    ...existingOptions,
    ip,
    hostname,
    ...(template === undefined ? {} : { template }),
    ...(cpus === undefined ? {} : { cpus }),
    ...(memoryMb === undefined ? {} : { memoryMb }),
    ...(diskGb === undefined ? {} : { diskGb })
  };
}

export async function promptReverseProxyOptions(project, existingOptions, prompts, { deployment, label, availableTemplates }) {
  if (prompts?.ask === undefined && prompts?.confirm === undefined) {
    return existingOptions;
  }

  const recommendations = deployment.resourceRecommendations;
  const ip = existingOptions.ip ?? await askRequired(prompts, `Static IP for ${label}`, validateIp);
  const hostname = existingOptions.hostname
    ?? await askPrompt(prompts, "LXC hostname", deployment.defaultHostname);
  const template = existingOptions.template
    ?? await selectLxcTemplate(prompts, availableTemplates, deployment.template);
  const useRecommended = existingOptions.cpus !== undefined
    ? true
    : await confirmPrompt(
      prompts,
      `Use recommended resources (${recommendations.cpus} CPU, ${recommendations.memoryMb} MB RAM, ${recommendations.diskGb} GB disk)?`,
      true
    );

  let cpus = existingOptions.cpus;
  let memoryMb = existingOptions.memoryMb;
  let diskGb = existingOptions.diskGb;
  if (useRecommended === false) {
    cpus = Number(await askPrompt(prompts, "CPU cores", String(recommendations.cpus)));
    memoryMb = Number(await askPrompt(prompts, "Memory (MB)", String(recommendations.memoryMb)));
    diskGb = Number(await askPrompt(prompts, "Disk (GB)", String(recommendations.diskGb)));
  }

  logInfo(prompts, [
    `Bridge: ${existingOptions.bridge ?? project.config.proxmox.defaultBridge}`,
    `Storage: ${existingOptions.storage ?? project.config.proxmox.defaultStorage}`,
    `Gateway: ${existingOptions.gateway ?? defaultGatewayFor(ip)}`,
    `Nameserver: ${existingOptions.nameserver ?? managedTechnitiumIp(project) ?? existingOptions.gateway ?? defaultGatewayFor(ip)}`
  ].join("\n"));

  return {
    ...existingOptions,
    ip,
    hostname,
    ...(template === undefined ? {} : { template }),
    ...(cpus === undefined ? {} : { cpus }),
    ...(memoryMb === undefined ? {} : { memoryMb }),
    ...(diskGb === undefined ? {} : { diskGb })
  };
}

export async function promptCaddyOptions(project, existingOptions, prompts, availableTemplates) {
  return promptReverseProxyOptions(project, existingOptions, prompts, {
    deployment: CADDY_DEPLOYMENT,
    label: "Caddy",
    availableTemplates
  });
}

export async function promptTraefikOptions(project, existingOptions, prompts, availableTemplates) {
  return promptReverseProxyOptions(project, existingOptions, prompts, {
    deployment: TRAEFIK_DEPLOYMENT,
    label: "Traefik",
    availableTemplates
  });
}

export async function promptStepCaOptions(project, existingOptions, prompts, availableTemplates) {
  return promptReverseProxyOptions(project, existingOptions, prompts, {
    deployment: STEP_CA_DEPLOYMENT,
    label: "step-ca",
    availableTemplates
  });
}

export async function promptTailscaleOptions(project, existingOptions, prompts, availableTemplates) {
  return promptReverseProxyOptions(project, existingOptions, prompts, {
    deployment: TAILSCALE_DEPLOYMENT,
    label: "Tailscale",
    availableTemplates
  });
}

export async function promptNetBirdOptions(project, existingOptions, prompts, availableTemplates) {
  return promptReverseProxyOptions(project, existingOptions, prompts, {
    deployment: NETBIRD_DEPLOYMENT,
    label: "NetBird",
    availableTemplates
  });
}

export async function promptExposureOptions(project, existingOptions, prompts) {
  if (prompts?.ask === undefined) {
    return existingOptions;
  }

  const name = existingOptions.name ?? await askPrompt(prompts, "Service name", "app");
  const suggestedHostname = `${name}.${project.config.baseLocalDomain}`;
  const hostname = existingOptions.hostname ?? await askPrompt(prompts, "Full hostname", suggestedHostname);
  const isRedirect = existingOptions.redirectTo !== undefined && existingOptions.redirectTo !== ""
    ? true
    : await confirmPrompt(
      prompts,
      "Is this a redirect to another URL? (no backend, e.g. apex bunny.internal -> home.bunny.internal)",
      false
    );
  if (isRedirect) {
    const redirectRaw = existingOptions.redirectTo
      ?? await askPrompt(prompts, "Redirect target (e.g. home.bunny.internal)", `home.${project.config.baseLocalDomain}`);
    const redirectCode = existingOptions.redirectCode
      ?? await promptRedirectCode(prompts, 308);
    return { ...existingOptions, name, hostname, redirectTo: redirectRaw, redirectCode };
  }
  const backendIp = existingOptions.backendIp
    ?? await askRequired(prompts, "Backend IP", validateIp);
  const backendPort = existingOptions.backendPort
    ?? Number(await askPrompt(prompts, "Backend port", "8080"));
  const backendTls = existingOptions.backendTls
    ?? await confirmPrompt(
      prompts,
      "Does the backend serve HTTPS/TLS itself? (e.g. Proxmox :8006, OPNsense)",
      false
    );

  return { ...existingOptions, name, hostname, backendIp, backendPort, backendTls };
}

async function promptRedirectCode(prompts, fallback = 308) {
  if (prompts?.select) {
    const selected = await prompts.select({
      message: "Redirect status code",
      options: [
        { value: 308, label: "308 Permanent (Recommended)", hint: "cached, preserves method and path" },
        { value: 307, label: "307 Temporary", hint: "not cached, preserves method and path" }
      ]
    });
    if (selected !== undefined) {
      return Number(selected);
    }
  }
  const answer = await askPrompt(prompts, "Redirect code (307 or 308)", String(fallback));
  return Number(answer ?? fallback);
}

async function askPrompt(prompts, question, fallback = undefined) {
  if (prompts?.ask === undefined) {
    return fallback;
  }
  return prompts.ask(question, fallback);
}

export async function confirmPrompt(prompts, message, initialValue) {
  if (prompts?.confirm) {
    return prompts.confirm({ message, initialValue });
  }
  if (prompts?.ask) {
    const answer = await prompts.ask(`${message} (y/n)`, initialValue ? "y" : "n");
    return answer.toLowerCase().startsWith("y");
  }
  return initialValue;
}

export async function promptUpgradeServiceName(project, prompts) {
  const choices = [];
  for (const [key, item] of Object.entries(project.config.managedInventory.platform)) {
    if (item && project.state.providerReferences[item.id]) {
      choices.push({ value: item.service, label: `${item.service} (${key})`, hint: `LXC vmid ${project.state.providerReferences[item.id].vmid}` });
    }
  }
  if (choices.length === 0) {
    throw new Error("No provisioned platform services found to upgrade.");
  }
  if (choices.length === 1) {
    return choices[0].value;
  }
  if (prompts?.select) {
    const selected = await prompts.select({
      message: "Which service would you like to upgrade?",
      options: choices
    });
    if (selected === undefined) throw new Error("Upgrade cancelled.");
    return selected;
  }
  if (prompts?.ask) {
    const text = choices.map((c) => `${c.label}`).join("; ");
    return prompts.ask(`Service to upgrade (${text})`, choices[0].value);
  }
  return choices[0].value;
}

export async function promptRemoveServiceName(project, prompts) {
  const choices = [];
  for (const [key, item] of Object.entries(project.config.managedInventory.platform)) {
    if (item && project.state.providerReferences[item.id]) {
      choices.push({ value: item.service, label: `${item.service} (${key})`, hint: `LXC vmid ${project.state.providerReferences[item.id].vmid}` });
    }
  }
  // Exposures are not platform services - use promptExposureServiceName / Remove an exposure
  if (choices.length === 0) {
    throw new Error("No provisioned services found to remove.");
  }
  if (choices.length === 1) {
    return choices[0].value;
  }
  if (prompts?.select) {
    const selected = await prompts.select({
      message: "Which service would you like to remove?",
      options: choices
    });
    if (selected === undefined) throw new Error("Removal cancelled.");
    return selected;
  }
  if (prompts?.ask) {
    const text = choices.map((c) => `${c.label}`).join("; ");
    return prompts.ask(`Service to remove (${text})`, choices[0].value);
  }
  return choices[0].value;
}

export async function promptExposureServiceName(project, prompts) {
  const choices = [];
  for (const s of project.config.managedInventory.services ?? []) {
    if (s?.exposure?.hostname) {
      const hint = s.exposure.redirect !== undefined
        ? `=> ${s.exposure.redirect.to} (${s.exposure.redirect.code ?? 308})`
        : s.exposure.backend !== undefined
          ? `${s.exposure.backend.ip}:${s.exposure.backend.port}`
          : "";
      choices.push({ value: s.id, label: `${s.name} (${s.exposure.hostname})`, hint });
    }
  }
  if (choices.length === 0) {
    throw new Error("No exposures found to manage.");
  }
  if (prompts?.select) {
    const selected = await prompts.select({
      message: "Which exposure would you like to manage?",
      options: choices
    });
    if (selected === undefined) throw new Error("Selection cancelled.");
    return selected;
  }
  if (prompts?.ask) {
    const text = choices.map((c) => `${c.label}`).join("; ");
    return prompts.ask(`Exposure to manage (${text})`, choices[0].value);
  }
  return choices[0].value;
}

export async function promptDestroyServiceName(project, prompts) {
  const choices = [];
  for (const [key, item] of Object.entries(project.config.managedInventory.platform)) {
    if (item && (project.state.providerReferences?.[item.id] || project.state.retainedServices?.[item.id])) {
      const ref = project.state.providerReferences?.[item.id] ?? project.state.retainedServices?.[item.id];
      const status = project.state.retainedServices?.[item.id] ? "retained" : "active";
      choices.push({ value: item.service, label: `${item.service} (${status})`, hint: `LXC vmid ${ref.vmid}` });
    }
  }
  for (const [id, ref] of Object.entries(project.state.retainedServices ?? {})) {
    if (!choices.some((c) => c.value === ref.service)) {
      choices.push({ value: ref.service, label: `${ref.service} (retained)`, hint: `LXC vmid ${ref.vmid}` });
    }
  }
  if (choices.length === 0) {
    throw new Error("No provisioned or retained services found to destroy.");
  }
  if (choices.length === 1) {
    return choices[0].value;
  }
  if (prompts?.select) {
    const selected = await prompts.select({
      message: "Which service LXC would you like to permanently destroy?",
      options: choices
    });
    if (selected === undefined) throw new Error("Destruction cancelled.");
    return selected;
  }
  if (prompts?.ask) {
    const text = choices.map((c) => `${c.label}`).join("; ");
    return prompts.ask(`Service to destroy (${text})`, choices[0].value);
  }
  return choices[0].value;
}

export async function promptSecretServiceName(project, prompts) {
  const entries = [];
  for (const [platformKey, item] of Object.entries(project.config.managedInventory.platform ?? {})) {
    if (item && project.config.connectionSecretReferences[item.id] !== undefined) {
      const provisioned = project.state.providerReferences?.[item.id] !== undefined;
      const hint = provisioned ? `LXC vmid ${project.state.providerReferences[item.id].vmid}` : "not yet provisioned";
      entries.push({ id: item.id, service: item.service, platformKey, label: `${item.service} (${platformKey})`, hint });
    }
  }
  for (const svc of project.config.managedInventory.services ?? []) {
    if (svc && project.config.connectionSecretReferences[svc.id] !== undefined) {
      entries.push({ id: svc.id, service: svc.name ?? svc.id, platformKey: "service", label: `${svc.name} (exposure)`, hint: svc.exposure?.hostname ?? svc.id });
    }
  }
  if (entries.length === 0) {
    throw new Error("No connection secrets are configured in this project.");
  }
  const choices = entries.map((e) => ({ value: e.id, label: e.label, hint: e.hint }));
  if (choices.length === 1) {
    return entries[0].id;
  }
  if (prompts?.select) {
    const selected = await prompts.select({
      message: "Which service secret would you like to update?",
      options: choices
    });
    if (selected === undefined) throw new Error("Secret change cancelled.");
    return selected;
  }
  if (prompts?.ask) {
    const text = choices.map((c) => `${c.label}`).join("; ");
    return prompts.ask(`Service secret to update (${text})`, choices[0].value);
  }
  return choices[0].value;
}

function logInfo(prompts, message) {
  if (prompts?.info) {
    prompts.info(message);
    return;
  }
  if (prompts?.warn) {
    prompts.warn(message);
  }
}

async function selectProvider(prompts, label, category, fallback = undefined) {
  const choices = INITIAL_PLATFORM_CATALOG[category].map((option) => ({
    value: option.name,
    label: option.name,
    hint: option.description
  }));
  if (prompts?.select) {
    const selected = await prompts.select({ message: label, options: choices, initialValue: fallback });
    if (selected === undefined) {
      throw new Error("Setup cancelled.");
    }
    return selected;
  }
  if (prompts?.ask) {
    const text = choices.map((choice) => `${choice.label} — ${choice.hint}`).join("; ");
    return prompts.ask(`${label} (${text})`, fallback);
  }
  return fallback;
}

async function selectOptionalProvider(prompts, label, category, reverseProxy, fallback) {
  const choices = INITIAL_PLATFORM_CATALOG[category]
    .filter((option) => option.compatibleWith === undefined || option.compatibleWith.includes(reverseProxy))
    .map((option) => ({
      value: option.name,
      label: option.name,
      hint: option.description
    }));
  choices.unshift({ value: "none", label: "none", hint: "skip this optional platform layer" });

  if (prompts?.select) {
    const selected = await prompts.select({ message: label, options: choices, initialValue: fallback });
    if (selected === undefined) {
      throw new Error("Setup cancelled.");
    }
    return selected;
  }
  if (prompts?.ask) {
    const text = choices.map((choice) => `${choice.label} — ${choice.hint}`).join("; ");
    return prompts.ask(`${label} (${text})`, fallback);
  }
  return fallback;
}

async function askRequired(prompts, question, validate) {
  while (true) {
    const answer = await askPrompt(prompts, question);
    const error = validate(answer);
    if (error === undefined) {
      return answer?.trim();
    }
    if (prompts?.warn) {
      prompts.warn(error);
    }
  }
}

function validateIp(value) {
  if (value === undefined || value.trim() === "") {
    return "Static IP is required.";
  }
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value.trim())) {
    return "Enter a valid IPv4 address, for example 10.0.0.53.";
  }
  return undefined;
}
