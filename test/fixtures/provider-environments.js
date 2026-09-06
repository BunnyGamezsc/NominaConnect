// ---------------------------------------------------------------------------
// A disposable stand-in for a Proxmox host and the initial platform catalog.
//
// It exists so one conformance suite can drive the *production* adapter set —
// the same composition `nomina` wires on a real host — instead of fakes that
// only implement the shape of the contract. Everything below answers the way
// the real thing answers: Technitium refuses an unauthenticated call, Caddy's
// admin API serves the live config tree, Traefik reports only what its file
// provider loaded, the VPN clients speak through `pct exec`, and every
// provider can be taken offline, drifted, duplicated, or emptied so the suite
// can assert what NominaConnect does about it.
//
// Nothing here may be mutated by NominaConnect except through a provider's own
// documented write path; unmanaged resources are snapshotted so the suite can
// prove they were preserved.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import { createProductionAdapters } from "../../src/adapter-runtime.js";

export const ZONE = "bunnyhome.test";
export const EXPOSED_HOSTNAME = `photos.${ZONE}`;
export const UNMANAGED_HOSTNAME = `legacy.${ZONE}`;
export const BACKEND = Object.freeze({ ip: "10.0.0.80", port: 8080 });

export const PROVIDER_LAYOUT = Object.freeze({
  technitium: { platformKey: "dns", vmid: 120, ip: "10.0.0.53", managedItemId: "nc_dns_test" },
  caddy: { platformKey: "reverseProxy", vmid: 121, ip: "10.0.0.54", managedItemId: "nc_proxy_test" },
  traefik: { platformKey: "reverseProxy", vmid: 122, ip: "10.0.0.55", managedItemId: "nc_proxy_test" },
  "step-ca": { platformKey: "certificateAuthority", vmid: 123, ip: "10.0.0.56", managedItemId: "nc_ca_test" },
  "caddy-internal-ca": { platformKey: "certificateAuthority", vmid: 121, ip: "10.0.0.54", managedItemId: "nc_ca_test" },
  tailscale: { platformKey: "vpn", vmid: 124, ip: "10.0.0.57", managedItemId: "nc_vpn_test" },
  netbird: { platformKey: "vpn", vmid: 125, ip: "10.0.0.58", managedItemId: "nc_vpn_test" }
});

export const TAILSCALE_AUTH_KEY = "tskey-auth-kbNq7CNTRL-3rZ8pXvVaLid";
export const NETBIRD_SETUP_KEY = "A616097E-FCF0-11EF-9354-770F4FF10EB9";

class Unreachable extends Error {
  constructor(url) {
    super(`Request to ${url} failed: connection refused.`);
    this.name = "HttpRequestError";
    this.unreachable = true;
  }
}

class ExecFailure extends Error {
  constructor(command, result) {
    super(`${command.binary} ${command.args.join(" ")} exited with status ${result.exitCode}. ${result.stderr}`.trim());
    this.name = "CommandExecutionError";
    this.result = result;
  }
}

const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });

// ---------------------------------------------------------------------------
// Technitium DNS Server
// ---------------------------------------------------------------------------

class FakeTechnitium {
  constructor() {
    this.password = "technitium-admin-secret";
    this.tokens = new Set();
    this.reachable = true;
    this.records = [
      { name: ZONE, type: "SOA", rData: { primaryNameServer: `ns1.${ZONE}` } },
      { name: EXPOSED_HOSTNAME, type: "A", rData: { ipAddress: PROVIDER_LAYOUT.caddy.ip } },
      { name: UNMANAGED_HOSTNAME, type: "A", rData: { ipAddress: "10.0.0.9" } }
    ];
    this.unmanagedSnapshot = JSON.stringify(this.#unmanaged());
  }

  #unmanaged() {
    return this.records.filter((record) => record.name === UNMANAGED_HOSTNAME);
  }

