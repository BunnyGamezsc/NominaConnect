import test from "node:test";
import assert from "node:assert/strict";

import { createNetBirdAdapter, describeTunRemediation, parseNetBirdStatus } from "../src/netbird-adapter.js";
import { runTrackingJob } from "../src/tracking.js";

const SETUP_KEY_PATH = "/run/nomina-netbird.setupkey";
const VALID_KEY = "A616097E-FCF0-48FA-9354-CA4A61142761";
const noSleep = () => Promise.resolve();

// ---------------------------------------------------------------------------
// A stand-in for a NetBird service LXC. It only answers commands a real
// container would answer: the client is not installed until apt installs it
// from NetBird's own repository, `netbird up` reads the key file rather than
// trusting the adapter's word for it, and a key the management server would
// reject fails the way the real CLI fails. Peers belong to the NetBird
// network, not to NominaConnect, so the fake fails loudly if anything tries to
// change them.
// ---------------------------------------------------------------------------
class FakeNetBirdLxc {
  constructor({ vmid = 131, tun = true, validKeys = [VALID_KEY], peers = defaultPeers() } = {}) {
    this.vmid = vmid;
    this.tun = tun;
    this.validKeys = new Set(validKeys);
    this.peers = peers;
    this.peersSnapshot = JSON.stringify(peers);
    this.files = new Map();
    this.execCalls = [];
    this.hostCommands = [];
    this.repositoryConfigured = false;
    this.installed = false;
    this.daemonActive = false;
    this.upgradedTo = undefined;
    this.daemonStatus = "NoState";
    this.managementConnected = false;
    this.managementError = "";
    this.managementDown = false;
    this.netbirdIp = "";
    this.publicKey = "";
    this.fqdn = "";
    this.malformedStatus = false;
    this.plainTextStatus = false;
    this.enrollments = 0;
  }

  exec = async (vmid, command) => {
    this.execCalls.push({ vmid, command });
    assert.equal(vmid, this.vmid, "commands must target the managed NetBird LXC");
    assert.equal(typeof command.binary, "string");
    assert.ok(Array.isArray(command.args), "commands must use a fixed argument array");
    assert.doesNotMatch(
      JSON.stringify(command.args),
      new RegExp(VALID_KEY),
      "a setup key must never travel in an argument array"
    );

    if (command.binary === "/usr/bin/apt-get") {
      return this.#runApt(command.args);
    }
    if (command.binary === "/usr/bin/netbird") {
      return this.#runNetBird(command.args);
    }
    if (command.binary === "/bin/rm") {
      for (const target of command.args.filter((argument) => !argument.startsWith("-"))) {
        this.files.delete(target);
      }
      return ok();
    }
    if (command.binary === "/bin/bash" && command.args[0] === "-c") {
      return this.#runScript(command.args[1], command.stdin);
    }
    return ok();
  };

  // Stands in for the Proxmox host handing the container a TUN device.
  enableTunDevice = async (vmid) => {
    this.hostCommands.push(["enableTunDevice", vmid]);
    this.tun = true;
    return { vmid, device: "/dev/net/tun" };
  };

  get setupKeyFile() {
    return this.files.get(SETUP_KEY_PATH);
  }

  assertPeersUntouched() {
    assert.equal(JSON.stringify(this.peers), this.peersSnapshot, "unmanaged NetBird peers must be preserved");
  }

