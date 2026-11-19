import { createHash, randomUUID, X509Certificate } from "node:crypto";
import { parseArgs } from "node:util";
import { findProjectDirectory, loadProject } from "./config.js";
import { domain, fetchProfileRoot } from "./device-definition.js";
import { queryTls } from "./device-resolver.js";

const storage = "/var/lib/nomina-dns-tls";
const ownedPath = /^\/var\/lib\/nomina-dns-tls\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/resolver\.pfx$/;
const string = { type: /** @type {const} */ ("string") };

const makeRequest = `
umask 077
if [ ! -d "$1" ]; then mkdir -m 0711 -- "$1"; fi
[ ! -L "$1" ]
[ "$(stat -c '%u:%a' -- "$1")" = '0:711' ]
mkdir -m 0700 -- "$2"
openssl req -new -newkey rsa:2048 -noenc -keyout "$2/key.pem" \
  -subj "/CN=$3" -addext "subjectAltName=DNS:$4" 2>/dev/null
`;

const signRequest = `
umask 077
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
cat > "$work/request.pem"
export STEPPATH=/var/lib/stepca
ca_url=https://localhost:9000
root="$STEPPATH/certs/root_ca.crt"
if ! step ca token "$1" --san "$2" --cnf-file "$work/request.pem" \
  --issuer admin --provisioner-password-file "$STEPPATH/password.txt" \
  --ca-url "$ca_url" --root "$root" --output-file "$work/token" >/dev/null 2>&1 ||
  ! step ca sign --token "$(cat "$work/token")" --ca-url "$ca_url" --root "$root" \
  "$work/request.pem" "$work/bundle.pem" >/dev/null 2>&1; then
  echo 'step-ca could not sign with the managed admin provisioner. Check its service and provisioner credentials.' >&2
  exit 1
fi
cat "$work/bundle.pem"
`;

const stageCertificate = `
umask 077
cd -- "$1"
awk 'BEGIN { root=1 } {print > (root ? "root.pem" : "signed.pem")} /^-----END CERTIFICATE-----$/ {root=0}'
openssl verify -purpose sslserver -verify_hostname "$2" -trusted root.pem -untrusted signed.pem signed.pem >/dev/null
openssl pkcs12 -export -in signed.pem -inkey key.pem -passout pass: -out resolver.pfx
user=$(systemctl show --property=User --value dns.service)
systemctl is-active --quiet dns.service
chown -- "\${user:-root}" resolver.pfx
chmod 0600 resolver.pfx
openssl x509 -in signed.pem -out leaf.pem
rm -- key.pem signed.pem
chmod 0711 .
`;

const discardCertificate = `
if [ ! -e "$1" ]; then exit 0; fi
[ -d "$1" ]
[ ! -L "$1" ]
cd -- "$1"
rm -f -- key.pem root.pem signed.pem leaf.pem resolver.pfx
rmdir -- "$1"
`;

function references(project) {
  const { certificateAuthority: ca, dns } = project.config.managedInventory.platform;
  const refs = project.state.providerReferences ?? {};
  return { ca, dns, caRef: refs[ca?.id], dnsRef: refs[dns?.id] };
}

export function canProvisionDnsCertificate(project) {
  const { ca, dns, caRef, dnsRef } = references(project);
  return Boolean(ca?.service === "step-ca" && caRef?.vmid && !caRef.provisioningPending &&
    dns?.service === "technitium" && dnsRef?.vmid && dnsRef.ip && !dnsRef.provisioningPending);
}

async function inspectCertificate(provider, request, runDns, managedOnly) {
  const settings = await provider.inspectTlsListener(request);
  const path = settings.dnsTlsCertificatePath ?? "";
  if (managedOnly && !ownedPath.test(path)) return;
  if (!/^15\.(?:4|6)(?:\.|$)/.test(settings.version) || settings.clusterInitialized !== false)
    throw new Error("Certificate provisioning requires standalone Technitium 15.4.x or 15.6.x.");
  if (settings.enableDnsOverHttps || settings.enableDnsOverHttpsUnixSocket || settings.enableDnsOverQuic)
    throw new Error("Technitium shares its TLS certificate with active DNS-over-HTTPS or DNS-over-QUIC. Manage that shared certificate in Technitium.");
  let current;
  if (path) {
    if (!ownedPath.test(path))
      throw new Error("Technitium already uses a certificate managed outside Nomina. Manage its replacement in Technitium.");
    const directory = path.replace(/\/resolver\.pfx$/, "");
    const { stdout } = await runDns('cat -- "$1/leaf.pem" "$1/root.pem"', [directory]);
    const [leafPem, rootPem] = stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
    const leaf = new X509Certificate(leafPem);
    current = {
      hostname: leaf.subjectAltName?.match(/^DNS:([a-z0-9.-]+)$/)?.[1],
      fingerprint: leaf.fingerprint256, rootFingerprint: new X509Certificate(rootPem).fingerprint256,
      issued: leaf.validFrom, expires: leaf.validTo,
    };
    if (!current.hostname) throw new Error("The current Nomina certificate has no expected DNS name.");
  }
  return { path, current, version: settings.version, enabled: settings.enableDnsOverTls, port: settings.dnsOverTlsPort };
}

