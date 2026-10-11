import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { runCli } from "../src/cli.js";
import { createCommandRunner, createProductionAdapters } from "../src/adapter-runtime.js";
import { loadProject, serializeProjectConfiguration } from "../src/config.js";
import { acquireProjectLock } from "../src/project-lock.js";
import { probeTcp } from "../src/tcp-adapter.js";

const env = process.env;
const required = ["NOMINA_DOCKER_EXPOSURE_RETAINED_PROJECT", "NOMINA_DOCKER_EXPOSURE_VMID", "NOMINA_DOCKER_EXPOSURE_PROXY_IP"];
const skip = env.NOMINA_DOCKER_EXPOSURE_ACCEPTANCE !== "1" ? "Set NOMINA_DOCKER_EXPOSURE_ACCEPTANCE=1 on the authorized lab. Creates/retains a separate proxy CT and one Docker SMB fixture."
  : process.getuid?.() !== 0 || !fs.existsSync("/usr/sbin/pct") ? "Root Proxmox shell unavailable."
  : required.some((key) => !env[key]) ? "Missing " + required.filter((key) => !env[key]).join(", ") : undefined;

test("live Docker web/TCP/SMB publication, review, conflicts, overrides and binding independence", { skip, timeout: 900000 }, async () => {
  const directory = env.NOMINA_DOCKER_EXPOSURE_PROJECT ?? fs.mkdtempSync(path.join(os.tmpdir(), "nomina-docker-exposure-"));
  fs.mkdirSync(path.join(directory, ".nomina"), { recursive: true, mode: 0o700 });
  const filesystem = { exists: fs.existsSync, read: (file) => fs.readFileSync(file, "utf8"), writeFile: fs.writeFileSync, rename: fs.renameSync, chmod: fs.chmodSync, acquireProjectLock };
  const retained = loadProject(filesystem, env.NOMINA_DOCKER_EXPOSURE_RETAINED_PROJECT);
  const runner = createCommandRunner();
  const production = createProductionAdapters({ commandRunner: runner });
  const adapters = { ...production, filesystem, cwd: directory, runtime: { isRoot: () => true, isProxmoxHost: () => true }, tracking: { start: () => {} } };
  const digest = (content) => createHash("sha256").update(content).digest("hex");
  const retainedHashes = [retained.configPath, retained.statePath].map((file) => [file, digest(fs.readFileSync(file))]);
  const existing = await production.proxmox.listLxcs();
  const configs = new Map();
  for (const ct of existing) configs.set(ct.vmid, digest((await runner.run({ binary: "/usr/sbin/pct", args: ["config", String(ct.vmid)] })).stdout));
  const vmid = Number(env.NOMINA_DOCKER_EXPOSURE_VMID);
  const domain = env.NOMINA_DOCKER_EXPOSURE_DOMAIN ?? "docker33.bunnytest.internal";
  const report = { directory, vmid, domain, checks: {}, retainedResources: true };
  const resume = env.NOMINA_DOCKER_EXPOSURE_RESUME === "1";
  const cli = (args) => runCli([...args, "--project-dir", directory], adapters);
  const publish = async (candidate, hostname, protocol, args, backendPort = candidate.hostPort, listenerPort = undefined) => {
    const saved = loadProject(filesystem, directory).config.managedInventory.services.find((service) => service.exposure?.hostname === hostname);
    if (!saved || !resume) return cli([...args, "--yes"]);
    assert.equal(saved.exposure.protocol, protocol === "smb" ? "tcp" : protocol);
    assert.equal(saved.exposure.backend.ip, candidate.backendAddress);
    assert.equal(Number(saved.exposure.backend.port), backendPort);
    if (listenerPort !== undefined) assert.equal(Number(saved.exposure.listenerPort), listenerPort);
    if (protocol === "smb") assert.equal(saved.exposure.preset, "smb");
    return { managedService: saved, resumed: true };
  };
  const docker = (args) => production.proxmox.pctExec(vmid, { binary: "/usr/bin/docker", args, timeoutMs: 180000, maxOutputBytes: 16384 });
  const appSnapshot = async () => {
    const result = await production.proxmox.pctExec(vmid, { binary: "/bin/sh", args: ["-s"], stdin: "set -eu\n{ docker ps -aq --no-trunc | sort | xargs -r docker inspect; docker network ls -q --no-trunc | sort | xargs -r docker network inspect; docker volume ls -q | sort | xargs -r docker volume inspect; } | sha256sum\n", timeoutMs: 30000, maxOutputBytes: 1024 });
    return result.stdout.trim();
  };
  const requestWeb = (ip, hostname, port = 443, tls = true) => new Promise((resolve, reject) => {
    const request = (tls ? https : http).request({ host: ip, port, path: "/", headers: { Host: hostname }, ...(tls ? { servername: hostname, rejectUnauthorized: false } : {}), timeout: 10000 }, (response) => {
      let body = ""; response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve({ status: response.statusCode, body, location: response.headers.location }));
    });
    request.on("error", reject); request.on("timeout", () => request.destroy(new Error("Web request timed out"))); request.end();
  });
  let originalApplications;
  try {
    if (!filesystem.exists(path.join(directory, "nomina.yaml"))) {
      const dns = retained.config.managedInventory.platform.dns;
      assert.equal(dns.service, "technitium");
      const proxy = { id: "nc_docker33_proxy", service: "caddy" };
      const config = { ...retained.config, baseLocalDomain: domain, managedInventory: { platform: { dns, reverseProxy: proxy, certificateAuthority: null, vpn: null }, services: [], dockerHosts: [] }, connectionSecretReferences: { [dns.id]: retained.config.connectionSecretReferences[dns.id] } };
      fs.writeFileSync(path.join(directory, "nomina.yaml"), serializeProjectConfiguration(config));
      fs.writeFileSync(path.join(directory, ".nomina/state.json"), JSON.stringify({ providerReferences: { [dns.id]: retained.state.providerReferences[dns.id] } }), { mode: 0o600 });
    }
    let project = loadProject(filesystem, directory);
    if (!project.state.providerReferences.nc_docker33_proxy) {
      if (env.NOMINA_DOCKER_EXPOSURE_PROXY_VMID) {
        // Explicit recovery of the isolated fixture CT after interrupted setup.
        const proxyVmid = Number(env.NOMINA_DOCKER_EXPOSURE_PROXY_VMID);
        const ct = await production.proxmox.inspectLxc(proxyVmid);
        assert.equal(ct.ip, env.NOMINA_DOCKER_EXPOSURE_PROXY_IP);
        assert.ok(proxyVmid !== vmid && !Object.values(retained.state.providerReferences).some((reference) => reference.vmid === proxyVmid));
        if (env.NOMINA_DOCKER_EXPOSURE_PROXY_READY !== "1") {
          const plan = await production.providerAdapters.caddy.setup({ provider: "caddy", vmid: proxyVmid });
          for (const command of plan.lxcCommands) await production.proxmox.pctExec(proxyVmid, command);
        }
        assert.equal((await production.providerAdapters.caddy.healthCheck({ ip: ct.ip })).endpoint, "reachable");
        project.state.providerReferences.nc_docker33_proxy = { vmid: proxyVmid, ip: ct.ip };
        fs.writeFileSync(project.statePath, JSON.stringify(project.state), { mode: 0o600 });
      } else {
        await cli(["service", "add", "caddy", "--ip", env.NOMINA_DOCKER_EXPOSURE_PROXY_IP, "--gateway", env.NOMINA_DOCKER_EXPOSURE_GATEWAY ?? "192.168.1.3", "--cpus", "1", "--memory", "256", "--disk", "2", "--template", env.NOMINA_DOCKER_EXPOSURE_TEMPLATE ?? "debian-13-standard"]);
      }
    }
    project = loadProject(filesystem, directory);
    report.proxy = project.state.providerReferences.nc_docker33_proxy;
    assert.ok(report.proxy.vmid !== vmid && !Object.values(retained.state.providerReferences).some((reference) => reference.vmid === report.proxy.vmid), "Must use a separate proxy CT");
    if (!project.config.managedInventory.dockerHosts?.length) await cli(["docker", "connect", "--name", "acceptance", "--vmid", String(vmid), "--yes"]);

    // Fixture setup is explicit acceptance work, outside product discovery/publication.
    // Never recreate or modify an existing fixture application.
    const fixtureName = "nomina-issue33-smb";
    const passwordFile = path.join(directory, "smb-fixture-password");
    const listed = await docker(["ps", "--all", "--format", "{{.Names}}"]);
    if (!listed.stdout.split("\n").includes(fixtureName)) {
      const password = randomUUID();
      fs.writeFileSync(passwordFile, password, { mode: 0o600 });
      const setup = "set -eu\napk add --no-cache samba samba-client >/dev/null\nadduser -D -H proof\nprintf '%s\\n%s\\n' \"$SMB_FIXTURE_PASSWORD\" \"$SMB_FIXTURE_PASSWORD\" | smbpasswd -a -s proof >/dev/null\nmkdir -p /share\nchown proof:proof /share\nprintf 'Docker SMB proof\\n' > /share/proof.txt\nchown proof:proof /share/proof.txt\ncat > /etc/samba/smb.conf <<'CONF'\n[global]\n  server role = standalone server\n  server min protocol = SMB2\n  map to guest = Never\n  netbios name = docker-files\n  netbios aliases = docker-files\n  smb ports = 445\n[verify]\n  path = /share\n  read only = no\n  valid users = proof\nCONF\nexec smbd --foreground --no-process-group --debug-stdout\n";
      await docker(["run", "--detach", "--name", fixtureName, "--publish", "0.0.0.0:14445:445/tcp", "--env", "SMB_FIXTURE_PASSWORD=" + password, "nginx:alpine", "/bin/sh", "-c", setup]);
    }
    const hostIp = (await production.proxmox.inspectLxc(vmid)).ip;
    for (let attempt = 0; !await probeTcp(hostIp, 14445) && attempt < 90; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.equal(await probeTcp(hostIp, 14445), true, "SMB fixture did not become reachable");
    originalApplications = await appSnapshot();
    const discovered = (await cli(["docker", "inspect", "acceptance", "--json"])).discovery;
    assert.equal(discovered.truncated, false);
    const web = discovered.candidates.find((candidate) => candidate.name === "standalone" && candidate.hostPort === 8080 && candidate.selectable);
    const compose = discovered.candidates.find((candidate) => candidate.application === "acceptance/web" && candidate.selectable);
    const smb = discovered.candidates.find((candidate) => candidate.name === fixtureName && candidate.hostPort === 14445 && candidate.selectable);
    assert.ok(web && compose && smb);
    const selected = (candidate, hostname, protocol) => ["exposure", "publish", "--source", "docker", "--docker-binding", "acceptance", "--docker-application", candidate.application, "--docker-endpoint", candidate.endpointId, "--hostname", hostname, "--protocol", protocol, "--tailnet", "false"];
    const runTag = env.NOMINA_DOCKER_EXPOSURE_RUN_TAG ?? "";
    const webHostname = "docker-web" + runTag + "." + domain;
    report.phase = "review Docker web endpoint";
    const reviewBefore = fs.readFileSync(project.configPath);
    const reviewed = await cli([...selected(web, resume ? "docker-review" + runTag + "." + domain : webHostname, "https"), "--review-only"]);
    assert.match(reviewed.stdout, /No exposure published/);
    assert.deepEqual(fs.readFileSync(project.configPath), reviewBefore);
    report.checks.review = "scripted review left configuration unchanged";
    report.phase = "publish Docker web endpoint";
    const publishedWeb = await publish(web, webHostname, "https", selected(web, webHostname, "https"));
    if (!publishedWeb.resumed) assert.equal(publishedWeb.health.status, "healthy");
    assert.equal(Number(publishedWeb.managedService.exposure.backend.port), 8080);
    report.phase = "request client HTTPS";
    const response = await requestWeb(report.proxy.ip, webHostname);
    assert.equal(response.status, 200); assert.match(response.body, /Welcome to nginx/);
    const redirect = await requestWeb(report.proxy.ip, webHostname, 80, false);
    assert.equal(redirect.status, 308); assert.equal(redirect.location, "https://" + webHostname + "/");
    report.checks.web = "HTTPS nginx response through discovered host port 8080; untrusted certificate as configured";
    await assert.rejects(cli([...selected(web, webHostname, "https"), "--yes"]), /already exists/);
    report.checks.existingHostname = "rejected without overwrite";
    const overrideName = "docker-override" + runTag + "." + domain;
    report.phase = "publish explicit backend override";
    const override = await publish(web, overrideName, "https", [...selected(web, overrideName, "https"), "--backend-port", String(compose.hostPort)], compose.hostPort);
    if (!override.resumed) assert.match(override.stdout, /explicit override/);
    assert.equal(Number(override.managedService.exposure.backend.port), compose.hostPort);
    assert.equal((await requestWeb(report.proxy.ip, overrideName)).status, 200);
    report.checks.override = "explicit Compose replica host-port override persisted and served";
    const tcpHostname = "docker-tcp." + domain;
    report.phase = "publish generic TCP";
    const tcp = await publish(web, tcpHostname, "tcp", [...selected(web, tcpHostname, "tcp"), "--listener-port", "18080"], web.hostPort, 18080);
    if (!tcp.resumed) assert.equal(tcp.health.status, "healthy");
    const tcpResponse = await requestWeb(report.proxy.ip, tcpHostname, 18080, false);
    assert.equal(tcpResponse.status, 200); assert.match(tcpResponse.body, /Welcome to nginx/);
    await assert.rejects(cli([...selected(web, "docker-collision." + domain, "tcp"), "--listener-port", "18080", "--yes"]), /conflict|already owned/i);
    report.checks.tcp = "raw TCP HTTP bytes through listener 18080; duplicate listener rejected";
    const smbHostname = "docker-files." + domain;
    report.phase = "publish SMB preset";
    const publishedSmb = await publish(smb, smbHostname, "smb", selected(smb, smbHostname, "smb"), smb.hostPort, 445);
    if (!publishedSmb.resumed) assert.equal(publishedSmb.health.status, "healthy");
    assert.equal(Number(publishedSmb.managedService.exposure.listenerPort), 445);
    assert.equal(Number(publishedSmb.managedService.exposure.backend.port), 14445);
    const password = fs.readFileSync(passwordFile, "utf8");
    const authFile = path.join(directory, "smb-auth");
    fs.writeFileSync(authFile, "username = proof\npassword = " + password + "\n", { mode: 0o600 });
    // Client auth is a separate application-level check; it does not become exposure health.
    const authInCt = "/tmp/nomina-issue33-smb-auth";
    await production.proxmox.pctExec(vmid, { binary: "/bin/sh", args: ["-s"], stdin: "umask 077\ncat > " + authInCt + " <<'NOMINA_AUTH'\n" + fs.readFileSync(authFile, "utf8") + "NOMINA_AUTH\n", timeoutMs: 10000, maxOutputBytes: 1024 });
    const client = async (args) => production.proxmox.pctExec(vmid, { binary: "/usr/bin/docker", args: ["exec", fixtureName, "smbclient", ...args], timeoutMs: 15000, maxOutputBytes: 4096 });
    // Feed the auth file to the fixture without putting the password in client argv.
    await docker(["cp", authInCt, fixtureName + ":/tmp/auth"]);
    report.phase = "authenticate SMB through hostname and port 445";
    const listing = await client(["//" + smbHostname + "/verify", "-A", "/tmp/auth", "-m", "SMB3", "-c", "ls"]);
    assert.match(listing.stdout, /proof.txt/);
    const content = await client(["//" + smbHostname + "/verify", "-A", "/tmp/auth", "-m", "SMB3", "-c", "get proof.txt /tmp/proof-downloaded"]);
    assert.equal(content.exitCode ?? 0, 0);
    const downloaded = await docker(["exec", fixtureName, "cat", "/tmp/proof-downloaded"]);
    assert.equal(downloaded.stdout.trim(), "Docker SMB proof");
    await assert.rejects(client(["//" + smbHostname + "/verify", "-N", "-U", "%", "-c", "ls"]));
    // Transient test auth/content files are outside product ownership.
    await docker(["exec", fixtureName, "rm", "-f", "/tmp/auth", "/tmp/proof-downloaded"]);
    await production.proxmox.pctExec(vmid, { binary: "/bin/rm", args: ["-f", authInCt], timeoutMs: 10000, maxOutputBytes: 1024 });
    fs.rmSync(authFile);
    report.checks.smb = "SMB3 authenticated listing/read and anonymous rejection through client 445 to Docker host 14445";
    assert.equal(await appSnapshot(), originalApplications, "Publication changed Docker configuration");
    const exposures = loadProject(filesystem, directory).config.managedInventory.services;
    await cli(["docker", "disconnect", "acceptance", "--yes"]);
    assert.deepEqual(loadProject(filesystem, directory).config.managedInventory.services, exposures);
    assert.equal((await requestWeb(report.proxy.ip, webHostname)).status, 200);
    report.checks.disconnect = "existing exposure still serves after binding removal";
    report.checks.dockerPreservation = "container/network/volume inspect digest unchanged by publication/disconnection";
  } catch (error) { report.failure = error.message; throw error; }
  finally {
    for (const [file, hash] of retainedHashes) assert.equal(digest(fs.readFileSync(file)), hash, "Retained project changed");
    for (const ct of existing) {
      assert.equal(digest((await runner.run({ binary: "/usr/sbin/pct", args: ["config", String(ct.vmid)] })).stdout), configs.get(ct.vmid), "Existing CT configuration changed");
      assert.equal(await production.proxmox.lxcStatus(ct.vmid), ct.status, "Existing CT status changed");
    }
    report.checks.retainedLab = "retained project hashes and existing CT configuration/status preserved";
    fs.writeFileSync(path.join(directory, "evidence.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log("Retained Docker exposure evidence: " + path.join(directory, "evidence.json"));
  }
});
