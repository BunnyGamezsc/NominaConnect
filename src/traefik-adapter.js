import { createHash } from "node:crypto";

// Traefik has no Debian package; the release tarball is the supported install
// path. Pinned so a provisioned LXC is reproducible; `nomina service upgrade
// traefik` resolves the newest v3 release instead of this pin.
const TRAEFIK_VERSION = "v3.7.13";
const TRAEFIK_API_PORT = 8080;
const TRAEFIK_CONFIG_DIR = "/etc/traefik";
const TRAEFIK_DYNAMIC_DIR = `${TRAEFIK_CONFIG_DIR}/dynamic`;
const FRAGMENT_PREFIX = "nomina-";
const REDIRECT_SUFFIX = "-redirect";
const FILE_PROVIDER = "file";

// step-ca trust. A certificate resolver can only live in Traefik's static
// configuration, so the managed block below is spliced into traefik.yml
// between markers; everything the operator wrote around it is left in place.
const STEP_CA_PORT = 9000;
const STEP_CA_RESOLVER = "nomina-stepca";
const STEP_CA_ROOT_CERT = "/usr/local/share/ca-certificates/step-ca-root.crt";
const STATIC_CONFIG_PATH = `${TRAEFIK_CONFIG_DIR}/traefik.yml`;
const ACME_STORAGE_PATH = `${TRAEFIK_CONFIG_DIR}/acme.json`;
const MANAGED_BLOCK_START = "# >>> Managed by NominaConnect: step-ca certificate resolver";
const MANAGED_BLOCK_END = "# <<< Managed by NominaConnect";

// The watched directory is reloaded asynchronously after a fragment is written,
// so publish confirms through the API instead of assuming the write took effect.
const RELOAD_POLL_ATTEMPTS = 20;
const RELOAD_POLL_DELAY_MS = 500;