  preservedUnmanaged() {
    return JSON.stringify(this.#unmanaged()) === this.unmanagedSnapshot;
  }

  stop() { this.reachable = false; }
  start() { this.reachable = true; }

  // A direct edit in Technitium's own UI: the record keeps its zone, name and
  // type, so its locator still resolves while its value moves.
  drift() {
    this.records.find((record) => record.name === EXPOSED_HOSTNAME).rData.ipAddress = "10.0.0.99";
  }

  duplicate() {
    this.records.push({ name: EXPOSED_HOSTNAME, type: "A", rData: { ipAddress: "10.0.0.77" } });
  }

  removeManaged() {
    this.records = this.records.filter((record) => record.name !== EXPOSED_HOSTNAME);
  }

  request({ url }) {
    if (!this.reachable) {
      throw new Unreachable(url);
    }
    const target = new URL(url);
    const path = target.pathname;
    if (path === "/api/user/login") {
      if (target.searchParams.get("pass") !== this.password) {
        return { status: 200, body: JSON.stringify({ status: "error", errorMessage: "Invalid username or password." }) };
      }
      const token = `session-${this.tokens.size + 1}`;
      this.tokens.add(token);
      return { status: 200, body: JSON.stringify({ status: "ok", token }) };
    }
    if (path === "/api/zones/list") {
      return { status: 200, body: JSON.stringify({ status: "ok", response: { zones: [{ name: ZONE, type: "Primary" }] } }) };
    }
    if (path === "/api/zones/records/get") {
      return { status: 200, body: JSON.stringify({ status: "ok", response: { records: structuredClone(this.records) } }) };
    }
    if (path === "/api/user/session/get") {
      return { status: 200, body: JSON.stringify({ status: "ok", response: {} }) };
    }
    if (path === "/api/zones/create") {
      return { status: 200, body: JSON.stringify({ status: "ok" }) };
    }
    return { status: 200, body: JSON.stringify({ status: "error", errorMessage: `Unsupported path ${path}.` }) };
  }
}

// ---------------------------------------------------------------------------
// Caddy — live configuration through the local Admin API
// ---------------------------------------------------------------------------

function caddyRoute(host, dial) {
  return {
    "@id": host,
    match: [{ host: [host] }],
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial }] }],
    terminal: true
  };
}

class FakeCaddy {
  constructor() {
    this.reachable = true;
    this.routes = [
      caddyRoute(EXPOSED_HOSTNAME, `${BACKEND.ip}:${BACKEND.port}`),
      caddyRoute(`existing.${ZONE}`, "10.0.0.7:80")
    ];
    this.policies = [];
    this.unmanagedSnapshot = JSON.stringify(this.#unmanaged());
  }

  #unmanaged() {
    return this.routes.filter((route) => route["@id"] === `existing.${ZONE}`);
  }

