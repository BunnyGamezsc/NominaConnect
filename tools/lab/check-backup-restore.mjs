// Root-only retained-lab recovery check. Private backups never leave Proxmox.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createCommandRunner } from "../../src/adapter-runtime.js";

assert.equal(process.env.NOMINA_READINESS, "1");
assert.equal(process.getuid(), 0);
const projectDir = process.argv[2];
assert.ok(projectDir && fs.existsSync(path.join(projectDir, "nomina.yaml")));
const state = JSON.parse(fs.readFileSync(path.join(projectDir, ".nomina/state.json")));
const byIp = ip => Object.values(state.providerReferences).find(ref => ref.ip === ip)?.vmid;
const caVmid = byIp("192.168.1.56");
assert.equal(caVmid, 102, "This helper is scoped to the retained bunnytest installation");
const runner = createCommandRunner();
const run = (binary, args, timeoutMs = 30_000) => runner.run({ binary, args, timeoutMs });
const exec = (vmid, binary, args) => run("/usr/sbin/pct", ["exec", String(vmid), "--", binary, ...args]);
const dir = `/root/nomina-production-check-backups/recovery-${Date.now()}`;
fs.mkdirSync(dir, { mode: 0o700 });
const inventory = (await run("/usr/sbin/pct", ["list"])).stdout;
const initial = new Set(inventory.split("\n").slice(1).map(line => Number(line.trim().split(/\s+/)[0])).filter(Number.isFinite));
let clone = 104;
while (initial.has(clone)) clone++;
const marker = path.join(dir, "clone.json");
fs.writeFileSync(marker, JSON.stringify({ vmid: clone, hostname: "nomina-recovery-stepca", stage: "planned" }), { mode: 0o600 });
const digestScript = "import hashlib,json,pathlib; p=pathlib.Path('/var/lib/stepca'); print(json.dumps({str(f.relative_to(p)):hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted(p.rglob('*')) if f.is_file() and ('secrets' in f.parts or 'certs' in f.parts or 'config' in f.parts)}))";
const original = JSON.parse((await exec(caVmid, "/usr/bin/python3", ["-c", digestScript])).stdout);
assert.ok(Object.keys(original).some(name => name.startsWith("secrets/")), "Backup must include CA private keys");
const archives = [];
for (const [vmid, data] of [[100, "/etc/dns"], [101, "/var/lib/caddy"], [102, "/var/lib/stepca"], [103, "/var/lib/tailscale"]]) {
  const remote = `/tmp/nomina-recovery-${Date.now()}-${vmid}.tar`;
  const archive = path.join(dir, `provider-${vmid}.tar`);
  await exec(vmid, "/usr/bin/python3", ["-c",
    "import os,subprocess,sys; os.umask(0o077); subprocess.check_call(['/bin/tar','-cf',sys.argv[1],sys.argv[2]])", remote, data]);
  await run("/usr/sbin/pct", ["pull", String(vmid), remote, archive]);
  fs.chmodSync(archive, 0o600);
  await exec(vmid, "/bin/rm", ["-f", remote]);
  const restored = path.join(dir, `provider-${vmid}-restored`);
  fs.mkdirSync(restored, { mode: 0o700 });
  await run("/bin/tar", ["-xf", archive, "-C", restored]);
  // Extract and repack the provider tree; compare every file's contents through
  // tar's comparison against the restored directory, without printing data.
  await run("/bin/tar", ["-df", archive, "-C", restored]);
  archives.push({ vmid, archive, restored, contentsVerified: true });
}
await run("/bin/tar", ["-cf", path.join(dir, "project-and-secrets.tar"), projectDir, "/var/lib/nominaconnect"]);
fs.chmodSync(path.join(dir, "project-and-secrets.tar"), 0o600);
const projectCopy = path.join(dir, "project-and-secrets-restored");
fs.mkdirSync(projectCopy, { mode: 0o700 });
await run("/bin/tar", ["-xf", path.join(dir, "project-and-secrets.tar"), "-C", projectCopy]);
await run("/bin/tar", ["-df", path.join(dir, "project-and-secrets.tar"), "-C", projectCopy]);
await run("/usr/bin/vzdump", [String(caVmid), "--mode", "snapshot", "--compress", "zstd", "--dumpdir", dir, "--tmpdir", "/var/tmp"], 600_000);
const backup = fs.readdirSync(dir).find(name => name.endsWith(".tar.zst"));
assert.ok(backup);
fs.chmodSync(path.join(dir, backup), 0o600);
let created = false;
try {
  await run("/usr/sbin/pct", ["restore", String(clone), path.join(dir, backup), "--storage", "local-lvm"], 600_000);
  created = true;
  fs.writeFileSync(marker, JSON.stringify({ vmid: clone, hostname: "nomina-recovery-stepca", stage: "restored" }), { mode: 0o600 });
  await run("/usr/sbin/pct", ["set", String(clone), "--hostname", "nomina-recovery-stepca", "--onboot", "0",
    "--net0", "name=eth0,bridge=vmbr0,ip=192.168.1.56/24,gw=192.168.1.3,link_down=1"]);
  await run("/usr/sbin/pct", ["start", String(clone)]);
  const restored = JSON.parse((await exec(clone, "/usr/bin/python3", ["-c", digestScript])).stdout);
  assert.deepEqual(restored, original, "Restored CA keys, certificates and config must match");
  let service;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { service = (await exec(clone, "/bin/systemctl", ["is-active", "step-ca"])).stdout.trim(); }
    catch {}
    if (service === "active") break;
    await delay(1000);
  }
  assert.equal(service, "active");
  const result = { time: new Date().toISOString(), caVmid, clone, networkDisconnected: true,
    caKeysAndConfigVerified: true, restoredCaService: service, projectAndSecretsCopyVerified: true, providerArchives: archives };
  fs.writeFileSync(path.join(dir, "results.json"), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(result));
} finally {
  if (created) {
    const config = (await run("/usr/sbin/pct", ["config", String(clone)])).stdout;
    assert.match(config, /^hostname: nomina-recovery-stepca$/m, "Never destroy an unexpected VMID");
    try { await run("/usr/sbin/pct", ["stop", String(clone)]); } catch {}
    await run("/usr/sbin/pct", ["destroy", String(clone)]);
    fs.writeFileSync(path.join(dir, "cleaned"), "Disposable restored CA removed. Retained installation preserved.\n", { mode: 0o600 });
  }
}
