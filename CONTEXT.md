# NominaConnect

NominaConnect is the domain for declaring and operating a homelab's managed
infrastructure and applications without taking ownership of unrelated existing
configuration.

## Language

**Managed inventory**:
The explicit list of infrastructure services, applications, domains, and
integrations that a user has entrusted to NominaConnect to manage.
_Avoid_: all configuration, discovered configuration

**Managed integration**:
A DNS, reverse-proxy, certificate, or VPN relationship derived from an item in
the managed inventory.
_Avoid_: automatic adoption, global synchronization

**NominaConnect ID**:
A stable, internal identifier for a managed inventory item. It exists only in
NominaConnect configuration and state, not in provider configuration.
_Avoid_: container ID, provider marker

**Provider reference**:
The provider-native identifier or matching details that NominaConnect stores
against a managed item to locate its provider-side resource.
_Avoid_: NominaConnect ID, ownership marker

**Connection secret**:
The credential used to connect to a provider or managed LXC. It is stored in a
secure local secret store and referenced from NominaConnect configuration.
_Avoid_: plain-text config value, project secret

**LXC administrator connection**:
The explicit privileged connection NominaConnect uses to install, configure,
and inspect a dedicated service LXC after provisioning it in Proxmox.
_Avoid_: service UI access, unauthenticated host access

**CLI**:
NominaConnect's only user interface for setup, inspection, and service
management.
_Avoid_: dashboard, web UI

**Proxmox node**:
The single explicit Proxmox host targeted by the initial NominaConnect setup.
_Avoid_: implicit cluster target, default node

**Proxmox-shell execution**:
Running the NominaConnect CLI as root directly on the Proxmox host, with local
access to Proxmox management commands.
_Avoid_: remote Proxmox API client, root password prompt

**LXC host control**:
The use of local `pct exec` commands from the Proxmox root shell to install,
configure, and inspect a dedicated service LXC.
_Avoid_: per-LXC SSH administration, service UI access

**Default network bridge**:
The Proxmox bridge selected during initialization for new service LXCs. A new
service can explicitly override it.
_Avoid_: implicit bridge, immutable network target

**Service hostname**:
The predictable, user-overridable LXC hostname generated from a managed service
name.
_Avoid_: random hostname, fixed hostname

**Explicit upgrade**:
A service version change initiated only by `nomina service upgrade <name>`, not
by background change tracking.
_Avoid_: automatic upgrade, reconciliation update

**Optional pre-upgrade snapshot**:
A rollback snapshot offered to the user before an explicit service upgrade when
the selected Proxmox storage supports it.
_Avoid_: mandatory snapshot, assumed rollback point

**Initial platform catalog**:
The first selectable platform options: Technitium, Caddy, Traefik, step-ca,
Caddy Internal CA, Tailscale, and NetBird.
_Avoid_: generic infrastructure capability, hidden software selection

**Resource recommendation**:
The plugin-provided CPU, memory, disk, and related LXC defaults shown during
service setup. The user may override each value.
_Avoid_: hidden resource sizing, mandatory default

**Base local domain**:
The local DNS suffix chosen during initialization, used to suggest—not force—a
full hostname when a web service is added.
_Avoid_: public-domain requirement, generated-only hostname

**LXC administrator key**:
A per-LXC SSH key created during provisioning and retained in the secure local
secret store for NominaConnect's administrator connection.
_Avoid_: repeated root password, shared SSH key

**Service plugin**:
A named supported service definition that owns its deployment, inspection, and
platform-integration behavior for a selected deployment option.
_Avoid_: arbitrary command, generic container image

**Background change tracking**:
The asynchronous inspection and adoption of changes across managed services and
integrations while the CLI performs the user's requested command.
_Avoid_: blocking preflight inspection, manual-only sync

**Tracking job**:
A work-to-completion background process started by a CLI invocation. It
continues after that command returns until its inspection and adoption pass is
finished.
_Avoid_: always-on daemon, foreground sync

**Configuration write queue**:
The single serialized path for foreground commands and tracking jobs to commit
atomic changes to NominaConnect configuration.
_Avoid_: concurrent file writes, last writer wins

**Change notice**:
A concise summary of adopted changes and verification warnings shown at the
start of the next CLI command. Full details are available through `nomina changes`.
_Avoid_: silent adoption, dashboard notification

**Bounded retry**:
Automatic reinspection with a finite backoff policy after a provider is
temporarily unavailable; failure becomes a verification warning, not an
unrelated command failure.
_Avoid_: infinite retry, fail-fast tracking