  preservedUnmanaged() {
    return JSON.stringify(this.#unmanaged()) === this.unmanagedSnapshot;
  }

  stop() { this.reachable = false; }
  start() { this.reachable = true; }

  // An operator repointing a managed route in Caddy's own configuration.
  drift() {
    this.routes.find((route) => route["@id"] === EXPOSED_HOSTNAME)
      .handle[0].upstreams[0].dial = "10.0.0.90:9090";
  }

  duplicate() {
    this.routes.push(caddyRoute(EXPOSED_HOSTNAME, "10.0.0.91:9091"));
  }

  removeManaged() {
    this.routes = this.routes.filter((route) => route["@id"] !== EXPOSED_HOSTNAME);
  }

  request({ url, method = "GET" }) {
    if (!this.reachable) {
      throw new Unreachable(url);
    }
    const path = new URL(url).pathname.replace(/\/$/, "");
    if (method !== "GET") {
      return { status: 405, body: "" };
    }
    if (path === "/config") {
      return { status: 200, body: JSON.stringify({ apps: { http: { servers: { srv_https: { routes: this.routes } } } } }) };
    }
    if (path === "/config/apps/http/servers/srv_https/routes") {
      return { status: 200, body: JSON.stringify(structuredClone(this.routes)) };
    }
    if (path === "/config/apps/tls/automation/policies") {
      return { status: 200, body: JSON.stringify(structuredClone(this.policies)) };
    }
    return { status: 404, body: JSON.stringify({ error: `not found: ${path}` }) };
  }
}

// ---------------------------------------------------------------------------
// Traefik — a watched dynamic-file directory, observed through its API
// ---------------------------------------------------------------------------

function traefikRouter(name, host) {
  return {
    name: `${name}@file`,
    provider: "file",
    rule: `Host(\`${host}\`)`,
    service: `${name}@file`,
    entryPoints: ["websecure"],
    tls: {},
    status: "enabled"
  };
}

function traefikService(name, url) {
  return { name: `${name}@file`, provider: "file", loadBalancer: { servers: [{ url }] } };
}

class FakeTraefik {
  constructor() {
    this.reachable = true;
    this.routers = [
      traefikRouter(`nomina-${EXPOSED_HOSTNAME}`, EXPOSED_HOSTNAME),
      traefikRouter("operator-owned", `nas.${ZONE}`)
    ];
    this.services = [
      traefikService(`nomina-${EXPOSED_HOSTNAME}`, `http://${BACKEND.ip}:${BACKEND.port}`),
      traefikService("operator-owned", "http://10.0.0.7:80")
    ];
    this.unmanagedSnapshot = JSON.stringify(this.#unmanaged());
  }

  #unmanaged() {
    return [
      this.routers.filter((router) => router.name.startsWith("operator-owned")),
      this.services.filter((service) => service.name.startsWith("operator-owned"))
    ];
  }

  preservedUnmanaged() {
    return JSON.stringify(this.#unmanaged()) === this.unmanagedSnapshot;
  }

  stop() { this.reachable = false; }
  start() { this.reachable = true; }

  // A direct edit to the watched fragment: Traefik reloads it and reports the
  // new backend as the effective configuration.
  drift() {
    this.services.find((service) => service.name === `nomina-${EXPOSED_HOSTNAME}@file`)
      .loadBalancer.servers[0].url = "http://10.0.0.90:9090";
  }

  duplicate() {
    this.routers.push({
      ...traefikRouter("nomina-duplicate", EXPOSED_HOSTNAME),
      service: `nomina-${EXPOSED_HOSTNAME}@file`
    });
  }

  removeManaged() {
    this.routers = this.routers.filter((router) => router.name !== `nomina-${EXPOSED_HOSTNAME}@file`);
  }

  request({ url }) {
    if (!this.reachable) {
      throw new Unreachable(url);
    }
    const path = new URL(url).pathname;
    if (path === "/api/overview") {
      return { status: 200, body: JSON.stringify({ http: { routers: { total: this.routers.length } } }) };
    }
    if (path === "/api/http/routers") {
      return { status: 200, body: JSON.stringify(structuredClone(this.routers)) };
    }
    if (path === "/api/http/services") {
      return { status: 200, body: JSON.stringify(structuredClone(this.services)) };
    }
    return { status: 404, body: JSON.stringify({ error: `not found: ${path}` }) };
  }
}

// ---------------------------------------------------------------------------
// step-ca
// ---------------------------------------------------------------------------

class FakeStepCa {
  constructor() {
    this.reachable = true;
    this.provisioners = [
      { name: "admin", type: "JWK" },
      { name: "acme", type: "ACME" }
    ];
    this.unmanagedSnapshot = JSON.stringify(this.#unmanaged());
  }

  #unmanaged() {
    return this.provisioners.filter((provisioner) => provisioner.name === "acme");
  }

