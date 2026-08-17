import test from "node:test";
import assert from "node:assert/strict";

import { getPlatformProvider, runCli } from "../src/cli.js";

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

test("nomina init writes a portable managed inventory and private operational state", async () => {
  const filesystem = new FakeFilesystem();
  const setupCalls = [];
  const result = await runCli(
    [
      "init",
      "--project-dir", "/projects/bunnyhome",
      "--node", "pve-1",
      "--bridge", "vmbr1",
      "--storage", "local-zfs",
      "--domain", "bunnyhome.test",
      "--dns", "technitium",
      "--reverse-proxy", "caddy",
      "--ca", "caddy-internal-ca",
      "--vpn", "tailscale"
    ],
    {
      filesystem,
      runtime: proxmoxRootRuntime(),
      providerAdapters: {
        caddy: {
          setup(request) {
            setupCalls.push(request);
            return { command: "configure-caddy", provider: request.provider };
          }
        }
      }
    }
  );

  const config = filesystem.read("/projects/bunnyhome/nomina.yaml");
  const state = JSON.parse(filesystem.read("/projects/bunnyhome/.nomina/state.json"));

  assert.match(result.stdout, /project initialized/i);
  assert.match(config, /node: pve-1/);
  assert.match(config, /defaultBridge: vmbr1/);
  assert.match(config, /defaultStorage: local-zfs/);
  assert.match(config, /baseLocalDomain: bunnyhome.test/);
  assert.match(config, /service: technitium/);
  assert.match(config, /service: caddy/);
  assert.match(config, /service: caddy-internal-ca/);
  assert.match(config, /service: tailscale/);
  assert.match(config, /id: nc_/);
  assert.doesNotMatch(config, /secret/i);
  assert.deepEqual(state.secretReferences, {});
  assert.equal(filesystem.modes.get("/projects/bunnyhome/.nomina"), 0o700);
  assert.equal(filesystem.modes.get("/projects/bunnyhome/.nomina/state.json"), 0o600);
  assert.deepEqual(setupCalls.map((call) => call.provider), ["caddy"]);
  assert.deepEqual(result.setupPlan.find((step) => step.provider === "caddy"), {
    command: "configure-caddy", provider: "caddy"
  });
});

test("nomina init rejects a non-root Proxmox-shell invocation", async () => {
  await assert.rejects(
    runCli(["init", "--project-dir", "/projects/bunnyhome"], {
      filesystem: new FakeFilesystem(),
      runtime: { isRoot: () => false, isProxmoxHost: () => true }
    }),
    /must run as root/i
  );
});

test("nomina init rejects a root shell that is not a Proxmox host", async () => {
  await assert.rejects(
    runCli(["init", "--project-dir", "/projects/bunnyhome"], {
      filesystem: new FakeFilesystem(),
      runtime: { isRoot: () => true, isProxmoxHost: () => false }
    }),
    /Proxmox host/i
  );
});

test("nomina init guides the platform bootstrap in dependency order with catalog defaults", async () => {
  const filesystem = new FakeFilesystem();
  const questions = [];
  const responses = ["pve-1", "vmbr0", "local-lvm", "home.test", "", "traefik", "step-ca", "netbird"];

  await runCli(["init", "--project-dir", "/projects/home"], {
    filesystem,
    runtime: proxmoxRootRuntime(),
    prompts: {
      ask(question, fallback) {
        questions.push(question);
        return responses.shift() || fallback;
      }
    }
  });

  const config = filesystem.read("/projects/home/nomina.yaml");
  assert.deepEqual(questions, [
    "Proxmox node",
    "Default network bridge",
    "Default storage target",
    "Base local domain",
    "DNS provider (technitium — provides local DNS records and name resolution)",
    "Reverse proxy (caddy — publishes HTTPS routes to managed services; traefik — publishes HTTPS routes to managed services)",
    "Certificate authority (none — skip this optional platform layer; step-ca — issues trusted internal certificates)",
    "VPN provider (none — skip this optional platform layer; tailscale — connects the managed inventory to a private network; netbird — connects the managed inventory to a private network)"
  ]);
  assert.match(config, /service: technitium/);
  assert.match(config, /service: traefik/);
  assert.match(config, /service: step-ca/);
  assert.match(config, /service: netbird/);
});

test("every selectable platform provider exposes setup, inspection, adoption, and health-check contracts", () => {
  const adapter = {
    setup: (request) => ({ action: "setup", ...request }),
    inspect: (request) => ({ action: "inspect", ...request }),
    adopt: (request) => ({ action: "adopt", ...request }),
    healthCheck: (request) => ({ action: "healthCheck", ...request })
  };
  const managedItem = { id: "nc_example", service: "caddy" };
  const caddy = getPlatformProvider("caddy");

  assert.deepEqual(caddy.setup(adapter, managedItem), { action: "setup", provider: "caddy", managedItem });
  assert.deepEqual(caddy.inspect(adapter, managedItem), { action: "inspect", provider: "caddy", managedItem });
  assert.deepEqual(
    caddy.adopt(adapter, managedItem, { routes: ["photos.home.test"] }),
    { action: "adopt", provider: "caddy", managedItem, observedConfiguration: { routes: ["photos.home.test"] } }
  );
  assert.deepEqual(caddy.healthCheck(adapter, managedItem), { action: "healthCheck", provider: "caddy", managedItem });
});

test("nomina init rejects incompatible certificate authority choices", async () => {
  await assert.rejects(
    runCli(
      [
        "init", "--project-dir", "/projects/bunnyhome", "--node", "pve-1",
        "--bridge", "vmbr0", "--storage", "local", "--domain", "home.test",
        "--reverse-proxy", "traefik", "--ca", "caddy-internal-ca"
      ],
      { filesystem: new FakeFilesystem(), runtime: proxmoxRootRuntime() }
    ),
    /not compatible/i
  );
});

test("nomina init does not overwrite an existing project configuration", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", "existing configuration\n");

  await assert.rejects(
    runCli(["init", "--project-dir", "/projects/bunnyhome"], {
      filesystem,
      runtime: proxmoxRootRuntime()
    }),
    /already exists/i
  );
});
