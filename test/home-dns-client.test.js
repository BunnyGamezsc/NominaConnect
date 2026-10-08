import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../clients/home-dns/nomina-home-dns.sh", import.meta.url));
const windowsHelper = fileURLToPath(new URL("../clients/home-dns/nomina-home-dns.ps1", import.meta.url));
const powershell = process.env.NOMINA_TEST_PWSH ?? (process.platform === "win32" ? "powershell.exe" : "pwsh");

function clientFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nomina-home-dns-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initialization = path.join(root, "commands.sh");
  fs.writeFileSync(initialization, `
uname() { printf 'Linux\\n'; }
ip() {
  case "$*" in
    '-4 route show default') printf 'default via 192.0.2.1 dev eth0\\n' ;;
    '-4 neigh show to 192.0.2.1 dev eth0') printf '192.0.2.1 dev eth0 lladdr 00:11:22:33:44:55 REACHABLE\\n' ;;
    *) return 1 ;;
  esac
}
ping() { return 0; }
dig() { printf '192.0.2.54\\n'; }
getent() { printf '192.0.2.54 STREAM private.example.test\\n'; }
tailscale() { printf '%s\\n' "$*" >> "$HOME/dns-events"; }
systemctl() { printf '%s\\n' "$*" >> "$HOME/service-events"; }
`);
  const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, ".config"), BASH_ENV: initialization };
  return {
    root, initialization, env,
    installed: path.join(root, ".local/bin/nomina-home-dns"),
    run(command, script = helper) {
      return spawnSync("/bin/bash", [script, ...command], { env, encoding: "utf8", timeout: 10_000 });
    }
  };
}

test("home DNS setup can be edited through its installed command", (t) => {
  const client = clientFixture(t);
  const first = client.run(["setup", "192.0.2.53", "private.example.test"]);
  assert.equal(first.status, 0, first.stderr);

  const edited = client.run(["setup", "192.0.2.53", "edited.example.test"], client.installed);
  assert.equal(edited.status, 0, edited.stderr);
  assert.equal(fs.readFileSync(path.join(client.root, ".config/nominaconnect/home-dns.conf"), "utf8").split("\n")[1], "edited.example.test");
  assert.ok(fs.existsSync(client.installed));
});

test("Linux home DNS uninstall stops an active tick before restoring Tailscale DNS", async (t) => {
  const client = clientFixture(t);
  assert.equal(client.run(["setup", "192.0.2.53", "private.example.test"]).status, 0);
  fs.writeFileSync(path.join(client.root, "dns-events"), "");
  fs.appendFileSync(client.initialization, `
tailscale() {
  if [ "$*" = 'set --accept-dns=false' ]; then
    touch "$HOME/tick-ready"
    while [ ! -e "$HOME/tick-resume" ]; do command sleep 0.02; done
  fi
  printf '%s\\n' "$*" >> "$HOME/dns-events"
  if [ "$*" = 'set --accept-dns=true' ]; then touch "$HOME/tick-resume"; fi
}
systemctl() {
  printf '%s\\n' "$*" >> "$HOME/service-events"
  if [ "$*" = '--user stop nomina-home-dns.service' ]; then
    kill "$(cat "$HOME/tick-pid")" 2>/dev/null || true
  fi
}
`);
  const tick = spawn("/bin/bash", [client.installed, "tick"], { env: client.env, stdio: "ignore" });
  t.after(() => { if (tick.exitCode === null && tick.signalCode === null) tick.kill(); });
  const finished = new Promise((resolve) => tick.once("exit", resolve));
  fs.writeFileSync(path.join(client.root, "tick-pid"), String(tick.pid));
  for (let attempt = 0; attempt < 100 && !fs.existsSync(path.join(client.root, "tick-ready")); attempt++) {
    await delay(20);
  }
  assert.ok(fs.existsSync(path.join(client.root, "tick-ready")), "tick must reach the DNS change before uninstall starts");

  const removed = client.run(["uninstall"], client.installed);
  assert.equal(removed.status, 0, removed.stderr);
  await finished;
  const changes = fs.readFileSync(path.join(client.root, "dns-events"), "utf8").trim().split("\n");
  assert.equal(changes.at(-1), "set --accept-dns=true", "an in-flight tick must not disable DNS after uninstall restores it");
  assert.equal(fs.existsSync(client.installed), false);
});