  preservedUnmanaged() {
    return JSON.stringify(this.#unmanaged()) === this.unmanagedSnapshot;
  }

  stop() { this.reachable = false; }
  start() { this.reachable = true; }

  drift() {
    this.provisioners.find((provisioner) => provisioner.name === "admin").type = "OIDC";
  }

  duplicate() {
    this.provisioners.push({ name: "admin", type: "JWK" });
  }

  removeManaged() {
    this.provisioners = this.provisioners.filter((provisioner) => provisioner.name !== "admin");
  }

  request({ url }) {
    if (!this.reachable) {
      throw new Unreachable(url);
    }
    const path = new URL(url).pathname;
    if (path === "/health") {
      return { status: 200, body: JSON.stringify({ status: "ok" }) };
    }
    if (path === "/admin/provisioners") {
      return { status: 200, body: JSON.stringify({ provisioners: structuredClone(this.provisioners) }) };
    }
    if (path === "/acme/acme/directory") {
      return { status: 200, body: JSON.stringify({ newOrder: "https://step-ca/acme/acme/new-order" }) };
    }
    if (path === "/roots.pem") {
      return { status: 200, body: "-----BEGIN CERTIFICATE-----\nnomina\n-----END CERTIFICATE-----\n" };
    }
    return { status: 404, body: JSON.stringify({ error: `not found: ${path}` }) };
  }
}

// ---------------------------------------------------------------------------
// Tailscale and NetBird — CLI clients inside their own service LXC
// ---------------------------------------------------------------------------

class FakeVpnLxc {
  /** @param {{ binary: string, unit: string }} options */
  constructor({ binary, unit }) {
    this.binary = binary;
    this.unit = unit;
    this.tun = true;
    this.installed = true;
    this.daemonActive = true;
    this.enrolled = true;
    this.hostname = unit === "tailscaled" ? "tailscale" : "netbird";
    this.files = new Map();
    this.commands = [];
    this.peersSnapshot = JSON.stringify(this.peers());
  }

  // Supplied by each client: the peers the provider reports and the client
  // command surface. Declared here so the shared exec path can reach them.
  /** @returns {any} */
  peers() { return {}; }
  /** @param {any} _command @returns {any} */
  runClient(_command) { return ok(""); }

  preservedUnmanaged() {
    return JSON.stringify(this.peers()) === this.peersSnapshot;
  }

  stop() { this.daemonActive = false; this.enrolled = false; }
  start() { this.daemonActive = true; this.enrolled = true; }

  exec(command) {
    this.commands.push(command);
    if (command.binary === "/usr/bin/apt-get") {
      return ok("");
    }
    if (command.binary === "/bin/rm") {
      for (const target of command.args.filter((argument) => !argument.startsWith("-"))) {
        this.files.delete(target);
      }
      return ok("");
    }
    if (command.binary === "/bin/bash" && command.args[0] === "-c") {
      const script = command.args[1];
      if (script.includes("systemctl is-active")) {
        return ok(this.daemonActive ? "active\n" : "inactive\n");
      }
      if (script.includes("/dev/net/tun")) {
        return ok(this.tun ? "nomina-tun-ok\n" : "nomina-tun-missing\n");
      }
      if (command.stdin !== undefined) {
        this.files.set(script.split(">").pop().trim(), command.stdin);
      }
      return ok("");
    }
    if (command.binary === this.binary) {
      return this.runClient(command);
    }
    return ok("");
  }
}

class FakeTailscale extends FakeVpnLxc {
  constructor() {
    super({ binary: "/usr/bin/tailscale", unit: "tailscaled" });
    this.nodeId = "nodeSELF01";
    this.dnsName = `${this.hostname}.tail1a2b.ts.net.`;
    this.extraPeers = [];
  }

  peers() {
    return {
      peerFRIEND1: {
        ID: "peerFRIEND1",
        HostName: "sarah-laptop",
        DNSName: "sarah-laptop.tail1a2b.ts.net.",
        TailscaleIPs: ["100.64.0.9"],
        Online: true
      }
    };
  }

  // Renaming a node in the Tailscale admin console keeps its stable node id.
  drift() {
    this.hostname = "vpn-gateway";
    this.dnsName = "vpn-gateway.tail1a2b.ts.net.";
  }

  duplicate() {
    this.extraPeers.push({
      ID: this.nodeId,
      HostName: this.hostname,
      DNSName: this.dnsName,
      TailscaleIPs: ["100.64.0.6"],
      Online: true
    });
  }

  removeManaged() { this.enrolled = false; }

