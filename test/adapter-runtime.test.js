import test from "node:test";
import assert from "node:assert/strict";

import {
  CommandExecutionError,
  createCommandRunner,
  createLocalSecretResolver,
  createProductionAdapters
} from "../src/adapter-runtime.js";

test("command runner uses argument arrays and redacts secret-derived diagnostics", async () => {
  const runner = createCommandRunner({
    execute: async (command) => ({
      exitCode: 1,
      stdout: "token=top-secret",
      stderr: `${command.binary} rejected top-secret`
    })
  });

  await assert.rejects(
    runner.run({
      binary: "/usr/bin/pct",
      args: ["exec", "120", "--", "/usr/bin/tailscale", "up", "--authkey", "top-secret"],
      redactions: ["top-secret"]
    }),
    (error) => {
      assert.ok(error instanceof CommandExecutionError);
      assert.equal(error.command.binary, "/usr/bin/pct");
      assert.deepEqual(error.command.args, [
        "exec", "120", "--", "/usr/bin/tailscale", "up", "--authkey", "[REDACTED]"
      ]);
      assert.equal("redactions" in error.command, false);
      assert.doesNotMatch(error.message, /top-secret/);
      assert.doesNotMatch(JSON.stringify(error), /top-secret/);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    }
  );
});

test("createLxc configures the container gateway and nameserver for outbound DNS", async () => {
  const commands = [];
  const { proxmox } = createProductionAdapters({
    commandRunner: {
      async run(command) {
        commands.push(command);
        const [binary, firstArg] = [command.binary, command.args[0]];
        if (binary === "/usr/bin/pvesh") return { exitCode: 0, stdout: "150\n", stderr: "" };
        if (binary === "/usr/sbin/pvesm" && command.args.includes("--content")) {
          return { exitCode: 0, stdout: "Name\tType...\nlocal\tdir...\n", stderr: "" };
        }
        if (binary === "/usr/sbin/pvesm") {
          return { exitCode: 0, stdout: "Name\tType\tStatus...\nlocal-lvm\tlvmthin\tactive\t...\n", stderr: "" };
        }
        if (binary === "/usr/bin/pveam") {
          return { exitCode: 0, stdout: "local:vztmpl/debian-13-standard_13.7-1_amd64.tar.zst\n", stderr: "" };
        }
        if (binary === "/usr/bin/grep") return { exitCode: 0, stdout: "root:100000:65536\n", stderr: "" };
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      }
    }
  });

  await proxmox.createLxc({
    node: "pve-1",
    hostname: "dns",
    ip: "10.0.0.53",
    bridge: "vmbr0",
    storage: "local-lvm",
    unprivileged: true,
    template: "debian-13-standard",
    gateway: "10.0.0.1",
    nameserver: "10.0.0.1",
    resources: { cpus: 2, memoryMb: 1024, diskGb: 8 }
  });

  const create = commands.find((command) => command.binary === "/usr/sbin/pct" && command.args[0] === "create");
  assert.ok(create, "expected a pct create command");
  assert.match(create.args.find((arg) => arg.startsWith("name=eth0")), /gw=10\.0\.0\.1/);
  const nameserverIndex = create.args.indexOf("--nameserver");
  assert.equal(create.args[nameserverIndex + 1], "10.0.0.1");
});

test("root-local secret resolution accepts configured references without exposing them", () => {
  const resolver = createLocalSecretResolver({
    isRoot: () => true,
    filesystem: {
      readFileSync: (path) => {
        assert.equal(path, "/var/lib/nominaconnect/secrets/nominaconnect/provider/nc_dns");
        return "top-secret\n";
      },
      statSync: () => ({ uid: 0, mode: 0o100600 })
    }
  });

  assert.equal(resolver.resolve("nominaconnect/provider/nc_dns"), "top-secret");
  assert.throws(() => resolver.resolve("../outside"), /relative secret reference/i);
  assert.throws(
    () => createLocalSecretResolver({ isRoot: () => false }).resolve("nominaconnect/provider/nc_dns"),
    /Proxmox root shell/
  );
});

