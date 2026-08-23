import test from "node:test";
import assert from "node:assert/strict";

import { findProjectDirectory } from "../src/config.js";
import { runCli } from "../src/cli.js";
import {
  buildMenuOptions,
  canProvisionCaddy,
  canProvisionTechnitium,
  canProvisionTraefik,
  canPublishExposure,
  runInteractiveApp,
  selectLxcTemplate
} from "../src/tui.js";

test("selectLxcTemplate falls back to a text prompt with the deployment default when no templates are detected", async () => {
  const asks = [];
  const selected = await selectLxcTemplate(
    { ask: async (question, fallback) => { asks.push({ question, fallback }); return "debian-12-standard"; } },
    undefined,
    "debian-12-standard"
  );

  assert.equal(selected, "debian-12-standard");
  assert.deepEqual(asks, [{ question: "LXC template", fallback: "debian-12-standard" }]);
});

test("selectLxcTemplate offers detected template volumes and preselects the default when present", async () => {
  const volumes = [
    "local:vztmpl/debian-13-standard_13.7-1_amd64.tar.zst",
    "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst"
  ];
  const calls = [];
  const selected = await selectLxcTemplate(
    {
      select: async (request) => {
        calls.push(request);
        return volumes[1];
      }
    },
    [...volumes, volumes[0]],
    "debian-12-standard"
  );

  assert.equal(selected, volumes[1]);
  assert.deepEqual(calls, [{
    message: "LXC template",
    options: volumes.map((volume) => ({ value: volume, label: volume })),
    initialValue: volumes[1]
  }]);
});

test("selectLxcTemplate cancels setup when the selection is dismissed", async () => {
  await assert.rejects(
    selectLxcTemplate(
      { select: async () => undefined },
      ["local:vztmpl/debian-13-standard_13.7-1_amd64.tar.zst"],
      "debian-12-standard"
    ),
    /Setup cancelled\./
  );
});

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

test("findProjectDirectory locates nomina.yaml in the current folder", () => {
  const filesystem = new FakeFilesystem();
  filesystem.writeFile("/srv/homelab/nomina.yaml", "project\n");

  assert.equal(findProjectDirectory(filesystem, "/srv/homelab"), "/srv/homelab");
  assert.equal(findProjectDirectory(filesystem, "/srv/homelab/apps"), "/srv/homelab");
  assert.equal(findProjectDirectory(filesystem, "/missing"), undefined);
});

test("nomina opens the interactive menu when run with no arguments", async () => {
  const commands = [];
  const result = await runCli([], {
    filesystem: new FakeFilesystem(),
    cwd: "/projects/new",
    interactive: {
      run: async () => {
        commands.push("menu");
        return { stdout: "", cancelled: true };
      }
    }
  });

  assert.deepEqual(commands, ["menu"]);
  assert.equal(result.cancelled, true);
});

test("interactive menu can route to service add technitium", async () => {
  const commands = [];
  await runInteractiveApp({
    filesystem: {
      exists: (path) => path === "/projects/home/nomina.yaml",
      read: () => ""
    },
    cwd: "/projects/home",
    interactive: {
      chooseAction: async () => "provision-technitium"
    },
    runCommand: async (argumentsList) => {
      commands.push(argumentsList);
      return { stdout: "provisioned\n" };
    }
  });

  assert.deepEqual(commands, [["service", "add", "technitium"]]);
});

test("interactive menu can route to service add caddy", async () => {
  const commands = [];
  await runInteractiveApp({
    filesystem: {
      exists: (path) => path === "/projects/home/nomina.yaml",
      read: () => ""
    },
    cwd: "/projects/home",
    interactive: {
      chooseAction: async () => "provision-caddy"
    },
    runCommand: async (argumentsList) => {
      commands.push(argumentsList);
      return { stdout: "provisioned\n" };
    }
  });

  assert.deepEqual(commands, [["service", "add", "caddy"]]);
});

test("interactive menu can route to exposure publish", async () => {
  const commands = [];
  await runInteractiveApp({
    filesystem: {
      exists: (path) => path === "/projects/home/nomina.yaml",
      read: () => ""
    },
    cwd: "/projects/home",
    interactive: {
      chooseAction: async () => "publish-exposure"
    },
    runCommand: async (argumentsList) => {
      commands.push(argumentsList);
      return { stdout: "published\n" };
    }
  });

  assert.deepEqual(commands, [["exposure", "publish"]]);
});

