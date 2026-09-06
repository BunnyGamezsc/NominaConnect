import test from "node:test";
import assert from "node:assert/strict";

import { createTailscaleAdapter, describeTunRemediation, parseTailscaleStatus } from "../src/tailscale-adapter.js";
import { runTrackingJob } from "../src/tracking.js";

const AUTH_KEY_PATH = "/run/nomina-tailscale.authkey";
const VALID_KEY = "tskey-auth-kbNq7CNTRL-3rZ8pXvVaLid";
const noSleep = () => Promise.resolve();

// ---------------------------------------------------------------------------
// A stand-in for a Tailscale service LXC. It only answers commands a real
// container would answer: the client is not installed until apt installs it,
// `tailscale up` reads the key file the adapter wrote rather than trusting the
// adapter's word for it, and a key the tailnet would reject fails the way the
// real CLI fails. Peers belong to the tailnet, not to NominaConnect, so the
// fake fails loudly if anything tries to change them.
// ---------------------------------------------------------------------------
class FakeTailscaleLxc {
  constructor({ vmid = 130, tun = true, validKeys = [VALID_KEY], peers = defaultPeers() } = {}) {
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
    this.backendState = "NoState";
    this.tailnetIps = [];
    this.hostname = "tailscale";
    this.dnsName = "tailscale.tail1a2b.ts.net.";
    this.nodeId = "nodeSELF01";
    this.malformedStatus = false;
    this.enrollments = 0;
  }

  exec = async (vmid, command) => {
    this.execCalls.push({ vmid, command });
    assert.equal(vmid, this.vmid, "commands must target the managed Tailscale LXC");
    assert.equal(typeof command.binary, "string");
    assert.ok(Array.isArray(command.args), "commands must use a fixed argument array");
    assert.doesNotMatch(
      JSON.stringify(command.args),
      new RegExp(VALID_KEY),
      "an auth key must never travel in an argument array"
    );

    if (command.binary === "/usr/bin/apt-get") {
      return this.#runApt(command.args);
    }
    if (command.binary === "/usr/bin/tailscale") {
      return this.#runTailscale(command.args);
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

  get authKeyFile() {
    return this.files.get(AUTH_KEY_PATH);
  }

  assertPeersUntouched() {
    assert.equal(JSON.stringify(this.peers), this.peersSnapshot, "unmanaged tailnet peers must be preserved");
  }

  #runApt(args) {
    if (args.includes("--only-upgrade") && args.includes("tailscale")) {
      if (!this.installed) {
        return fail("E: Unable to locate package tailscale");
      }
      this.upgradedTo = "1.99.0";
      return ok();
    }
    if (args[0] === "install" && args.includes("tailscale")) {
      if (!this.repositoryConfigured) {
        return fail("E: Unable to locate package tailscale");
      }
      this.installed = true;
      return ok();
    }
    return ok();
  }

  #runTailscale(args) {
    if (!this.installed) {
      return fail("bash: /usr/bin/tailscale: No such file or directory");
    }
    if (args[0] === "status") {
      if (this.malformedStatus) {
        return { exitCode: 0, stdout: "<html>proxy error</html>", stderr: "" };
      }
      if (!this.daemonActive) {
        return fail("failed to connect to local tailscaled; it doesn't appear to be running");
      }
      return { exitCode: 0, stdout: JSON.stringify(this.#statusDocument()), stderr: "" };
    }
    if (args[0] === "up") {
      const keyArgument = args.find((argument) => argument.startsWith("--auth-key="));
      assert.ok(keyArgument?.startsWith("--auth-key=file:"), "the key must be read from a file, not the command line");
      const key = this.files.get(keyArgument.slice("--auth-key=file:".length));
      if (key === undefined) {
        return fail("invalid key: empty");
      }
      if (!this.validKeys.has(key)) {
        return fail("backend error: invalid key: unauthorized");
      }
      this.enrollments += 1;
      this.backendState = "Running";
      this.tailnetIps = ["100.64.0.5", "fd7a:115c:a1e0::5"];
      return ok("Success.");
    }
    return ok();
  }

  #runScript(script, stdin) {
    if (script.includes("/dev/net/tun")) {
      return ok(this.tun ? "nomina-tun-ok" : "nomina-tun-missing");
    }
    if (script.includes("pkgs.tailscale.com")) {
      this.repositoryConfigured = true;
      return ok();
    }
    if (script.includes("systemctl enable --now tailscaled")) {
      if (!this.installed) {
        return fail("Failed to enable unit: Unit tailscaled.service does not exist.");
      }
      this.daemonActive = true;
      this.backendState = "NeedsLogin";
      return ok();
    }
    if (script.includes("systemctl restart tailscaled")) {
      this.daemonActive = true;
      return ok();
    }
    if (script.includes("systemctl is-active tailscaled")) {
      return ok(this.daemonActive ? "active" : "inactive");
    }
    if (script.includes(`cat > ${AUTH_KEY_PATH}`)) {
      assert.equal(typeof stdin, "string", "the auth key must arrive over standard input");
      this.files.set(AUTH_KEY_PATH, stdin);
      return ok();
    }
    return ok();
  }

  #statusDocument() {
    return {
      Version: "1.98.0",
      BackendState: this.backendState,
      CurrentTailnet: { Name: "bunnyhome.example.ts.net", MagicDNSSuffix: "tail1a2b.ts.net" },
      Self: {
        ID: this.nodeId,
        HostName: this.hostname,
        DNSName: this.dnsName,
        TailscaleIPs: this.tailnetIps,
        Online: this.backendState === "Running",
        Tags: []
      },
      Peer: Object.fromEntries(this.peers.map((peer) => [`nodekey:${peer.ID}`, peer]))
    };
  }
}