  #runApt(args) {
    if (args.includes("--only-upgrade") && args.includes("netbird")) {
      if (!this.installed) {
        return fail("E: Unable to locate package netbird");
      }
      this.upgradedTo = "0.61.0";
      return ok();
    }
    if (args[0] === "install" && args.includes("netbird")) {
      if (!this.repositoryConfigured) {
        return fail("E: Unable to locate package netbird");
      }
      this.installed = true;
      return ok();
    }
    return ok();
  }

  #runNetBird(args) {
    if (!this.installed) {
      return fail("bash: /usr/bin/netbird: No such file or directory");
    }
    if (args[0] === "status") {
      if (this.malformedStatus) {
        return { exitCode: 0, stdout: "<html>proxy error</html>", stderr: "" };
      }
      if (!this.daemonActive) {
        return fail("failed to connect to daemon error: context deadline exceeded");
      }
      if (this.plainTextStatus) {
        // Older clients answer with a plain-text summary and a non-zero exit
        // until the peer has logged in (netbirdio/netbird#2780).
        const error = /** @type {Error & { result?: object }} */ (new Error("needs login"));
        error.result = {
          exitCode: 1,
          stdout: `Daemon status: ${this.daemonStatus}\n\nRun UP command to log in with SSO or setup keys.`,
          stderr: ""
        };
        throw error;
      }
      return { exitCode: 0, stdout: JSON.stringify(this.#statusDocument()), stderr: "" };
    }
    if (args[0] === "up") {
      const keyArgument = args.find((argument) => argument.startsWith("--setup-key"));
      assert.ok(
        keyArgument?.startsWith("--setup-key-file="),
        "the key must be read from a file, not the command line"
      );
      const key = this.files.get(keyArgument.slice("--setup-key-file=".length));
      if (key === undefined) {
        return fail("error while reading setup key file: no such file or directory");
      }
      if (!this.validKeys.has(key)) {
        return fail("rpc error: code = Internal desc = failed logging in peer: invalid setup key");
      }
      this.enrollments += 1;
      this.daemonStatus = "Connected";
      this.managementConnected = !this.managementDown;
      this.netbirdIp = "100.92.0.5/16";
      this.publicKey = "gL5xQ3nJmVh0Nk1sVBrqPcJvV6yQ4dQ0oXxk8dR3vBc=";
      this.fqdn = "netbird.netbird.cloud";
      return ok("Connected");
    }
    return ok();
  }

  #runScript(script, stdin) {
    if (script.includes("/dev/net/tun")) {
      return ok(this.tun ? "nomina-tun-ok" : "nomina-tun-missing");
    }
    if (script.includes("pkgs.netbird.io")) {
      this.repositoryConfigured = true;
      return ok();
    }
    if (script.includes("systemctl enable --now netbird")) {
      if (!this.installed) {
        return fail("Failed to enable unit: Unit netbird.service does not exist.");
      }
      this.daemonActive = true;
      this.daemonStatus = "NeedsLogin";
      return ok();
    }
    if (script.includes("systemctl restart netbird")) {
      this.daemonActive = true;
      return ok();
    }
    if (script.includes("systemctl is-active netbird")) {
      return ok(this.daemonActive ? "active" : "inactive");
    }
    if (script.includes(`cat > ${SETUP_KEY_PATH}`)) {
      assert.equal(typeof stdin, "string", "the setup key must arrive over standard input");
      this.files.set(SETUP_KEY_PATH, stdin);
      return ok();
    }
    return ok();
  }

  #statusDocument() {
    return {
      cliVersion: "0.60.0",
      daemonVersion: "0.60.0",
      daemonStatus: this.daemonStatus,
      management: {
        url: "https://api.netbird.io:443",
        connected: this.managementConnected,
        error: this.managementError
      },
      signal: { url: "https://signal.netbird.io:443", connected: this.managementConnected, error: "" },
      relays: { total: 1, available: 1, details: [] },
      netbirdIp: this.netbirdIp,
      publicKey: this.publicKey,
      fqdn: this.fqdn,
      usesKernelInterface: true,
      peers: {
        total: this.peers.length,
        connected: this.peers.filter((peer) => peer.status === "Connected").length,
        details: this.peers
      }
    };
  }
}

function defaultPeers() {
  return [
    {
      fqdn: "sarah-laptop.netbird.cloud",
      netbirdIp: "100.92.0.9",
      publicKey: "peerLAPTOPr8mQd1sVBrqPcJvV6yQ4dQ0oXxk8dR3vBc=",
      status: "Connected",
      connectionType: "P2P",
      latency: "12ms"
    },
    {
      fqdn: "pixel.netbird.cloud",
      netbirdIp: "100.92.0.11",
      publicKey: "peerPHONEr8mQd1sVBrqPcJvV6yQ4dQ0oXxk8dR3vBcQ=",
      status: "Idle",
      connectionType: "Relayed"
    }
  ];
}

function ok(stdout = "") {
  return { exitCode: 0, stdout, stderr: "" };
}

function fail(stderr) {
  const error = /** @type {Error & { result?: object }} */ (new Error(stderr));
  error.result = { exitCode: 1, stdout: "", stderr };
  throw error;
}

