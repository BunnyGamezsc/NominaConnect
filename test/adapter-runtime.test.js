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
    runner.run({ binary: "/usr/bin/pct", args: ["list"], redactions: ["top-secret"] }),
    (error) => {
      assert.ok(error instanceof CommandExecutionError);
      assert.equal(error.command.binary, "/usr/bin/pct");
      assert.deepEqual(error.command.args, ["list"]);
      assert.doesNotMatch(error.message, /top-secret/);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    }
  );
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

  const setup = await providerAdapters.technitium.setup({
    provider: "technitium",
    managedItemId: "nc_dns",
    operations: ["install-technitium"]
  });
  assert.deepEqual(setup.lxcCommands[0], {
    binary: "/usr/bin/apt-get",
    args: ["update"]
  });
  assert.deepEqual(commands[0], { binary: "/usr/sbin/pct", args: ["list"] });
});
