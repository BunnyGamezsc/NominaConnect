import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";
import { createTailscaleAdapter } from "../src/tailscale-adapter.js";

const AUTH_KEY = "tskey-auth-kbNq7CNTRL-3rZ8pXvVaLid";
const AUTH_KEY_PATH = "/run/nomina-tailscale.authkey";
const SECRET_REFERENCE = "nominaconnect/provider/nc_vpn_test";
const noSleep = () => Promise.resolve();
const proxmoxRootRuntime = () => ({ isRoot: () => true, isProxmoxHost: () => true });

class FakeFilesystem {
  files = new Map();
  directories = new Set();
  modes = new Map();

  exists(path) {
    return this.files.has(path) || this.directories.has(path);
  }

  mkdir(path) {
    this.directories.add(path);
  }

  writeFile(path, content) {
    this.files.set(path, content);
  }

  rename(from, to) {
    this.files.set(to, this.files.get(from));
    this.files.delete(from);
  }

  chmod(path, mode) {
    this.modes.set(path, mode);
  }

  read(path) {
    return this.files.get(path);
  }
}

const TAILSCALE_PROJECT = `apiVersion: nomina.connect/v0alpha1
kind: NominaConnect
proxmox:
  node: pve-1
  defaultBridge: vmbr0
  defaultStorage: local-lvm
baseLocalDomain: bunnyhome.test
managedInventory:
  platform:
    dns: null
    reverseProxy: null
    certificateAuthority: null
    vpn:
      id: nc_vpn_test
      service: tailscale
  services: []
connectionSecretReferences:
  nc_vpn_test: ${SECRET_REFERENCE}
`;

function seedProject(filesystem) {
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", TAILSCALE_PROJECT);
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    `${JSON.stringify({ version: 1, providerReferences: {}, tracking: { notices: [] } }, null, 2)}\n`
  );
}

// A Tailscale LXC as `pct exec` sees it: the client only exists after apt
// installs it, `tailscale up` reads the key file rather than the command line,
// and the two peers already in the tailnet are not NominaConnect's to change.
class FakeTailscaleLxc {
  constructor({ tun = true } = {}) {
    this.tun = tun;
    this.files = new Map();
    this.installed = false;
    this.repositoryConfigured = false;
    this.daemonActive = false;
    this.backendState = "NoState";
    this.tailnetIps = [];
    this.upgraded = false;
    this.commands = [];
  }

  exec = async (vmid, command) => {
    this.commands.push(command);
    assert.doesNotMatch(JSON.stringify(command.args), new RegExp(AUTH_KEY));
    if (command.binary === "/usr/bin/apt-get") {
      if (command.args.includes("--only-upgrade")) {
        this.upgraded = true;
      } else if (command.args[0] === "install" && command.args.includes("tailscale")) {
        assert.ok(this.repositoryConfigured, "tailscale is only installable from its own repository");
        this.installed = true;
      }
      return ok();
    }
    if (command.binary === "/bin/rm") {
      for (const target of command.args.filter((argument) => !argument.startsWith("-"))) {
        this.files.delete(target);
      }
      return ok();
    }
    if (command.binary === "/usr/bin/tailscale") {
      assert.ok(this.installed, "tailscale must be installed before it is used");
      if (command.args[0] === "up") {
        const key = this.files.get(AUTH_KEY_PATH);
        assert.equal(key, AUTH_KEY, "the client must read the key NominaConnect stored");
        this.backendState = "Running";
        this.tailnetIps = ["100.64.0.5"];
        return ok("Success.");
      }
      if (!this.daemonActive) {
        throw new Error("failed to connect to local tailscaled");
      }
      return ok(JSON.stringify(this.#status()));
    }
    if (command.binary === "/bin/bash") {
      return this.#runScript(command.args[1], command.stdin);
    }
    return ok();
  };

  #runScript(script, stdin) {
    if (script.includes("/dev/net/tun")) {
      return ok(this.tun ? "nomina-tun-ok" : "nomina-tun-missing");
    }
    if (script.includes("pkgs.tailscale.com")) {
      this.repositoryConfigured = true;
      return ok();
    }
    if (script.includes("enable --now tailscaled") || script.includes("restart tailscaled")) {
      this.daemonActive = true;
      if (this.backendState === "NoState") {
        this.backendState = "NeedsLogin";
      }
      return ok();
    }
    if (script.includes("is-active tailscaled")) {
      return ok(this.daemonActive ? "active" : "inactive");
    }
    if (script.includes(`cat > ${AUTH_KEY_PATH}`)) {
      this.files.set(AUTH_KEY_PATH, stdin);
      return ok();
    }
    return ok();
  }

  #status() {
    return {
      Version: "1.98.0",
      BackendState: this.backendState,
      CurrentTailnet: { Name: "bunnyhome.example.ts.net" },
      Self: {
        ID: "nodeSELF01",
        HostName: "tailscale",
        DNSName: "tailscale.tail1a2b.ts.net.",
        TailscaleIPs: this.tailnetIps,
        Online: this.backendState === "Running"
      },
      Peer: {
        "nodekey:laptop": {
          ID: "nodeLAPTOP",
          HostName: "sarah-laptop",
          DNSName: "sarah-laptop.tail1a2b.ts.net.",
          TailscaleIPs: ["100.64.0.9"],
          Online: true
        },
        "nodekey:phone": {
          ID: "nodePHONE",
          HostName: "pixel",
          DNSName: "pixel.tail1a2b.ts.net.",
          TailscaleIPs: ["100.64.0.11"],
          Online: false
        }
      }
    };
  }
}