// `secret: null` stands for a credential the secure store cannot produce.
function createAdapter(lxc, { secret = VALID_KEY, enableTun = true } = {}) {
  return createNetBirdAdapter({
    secretResolver: {
      resolve(reference) {
        assert.equal(reference, "nominaconnect/provider/nc_vpn");
        if (secret === null) {
          throw new Error("No such file or directory");
        }
        return secret;
      }
    },
    exec: lxc.exec,
    enableTunDevice: enableTun ? lxc.enableTunDevice : undefined,
    sleep: noSleep
  });
}

const REQUEST = Object.freeze({
  provider: "netbird",
  managedItemId: "nc_vpn_test",
  vmid: 131,
  ip: "10.0.0.61",
  connectionSecretReference: "nominaconnect/provider/nc_vpn"
});

async function provision(lxc, adapter) {
  const plan = await adapter.setup({ ...REQUEST });
  for (const command of plan.lxcCommands) {
    await lxc.exec(REQUEST.vmid, command);
  }
  return adapter.configure({ ...REQUEST });
}

test("setup and enrollment leave a real NetBird client joined to its network", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);

  const configured = await provision(lxc, adapter);

  assert.equal(lxc.installed, true);
  assert.equal(lxc.daemonActive, true);
  assert.equal(lxc.daemonStatus, "Connected");
  assert.equal(configured.daemonStatus, "Connected");
  assert.deepEqual(configured.netbirdIps, ["100.92.0.5"]);
  assert.equal(configured.managementUrl, "https://api.netbird.io:443");
  lxc.assertPeersUntouched();
});

test("the client is only installed from NetBird's own signed repository", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);

  const plan = await adapter.setup({ ...REQUEST });

  const script = plan.lxcCommands
    .flatMap((command) => command.args)
    .find((argument) => argument.includes("pkgs.netbird.io"));
  assert.match(script, /public\.key/);
  assert.match(script, /signed-by=\/usr\/share\/keyrings\/netbird-archive-keyring\.gpg/);
  assert.ok(plan.lxcCommands.every((command) => Number.isFinite(command.timeoutMs)), "every command is time-bounded");
});

test("the enrollment credential reaches the client over standard input and is removed afterwards", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);

  await provision(lxc, adapter);

  const everyCommand = JSON.stringify(lxc.execCalls.map(({ command }) => ({ binary: command.binary, args: command.args })));
  assert.doesNotMatch(everyCommand, new RegExp(VALID_KEY));

  const writes = lxc.execCalls.filter(({ command }) => command.stdin !== undefined);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].command.stdin, VALID_KEY);
  assert.deepEqual(writes[0].command.redactions, [VALID_KEY], "the key must be redacted from diagnostics");

  assert.equal(lxc.setupKeyFile, undefined, "the setup key file must not be left in the LXC");
});

test("a rejected setup key fails enrollment with a remediation the operator can act on", async () => {
  const lxc = new FakeNetBirdLxc({ validKeys: [] });
  const adapter = createAdapter(lxc);

  const plan = await adapter.setup({ ...REQUEST });
  for (const command of plan.lxcCommands) {
    await lxc.exec(REQUEST.vmid, command);
  }

  await assert.rejects(adapter.configure({ ...REQUEST }), (/** @type {Error} */ error) => {
    assert.match(error.message, /rejected, already used, or expired/i);
    assert.match(error.message, /nomina secret change/);
    assert.doesNotMatch(error.message, new RegExp(VALID_KEY));
    return true;
  });
  assert.equal(lxc.setupKeyFile, undefined, "a rejected key must not be left behind in the LXC");
  assert.equal(lxc.daemonStatus, "NeedsLogin");
});

test("a missing setup key is reported before anything is installed", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc, { secret: null });

  await assert.rejects(adapter.setup({ ...REQUEST }), /Unable to read the NetBird setup key/);
  assert.equal(lxc.installed, false);
});

test("a plan-only setup without a managed LXC returns install commands and touches nothing", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc, { secret: null });

  const plan = await adapter.setup({ provider: "netbird", managedItemId: "nc_vpn_test" });

  assert.ok(Array.isArray(plan.lxcCommands) && plan.lxcCommands.length > 0, "init still plans the install");
  assert.equal(lxc.execCalls.length, 0, "no command may run before the LXC exists");
  assert.equal(lxc.hostCommands.length, 0, "no TUN grant may run before the LXC exists");
});