test("production composition provides asynchronous Proxmox and provider adapters", async () => {
  const commands = [];
  const { proxmox, providerAdapters } = createProductionAdapters({
    commandRunner: {
      async run(command) {
        commands.push(command);
        if (command.args[0] === "list") {
          return { exitCode: 0, stdout: "VMID Status Lock Name\n120 running - dns 10.0.0.53\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }
    }
  });

  const availability = await proxmox.checkIpAvailability("10.0.0.53");
  assert.deepEqual(availability, { status: "known-collision", conflictWith: "lxc/120" });

  const setup = await providerAdapters.caddy.setup({
    provider: "caddy",
    managedItemId: "nc_proxy",
    operations: ["install-caddy"]
  });
  assert.deepEqual(setup.lxcCommands[0], {
    binary: "/usr/bin/apt-get",
    args: ["update"],
    timeoutMs: 180_000
  });
  assert.deepEqual(commands[0], { binary: "/usr/sbin/pct", args: ["list"] });
});

test("production adapters keep resolved connection secrets out of command arguments", async () => {
  const commands = [];
  let enrolled = false;
  const { providerAdapters } = createProductionAdapters({
    commandRunner: {
      async run(command) {
        commands.push(command);
        if (command.args.includes("--auth-key=file:/run/nomina-tailscale.authkey")) {
          enrolled = true;
        }
        if (command.args.includes("/usr/bin/tailscale") && command.args.includes("status")) {
          if (!enrolled) {
            return { exitCode: 0, stdout: JSON.stringify({ BackendState: "NeedsLogin", Peer: {} }), stderr: "" };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              BackendState: "Running",
              Self: { ID: "nodeAAA", HostName: "tailscale", DNSName: "tailscale.tail1.ts.net.", TailscaleIPs: ["100.64.0.5"], Online: true },
              Peer: {}
            }),
            stderr: ""
          };
        }
        return { exitCode: 0, stdout: "nomina-tun-ok\n", stderr: "" };
      }
    },
    secretResolver: {
      resolve(reference) {
        assert.equal(reference, "nominaconnect/provider/nc_vpn");
        return "top-secret";
      }
    }
  });

  const request = {
    provider: "tailscale",
    managedItemId: "nc_vpn",
    vmid: 130,
    connectionSecretReference: "nominaconnect/provider/nc_vpn"
  };
  const setup = await providerAdapters.tailscale.setup(request);
  await providerAdapters.tailscale.configure(request);

  const commandText = JSON.stringify(setup.lxcCommands);
  assert.doesNotMatch(commandText, /top-secret/);
  assert.doesNotMatch(commandText, /nominaconnect\/provider\/nc_vpn/);
  assert.ok(setup.lxcCommands.every((command) => Array.isArray(command.args)));

  // The auth key reaches the LXC over standard input only: an argument array
  // would put it in the Proxmox host's process list.
  assert.doesNotMatch(JSON.stringify(commands.map((command) => command.args)), /top-secret/);
  const enrolling = commands.filter((command) => command.stdin !== undefined);
  assert.equal(enrolling.length, 1);
  assert.equal(enrolling[0].stdin, "top-secret");
  assert.deepEqual(enrolling[0].redactions, ["top-secret"]);
  assert.ok(commands.some((command) => command.args.includes("up") && command.args.includes("--auth-key=file:/run/nomina-tailscale.authkey")));
  assert.ok(commands.some((command) => command.args.includes("/bin/rm") && command.args.includes("/run/nomina-tailscale.authkey")));
});

test("the production NetBird adapter enrolls through pct exec without exposing the setup key", async () => {
  const commands = [];
  let enrolled = false;
  const { providerAdapters } = createProductionAdapters({
    commandRunner: {
      async run(command) {
        commands.push(command);
        if (command.args.includes("--setup-key-file=/run/nomina-netbird.setupkey")) {
          enrolled = true;
        }
        if (command.args.includes("/usr/bin/netbird") && command.args.includes("status")) {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              daemonStatus: enrolled ? "Connected" : "NeedsLogin",
              management: { url: "https://api.netbird.io:443", connected: enrolled },
              netbirdIp: enrolled ? "100.92.0.5/16" : "",
              publicKey: enrolled ? "pubKeyAAA=" : "",
              fqdn: enrolled ? "netbird.netbird.cloud" : "",
              peers: { total: 0, connected: 0, details: [] }
            }),
            stderr: ""
          };
        }
        return { exitCode: 0, stdout: "nomina-tun-ok\n", stderr: "" };
      }
    },
    secretResolver: {
      resolve(reference) {
        assert.equal(reference, "nominaconnect/provider/nc_vpn");
        return "top-secret";
      }
    }
  });

  const request = {
    provider: "netbird",
    managedItemId: "nc_vpn",
    vmid: 131,
    connectionSecretReference: "nominaconnect/provider/nc_vpn"
  };
  const setup = await providerAdapters.netbird.setup(request);
  const configured = await providerAdapters.netbird.configure(request);

  assert.deepEqual(configured.netbirdIps, ["100.92.0.5"]);
  const commandText = JSON.stringify(setup.lxcCommands);
  assert.doesNotMatch(commandText, /top-secret/);
  assert.doesNotMatch(commandText, /nominaconnect\/provider\/nc_vpn/);

  // The setup key reaches the LXC over standard input only: an argument array
  // would put it in the Proxmox host's process list.
  assert.doesNotMatch(JSON.stringify(commands.map((command) => command.args)), /top-secret/);
  const enrolling = commands.filter((command) => command.stdin !== undefined);
  assert.equal(enrolling.length, 1);
  assert.equal(enrolling[0].stdin, "top-secret");
  assert.deepEqual(enrolling[0].redactions, ["top-secret"]);
  assert.ok(commands.some((command) => command.args.includes("/bin/rm") && command.args.includes("/run/nomina-netbird.setupkey")));
  assert.ok(commands.every((command) => command.args.every((argument) => typeof argument === "string")));
});
