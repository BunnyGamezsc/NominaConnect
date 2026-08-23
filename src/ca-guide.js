export function getStepCaTrustGuide(project) {
  const caService = project?.config?.managedInventory?.platform?.certificateAuthority;
  const caRef = caService ? project?.state?.providerReferences?.[caService.id] : undefined;
  const caIp = caRef?.ip ?? caService?.deployment?.ip ?? "<CA-IP>";
  const caVmid = caRef?.vmid ?? "<vmid>";
  const domain = project?.config?.baseLocalDomain ?? "bunnyhome.test";

  const fetchCmd = `curl -k https://\${CA_IP}:9000/roots.pem -o step-ca-root.crt`;
  const pctCmd = `pct exec ${caVmid} -- cat /var/lib/stepca/certs/root_ca.crt > step-ca-root.crt`;
  const caIpLine = typeof caIp === "string" && caIp.includes(".") ? `CA_IP=${caIp}` : `CA_IP=192.168.4.87  # your step-ca IP`;

  return `NominaConnect step-ca trust guide
===============================

What happens:
- When step-ca is provisioned, Caddy asks step-ca for a cert for each new exposure.
- Example: photos.${domain} → Caddy → ACME https://${caIp}:9000/acme/acme/directory → trusted cert.
- Without trusting the CA, browsers show "untrusted" but still HTTPS (never HTTP).

You MUST trust the step-ca root CA on every device that will open https://${domain} sites.

1) Get the root certificate (choose one)

   From Proxmox host (recommended):
     ${pctCmd}
     cat step-ca-root.crt  # verify it starts with -----BEGIN CERTIFICATE-----

   Or from any machine that can reach the CA (ignores TLS):
     ${caIpLine}
     ${fetchCmd}
     # alternative:
     curl -k https://${caIp}:9000/roots.pem -o step-ca-root.crt

   The cert is at:
     LXC ${caVmid} (${caIp}): /var/lib/stepca/certs/root_ca.crt  (also STEPPATH/certs/root_ca.crt)
     Also available via: https://${caIp}:9000/roots.pem

2) Install on devices

   macOS (per-user):
     sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain step-ca-root.crt
     # then restart browser

   macOS (Firefox):
     Firefox → Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import → step-ca-root.crt → Trust to identify websites

   Windows (per-machine):
     double-click step-ca-root.crt → Install Certificate → Local Machine → Place in Trusted Root Certification Authorities → Finish

   Linux (Debian/Ubuntu + Chrome):
     sudo cp step-ca-root.crt /usr/local/share/ca-certificates/step-ca-root.crt
     sudo update-ca-certificates

   Linux (Firefox):
     Firefox → Settings → Privacy & Security → View Certificates → Authorities → Import → step-ca-root.crt → Trust

   iOS:
     Send step-ca-root.crt to iPhone (AirDrop/email) → Install profile → Settings → General → VPN & Device Management → enable → Settings → General → About → Certificate Trust Settings → enable Full Trust for step-ca

   Android:
     Settings → Security → Encryption & credentials → Install a certificate → CA certificate → select step-ca-root.crt

3) Verify

   On a trusted device:
     curl --cacert step-ca-root.crt https://photos.${domain}
     # or after installing system-wide:
     curl https://photos.${domain}

   In browser, open https://photos.${domain} — no warning, lock icon valid, issuer = NominaConnect CA.

4) Notes

   * Do this BEFORE publishing exposures, or re-open the site after trusting — Caddy already has a trusted cert, only the client needs the root.
   * step-ca root does not change unless you re-init the CA (deleting /var/lib/stepca). Keep step-ca-root.crt safe.
   * Caddy Internal CA is different: it uses Caddy's internal PKI (caddy trust) and has no separate LXC.

Commands to re-export the cert anytime:
   pct exec ${caVmid} -- cat /var/lib/stepca/certs/root_ca.crt
   pct exec ${caVmid} -- cat /var/lib/stepca/certs/root_ca.crt > /root/step-ca-root.crt && cat /root/step-ca-root.crt

Need help? Run: nomina ca cert --project-dir /root  # prints the cert if reachable
`;
}

export function canShowCaTrustGuide(project) {
  const caService = project?.config?.managedInventory?.platform?.certificateAuthority;
  if (caService?.service !== "step-ca") return false;
  return project?.state?.providerReferences?.[caService.id] !== undefined;
}

export function getStepCaExportGuide(project, outputPath) {
  const domain = project?.config?.baseLocalDomain ?? "bunnyhome.test";

  return `step-ca root certificate exported to ${outputPath}

Copy it to a device (run on the device, not on Proxmox):
  scp root@<proxmox-host>:${outputPath} .

Install the root on the device:

  macOS:
    sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain step-ca-root.crt
    # then restart your browser

  Windows:
    double-click step-ca-root.crt → Install Certificate → Local Machine → Place in Trusted Root Certification Authorities

  Linux:
    sudo cp step-ca-root.crt /usr/local/share/ca-certificates/step-ca-root.crt
    sudo update-ca-certificates

  Firefox (separate trust store on every OS):
    Settings → Privacy & Security → Certificates → View Certificates → Authorities → Import → step-ca-root.crt → Trust for websites

  iOS: AirDrop/email the file → Install profile → enable in VPN & Device Management → enable Full Trust in Certificate Trust Settings
  Android: Settings → Security → Install a certificate → CA certificate

Verify from the device:
  curl https://<exposure>.${domain}
  # no TLS error and issuer "NominaConnect CA" = trusted
`;
}