  statusDocument() {
    return {
      BackendState: this.enrolled ? "Running" : "NeedsLogin",
      Version: "1.90.0",
      CurrentTailnet: { Name: "bunny.ts.net" },
      ...(this.enrolled
        ? {
            Self: {
              ID: this.nodeId,
              HostName: this.hostname,
              DNSName: this.dnsName,
              TailscaleIPs: ["100.64.0.5"],
              Online: true
            }
          }
        : {}),
      Peer: { ...this.peers(), ...Object.fromEntries(this.extraPeers.map((peer, index) => [`extra${index}`, peer])) }
    };
  }

  runClient(command) {
    if (command.args[0] === "status") {
      const document = JSON.stringify(this.statusDocument());
      return this.enrolled ? ok(document) : new ExecFailure(command, { exitCode: 1, stdout: document, stderr: "" });
    }
    if (command.args[0] === "up") {
      this.enrolled = this.files.get("/run/nomina-tailscale.authkey")?.trim() === TAILSCALE_AUTH_KEY;
      return this.enrolled ? ok("") : new ExecFailure(command, { exitCode: 1, stdout: "", stderr: "invalid key" });
    }
    return ok("");
  }
}

class FakeNetBird extends FakeVpnLxc {
  constructor() {
    super({ binary: "/usr/bin/netbird", unit: "netbird" });
    this.publicKey = "gL5xQ3nJmVh0Nk1sVBrqPcJvV6yQ4dQ0oXxk8dR3vBc=";
    this.fqdn = "netbird.netbird.cloud";
    this.extraPeers = [];
  }

  peers() {
    return [
      {
        fqdn: "sarah-laptop.netbird.cloud",
        publicKey: "peerLAPTOPr8mQd1sVBrqPcJvV6yQ4dQ0oXxk8dR3vBc=",
        netbirdIp: "100.92.0.9",
        status: "Connected"
      }
    ];
  }

  // Renaming a peer in the NetBird dashboard keeps its stable public key.
  drift() { this.fqdn = "vpn-gateway.netbird.cloud"; }

  duplicate() {
    this.extraPeers.push({
      fqdn: this.fqdn,
      publicKey: this.publicKey,
      netbirdIp: "100.92.0.6",
      status: "Connected"
    });
  }

  removeManaged() { this.enrolled = false; }

  statusDocument() {
    return {
      daemonStatus: this.enrolled ? "Connected" : "NeedsLogin",
      daemonVersion: "0.60.0",
      management: { url: "https://api.netbird.io:443", connected: this.enrolled, error: "" },
      signal: { url: "https://signal.netbird.io:443", connected: this.enrolled, error: "" },
      netbirdIp: this.enrolled ? "100.92.0.5/16" : "",
      publicKey: this.enrolled ? this.publicKey : "",
      fqdn: this.enrolled ? this.fqdn : "",
      peers: { details: [...this.peers(), ...this.extraPeers] }
    };
  }

