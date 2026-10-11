# Publish an exposure from Docker

Run `nomina`, choose **Publish an exposure**, then **From Docker**. Select a
Docker host binding, application and published endpoint. Compose services
are grouped by project/service; replicas retain their container/instance
identity. Standalone containers are listed by name. Each endpoint shows its
status, bind address, effective host port, private container port, transport
and any reason it is unavailable. Repeated identical binding tuples collapse.

With no binding, create/connect a Docker LXC from **Docker hosts**, or continue
with **Manual entry**. `nomina docker create` and `nomina docker connect`
provide the same host workflows for scripts. Existing manual publication and
editing commands keep their behavior.

## Review and confirm

All proposals are editable: display name, full hostname, connection type,
backend IP and effective published host port, backend HTTP/HTTPS, TCP listener
port and Tailscale access when configured. A web exposure always uses HTTPS
for clients; backend HTTP/HTTPS is a separate choice. Existing CA trust,
redirect, TCP forwarding, DNS, listener and tailnet behavior still belongs to
the existing exposure lifecycle.

Names derive from the sanitized application and `baseLocalDomain`. Multiple
endpoints get port/identity suffixes; existing managed hostnames get distinct
names. Existing exposures for the backend are advisory, so another name is
allowed. Docker creation never overwrites an existing exposure, even when its
hostname is entered explicitly. Use **Edit an exposure** to update one.
Unmanaged DNS records or proxy routes also block publication.

Allowlisted image/application-port pairs can suggest a type: official
nginx/httpd/Caddy/Traefik on 80 or 443, known Samba images on 445, and the
LinuxServer OpenSSH image on 2222. The review explains that evidence and lets
you change it. A TCP transport or familiar port alone never proves HTTP, SSH
or SMB. Unknown protocols require an explicit choice. SSH uses generic TCP,
with an editable listener; reserved administration ports remain reserved.

SMB uses the existing client-port-445 preset, while the Docker published
backend port can differ. Shares, users, passwords and permissions stay on the
SMB server. Configure the server's hostname alias. Client paths are
`\\\\HOSTNAME\\SHARE` on Windows and `smb://HOSTNAME/SHARE` on macOS.
Ordinary TCP selects a backend by listener address/port, not hostname; each
listener is exclusive. See [SMB verification](smb-live-verification.md).

At the final Docker review, choose **Publish this reviewed exposure**,
**Check readiness without publishing**, or **Cancel**. Cancellation is the
initial selection. Readiness review and cancellation perform no provider/
configuration writes or background tracking. Readiness review applies the
same TCP listener, gateway and DNS preflights as publication.
Before publication the exact endpoint is reinspected, and the reviewed backend
is checked from the managed proxy LXC. Transport reachability does not prove
HTTP correctness, authentication, a share read or an application login.

## Scripted selection

Inspect the named binding to get application names and current endpoint IDs:

```sh
nomina docker inspect apps --json
nomina exposure publish --source docker --docker-binding apps \
  --docker-application 'suite/web' --docker-endpoint ENDPOINT_ID \
  --protocol https --hostname web.bunny.internal --review-only
```

Review the output, then repeat the same selection and edits with `--yes`
instead of `--review-only`. Both modes suppress interactive prompts. Unknown
applications require `--protocol https|tcp|smb`; known hints can be overridden.
Optional flags include `--name`, `--hostname`, `--backend-ip`,
`--backend-port`, `--backend-tls true|false`, `--listener-port` and
`--tailnet true|false`. `--source manual` selects the existing manual flow.
Use `nomina exposure publish --help` for the flag summary.

## Menu and flag parity

The menu and scripted commands use the same field collection, validation and
publication handlers. Supplied flags override proposals; missing fields are
editable prompts unless `--yes` or Docker `--review-only` suppresses them.
`--yes` also suppresses prompts for Manual entry, where missing required fields
fail validation. Switching to Manual entry retains any exposure fields already
supplied and drops the Docker selectors.

