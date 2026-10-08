// macOS client evidence through native DNS, fresh trusted TLS and direct DNS.
import fs from "node:fs";
import dns from "node:dns/promises";
import net from "node:net";
import https from "node:https";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const mode = process.argv[2];
assert.ok(["both-on", "local-only", "disconnected"].includes(mode));
const outputDir = process.argv[3];
const ca = fs.readFileSync(`${outputDir}/step-ca-root.crt`);
const command = promisify(execFile);
const gateway = "100.109.138.62", gateway6 = "fd7a:115c:a1e0::f82f:8a3f";
const evidence = { time: new Date().toISOString(), mode, https: [], dns: [], blockedPorts: [] };
const interfaces = (await command("/sbin/ifconfig", [])).stdout;
evidence.ethernetConnected = /en8:[\s\S]*?status: active/.test(interfaces.split(/(?=\n\S)/).find(block => block.trimStart().startsWith("en8:")) ?? "");
if (mode === "disconnected") assert.equal(evidence.ethernetConnected, false, "Physically disconnect Ethernet before this check");
if (mode === "local-only") assert.equal(evidence.ethernetConnected, true);
for (const hostname of ["dns.bunnytest.internal", "pve.bunnytest.internal"]) {
  const resolution = await dns.lookup(hostname, { all: true });
  if (mode === "local-only") assert.ok(resolution.some(result => result.address === "192.168.1.54"));
  else assert.ok(resolution.some(result => result.address === gateway));
  const response = await new Promise((resolve, reject) => {
    const request = https.request({ hostname, path: `/?nomina-readiness=${Date.now()}`, ca,
      rejectUnauthorized: true, agent: false, timeout: 15_000 }, response => {
      const certificate = response.socket.getPeerCertificate();
      const result = { hostname, resolution, status: response.statusCode,
        destination: response.socket.remoteAddress, tlsVerified: response.socket.authorized,
        serial: certificate.serialNumber, expiry: certificate.valid_to };
      let body = "";
      response.on("data", chunk => { if (body.length < 1_000_000) body += chunk; });
      response.on("end", () => {
        try {
          assert.equal(result.status, 200); assert.equal(result.tlsVerified, true);
          assert.match(body, hostname.startsWith("dns.") ? /technitium/i : /proxmox/i);
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("HTTPS timed out")));
    request.end();
  });
  evidence.https.push(response);
}
const server = mode === "local-only" ? "192.168.1.53" : gateway;
for (const tcp of [false, true]) {
  for (const query of ["dns.bunnytest.internal", `nomina-${Date.now()}-${tcp}.example.com`]) {
    const answer = (await command("/usr/bin/dig", [`@${server}`, query, "A", "+time=3", "+tries=1", "+comments", "+answer", "+authority", ...(tcp ? ["+tcp"] : [])])).stdout;
    const status = answer.match(/status: (\w+)/)?.[1];
    if (query.endsWith(".example.com")) {
      // example.com currently gives authenticated NOERROR/NODATA for random
      // labels. Both negative response forms need an upstream SOA, not silence.
      assert.ok(["NOERROR", "NXDOMAIN"].includes(status));
      assert.match(answer, /\bIN\s+SOA\s/);
    } else assert.equal(status, "NOERROR", "Direct DNS must serve internal queries");
    if (!query.endsWith(".example.com")) assert.ok(answer.includes(mode === "local-only" ? "192.168.1.54" : gateway));
    evidence.dns.push({ server, tcp, query, status });
  }
}
if (mode !== "local-only") {
  const probes = [...[22, 2019, 5380, 8006].map(port => [gateway, port]), ...[22, 53, 443].map(port => [gateway6, port])];
  evidence.blockedPorts = await Promise.all(probes.map(([address, port]) => new Promise(resolve => {
    const socket = net.connect({ host: address, port });
    const finish = reachable => { socket.destroy(); resolve({ address, port, reachable }); };
    socket.setTimeout(2000, () => finish(false));
    socket.on("error", () => finish(false)); socket.on("connect", () => finish(true));
  })));
  assert.ok(evidence.blockedPorts.every(probe => !probe.reachable), "Gateway administration and IPv6 ports must remain closed");
  evidence.gatewayRoute = (await command("/sbin/route", ["-n", "get", gateway])).stdout.match(/interface: (\S+)/)?.[1];
  try {
    evidence.transport = (await command("/usr/local/bin/tailscale", ["ping", "--c", "1", "--timeout", "5s", "bunnytest"])).stdout.trim();
  } catch (error) {
    // Tailscale exits 1 when a relay pong arrives but no direct path forms.
    // HTTPS above proves the relay transport works; retain this distinction.
    assert.match(error.stdout ?? "", /^pong from bunnytest /m);
    evidence.transport = error.stdout.trim();
  }
  evidence.directPeerConnection = !evidence.transport.includes("via DERP");
  if (mode === "disconnected") {
    evidence.lanPorts = await Promise.all([["192.168.1.3", 8006], ["192.168.1.54", 443]].map(([address, port]) => new Promise(resolve => {
      const socket = net.connect({ host: address, port });
      const finish = reachable => { socket.destroy(); resolve({ address, port, reachable }); };
      socket.setTimeout(2000, () => finish(false));
      socket.on("error", () => finish(false)); socket.on("connect", () => finish(true));
    })));
    assert.ok(evidence.lanPorts.every(probe => !probe.reachable), "Disconnected client must not reach the LAN directly");
  }
}
fs.writeFileSync(`${outputDir}/readiness-${mode}.json`, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence));
