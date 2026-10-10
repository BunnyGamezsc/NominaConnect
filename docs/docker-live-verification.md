# Docker binding validation, 2026-10-10

Scope: [#32](https://github.com/BunnyGamezsc/NominaConnect/issues/32), under
[#31](https://github.com/BunnyGamezsc/NominaConnect/issues/31).

## Target and preservation

Live mutations ran only on the documented Ethernet lab, `root@192.168.1.3`,
node `pve`, bridge `vmbr0`. Existing CTs 100-105 and the retained
`/root/nomina-bunnytest` project were preserved. The initial SSH attempt timed
out; the lab became reachable on the subsequent attempt.

The production SSH alias was initially queried read-only before the target
was clarified. No production CT, application, project or host setting was
created, started, stopped, installed or changed. It was not used afterward.

The requested test IP `192.168.1.88/24` did not match an existing CT config
and did not respond to preflight ping. External availability still could not
be guaranteed and the CLI's warning remained accurate. Gateway was
`192.168.1.3`; the managed Technitium resolver default was `192.168.1.53`.

The lab initially had only Debian 12 cached. The official
`debian-13-standard_13.6-1_amd64.tar.zst` template was downloaded with `pveam`,
which verified its checksum. Existing templates were retained. Available
rootdir storage was about 13.6 GiB, so the test used editable overrides of
2 cores, 512 MiB and 8 GiB instead of the 2048 MiB/32 GiB recommendations.
No host package upgrade, networking rewrite or confinement workaround ran.

## Real creation and recovery

The production Proxmox adapter created CT 106, `docker-acceptance`,
unprivileged with nesting/keyctl configured before its first start. VMID 106
was persisted before installation. The acceptance harness deliberately
interrupted the first installation call and verified pending state.

Retry used the same VMID. The first verification also uncovered a real CLI
integration defect: Docker's invalid `/dev/null` config directory prevented
Compose and Buildx discovery despite their packages being installed. A
minimal read-only production-adapter check reproduced it. Replacing that
directory with `/proc/self/fd` restored both plugins without loading operator
configuration or changing the daemon. The same check then passed, and the
retained project resumed successfully without another CT creation.

Observed versions:

- Engine 29.9.0
- Compose 5.6.0
- Buildx 0.38.0
- containerd package 2.4.1

## Live acceptance

`acceptance/docker-lxc.acceptance.mjs` passed 1/1 live test, with no skip, after
resuming `/tmp/nomina-docker-acceptance-LR5gwt` on the lab. Six check groups
passed: resumable creation, confinement/features, read-only attachment
and disconnect, endpoint/replica discovery, retained created CT, and
preservation of existing CTs.

The test seeded only CT 106 with a standalone nginx container, two Compose
replicas, a stopped container, a host-network container and a named volume.
It verified effective published ports, IPv4/IPv6 wildcard observations,
loopback and UDP exclusions, Compose grouping and distinct current instances.
A private environment fixture never appeared in discovery output.

Hash snapshots of the new CT configuration and its Docker container, network,
volume and daemon configuration stayed identical across connect, inspect and
disconnect. Read-only command tracing excluded installation, restart and
reconfiguration. All six pre-existing CT configuration hashes and running
statuses matched their baseline. The retained lab project's YAML and state
also passed their independent SHA-256 checks.

The Linux native binary was built from this checkout and copied to an
isolated `/opt/nomina-docker-issue32-run1` directory. It separately passed
scripted connect/list/inspect/disconnect against CT 106. Inspection returned
5 containers, 9 candidate observations, no truncation and no diagnostics.
The native test also reconfirmed the retained lab project hashes.

The final native build's SHA-256 is recorded in the PR validation summary.
The existing installed lab binary and retained project were not replaced.

Repository validation passed 579 tests, with two existing skips and no
failures. `npm run typecheck` and `git diff --check` passed. The legacy full
platform acceptance command was run locally and skipped by its explicit
opt-in gate. It was not enabled on the retained lab, because this ticket does
not require reprovisioning its DNS, proxy, CA and VPN stack.

## Retained resources and limits

CT 106 remains running at `192.168.1.88` with its fixture applications and
volume. Both test bindings were disconnected. The temporary acceptance
project, its `attachment` subproject and `evidence.json` remain on the lab for
inspection; no stop/destroy/prune cleanup ran.

The tests did not reconnect or modify the stopped Docker CT on production.
Live privileged/rootless attachment, macvlan/ipvlan and large-fleet truncation
were not exercised. Automated tests cover their acceptance/rejection or
normalization paths. Discovery establishes published mapping evidence, not
an application's HTTP protocol or end-to-end reachability. The exposure
picker and publishing integration remain the separate #33 ticket.

## PR #34 review follow-up, 2026-10-10

Setup failures now preserve their original error as the cause. If saving
recovery state also fails, an `AggregateError` retains both errors and asks
for manual project-storage and Proxmox inspection without claiming that a
VMID was saved or recommending an automatic retry.

Regression coverage simulates allocation and recovery write-lock failures,
checks that no provider reference was persisted, and confirms that setup
does not continue. The existing interrupted-installation test also checks
that a successful recovery write preserves the original setup error.
Changed runtime functions have JSDoc descriptions for CodeRabbit's
docstring coverage warning.

Repository validation passed 580 tests with two existing skips and no
failures. Typecheck and `git diff --check` passed. No live acceptance or
native-binary check was rerun for this error-handling and documentation
follow-up; the lab and production resources were not accessed or changed.