test("a stored credential that is not a setup key is rejected instead of being sent to NetBird", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc, { secret: "hunter2 my netbird password" });

  await assert.rejects(adapter.setup({ ...REQUEST }), (/** @type {Error} */ error) => {
    assert.match(error.message, /does not look like a setup key/);
    assert.doesNotMatch(error.message, /hunter2/);
    return true;
  });
  assert.equal(lxc.installed, false);
});

test("an LXC without a TUN device is given one before setup continues", async () => {
  const lxc = new FakeNetBirdLxc({ tun: false });
  const adapter = createAdapter(lxc);

  const configured = await provision(lxc, adapter);

  assert.deepEqual(lxc.hostCommands, [["enableTunDevice", 131]]);
  assert.equal(configured.daemonStatus, "Connected");
});

test("an LXC that cannot get a TUN device fails with the exact Proxmox remediation", async () => {
  const lxc = new FakeNetBirdLxc({ tun: false });
  const adapter = createAdapter(lxc, { enableTun: false });

  await assert.rejects(adapter.setup({ ...REQUEST }), (/** @type {Error} */ error) => {
    assert.equal(error.name, "NetBirdPrerequisiteError");
    assert.match(error.message, /^NetBird needs the TUN device/);
    assert.match(error.message, /pct set 131 --dev0 \/dev\/net\/tun/);
    assert.match(error.message, /lxc\.cgroup2\.devices\.allow: c 10:200 rwm/);
    assert.match(error.message, /pct destroy 131/);
    assert.match(error.message, /nomina service add netbird/);
    return true;
  });
  assert.equal(lxc.installed, false, "nothing may be installed into an LXC that cannot run the VPN");
});

test("a Proxmox host that refuses the device passthrough explains both failures", async () => {
  const lxc = new FakeNetBirdLxc({ tun: false });
  const adapter = createNetBirdAdapter({
    secretResolver: { resolve: () => VALID_KEY },
    exec: lxc.exec,
    enableTunDevice: async () => {
      throw new Error("unable to parse option 'dev0'");
    },
    sleep: noSleep
  });

  await assert.rejects(adapter.setup({ ...REQUEST }), (/** @type {Error} */ error) => {
    assert.match(error.message, /pct set 131 --dev0/);
    assert.match(error.message, /Proxmox refused: unable to parse option 'dev0'/);
    return true;
  });
});

test("inspection reports the enrolled peer and preserves every unmanaged peer", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);

  const observed = await adapter.inspect({ ...REQUEST });

  assert.equal(observed.resources.length, 3);
  const self = observed.resources.find((resource) => resource.self === true);
  assert.equal(self.id, "gL5xQ3nJmVh0Nk1sVBrqPcJvV6yQ4dQ0oXxk8dR3vBc=");
  assert.deepEqual(self.locator, {
    id: "gL5xQ3nJmVh0Nk1sVBrqPcJvV6yQ4dQ0oXxk8dR3vBc=",
    fqdn: "netbird.netbird.cloud",
    hostname: "netbird"
  });
  assert.deepEqual(self.netbirdIps, ["100.92.0.5"], "the address is reported without its prefix length");
  assert.match(self.fingerprint, /^[0-9a-f]{64}$/);

  const peers = observed.resources.filter((resource) => resource.self !== true);
  assert.deepEqual(peers.map((peer) => peer.hostname).sort(), ["pixel", "sarah-laptop"]);
  assert.deepEqual(peers.map((peer) => peer.online), [true, false]);
  lxc.assertPeersUntouched();
});

test("inspection is read-only and never enrolls or reconfigures the client", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);
  const enrollments = lxc.enrollments;

  await adapter.inspect({ ...REQUEST });
  await adapter.healthCheck({ ...REQUEST });

  assert.equal(lxc.enrollments, enrollments);
  const mutating = lxc.execCalls
    .slice(lxc.execCalls.findIndex(({ command }) => command.args.includes("up")) + 1)
    .filter(({ command }) => command.args.includes("up") || command.binary === "/usr/bin/apt-get");
  assert.deepEqual(mutating, []);
});