function certificateContext(project, adapters) {
  const provider = adapters.providerAdapters?.technitium;
  if (!canProvisionDnsCertificate(project) || !provider?.setTlsCertificate)
    throw new Error("Provision managed step-ca and Technitium before requesting a DNS-over-TLS certificate.");
  const { dns, caRef, dnsRef } = references(project);
  const { proxmox } = adapters;
  const run = (vmid, script, params = [], stdin = undefined) => proxmox.pctExec(vmid, {
    binary: "/bin/bash", args: ["-eu", "-c", script, "nomina-dns-certificate", ...params],
    stdin, timeoutMs: 60_000, maxOutputBytes: 32_768,
  });
  const runDns = (script, params, stdin = undefined) => run(dnsRef.vmid, script, params, stdin);
  const request = { ip: dnsRef.ip, connectionSecretReference: project.config.connectionSecretReferences[dns.id] };
  const inspect = (managedOnly = false) => inspectCertificate(provider, request, runDns, managedOnly);
  return { caRef, dnsRef, inspect, provider, request, run, runDns, zone: domain(project.config.baseLocalDomain) };
}

export async function dnsCertificateCommand(args, adapters) {
  const { values } = parseArgs({ args, options: { "project-dir": string, hostname: string, approve: string } });
  if (args.filter(arg => arg === "--project-dir" || arg.startsWith("--project-dir=")).length > 1)
    throw new Error("Specify only one project directory.");
  const fs = adapters.filesystem;
  const project = loadProject(fs, values["project-dir"] ?? findProjectDirectory(fs, adapters.cwd ?? "."));
  const context = certificateContext(project, adapters);
  const { caRef, dnsRef, inspect, zone } = context;
  const root = await fetchProfileRoot(project, adapters.proxmox);
  const previous = await inspect();
  const hostname = domain(values.hostname ?? previous.current?.hostname ?? `dns.${zone}`);
  if (previous.enabled && previous.current?.hostname !== hostname)
    throw new Error("Keep the current DNS-over-TLS hostname while it is in use. Existing profiles depend on it.");
  if (previous.enabled && previous.current.rootFingerprint !== root.fingerprint256)
    throw new Error("The CA root has changed. Plan a device trust migration before replacing the active resolver certificate.");
  const review = {
    change: previous.path ? "Replace the Nomina DNS-over-TLS certificate" : "Issue and select a DNS-over-TLS certificate",
    hostname, root: root.fingerprint256, caVmid: caRef.vmid, dnsVmid: dnsRef.vmid, dnsIp: dnsRef.ip,
    listener: previous.enabled ? `TCP ${previous.port} is enabled` : "DNS-over-TLS will stay off",
    certificate: previous.current ?? null, version: previous.version,
  };
  const approval = createHash("sha256").update(JSON.stringify({ review, previous })).digest("hex");
  if (!values.approve) {
    return {
      stdout: JSON.stringify(review, null, 2) + `\nRepeat with --hostname ${hostname} --approve ${approval}\n`,
      reviewOnly: true, review, approval,
    };
  }
  if (values.approve !== approval) throw new Error("Certificate review has changed. Review it again before provisioning.");
  const { leaf, warning } = await replaceCertificate(context, adapters, { root, hostname, previous });
  let renewal = "";
  if (adapters.dnsRenewal) {
    try {
      const unit = await adapters.dnsRenewal.register(project.projectDirectory);
      renewal = `\nAutomatic renewal is configured through ${unit}.timer.`;
    } catch (error) {
      renewal = `\nAutomatic renewal could not be scheduled. ${error.message}\nRun nomina ca dns-renewal migrate from the project to retry.`;
    }
  }
  const message = previous.enabled ? "Verified the new certificate over DNS-over-TLS." : "DNS-over-TLS remains off. Use the device setup workflow when you want to enable it.";
  return { stdout: `Selected the certificate for ${hostname}. Expires ${leaf.validTo}.\n${message}${renewal}${warning}\n`, hostname };
}

/** Identify an existing managed certificate without applying a certificate or listener change. */
export async function hasManagedDnsCertificate(project, adapters) {
  if (!canProvisionDnsCertificate(project)) return false;
  const { runDns, inspect } = certificateContext(project, adapters);
  const { stdout } = await runDns('if [ -d "$1" ] && [ ! -L "$1" ]; then printf present; fi', [storage]);
  return stdout === "present" && Boolean(await inspect(true));
}

