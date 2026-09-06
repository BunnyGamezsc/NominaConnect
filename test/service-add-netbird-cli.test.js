import test from "node:test";
import assert from "node:assert/strict";

import { runCli } from "../src/cli.js";
import { createNetBirdAdapter } from "../src/netbird-adapter.js";

const SETUP_KEY = "A616097E-FCF0-48FA-9354-CA4A61142761";
const SETUP_KEY_PATH = "/run/nomina-netbird.setupkey";
const SECRET_REFERENCE = "nominaconnect/provider/nc_vpn_test";
const SELF_PUBLIC_KEY = "gL5xQ3nJmVh0Nk1sVBrqPcJvV6yQ4dQ0oXxk8dR3vBc=";
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

const NETBIRD_PROJECT = `apiVersion: nomina.connect/v0alpha1
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
      service: netbird
  services: []
connectionSecretReferences:
  nc_vpn_test: ${SECRET_REFERENCE}
`;

function seedProject(filesystem) {
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", NETBIRD_PROJECT);
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    `${JSON.stringify({ version: 1, providerReferences: {}, tracking: { notices: [] } }, null, 2)}\n`
  );
}

// A NetBird LXC as `pct exec` sees it: the client only exists after apt
// installs it from NetBird's repository, `netbird up` reads the key file
// rather than the command line, and the two peers already on the network are
// not NominaConnect's to change.
class FakeNetBirdLxc {
  constructor({ tun = true } = {}) {
    this.tun = tun;
    this.files = new Map();
    this.installed = false;
    this.repositoryConfigured = false;
    this.daemonActive = false;
    this.daemonStatus = "NoState";
    this.managementConnected = false;
    this.netbirdIp = "";
    this.publicKey = "";
    this.fqdn = "";
    this.upgraded = false;
    this.commands = [];
  }

