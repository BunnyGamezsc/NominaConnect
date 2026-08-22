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
    args: ["update"]
  });
  assert.deepEqual(commands[0], { binary: "/usr/sbin/pct", args: ["list"] });
});

test("production adapters keep resolved connection secrets out of command arguments", async () => {
  const { providerAdapters } = createProductionAdapters({
    secretResolver: {
      resolve(reference) {
        assert.equal(reference, "nominaconnect/provider/nc_vpn");
        return "top-secret";
      }
    }
  });

  const setup = await providerAdapters.tailscale.setup({
    provider: "tailscale",
    managedItemId: "nc_vpn",
    operations: ["install-tailscale", "join-tailnet"],
    connectionSecretReference: "nominaconnect/provider/nc_vpn"
  });

  const commandText = JSON.stringify(setup.lxcCommands);
  assert.doesNotMatch(commandText, /top-secret/);
  assert.doesNotMatch(commandText, /nominaconnect\/provider\/nc_vpn/);
  assert.ok(setup.lxcCommands.every((command) => Array.isArray(command.args)));
});