export async function renewDnsCertificate(project, adapters, now = Date.now()) {
  if (!canProvisionDnsCertificate(project)) return { stdout: "" };
  const context = certificateContext(project, adapters);
  const previous = await context.inspect(true);
  if (!previous) return { stdout: "" };
  const expiry = Date.parse(previous.current.expires);
  const lifetime = expiry - Date.parse(previous.current.issued);
  if (expiry - now > lifetime / 3) return { stdout: "" };
  const root = await fetchProfileRoot(project, adapters.proxmox);
  if (previous.current.rootFingerprint !== root.fingerprint256)
    throw new Error("The CA root has changed. Review the resolver certificate and device trust before rotating it.");
  const hostname = domain(previous.current.hostname);
  const { leaf, warning } = await replaceCertificate(context, adapters, { root, hostname, previous, minimumExpiry: expiry });
  return { stdout: `Renewed the certificate for ${hostname}. Expires ${leaf.validTo}.${warning}\n` };
}

async function replaceCertificate(context, adapters, { root, hostname, previous, minimumExpiry = 0 }) {
  const { caRef, dnsRef, inspect, provider, request, run, runDns, zone } = context;
  const directory = `${storage}/${randomUUID()}`;
  const path = `${directory}/resolver.pfx`;
  const discard = folder => runDns(discardCertificate, [folder]);
  let selectionAttempted = false;
  let leaf;
  try {
    const cn = hostname.length <= 64 ? hostname : "Nomina DNS resolver";
    const { stdout: csr } = await runDns(makeRequest, [storage, directory, cn, hostname]);
    const { stdout: bundle } = await run(caRef.vmid, signRequest, [cn, hostname], csr);
    leaf = new X509Certificate(bundle);
    if (leaf.ca || leaf.subjectAltName !== `DNS:${hostname}`)
      throw new Error("step-ca did not issue a leaf certificate for the reviewed hostname.");
    if (Date.parse(leaf.validTo) <= minimumExpiry)
      throw new Error("step-ca did not issue a certificate that extends the current expiration date.");
    await runDns(stageCertificate, [directory, hostname], `${root.toString().trimEnd()}\n${bundle.trim()}\n`);
    if (JSON.stringify(await inspect()) !== JSON.stringify(previous))
      throw new Error("Technitium certificate settings changed during issuance. Review them again.");
    selectionAttempted = true;
    await provider.setTlsCertificate(request, path);
    const current = await inspect();
    if (current.path !== path || current.current?.fingerprint !== leaf.fingerprint256 ||
        current.enabled !== previous.enabled || current.port !== previous.port)
      throw new Error("Technitium did not retain the reviewed certificate and listener settings.");
    if (current.enabled)
      await (adapters.deviceTlsQuery ?? queryTls)(dnsRef.ip, hostname, zone, root.toString(), current.port, leaf.fingerprint256);
  } catch (error) {
    if (selectionAttempted) {
      try {
        const current = await inspect();
        if (current.path === path) {
          if (current.enabled !== previous.enabled || current.port !== previous.port)
            throw new Error("Listener settings changed concurrently.");
          await provider.setTlsCertificate(request, previous.path);
          if ((await inspect()).path !== previous.path) throw new Error("Previous path was not restored.");
        }
      } catch (rollbackError) {
        throw new Error(`${error.message} Could not confirm certificate rollback: ${rollbackError.message} Check Technitium. The staged file is ${path}.`);
      }
    }
    try {
      await discard(directory);
    } catch {
      throw new Error(`${error.message} Could not remove staged files in ${directory}.`);
    }
    throw error;
  }

  let warning = "";
  if (previous.path) {
    try {
      await discard(previous.path.replace(/\/resolver\.pfx$/, ""));
    } catch {
      warning = `\nCould not remove the superseded certificate at ${previous.path}.`;
    }
  }
  return { leaf, warning };
}

export async function dnsCertificateMenu(adapters, project, initialHostname = undefined) {
  const p = adapters.prompts;
  const cancelled = { stdout: "", cancelled: true };
  const command = (...args) => adapters.runCommand(["ca", "dns-certificate", "--project-dir", project.projectDirectory, ...args], adapters);
  try {
    const initial = initialHostname ?? (await command()).review.hostname;
    const hostname = domain(await p.ask("Name for the DNS server certificate", initial));
    const review = await command("--hostname", hostname);
    p.info(JSON.stringify(review.review, null, 2));
    if (!(await p.confirm({ message: "Issue and select this certificate in Technitium?", initialValue: false })))
      return cancelled;
    return await command("--hostname", hostname, "--approve", review.approval);
  } catch (error) {
    if (error.message === "Setup cancelled.") return cancelled;
    throw error;
  }
}