export function createTraefikAdapter({ httpClient, secretResolver, exec, sleep = defaultSleep }) {
  const requireExec = (request) => {
    if (typeof exec !== "function") {
      throw new Error("Traefik dynamic configuration requires Proxmox-shell execution, which is unavailable.");
    }
    if (request.vmid === undefined) {
      throw new Error("Traefik dynamic configuration requires the managed LXC id, which is not recorded for this project.");
    }
    return (command) => exec(request.vmid, command);
  };

  return Object.freeze({
    async setup(plan) {
      tryResolveSecret(secretResolver, plan.connectionSecretReference);
      return { ...plan, lxcCommands: installCommands(TRAEFIK_VERSION) };
    },
    async upgrade(plan) {
      tryResolveSecret(secretResolver, plan.connectionSecretReference);
      return { ...plan, lxcCommands: upgradeCommands() };
    },
    // Provisioning calls configure() under bounded retry, so a Traefik that is
    // still booting is a retryable failure rather than a failed install.
    async configure(request) {
      tryResolveSecret(secretResolver, request.connectionSecretReference);
      const endpoint = resolveEndpoint(request);
      await apiGet(httpClient, endpoint, "/api/overview");
      return { endpoint, dynamicDirectory: TRAEFIK_DYNAMIC_DIR };
    },
    // Inspection reads Traefik's API: it reports the effective configuration
    // that the file provider loaded, so a direct edit to a watched fragment is
    // observed the same way a NominaConnect publish is.
    async inspect(request) {
      tryResolveSecret(secretResolver, request.connectionSecretReference);
      const endpoint = resolveEndpoint(request);
      const [routers, services] = await Promise.all([
        listRouters(httpClient, endpoint),
        listServices(httpClient, endpoint)
      ]);
      const resources = routers
        .filter((router) => !isRedirectRouter(router) && hostForRouter(router) !== undefined)
        .map((router) => toManagedResource(router, services));
      return { resources };
    },
    async adopt(request) {
      const locators = new Map();
      for (const resource of request.managed ?? []) {
        const key = locatorKey(resource.locator ?? locatorFor(resource.id));
        locators.set(key, (locators.get(key) ?? 0) + 1);
      }
      const ambiguous = [...locators.entries()].filter(([, count]) => count > 1).map(([key]) => key);
      if (ambiguous.length > 0) {
        return {
          managedInventoryUpdate: [],
          warnings: [`Ambiguous Traefik dynamic fragment ${ambiguous[0]}; managed routes were not adopted.`]
        };
      }
      return {
        managedInventoryUpdate: (request.managed ?? []).map((resource) => ({
          ...resource,
          fingerprint: resource.fingerprint ?? fingerprintFor(
            resource.locator ?? locatorFor(resource.id),
            { router: resource.router, service: resource.service }
          )
        }))
      };
    },
    async healthCheck(request) {
      const endpoint = resolveEndpoint(request);
      try {
        await apiGet(httpClient, endpoint, "/api/overview");
        return { process: "running", endpoint: "reachable" };
      } catch (error) {
        if (isUnreachable(error)) {
          return { process: "stopped", endpoint: "unreachable" };
        }
        return { process: "running", endpoint: "unreachable" };
      }
    },
    // Distributes the step-ca root into the Traefik LXC and adds the managed
    // ACME certificate resolver to Traefik's static configuration. Every
    // failure is a verification warning: nothing else in traefik.yml is
    // touched, and the caller publishes untrusted HTTPS rather than pointing a
    // router at a resolver Traefik does not have.
    async configureCaTrust(request) {
      if (request.caStrategy !== "step-ca") {
        return { warnings: [] };
      }
      const caHost = request.tls?.caHost ?? request.tls?.caIp;
      if (typeof caHost !== "string" || caHost === "") {
        return { warnings: ["The step-ca location is not recorded for this project, so Traefik was not configured to request trusted certificates."] };
      }
      // The CA host becomes part of a shell command and a YAML value, so
      // anything that is not a plain DNS name or address is refused rather
      // than escaped.
      if (!isPlainHostname(caHost)) {
        return { warnings: [`step-ca is recorded at an unusable address (${caHost}); Traefik was not configured to request trusted certificates.`] };
      }
      const runInLxc = requireExec(request);
      const warnings = [];
      let restartNeeded = false;

      // step-ca serving certificates carry DNS SANs only, so ACME has to reach
      // it by name. Pinning the name in the LXC keeps issuance working while
      // the managed DNS record for the CA is still settling.
      if (typeof request.tls?.caIp === "string" && /^[0-9.]+$/.test(request.tls.caIp)) {
        try {
          await runInLxc(pinCaHostCommand(caHost, request.tls.caIp));
        } catch (error) {
          warnings.push(`Unable to pin ${caHost} in the Traefik LXC hosts file (${describeFailure(error)}).`);
        }
      }

      // Trust-on-first-use: the root has to be fetched over a connection that
      // cannot be verified yet, which is the same bootstrap the Caddy path uses.
      let rootCertificate;
      try {
        rootCertificate = String((await runInLxc(fetchRootCertificateCommand(caHost))).stdout ?? "");
      } catch (error) {
        return {
          warnings: [...warnings, `Unable to fetch the step-ca root certificate from ${caHost} (${describeFailure(error)}); this exposure stays on untrusted HTTPS.`]
        };
      }
      if (!rootCertificate.includes("BEGIN CERTIFICATE") || containsHeredocMarker(rootCertificate)) {
        return {
          warnings: [...warnings, `${caHost} did not return a usable root certificate; this exposure stays on untrusted HTTPS.`]
        };
      }
      let installedCertificate = "";
      try {
        installedCertificate = String((await runInLxc({ binary: "/bin/cat", args: [STEP_CA_ROOT_CERT] })).stdout ?? "");
      } catch {
        // Not installed yet; the install below is what puts it there.
      }
      if (installedCertificate.trim() !== rootCertificate.trim()) {
        try {
          await runInLxc(installRootCertificateCommand(rootCertificate));
          restartNeeded = true;
        } catch (error) {
          return {
            warnings: [...warnings, `Unable to install the step-ca root certificate in the Traefik LXC (${describeFailure(error)}); this exposure stays on untrusted HTTPS.`]
          };
        }
      }

      let staticConfig;
      try {
        staticConfig = String((await runInLxc({ binary: "/bin/cat", args: [STATIC_CONFIG_PATH] })).stdout ?? "");
      } catch (error) {
        return {
          warnings: [...warnings, `Unable to read ${STATIC_CONFIG_PATH} (${describeFailure(error)}); the step-ca certificate resolver was not configured.`]
        };
      }
      const applied = applyStepCaResolver(staticConfig, stepCaResolverBlock({ caHost, email: acmeEmailFor(request, caHost) }));
      if (applied.conflict) {
        return {
          warnings: [...warnings, `Traefik's static configuration already defines certificatesResolvers that NominaConnect did not write; it was left unchanged and ${request.hostname ?? "this exposure"} stays on untrusted HTTPS.`]
        };
      }
      if (containsHeredocMarker(staticConfig)) {
        return {
          warnings: [...warnings, `${STATIC_CONFIG_PATH} contains text NominaConnect cannot safely rewrite; the step-ca certificate resolver was not configured.`]
        };
      }
      if (applied.content !== staticConfig) {
        try {
          await runInLxc(writeStaticConfigCommand(applied.content));
          restartNeeded = true;
        } catch (error) {
          return {
            warnings: [...warnings, `Unable to write the step-ca certificate resolver into ${STATIC_CONFIG_PATH} (${describeFailure(error)}); this exposure stays on untrusted HTTPS.`]
          };
        }
      }

      // Traefik reads its static configuration and the system trust store once
      // at start, so a change to either only takes effect after a restart.
      if (restartNeeded) {
        try {
          await runInLxc({ binary: "/bin/bash", args: ["-c", "systemctl restart traefik"], timeoutMs: 60_000 });
        } catch (error) {
          return {
            warnings: [...warnings, `Traefik did not restart after the step-ca certificate resolver was configured (${describeFailure(error)}); this exposure stays on untrusted HTTPS until it does.`]
          };
        }
      }
      return { resolver: STEP_CA_RESOLVER, warnings };
    },
    async publishRoute(request) {
      tryResolveSecret(secretResolver, request.connectionSecretReference);
      const hostname = assertPublishableHostname(request.hostname);
      const runInLxc = requireExec(request);
      const endpoint = resolveEndpoint(request);

      // The resolver has to exist in the static configuration before a router
      // names it, or Traefik rejects the router outright instead of serving it
      // with an untrusted certificate.
      const trust = await this.configureCaTrust(request);

      const fragment = buildFragment({
        hostname,
        backendIp: request.backendIp,
        backendPort: request.backendPort,
        backendTls: request.backendTls === true,
        httpRedirect: request.httpRedirect === true,
        certResolver: trust.resolver
      });
      await runInLxc(writeFragmentCommand(hostname, fragment));

      const routerName = routerNameFor(hostname);
      const observed = await waitForRouter(httpClient, endpoint, routerName, sleep);
      const locator = locatorFor(hostname);
      const services = observed === undefined ? [] : await listServices(httpClient, endpoint);
      const warnings = [
        ...trust.warnings,
        ...(observed === undefined
          ? [`Traefik did not load the dynamic fragment for ${hostname} before the reload timeout.`]
          : [])
      ];
      return {
        id: hostname,
        locator,
        fingerprint: fingerprintFor(locator, {
          router: observed ?? undefined,
          service: observed === undefined ? undefined : serviceForRouter(observed, services)
        }),
        route: `https://${hostname} -> ${backendUrl(request.backendIp, request.backendPort, request.backendTls === true)}`,
        ...(trust.resolver === undefined ? {} : { certResolver: trust.resolver }),
        ...(warnings.length > 0 ? { warnings } : {})
      };
    },
    async unpublishRoute(request) {
      const hostname = assertPublishableHostname(request.hostname);
      const runInLxc = requireExec(request);
      const endpoint = resolveEndpoint(request);

      // A fingerprint mismatch means the fragment no longer holds what
      // NominaConnect published. Removing it anyway would delete configuration
      // the operator wrote by hand, so refuse instead.
      if (request.fingerprint !== undefined) {
        const actual = await observedFingerprint(httpClient, endpoint, hostname);
        if (actual !== null && actual !== request.fingerprint) {
          throw new Error(`Traefik fragment for ${hostname} does not match its managed fingerprint. Aborting deletion to preserve direct edits.`);
        }
      }

      // Only the resolved managed fragment path is removed; every other file in
      // the watched directory is left alone.
      await runInLxc({
        binary: "/bin/rm",
        args: ["-f", fragmentPathFor(hostname)]
      });
      return { id: hostname, locator: locatorFor(hostname) };
    },
    async deleteRoute(request) {
      return this.unpublishRoute(request);
    },
    async healthCheckExposure(request) {
      const endpoint = resolveEndpoint(request);
      let routers;
      let services;
      try {
        [routers, services] = await Promise.all([
          listRouters(httpClient, endpoint),
          listServices(httpClient, endpoint)
        ]);
      } catch (error) {
        if (isUnreachable(error)) {
          return exposureHealth({ https: "unreachable", reason: "Traefik is unreachable." });
        }
        throw error;
      }

      const router = routers.find(
        (candidate) => !isRedirectRouter(candidate) && hostForRouter(candidate) === request.hostname
      );
      if (router === undefined) {
        return exposureHealth({
          https: "unreachable",
          reason: `Traefik has no router for ${request.hostname}.`
        });
      }
      const tls = tlsSummaryFor(router, request.caStrategy);
      const base = { https: "reachable", tls: tls.trusted ? "valid" : "untrusted", issuer: tls.issuer };

      // An exposure without a TLS router would answer plain HTTP on :443 or
      // not at all. NominaConnect never downgrades a managed exposure, so this
      // is a failure rather than a working HTTP route.
      if (router.tls === undefined) {
        return exposureHealth({
          ...base,
          https: "unreachable",
          tls: "missing",
          reason: `Traefik router for ${request.hostname} has no TLS configuration.`
        });
      }
      if (router.status !== undefined && router.status !== "enabled") {
        return exposureHealth({ ...base, reason: `Traefik router for ${request.hostname} is ${router.status}.` });
      }
      const expected = request.backendIp !== undefined && request.backendPort !== undefined
        ? `${request.backendIp}:${request.backendPort}`
        : undefined;
      const observed = serverUrlFor(serviceForRouter(router, services));
      if (expected !== undefined && observed !== undefined && hostPortOf(observed) !== expected) {
        return exposureHealth({ ...base, reason: `Traefik router for ${request.hostname} points at ${observed}.` });
      }
      if (!tls.trusted && tls.expectedTrusted) {
        // The router carries no certificate resolver, so Traefik is answering
        // with its own generated certificate. A CA-backed project must not be
        // told that certificate is trusted.
        return exposureHealth({
          ...base,
          reason: `${request.caStrategy} trust is not configured for this Traefik exposure; it is serving Traefik's default self-signed certificate.`
        });
      }

      // A configured resolver is not an issued certificate. The exposure is
      // only trusted once step-ca has issued for this hostname and the served
      // certificate validates against the root installed in the LXC.
      if (tls.expectedTrusted) {
        const verified = await verifyIssuedCertificate(exec, request);
        if (verified.reason !== undefined) {
          return exposureHealth({ ...base, tls: verified.tls, reason: verified.reason });
        }
      }
      return exposureHealth(base);
    }
  });
}

