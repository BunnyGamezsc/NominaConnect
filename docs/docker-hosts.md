# Docker host bindings

Docker host bindings are optional inspection targets on the project's configured
Proxmox node. They are separate from native service LXCs and managed exposures.
The interactive main menu has a Docker hosts entry. Each operation shares the
same command and prompt functions with the scripted CLI.

Run as root on the configured node to create, connect, retry or inspect. Listing
and disconnecting need only the local project files. Discovery is on demand;
background tracking never adopts Docker containers or retargets exposures.

## Commands

```sh
nomina docker create --name apps --ip 192.168.1.88 --gateway 192.168.1.3 --yes
nomina docker connect --name existing --vmid 110 --socket /var/run/docker.sock --yes
nomina docker list --json
nomina docker inspect apps --json
nomina docker retry apps --yes
nomina docker disconnect apps --yes
```

Omit supplied values to use guided prompts. `--yes` confirms scripted mutations
and uses recommendations for optional creation fields. A name and requested IP
remain required for scripted creation; connection also requires a VMID. Use
`--project-dir` to select a project explicitly for scripts, or let the CLI find
`nomina.yaml` in the working directory or its parents.

Creation accepts `--hostname`, `--template`, `--bridge`, `--storage`, `--gateway`,
`--nameserver`, `--prefix-length`, `--cpus`, `--memory` and `--disk`. Memory is MiB,
disk is GiB. Recommendations are 2 cores, 2048 MiB, 32 GiB and an editable `/24`.
Bridge/storage come from the project. The resolver defaults to the managed
Technitium IP, then the gateway. The template must be an available Debian 13
standard volume. CPU, available memory, rootdir storage space, an UP Linux
bridge, subnet addresses and configured-LXC IP collisions are checked before
creation. External IP collisions remain unverified and produce a warning.

## Provisioning and recovery

Created CTs are unprivileged with nesting/keyctl enabled before their first
start. Engine, Compose and Buildx come from Docker's official Debian apt
repository. Installation runs only inside the created CT. Host packages,
AppArmor confinement and storage-driver defaults are not changed.

The allocated VMID is recorded before `pct create`, and the created VMID is
saved before installation. A setup failure leaves the CT in place with a
pending phase. `retry` uses that VMID, verifies the created hostname, IP and
privilege mode, and resumes setup. It never creates a replacement. A missing
or changed CT requires manual inspection. If allocation was never recorded,
inspect Proxmox before disconnecting the pending binding and creating again.
Completed setup cannot be retried as an upgrade. Installed Docker packages
are not upgraded when resuming a partial installation.

Configuration and operational state use the project write queue and atomic
file replacements. A separate operation lock prevents concurrent provisioning
or disconnection. Locks with a recorded dead owner are recovered automatically.
An unidentifiable lock requires manual inspection before removal. Cancellation
before confirmation writes no binding; interruption after creation leaves
pending state, never a healthy claim.

## Read-only connection and discovery

Connection requires an existing running CT, a root-owned local Unix socket and
a responsive rootful Engine. Existing privileged CTs are accepted without
conversion. Socket paths are validated, passed as argument values and
canonicalized for duplicate detection. Ambient Docker contexts and CLI
configuration do not select a remote daemon. No install, restart, feature
change, stack edit, stop, destroy or prune operation occurs on attachment.

Socket access conveys full daemon authority. Using read-only commands does
not restrict the connection's permissions. Rootless and remote environments
require manual exposure entry.

`inspect` returns a transient `discovery` result for the exposure workflow:

- `containers` includes current full IDs, bounded names/image references,
  status, network mode, EXPOSE metadata and four allowlisted Compose labels:
  project, service, container-number and oneoff.
- `candidates` preserves every effective container-port/host-port/transport/
  bind-address tuple within the limits, plus application grouping and current
  instance identity. Standalone containers also appear.
- TCP candidates with a supported address provide `backendAddress` and
  `hostPort`. Wildcards use a verified CT address of the same address family.
  Wildcard and loopback addresses are never suggested as usable backends.
- Stopped containers, absent public bindings, loopback, UDP/SCTP, host networking
  and directly addressed or unverified networks remain visible with reasons
  and manual-entry fallback. EXPOSE metadata never becomes a published port.
- `connectionTypeHint` stays `unknown`; TCP or a familiar port does not prove
  HTTP. The hostname label suggestion is editable and publishes nothing.
- `truncated` and diagnostics explicitly report incomplete observations.

Limits are 100 containers, 500 endpoint candidates, 256-character names/image/
label fields, 64 KiB per inspection command, a 10-second inspection-command
timeout and a 60-second discovery budget checked between containers. Commands
and temporary outages have bounded retries. A command already in flight can
finish after the discovery budget. Only projected inspection fields cross the
adapter boundary; full inspect JSON, environment, mounts and arbitrary labels
are not printed or persisted. Docker observations are never saved to the
project.

Full container IDs are observations, not durable service identities. Compose
labels help grouping, while the current ID distinguishes instances. Container
recreation never automatically adopts a replacement or changes an exposure.
Disconnect removes only the binding and its local operational references.
The LXC, applications and existing exposures remain independently managed.
The existing nuclear uninstall workflow also excludes Docker-bound CTs from
its destruction targets, including bindings to existing CTs.

The exposure picker and editable publish form are tracked separately in #33.

## Validation

```sh
npm test
npm run typecheck
npm run test:docker-acceptance
```

The acceptance test skips unless explicitly enabled on a root Proxmox shell.
Use only the documented Ethernet lab at `root@192.168.1.3`; the SSH alias `pve`
points to production and must not be used for field tests. Preserve the
retained `bunnytest` project and its LXCs. Reserve a free test IP first.

```sh
export NOMINA_DOCKER_ACCEPTANCE=1
export NOMINA_DOCKER_ACCEPTANCE_NODE=pve
export NOMINA_DOCKER_ACCEPTANCE_IP=192.168.1.88
export NOMINA_DOCKER_ACCEPTANCE_GATEWAY=192.168.1.3
export NOMINA_DOCKER_ACCEPTANCE_RESOLVER=192.168.1.53
export NOMINA_DOCKER_ACCEPTANCE_STORAGE=local-lvm
export NOMINA_DOCKER_ACCEPTANCE_BRIDGE=vmbr0
npm run test:docker-acceptance
```

The IP above is an example, not an allocation. The suite creates one new CT,
interrupts setup after real creation, resumes it, seeds standalone and Compose
fixtures, and verifies read-only attachment, endpoint normalization and
disconnection. Existing CT configuration hashes and statuses must match their
baseline. It retains the new CT, fixture workloads, project and `evidence.json`
under a root-only temporary directory, including after failure. It does not
alter or destroy the retained lab project or applications.

Constrained labs may set `NOMINA_DOCKER_ACCEPTANCE_CPUS`,
`NOMINA_DOCKER_ACCEPTANCE_MEMORY` and `NOMINA_DOCKER_ACCEPTANCE_DISK` to exercise
the supported resource overrides. If a run fails before disconnection, set
`NOMINA_DOCKER_ACCEPTANCE_PROJECT` to its printed project directory to resume
that CT. Do not start a fresh acceptance run to recover a pending host.

Sources: [Docker Debian installation](https://docs.docker.com/engine/install/debian/),
[published ports](https://docs.docker.com/engine/network/port-publishing/),
[Docker socket authority](https://docs.docker.com/engine/security/protect-access/),
[Compose service labels](https://docs.docker.com/reference/compose-file/services/),
[Proxmox CT options](https://pve.proxmox.com/pve-docs/pct.1.html).
