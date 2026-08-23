import * as clack from "@clack/prompts";
import { INITIAL_PLATFORM_CATALOG } from "./catalog.js";
import { canShowCaTrustGuide } from "./ca-guide.js";
import { findProjectDirectory, loadProject } from "./config.js";
import { TECHNITIUM_DEPLOYMENT, CADDY_DEPLOYMENT, TRAEFIK_DEPLOYMENT, STEP_CA_DEPLOYMENT, TAILSCALE_DEPLOYMENT, NETBIRD_DEPLOYMENT, defaultGatewayFor } from "./provisioning.js";
import { formatPendingNotices } from "./tracking.js";

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

export function canProvisionCaddy(project) {
  return canProvisionReverseProxy(project, "caddy");
}

export function canProvisionTraefik(project) {
  return canProvisionReverseProxy(project, "traefik");
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

export function canProvisionStepCa(project) {
  return canProvisionCertificateAuthority(project, "step-ca");
}

export function canProvisionCaddyInternalCa(project) {
  return canProvisionCertificateAuthority(project, "caddy-internal-ca");
}

export function canProvisionVpn(project, serviceName) {
  const vpnService = project?.config.managedInventory.platform.vpn;
  if (vpnService?.service !== serviceName) {
    return false;
  }
  return project.state.providerReferences[vpnService.id] === undefined;
}

export function canProvisionTailscale(project) {
  return canProvisionVpn(project, "tailscale");
}

export function canProvisionNetbird(project) {
  return canProvisionVpn(project, "netbird");
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

export function buildMenuOptions(project) {
  const options = [];
  if (project !== undefined && canProvisionTechnitium(project)) {
    options.push({
      value: "provision-technitium",
      label: "Provision Technitium DNS",
      hint: "create the DNS LXC"
    });
  }
  if (project !== undefined && canProvisionCaddy(project)) {
    options.push({
      value: "provision-caddy",
      label: "Provision Caddy reverse proxy",
      hint: "create the proxy LXC"
    });
  }
  if (project !== undefined && canProvisionTraefik(project)) {
    options.push({
      value: "provision-traefik",
      label: "Provision Traefik reverse proxy",
      hint: "create the proxy LXC"
    });
  }
  if (project !== undefined && canProvisionStepCa(project)) {
    options.push({
      value: "provision-step-ca",
      label: "Provision step-ca certificate authority",
      hint: "create the step-ca LXC"
    });
  }
  if (project !== undefined && canProvisionCaddyInternalCa(project)) {
    options.push({
      value: "provision-caddy-internal-ca",
      label: "Configure Caddy Internal CA",
      hint: "configure internal certificates in Caddy"
    });
  }
  if (project !== undefined && canProvisionTailscale(project)) {
    options.push({
      value: "provision-tailscale",
      label: "Provision Tailscale VPN",
      hint: "create the Tailscale LXC"
    });
  }
  if (project !== undefined && canProvisionNetbird(project)) {
    options.push({
      value: "provision-netbird",
      label: "Provision NetBird VPN",
      hint: "create the NetBird LXC"
    });
  }
  if (project !== undefined && canPublishExposure(project)) {
    options.push({
      value: "publish-exposure",
      label: "Publish a web exposure",
      hint: "connect DNS and HTTPS routing"
    });
  }
  if (project !== undefined && canEditExposure(project)) {
    options.push({
      value: "edit-exposure",
      label: "Edit an exposure",
      hint: "update backend IP or port"
    });
  }
  if (project !== undefined && canRemoveExposure(project)) {
    options.push({
      value: "remove-exposure",
      label: "Remove an exposure",
      hint: "disconnect DNS and HTTPS routing"
    });
  }
  if (project !== undefined && canShowCaTrustGuide(project)) {
    options.push({
      value: "view-ca-guide",
      label: "View step-ca trust guide",
      hint: "install CA root on devices"
    });
  }
  if (project !== undefined && hasProvisionedServices(project)) {
    options.push({
      value: "upgrade-service",
      label: "Upgrade a managed service",
      hint: "explicit service upgrade with snapshot"
    });
    options.push({
      value: "remove-service",
      label: "Remove a managed service",
      hint: "disconnect integrations and retain data"
    });
  }
  if (project !== undefined && hasProvisionedOrRetainedServices(project)) {
    options.push({
      value: "destroy-service",
      label: "Destroy a service LXC",
      hint: "permanently delete LXC container and data"
    });
  }
  if (project !== undefined && canUpdateConnectionSecret(project)) {
    options.push({
      value: "update-secret",
      label: "Update connection secret",
      hint: "change stored provider password"
    });
  }
  if (project !== undefined && canRecheckProvisioning(project)) {
    options.push({
      value: "recheck-service",
      label: "Recheck provisioning",
      hint: "adopt existing LXC if healthy"
    });
  }
  if (project !== undefined) {
    const notices = project.state?.tracking?.notices ?? [];
    if (notices.length > 0) {
      options.push({
        value: "view-changes",
        label: "View changes",
        hint: `${notices.length} pending change(s)`
      });
    }
  }
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
    let backendIp = svc.exposure.backend.ip;
    let backendPortRaw = String(svc.exposure.backend.port);
    if (adapters.prompts?.ask) {
      const answerIp = await adapters.prompts.ask("Backend IP", svc.exposure.backend.ip);
      if (answerIp && answerIp.trim() !== "") {
        const err = validateIp(answerIp);
        if (err) throw new Error(err);
        backendIp = answerIp.trim();
      }
      const answerPort = await adapters.prompts.ask("Backend port", String(svc.exposure.backend.port));
      if (answerPort && answerPort.trim() !== "") {
        backendPortRaw = answerPort.trim();
      }
    } else if (adapters.prompts?.select) {
      backendIp = svc.exposure.backend.ip;
      backendPortRaw = String(svc.exposure.backend.port);
    }
    const backendPort = Number(backendPortRaw);
    if (!Number.isInteger(backendPort) || backendPort <= 0) {
      throw new Error(`Invalid backend port: ${backendPortRaw}.`);
    }
    const result = await adapters.runCommand(
      ["exposure", "publish", "--name", svc.name, "--hostname", svc.exposure.hostname, "--backend-ip", backendIp, "--backend-port", String(backendPort)],
      adapters
    );
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

export async function promptServiceName(project, prompts) {
  const choices = [];
  if (canProvisionTechnitium(project)) {
    const description = INITIAL_PLATFORM_CATALOG.dns[0]?.description ?? "DNS service";
    choices.push({ value: "technitium", label: "Technitium DNS", hint: description });
  }
  if (canProvisionCaddy(project)) {
    const description = INITIAL_PLATFORM_CATALOG.reverseProxy.find((option) => option.name === "caddy")?.description
      ?? "reverse proxy";
    choices.push({ value: "caddy", label: "Caddy reverse proxy", hint: description });
  }
  if (canProvisionTraefik(project)) {
    const description = INITIAL_PLATFORM_CATALOG.reverseProxy.find((option) => option.name === "traefik")?.description
      ?? "reverse proxy";
    choices.push({ value: "traefik", label: "Traefik reverse proxy", hint: description });
  }
  if (canProvisionStepCa(project)) {
    const description = INITIAL_PLATFORM_CATALOG.certificateAuthority.find((option) => option.name === "step-ca")?.description
      ?? "certificate authority";
    choices.push({ value: "step-ca", label: "step-ca certificate authority", hint: description });
  }
  if (canProvisionCaddyInternalCa(project)) {
    const description = INITIAL_PLATFORM_CATALOG.certificateAuthority.find((option) => option.name === "caddy-internal-ca")?.description
      ?? "internal certificate authority";
    choices.push({ value: "caddy-internal-ca", label: "Caddy Internal CA", hint: description });
  }
  if (canProvisionTailscale(project)) {
    const description = INITIAL_PLATFORM_CATALOG.vpn.find((option) => option.name === "tailscale")?.description
      ?? "VPN service";
    choices.push({ value: "tailscale", label: "Tailscale VPN", hint: description });
  }
  if (canProvisionNetbird(project)) {
    const description = INITIAL_PLATFORM_CATALOG.vpn.find((option) => option.name === "netbird")?.description
      ?? "VPN service";
    choices.push({ value: "netbird", label: "NetBird VPN", hint: description });
  }
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
    `Nameserver: ${existingOptions.nameserver ?? existingOptions.gateway ?? defaultGatewayFor(ip)}`
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
  const backendIp = existingOptions.backendIp
    ?? await askRequired(prompts, "Backend IP", validateIp);
  const backendPort = existingOptions.backendPort
    ?? Number(await askPrompt(prompts, "Backend port", "8080"));

  return { ...existingOptions, name, hostname, backendIp, backendPort };
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
      choices.push({ value: s.id, label: `${s.name} (${s.exposure.hostname})`, hint: `${s.exposure.backend.ip}:${s.exposure.backend.port}` });
    }
  }
  if (choices.length === 0) {
    throw new Error("No exposures found to manage.");
  }
  if (choices.length === 1) {
    return choices[0].value;
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