test("Linux home DNS uninstall succeeds when its service is already absent", (t) => {
  const client = clientFixture(t);
  fs.appendFileSync(client.initialization, `
systemctl() {
  case "$*" in
    '--user stop nomina-home-dns.service') return 5 ;;
    '--user show nomina-home-dns.service --property=LoadState --value') printf 'not-found\\n' ;;
  esac
}
`);
  const removed = client.run(["uninstall"]);
  assert.equal(removed.status, 0, removed.stderr);
  assert.match(fs.readFileSync(path.join(client.root, "dns-events"), "utf8"), /set --accept-dns=true/);
});

test("Windows home DNS setup can be edited through its installed command", (t) => {
  const powershellProbe = spawnSync(powershell, ["-NoProfile", "-Command", "exit 0"]);
  const probeError = /** @type {NodeJS.ErrnoException | undefined} */ (powershellProbe.error);
  if (probeError?.code === "ENOENT") {
    t.skip("PowerShell is unavailable; set NOMINA_TEST_PWSH to run the isolated helper CLI check");
    return;
  }
  const client = clientFixture(t);
  const systemRoot = path.join(client.root, "windows");
  fs.mkdirSync(path.join(systemRoot, "System32"), { recursive: true });
  fs.mkdirSync(path.join(client.root, "bin"));
  fs.writeFileSync(path.join(systemRoot, "System32/ping.exe"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.writeFileSync(path.join(client.root, "bin/tailscale.exe"), "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$HOME/dns-events\"\n", { mode: 0o700 });
  const driver = path.join(client.root, "windows-check.ps1");
  fs.writeFileSync(driver, `
$ErrorActionPreference = 'Stop'
function Get-NetRoute { [pscustomobject]@{NextHop='192.0.2.1';InterfaceIndex=1;RouteMetric=10} }
function Get-NetAdapter { [pscustomobject]@{Name='Ethernet'} }
function Get-NetIPInterface { [pscustomobject]@{InterfaceMetric=10} }
function Get-NetNeighbor { [pscustomobject]@{LinkLayerAddress='00-11-22-33-44-55'} }
function Resolve-DnsName { [pscustomobject]@{Type='A';IPAddress='192.0.2.54'} }
function New-ScheduledTaskAction { [pscustomobject]@{} }
function New-ScheduledTaskTrigger { [pscustomobject]@{} }
function New-ScheduledTaskPrincipal { [pscustomobject]@{} }
function New-ScheduledTaskSettingsSet { [pscustomobject]@{} }
function Register-ScheduledTask { }
function Start-Sleep { }
function New-Object {
  param([string]$ComObject)
  $shell = [pscustomobject]@{}
  $shell | Add-Member ScriptMethod CreateShortcut {
    param($shortcutPath)
    $shortcut = [pscustomobject]@{TargetPath='';Arguments='';WorkingDirectory='';IconLocation='';Path=$shortcutPath}
    $shortcut | Add-Member ScriptMethod Save { Set-Content -Path $this.Path -Value 'test shortcut' }
    return $shortcut
  }
  return $shell
}
& $env:NOMINA_HELPER setup 192.0.2.53 private.example.test
$installed = Join-Path $env:LOCALAPPDATA 'Programs/NominaConnect/nomina-home-dns.ps1'
& $installed setup 192.0.2.53 edited.example.test
$config = Get-Content -Raw (Join-Path $env:APPDATA 'NominaConnect/home-dns.json') | ConvertFrom-Json
if ($config.probeHost -ne 'edited.example.test') { throw 'Updated probe hostname was not saved.' }
`);
  const checked = spawnSync(powershell, ["-NoProfile", "-File", driver], {
    env: { ...client.env, APPDATA: path.join(client.root, "appdata"), LOCALAPPDATA: path.join(client.root, "localappdata"),
      SystemRoot: systemRoot, NOMINA_HELPER: windowsHelper, PATH: `${path.join(client.root, "bin")}${path.delimiter}${process.env.PATH}` },
    encoding: "utf8", timeout: 15_000
  });
  assert.equal(checked.status, 0, checked.stderr);
});