function defaultPeers() {
  return [
    {
      ID: "nodeLAPTOP",
      HostName: "sarah-laptop",
      DNSName: "sarah-laptop.tail1a2b.ts.net.",
      TailscaleIPs: ["100.64.0.9"],
      Online: true
    },
    {
      ID: "nodePHONE",
      HostName: "pixel",
      DNSName: "pixel.tail1a2b.ts.net.",
      TailscaleIPs: ["100.64.0.11"],
      Online: false
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
  return createTailscaleAdapter({
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
  provider: "tailscale",
  managedItemId: "nc_vpn_test",
  vmid: 130,
  ip: "10.0.0.60",
  connectionSecretReference: "nominaconnect/provider/nc_vpn"
});

async function provision(lxc, adapter) {
  const plan = await adapter.setup({ ...REQUEST });
  for (const command of plan.lxcCommands) {
    await lxc.exec(REQUEST.vmid, command);
  }
  return adapter.configure({ ...REQUEST });
}

test("setup and enrollment leave a real Tailscale client joined to its tailnet", async () => {
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc);

  const configured = await provision(lxc, adapter);

  assert.equal(lxc.installed, true);
  assert.equal(lxc.daemonActive, true);
  assert.equal(lxc.backendState, "Running");
  assert.equal(configured.backendState, "Running");
  assert.deepEqual(configured.tailnetIps, ["100.64.0.5", "fd7a:115c:a1e0::5"]);
  assert.equal(configured.tailnet, "bunnyhome.example.ts.net");
  lxc.assertPeersUntouched();
});

test("the enrollment credential reaches the client over standard input and is removed afterwards", async () => {
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc);

  await provision(lxc, adapter);

  const everyCommand = JSON.stringify(lxc.execCalls.map(({ command }) => ({ binary: command.binary, args: command.args })));
  assert.doesNotMatch(everyCommand, new RegExp(VALID_KEY));

  const writes = lxc.execCalls.filter(({ command }) => command.stdin !== undefined);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].command.stdin, VALID_KEY);
  assert.deepEqual(writes[0].command.redactions, [VALID_KEY], "the key must be redacted from diagnostics");

  assert.equal(lxc.authKeyFile, undefined, "the auth key file must not be left in the LXC");
});

test("a rejected auth key fails enrollment with a remediation the operator can act on", async () => {
  const lxc = new FakeTailscaleLxc({ validKeys: [] });
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
  assert.equal(lxc.authKeyFile, undefined, "a rejected key must not be left behind in the LXC");
  assert.equal(lxc.backendState, "NeedsLogin");
});

test("a missing auth key is reported before anything is installed", async () => {
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc, { secret: null });

  await assert.rejects(adapter.setup({ ...REQUEST }), /Unable to read the Tailscale auth key/);
  assert.equal(lxc.installed, false);
});

test("a plan-only setup without a managed LXC returns install commands and touches nothing", async () => {
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc, { secret: null });

  const plan = await adapter.setup({ provider: "tailscale", managedItemId: "nc_vpn_test" });

  assert.ok(Array.isArray(plan.lxcCommands) && plan.lxcCommands.length > 0, "init still plans the install");
  assert.equal(lxc.execCalls.length, 0, "no command may run before the LXC exists");
  assert.equal(lxc.hostCommands.length, 0, "no TUN grant may run before the LXC exists");
});

test("a stored credential that is not an auth key is rejected instead of being sent to the tailnet", async () => {
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc, { secret: "hunter2 my tailscale password" });

  await assert.rejects(adapter.setup({ ...REQUEST }), (/** @type {Error} */ error) => {
    assert.match(error.message, /does not look like a tailnet auth key/);
    assert.doesNotMatch(error.message, /hunter2/);
    return true;
  });
  assert.equal(lxc.installed, false);
});