test("an already enrolled client is not re-registered when configure runs again", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);

  await adapter.configure({ ...REQUEST });

  assert.equal(lxc.enrollments, 1);
});

test("a client that has never logged in still reports its daemon state", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);
  const plan = await adapter.setup({ ...REQUEST });
  for (const command of plan.lxcCommands) {
    await lxc.exec(REQUEST.vmid, command);
  }
  lxc.plainTextStatus = true;

  assert.deepEqual(await adapter.healthCheck({ ...REQUEST }), { process: "running", endpoint: "unreachable" });
  assert.deepEqual((await adapter.inspect({ ...REQUEST })).resources, []);
});

test("a status document the client cannot produce is reported rather than guessed at", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);
  lxc.malformedStatus = true;

  await assert.rejects(adapter.inspect({ ...REQUEST }), /malformed status document/);
});

test("adoption refreshes the fingerprint of a uniquely matched peer", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);
  const observed = await adapter.inspect({ ...REQUEST });
  const self = observed.resources.find((resource) => resource.self === true);

  const adopted = await adapter.adopt({ ...REQUEST, managed: [self] });

  assert.equal(adopted.warnings, undefined);
  assert.equal(adopted.managedInventoryUpdate.length, 1);
  assert.equal(adopted.managedInventoryUpdate[0].fingerprint, self.fingerprint);
});

test("an ambiguous peer match is a verification warning instead of an adoption", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);
  const duplicate = { id: "peerAMBIGUOUS", locator: { id: "peerAMBIGUOUS", fqdn: "netbird.netbird.cloud" } };

  const adopted = await adapter.adopt({ ...REQUEST, managed: [duplicate, { ...duplicate }] });

  assert.deepEqual(adopted.managedInventoryUpdate, []);
  assert.match(adopted.warnings[0], /Ambiguous NetBird peer/);
});

test("a renamed peer is adopted with the value the NetBird dashboard reports", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);
  const before = (await adapter.inspect({ ...REQUEST })).resources.find((resource) => resource.self === true);

  // The operator renames the peer in the NetBird dashboard.
  lxc.fqdn = "vpn-gateway.netbird.cloud";
  const after = (await adapter.inspect({ ...REQUEST })).resources.find((resource) => resource.self === true);

  assert.equal(after.id, before.id, "the WireGuard public key survives a rename");
  assert.notEqual(after.fingerprint, before.fingerprint);
  const adopted = await adapter.adopt({ ...REQUEST, managed: [after] });
  assert.equal(adopted.managedInventoryUpdate[0].locator.fqdn, "vpn-gateway.netbird.cloud");
  assert.equal(adopted.managedInventoryUpdate[0].hostname, "vpn-gateway");
});

test("health reports a running daemon that lost its management server as unhealthy", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);

  assert.deepEqual(await adapter.healthCheck({ ...REQUEST }), { process: "running", endpoint: "reachable" });

  lxc.managementConnected = false;
  lxc.managementError = "context deadline exceeded";
  assert.deepEqual(await adapter.healthCheck({ ...REQUEST }), { process: "running", endpoint: "unreachable" });
});

test("health reports a running daemon with an expired session as unhealthy", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);
  lxc.daemonStatus = "SessionExpired";

  assert.deepEqual(await adapter.healthCheck({ ...REQUEST }), { process: "running", endpoint: "unreachable" });
});

test("health reports a stopped daemon", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);
  lxc.daemonActive = false;

  assert.deepEqual(await adapter.healthCheck({ ...REQUEST }), { process: "stopped", endpoint: "unreachable" });
});

test("an enrolled client that cannot reach its management server explains the failure", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);
  const plan = await adapter.setup({ ...REQUEST });
  for (const command of plan.lxcCommands) {
    await lxc.exec(REQUEST.vmid, command);
  }
  // The peer registered, but cannot reach the management server, so the
  // tunnel never becomes usable.
  lxc.managementDown = true;
  lxc.managementError = "context deadline exceeded";

  await assert.rejects(adapter.configure({ ...REQUEST }), (/** @type {Error} */ error) => {
    assert.match(error.message, /cannot reach https:\/\/api\.netbird\.io:443/);
    assert.match(error.message, /context deadline exceeded/);
    return true;
  });
});