| Scripted option | Interactive equivalent |
| --- | --- |
| `--source manual\|docker` | Manual entry / From Docker |
| `--docker-binding` | Docker host binding selection |
| `--docker-application` | Docker application selection |
| `--docker-endpoint` | Published Docker endpoint selection |
| `--name`, `--hostname` | Service name and full hostname |
| `--protocol https\|tcp\|smb` | HTTPS / TCP / SMB protocol selection |
| `--backend-ip`, `--backend-port` | Backend IP and effective published port |
| `--backend-tls true\|false` | Backend HTTPS/TLS confirmation for web exposures |
| `--listener-port` | Editable generic TCP client listener; SMB is fixed at 445 |
| `--tailnet true\|false` | Tailscale access confirmation when configured |
| `--yes` | Explicit final Docker publication choice; suppress scripted prompts |
| `--review-only` | Docker readiness review without publication |
| `--redirect-to`, `--redirect-code 307\|308` | Manual web redirect target and status code |
| `--project-dir` | Select a project explicitly; the menu discovers its current or parent project |

Raw TCP rejects backend TLS and redirects. Web exposures reject a TCP listener.
SMB rejects client listeners other than 445. Docker selection requires a backend
endpoint; URL redirects use Manual entry. Review-only applies to Docker selection.

Endpoint IDs describe an observation, including current container identity,
application/instance, bind tuple, status and resolved CT address. They are not
durable service identities. Recreation, disappearance or changed bindings
invalidate an old ID and require fresh selection/review. The flow also
reinspects after guided confirmation. Explicit backend overrides remain
exactly as entered and must pass the proxy-context reachability check.

## Unsupported endpoints and independence

Wildcard bindings use the inspected CT address in the matching address family,
then require a successful proxy-context probe. Concrete bindings are retained.
Loopback, unspecified, multicast, link-local, unsupported mapped addresses,
UDP/SCTP, host networking, directly addressed networks and missing published
ports show explanations and a manual-entry option. Discovery never changes
Docker networking or publishes another port. Current raw TCP forwarding
requires IPv4 listener/backend addresses; web adapters retain their existing
address/TLS limits.

Only the confirmed exposure is saved, with existing integration references
and tracking. No container ID, Docker environment, credentials or discovery
snapshot is adopted into the exposure. Disconnecting a Docker binding retains
the exposure, its configured backend and the application. Docker changes never
automatically retarget it. Truncated discovery is reported; only observed
endpoints can be selected.

## Live acceptance

`npm run test:docker-exposure-acceptance` skips without explicit opt-in. On the
authorized root Proxmox lab, provide:

```sh
export NOMINA_DOCKER_EXPOSURE_ACCEPTANCE=1
export NOMINA_DOCKER_EXPOSURE_RETAINED_PROJECT=/root/nomina-bunnytest
export NOMINA_DOCKER_EXPOSURE_VMID=106
export NOMINA_DOCKER_EXPOSURE_PROXY_IP=192.168.1.89
export NOMINA_DOCKER_EXPOSURE_PROJECT=/opt/nomina-issue33-live/project
npm run test:docker-exposure-acceptance
```

The fixture needs the #32 standalone nginx/Compose applications in that Docker
CT, the retained Technitium provider and its local secret reference, available
Debian template/storage, and a free explicitly supplied proxy IP. It creates
and retains a separate Caddy proxy CT and one named Samba Docker fixture,
checks web/TCP/SMB access and writes a root-only `evidence.json`. It preserves
the retained project's files and existing CT configuration/status. Fixture
setup is acceptance work, outside product discovery/publication. Inspect
retained state after a failure rather than blindly recreating resources.

For an interrupted fixture, `NOMINA_DOCKER_EXPOSURE_PROXY_VMID` explicitly
selects its isolated proxy CT; `NOMINA_DOCKER_EXPOSURE_PROXY_READY=1` uses its
already configured Caddy after a health check. `NOMINA_DOCKER_EXPOSURE_RUN_TAG`
adds a suffix to the web/override hostnames when earlier failed publication
left DNS records. `NOMINA_DOCKER_EXPOSURE_RESUME=1` verifies matching saved
exposures and continues their client checks without republishing them. Use the
same project and run tag, and inspect its retained evidence first. Resume
rejects mismatched backend, protocol, preset or listener settings.

See [the validation report](docker-exposure-live-verification.md) for results
and limits.