test("an LXC without a TUN device is given one before setup continues", async () => {
  const lxc = new FakeTailscaleLxc({ tun: false });
  const adapter = createAdapter(lxc);

  const configured = await provision(lxc, adapter);

  assert.deepEqual(lxc.hostCommands, [["enableTunDevice", 130]]);
  assert.equal(configured.backendState, "Running");
});

test("an LXC that cannot get a TUN device fails with the exact Proxmox remediation", async () => {
  const lxc = new FakeTailscaleLxc({ tun: false });
  const adapter = createAdapter(lxc, { enableTun: false });

  await assert.rejects(adapter.setup({ ...REQUEST }), (/** @type {Error} */ error) => {
    assert.equal(error.name, "TailscalePrerequisiteError");
    assert.match(error.message, /pct set 130 --dev0 \/dev\/net\/tun/);
    assert.match(error.message, /lxc\.cgroup2\.devices\.allow: c 10:200 rwm/);
    assert.match(error.message, /pct destroy 130/);
    return true;
  });
  assert.equal(lxc.installed, false, "nothing may be installed into an LXC that cannot run the VPN");
});

test("a Proxmox host that refuses the device passthrough explains both failures", async () => {
  const lxc = new FakeTailscaleLxc({ tun: false });
  const adapter = createTailscaleAdapter({
    secretResolver: { resolve: () => VALID_KEY },
    exec: lxc.exec,
    enableTunDevice: async () => {
      throw new Error("unable to parse option 'dev0'");
    },
    sleep: noSleep
  });

  await assert.rejects(adapter.setup({ ...REQUEST }), (/** @type {Error} */ error) => {
    assert.match(error.message, /pct set 130 --dev0/);
    assert.match(error.message, /Proxmox refused: unable to parse option 'dev0'/);
    return true;
  });
});

test("inspection reports the enrolled node and preserves every unmanaged peer", async () => {
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);

  const observed = await adapter.inspect({ ...REQUEST });

  assert.equal(observed.resources.length, 3);
  const self = observed.resources.find((resource) => resource.self === true);
  assert.equal(self.id, "nodeSELF01");
  assert.deepEqual(self.locator, {
    id: "nodeSELF01",
    dnsName: "tailscale.tail1a2b.ts.net",
    hostname: "tailscale"
  });
  assert.deepEqual(self.tailscaleIps, ["100.64.0.5", "fd7a:115c:a1e0::5"]);
  assert.match(self.fingerprint, /^[0-9a-f]{64}$/);

  const peers = observed.resources.filter((resource) => resource.self !== true);
  assert.deepEqual(peers.map((peer) => peer.id).sort(), ["nodeLAPTOP", "nodePHONE"]);
  lxc.assertPeersUntouched();
});

test("inspection is read-only and never enrolls or reconfigures the client", async () => {
  const lxc = new FakeTailscaleLxc();
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
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);

  await adapter.configure({ ...REQUEST });

  assert.equal(lxc.enrollments, 1);
});

test("a logged-out client that exits non-zero still reports its backend state", async () => {
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);
  // `tailscale status --json` prints its document and exits 1 when the tunnel
  // is down; the document is the answer.
  lxc.backendState = "Stopped";
  lxc.tailnetIps = [];
  const document = JSON.stringify({ BackendState: "Stopped", Self: { ID: "nodeSELF01" }, Peer: {} });
  const original = lxc.exec;
  lxc.exec = async (vmid, command) => {
    if (command.binary === "/usr/bin/tailscale" && command.args[0] === "status") {
      const error = /** @type {Error & { result?: object }} */ (new Error("Tailscale is stopped."));
      error.result = { exitCode: 1, stdout: document, stderr: "" };
      throw error;
    }
    return original(vmid, command);
  };

  assert.deepEqual(await adapter.healthCheck({ ...REQUEST }), { process: "running", endpoint: "unreachable" });
});

test("a status document the client cannot produce is reported rather than guessed at", async () => {
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);
  lxc.malformedStatus = true;

  await assert.rejects(adapter.inspect({ ...REQUEST }), /malformed status document/);
});

test("adoption refreshes the fingerprint of a uniquely matched node", async () => {
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);
  const observed = await adapter.inspect({ ...REQUEST });
  const self = observed.resources.find((resource) => resource.self === true);

  const adopted = await adapter.adopt({ ...REQUEST, managed: [self] });

  assert.equal(adopted.warnings, undefined);
  assert.equal(adopted.managedInventoryUpdate.length, 1);
  assert.equal(adopted.managedInventoryUpdate[0].fingerprint, self.fingerprint);
});