  runClient(command) {
    if (command.args[0] === "status") {
      if (!this.enrolled) {
        return ok("Daemon status: NeedsLogin\n\nRun UP command to log in with SSO or setup keys.");
      }
      return ok(JSON.stringify(this.statusDocument()));
    }
    if (command.args[0] === "up") {
      this.enrolled = this.files.get("/run/nomina-netbird.setupkey")?.trim() === NETBIRD_SETUP_KEY;
      return this.enrolled ? ok("") : new ExecFailure(command, { exitCode: 1, stdout: "", stderr: "invalid setup key" });
    }
    return ok("");
  }
}

// ---------------------------------------------------------------------------
// The disposable environment
// ---------------------------------------------------------------------------

export function createConformanceEnvironment() {
  const providers = {
    technitium: new FakeTechnitium(),
    caddy: new FakeCaddy(),
    traefik: new FakeTraefik(),
    "step-ca": new FakeStepCa(),
    tailscale: new FakeTailscale(),
    netbird: new FakeNetBird()
  };
  providers["caddy-internal-ca"] = providers.caddy;

  const byPort = new Map(/** @type {[string, any][]} */ ([
    ["5380", providers.technitium],
    ["2019", providers.caddy],
    ["8080", providers.traefik],
    ["9000", providers["step-ca"]]
  ]));
  const byVmid = new Map(/** @type {[string, any][]} */ ([
    [String(PROVIDER_LAYOUT.tailscale.vmid), providers.tailscale],
    [String(PROVIDER_LAYOUT.netbird.vmid), providers.netbird]
  ]));

  const hostCommands = [];
  const httpRequests = [];

  const httpClient = {
    async request(request) {
      httpRequests.push(request);
      const provider = byPort.get(new URL(request.url).port);
      if (provider === undefined) {
        throw new Unreachable(request.url);
      }
      return provider.request(request);
    }
  };

  const secrets = new Map(/** @type {[string, string][]} */ ([
    [`nominaconnect/provider/${PROVIDER_LAYOUT.technitium.managedItemId}`, providers.technitium.password],
    [`nominaconnect/provider/${PROVIDER_LAYOUT.caddy.managedItemId}`, "caddy-admin-secret"],
    [`nominaconnect/provider/${PROVIDER_LAYOUT["step-ca"].managedItemId}`, "step-ca-secret"],
    [`nominaconnect/provider/${PROVIDER_LAYOUT.tailscale.managedItemId}`, TAILSCALE_AUTH_KEY]
  ]));
  // Tailscale and NetBird share the vpn managed-item id, so the stored
  // credential is whichever client the project selected. Tests swap it.
  const secretResolver = {
    resolve(reference) {
      if (!secrets.has(reference)) {
        throw new Error(`No connection secret is stored for ${reference}.`);
      }
      return secrets.get(reference);
    }
  };
  const secretStore = {
    locate: (reference) => `/var/lib/nominaconnect/secrets/${reference}`,
    has: (reference) => secrets.has(reference),
    store: (reference, content) => secrets.set(reference, content.trim())
  };

  const commandRunner = {
    async run(command) {
      hostCommands.push(command);
      if (command.binary === "/usr/sbin/pct" && command.args[0] === "exec") {
        const vmid = command.args[1];
        const separator = command.args.indexOf("--");
        const inner = {
          binary: command.args[separator + 1],
          args: command.args.slice(separator + 2),
          ...(command.stdin === undefined ? {} : { stdin: command.stdin })
        };
        const lxc = byVmid.get(vmid);
        if (lxc === undefined) {
          return ok("");
        }
        const result = lxc.exec(inner);
        if (result instanceof Error) {
          throw result;
        }
        return result;
      }
      if (command.binary === "/usr/sbin/pct" && command.args[0] === "list") {
        return ok(["VMID STATUS NAME", ...[...byVmid.keys()].map((vmid) => `${vmid} running lxc-${vmid}`)].join("\n"));
      }
      return ok("");
    }
  };

  const adapters = createProductionAdapters({ commandRunner, secretResolver, secretStore, httpClient });

  return {
    providers,
    adapters,
    providerAdapters: adapters.providerAdapters,
    proxmox: adapters.proxmox,
    hostCommands,
    httpRequests,
    secrets,
    useNetBirdCredential() {
      secrets.set(`nominaconnect/provider/${PROVIDER_LAYOUT.netbird.managedItemId}`, NETBIRD_SETUP_KEY);
    }
  };
}

// The inspection/health context the CLI and background tracking build for one
// catalog provider. Keeping it here means the conformance suite and the
// background-adoption suite ask for provider state the same way.
export function contextFor(provider, { providerReferences = [] } = {}) {
  const layout = PROVIDER_LAYOUT[provider];
  return {
    providerReferences,
    connectionSecretReference: `nominaconnect/provider/${layout.managedItemId}`,
    ip: layout.ip,
    vmid: layout.vmid,
    zone: ZONE
  };
}

export function managedItemFor(provider) {
  return { id: PROVIDER_LAYOUT[provider].managedItemId, service: provider };
}

export function fingerprintOf(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