test("buildMenuOptions offers Caddy after Technitium is provisioned", () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium" },
          reverseProxy: { id: "nc_proxy_test", service: "caddy" }
        }
      }
    },
    state: {
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" }
      }
    }
  };

  assert.equal(canProvisionTechnitium(project), false);
  assert.equal(canProvisionCaddy(project), true);
  assert.equal(canPublishExposure(project), false);
  assert.deepEqual(
    buildMenuOptions(project).map((option) => option.value),
    ["provision-caddy", "upgrade-service", "remove-service", "destroy-service", "nuclear-uninstall", "init", "exit"]
  );
});

test("buildMenuOptions offers exposure publish when DNS and Caddy are provisioned", () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium" },
          reverseProxy: { id: "nc_proxy_test", service: "caddy" }
        }
      }
    },
    state: {
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      }
    }
  };

  assert.equal(canPublishExposure(project), true);
  assert.deepEqual(
    buildMenuOptions(project).map((option) => option.value),
    ["publish-exposure", "toggle-http-redirect", "upgrade-service", "remove-service", "destroy-service", "nuclear-uninstall", "init", "exit"]
  );
});

test("nomina service add caddy can prompt for the static IP", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", `apiVersion: nomina.connect/v0alpha1
kind: NominaConnect
proxmox:
  node: pve-1
  defaultBridge: vmbr0
  defaultStorage: local-lvm
baseLocalDomain: bunnyhome.test
managedInventory:
  platform:
    dns:
      id: nc_dns_test
      service: technitium
      deployment:
        ip: 10.0.0.53
        hostname: technitium
    reverseProxy:
      id: nc_proxy_test
      service: caddy
    certificateAuthority: null
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test
`);
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", JSON.stringify({
    version: 1,
    providerReferences: { nc_dns_test: { vmid: 120, ip: "10.0.0.53" } },
    tracking: { notices: [] }
  }));

  const result = await runCli(
    ["service", "add", "caddy", "--project-dir", "/projects/bunnyhome"],
    {
      filesystem,
      runtime: { isRoot: () => true, isProxmoxHost: () => true },
      proxmox: {
        checkIpAvailability: () => ({ status: "available" }),
        createLxc: (spec) => ({ vmid: 121, hostname: spec.hostname }),
        pctExec: () => ({ exitCode: 0 })
      },
      providerAdapters: {
        caddy: {
          setup: (plan) => ({ ...plan, lxcCommands: ["install-caddy", "configure-https-routes"] }),
          inspect: () => ({ resources: [{ id: "existing.bunnyhome.test", route: "https://existing.bunnyhome.test" }] }),
          healthCheck: () => ({ process: "running", endpoint: "reachable" })
        }
      },
      prompts: {
        ask: async (question, fallback) => {
          if (question === "Static IP for Caddy") return "10.0.0.54";
          if (question === "LXC hostname") return fallback;
          return fallback;
        },
        confirm: async () => true
      }
    }
  );

  assert.match(result.stdout, /10\.0\.0\.54/);
  assert.match(result.stdout, /Caddy provisioned/i);
});

test("nomina exposure publish can prompt for hostname and backend", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", `apiVersion: nomina.connect/v0alpha1
kind: NominaConnect
proxmox:
  node: pve-1
  defaultBridge: vmbr0
  defaultStorage: local-lvm
baseLocalDomain: bunnyhome.test
managedInventory:
  platform:
    dns:
      id: nc_dns_test
      service: technitium
      deployment:
        ip: 10.0.0.53
        hostname: technitium
    reverseProxy:
      id: nc_proxy_test
      service: caddy
      deployment:
        ip: 10.0.0.54
        hostname: caddy
    certificateAuthority: null
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test
`);
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", JSON.stringify({
    version: 1,
    providerReferences: {
      nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
      nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
    },
    tracking: { notices: [] }
  }));

  const result = await runCli(
    ["exposure", "publish", "--project-dir", "/projects/bunnyhome"],
    {
      filesystem,
      runtime: { isRoot: () => true, isProxmoxHost: () => true },
      providerAdapters: {
        technitium: {
          publishRecord: () => ({ id: "photos.bunnyhome.test" }),
          inspect: () => ({ resources: [] }),
          healthCheckExposure: () => ({ dns: "reachable", status: "healthy" })
        },
        caddy: {
          publishRoute: () => ({ id: "photos.bunnyhome.test" }),
          inspect: () => ({ resources: [] }),
          healthCheckExposure: () => ({ https: "reachable", status: "healthy" })
        }
      },
      prompts: {
        ask: async (question, fallback) => {
          if (question === "Service name") return "photos";
          if (question === "Full hostname") return fallback;
          if (question === "Backend IP") return "10.0.0.100";
          if (question === "Backend port") return "8080";
          return fallback;
        }
      }
    }
  );

  assert.match(result.stdout, /photos\.bunnyhome\.test/i);
  assert.match(result.stdout, /published/i);
});

test("nomina service add technitium can prompt for the static IP", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", `apiVersion: nomina.connect/v0alpha1
kind: NominaConnect
proxmox:
  node: pve-1
  defaultBridge: vmbr0
  defaultStorage: local-lvm
baseLocalDomain: bunnyhome.test
managedInventory:
  platform:
    dns:
      id: nc_dns_test
      service: technitium
    reverseProxy: null
    certificateAuthority: null
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
`);
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", JSON.stringify({
    version: 1,
    providerReferences: {},
    tracking: { notices: [] }
  }));

  const proxmox = {
    checkIpAvailability: () => ({ status: "available" }),
    createLxc: (spec) => ({ vmid: 120, hostname: spec.hostname }),
    pctExec: () => ({ exitCode: 0 })
  };

  const result = await runCli(
    ["service", "add", "technitium", "--project-dir", "/projects/bunnyhome"],
    {
      filesystem,
      runtime: { isRoot: () => true, isProxmoxHost: () => true },
      proxmox,
      providerAdapters: {
        technitium: {
          setup: (plan) => plan,
          inspect: () => ({ resources: [{ id: "bunnyhome.test", record: "zone" }] }),
          healthCheck: () => ({ process: "running", endpoint: "reachable" })
        }
      },
      prompts: {
        ask: async (question, fallback) => {
          if (question === "Static IP for Technitium") return "10.0.0.53";
          if (question === "LXC hostname") return fallback;
          if (question.startsWith("Use recommended resources")) return "y";
          return fallback;
        },
        confirm: async () => true
      }
    }
  );

  assert.match(result.stdout, /10\.0\.0\.53/);
});

test("buildMenuOptions hides Technitium when it is already provisioned", () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium" }
        }
      }
    },
    state: {
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" }
      }
    }
  };

  assert.equal(canProvisionTechnitium(project), false);
  assert.deepEqual(
    buildMenuOptions(project).map((option) => option.value),
    ["upgrade-service", "remove-service", "destroy-service", "nuclear-uninstall", "init", "exit"]
  );
});

test("nomina init uses guided prompts when run without flags", async () => {
  const filesystem = new FakeFilesystem();

  await runCli(["init"], {
    filesystem,
    cwd: "/projects/home",
    runtime: { isRoot: () => true, isProxmoxHost: () => true },
    prompts: {
      ask: async (question) => {
        const answers = {
          "Proxmox node": "pve-1",
          "Default network bridge": "vmbr0",
          "Default storage target": "local-lvm",
          "Base local domain": "home.test"
        };
        return answers[question];
      },
      select: async ({ message }) => {
        if (message === "DNS provider") return "technitium";
        if (message === "Reverse proxy") return "caddy";
        if (message === "Certificate authority") return "none";
        if (message === "VPN provider") return "none";
        throw new Error(`Unexpected select: ${message}`);
      }
    }
  });

  assert.match(filesystem.read("/projects/home/nomina.yaml"), /service: caddy/);
});

test("nomina service add without a service name auto-selects the only provisionable service", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", `apiVersion: nomina.connect/v0alpha1
kind: NominaConnect
proxmox:
  node: pve-1
  defaultBridge: vmbr0
  defaultStorage: local-lvm
baseLocalDomain: bunnyhome.test
managedInventory:
  platform:
    dns:
      id: nc_dns_test
      service: technitium
    reverseProxy: null
    certificateAuthority: null
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
`);
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", JSON.stringify({
    version: 1,
    providerReferences: {},
    tracking: { notices: [] }
  }));

  const result = await runCli(
    ["service", "add", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.53"],
    {
      filesystem,
      runtime: { isRoot: () => true, isProxmoxHost: () => true },
      proxmox: {
        checkIpAvailability: () => ({ status: "available" }),
        createLxc: (spec) => ({ vmid: 120, hostname: spec.hostname }),
        pctExec: () => ({ exitCode: 0 })
      },
      providerAdapters: {
        technitium: {
          setup: (plan) => plan,
          inspect: () => ({ resources: [{ id: "bunnyhome.test", record: "zone" }] }),
          healthCheck: () => ({ process: "running", endpoint: "reachable" })
        }
      }
    }
  );

  assert.match(result.stdout, /Technitium provisioned/);
});

test("interactive menu can route to service add traefik", async () => {
  const commands = [];
  await runInteractiveApp({
    filesystem: {
      exists: (path) => path === "/projects/home/nomina.yaml",
      read: () => ""
    },
    cwd: "/projects/home",
    interactive: {
      chooseAction: async () => "provision-traefik"
    },
    runCommand: async (argumentsList) => {
      commands.push(argumentsList);
      return { stdout: "provisioned\n" };
    }
  });

  assert.deepEqual(commands, [["service", "add", "traefik"]]);
});

test("buildMenuOptions offers Traefik after Technitium is provisioned", () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium" },
          reverseProxy: { id: "nc_proxy_test", service: "traefik" }
        }
      }
    },
    state: {
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" }
      }
    }
  };

  assert.equal(canProvisionTechnitium(project), false);
  assert.equal(canProvisionTraefik(project), true);
  assert.equal(canPublishExposure(project), false);
  assert.deepEqual(
    buildMenuOptions(project).map((option) => option.value),
    ["provision-traefik", "upgrade-service", "remove-service", "destroy-service", "nuclear-uninstall", "init", "exit"]
  );
});

test("buildMenuOptions offers exposure publish when DNS and Traefik are provisioned", () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          dns: { id: "nc_dns_test", service: "technitium" },
          reverseProxy: { id: "nc_proxy_test", service: "traefik" }
        }
      }
    },
    state: {
      providerReferences: {
        nc_dns_test: { vmid: 120, ip: "10.0.0.53" },
        nc_proxy_test: { vmid: 121, ip: "10.0.0.54" }
      }
    }
  };

  assert.equal(canPublishExposure(project), true);
  assert.deepEqual(
    buildMenuOptions(project).map((option) => option.value),
    ["publish-exposure", "upgrade-service", "remove-service", "destroy-service", "nuclear-uninstall", "init", "exit"]
  );
});

test("nomina service add traefik can prompt for the static IP", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", `apiVersion: nomina.connect/v0alpha1
kind: NominaConnect
proxmox:
  node: pve-1
  defaultBridge: vmbr0
  defaultStorage: local-lvm
baseLocalDomain: bunnyhome.test
managedInventory:
  platform:
    dns:
      id: nc_dns_test
      service: technitium
      deployment:
        ip: 10.0.0.53
        hostname: technitium
    reverseProxy:
      id: nc_proxy_test
      service: traefik
    certificateAuthority: null
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test
`);
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", JSON.stringify({
    version: 1,
    providerReferences: { nc_dns_test: { vmid: 120, ip: "10.0.0.53" } },
    tracking: { notices: [] }
  }));

  const result = await runCli(
    ["service", "add", "traefik", "--project-dir", "/projects/bunnyhome"],
    {
      filesystem,
      runtime: { isRoot: () => true, isProxmoxHost: () => true },
      proxmox: {
        checkIpAvailability: () => ({ status: "available" }),
        createLxc: (spec) => ({ vmid: 121, hostname: spec.hostname }),
        pctExec: () => ({ exitCode: 0 })
      },
      providerAdapters: {
        traefik: {
          setup: (plan) => ({ ...plan, lxcCommands: ["install-traefik", "configure-https-routes"] }),
          inspect: () => ({ resources: [{ id: "existing.bunnyhome.test", route: "https://existing.bunnyhome.test" }] }),
          healthCheck: () => ({ process: "running", endpoint: "reachable" })
        }
      },
      prompts: {
        ask: async (question, fallback) => {
          if (question === "Static IP for Traefik") return "10.0.0.54";
          if (question === "LXC hostname") return fallback;
          return fallback;
        },
        confirm: async () => true
      }
    }
  );

  assert.match(result.stdout, /10\.0\.0\.54/);
  assert.match(result.stdout, /Traefik provisioned/i);
});

test("nomina service add without a service name auto-selects traefik when traefik is the only provisionable service", async () => {
  const filesystem = new FakeFilesystem();
  filesystem.writeFile("/projects/bunnyhome/nomina.yaml", `apiVersion: nomina.connect/v0alpha1
kind: NominaConnect
proxmox:
  node: pve-1
  defaultBridge: vmbr0
  defaultStorage: local-lvm
baseLocalDomain: bunnyhome.test
managedInventory:
  platform:
    dns:
      id: nc_dns_test
      service: technitium
      deployment:
        ip: 10.0.0.53
        hostname: technitium
    reverseProxy:
      id: nc_proxy_test
      service: traefik
    certificateAuthority: null
    vpn: null
  services: []
connectionSecretReferences:
  nc_dns_test: nominaconnect/provider/nc_dns_test
  nc_proxy_test: nominaconnect/provider/nc_proxy_test
`);
  filesystem.writeFile("/projects/bunnyhome/.nomina/state.json", JSON.stringify({
    version: 1,
    providerReferences: {
      nc_dns_test: { vmid: 120, ip: "10.0.0.53" }
    },
    tracking: { notices: [] }
  }));

  const result = await runCli(
    ["service", "add", "--project-dir", "/projects/bunnyhome", "--ip", "10.0.0.54"],
    {
      filesystem,
      runtime: { isRoot: () => true, isProxmoxHost: () => true },
      proxmox: {
        checkIpAvailability: () => ({ status: "available" }),
        createLxc: (spec) => ({ vmid: 121, hostname: spec.hostname }),
        pctExec: () => ({ exitCode: 0 })
      },
      providerAdapters: {
        traefik: {
          setup: (plan) => plan,
          inspect: () => ({ resources: [{ id: "existing.bunnyhome.test", route: "https://existing.bunnyhome.test" }] }),
          healthCheck: () => ({ process: "running", endpoint: "reachable" })
        }
      }
    }
  );

  assert.match(result.stdout, /Traefik provisioned/);
});

test("editing an exposure lets you flip the backend TLS setting", async () => {
  const filesystem = {
    exists: (path) => path === "/projects/home/nomina.yaml" || path === "/projects/home/.nomina/state.json",
    read: (path) => path.endsWith("state.json")
      ? JSON.stringify({
          version: 1,
          providerReferences: { d: { vmid: 1, ip: "10.0.0.53" }, p: { vmid: 2, ip: "10.0.0.54" } },
          tracking: { notices: [] }
        })
      : `apiVersion: nomina.connect/v0alpha1
kind: NominaConnect
proxmox:
  node: pve-1
  defaultBridge: vmbr0
  defaultStorage: local-lvm
baseLocalDomain: bunny.internal
managedInventory:
  platform:
    dns:
      id: d
      service: technitium
      deployment:
        ip: 10.0.0.53
        hostname: technitium
    reverseProxy:
      id: p
      service: caddy
      deployment:
        ip: 10.0.0.54
        hostname: caddy
    certificateAuthority: null
    vpn: null
  services:
    - id: e1
      name: pve
      exposure:
        hostname: pve.bunny.internal
        backend:
          ip: 10.0.0.1
          port: 8006
          tls: true
        protocol: https
connectionSecretReferences: {}
`
  };

  const commands = [];
  await runInteractiveApp({
    filesystem,
    cwd: "/projects/home",
    interactive: {
      chooseAction: async () => "edit-exposure"
    },
    prompts: {
      ask: async (message) => message.startsWith("Exposure to manage") ? "e1" : undefined,
      confirm: async ({ initialValue }) => initialValue === true ? false : true // flip the TLS answer
    },
    runCommand: async (argumentsList) => {
      commands.push(argumentsList);
      return { stdout: "updated\n" };
    }
  });

  assert.equal(commands.length, 1);
  assert.equal(commands[0].includes("--backend-tls"), false,
    "answering 'no' to the TLS prompt must drop the --backend-tls flag");

  commands.length = 0;
  await runInteractiveApp({
    filesystem,
    cwd: "/projects/home",
    interactive: {
      chooseAction: async () => "edit-exposure"
    },
    prompts: {
      ask: async (message) => message.startsWith("Exposure to manage") ? "e1" : undefined,
      confirm: async ({ initialValue }) => initialValue === true
    },
    runCommand: async (argumentsList) => {
      commands.push(argumentsList);
      return { stdout: "updated\n" };
    }
  });
  assert.equal(commands[0].includes("--backend-tls"), true,
    "keeping the TLS answer must preserve the --backend-tls flag");
});
