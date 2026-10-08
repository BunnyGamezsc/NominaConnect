// Retained bunnytest service update and a controlled delayed-address check.
import fs from "node:fs";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createProductionAdapters } from "../../src/adapter-runtime.js";
import { dnsInstallScript, firewallInstallScript } from "../../src/tailscale-tailnet.js";

assert.equal(process.env.NOMINA_READINESS, "1");
assert.equal(process.getuid(), 0);
const projectDir = process.argv[2];
const state = JSON.parse(fs.readFileSync(`${projectDir}/.nomina/state.json`));
assert.ok(Object.values(state.providerReferences).some(ref => ref.vmid === 103 && ref.ip === "192.168.1.57"));
const production = createProductionAdapters();
const exec = (binary, args) => production.proxmox.pctExec(103, { binary, args, timeoutMs: 60_000 });
const gatewayIp = (await exec("/usr/bin/tailscale", ["ip", "-4"])).stdout.trim();
await exec("/bin/bash", ["-c", firewallInstallScript("192.168.1.53", "192.168.1.54", gatewayIp)]);
await exec("/bin/bash", ["-c", dnsInstallScript({ dnsIp: "192.168.1.53", proxyIp: "192.168.1.54", gatewayIp, zone: "bunnytest.internal" })]);
const unitPath = "/etc/systemd/system/nomina-tailnet-dns.service";
const originalUnit = (await exec("/bin/cat", [unitPath])).stdout;
const unitBackup = `${projectDir}/.nomina/gateway-recovery-unit`;
fs.writeFileSync(unitBackup, originalUnit, { mode: 0o600 });
const writeUnit = contents => production.proxmox.pctExec(103, {
  binary: "/usr/bin/python3", args: ["-c", `import sys;open('${unitPath}','w').write(sys.stdin.read())`], stdin: contents
});
const marker = `${projectDir}/.nomina/gateway-recovery-pending`;
fs.writeFileSync(marker, `Restore ${unitBackup} to ${unitPath} in LXC 103, daemon-reload and restart nomina-tailnet-dns if interrupted.\n`, { mode: 0o600 });
try {
  // Keep the installed dependencies and retry settings. A documentation-only
  // address supplies a bind failure without changing interfaces or routes.
  assert.ok(originalUnit.includes(`tailnet-dns.py ${gatewayIp} `));
  await writeUnit(originalUnit.replace(`tailnet-dns.py ${gatewayIp} `, "tailnet-dns.py 192.0.2.123 "));
  await exec("/bin/systemctl", ["daemon-reload"]);
  try { await exec("/bin/systemctl", ["restart", "nomina-tailnet-dns"]); } catch {}
  await delay(35_000);
  const delayed = (await exec("/bin/systemctl", ["show", "nomina-tailnet-dns", "-p", "NRestarts", "-p", "ActiveState", "-p", "SubState", "-p", "StartLimitIntervalUSec"])).stdout;
  const restarts = Number(delayed.match(/^NRestarts=(\d+)$/m)?.[1]);
  assert.ok(restarts >= 5, "DNS must keep retrying while its address is absent");
  assert.match(delayed, /^StartLimitIntervalUSec=0$/m);
  await writeUnit(originalUnit);
  await exec("/bin/systemctl", ["daemon-reload"]);
  let recovered = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { recovered = (await exec("/bin/systemctl", ["is-active", "nomina-tailnet-dns"])).stdout.trim() === "active"; } catch {}
    if (recovered) break;
    await delay(1000);
  }
  assert.ok(recovered, "Relay must recover automatically when the gateway address returns");
  const result = { time: new Date().toISOString(), gatewayIp, syntheticMissingBindAddress: "192.0.2.123", addressAbsentSeconds: 35,
    restartAttempts: restarts, automaticDnsRecovery: true };
  fs.writeFileSync(`${projectDir}/.nomina/gateway-recovery-results.json`, JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally {
  await writeUnit(originalUnit);
  await exec("/bin/systemctl", ["daemon-reload"]);
  try { await exec("/bin/systemctl", ["is-active", "nomina-tailnet-dns"]); }
  catch { await exec("/bin/systemctl", ["restart", "nomina-tailnet-dns"]); }
  fs.rmSync(marker);
}
