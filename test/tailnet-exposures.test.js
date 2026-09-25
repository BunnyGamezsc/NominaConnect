import test from "node:test";
import assert from "node:assert/strict";

import { createTailnetController, firewallInstallScript } from "../src/tailscale-tailnet.js";
import { buildFragment } from "../src/traefik-adapter.js";
import { parseProjectConfiguration, serializeProjectConfiguration } from "../src/config.js";

function fakeTailnet({ routeApproval = true, splitDns = {} } = {}) {
  const calls = [];
  const state = {
    routes: { advertisedRoutes: ["192.168.1.90/32", "192.168.1.86/32"], enabledRoutes: ["10.0.0.0/24"] },
    nameservers: { dns: ["1.1.1.1"] },
    preferences: { magicDNS: true, overrideLocalDNS: false }
  };
  const httpClient = {
    async request(request) {
      calls.push({ method: request.method, path: new URL(request.url).pathname, body: request.body && JSON.parse(request.body) });
      assert.equal(request.headers.Authorization, "Bearer secret-token");
      const path = new URL(request.url).pathname;
      if (path.endsWith("/routes")) {
        if (request.method === "POST") {
          if (routeApproval) state.routes.enabledRoutes = JSON.parse(request.body).routes;
          return { status: 200, body: "" };
        }
        return { status: 200, body: JSON.stringify(state.routes) };
      }
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
    }
  });
  return { controller, calls, state };
}

const REQUEST = {
  vmid: 120,
  deviceId: "nodeAAA",
  dnsIp: "192.168.1.90",
  proxyIp: "192.168.1.86",
  adminSecretReference: "nominaconnect/tailscale-admin/vpn"
};

test("tailnet setup allows DNS and web ports before enabling routes, then forces Technitium DNS", async () => {
  const { controller, calls, state } = fakeTailnet();
  await controller.configure(REQUEST);
  const firewall = calls.find((call) => call.command?.args?.[1]?.includes("nomina-tailnet-firewall"));
  assert.ok(firewall);
  assert.match(firewall.command.args[1], /--dport 53/);
  assert.match(firewall.command.args[1], /--dport 443/);
  assert.doesNotMatch(firewall.command.args[1], /--dport 5380|--dport 2019|--dport 8080/);
  assert.ok(calls.indexOf(firewall) < calls.findIndex((call) => call.command?.args?.[0] === "set"));
  assert.deepEqual(state.routes.enabledRoutes, ["10.0.0.0/24", "192.168.1.90/32", "192.168.1.86/32"]);
  assert.deepEqual(state.nameservers, { dns: ["192.168.1.90"] });
  assert.deepEqual(state.preferences, { magicDNS: true, overrideLocalDNS: true });
  assert.ok(calls.findIndex((call) => call.method === "POST" && call.path.endsWith("/routes")) <
    calls.findIndex((call) => call.method === "POST" && call.path.endsWith("/dns/nameservers")));
});

test("tailnet setup leaves DNS alone if routes were not approved", async () => {
  const { controller, calls } = fakeTailnet({ routeApproval: false });
  await assert.rejects(() => controller.configure(REQUEST), /did not approve/);
  assert.equal(calls.some((call) => call.method === "POST" && call.path?.includes("/dns/")), false);
});

test("tailnet setup refuses a split resolver that would bypass Technitium", async () => {
  const { controller, calls } = fakeTailnet({ splitDns: { "example.com": ["1.1.1.1"] } });
  await assert.rejects(() => controller.configure(REQUEST), /split DNS uses another resolver/);
  assert.equal(calls.some((call) => call.command?.args?.[0] === "set"), false);
});

test("gateway firewall rejects all tailnet forwarding beyond DNS and proxy web ports", () => {
  const script = firewallInstallScript("192.168.1.90", "192.168.1.86");
  assert.match(script, /iptables -A NOMINA_TAILNET -j REJECT/);
  assert.match(script, /Requires=nomina-tailnet-firewall.service/);
  assert.throws(() => firewallInstallScript("192.168.1.90; bad", "192.168.1.86"), /IPv4/);
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
