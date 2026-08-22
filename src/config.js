function readScalarBlock(lines, startIndex) {
  const valueLine = lines[startIndex]?.trim();
  if (valueLine === undefined || valueLine.startsWith("#")) {
    return { value: undefined, nextIndex: startIndex + 1 };
  }
  const match = valueLine.match(/^(\w+):\s*(.*)$/);
  if (match === null) {
    return { value: undefined, nextIndex: startIndex + 1 };
  }
  const [, , rawValue] = match;
  if (rawValue === "") {
    return readNestedBlock(lines, startIndex + 1);
  }
  if (rawValue === "null") {
    return { value: null, nextIndex: startIndex + 1 };
  }
  return { value: parseScalar(rawValue), nextIndex: startIndex + 1 };
}

function readNestedBlock(lines, startIndex, parentIndent = -1) {
  const value = {};
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (line.trim() === "" || line.trim().startsWith("#")) {
      index += 1;
      continue;
    }
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= parentIndent && Object.keys(value).length > 0) {
      break;
    }
    if (indent <= parentIndent) {
      index += 1;
      continue;
    }
    const trimmed = line.trim();
    const match = trimmed.match(/^(\w+):\s*(.*)$/);
    if (match === null) {
      index += 1;
      continue;
    }
    const [, key, rawValue] = match;
    if (rawValue === "") {
      const nested = readNestedBlock(lines, index + 1, indent);
      value[key] = nested.value;
      index = nested.nextIndex;
      continue;
    }
    value[key] = rawValue === "null" ? null : parseScalar(rawValue);
    index += 1;
  }
  return { value, nextIndex: index };
}

function parseScalar(rawValue) {
  if (rawValue.startsWith('"') || rawValue.startsWith("'")) {
    return JSON.parse(rawValue.replaceAll("'", '"'));
  }
  if (rawValue === "true") {
    return true;
  }
  if (rawValue === "false") {
    return false;
  }
  return rawValue;
}

function readServiceEntry(lines, startIndex) {
  const header = lines[startIndex];
  const headerIndent = header.match(/^(\s*)/)?.[1].length ?? 0;
  const match = header.trim().match(/^(\w+):\s*(null|\s*)$/);
  if (match === null) {
    return { value: undefined, nextIndex: startIndex + 1 };
  }
  if (match[2] === "null") {
    return { value: null, nextIndex: startIndex + 1 };
  }
  const nested = readNestedBlock(lines, startIndex + 1, headerIndent);
  return { value: nested.value, nextIndex: nested.nextIndex };
}

export function parseProjectConfiguration(content) {
  const lines = content.split("\n");
  const config = {
    proxmox: {},
    managedInventory: { platform: {}, services: [] },
    connectionSecretReferences: {}
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (line === "proxmox:") {
      const headerIndent = lines[index].match(/^(\s*)/)?.[1].length ?? 0;
      const block = readNestedBlock(lines, index + 1, headerIndent);
      config.proxmox = block.value;
      index = block.nextIndex;
      continue;
    }
    if (line.startsWith("baseLocalDomain:")) {
      config.baseLocalDomain = parseScalar(line.slice("baseLocalDomain:".length).trim());
      index += 1;
      continue;
    }
    if (line === "managedInventory:") {
      index += 1;
      continue;
    }
    if (line === "platform:") {
      const platformIndent = lines[index].match(/^(\s*)/)?.[1].length ?? 0;
      index += 1;
      while (index < lines.length) {
        const platformLine = lines[index];
        if (platformLine === undefined) {
          break;
        }
        const platformLineIndent = platformLine.match(/^(\s*)/)?.[1].length ?? 0;
        if (platformLineIndent <= platformIndent && platformLine.trim() !== "") {
          break;
        }
        const platformMatch = platformLine.trim().match(/^(\w+):\s*(null|\s*)$/);
        if (platformMatch === null) {
          index += 1;
          continue;
        }
        const entry = readServiceEntry(lines, index);
        config.managedInventory.platform[platformMatch[1]] = entry.value;
        index = entry.nextIndex;
      }
      continue;
    }
    if (line === "connectionSecretReferences:") {
      index += 1;
      while (index < lines.length) {
        const refLine = lines[index]?.trim();
        if (refLine === "") {
          index += 1;
          continue;
        }
        const refMatch = refLine.match(/^(\S+):\s+(\S+)$/);
        if (refMatch === null) {
          break;
        }
        config.connectionSecretReferences[refMatch[1]] = refMatch[2];
        index += 1;
      }
      continue;
    }
    if (line === "services:") {
      const servicesIndent = lines[index].match(/^(\s*)/)?.[1].length ?? 0;
      index += 1;
      config.managedInventory.services = readServiceList(lines, index, servicesIndent);
      index = skipServiceList(lines, index, servicesIndent);
      continue;
    }
    index += 1;
  }

  return config;
}