**Project configuration**:
The visible, human-editable `nomina.yaml` that declares one homelab's managed
inventory. Secrets and operational state are kept outside this file.
_Avoid_: hidden global configuration, secret store

**Service health check**:
The plugin-defined verification of a managed service's process, network
endpoint, and applicable platform integrations.
_Avoid_: installation success, configuration observed

**Verified adoption**:
An adopted provider or service configuration change whose affected service has
subsequently passed its service health check.
_Avoid_: observed change, assumed healthy

**Service base image**:
The operating-system template used for a dedicated service LXC. The first
supported image is Debian stable.
_Avoid_: incidental template, host operating system

**Unprivileged service LXC**:
A dedicated service LXC created without elevated container privileges. It is the
default unless a plugin declares and the user confirms an exception.
_Avoid_: privileged-by-default LXC, unrestricted container

**Default storage target**:
The Proxmox storage selected during initialization for new service LXCs. A new
service may explicitly override it.
_Avoid_: implicit storage, immutable storage target

**Service configuration**:
The inspectable settings of a managed service, including its application-owned
settings and its platform integrations. NominaConnect adopts observed changes to
these settings.
_Avoid_: integration-only configuration, opaque service state

**Unmanaged configuration**:
Existing provider configuration that is outside NominaConnect's managed
inventory and must be preserved.
_Avoid_: legacy configuration, foreign configuration

**Provider inspection**:
Reading a provider's current configuration or effective state in order to
compare it with the managed inventory.
_Avoid_: blind apply, assumed state

**Observed configuration**:
The current configuration or effective state reported by a provider through
provider inspection.
_Avoid_: desired state, guessed state

**Adoption**:
Updating NominaConnect's managed inventory to reflect an inspectable change
made directly in a provider's own interface. Adoption automatically persists
the observed value to NominaConnect's configuration.
_Avoid_: overwrite, forced restoration

**Change history**:
A reversible record of an automated adoption or user-initiated modification to
the managed inventory.
_Avoid_: opaque mutation, audit log

**Verification warning**:
A visible report that NominaConnect cannot inspect a managed integration well
enough to confirm that it is working.
_Avoid_: healthy, synchronized

**Provider precedence**:
The rule that current configuration from an inspectable provider is the value
NominaConnect persists when it differs from its own configuration.
_Avoid_: merge conflict, configuration precedence

**Primary environment**:
The deployment environment whose workflows and provider integrations define the
first supported NominaConnect experience. For the MVP, this is Proxmox.
_Avoid_: default backend, incidental host

**Deployment option**:
A user-selected combination of environment and deployment backend for a
managed service, such as Proxmox native LXC or Docker in a Proxmox VM.
_Avoid_: Docker versus LXC question, fixed runtime

**Dedicated service LXC**:
A Proxmox LXC created and managed by NominaConnect for exactly one managed
service in the native-LXC deployment option.
_Avoid_: shared service host, adopted LXC

**Requested service IP**:
The static IP address entered by the user during new-service setup for a
dedicated service LXC.
_Avoid_: automatic allocation, DHCP assignment

**IP preflight**:
The setup check that blocks a requested service IP known to be in use and warns
when NominaConnect cannot determine whether an external collision exists.
_Avoid_: IP allocation, guaranteed availability

**Platform bootstrap**:
The guided setup of foundational platform services in dependency order: DNS,
reverse proxy, certificate authority, then optional VPN.
_Avoid_: application-first setup, opaque installer

**Provider plugin**:
The provider-specific integration responsible for setup, inspection, and
adoption of one named software choice. The first DNS provider plugin is
Technitium DNS Server.
_Avoid_: generic capability, partial integration

**Reverse-proxy provider**:
A provider plugin that manages application routes and their observed state. The
initial supported choices are Caddy and Traefik.
_Avoid_: generic proxy, hidden implementation

**Certificate-authority provider**:
A separately selected provider plugin that supplies certificates and trust for
managed exposures when TLS is enabled. Its available choices depend on
compatibility with the selected reverse-proxy provider.
_Avoid_: proxy setting, implicit TLS

**VPN provider**:
An optional provider plugin that supplies private network connectivity for the
managed inventory. The initial selectable choices are Tailscale and NetBird.
_Avoid_: required platform service, generic VPN

**Untrusted HTTPS exposure**:
A published application address served by Caddy or Traefik through TLS with a
certificate that browsers do not trust because no trust-providing CA is
configured.
_Avoid_: HTTP-only fallback, failed exposure