test("an ambiguous node match is a verification warning instead of an adoption", async () => {
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc);
  const duplicate = { id: "nodeSELF01", locator: { id: "nodeSELF01", dnsName: "tailscale.tail1a2b.ts.net" } };

  const adopted = await adapter.adopt({ ...REQUEST, managed: [duplicate, { ...duplicate }] });

  assert.deepEqual(adopted.managedInventoryUpdate, []);
  assert.match(adopted.warnings[0], /Ambiguous Tailscale node/);
});

test("a renamed node is adopted with the value the tailnet reports", async () => {
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);
  const before = (await adapter.inspect({ ...REQUEST })).resources.find((resource) => resource.self === true);

  // The operator renames the node in the Tailscale admin console.
  lxc.hostname = "vpn-gateway";
  lxc.dnsName = "vpn-gateway.tail1a2b.ts.net.";
  const after = (await adapter.inspect({ ...REQUEST })).resources.find((resource) => resource.self === true);

  assert.equal(after.id, before.id, "the provider-native locator survives a rename");
  assert.notEqual(after.fingerprint, before.fingerprint);
  const adopted = await adapter.adopt({ ...REQUEST, managed: [after] });
  assert.equal(adopted.managedInventoryUpdate[0].locator.dnsName, "vpn-gateway.tail1a2b.ts.net");
  assert.equal(adopted.managedInventoryUpdate[0].hostname, "vpn-gateway");
});

test("health reports a running daemon with an expired node key as unhealthy", async () => {
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);

  assert.deepEqual(await adapter.healthCheck({ ...REQUEST }), { process: "running", endpoint: "reachable" });

  lxc.backendState = "NeedsLogin";
  lxc.tailnetIps = [];
  assert.deepEqual(await adapter.healthCheck({ ...REQUEST }), { process: "running", endpoint: "unreachable" });
});

test("health reports a stopped daemon", async () => {
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);
  lxc.daemonActive = false;

  assert.deepEqual(await adapter.healthCheck({ ...REQUEST }), { process: "stopped", endpoint: "unreachable" });
});

test("an explicit upgrade replaces the client and restarts it without re-enrolling", async () => {
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);

  const plan = await adapter.upgrade({ ...REQUEST });
  for (const command of plan.lxcCommands) {
    await lxc.exec(REQUEST.vmid, command);
  }

  assert.equal(lxc.upgradedTo, "1.99.0");
  assert.equal(lxc.enrollments, 1);
  assert.equal(lxc.backendState, "Running");
  assert.ok(plan.lxcCommands.some((command) => command.args.includes("--only-upgrade")));
  assert.equal(
    plan.lxcCommands.some((command) => command.args.some((argument) => argument.includes("auth-key"))),
    false,
    "an upgrade must not touch enrollment"
  );
});

test("status parsing tolerates a client that has not been assigned a tailnet address", () => {
  const status = parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin", Self: { ID: "n1" }, Peer: {} }));
  assert.equal(status.backendState, "NeedsLogin");
  assert.deepEqual(status.self.tailscaleIps, []);
  assert.deepEqual(status.peers, []);
});

test("the TUN remediation names the LXC it applies to", () => {
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
      service: tailscale
      deployment:
        ip: 10.0.0.60
        hostname: tailscale
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
          vmid: 130,
          ip: "10.0.0.60",
          locator: { id: "nodeSELF01", dnsName: "tailscale.tail1a2b.ts.net", hostname: "tailscale" }
        }
      },
      tracking: { notices: [] }
    }, null, 2)}\n`
  );
}

test("tracking inspects the real client through its LXC and separates the managed node from peers", async () => {
  const filesystem = new FakeFilesystem();
  seedTrackedProject(filesystem);
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);

  const result = await runTrackingJob({
    filesystem,
    projectDir: "/projects/bunnyhome",
    providerAdapters: { tailscale: adapter },
    retryOptions: { maxRetries: 0, baseDelayMs: 0 }
  });

  assert.deepEqual(result.warnings, []);
  lxc.assertPeersUntouched();
});

test("tracking records a verification warning when the VPN client stops answering", async () => {
  const filesystem = new FakeFilesystem();
  seedTrackedProject(filesystem);
  const lxc = new FakeTailscaleLxc();
  const adapter = createAdapter(lxc);
  await provision(lxc, adapter);
  lxc.daemonActive = false;

  const result = await runTrackingJob({
    filesystem,
    projectDir: "/projects/bunnyhome",
    providerAdapters: { tailscale: adapter },
    retryOptions: { maxRetries: 0, baseDelayMs: 0 }
  });

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /tailscale/);
  assert.equal(result.warnings[0].platformKey, "vpn");
});