function readServiceList(lines, startIndex, parentIndent) {
  const services = [];
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.trim() === "" || line.trim().startsWith("#")) {
      index += 1;
      continue;
    }
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= parentIndent && line.trim() !== "") {
      break;
    }
    if (line.trim() === "[]") {
      return [];
    }
    if (!line.trim().startsWith("-")) {
      break;
    }
    const itemIndent = indent;
    const item = {};
    const firstLineContent = line.replace(/^\s*-\s*/, "").trim();
    if (firstLineContent !== "") {
      const match = firstLineContent.match(/^(\w+):\s*(.*)$/);
      if (match) {
        const [, key, rawValue] = match;
        item[key] = rawValue === "null" ? null : parseScalar(rawValue);
      }
    }
    index += 1;
    while (index < lines.length) {
      const itemLine = lines[index];
      if (itemLine === undefined || itemLine.trim() === "" || itemLine.trim().startsWith("#")) {
        index += 1;
        continue;
      }
      const itemLineIndent = itemLine.match(/^(\s*)/)?.[1].length ?? 0;
      if (itemLineIndent <= itemIndent) {
        break;
      }
      const trimmed = itemLine.trim();
      const match = trimmed.match(/^(\w+):\s*(.*)$/);
      if (match === null) {
        index += 1;
        continue;
      }
      const [, key, rawValue] = match;
      if (rawValue === "") {
        const nested = readNestedBlock(lines, index + 1, itemLineIndent);
        item[key] = nested.value;
        index = nested.nextIndex;
        continue;
      }
      item[key] = rawValue === "null" ? null : parseScalar(rawValue);
      index += 1;
    }
    services.push(item);
  }
  return services;
}

function skipServiceList(lines, startIndex, parentIndent) {
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined || line.trim() === "" || line.trim().startsWith("#")) {
      index += 1;
      continue;
    }
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (indent <= parentIndent && line.trim() !== "") {
      break;
    }
    if (line.trim() === "[]") {
      return index + 1;
    }
    if (!line.trim().startsWith("-")) {
      break;
    }
    index += 1;
    while (index < lines.length) {
      const nestedLine = lines[index];
      if (nestedLine === undefined || nestedLine.trim() === "" || nestedLine.trim().startsWith("#")) {
        index += 1;
        continue;
      }
      const nestedIndent = nestedLine.match(/^(\s*)/)?.[1].length ?? 0;
      if (nestedIndent <= indent) {
        break;
      }
      index += 1;
    }
  }
  return index;
}

export function upsertManagedExposure(config, managedService) {
  const services = config.managedInventory.services.filter(
    (service) => service.exposure?.hostname !== managedService.exposure.hostname
  );
  return {
    ...config,
    managedInventory: {
      ...config.managedInventory,
      services: [...services, managedService]
    }
  };
}