function ok(stdout = "") {
  return { exitCode: 0, stdout, stderr: "" };
}

function createProxmox(lxc, { enableTunDevice = undefined } = {}) {
  const created = [];
  const hostCommands = [];
  return {
    created,
    hostCommands,
    async checkIpAvailability() {
      return { status: "available" };
    },
    async createLxc(spec) {
      created.push(spec);
      return { vmid: 130, hostname: spec.hostname };
    },
    async inspectLxc() {
      return { hostname: "tailscale", unprivileged: true };
    },
    async pctExec(vmid, command) {
      return lxc.exec(vmid, command);
    },
    async enableTunDevice(vmid) {
      hostCommands.push(["enableTunDevice", vmid]);
      if (enableTunDevice !== undefined) {
        return enableTunDevice(vmid);
      }
      lxc.tun = true;
      return { vmid };
    },
    async supportsSnapshots() {
      return false;
    }
  };
}

// `storedSecret: null` stands for a project whose auth key has not been
// entered yet, so the CLI has to prompt for it.
function createAdapters(lxc, { proxmox = createProxmox(lxc), storedSecret = AUTH_KEY } = {}) {
  const filesystem = new FakeFilesystem();
  seedProject(filesystem);
  const secrets = new Map(storedSecret === null ? [] : [[SECRET_REFERENCE, storedSecret]]);
  const prompted = [];
  return {
    filesystem,
    proxmox,
    secrets,
    prompted,
    adapters: {
      filesystem,
      runtime: proxmoxRootRuntime(),
      proxmox,
      secretStore: {
        has: (reference) => secrets.has(reference),
        store: (reference, value) => secrets.set(reference, value)
      },
      prompts: {
        secret: async (question) => {
          prompted.push(question);
          return AUTH_KEY;
        },
        confirm: async () => false
      },
      providerAdapters: {
        tailscale: createTailscaleAdapter({
          secretResolver: {
            resolve(reference) {
              const value = secrets.get(reference);
              if (value === undefined) {
                throw new Error(`No connection secret is stored at ${reference}.`);
              }
              return value;
            }
          },
          exec: (vmid, command) => proxmox.pctExec(vmid, command),
          enableTunDevice: (vmid) => proxmox.enableTunDevice(vmid),
          sleep: noSleep
        })
      }
    }
  };
}

test("nomina service add tailscale enrolls a real client and reports its tailnet address", async () => {
  const lxc = new FakeTailscaleLxc();
  const { adapters, filesystem, proxmox } = createAdapters(lxc);

  const result = await runCli(
    ["service", "add", "tailscale", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.60"],
    adapters
  );

  assert.equal(proxmox.created.length, 1);
  assert.equal(proxmox.created[0].unprivileged, true);
  assert.equal(proxmox.created[0].template, "debian-12-standard");
  assert.equal(lxc.installed, true);
  assert.equal(lxc.backendState, "Running");

  assert.match(result.stdout, /Tailscale provisioned at 10\.0\.0\.60/);
  assert.match(result.stdout, /Enrolled as tailscale\.tail1a2b\.ts\.net \(100\.64\.0\.5\)/);
  assert.match(result.stdout, /Health: healthy/);
  assert.equal(result.health.status, "healthy");

  // The two devices already in the tailnet are unmanaged and preserved.
  assert.equal(result.inspection.unmanaged.filter((resource) => resource.self !== true).length, 2);

  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.equal(state.providerReferences.nc_vpn_test.vmid, 130);
  assert.deepEqual(state.providerReferences.nc_vpn_test.locator, {
    id: "nodeSELF01",
    dnsName: "tailscale.tail1a2b.ts.net",
    hostname: "tailscale"
  });
  assert.match(state.providerReferences.nc_vpn_test.fingerprint, /^[0-9a-f]{64}$/);

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /ip: 10\.0\.0\.60/);
  assert.doesNotMatch(config, new RegExp(AUTH_KEY));
  assert.doesNotMatch(filesystem.read("/projects/bunnyhome/.nomina/state.json"), new RegExp(AUTH_KEY));
});

