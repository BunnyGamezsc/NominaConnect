// Read-only audit. Never print credentials or complete API response bodies.
import fs from "node:fs";
import assert from "node:assert/strict";
import { createHttpClient, createLocalSecretResolver, createProductionAdapters } from "../../src/adapter-runtime.js";
import { loadProject } from "../../src/config.js";
import { countAccessRules } from "./tailnet-policy.js";

assert.equal(process.env.NOMINA_READINESS, "1");
assert.equal(process.getuid(), 0);
const project = loadProject({ exists: fs.existsSync, read: target => fs.readFileSync(target, "utf8") }, process.argv[2]);
assert.ok(Object.values(project.state.providerReferences).some(ref => ref.vmid === 103 && ref.ip === "192.168.1.57"),
  "This helper is scoped to the retained bunnytest installation");
const resolver = createLocalSecretResolver();
const dnsId = project.config.managedInventory.platform.dns.id;
const dnsSecretReference = project.config.connectionSecretReferences[dnsId];
const dnsSecret = resolver.resolve(dnsSecretReference);
const token = fs.readFileSync("/root/tskey/api", "utf8").trim();
const client = createHttpClient();
const api = async route => {
  const response = await client.request({ method: "GET", url: `https://api.tailscale.com/api/v2${route}`,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, redactions: [token] });
  assert.equal(response.status, 200, `Tailscale audit ${route} failed`);
  return JSON.parse(response.body);
};
const devices = await api("/tailnet/-/devices");
const policy = await api("/tailnet/-/acl");
const nameservers = await api("/tailnet/-/dns/nameservers");
const gatewayPreferences = JSON.parse((await createProductionAdapters().proxmox.pctExec(103,
  { binary: "/usr/bin/tailscale", args: ["debug", "prefs"] })).stdout);
assert.deepEqual(gatewayPreferences.AdvertiseRoutes ?? [], [], "Retained gateway must not advertise a LAN subnet");
const loginUrl = new URL("http://192.168.1.53:5380/api/user/login");
loginUrl.searchParams.set("user", "admin");
loginUrl.searchParams.set("pass", dnsSecret);
const login = await client.request({ method: "GET", url: loginUrl.href, headers: {}, redactions: [dnsSecret, encodeURIComponent(dnsSecret)] });
const session = JSON.parse(login.body);
assert.equal(session.status, "ok", "Stored Technitium credential must authenticate");
const logoutUrl = new URL("http://192.168.1.53:5380/api/user/logout");
logoutUrl.searchParams.set("token", session.token);
const logout = await client.request({ method: "GET", url: logoutUrl.href, headers: {}, redactions: [session.token, encodeURIComponent(session.token)] });
assert.equal(JSON.parse(logout.body).status, "ok", "Audit login session must be closed");
const result = { time: new Date().toISOString(),
  technitiumDefaultAdminPassword: dnsSecret === "admin", technitiumCredentialVerified: true,
  dnsReadPermissionVerified: true, nameservers: nameservers.dns,
  advertisedRoutes: gatewayPreferences.AdvertiseRoutes ?? [],
  accessRuleCount: countAccessRules(policy),
  broadAllowRule: (policy.acls?.some(rule => rule.action === "accept" && (rule.src ?? rule.users)?.includes("*") && (rule.dst ?? rule.ports)?.includes("*:*") ) ?? false)
    || (policy.grants?.some(rule => rule.src?.includes("*") && rule.dst?.includes("*") && rule.ip?.includes("*")) ?? false),
  devices: devices.devices.map(device => ({ id: device.id, hostname: device.hostname,
    addresses: device.addresses, lastSeen: device.lastSeen, expires: device.expires,
    keyExpiryDisabled: device.keyExpiryDisabled, authorized: device.authorized })) };
const target = `${process.argv[2]}/.nomina/tailnet-readiness-audit.json`;
fs.writeFileSync(target, JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify(result));
