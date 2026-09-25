import test from "node:test";
import assert from "node:assert/strict";

import { spawnSync } from "node:child_process";
import { createTailnetController, dnsInstallScript, DNS_RELAY, firewallInstallScript } from "../src/tailscale-tailnet.js";
import { buildFragment } from "../src/traefik-adapter.js";
import { parseProjectConfiguration, serializeProjectConfiguration } from "../src/config.js";

function fakeTailnet({ splitDns = {} } = {}) {
  const calls = [];
  const state = {
    nameservers: { dns: ["1.1.1.1"] },
    preferences: { magicDNS: true, overrideLocalDNS: false }
  };
  const httpClient = {
    async request(request) {
      calls.push({ method: request.method, path: new URL(request.url).pathname, body: request.body && JSON.parse(request.body) });
      assert.equal(request.headers.Authorization, "Bearer secret-token");
      const path = new URL(request.url).pathname;
      if (path.endsWith("/dns/split-dns")) {
        return { status: 200, body: JSON.stringify(splitDns) };
      }
      if (path.endsWith("/dns/nameservers")) {
        if (request.method === "POST") state.nameservers = JSON.parse(request.body);
        return { status: 200, body: JSON.stringify(state.nameservers) };
      }
      if (path.endsWith("/dns/preferences")) {
        if (request.method === "POST") state.preferences = JSON.parse(request.body);
        return { status: 200, body: JSON.stringify(state.preferences) };
      }
      throw new Error(`Unexpected API path ${path}`);
    }
  };
  const controller = createTailnetController({
    httpClient,
    secretResolver: { resolve: () => "secret-token" },
    exec: async (vmid, command) => {
      calls.push({ vmid, command });
      assert.equal(vmid, 120);
      if (command.binary === "/usr/bin/tailscale" && command.args[0] === "ip") {
        return { stdout: "100.70.80.90\n" };
      }
    }
  });
  return { controller, calls, state };
}

const REQUEST = {
  vmid: 120,
  dnsIp: "192.168.1.90",
  proxyIp: "192.168.1.86",
  zone: "bunny.internal",
  adminSecretReference: "nominaconnect/tailscale-admin/vpn"
};

test("tailnet setup serves DNS and web at the gateway address without advertising LAN routes", async () => {
  const { controller, calls, state } = fakeTailnet();
  await controller.configure(REQUEST);
  const firewall = calls.find((call) => call.command?.args?.[1]?.includes("nomina-tailnet-firewall"));
  assert.ok(firewall);
  assert.match(firewall.command.args[1], /--dport 53/);
  assert.match(firewall.command.args[1], /--dports 80,443/);
  assert.doesNotMatch(firewall.command.args[1], /--dport 5380|--dport 2019|--dport 8080/);
  assert.ok(calls.indexOf(firewall) < calls.findIndex((call) => call.command?.args?.[0] === "set"));
  assert.deepEqual(calls.find((call) => call.command?.args?.[0] === "set").command.args,
    ["set", "--advertise-routes="]);
  assert.equal(calls.some((call) => call.path?.endsWith("/routes")), false);
  assert.deepEqual(state.nameservers, { dns: ["100.70.80.90"] });
  assert.deepEqual(state.preferences, { magicDNS: true, overrideLocalDNS: true });
  assert.ok(calls.some((call) => call.command?.args?.[1]?.includes("nomina-tailnet-dns.service")));
});

test("tailnet setup refuses a split resolver that would bypass Technitium", async () => {
  const { controller, calls } = fakeTailnet({ splitDns: { "example.com": ["1.1.1.1"] } });
  await assert.rejects(() => controller.configure(REQUEST), /split DNS uses another resolver/);
  assert.equal(calls.some((call) => call.command?.args?.[0] === "set"), false);
});

test("gateway firewall rejects non-DNS input and non-web forwarding", () => {
  const script = firewallInstallScript("192.168.1.90", "192.168.1.86", "100.70.80.90");
  const syntax = spawnSync("sh", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(script, /NOMINA_TAILNET_INPUT -j REJECT/);
  assert.match(script, /NOMINA_TAILNET_FORWARD -j REJECT/);
  assert.match(script, /DNAT --to-destination 192.168.1.86/);
  assert.match(script, /MASQUERADE/);
  assert.throws(() => firewallInstallScript("192.168.1.90; bad", "192.168.1.86", "100.70.80.90"), /IPv4/);
});

test("DNS relay preserves Technitium blocks and rewrites only managed proxy A answers", () => {
  const probe = `
import struct
def packet(name, ip, rcode=0):
    q = b"".join(bytes([len(x)]) + x.encode() for x in name.split(".")) + b"\\0\\0\\1\\0\\1"
    header = struct.pack("!HHHHHH", 1, 0x8180 | rcode, 1, 0 if rcode else 1, 0, 0)
    answer = b"" if rcode else b"\\xc0\\x0c" + struct.pack("!HHIH", 1, 1, 60, 4) + bytes(map(int, ip.split(".")))
    return struct.pack("!HHHHHH", 1, 0x0100, 1, 0, 0, 0) + q, header + q + answer
q, a = packet("app.bunny.internal", "192.168.1.86")
assert rewrite(q, a)[-4:] == bytes([100,70,80,90])
q, a = packet("app.bunny.internal", "192.168.1.86", 3)
assert rewrite(q, a) == a
q, a = packet("other.example", "192.168.1.86")
assert rewrite(q, a) == a
q, a = packet("app.bunny.internal", "192.168.1.88")
assert rewrite(q, a) == a
`;
  const source = DNS_RELAY.split("import threading")[0];
  const result = spawnSync("python3", ["-c", source + probe, "100.70.80.90", "192.168.1.90", "192.168.1.86", "bunny.internal"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const install = dnsInstallScript({ ...REQUEST, gatewayIp: "100.70.80.90" });
  const syntax = spawnSync("sh", ["-n"], { input: install, encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(install, /nomina-tailnet-dns.service/);
});

test("Traefik blocks the gateway for opted-out exposures on HTTP and HTTPS", () => {
  const blocked = buildFragment({ hostname: "home.bunny.internal", backendIp: "192.168.1.88", backendPort: 8085,
    httpRedirect: true, tailnet: false, tailnetGatewayIp: "192.168.1.91" });
  assert.equal((blocked.match(/!ClientIP\(`192\.168\.1\.91`\)/g) ?? []).length, 2);
  assert.match(blocked, /Host\(`home\.bunny\.internal`\)/);
  const allowed = buildFragment({ hostname: "home.bunny.internal", backendIp: "192.168.1.88", backendPort: 8085,
    tailnet: true, tailnetGatewayIp: "192.168.1.91" });
  assert.doesNotMatch(allowed, /ClientIP/);
});

test("exposure tailnet access survives project serialization", () => {
  const config = {
    proxmox: { node: "pve", defaultBridge: "vmbr0", defaultStorage: "local" },
    baseLocalDomain: "bunny.internal",
    managedInventory: { platform: { dns: null, reverseProxy: null, certificateAuthority: null, vpn: null },
      services: [{ id: "nc_app", name: "home", exposure: { hostname: "home.bunny.internal", protocol: "https",
        tailnet: false, backend: { ip: "192.168.1.88", port: 8085 } } }] },
    connectionSecretReferences: {}
  };
  assert.equal(parseProjectConfiguration(serializeProjectConfiguration(config)).managedInventory.services[0].exposure.tailnet, false);
});
