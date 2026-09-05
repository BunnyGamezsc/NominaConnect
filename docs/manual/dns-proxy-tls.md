# Manual reference: local DNS, reverse proxy, and TLS

## Purpose

This is the first manual reference path. Complete it on a disposable or
well-understood host before implementing a provider, plugin, renderer, or
automation command.

## Proposed reference choices

This document proposes, but does not yet validate:

- DNS: Technitium DNS Server
- Reverse proxy: Caddy
- Certificate authority: Caddy Internal CA
- Environment: Linux (manual installation)
- Test application: a simple HTTP service on `127.0.0.1:3000`
- Local domain: `photos.bunnyhome.com`

These choices are intentionally concrete so the manual process can uncover
real integration requirements. They are not project-wide defaults.

## Desired behavior

```text
client
  -> local DNS resolves photos.bunnyhome.com to proxy host
  -> Caddy terminates trusted local TLS
  -> Caddy proxies to the application on localhost:3000
  -> application is reachable at https://photos.bunnyhome.com
```

## Manual validation log

Record exact commands and results below during validation. Do not replace this
section with automation output.

| Check | Command or observation | Expected result | Actual result | Status |
| --- | --- | --- | --- | --- |
| DNS service healthy |  | Service is running |  | pending |
| DNS record resolves |  | Proxy host address returned |  | pending |
| Application reachable locally |  | HTTP response on `127.0.0.1:3000` |  | pending |
| Proxy route works |  | Expected application response |  | pending |
| Client trusts local TLS |  | No certificate warning |  | pending |
| Restart behavior |  | Route recovers after restart |  | pending |

## Acceptance criteria

The reference path is ready to document as proven only when all checks pass on
a real client, including client trust of the local CA. At that point, add the
actual commands, configuration snippets, failure modes, and recovery steps to
this guide.

## Future generated artifacts

After validation, an eventual implementation may generate:

- a Technitium DNS record for the local domain;
- a Caddy site definition and upstream route;
- local CA trust-installation instructions or an explicit trust artifact;
- a machine-readable reconciliation state.

Those outputs remain derived from the system definition.

## Traefik as the reverse proxy

Choosing Traefik at `nomina init` swaps the proxy layer; DNS and the exposure
workflow are unchanged.

`nomina service add traefik` provisions a dedicated unprivileged Debian LXC and
installs Traefik v3 from its release tarball with:

- `/etc/traefik/traefik.yml` — static configuration: the `web` (`:80`),
  `websecure` (`:443`), and `traefik` (`:8080`) entryPoints, and a **file
  provider watching `/etc/traefik/dynamic`**.
- `/etc/systemd/system/traefik.service` — the unit that runs it.

### One fragment per exposure

`nomina exposure publish` writes exactly one file:

```
/etc/traefik/dynamic/nomina-<hostname>.yml
```

It holds an `http.routers` entry on the `websecure` entryPoint with a `tls`
block, and the matching `http.services` load balancer pointing at the backend.
The file is staged outside the watched directory and moved into place, so
Traefik never reloads a half-written fragment.

Nothing else in `/etc/traefik/dynamic` is read or written. Fragments you wrote
yourself are preserved by provisioning, publishing, and removal alike.

### The dashboard is for looking, not writing

Traefik's API on `:8080` is how NominaConnect *observes* Traefik — health,
inspection, and confirming that a published fragment was actually loaded. Every
configuration change goes through the watched directory, which is Traefik's
supported configuration path. NominaConnect never issues a write to the API.

Because inspection reads the effective configuration, editing a managed fragment
by hand is picked up on the next command: the observed backend becomes the value
NominaConnect persists (see ADR-0005). If the fragment no longer matches what
NominaConnect published, removing the exposure is refused rather than deleting
your edit.

### TLS

Traefik exposures are always HTTPS. With no trust-providing CA configured,
Traefik answers with its own generated self-signed certificate — an untrusted
HTTPS exposure, never an HTTP fallback.

### Trusted certificates through step-ca

Selecting step-ca as the certificate authority makes those exposures trusted.
Publishing does three things inside the Traefik LXC:

1. installs the step-ca root certificate
   (`/usr/local/share/ca-certificates/step-ca-root.crt`, then
   `update-ca-certificates`) and pins `step-ca.<domain>` in `/etc/hosts`,
   because step-ca's serving certificate carries DNS names only;
2. adds a managed certificate resolver to `/etc/traefik/traefik.yml`:

   ```yaml
   # >>> Managed by NominaConnect: step-ca certificate resolver
   certificatesResolvers:
     nomina-stepca:
       acme:
         caServer: "https://step-ca.<domain>:9000/acme/acme/directory"
         email: "nomina@<domain>"
         storage: /etc/traefik/acme.json
         certificatesDuration: 24
         tlsChallenge: {}
   # <<< Managed by NominaConnect
   ```

3. names that resolver in the exposure's fragment (`tls.certResolver`), so the
   router asks step-ca for a certificate instead of serving Traefik's own.

A certificate resolver can only be defined in Traefik's **static**
configuration — a configuration file, command-line arguments, and environment
variables are mutually exclusive there — so that file has to be edited. Only
the block between the markers belongs to NominaConnect: entryPoints, logging,
and anything else you put in `traefik.yml` are preserved, and a
`certificatesResolvers` key you wrote yourself is never replaced. Traefik is
restarted only when the root certificate or the static configuration actually
changed.

`certificatesDuration: 24` matches step-ca's 24-hour certificate lifetime;
Traefik derives its renewal window from that value.

### What "trusted" has to prove

An exposure is only reported as trusted when step-ca has issued a certificate
for the hostname (its entry exists in `/etc/traefik/acme.json`) *and* the
certificate Traefik presents validates against the root installed in the LXC.
`nomina.yaml` records `tls.trusted: true` only after that check passes.

If the CA is unreachable, the certificate has not been issued yet, or the
handshake does not validate, `nomina exposure publish` prints a verification
warning and leaves the exposure on Traefik's own certificate — still HTTPS, and
with nothing else in Traefik's configuration changed.

Browsers still need the step-ca root installed to trust these certificates;
`nomina ca guide` prints the per-device instructions.