test("an auth key entered at the prompt is stored securely and never written to the project", async () => {
  const lxc = new FakeTailscaleLxc();
  const { adapters, filesystem, secrets, prompted } = createAdapters(lxc, { storedSecret: null });

  await runCli(
    ["service", "add", "tailscale", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.60"],
    adapters
  );

  assert.equal(prompted.length, 1);
  assert.match(prompted[0], /tailnet auth key/i);
  assert.equal(secrets.get(SECRET_REFERENCE), AUTH_KEY);
  assert.doesNotMatch(filesystem.read("/projects/bunnyhome/nomina.yaml"), new RegExp(AUTH_KEY));
  assert.equal(lxc.files.has(AUTH_KEY_PATH), false, "the key file is removed from the LXC after enrollment");
});

test("a container without a TUN device is repaired from the Proxmox host before setup continues", async () => {
  const lxc = new FakeTailscaleLxc({ tun: false });
  const { adapters, proxmox } = createAdapters(lxc);

  const result = await runCli(
    ["service", "add", "tailscale", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.60"],
    adapters
  );

  assert.deepEqual(proxmox.hostCommands, [["enableTunDevice", 130]]);
  assert.equal(result.health.status, "healthy");
});

test("a container that cannot get a TUN device fails with remediation and changes nothing", async () => {
  const lxc = new FakeTailscaleLxc({ tun: false });
  const proxmox = createProxmox(lxc, {
    enableTunDevice: () => {
      throw new Error("400 Parameter verification failed. dev0: property is not defined in schema");
    }
  });
  const { adapters, filesystem } = createAdapters(lxc, { proxmox });

  await assert.rejects(
    runCli(["service", "add", "tailscale", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.60"], adapters),
    (/** @type {Error} */ error) => {
      assert.match(error.message, /TUN device \/dev\/net\/tun inside LXC 130/);
      assert.match(error.message, /pct set 130 --dev0 \/dev\/net\/tun/);
      assert.match(error.message, /property is not defined in schema/);
      return true;
    }
  );

  assert.equal(lxc.installed, false);
  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.deepEqual(state.providerReferences, {});
  assert.equal(filesystem.read("/projects/bunnyhome/nomina.yaml"), TAILSCALE_PROJECT);
});

test("nomina service upgrade tailscale upgrades the client without re-enrolling it", async () => {
  const lxc = new FakeTailscaleLxc();
  const { adapters, filesystem } = createAdapters(lxc);
  await runCli(
    ["service", "add", "tailscale", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.60"],
    adapters
  );
  const enrolledAt = lxc.files.size;

  const result = await runCli(
    ["service", "upgrade", "tailscale", "--project-dir", "/projects/bunnyhome", "--no-snapshot"],
    adapters
  );

  assert.equal(lxc.upgraded, true);
  assert.equal(lxc.backendState, "Running");
  assert.equal(lxc.files.size, enrolledAt, "an upgrade must not write a new auth key file");
  assert.match(result.stdout, /Tailscale upgraded on tailscale \(vmid 130\)/);
  assert.equal(result.health.status, "healthy");
  assert.doesNotMatch(filesystem.read("/projects/bunnyhome/nomina.yaml"), new RegExp(AUTH_KEY));
});

test("nomina service recheck tailscale adopts an already enrolled client through its LXC", async () => {
  const lxc = new FakeTailscaleLxc();
  // An LXC that was already provisioned and enrolled, but is missing from
  // local state — the case recheck exists for.
  lxc.repositoryConfigured = true;
  lxc.installed = true;
  lxc.daemonActive = true;
  lxc.backendState = "Running";
  lxc.tailnetIps = ["100.64.0.5"];

  const proxmox = createProxmox(lxc);
  proxmox.checkIpAvailability = async () => ({ status: "known-collision", conflictWith: "lxc/130" });
  const { adapters, filesystem } = createAdapters(lxc, { proxmox });

  const result = await runCli(
    ["service", "recheck", "tailscale", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.60"],
    adapters
  );

  assert.match(result.stdout, /Rechecked tailscale: LXC 130 at 10\.0\.0\.60/);
  assert.equal(result.health.status, "healthy");
  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.equal(state.providerReferences.nc_vpn_test.locator.id, "nodeSELF01");
});

// Companion to the provisioning fix: recheck *throws* when the first probe
// comes back unhealthy, so a provider that is still starting used to fail the
// command outright instead of being given the same settling window.
test("nomina service recheck settles a health check that is not ready on the first probe", async () => {
  const lxc = new FakeTailscaleLxc();
  lxc.repositoryConfigured = true;
  lxc.installed = true;
  lxc.daemonActive = false;
  lxc.backendState = "Running";
  lxc.tailnetIps = ["100.64.0.5"];

  const proxmox = createProxmox(lxc);
  proxmox.checkIpAvailability = async () => ({ status: "known-collision", conflictWith: "lxc/130" });
  const { adapters } = createAdapters(lxc, { proxmox });
  adapters.retryOptions = { baseDelayMs: 0, sleep: async () => { lxc.daemonActive = true; } };

  const result = await runCli(
    ["service", "recheck", "tailscale", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.60"],
    adapters
  );

  assert.equal(result.health.status, "healthy");
});
