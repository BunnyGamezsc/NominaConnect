// Read-only production check. It never commits adoptions or writes providers.
// Run as root on the Proxmox host, passing the project directory as argv[2].
import fs from "node:fs";
import { loadProject } from "../../src/config.js";
import { createProductionAdapters } from "../../src/adapter-runtime.js";
import { runAdoptionPass } from "../../src/adoption.js";
import { getPlatformProvider } from "../../src/providers.js";

if (process.getuid?.() !== 0) throw new Error("Run this check as root on the Proxmox host.");
const filesystem = { exists: fs.existsSync, read: (path) => fs.readFileSync(path, "utf8") };
const project = loadProject(filesystem, process.argv[2] ?? "/root");
const { providerAdapters } = createProductionAdapters();
const selected = Object.fromEntries(["technitium", "caddy", "step-ca"].map((name) => [name, providerAdapters[name]]));
for (const key of ["dns", "certificateAuthority"]) {
  const item = project.config.managedInventory.platform[key];
  if (item === null || item === undefined || selected[item.service] === undefined) continue;
  const reference = project.state.providerReferences[item.id];
  const context = { ip: reference.ip, vmid: reference.vmid, zone: project.config.baseLocalDomain,
    connectionSecretReference: project.config.connectionSecretReferences[item.id] };
  const plugin = getPlatformProvider(item.service);
  const health = await plugin.healthCheck(selected[item.service], item, context);
  console.log(JSON.stringify({ provider: item.service, health }));
  if (key === "dns") {
    const inspection = await selected[item.service].inspect(context);
    console.log(JSON.stringify({ apexRecordLocators: inspection.resources
      .filter((resource) => resource.id === project.config.baseLocalDomain).map((resource) => resource.locator) }));
  }
}
const result = await runAdoptionPass({ project, providerAdapters, retryOptions: { maxRetries: 0 } });
console.log(JSON.stringify({ changes: result.changes.map(({ kind, serviceName, integration, changes }) =>
  ({ kind, serviceName, integration, fields: Object.keys(changes ?? {}) })),
  warnings: result.warnings.map(({ message }) => message) }));
if (result.warnings.length || result.changes.some((change) => change.kind === "exposure-changed")) process.exitCode = 1;