  exec = async (vmid, command) => {
    this.commands.push(command);
    assert.doesNotMatch(JSON.stringify(command.args), new RegExp(SETUP_KEY));
    if (command.binary === "/usr/bin/apt-get") {
      if (command.args.includes("--only-upgrade")) {
        this.upgraded = true;
      } else if (command.args[0] === "install" && command.args.includes("netbird")) {
        assert.ok(this.repositoryConfigured, "netbird is only installable from its own repository");
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
    if (command.binary === "/usr/bin/netbird") {
      assert.ok(this.installed, "netbird must be installed before it is used");
      if (command.args[0] === "up") {
        const key = this.files.get(SETUP_KEY_PATH);
        assert.equal(key, SETUP_KEY, "the client must read the key NominaConnect stored");
        this.daemonStatus = "Connected";
        this.managementConnected = true;
        this.netbirdIp = "100.92.0.5/16";
        this.publicKey = SELF_PUBLIC_KEY;
        this.fqdn = "netbird.netbird.cloud";
        return ok("Connected");
      }
      if (!this.daemonActive) {
        throw new Error("failed to connect to daemon");
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
    if (script.includes("pkgs.netbird.io")) {
      this.repositoryConfigured = true;
      return ok();
    }
    if (script.includes("enable --now netbird") || script.includes("restart netbird")) {
      this.daemonActive = true;
      if (this.daemonStatus === "NoState") {
        this.daemonStatus = "NeedsLogin";
      }
      return ok();
    }
    if (script.includes("is-active netbird")) {
      return ok(this.daemonActive ? "active" : "inactive");
    }
    if (script.includes(`cat > ${SETUP_KEY_PATH}`)) {
      this.files.set(SETUP_KEY_PATH, stdin);
      return ok();
    }
    return ok();
  }

  #status() {
    return {
      cliVersion: "0.60.0",
      daemonVersion: "0.60.0",
      daemonStatus: this.daemonStatus,
      management: { url: "https://api.netbird.io:443", connected: this.managementConnected, error: "" },
      signal: { url: "https://signal.netbird.io:443", connected: this.managementConnected, error: "" },
      netbirdIp: this.netbirdIp,
      publicKey: this.publicKey,
      fqdn: this.fqdn,
      peers: {
        total: 2,
        connected: 1,
        details: [
          {
            fqdn: "sarah-laptop.netbird.cloud",
            netbirdIp: "100.92.0.9",
            publicKey: "peerLAPTOPr8mQd1sVBrqPcJvV6yQ4dQ0oXxk8dR3vBc=",
            status: "Connected",
            connectionType: "P2P"
          },
          {
            fqdn: "pixel.netbird.cloud",
            netbirdIp: "100.92.0.11",
            publicKey: "peerPHONEr8mQd1sVBrqPcJvV6yQ4dQ0oXxk8dR3vBcQ=",
            status: "Idle",
            connectionType: "Relayed"
          }
        ]
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
      return { vmid: 131, hostname: spec.hostname };
    },
    async inspectLxc() {
      return { hostname: "netbird", unprivileged: true };
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

// `storedSecret: null` stands for a project whose setup key has not been
// entered yet, so the CLI has to prompt for it.
function createAdapters(lxc, { proxmox = createProxmox(lxc), storedSecret = SETUP_KEY } = {}) {
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
          return SETUP_KEY;
        },
        confirm: async () => false
      },
      providerAdapters: {
        netbird: createNetBirdAdapter({
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

test("nomina service add netbird enrolls a real client and reports its network address", async () => {
  const lxc = new FakeNetBirdLxc();
  const { adapters, filesystem, proxmox } = createAdapters(lxc);

  const result = await runCli(
    ["service", "add", "netbird", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.61"],
    adapters
  );

  assert.equal(proxmox.created.length, 1);
  assert.equal(proxmox.created[0].unprivileged, true);
  assert.equal(proxmox.created[0].template, "debian-12-standard");
  assert.equal(lxc.installed, true);
  assert.equal(lxc.daemonStatus, "Connected");

  assert.match(result.stdout, /NetBird provisioned at 10\.0\.0\.61/);
  assert.match(result.stdout, /Enrolled as netbird\.netbird\.cloud \(100\.92\.0\.5\)/);
  assert.match(result.stdout, /Health: healthy/);
  assert.equal(result.health.status, "healthy");

  // The two peers already on the NetBird network are unmanaged and preserved.
  assert.equal(result.inspection.unmanaged.filter((resource) => resource.self !== true).length, 2);

  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.equal(state.providerReferences.nc_vpn_test.vmid, 131);
  assert.deepEqual(state.providerReferences.nc_vpn_test.locator, {
    id: SELF_PUBLIC_KEY,
    fqdn: "netbird.netbird.cloud",
    hostname: "netbird"
  });
  assert.match(state.providerReferences.nc_vpn_test.fingerprint, /^[0-9a-f]{64}$/);

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  assert.match(config, /ip: 10\.0\.0\.61/);
  assert.doesNotMatch(config, new RegExp(SETUP_KEY));
  assert.doesNotMatch(filesystem.read("/projects/bunnyhome/.nomina/state.json"), new RegExp(SETUP_KEY));
});

test("a setup key entered at the prompt is stored securely and never written to the project", async () => {
  const lxc = new FakeNetBirdLxc();
  const { adapters, filesystem, secrets, prompted } = createAdapters(lxc, { storedSecret: null });

  await runCli(
    ["service", "add", "netbird", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.61"],
    adapters
  );

  assert.equal(prompted.length, 1);
  assert.match(prompted[0], /setup key/i);
  assert.equal(secrets.get(SECRET_REFERENCE), SETUP_KEY);
  assert.doesNotMatch(filesystem.read("/projects/bunnyhome/nomina.yaml"), new RegExp(SETUP_KEY));
  assert.equal(lxc.files.has(SETUP_KEY_PATH), false, "the key file is removed from the LXC after enrollment");
});

test("a container without a TUN device is repaired from the Proxmox host before setup continues", async () => {
  const lxc = new FakeNetBirdLxc({ tun: false });
  const { adapters, proxmox } = createAdapters(lxc);

  const result = await runCli(
    ["service", "add", "netbird", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.61"],
    adapters
  );

  assert.deepEqual(proxmox.hostCommands, [["enableTunDevice", 131]]);
  assert.equal(result.health.status, "healthy");
});

test("a container that cannot get a TUN device fails with remediation and changes nothing", async () => {
  const lxc = new FakeNetBirdLxc({ tun: false });
  const proxmox = createProxmox(lxc, {
    enableTunDevice: () => {
      throw new Error("400 Parameter verification failed. dev0: property is not defined in schema");
    }
  });
  const { adapters, filesystem } = createAdapters(lxc, { proxmox });

  await assert.rejects(
    runCli(["service", "add", "netbird", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.61"], adapters),
    (/** @type {Error} */ error) => {
      assert.match(error.message, /NetBird needs the TUN device \/dev\/net\/tun inside LXC 131/);
      assert.match(error.message, /pct set 131 --dev0 \/dev\/net\/tun/);
      assert.match(error.message, /property is not defined in schema/);
      return true;
    }
  );

  assert.equal(lxc.installed, false);
  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.deepEqual(state.providerReferences, {});
  assert.equal(filesystem.read("/projects/bunnyhome/nomina.yaml"), NETBIRD_PROJECT);
});

test("nomina service upgrade netbird upgrades the client without re-enrolling it", async () => {
  const lxc = new FakeNetBirdLxc();
  const { adapters, filesystem } = createAdapters(lxc);
  await runCli(
    ["service", "add", "netbird", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.61"],
    adapters
  );
  const enrolledAt = lxc.files.size;

  const result = await runCli(
    ["service", "upgrade", "netbird", "--project-dir", "/projects/bunnyhome", "--no-snapshot"],
    adapters
  );

  assert.equal(lxc.upgraded, true);
  assert.equal(lxc.daemonStatus, "Connected");
  assert.equal(lxc.files.size, enrolledAt, "an upgrade must not write a new setup key file");
  assert.match(result.stdout, /NetBird upgraded on netbird \(vmid 131\)/);
  assert.equal(result.health.status, "healthy");
  assert.doesNotMatch(filesystem.read("/projects/bunnyhome/nomina.yaml"), new RegExp(SETUP_KEY));
});

test("nomina service recheck netbird adopts an already enrolled client through its LXC", async () => {
  const lxc = new FakeNetBirdLxc();
  // An LXC that was already provisioned and enrolled, but is missing from
  // local state — the case recheck exists for.
  lxc.repositoryConfigured = true;
  lxc.installed = true;
  lxc.daemonActive = true;
  lxc.daemonStatus = "Connected";
  lxc.managementConnected = true;
  lxc.netbirdIp = "100.92.0.5/16";
  lxc.publicKey = SELF_PUBLIC_KEY;
  lxc.fqdn = "netbird.netbird.cloud";

  const proxmox = createProxmox(lxc);
  proxmox.checkIpAvailability = async () => ({ status: "known-collision", conflictWith: "lxc/131" });
  const { adapters, filesystem } = createAdapters(lxc, { proxmox });

  const result = await runCli(
    ["service", "recheck", "netbird", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.61"],
    adapters
  );

  assert.match(result.stdout, /Rechecked netbird: LXC 131 at 10\.0\.0\.61/);
  assert.equal(result.health.status, "healthy");
  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));
  assert.equal(state.providerReferences.nc_vpn_test.locator.id, SELF_PUBLIC_KEY);
});