export function findProjectDirectory(filesystem, startDirectory = ".") {
  let current = normalizeDirectory(startDirectory);
  while (true) {
    if (filesystem.exists(joinPath(current, "nomina.yaml"))) {
      return current;
    }
    const parent = parentDirectory(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function loadProject(filesystem, projectDirectory) {
  const resolvedDirectory = projectDirectory ?? findProjectDirectory(filesystem);
  if (resolvedDirectory === undefined) {
    throw new Error("No NominaConnect project found. Run nomina init from the folder where you want your homelab config.");
  }
  const configPath = joinPath(resolvedDirectory, "nomina.yaml");
  if (!filesystem.exists(configPath)) {
    throw new Error("No NominaConnect project found. Run nomina init from the folder where you want your homelab config.");
  }
  const statePath = joinPath(resolvedDirectory, ".nomina/state.json");
  if (!filesystem.exists(statePath)) {
    throw new Error("No NominaConnect project found. Run nomina init from the folder where you want your homelab config.");
  }
  return {
    projectDirectory: resolvedDirectory,
    configPath,
    statePath,
    config: parseProjectConfiguration(filesystem.read(configPath)),
    state: JSON.parse(filesystem.read(statePath))
  };
}

export function updatePlatformDeployment(config, platformKey, deployment) {
  const service = config.managedInventory.platform[platformKey];
  if (service === null || service === undefined) {
    throw new Error(`Platform service ${platformKey} is not configured.`);
  }
  return {
    ...config,
    managedInventory: {
      ...config.managedInventory,
      platform: {
        ...config.managedInventory.platform,
        [platformKey]: { ...service, deployment }
      }
    }
  };
}

export function serializeProjectConfiguration(config) {
  const lines = [
    "apiVersion: nomina.connect/v0alpha1",
    "kind: NominaConnect",
    "proxmox:",
    `  node: ${yamlScalar(config.proxmox.node)}`,
    `  defaultBridge: ${yamlScalar(config.proxmox.defaultBridge)}`,
    `  defaultStorage: ${yamlScalar(config.proxmox.defaultStorage)}`,
    `baseLocalDomain: ${yamlScalar(config.baseLocalDomain)}`,
    "managedInventory:",
    "  platform:"
  ];
  appendPlatformService(lines, "    dns", config.managedInventory.platform.dns);
  appendPlatformService(lines, "    reverseProxy", config.managedInventory.platform.reverseProxy);
  appendPlatformService(lines, "    certificateAuthority", config.managedInventory.platform.certificateAuthority);
  appendPlatformService(lines, "    vpn", config.managedInventory.platform.vpn);
  appendManagedServices(lines, config.managedInventory.services);
  lines.push("connectionSecretReferences:");
  for (const [id, reference] of Object.entries(config.connectionSecretReferences)) {
    lines.push(`  ${id}: ${reference}`);
  }
  lines.push("");
  return lines.join("\n");
}

function appendManagedServices(lines, services) {
  if (services.length === 0) {
    lines.push("  services: []");
    return;
  }
  lines.push("  services:");
  for (const service of services) {
    lines.push(`    - id: ${service.id}`, `      name: ${yamlScalar(service.name)}`);
    if (service.exposure !== undefined) {
      lines.push(
        "      exposure:",
        `        hostname: ${yamlScalar(service.exposure.hostname)}`,
        "        backend:",
        `          ip: ${yamlScalar(service.exposure.backend.ip)}`,
        `          port: ${service.exposure.backend.port}`,
        `        protocol: ${yamlScalar(service.exposure.protocol)}`
      );
      if (service.exposure.certificateAuthority !== undefined) {
        lines.push(`        certificateAuthority: ${yamlScalar(service.exposure.certificateAuthority)}`);
      }
      if (service.exposure.tls !== undefined) {
        lines.push(
          "        tls:",
          `          mode: ${yamlScalar(service.exposure.tls.mode)}`,
          `          trusted: ${service.exposure.tls.trusted}`
        );
      }
    }
  }
}

function appendPlatformService(lines, field, service) {
  if (service === null) {
    lines.push(`${field}: null`);
    return;
  }
  lines.push(`${field}:`, `      id: ${service.id}`, `      service: ${service.service}`);
  if (service.deployment !== undefined) {
    lines.push("      deployment:", `        ip: ${yamlScalar(service.deployment.ip)}`, `        hostname: ${yamlScalar(service.deployment.hostname)}`);
    if (service.deployment.bridge !== undefined) {
      lines.push(`        bridge: ${yamlScalar(service.deployment.bridge)}`);
    }
    if (service.deployment.storage !== undefined) {
      lines.push(`        storage: ${yamlScalar(service.deployment.storage)}`);
    }
    if (service.deployment.template !== undefined) {
      lines.push(`        template: ${yamlScalar(service.deployment.template)}`);
    }
    if (service.deployment.resources !== undefined) {
      lines.push(
        "        resources:",
        `          cpus: ${service.deployment.resources.cpus}`,
        `          memoryMb: ${service.deployment.resources.memoryMb}`,
        `          diskGb: ${service.deployment.resources.diskGb}`
      );
    }
  }
}

function yamlScalar(value) {
  return /^[A-Za-z0-9._-]+$/.test(String(value)) ? String(value) : JSON.stringify(value);
}

function joinPath(...parts) {
  return parts.join("/").replaceAll(/\/{2,}/g, "/");
}

function normalizeDirectory(directory) {
  if (directory === ".") {
    return ".";
  }
  return directory.replace(/\/+$/, "") || "/";
}

function parentDirectory(directory) {
  const normalized = normalizeDirectory(directory);
  if (normalized === ".") {
    return ".";
  }
  const index = normalized.lastIndexOf("/");
  if (index <= 0) {
    return "/";
  }
  return normalized.slice(0, index);
}
