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