export function traefikApiEndpointFor(ip) {
  return `http://${ip}:${TRAEFIK_API_PORT}`;
}

export const TRAEFIK_DYNAMIC_DIRECTORY = TRAEFIK_DYNAMIC_DIR;

function resolveEndpoint(request) {
  if (request.endpoint !== undefined) {
    return request.endpoint;
  }
  if (request.ip !== undefined) {
    return traefikApiEndpointFor(request.ip);
  }
  return traefikApiEndpointFor("127.0.0.1");
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

// api.insecure binds the dashboard/API to the `traefik` entryPoint (:8080).
// NominaConnect only reads from it; every configuration write goes through the
// watched dynamic directory.
const STATIC_CONFIG = [
  "entryPoints:",
  "  web:",
  '    address: ":80"',
  "  websecure:",
  '    address: ":443"',
  "  traefik:",
  '    address: ":8080"',
  "api:",
  "  dashboard: true",
  "  insecure: true",
  "providers:",
  "  file:",
  `    directory: ${TRAEFIK_DYNAMIC_DIR}`,
  "    watch: true",
  "log:",
  "  level: INFO",
  ""
].join("\n");

const SYSTEMD_UNIT = [
  "[Unit]",
  "Description=Traefik",
  "After=network-online.target",
  "Wants=network-online.target",
  "",
  "[Service]",
  `ExecStart=/usr/local/bin/traefik --configFile=${TRAEFIK_CONFIG_DIR}/traefik.yml`,
  "Restart=on-failure",
  "RestartSec=5",
  "AmbientCapabilities=CAP_NET_BIND_SERVICE",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
  ""
].join("\n");

function downloadScript(versionExpression) {
  return [
    "set -eu",
    `VERSION=${versionExpression}`,
    'case "$(dpkg --print-architecture)" in',
    "  amd64) TARCH=amd64 ;;",
    "  arm64) TARCH=arm64 ;;",
    '  *) echo "Unsupported architecture for Traefik: $(dpkg --print-architecture)" >&2; exit 1 ;;',
    "esac",
    'curl -fsSL -o /tmp/traefik.tar.gz "https://github.com/traefik/traefik/releases/download/${VERSION}/traefik_${VERSION}_linux_${TARCH}.tar.gz"',
    "tar -xzf /tmp/traefik.tar.gz -C /tmp traefik",
    "install -m 0755 /tmp/traefik /usr/local/bin/traefik",
    "rm -f /tmp/traefik /tmp/traefik.tar.gz"
  ].join("\n");
}

function installCommands(version) {
  return [
    { binary: "/usr/bin/apt-get", args: ["update"] },
    { binary: "/usr/bin/apt-get", args: ["install", "--yes", "curl", "ca-certificates", "tar"], timeoutMs: 180_000 },
    { binary: "/bin/bash", args: ["-c", downloadScript(version)], timeoutMs: 180_000 },
    {
      binary: "/bin/bash",
      args: [
        "-c",
        [
          "set -eu",
          // mkdir -p leaves an existing watched directory and its unrelated
          // fragments untouched when Traefik is reinstalled over an old LXC.
          `mkdir -p ${TRAEFIK_DYNAMIC_DIR}`,
          `cat > ${TRAEFIK_CONFIG_DIR}/traefik.yml <<'NOMINA_STATIC_EOF'`,
          STATIC_CONFIG.trimEnd(),
          "NOMINA_STATIC_EOF",
          "cat > /etc/systemd/system/traefik.service <<'NOMINA_UNIT_EOF'",
          SYSTEMD_UNIT.trimEnd(),
          "NOMINA_UNIT_EOF",
          "systemctl daemon-reload",
          "systemctl enable --now traefik",
          "systemctl restart traefik"
        ].join("\n")
      ],
      timeoutMs: 60_000
    }
  ];
}

function upgradeCommands() {
  const resolveLatest = [
    "set -eu",
    // Explicit upgrades follow the newest v3 release; the pinned version is the
    // fallback when GitHub cannot be reached.
    `VERSION=$(curl -fsSL https://api.github.com/repos/traefik/traefik/releases/latest | grep -o '"tag_name": *"v3[^"]*"' | head -1 | cut -d'"' -f4)`,
    `[ -n "\${VERSION:-}" ] || VERSION=${TRAEFIK_VERSION}`
  ].join("\n");
  return [
    { binary: "/bin/bash", args: ["-c", `${resolveLatest}\n${downloadScript("$VERSION")}`], timeoutMs: 180_000 },
    { binary: "/bin/bash", args: ["-c", "systemctl restart traefik"], timeoutMs: 60_000 }
  ];
}

// ---------------------------------------------------------------------------
// Dynamic configuration fragments
// ---------------------------------------------------------------------------

export function fragmentPathFor(hostname) {
  return `${TRAEFIK_DYNAMIC_DIR}/${FRAGMENT_PREFIX}${hostname}.yml`;
}

export function routerNameFor(hostname) {
  return `${FRAGMENT_PREFIX}${hostname}`;
}

// A managed exposure is one file per hostname, so a publish or removal can
// never reach configuration that another fragment owns.
export function buildFragment({ hostname, backendIp, backendPort, backendTls = false, httpRedirect = false, certResolver = undefined }) {
  const name = routerNameFor(hostname);
  const lines = [
    "# Managed by NominaConnect. Direct edits are inspected and adopted.",
    `# Exposure: ${hostname}`,
    "http:",
    "  routers:",
    `    ${name}:`,
    `      rule: "Host(\`${hostname}\`)"`,
    "      entryPoints:",
    "        - websecure",
    `      service: ${name}`,
    // The tls block is what keeps the exposure on HTTPS. Naming a certificate
    // resolver makes Traefik request a trusted certificate through ACME;
    // without one it answers with its own generated self-signed certificate.
    // Neither case serves the route over plain HTTP.
    ...(certResolver === undefined
      ? ["      tls: {}"]
      : ["      tls:", `        certResolver: ${certResolver}`])
  ];

  if (httpRedirect) {
    lines.push(
      `    ${name}${REDIRECT_SUFFIX}:`,
      `      rule: "Host(\`${hostname}\`)"`,
      "      entryPoints:",
      "        - web",
      `      service: ${name}`,
      "      middlewares:",
      `        - ${name}${REDIRECT_SUFFIX}`,
      "  middlewares:",
      `    ${name}${REDIRECT_SUFFIX}:`,
      "      redirectScheme:",
      "        scheme: https",
      "        permanent: true"
    );
  }

  lines.push(
    "  services:",
    `    ${name}:`,
    "      loadBalancer:",
    "        servers:",
    `          - url: "${backendUrl(backendIp, backendPort, backendTls)}"`
  );

  if (backendTls) {
    // HTTPS-only backends (Proxmox, OPNsense, ...) present self-signed
    // certificates. The relaxed check applies to this internal hop only.
    lines.push(
      `        serversTransport: ${name}`,
      "  serversTransports:",
      `    ${name}:`,
      "      insecureSkipVerify: true"
    );
  }

  return `${lines.join("\n")}\n`;
}

// Written outside the watched directory and moved into place, so Traefik never
// reloads a half-written fragment.
function writeFragmentCommand(hostname, fragment) {
  const target = fragmentPathFor(hostname);
  const staging = `${TRAEFIK_CONFIG_DIR}/.${FRAGMENT_PREFIX}${hostname}.yml.tmp`;
  return {
    binary: "/bin/bash",
    args: [
      "-c",
      [
        "set -eu",
        `mkdir -p ${TRAEFIK_DYNAMIC_DIR}`,
        `cat > ${staging} <<'NOMINA_FRAGMENT_EOF'`,
        fragment.trimEnd(),
        "NOMINA_FRAGMENT_EOF",
        `chmod 0644 ${staging}`,
        `mv -f ${staging} ${target}`
      ].join("\n")
    ],
    timeoutMs: 30_000
  };
}

function backendUrl(backendIp, backendPort, backendTls) {
  return `${backendTls ? "https" : "http"}://${backendIp}:${backendPort}`;
}

// Hostnames become both a filename and a shell heredoc body, so anything that
// is not a plain DNS name is rejected rather than escaped.
function assertPublishableHostname(hostname) {
  if (typeof hostname !== "string" || !/^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(hostname)) {
    throw new Error(`Invalid exposure hostname for Traefik: ${hostname}.`);
  }
  return hostname;
}

// ---------------------------------------------------------------------------
// step-ca trust
// ---------------------------------------------------------------------------

// Traefik reads certificate resolvers from its static configuration only —
// command-line and environment configuration are mutually exclusive with a
// configuration file — so the resolver has to live in traefik.yml.
export function stepCaResolverBlock({ caHost, email, resolver = STEP_CA_RESOLVER }) {
  return [
    MANAGED_BLOCK_START,
    "certificatesResolvers:",
    `  ${resolver}:`,
    "    acme:",
    `      caServer: "https://${caHost}:${STEP_CA_PORT}/acme/acme/directory"`,
    `      email: "${email}"`,
    `      storage: ${ACME_STORAGE_PATH}`,
    // step-ca issues 24-hour certificates. Traefik derives its renewal window
    // from this value, so leaving its 90-day default would let every managed
    // certificate expire before it was renewed.
    "      certificatesDuration: 24",
    // TLS-ALPN-01 keeps issuance on :443, so it works the same whether or not
    // the exposure also has an HTTP redirect on :80.
    "      tlsChallenge: {}",
    MANAGED_BLOCK_END
  ].join("\n");
}

// The managed block is spliced between markers so that entryPoints, logging,
// and anything else an operator added to the static configuration survive.
// A certificatesResolvers key NominaConnect did not write is left alone: a
// second one would be a duplicate YAML mapping key and Traefik would refuse to
// start.
export function applyStepCaResolver(staticConfig, block) {
  const current = typeof staticConfig === "string" ? staticConfig : "";
  const withoutManaged = stripManagedBlock(current);
  if (/^certificatesResolvers:/m.test(withoutManaged)) {
    return { conflict: true, content: current };
  }
  return { conflict: false, content: `${withoutManaged.replace(/\n+$/, "")}\n${block}\n` };
}

function stripManagedBlock(text) {
  const kept = [];
  let inside = false;
  for (const line of text.split("\n")) {
    if (line.trim() === MANAGED_BLOCK_START) {
      inside = true;
      continue;
    }
    if (line.trim() === MANAGED_BLOCK_END) {
      inside = false;
      continue;
    }
    if (!inside) {
      kept.push(line);
    }
  }
  return kept.join("\n");
}

function isPlainHostname(value) {
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(value);
}

// Content written through a quoted heredoc is safe unless it can close the
// heredoc itself, which is the one case worth refusing rather than escaping.
function containsHeredocMarker(content) {
  return /^(NOMINA_ROOT_EOF|NOMINA_STATIC_EOF)$/m.test(content);
}

function acmeEmailFor(request, caHost) {
  const zone = request.zone ?? caHost.split(".").slice(1).join(".");
  return `nomina@${zone === "" ? caHost : zone}`;
}

// Only lines whose last field is exactly the CA hostname are replaced, so
// unrelated entries in the LXC hosts file are preserved.
function pinCaHostCommand(caHost, caIp) {
  return {
    binary: "/bin/bash",
    args: [
      "-c",
      [
        "set -eu",
        `sed -i '/[[:space:]]${caHost.replace(/\./g, "\\.")}$/d' /etc/hosts`,
        `echo '${caIp} ${caHost}' >> /etc/hosts`
      ].join("\n")
    ],
    timeoutMs: 30_000
  };
}

function fetchRootCertificateCommand(caHost) {
  return {
    binary: "/usr/bin/curl",
    args: ["-skf", "--max-time", "15", `https://${caHost}:${STEP_CA_PORT}/roots.pem`],
    timeoutMs: 30_000
  };
}

function installRootCertificateCommand(rootCertificate) {
  const staging = `${TRAEFIK_CONFIG_DIR}/.nomina-step-ca-root.pem`;
  return {
    binary: "/bin/bash",
    args: [
      "-c",
      [
        "set -eu",
        "mkdir -p /usr/local/share/ca-certificates",
        `cat > ${staging} <<'NOMINA_ROOT_EOF'`,
        rootCertificate.trimEnd(),
        "NOMINA_ROOT_EOF",
        `chmod 0644 ${staging}`,
        `mv -f ${staging} ${STEP_CA_ROOT_CERT}`,
        "update-ca-certificates"
      ].join("\n")
    ],
    timeoutMs: 60_000
  };
}

function writeStaticConfigCommand(content) {
  const staging = `${TRAEFIK_CONFIG_DIR}/.nomina-traefik.yml`;
  return {
    binary: "/bin/bash",
    args: [
      "-c",
      [
        "set -eu",
        `cat > ${staging} <<'NOMINA_STATIC_EOF'`,
        content.trimEnd(),
        "NOMINA_STATIC_EOF",
        `chmod 0644 ${staging}`,
        `mv -f ${staging} ${STATIC_CONFIG_PATH}`
      ].join("\n")
    ],
    timeoutMs: 30_000
  };
}

// A configured resolver only means Traefik was asked for a trusted
// certificate. This is the part that proves it got one: the ACME storage holds
// a certificate for the hostname, and the certificate Traefik actually
// presents validates against the root installed in its own trust store.
async function verifyIssuedCertificate(exec, request) {
  const hostname = request.hostname;
  if (typeof exec !== "function" || request.vmid === undefined) {
    return {
      tls: "unknown",
      reason: `NominaConnect cannot reach the Traefik LXC to verify the certificate for ${hostname}.`
    };
  }
  const runInLxc = (command) => exec(request.vmid, command);
  let storage = "";
  try {
    storage = String((await runInLxc({ binary: "/bin/cat", args: [ACME_STORAGE_PATH] })).stdout ?? "");
  } catch {
    // No ACME storage yet means no issued certificate yet.
  }
  if (!acmeStorageHolds(storage, hostname)) {
    return { tls: "untrusted", reason: `step-ca has not issued a certificate for ${hostname} yet.` };
  }
  try {
    await runInLxc(trustedHandshakeCommand(hostname));
  } catch (error) {
    return {
      tls: "untrusted",
      reason: `The certificate Traefik presents for ${hostname} did not validate against the step-ca root installed in its LXC (${describeFailure(error)}).`
    };
  }
  return {};
}

function acmeStorageHolds(storage, hostname) {
  let parsed;
  try {
    parsed = JSON.parse(storage);
  } catch {
    return false;
  }
  for (const resolver of Object.values(parsed ?? {})) {
    for (const certificate of resolver?.Certificates ?? []) {
      const domain = certificate?.domain ?? {};
      if (domain.main === hostname || (domain.sans ?? []).includes(hostname)) {
        return true;
      }
    }
  }
  return false;
}

// --resolve pins the connection to Traefik itself, so this reports on the
// certificate and the trust store rather than on DNS. A backend that answers
// 502 still proves the handshake, which is what is being verified here.
function trustedHandshakeCommand(hostname) {
  return {
    binary: "/usr/bin/curl",
    args: [
      "-sS", "-o", "/dev/null", "--max-time", "10",
      "--resolve", `${hostname}:443:127.0.0.1`,
      `https://${hostname}/`
    ],
    timeoutMs: 30_000
  };
}

// Command failures carry the full command line and its output; a warning only
// needs the reason, and it has to stay short enough to read in a change notice.
function describeFailure(error) {
  const message = String(error?.message ?? error ?? "unknown error").trim();
  const detail = message.split("\n")[0];
  return detail.length > 200 ? `${detail.slice(0, 197)}...` : detail;
}

// ---------------------------------------------------------------------------
// Traefik API (observation only)
// ---------------------------------------------------------------------------

async function listRouters(httpClient, endpoint) {
  const payload = await apiGet(httpClient, endpoint, "/api/http/routers");
  return asFileProviderList(payload);
}

async function listServices(httpClient, endpoint) {
  const payload = await apiGet(httpClient, endpoint, "/api/http/services");
  return asFileProviderList(payload);
}

function asFileProviderList(payload) {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload.filter((entry) => providerOf(entry) === FILE_PROVIDER);
}

function providerOf(entry) {
  if (typeof entry?.provider === "string") {
    return entry.provider;
  }
  const name = typeof entry?.name === "string" ? entry.name : "";
  const at = name.lastIndexOf("@");
  return at === -1 ? undefined : name.slice(at + 1);
}

function bareName(entry) {
  const name = typeof entry?.name === "string" ? entry.name : "";
  const at = name.lastIndexOf("@");
  return at === -1 ? name : name.slice(0, at);
}

async function waitForRouter(httpClient, endpoint, routerName, sleep) {
  for (let attempt = 0; attempt < RELOAD_POLL_ATTEMPTS; attempt += 1) {
    let routers;
    try {
      routers = await listRouters(httpClient, endpoint);
    } catch (error) {
      if (!isUnreachable(error)) {
        throw error;
      }
      routers = [];
    }
    const match = routers.find((router) => bareName(router) === routerName);
    if (match !== undefined) {
      return match;
    }
    if (attempt < RELOAD_POLL_ATTEMPTS - 1) {
      await sleep(RELOAD_POLL_DELAY_MS);
    }
  }
  return undefined;
}

async function observedFingerprint(httpClient, endpoint, hostname) {
  let routers;
  let services;
  try {
    [routers, services] = await Promise.all([
      listRouters(httpClient, endpoint),
      listServices(httpClient, endpoint)
    ]);
  } catch (error) {
    if (isUnreachable(error)) {
      return null;
    }
    throw error;
  }
  const router = routers.find(
    (candidate) => !isRedirectRouter(candidate) && bareName(candidate) === routerNameFor(hostname)
  );
  if (router === undefined) {
    return null;
  }
  return fingerprintFor(locatorFor(hostname), { router, service: serviceForRouter(router, services) });
}

async function apiGet(httpClient, endpoint, path) {
  const url = `${endpoint.replace(/\/$/, "")}${path}`;
  let result;
  try {
    result = await httpClient.request({ method: "GET", url, headers: { Accept: "application/json" }, redactions: [] });
  } catch (error) {
    error.unreachable = true;
    throw error;
  }
  if (result.status === 404) {
    return null;
  }
  if (result.status >= 400) {
    throw new Error(`Traefik API ${path} failed with status ${result.status}: ${result.body}`);
  }
  if (result.body === undefined || result.body === "" || result.body === "null") {
    return null;
  }
  try {
    return JSON.parse(result.body);
  } catch {
    throw new Error(`Traefik returned a malformed response from ${path}.`);
  }
}

// ---------------------------------------------------------------------------
// Observed resources
// ---------------------------------------------------------------------------

function isRedirectRouter(router) {
  return bareName(router).endsWith(REDIRECT_SUFFIX);
}

const HOST_RULE = /Host\(`([^`]+)`\)/;

function hostForRouter(router) {
  return typeof router?.rule === "string" ? router.rule.match(HOST_RULE)?.[1] : undefined;
}

function serviceForRouter(router, services) {
  const target = router?.service;
  if (typeof target !== "string") {
    return undefined;
  }
  const bare = target.includes("@") ? target.slice(0, target.lastIndexOf("@")) : target;
  return services.find((service) => bareName(service) === bare);
}

function serverUrlFor(service) {
  const servers = service?.loadBalancer?.servers;
  return Array.isArray(servers) ? servers[0]?.url : undefined;
}

function hostPortOf(url) {
  try {
    const parsed = new URL(url);
    return parsed.port === "" ? parsed.hostname : `${parsed.hostname}:${parsed.port}`;
  } catch {
    return undefined;
  }
}

function locatorFor(hostname) {
  return { router: routerNameFor(hostname), fragmentPath: fragmentPathFor(hostname) };
}

function toManagedResource(router, services) {
  const host = hostForRouter(router);
  const service = serviceForRouter(router, services);
  const url = serverUrlFor(service);
  const hostPort = url === undefined ? undefined : hostPortOf(url);
  const [backendIp, backendPortRaw] = typeof hostPort === "string" && hostPort.includes(":")
    ? hostPort.split(":")
    : [undefined, undefined];
  const backendPort = backendPortRaw === undefined ? undefined : Number(backendPortRaw);
  const locator = locatorFor(host);
  // Inspection reports the untrusted default certificate as untrusted: the API
  // cannot tell a configured trust anchor from Traefik's generated one, and
  // inspection feeds adoption (ADR-0005), so a guess would be persisted.
  const tls = tlsSummaryFor(router);
  return {
    id: host,
    locator,
    fingerprint: fingerprintFor(locator, { router, service }),
    route: `https://${host} -> ${url ?? "unknown"}`,
    router,
    service,
    rule: router.rule,
    entryPoints: router.entryPoints,
    status: router.status,
    tls,
    url,
    backendIp,
    backendPort,
    ...(backendIp !== undefined && backendPort !== undefined ? { backend: { ip: backendIp, port: backendPort } } : {}),
    rData: { url, tls }
  };
}

