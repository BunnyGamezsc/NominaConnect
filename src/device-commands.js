import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  loadProject,
  writeDevicePackageSelections,
  findProjectDirectory,
} from "./config.js";
import { atomicWrite } from "./project-write.js";
import { managedTechnitiumIp } from "./provisioning.js";
import {
  validateDefinition,
  fetchProfileRoot,
  domain,
} from "./device-definition.js";
import { exportBundle } from "./device-export.js";
import {
  listenerPlan,
  queryPlainDns,
  verifyResolver,
} from "./device-resolver.js";

const usage =
  "nomina ca profile configure|list|inspect|resolver-check|resolver-setup|export. See docs/device-setup.md.";
const single = { type: /** @type {const} */ ("string") };
const repeat = { ...single, multiple: /** @type {const} */ (true) };
const switches = { type: /** @type {const} */ ("boolean") };
const common = { "project-dir": single, name: single };
const configure = {
  "display-name": single,
  description: single,
  target: repeat,
  "apple-dns": single,
  ssid: repeat,
  "home-check": single,
  mode: single,
  suffix: single,
  resolver: single,
  address: repeat,
  shortcut: repeat,
  "clear-shortcuts": switches,
};
function result(stdout) {
  return { stdout: stdout + "\n" };
}

export async function profileCommand(args, adapters, upgradeTechnitium) {
  const [action, ...rest] = args;
  const verbs = [
    "configure",
    "list",
    "inspect",
    "resolver-check",
    "resolver-setup",
    "export",
  ];
  if (!verbs.includes(action)) throw new Error(usage);
  const options = {
    ...common,
    ...(action === "configure" ? configure : {}),
    ...(action === "resolver-setup"
      ? { approve: single, "upgrade-technitium": switches }
      : {}),
    ...(action === "export"
      ? { output: single, "accept-root-change": switches }
      : {}),
  };
  if (
    rest.filter(
      (arg) => arg === "--project-dir" || arg.startsWith("--project-dir="),
    ).length > 1
  ) {
    throw new Error("Specify only one project directory.");
  }
  const { values: v } = parseArgs({ args: rest, options });
  const fs = adapters.filesystem;
  const project = loadProject(
    fs,
    v["project-dir"] ?? findProjectDirectory(fs, adapters.cwd ?? "."),
  );
  const packages = project.config.devicePackages;
  if (action === "list")
    return result(JSON.stringify(packages.map((p) => p.name)));
  const name = v.name;
  if (typeof name !== "string" || !name)
    throw new Error("Specify --name PACKAGE.");
  const pkg = packages.find((p) => p.name === name);
  const state = project.state;
  const save = () =>
    atomicWrite(
      fs,
      project.statePath,
      JSON.stringify(state, null, 2) + "\n",
      0o600,
    );
  if (action === "configure") {
    if (v.shortcut && v["clear-shortcuts"])
      throw new Error("Choose --shortcut or --clear-shortcuts.");
    const targets = v.target ?? pkg?.targets;
    if (v["apple-dns"] && !targets?.includes("apple"))
      throw new Error("--apple-dns requires --target apple.");
    const homeCheckOption = v["home-check"];
    const clearHomeCheck = typeof homeCheckOption === "string";
    if (clearHomeCheck) {
      const check = JSON.parse(homeCheckOption);
      if (
        !check ||
        typeof check !== "object" ||
        Array.isArray(check) ||
        Object.keys(check).length
      )
        throw new Error(
          "New packages match by Wi-Fi name. Pass --home-check '{}' to remove an existing extra check.",
        );
    }
    const technitiumIp = managedTechnitiumIp(project);
    const next = validateDefinition({
      name,
      displayName: v["display-name"] ?? pkg?.displayName,
      description: v.description ?? pkg?.description,
      targets,
      appleDns: v["apple-dns"] ?? pkg?.appleDns,
      ssids: v.ssid ?? pkg?.ssids,
      homeCheck: clearHomeCheck ? undefined : pkg?.homeCheck,
      mode: v.mode ?? pkg?.mode,
      suffix: v.suffix ?? pkg?.suffix,
      resolver: v.resolver ?? pkg?.resolver,
      addresses:
        v.address ??
        pkg?.addresses ??
        (technitiumIp ? [technitiumIp] : undefined),
      shortcuts: v["clear-shortcuts"]
        ? []
        : (v.shortcut?.map((s) => JSON.parse(s)) ?? pkg?.shortcuts ?? []),
    });
    state.devicePackages ??= {};
    if (!Object.hasOwn(state.devicePackages, name)) {
      state.devicePackages[name] = { id: randomUUID() };
      save();
    }
    project.config.devicePackages = [
      ...packages.filter((p) => p.name !== name),
      next,
    ];
    atomicWrite(
      fs,
      project.configPath,
      writeDevicePackageSelections(
        fs.read(project.configPath),
        project.config.devicePackages,
      ),
    );
    return result("Saved " + name);
  }
  if (!pkg) throw new Error("No such device package. Configure it first.");
  if (action === "inspect") return result(JSON.stringify(pkg, null, 2));
  if (action === "resolver-setup" && pkg.appleDns !== "encrypted")
    throw new Error(
      "Resolver setup requires an Apple package with encrypted DNS selected.",
    );
  if (action === "resolver-check" && !pkg.mode)
    return result("This package uses the device's existing DNS.");
  const record =
    Object.hasOwn(state.devicePackages ?? {}, name) &&
    state.devicePackages[name];
  if (!record?.id)
    throw new Error(
      "Package identity missing. Run configure and review the identity before redistribution.",
    );
  const cert = await fetchProfileRoot(project, adapters.proxmox);
  const verify = () =>
    pkg.mode
      ? (adapters.deviceResolverCheck ?? verifyResolver)(
          pkg,
          domain(project.config.baseLocalDomain),
          cert,
        )
      : undefined;
  if (action === "resolver-check") {
    await verify();
    return result(
      "Resolver verified at " +
        pkg.addresses.join(", ") +
        ". Public CA SHA-256 " +
        cert.fingerprint256,
    );
  }
  if (action === "export") {
    if (
      record.fingerprint &&
      record.fingerprint !== cert.fingerprint256 &&
      !v["accept-root-change"]
    )
      throw new Error(
        "CA root rotated from " +
          record.fingerprint +
          " to " +
          cert.fingerprint256 +
          ". Review and pass --accept-root-change.",
      );
    await verify();
    const { dest, manifest } = await exportBundle({
      pkg,
      id: record.id,
      cert,
      output: v.output,
      projectDirectory: project.projectDirectory,
    });
    record.fingerprint = cert.fingerprint256;
    save();
    return result(
      dest +
        "\n" +
        JSON.stringify(manifest, null, 2) +
        "\nFollow INSTALL.txt for installation and removal.",
    );
  }
  const dns = project.config.managedInventory.platform.dns;
  const ref = state.providerReferences[dns?.id];
  const provider = adapters.providerAdapters?.technitium;
  if (
    dns?.service !== "technitium" ||
    !ref?.vmid ||
    !ref.ip ||
    !provider?.inspectTlsListener
  )
    throw new Error("Provision a managed Technitium resolver first.");
  const request = {
    ip: ref.ip,
    connectionSecretReference:
      project.config.connectionSecretReferences[dns.id],
  };
  const inspect = async (recover = false) => {
    const settings = await provider.inspectTlsListener(request);
    let interfaces;
    if (settings.dnsServerLocalEndPoints?.some(endpoint => endpoint === "0.0.0.0:53" || endpoint === "[::]:53") &&
        (!settings.enableDnsOverTls || recover)) {
      const { stdout } = await adapters.proxmox.pctExec(ref.vmid, {
        binary: "/usr/bin/ip", args: ["-j", "address", "show"], timeoutMs: 5000, maxOutputBytes: 65536,
      });
      interfaces = JSON.parse(stdout);
    }
    const reviewed = listenerPlan(recover ? { ...settings, enableDnsOverTls: false } : settings, pkg.addresses, interfaces);
    return { ...reviewed, enabled: settings.enableDnsOverTls };
  };
  const observed = plan => ({ enabled: plan.enabled, version: plan.version,
    listeners: [...plan.listeners].sort(), certificate: plan.certificate });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const checkPlainDns = async (ip = ref.ip) => {
    try {
      await (adapters.devicePlainDnsCheck ?? queryPlainDns)(ip, domain(project.config.baseLocalDomain));
    } catch (error) {
      throw new Error(`Ordinary DNS failed at ${ip}: ${error.message}`);
    }
  };
  const checkBindingDns = async () => {
    for (const ip of new Set([ref.ip, ...pkg.addresses])) await checkPlainDns(ip);
  };
  let plan = await inspect();
  const pendingPlan = record.listener?.status === "pending" && record.listener.vmid === ref.vmid
    ? record.listener.plan : undefined;
  // A prior process may have stopped after Technitium saved the addresses.
  const interruptedBindings = pendingPlan?.bindings && same(plan, observed(pendingPlan));
  const upgrade = v["upgrade-technitium"];
  const reviewCommand =
    "Repeat resolver-setup" +
    (upgrade ? " --upgrade-technitium" : "") +
    " with --approve ";
  if (plan.enabled) {
    const pending = pendingPlan && same({ ...plan, enabled: false }, observed(pendingPlan));
    try {
      await verify();
      if (pending && pendingPlan.bindings) await checkBindingDns();
    } catch (error) {
      if (!pending || upgrade) throw error;
      const summary = JSON.stringify({
        change: "Roll back interrupted listener setup on TCP 853",
        impact:
          "Technitium restarts its DNS listeners when the setting changes.",
        vmid: ref.vmid,
        ...plan,
        restoreBindings: pendingPlan.bindings?.from,
      });
      const token = createHash("sha256").update(summary).digest("hex");
      if (!v.approve)
        return result(
          error.message +
            "\n" +
            summary +
            "\nRepeat resolver-setup with --approve " +
            token,
        );
      if (token !== v.approve)
        throw new Error("Review the pending rollback again.");
      if (!same(await inspect(), plan)) throw new Error("Technitium settings changed. Review the pending rollback again.");
      await provider.setTlsEnabled(request, false, pendingPlan.bindings?.from);
      if (!same(await inspect(), { ...pendingPlan, listeners: [...pendingPlan.listeners].sort() }))
        throw new Error("Could not verify the restored Technitium listeners. Review the current settings again.");
      record.listener.status = "rolled back";
      save();
      return result("Interrupted listener change rolled back.");
    }
    if (pending) {
      record.listener.status = "verified";
      save();
    }
    if (!upgrade)
      return result("Existing listener verified. No settings changed.");
  }
  const checkPort = async () => {
    const occupied = await adapters.proxmox.pctExec(ref.vmid, {
      binary: "/usr/bin/ss",
      args: ["-Hltn", "sport", "=", ":853"],
    });
    if (occupied.stdout.trim())
      throw new Error("TCP 853 already has a listener in the Technitium LXC.");
  };
  if (!plan.enabled) await checkPort();
  if (plan.bindings || interruptedBindings) await checkBindingDns();
  else if (upgrade) await checkPlainDns();
  const summary = JSON.stringify({
    change: upgrade
      ? "Run the vendor's in-place Technitium updater, then verify or enable DNS over TLS on TCP 853"
      : "Enable DNS over TLS on TCP 853",
    impact: upgrade
      ? "Requests a Proxmox snapshot when supported. The update and any listener change restart DNS."
      : "Technitium restarts its DNS listeners when the setting changes.",
    addressChange: plan.bindings && "Use the current private addresses explicitly. Address changes on the DNS LXC may require a new review.",
    restoreBindings: interruptedBindings ? pendingPlan.bindings.from : undefined,
    ...plan,
    vmid: ref.vmid,
    ip: ref.ip,
    resolver: pkg.resolver,
    bootstrap: pkg.addresses,
    root: cert.fingerprint256,
  });
  const token = createHash("sha256").update(summary).digest("hex");
  if (!v.approve) return result(summary + "\n" + reviewCommand + token);
  if (v.approve !== token)
    throw new Error(
      "Listener review has changed. Review resolver-setup again.",
    );
  let upgradeOutput = "";
  if (upgrade) {
    const updated = await upgradeTechnitium(project.projectDirectory);
    upgradeOutput = updated.stdout;
    if (updated.health?.status !== "healthy")
      throw new Error(
        upgradeOutput + "Stopped before changing the encrypted DNS setting.",
      );
    try {
      await checkPlainDns();
      const afterUpgrade = await inspect();
      if (
        JSON.stringify({ ...afterUpgrade, version: plan.version }) !==
        JSON.stringify(plan)
      )
        throw new Error(
          "Listener settings changed during the upgrade. Review resolver setup again.",
        );
      upgradeOutput +=
        "Technitium version before upgrade: " +
        plan.version +
        ". Current version: " +
        afterUpgrade.version +
        ".\n";
      plan = afterUpgrade;
      if (plan.enabled) {
        await verify();
        return result(upgradeOutput + "Encrypted DNS verified after upgrade.");
      }
      await checkPort();
    } catch (error) {
      throw new Error(upgradeOutput + error.message);
    }
  }
  if (!same(await inspect(), plan)) throw new Error("Technitium listener addresses changed. Review setup again.");
  const originalPlan = interruptedBindings ? { ...pendingPlan, version: plan.version } : plan;
  record.listener = { plan: originalPlan, vmid: ref.vmid, status: "pending" };
  save();
  try {
    await provider.setTlsEnabled(request, true, plan.bindings?.to);
    let failure;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await verify();
        if (originalPlan.bindings) await checkBindingDns();
        else if (upgrade) await checkPlainDns();
        failure = undefined;
        break;
      } catch (e) {
        failure = e;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (failure) throw failure;
    if (!same(await inspect(), { ...observed(plan), enabled: true }))
      throw new Error(
        "Technitium did not retain the reviewed listener setting.",
      );
    record.listener.status = "verified";
    save();
    return result(
      upgradeOutput + "Reviewed Technitium listener enabled and verified.",
    );
  } catch (error) {
    const current = await inspect(true);
    const onlyToggleChanged = current.enabled && same({ ...current, enabled: false }, plan);
    const bindingsChanged = originalPlan.bindings && same({ ...current, enabled: false }, observed(plan));
    if (onlyToggleChanged || bindingsChanged) {
      await provider.setTlsEnabled(request, false, bindingsChanged ? originalPlan.bindings.from : undefined);
      if (!same(await inspect(), originalPlan)) throw new Error(`${error.message} Could not verify restoration of the reviewed DNS settings.`);
      record.listener.status = "rolled back";
      save();
    }
    if (upgradeOutput) throw new Error(upgradeOutput + error.message);
    throw error;
  }
}