test("an explicit upgrade replaces the client and restarts it without re-enrolling", async () => {
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);

  const plan = await adapter.upgrade({ ...REQUEST });
  for (const command of plan.lxcCommands) {
    await lxc.exec(REQUEST.vmid, command);
  }

  assert.equal(lxc.upgradedTo, "0.61.0");
  assert.equal(lxc.enrollments, 1);
  assert.equal(lxc.daemonStatus, "Connected");
  assert.ok(plan.lxcCommands.some((command) => command.args.includes("--only-upgrade")));
  assert.equal(
    plan.lxcCommands.some((command) => command.args.some((argument) => argument.includes("setup-key"))),
    false,
    "an upgrade must not touch enrollment"
  );
});

test("status parsing tolerates a client that has not been assigned a network address", () => {
  const status = parseNetBirdStatus(JSON.stringify({
    daemonStatus: "NeedsLogin",
    management: { url: "https://api.netbird.io:443", connected: false },
    netbirdIp: "",
    publicKey: "",
    fqdn: "",
    peers: { total: 0, connected: 0, details: [] }
  }));

  assert.equal(status.daemonStatus, "NeedsLogin");
  assert.equal(status.management.connected, false);
  assert.equal(status.self, undefined);
  assert.deepEqual(status.peers, []);
});

test("the TUN remediation names the LXC and the client it applies to", () => {
  assert.match(describeTunRemediation(141), /NetBird needs the TUN device/);
  assert.match(describeTunRemediation(141), /LXC 141/);
  assert.match(describeTunRemediation(141), /pct reboot 141/);
});

// ---------------------------------------------------------------------------
// Background tracking runs against the same real adapter as foreground
// commands (issue #12, user story 20).
// ---------------------------------------------------------------------------

class FakeFilesystem {
  files = new Map();
  directories = new Set();

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

  chmod() {}

  read(path) {
    return this.files.get(path);
  }
}

const TRACKED_PROJECT = `apiVersion: nomina.connect/v0alpha1
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
      deployment:
        ip: 10.0.0.61
        hostname: netbird
        bridge: vmbr0
        storage: local-lvm
        resources:
          cpus: 1
          memoryMb: 256
          diskGb: 2
  services: []
connectionSecretReferences:
  nc_vpn_test: nominaconnect/provider/nc_vpn
`;

function seedTrackedProject(filesystem) {
  filesystem.mkdir("/projects/bunnyhome");
  filesystem.mkdir("/projects/bunnyhome/.nomina");
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", TRACKED_PROJECT);
  filesystem.writeFile(
    "/projects/bunnyhome/.nomina/state.json",
    `${JSON.stringify({
      version: 1,
      providerReferences: {
        nc_vpn_test: {
          vmid: 131,
          ip: "10.0.0.61",
          locator: {
            id: "gL5xQ3nJmVh0Nk1sVBrqPcJvV6yQ4dQ0oXxk8dR3vBc=",
            fqdn: "netbird.netbird.cloud",
            hostname: "netbird"
          }
        }
      },
      tracking: { notices: [] }
    }, null, 2)}\n`
  );
}

test("tracking inspects the real client through its LXC and separates the managed peer from the rest", async () => {
  const filesystem = new FakeFilesystem();
  seedTrackedProject(filesystem);
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);

  const result = await runTrackingJob({
    filesystem,
    projectDir: "/projects/bunnyhome",
    providerAdapters: { netbird: adapter },
    retryOptions: { maxRetries: 0, baseDelayMs: 0 }
  });

  assert.deepEqual(result.warnings, []);
  lxc.assertPeersUntouched();
});

test("tracking records a verification warning when the VPN client stops answering", async () => {
  const filesystem = new FakeFilesystem();
  seedTrackedProject(filesystem);
  const lxc = new FakeNetBirdLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);
  lxc.daemonActive = false;

  const result = await runTrackingJob({
    filesystem,
    projectDir: "/projects/bunnyhome",
    providerAdapters: { netbird: adapter },
    retryOptions: { maxRetries: 0, baseDelayMs: 0 }
  });

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /netbird/);
  assert.equal(result.warnings[0].platformKey, "vpn");
});
