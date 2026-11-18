import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import tls from "node:tls";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import packet from "dns-packet";
import { PNG } from "pngjs";
import { runCli } from "../src/cli.js";
import { runInteractiveApp } from "../src/tui.js";
import { deviceMenu } from "../src/device-menu.js";
import {
  fetchProfileRoot,
  validateRoot,
  validateDefinition,
} from "../src/device-definition.js";
import { queryTls, listenerPlan } from "../src/device-resolver.js";
import {
  serializeProjectConfiguration,
  parseProjectConfiguration,
  writeDevicePackageSelections,
} from "../src/config.js";
import { exportBundle } from "../src/device-export.js";

const fixturePowerShell = process.env.NOMINA_DEVICE_TEST_PWSH ?? "pwsh";
const base = {
  name: "family",
  displayName: "Family & friends",
  targets: ["apple", "windows"],
  appleDns: "encrypted",
  resolver: "dns.home.test",
  addresses: ["192.168.1.53", "fd00::53"],
  mode: "private-domain",
  suffix: "Home.Test.",
  ssids: ["It's <home>"],
};
let dir, cert, pem, key, leaf;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomina-device-test-"));
  function ssl(args) {
    execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  }
  ssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=Temporary fixture root",
    "-days",
    "1",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
  ]);
  ssl([
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=dns.home.test",
    "-keyout",
    "leaf.key",
    "-out",
    "leaf.req",
  ]);
  fs.writeFileSync(
    path.join(dir, "extensions"),
    "basicConstraints=CA:FALSE\nsubjectAltName=DNS:dns.home.test\n",
  );
  ssl([
    "x509",
    "-req",
    "-in",
    "leaf.req",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "1",
    "-extfile",
    "extensions",
    "-out",
    "leaf.crt",
  ]);
  pem = fs.readFileSync(path.join(dir, "ca.crt"), "utf8");
  cert = validateRoot(pem);
  key = fs.readFileSync(path.join(dir, "leaf.key"));
  leaf = fs.readFileSync(path.join(dir, "leaf.crt"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

test("rejects ambiguous, expired, non-CA, key and malformed trust material", () => {
  for (const material of [
    pem + pem,
    pem + key,
    leaf.toString(),
    pem.replace("CERTIFICATE", "DATA"),
  ])
    assert.throws(() => validateRoot(material));
  assert.throws(() => validateRoot(pem, Date.now() + 365 * 86400000));
});
test("package selection validation and visible config round trip", () => {
  const pkg = validateDefinition(base);
  assert.deepEqual(pkg.shortcuts, []);
  assert.equal(pkg.suffix, "home.test");
  const config = {
    proxmox: {},
    baseLocalDomain: "home.test",
    managedInventory: {
      platform: {
        dns: null,
        reverseProxy: null,
        certificateAuthority: null,
        vpn: null,
      },
      services: [],
    },
    connectionSecretReferences: {},
    devicePackages: [pkg],
  };
  assert.deepEqual(
    parseProjectConfiguration(serializeProjectConfiguration(config))
      .devicePackages,
    [pkg],
  );
  const { appleDns, ...previewDefinition } = pkg;
  assert.deepEqual(
    parseProjectConfiguration(
      "devicePackages: " + JSON.stringify([previewDefinition]),
    ).devicePackages,
    [pkg],
  );
  assert.deepEqual(
    parseProjectConfiguration("kind: NominaConnect\n").devicePackages,
    [],
  );
  for (const url of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://u:p@site.test/",
    "https://site.test/\nIconFile=evil",
  ])
    assert.throws(() =>
      validateDefinition({ ...base, shortcuts: [{ name: "x", url }] }),
    );
  for (const name of ["x\\y", "CON.txt", "name.", "x\nabc"])
    assert.throws(() =>
      validateDefinition({
        ...base,
        shortcuts: [{ name, url: "https://example.test" }],
      }),
    );
});

function mockProject() {
  const projectDirectory = fs.mkdtempSync(path.join(dir, "project-"));
  const fsAdapter = {
    exists: fs.existsSync,
    read: (p) => fs.readFileSync(p, "utf8"),
    writeFile: fs.writeFileSync,
    rename: fs.renameSync,
    chmod: fs.chmodSync,
  };
  fs.mkdirSync(path.join(projectDirectory, ".nomina"));
  fs.writeFileSync(
    path.join(projectDirectory, ".nomina/state.json"),
    JSON.stringify({
      providerReferences: {
        ca: { vmid: "201" },
        dns: { vmid: "202", ip: base.addresses[0] },
      },
    }),
  );
  fs.writeFileSync(
    path.join(projectDirectory, "nomina.yaml"),
    serializeProjectConfiguration({
      baseLocalDomain: "home.test",
      proxmox: {},
      managedInventory: {
        platform: {
          reverseProxy: null,
          vpn: null,
          dns: { id: "dns", service: "technitium" },
          certificateAuthority: { id: "ca", service: "step-ca" },
        },
        services: [],
      },
      connectionSecretReferences: {},
    }),
  );
  const adapters = {
    cwd: projectDirectory,
    filesystem: fsAdapter,
    proxmox: {
      pctExec: async (_, q) => ({ stdout: q.binary === "/bin/cat" ? pem : "" }),
    },
    deviceResolverCheck: async () => {},
  };
  const cmd = (...args) =>
    runCli(
      ["ca", "profile", ...args, "--project-dir", projectDirectory],
      adapters,
    );
  const configure = (...extra) =>
    cmd(
      "configure",
      "--name",
      "family",
      "--ssid",
      base.ssids[0],
      "--target",
      "apple",
      "--apple-dns",
      "encrypted",
      "--resolver",
      base.resolver,
      "--address",
      base.addresses[0],
      "--mode",
      "private-domain",
      "--suffix",
      base.suffix,
      ...extra,
    );
  return { cmd, configure, adapters, projectDirectory };
}

test("adding and editing a device package preserves existing project YAML byte-for-byte outside its field", async () => {
  const { cmd, configure, projectDirectory } = mockProject();
  const file = path.join(projectDirectory, "nomina.yaml");
  const legacy =
    fs
      .readFileSync(file, "utf8")
      .replace(
        "managedInventory:",
        "# Operator notes\nfutureSetting: enabled\nmanagedInventory:",
      )
      .trimEnd() + "\n  dns: secret://existing-reference\n";
  const original = legacy.replaceAll("\n", "\r\n");
  fs.writeFileSync(file, original);
  await configure();
  await cmd("configure", "--name", "family", "--display-name", "Household $&");
  const saved = fs.readFileSync(file, "utf8");
  assert.equal(saved.replace(/^devicePackages:[^\r\n]*\r\n/gm, ""), original);
  assert.equal(
    parseProjectConfiguration(saved).connectionSecretReferences.dns,
    "secret://existing-reference",
  );
  assert.equal(
    JSON.parse((await cmd("inspect", "--name", "family")).stdout).displayName,
    "Household $&",
  );
});

function parsePlist(file) {
  if (process.platform === "darwin")
    execFileSync("/usr/bin/plutil", ["-lint", file]);
  const source =
    'import plistlib,json,base64,sys; print(json.dumps(plistlib.load(open(sys.argv[1],"rb")),default=lambda b:base64.b64encode(b).decode()))';
  return JSON.parse(
    execFileSync("python3", ["-c", source, file], { encoding: "utf8" }),
  );
}
test("CLI exports both Apple policies, same identity, validated payloads and separate Mac clip scope", async () => {
  const { cmd, configure, adapters, projectDirectory } = mockProject();
  await configure();
  const one = path.join(projectDirectory, "first");
  await cmd("export", "--name", "family", "--output", one);
  const a = parsePlist(path.join(one, "mobile.mobileconfig"));
  assert.equal(a.PayloadContent.length, 2);
  assert.deepEqual(
    Buffer.from(a.PayloadContent[0].PayloadContent, "base64"),
    cert.raw,
  );
  assert.equal(a.PayloadContent[1].DNSSettings.AllowFailover, false);
  assert.deepEqual(a.PayloadContent[1].DNSSettings.SupplementalMatchDomains, [
    "home.test",
  ]);
  assert.deepEqual(a.PayloadContent[1].OnDemandRules, [
    { Action: "Connect", InterfaceTypeMatch: "WiFi", SSIDMatch: base.ssids },
    { Action: "Disconnect" },
  ]);
  const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
  fs.writeFileSync(path.join(projectDirectory, "house.png"), png);
  await cmd(
    "configure",
    "--name",
    "family",
    "--mode",
    "whole-system",
    "--shortcut",
    JSON.stringify({
      name: "A < B",
      url: "https://example.test/?a=b&c=d",
      opening: "ios-fullscreen",
      icon: "house.png",
    }),
    "--shortcut",
    JSON.stringify({ name: "Two", url: "http://home.test/other" }),
  );
  const two = path.join(projectDirectory, "second");
  await cmd("export", "--name", "family", "--output", two);
  const b = parsePlist(path.join(two, "mobile.mobileconfig")),
    mac = parsePlist(path.join(two, "mac-shortcuts.mobileconfig"));
  assert.equal(b.PayloadIdentifier, a.PayloadIdentifier);
  assert.equal(b.PayloadUUID, a.PayloadUUID);
  assert.equal(
    b.PayloadContent[1].DNSSettings.SupplementalMatchDomains,
    undefined,
  );
  assert.equal(b.PayloadContent[2].Label, "A < B");
  assert.equal(b.PayloadContent[2].FullScreen, true);
  assert.ok(b.PayloadContent[2].Icon);
  assert.equal(mac.PayloadScope, "User");
  assert.equal(mac.PayloadContent[0].FullScreen, undefined);
  assert.equal(mac.PayloadContent.length, 2);
  await assert.rejects(
    cmd("export", "--name", "family", "--output", two),
    /exists/,
  );
  adapters.deviceResolverCheck = async () => {
    throw new Error("resolver offline");
  };
  await assert.rejects(
    cmd("export", "--name", "family", "--output", two + "-failed"),
    /offline/,
  );
  assert.ok(!fs.existsSync(two + "-failed"));
});

test("managed Technitium is the default device resolver in the wizard and CLI", async () => {
  const { cmd, adapters } = mockProject();
  const prompts = {
    select: async ({ message, options, initialValue }) => {
      if (message === "Devices") return "windows";
      if (message === "DNS server for household devices")
        assert.equal(
          options[0].label,
          "Use managed Technitium (" + base.addresses[0] + ")",
        );
      return initialValue;
    },
    ask: async (message, fallback) => {
      if (message.startsWith("Package ID")) return "from-menu";
      if (message === "Exact home Wi-Fi name") return base.ssids[0];
      if (message === "Private DNS suffix") return base.suffix;
      assert.ok(fallback, message);
      return fallback;
    },
    confirm: async ({ message }) => message === "Save these selections?",
    info: () => {},
  };
  await deviceMenu({ ...adapters, prompts, runCommand: runCli });
  const inspect = async (name) =>
    JSON.parse((await cmd("inspect", "--name", name)).stdout);
  assert.deepEqual((await inspect("from-menu")).addresses, [base.addresses[0]]);

  const save = (...args) => cmd("configure", "--name", "from-cli", ...args);
  await save(
    "--target",
    "windows",
    "--mode",
    "whole-system",
    "--ssid",
    base.ssids[0],
  );
  assert.deepEqual((await inspect("from-cli")).addresses, [base.addresses[0]]);
  await save("--address", "192.168.1.99");
  await save("--display-name", "Custom resolver");
  assert.deepEqual((await inspect("from-cli")).addresses, ["192.168.1.99"]);
});

function seedLegacyHomeCheck(projectDirectory, homeCheck) {
  const file = path.join(projectDirectory, "nomina.yaml");
  const document = fs.readFileSync(file, "utf8");
  const config = parseProjectConfiguration(document);
  config.devicePackages[0].homeCheck = homeCheck;
  fs.writeFileSync(
    file,
    writeDevicePackageSelections(document, config.devicePackages),
  );
}

test("extra Wi-Fi checks are disabled for new settings and preserved in old exports", async () => {
  const { cmd, configure, projectDirectory } = mockProject();
  const homeCheck = {
    dnsServers: ["192.168.1.1", "fd00:0::1"],
    probeUrl: "https://192.168.4.90/health",
  };
  await assert.rejects(
    configure("--home-check", JSON.stringify(homeCheck)),
    /New packages match by Wi-Fi name/,
  );
  await configure();
  seedLegacyHomeCheck(projectDirectory, homeCheck);
  const output = path.join(projectDirectory, "distinct-wifi");
  await cmd("export", "--name", "family", "--output", output);
  const apple = parsePlist(path.join(output, "mac.mobileconfig"));
  assert.deepEqual(apple.PayloadContent[1].OnDemandRules, [
    {
      Action: "Connect",
      InterfaceTypeMatch: "WiFi",
      SSIDMatch: base.ssids,
      DNSServerAddressMatch: ["192.168.1.1", "fd00::1"],
      URLStringProbe: "https://192.168.4.90/health",
    },
    { Action: "Disconnect" },
  ]);
  await cmd("configure", "--name", "family", "--home-check", "{}");
  const saved = JSON.parse((await cmd("inspect", "--name", "family")).stdout);
  assert.equal(saved.homeCheck, undefined);
});

test("an existing project can opt into Apple trust first and add or remove DoT under the same package identity", async () => {
  const { cmd, adapters, projectDirectory } = mockProject();
  const configFile = path.join(projectDirectory, "nomina.yaml");
  const stateFile = path.join(projectDirectory, ".nomina/state.json");
  const originalConfig = fs.readFileSync(configFile, "utf8");
  const originalState = fs.readFileSync(stateFile, "utf8");
  let resolverChecks = 0;
  adapters.deviceResolverCheck = async () => {
    resolverChecks++;
  };
  assert.equal((await cmd("list")).stdout.trim(), "[]");
  assert.equal(fs.readFileSync(configFile, "utf8"), originalConfig);
  assert.equal(fs.readFileSync(stateFile, "utf8"), originalState);

  const save = (...flags) => cmd("configure", "--name", "family", ...flags);
  const bundle = async (name) => {
    const output = path.join(projectDirectory, name);
    await cmd("export", "--name", "family", "--output", output);
    return parsePlist(path.join(output, "mac.mobileconfig"));
  };
  await save("--target", "apple");
  assert.match(
    (await cmd("resolver-check", "--name", "family")).stdout,
    /existing DNS/,
  );
  await assert.rejects(
    cmd("resolver-setup", "--name", "family"),
    /encrypted DNS selected/,
  );
  const trust = await bundle("trust");
  assert.equal(trust.PayloadContent.length, 1);
  assert.equal(trust.PayloadContent[0].PayloadType, "com.apple.security.root");
  assert.equal(resolverChecks, 0);

  await save(
    "--apple-dns",
    "encrypted",
    "--mode",
    "private-domain",
    "--suffix",
    base.suffix,
    "--ssid",
    base.ssids[0],
    "--address",
    base.addresses[0],
    "--resolver",
    base.resolver,
  );
  const encrypted = await bundle("encrypted");
  assert.equal(encrypted.PayloadIdentifier, trust.PayloadIdentifier);
  assert.deepEqual(encrypted.PayloadContent[0], trust.PayloadContent[0]);
  assert.equal(encrypted.PayloadContent[1].DNSSettings.DNSProtocol, "TLS");
  assert.equal(resolverChecks, 1);

  await save("--apple-dns", "existing");
  assert.deepEqual(await bundle("trust-again"), trust);
  assert.equal(resolverChecks, 1);
  assert.equal(
    fs.readFileSync(configFile, "utf8").replace(/^devicePackages:.*\n/gm, ""),
    originalConfig,
  );
  const { devicePackages, ...remainingState } = JSON.parse(
    fs.readFileSync(stateFile, "utf8"),
  );
  assert.deepEqual(remainingState, JSON.parse(originalState));
});
test("trusted Caddy retrieval reads only from its provisioned LXC", async () => {
  const project = {
    config: {
      managedInventory: {
        platform: {
          certificateAuthority: { id: "c", service: "caddy-internal-ca" },
        },
      },
    },
    state: { providerReferences: { c: { vmid: 207 } } },
  };
  const root = await fetchProfileRoot(project, {
    pctExec: async (id, q) => {
      assert.equal(id, 207);
      assert.match(q.args[0], /caddy\/pki\/authorities\/local\/root.crt$/);
      return { stdout: pem };
    },
  });
  assert.equal(root.fingerprint256, cert.fingerprint256);
  await assert.rejects(fetchProfileRoot(project, {}), /Proxmox/);
});
test("DoT fixture requires authenticated TLS, matching question and a usable DNS answer", async () => {
  let bad = false;
  const server = tls.createServer({ key, cert: leaf }, (socket) => {
    socket.on("error", () => {});
    socket.on("data", (data) => {
      const query = packet.streamDecode(data);
      socket.end(
        packet.streamEncode({
          ...query,
          type: "response",
          answers: bad
            ? []
            : [
                {
                  name: "home.test",
                  type: "SOA",
                  ttl: 5,
                  data: {
                    mname: "dns.home.test",
                    rname: "hostmaster.home.test",
                    serial: 1,
                    refresh: 60,
                    retry: 60,
                    expire: 60,
                    minimum: 60,
                  },
                },
              ],
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(true)));
  try {
    const address = server.address();
    if (typeof address === "string") throw new Error("No fixture port.");
    const query = (name, root, fingerprint = undefined) =>
      queryTls("127.0.0.1", name, "home.test", root, address.port, fingerprint);
    assert.equal(await query("dns.home.test", pem), true);
    assert.equal(await query("dns.home.test", pem, new X509Certificate(leaf).fingerprint256), true);
    await assert.rejects(query("dns.home.test", pem, cert.fingerprint256), /did not present the new TLS certificate/);
    await assert.rejects(query("wrong.home.test", pem));
    await assert.rejects(query("dns.home.test", ""));
    bad = true;
    await assert.rejects(query("dns.home.test", pem), /SOA/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
test("DoT issuance reviews first and rotates only the managed certificate with rollback on failure", async () => {
  const { adapters, projectDirectory } = mockProject();
  const settings = { version: "15.6.2", clusterInitialized: false, dnsTlsCertificatePath: "", enableDnsOverTls: false, dnsOverTlsPort: 853 };
  const csr = fs.readFileSync(path.join(dir, "leaf.req"), "utf8");
  const operations = [];
  let chain = leaf.toString();
  let verifies = true;
  const toolsDir = fs.mkdtempSync(path.join(dir, "dns-tools-"));
  fs.writeFileSync(path.join(toolsDir, "systemctl"), '#!/bin/sh\ncase "$1" in show) echo dns-server;; is-active) exit 0;; *) exit 1;; esac\n', { mode: 0o700 });
  fs.writeFileSync(path.join(toolsDir, "chown"), '#!/bin/sh\n[ "$1 $2 $3" = "-- dns-server resolver.pfx" ]\n', { mode: 0o700 });
  const fixture = {
    ...adapters,
    runtime: { isRoot: () => true, isProxmoxHost: () => true },
    proxmox: {
      pctExec: async (vmid, { binary, args, stdin }) => {
        if (binary === "/bin/cat") return { stdout: pem };
        const script = args[2];
        if (script.startsWith("cat --")) return { stdout: leaf.toString() + pem };
        operations.push(vmid === "201" ? "sign" : script.includes("openssl req") ? "csr" : script.includes("openssl verify") ? "stage" : "discard");
        if (script.includes("openssl req")) return { stdout: csr };
        if (vmid === "201") {
          assert.equal(stdin, csr);
          assert.match(script, /--san "\$2" --cnf-file/);
          assert.deepEqual(args.slice(-2), [base.resolver, base.resolver]);
          return { stdout: chain };
        }
        if (script.includes("openssl verify")) {
          assert.equal(stdin, pem.trimEnd() + "\n" + leaf.toString().trimEnd() + "\n");
          const stage = fs.mkdtempSync(path.join(dir, "dns-stage-"));
          fs.writeFileSync(path.join(stage, "key.pem"), key, { mode: 0o600 });
          execFileSync(binary, [...args.slice(0, -2), stage, args.at(-1)], {
            input: stdin, env: { ...process.env, PATH: toolsDir + path.delimiter + process.env.PATH }, stdio: "pipe",
          });
          const pfx = path.join(stage, "resolver.pfx");
          execFileSync("openssl", ["pkcs12", "-in", pfx, "-passin", "pass:", "-noout"], { stdio: "pipe" });
          assert.equal(fs.statSync(pfx).mode & 0o777, 0o600);
          assert.equal(fs.existsSync(path.join(stage, "key.pem")), false);
        }
        return { stdout: "" };
      },
    },
    providerAdapters: {
      technitium: {
        inspectTlsListener: async () => ({ ...settings }),
        setTlsCertificate: async (_, file) => {
          operations.push(file);
          settings.dnsTlsCertificatePath = file;
        },
      },
    },
    deviceTlsQuery: async (ip, host, zone, root, port, fingerprint) => {
      assert.deepEqual([ip, host, zone, root, port, fingerprint], [base.addresses[0], base.resolver, "home.test", cert.toString(), 853, new X509Certificate(leaf).fingerprint256]);
      if (!verifies) throw new Error("Fixture verification failed");
      return true;
    },
  };
  const command = (...args) => runCli(["ca", "dns-certificate", "--project-dir", projectDirectory, ...args], fixture);
  const token = async () => (await command()).stdout.trimEnd().split(" ").at(-1);
  const preview = await token();
  assert.deepEqual(operations, []);
  const cancelled = await runInteractiveApp({
    ...fixture,
    runCommand: runCli,
    interactive: { chooseAction: async ({ options }) => {
      assert.ok(options.some(option => option.value === "dns-certificate"));
      return "dns-certificate";
    } },
    prompts: { ask: async (_, initial) => initial, info: () => {}, confirm: async () => false },
  });
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(operations, []);
  await assert.rejects(command("--hostname", "different.home.test", "--approve", preview), /review has changed/);
  chain = pem;
  await assert.rejects(command("--approve", preview), /did not issue a leaf/);
  assert.deepEqual(operations.splice(0), ["csr", "sign", "discard"]);
  chain = leaf.toString();
  assert.match((await command("--approve", preview)).stdout, /DNS-over-TLS remains off/);
  const initial = settings.dnsTlsCertificatePath;
  assert.match(initial, /^\/var\/lib\/nomina-dns-tls\/.+\/resolver\.pfx$/);
  assert.deepEqual(operations.splice(0), ["csr", "sign", "stage", initial]);

  settings.enableDnsOverTls = true;
  await assert.rejects(command("--hostname", "different.home.test"), /Existing profiles depend on it/);
  verifies = false;
  await assert.rejects(command("--approve", await token()), /Fixture verification failed/);
  assert.equal(settings.dnsTlsCertificatePath, initial);
  assert.deepEqual(operations.splice(0).slice(-2), [initial, "discard"]);
  verifies = true;
  assert.match((await command("--approve", await token())).stdout, /Verified the new certificate/);
  assert.notEqual(settings.dnsTlsCertificatePath, initial);
  assert.equal(settings.enableDnsOverTls, true);
  assert.equal(operations.at(-1), "discard");

  settings.dnsTlsCertificatePath = "/etc/dns/manual.pfx";
  await assert.rejects(command(), /managed outside Nomina/);
});
test("Technitium change requires a fresh review, reuses compatible listener and rolls back only its toggle", async () => {
  const { cmd, configure, adapters } = mockProject();
  await configure();
  const settings = {
    version: "15.6.2",
    clusterInitialized: false,
    dnsTlsCertificatePath: "/certs/resolver.pfx",
    dnsOverTlsPort: 853,
    recursion: "AllowOnlyForPrivateNetworks",
    dnsServerLocalEndPoints: ["192.168.1.53:53"],
    enableDnsOverTls: false,
  };
  assert.equal(
    listenerPlan({ ...settings, version: "15.4" }, [base.addresses[0]]).version,
    "15.4",
  );
  for (const override of [
    { recursion: "Allow" },
    { dnsTlsCertificatePath: null },
    { dnsServerLocalEndPoints: ["0.0.0.0:53"] },
  ])
    assert.throws(() =>
      listenerPlan({ ...settings, ...override }, base.addresses.slice(0, 1)),
    );
  const changes = [];
  Object.assign(adapters, {
    providerAdapters: {
      technitium: {
        inspectTlsListener: async () => settings,
        setTlsEnabled: async (_, b) => {
          changes.push(b);
          settings.enableDnsOverTls = b;
        },
      },
    },
  });
  const setup = (...args) => cmd("resolver-setup", "--name", "family", ...args);
  const review = (await setup()).stdout;
  assert.match(review, /restarts its DNS listeners/);
  const token = review.split("--approve ")[1].trim();
  await assert.rejects(setup("--approve", "bad"), /review/i);
  assert.deepEqual(changes, []);
  adapters.deviceResolverCheck = async () => {
    throw new Error("TLS name mismatch");
  };
  await assert.rejects(setup("--approve", token), /TLS name/);
  assert.deepEqual(changes, [true, false]);
  adapters.deviceResolverCheck = async () => {};
  await setup("--approve", token);
  await setup();
  assert.deepEqual(changes, [true, false, true]);
});
test("post-CA skip and cancel do not run any device command", async () => {
  for (const select of [
    async ({ initialValue }) => {
      assert.equal(initialValue, "skip");
      return "skip";
    },
    async () => {
      throw new Error("Setup cancelled.");
    },
  ]) {
    const out = await deviceMenu(
      { prompts: { select }, runCommand: () => assert.fail() },
      { afterProvision: true },
    );
    assert.ok(out.cancelled);
  }
});
test(
  "Windows export builds an actual setup executable for each policy",
  { skip: spawnSync("makensis", ["-VERSION"]).status !== 0 },
  async () => {
    for (const mode of ["private-domain", "whole-system"]) {
      const pkg = validateDefinition({
        ...base,
        mode,
        targets: mode === "private-domain" ? ["windows"] : ["apple", "windows"],
        appleDns: "existing",
        shortcuts: [{ name: "Example", url: "https://example.test/path" }],
      });
      const target = path.join(dir, "win-" + mode);
      const id = randomUUID();
      await exportBundle({
        pkg,
        id,
        cert,
        output: target,
        projectDirectory: dir,
      });
      if (pkg.targets.includes("apple"))
        assert.equal(
          parsePlist(path.join(target, "mac.mobileconfig")).PayloadContent
            .length,
          1,
        );
      await exportBundle({
        pkg,
        id,
        cert,
        output: target + "-repeat",
        projectDirectory: dir,
      });
      assert.deepEqual(
        fs.readFileSync(path.join(target, "NominaDeviceSetup.exe")),
        fs.readFileSync(path.join(target + "-repeat", "NominaDeviceSetup.exe")),
      );
      assert.equal(
        fs
          .readFileSync(path.join(target, "NominaDeviceSetup.exe"))
          .subarray(0, 2)
          .toString(),
        "MZ",
      );
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(target, "manifest.json"), "utf8"))
          .mode,
        mode,
      );
      if (spawnSync("7z", ["i"]).status === 0)
        assert.match(
          execFileSync(
            "7z",
            ["l", path.join(target, "NominaDeviceSetup.exe")],
            {
              encoding: "utf8",
            },
          ),
          /device\.ps1/,
        );
    }
  },
);

test(
  "Windows lifecycle runs the shipped PowerShell functions against injected OS operations",
  {
    skip:
      spawnSync(fixturePowerShell, ["-NoProfile", "-Command", "exit"])
        .status !== 0,
  },
  () => {
    fs.writeFileSync(path.join(dir, "root.cer"), cert.raw);
    assert.match(
      execFileSync(
        fixturePowerShell,
        [
          "-NoProfile",
          "-File",
          "test/fixtures/device-lifecycle.ps1",
          path.resolve("clients/device-setup/device.ps1"),
          dir,
        ],
        { encoding: "utf8" },
      ),
      /Fixture lifecycle passed/,
    );
  },
);

test("later menu edits a saved definition and exports through the shared command", async () => {
  const { adapters, configure, projectDirectory } = mockProject();
  const homeCheck = {
    dnsServers: ["192.168.1.1"],
    probeUrl: "https://192.168.4.90/health",
  };
  await configure();
  seedLegacyHomeCheck(projectDirectory, homeCheck);
  const destination = path.join(projectDirectory, "from-menu");
  const prompts = {
    select: async ({ message, options, initialValue }) => {
      if (message === "Home Wi-Fi network")
        assert.ok(
          options.some(
            (option) => option.label === "Use Proxmox host Wi-Fi: Server Wi-Fi",
          ),
        );
      return initialValue;
    },
    ask: async (message, previous) => {
      assert.notEqual(message, "Exact home Wi-Fi name");
      return message.startsWith("Fresh export") ? destination : previous;
    },
    confirm: async ({ message }) =>
      ["Save these", "Verify resolver"].some((s) => message.startsWith(s)),
    info: () => {},
    warn: () => {},
  };
  await runInteractiveApp({
    ...adapters,
    runtime: { isProxmoxHost: () => true },
    proxmox: {
      ...adapters.proxmox,
      connectedWifiSsids: async () => ["Server Wi-Fi"],
    },
    prompts,
    interactive: {
      chooseAction: ({ options }) => {
        assert.ok(options.some((o) => o.value === "device-setup"));
        return "device-setup";
      },
    },
    runCommand: runCli,
  });
  const manifest = JSON.parse(
    fs.readFileSync(path.join(destination, "manifest.json"), "utf8"),
  );
  assert.deepEqual(manifest.homeCheck, homeCheck);
  assert.deepEqual(manifest.ssids, ["Server Wi-Fi"]);
});

test("explicit resolver migration reviews first, upgrades in place, and verifies DNS before completing", async () => {
  const { cmd, configure, adapters, projectDirectory } = mockProject();
  await configure();
  const configPath = path.join(projectDirectory, "nomina.yaml");
  const originalConfig = fs.readFileSync(configPath, "utf8");
  const statePath = path.join(projectDirectory, ".nomina/state.json");
  const originalState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const settings = {
    version: "15.4",
    clusterInitialized: false,
    dnsTlsCertificatePath: null,
    dnsOverTlsPort: 853,
    recursion: "AllowOnlyForPrivateNetworks",
    dnsServerLocalEndPoints: ["192.168.1.53:53"],
    enableDnsOverTls: false,
  };
  const writes = [];
  const authorize = (token) =>
    cmd(
      "resolver-setup",
      "--name",
      "family",
      "--upgrade-technitium",
      "--approve",
      token,
    );
  const review = () =>
    cmd("resolver-setup", "--name", "family", "--upgrade-technitium");
  Object.assign(adapters, {
    runtime: { isRoot: () => true, isProxmoxHost: () => true },
    devicePlainDnsCheck: async (ip, zone) => {
      assert.equal(ip, base.addresses[0]);
      assert.equal(zone, "home.test");
    },
    deviceResolverCheck: async () => {
      assert.equal(settings.version, "15.6.2");
      assert.equal(settings.enableDnsOverTls, true);
    },
    providerAdapters: {
      technitium: {
        inspectTlsListener: async () => ({ ...settings }),
        setTlsEnabled: async (_, enabled) => {
          writes.push("listener");
          settings.enableDnsOverTls = enabled;
        },
        inspect: async () => ({ resources: [] }),
        upgrade: async () => ({
          lxcCommands: [{ binary: "/upgrade-fixture" }],
        }),
        healthCheck: async () => ({
          process: "running",
          endpoint: "reachable",
        }),
      },
    },
  });
  const exec = adapters.proxmox.pctExec;
  Object.assign(adapters.proxmox, {
    supportsSnapshots: true,
    createSnapshot: async (vmid, snapshotName) => {
      assert.equal(vmid, "202");
      writes.push("snapshot");
      return { snapshotName };
    },
    pctExec: async (vmid, command) => {
      if (command.binary !== "/upgrade-fixture") return exec(vmid, command);
      assert.equal(vmid, "202");
      writes.push("upgrade");
      settings.version = "15.6.2";
      return { stdout: "" };
    },
  });
  await assert.rejects(review(), /PKCS#12/);
  settings.dnsTlsCertificatePath = "/certs/resolver.pfx";
  const plan = (await review()).stdout;
  assert.match(plan, /in-place Technitium updater/);
  const token = plan.match(/--approve ([a-f0-9]{64})/)[1];
  await assert.rejects(authorize("stale"), /review has changed/);
  assert.deepEqual(writes, []);
  const applied = await authorize(token);
  assert.match(applied.stdout, /Current version: 15\.6\.2/);
  assert.deepEqual(writes, ["snapshot", "upgrade", "listener"]);
  assert.equal(fs.readFileSync(configPath, "utf8"), originalConfig);
  const currentState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(
    currentState.providerReferences,
    originalState.providerReferences,
  );
  assert.equal(
    currentState.devicePackages.family.id,
    originalState.devicePackages.family.id,
  );
  assert.equal(currentState.devicePackages.family.listener.status, "verified");
});

test("fresh CA follow-up and existing project menu use the same Apple default", async () => {
  const selections = [];
  for (const afterProvision of [true, false]) {
    const { adapters, cmd, projectDirectory } = mockProject();
    const destination = path.join(projectDirectory, "existing-dns");
    const prompts = {
      select: async ({ message, initialValue }) => {
        if (message === "Set up household devices?") return "setup";
        if (message === "Devices") return "apple";
        assert.equal(message, "Apple device DNS");
        assert.equal(initialValue, "existing");
        return initialValue;
      },
      ask: async (message, previous, placeholder) => {
        if (message.startsWith("Package ID")) {
          assert.equal(previous, undefined);
          assert.equal(placeholder, "e.g. home-devices");
          return "family";
        }
        if (message === "Fresh export directory") return destination;
        assert.ok(["Display name", "Description"].includes(message), message);
        return previous;
      },
      confirm: async ({ message }) => {
        if (message === "Add a shortcut?") return false;
        assert.ok(
          ["Save these selections?", "Export now?"].includes(message),
          message,
        );
        return true;
      },
      info: () => {},
      warn: (message) => assert.fail(message),
    };
    const runtime = { ...adapters, prompts, runCommand: runCli };
    if (afterProvision) await deviceMenu(runtime, { afterProvision: true });
    else
      await runInteractiveApp({
        ...runtime,
        interactive: { chooseAction: () => "device-setup" },
      });
    selections.push(
      JSON.parse((await cmd("inspect", "--name", "family")).stdout),
    );
    const apple = parsePlist(path.join(destination, "mobile.mobileconfig"));
    assert.equal(apple.PayloadContent.length, 1);
    assert.deepEqual(
      Buffer.from(apple.PayloadContent[0].PayloadContent, "base64"),
      cert.raw,
    );
  }
  assert.deepEqual(selections[0], selections[1]);
});

test("export rejects protected and redirected directories and gates root rotation", async () => {
  const { cmd, configure, projectDirectory } = mockProject();
  await configure();
  const paths = [
    path.join(projectDirectory, ".nomina", "bad"),
    path.join(projectDirectory, "linked", "bad"),
  ];
  fs.symlinkSync(dir, path.join(projectDirectory, "linked"));
  for (const p of paths)
    await assert.rejects(
      cmd("export", "--name", "family", "--output", p),
      /metadata|symbolic/,
    );
  const statePath = path.join(projectDirectory, ".nomina", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.devicePackages.family.fingerprint = "previous root";
  fs.writeFileSync(statePath, JSON.stringify(state));
  const args = [
    "export",
    "--name",
    "family",
    "--output",
    path.join(projectDirectory, "rotated"),
  ];
  await assert.rejects(cmd(...args), /root rotated/);
  await cmd(...args, "--accept-root-change");
});