// One shape for every outcome, so a caller reading `tls` or `reason` never has
// to know which branch produced the result. A reason present means unhealthy.
function exposureHealth({ https, tls = "unknown", issuer = "traefik-default", reason = undefined }) {
  return {
    https,
    tls,
    issuer,
    status: reason === undefined ? "healthy" : "unhealthy",
    ...(reason === undefined ? {} : { reason })
  };
}

// Caddy Internal CA is not a compatible authority for Traefik (ADR-0013), so
// step-ca is the only strategy that promises a trusted certificate here.
function tlsSummaryFor(router, caStrategy = "none") {
  const expectedTrusted = caStrategy === "step-ca";
  const resolver = router?.tls?.certResolver;
  if (typeof resolver === "string" && resolver !== "") {
    return {
      issuer: resolver === STEP_CA_RESOLVER ? "step-ca" : resolver,
      trusted: true,
      expectedTrusted
    };
  }
  return { issuer: "traefik-default", trusted: false, expectedTrusted };
}

function fingerprintFor(locator, observed) {
  return createHash("sha256")
    .update(JSON.stringify({
      locator,
      router: normalizeForFingerprint(observed?.router),
      service: normalizeForFingerprint(observed?.service)
    }))
    .digest("hex");
}

// Traefik reports live status alongside configuration (serverStatus, usedBy,
// using). Those change without anyone editing a fragment, so they are excluded
// from the fingerprint that detects direct edits.
function normalizeForFingerprint(entry) {
  if (entry === undefined || entry === null) {
    return null;
  }
  const { status, serverStatus, usedBy, using, error, ...configuration } = entry;
  return configuration;
}

function locatorKey(locator) {
  return `${locator.fragmentPath ?? ""}/${locator.router ?? ""}`;
}

function tryResolveSecret(secretResolver, reference) {
  if (reference !== undefined && secretResolver?.resolve !== undefined) {
    try { secretResolver.resolve(reference); } catch {}
  }
}

function isUnreachable(error) {
  return error?.unreachable === true
    || error?.cause?.code === "ECONNREFUSED"
    || error?.name === "HttpRequestError";
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
