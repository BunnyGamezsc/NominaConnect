// The prerequisite every VPN client shares: an unprivileged service LXC
// (ADR-0030) has no /dev/net/tun, and no WireGuard or userspace tunnel can
// come up without it. NominaConnect checks the device from inside the
// container before it installs a client, grants it from the Proxmox root shell
// if it can, and otherwise fails with the exact remediation (ADR-0038).
const TUN_DEVICE = "/dev/net/tun";

const TUN_PROBE_OK = "nomina-tun-ok";
const TUN_PROBE_MISSING = "nomina-tun-missing";

// `pct reboot` returns once the LXC is back, but the client's daemon and the
// bind mounted device can lag slightly behind it.
const TUN_RECHECK_ATTEMPTS = 10;
const TUN_RECHECK_DELAY_MS = 1000;

export class VpnPrerequisiteError extends Error {
  constructor(message, name = "VpnPrerequisiteError") {
    super(message);
    this.name = name;
  }
}

export async function ensureTunDevice(run, vmid, { enableTunDevice, sleep, client }) {
  if (await hasTunDevice(run)) {
    return;
  }
  if (typeof enableTunDevice !== "function") {
    throw new VpnPrerequisiteError(describeTunRemediation(vmid, client), client.errorName);
  }
  try {
    await enableTunDevice(vmid);
  } catch (error) {
    throw new VpnPrerequisiteError(
      `${describeTunRemediation(vmid, client)}\n\nNominaConnect tried to enable it and Proxmox refused: ${error.message}`,
      client.errorName
    );
  }
  for (let attempt = 0; attempt < TUN_RECHECK_ATTEMPTS; attempt += 1) {
    if (await hasTunDevice(run)) {
      return;
    }
    await sleep(TUN_RECHECK_DELAY_MS);
  }
  throw new VpnPrerequisiteError(describeTunRemediation(vmid, client), client.errorName);
}

async function hasTunDevice(run) {
  try {
    const result = await run({
      binary: "/bin/bash",
      args: [
        "-c",
        `if [ -c ${TUN_DEVICE} ] && [ -r ${TUN_DEVICE} ] && [ -w ${TUN_DEVICE} ]; then echo ${TUN_PROBE_OK}; else echo ${TUN_PROBE_MISSING}; fi`
      ]
    });
    return String(result?.stdout ?? "").includes(TUN_PROBE_OK);
  } catch {
    return false;
  }
}

export function describeTunRemediation(vmid, client) {
  const id = vmid === undefined ? "<vmid>" : String(vmid);
  return [
    `${client.label} needs the TUN device ${TUN_DEVICE} inside LXC ${id}, and this unprivileged container does not have it.`,
    "Enable it from the Proxmox root shell and run this command again:",
    `  pct set ${id} --dev0 ${TUN_DEVICE}`,
    `  pct set ${id} --features keyctl=1,nesting=1`,
    `  pct reboot ${id}`,
    `On Proxmox 7, append these lines to /etc/pve/lxc/${id}.conf instead, then reboot the LXC:`,
    "  lxc.cgroup2.devices.allow: c 10:200 rwm",
    "  lxc.mount.entry: /dev/net/tun dev/net/tun none bind,create=file",
    `LXC ${id} was created and is left in place; NominaConnect never destroys it for you. Remove it with 'pct stop ${id} && pct destroy ${id}' before running '${client.addCommand}' again.`
  ].join("\n");
}

export { TUN_DEVICE };
