# Testing NominaConnect on a Proxmox host

A worked first-run against a disposable Proxmox host, using a Proxmox VM at
`192.168.1.3` bridged onto the same ethernet LAN as the workstation.

Substitute your own addresses; everything below is a real command, not a
sketch.

---

## 1. What state the work is in

- Issues #21 (catalog-wide adapter conformance) and #22 (provider-native
  adoption in background tracking) are implemented.
- `node --test` — 449 tests, all passing. `tsc --noEmit` clean.
- The live acceptance suite (`acceptance/live-proxmox.acceptance.mjs`) has
  **never been executed against real hardware**. Its assertions are written
  from the adapters' real command and API surface, and it has been exercised
  through its skip path only. Treat the first live run as a shakedown of the
  suite as much as of the product.
- Everything is uncommitted on `main`.

### Run the tests with `node --test`, not `bun test`

`package.json` declares `"test": "node --test"`. Bun's own runner
(`bun test`) discovers the files itself and fails ~11 of them on runner
incompatibilities, not product defects: a 5-second default timeout against
tests that deliberately wait on retry/ACME backoff, and mis-reading
`node:test`'s subtest context parameter as a `done` callback. If your shell
aliases `npm` to `bun`, invoke the runner directly:

```sh
node --test          # not: npm test
```

---

## 2. Host prerequisites

### 2.1 The Proxmox VM must be bridged, with promiscuous mode on

This is the most likely thing to sink the run. Each LXC gets its own MAC
address on `vmbr0`. If the hypervisor hosting your Proxmox VM filters unknown
MACs, the containers get addresses but nothing on the LAN can reach them, and
every health check fails in a way that looks like a NominaConnect bug.

- The Proxmox VM's network adapter must be **bridged** to the physical
  ethernet interface, not NAT'd.
- Promiscuous mode must be allowed on that adapter:
  - **VMware Fusion/Workstation** — needs the vmnet to permit promiscuous mode.
  - **VirtualBox** — adapter's Promiscuous Mode set to *Allow All*.
  - **UTM/QEMU** — use a bridged interface.
  - **Hyper-V** — enable MAC address spoofing on the vNIC.

Confirm from the Proxmox shell that `vmbr0` exists and carries the LAN:

```sh
ip -o addr show vmbr0
ip route | grep default
```

### 2.2 Free static IPs

NominaConnect never allocates addresses; you supply them, and they must be
outside the router's DHCP pool. For `192.168.1.0/24` with gateway
`192.168.1.1`:

| Purpose        | Address        |
| -------------- | -------------- |
| Proxmox host   | `192.168.1.3`  |
| Technitium DNS | `192.168.1.53` |
| Reverse proxy  | `192.168.1.54` |
| step-ca        | `192.168.1.56` |
| VPN client     | `192.168.1.57` |

Check each is genuinely free before you start:

```sh
for ip in 53 54 56 57; do ping -c1 -W1 192.168.1.$ip >/dev/null && echo "192.168.1.$ip IN USE"; done
```

### 2.3 A Debian LXC template

```sh
pveam update
pveam available | grep debian
pveam download local debian-12-standard_12.7-1_amd64.tar.zst
pveam list local
```

The template flag matches by substring, so `--template debian-12-standard` is
enough.

### 2.4 Storage

A default Proxmox install gives you `local` (templates, ISOs) and `local-lvm`
(container rootfs). Confirm both are active:

```sh
pvesm status
```

Use `local-lvm` as the default storage during `nomina init`.

### 2.5 A backend to expose

The exposure test needs something already serving HTTP. Simplest option — run
one on the Proxmox host itself:

```sh
mkdir -p /tmp/backend && echo "backend ok" > /tmp/backend/index.html
cd /tmp/backend && nohup python3 -m http.server 8080 >/dev/null 2>&1 &
curl -s http://192.168.1.3:8080/
```

Backend becomes `192.168.1.3:8080`.

### 2.6 Node.js ≥ 22

```sh
node -v || { curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs; }
```

---

## 3. Getting this working tree onto the host

The changes are uncommitted, so the published installer will not have them.
Copy the tree from the workstation:

```sh
rsync -av --delete \
  --exclude node_modules --exclude .git \
  ~/Desktop/NominaConnect/ root@192.168.1.3:/opt/nominaconnect-test/
```

Then on the host:

```sh
cd /opt/nominaconnect-test
npm install          # only @clack/prompts is needed at runtime
node bin/nomina.js --version
```

Run it as `node bin/nomina.js` throughout, so you are testing this tree rather
than an installed release.

---

## 4. Layer 1 — unit and conformance suites

These need no Proxmox at all and should pass identically on the workstation
and on the host. Run them on the host first to prove the copy is intact:

```sh
cd /opt/nominaconnect-test
node --test
```

Expect `pass 449`, `fail 0`. This includes:

- `test/adapter-conformance.test.js` — all seven catalog providers through the
  production adapter set.
- `test/background-adoption-conformance.test.js` — background provider-native
  adoption, bounded retry, next-command reporting.

If this fails, stop here. Nothing below will be interpretable.

---

## 5. Layer 2 — guided manual walkthrough (do this before the automated run)

The automated acceptance suite is unproven. Walking the same path by hand
first tells you whether a later failure is the product or the harness, and you
see the real output.

```sh
cd /opt/nominaconnect-test
mkdir -p /root/nomina-test && cd /root/nomina-test
```

### 5.1 Initialise

```sh
node /opt/nominaconnect-test/bin/nomina.js init \
  --node "$(hostname)" \
  --bridge vmbr0 \
  --storage local-lvm \
  --domain home.test \
  --dns technitium \
  --reverse-proxy caddy \
  --ca none \
  --vpn none
```

Check `cat nomina.yaml`.

Valid values: `--reverse-proxy caddy|traefik`, `--ca none|step-ca|caddy-internal-ca`
(`caddy-internal-ca` only with Caddy), `--vpn none|tailscale|netbird`.

### 5.2 DNS

```sh
node /opt/nominaconnect-test/bin/nomina.js service add technitium \
  --ip 192.168.1.53 --template debian-12-standard --gateway 192.168.1.1
```

You will be prompted for a **connection secret for Technitium**. A fresh
Technitium install uses the default credentials `admin` / `admin`, and
NominaConnect never changes the password — it authenticates with whatever you
store here. Enter `admin` unless you have already changed it in the Technitium
UI.

This takes a few minutes: it creates the LXC, installs Technitium from its
official installer, and waits for the API. Verify:

```sh
pct list
pct config <vmid> | grep -E 'hostname|net0|unprivileged'
curl -s "http://192.168.1.53:5380/api/user/login?user=admin&pass=admin"
```

`unprivileged: 1` is the important one (ADR-0030).

### 5.3 Reverse proxy

```sh
node /opt/nominaconnect-test/bin/nomina.js service add caddy \
  --ip 192.168.1.54 --template debian-12-standard --gateway 192.168.1.1
```

Verify Caddy's admin API is answering on the LAN — the adapter drives it over
`http://<ip>:2019`, so this must work from the host:

```sh
curl -s http://192.168.1.54:2019/config/ | head -c 200
```

For Traefik instead, the API is `http://<ip>:8080/api/overview`.

### 5.4 Seed unmanaged configuration

The whole premise is that NominaConnect does not touch what it did not create.
Put something in both providers by hand first:

```sh
TOKEN=$(curl -s "http://192.168.1.53:5380/api/user/login?user=admin&pass=admin" | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://192.168.1.53:5380/api/zones/records/add?domain=legacy.home.test&zone=home.test&type=A&ttl=3600&ipAddress=10.99.99.99"

curl -s -X POST http://192.168.1.54:2019/config/apps/http/servers/srv_https/routes \
  -H 'Content-Type: application/json' \
  -d '{"@id":"operator.home.test","match":[{"host":["operator.home.test"]}],"handle":[{"handler":"reverse_proxy","upstreams":[{"dial":"192.168.1.3:8080"}]}],"terminal":true}'
```

### 5.5 Publish an exposure

```sh
node /opt/nominaconnect-test/bin/nomina.js exposure publish \
  --name photos \
  --hostname photos.home.test \
  --backend-ip 192.168.1.3 \
  --backend-port 8080
```

Expect `published` and `healthy`. With `--ca none` the certificate is
untrusted — that is correct and by design (ADR-0015/0016): HTTPS with an
untrusted certificate, never an HTTP fallback.

Confirm both the managed and the unmanaged resources exist:

```sh
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://192.168.1.53:5380/api/zones/records/get?domain=home.test&zone=home.test&listZone=true" \
  | grep -o '"name":"[^"]*"'

curl -s http://192.168.1.54:2019/config/apps/http/servers/srv_https/routes | grep -o '"@id":"[^"]*"'
```

You should see `legacy.home.test` and `operator.home.test` still there
alongside `photos.home.test`.

End to end, from the workstation:

```sh
curl -k --resolve photos.home.test:443:192.168.1.54 https://photos.home.test/
dig @192.168.1.53 photos.home.test +short
```

### 5.6 Exercise #22 — provider-native adoption in background tracking

This is the new behaviour. Edit a managed resource **in the provider**, then
run any command and read the notices.

```sh
# Repoint the managed Caddy route by hand.
curl -s -X PATCH http://192.168.1.54:2019/id/photos.home.test/handle/0/upstreams/0/dial \
  -H 'Content-Type: application/json' -d '"192.168.1.3:9999"'

# Any command starts a background tracking pass; give it a moment, then read.
node /opt/nominaconnect-test/bin/nomina.js changes
sleep 15
node /opt/nominaconnect-test/bin/nomina.js changes
```

Expect a change notice saying the provider reference was adopted, and
`nomina.yaml`'s backend updated to match the provider (provider precedence,
ADR-0005). Confirm local state carries the new fingerprint:

```sh
cat .nomina/state.json | python3 -m json.tool | grep -A6 integrations
```

Then the refusal paths — both should produce a verification warning and leave
state untouched rather than guessing:

```sh
# Ambiguous: a second route for the same host.
curl -s -X POST http://192.168.1.54:2019/config/apps/http/servers/srv_https/routes \
  -H 'Content-Type: application/json' \
  -d '{"match":[{"host":["photos.home.test"]}],"handle":[{"handler":"reverse_proxy","upstreams":[{"dial":"192.168.1.3:8080"}]}],"terminal":true}'

# Missing: delete the managed record out from under it.
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://192.168.1.53:5380/api/zones/records/delete?domain=photos.home.test&zone=home.test&type=A&ipAddress=192.168.1.54"
```

### 5.7 Optional layers

**step-ca** (trusted certificates):

```sh
node /opt/nominaconnect-test/bin/nomina.js service add step-ca \
  --ip 192.168.1.56 --template debian-12-standard --gateway 192.168.1.1
node /opt/nominaconnect-test/bin/nomina.js ca guide
node /opt/nominaconnect-test/bin/nomina.js exposure publish \
  --name photos --hostname photos.home.test --backend-ip 192.168.1.3 --backend-port 8080
```

Requires `--ca step-ca` at init time.

**VPN** (needs a real credential and Proxmox ≥ 8.2 for `pct set --dev0`):

```sh
node /opt/nominaconnect-test/bin/nomina.js service add tailscale \
  --ip 192.168.1.57 --template debian-12-standard --gateway 192.168.1.1
```

Prompts for the tailnet auth key. Watch for two things: the LXC gets
`/dev/net/tun` granted and reboots automatically (ADR-0038), and the key never
appears in output, `nomina.yaml`, or state. Grep to be sure:

```sh
grep -r "tskey-" /root/nomina-test/ ; echo "exit=$? (1 = clean)"
```

### 5.8 Upgrade and teardown

```sh
node /opt/nominaconnect-test/bin/nomina.js service upgrade caddy
node /opt/nominaconnect-test/bin/nomina.js uninstall --yes
```

`uninstall` destroys only vmids recorded in this project's own state.

---

## 6. Layer 3 — automated acceptance suite

Once the manual pass works, run the automated one. It repeats the same path
and adds the assertions.

```sh
cd /opt/nominaconnect-test

export NOMINA_ACCEPTANCE=1
export NOMINA_ACCEPTANCE_DISPOSABLE=yes
export NOMINA_ACCEPTANCE_NODE="$(hostname)"
export NOMINA_ACCEPTANCE_STORAGE=local-lvm
export NOMINA_ACCEPTANCE_BRIDGE=vmbr0
export NOMINA_ACCEPTANCE_TEMPLATE=debian-12-standard
export NOMINA_ACCEPTANCE_GATEWAY=192.168.1.1
export NOMINA_ACCEPTANCE_DNS_IP=192.168.1.53
export NOMINA_ACCEPTANCE_PROXY_IP=192.168.1.54
export NOMINA_ACCEPTANCE_BACKEND=192.168.1.3:8080
export NOMINA_ACCEPTANCE_DOMAIN=acceptance.test
export NOMINA_ACCEPTANCE_DNS_PASSWORD=admin

node --test acceptance/live-proxmox.acceptance.mjs
```

Optional:

```sh
export NOMINA_ACCEPTANCE_PROXY=traefik      # default caddy
export NOMINA_ACCEPTANCE_CA=step-ca         # plus NOMINA_ACCEPTANCE_CA_IP
export NOMINA_ACCEPTANCE_CA_IP=192.168.1.56
export NOMINA_ACCEPTANCE_VPN=tailscale      # plus the two below
export NOMINA_ACCEPTANCE_VPN_IP=192.168.1.57
export NOMINA_ACCEPTANCE_VPN_KEY=tskey-auth-…
```

Run it once with Caddy and once with `NOMINA_ACCEPTANCE_PROXY=traefik` to
cover both reverse proxies. Free the IPs between runs — teardown destroys the
LXCs it created, but a failed run may leave them behind.

The suite refuses to start without `NOMINA_ACCEPTANCE=1`,
`NOMINA_ACCEPTANCE_DISPOSABLE=yes`, a root Proxmox shell, and every required
variable, and prints the reason instead of touching the host.

---

## 7. Failure triage

| Symptom | Most likely cause |
| --- | --- |
| LXC created but nothing reachable | Hypervisor is filtering LXC MACs — promiscuous mode (§2.1) |
| `Template … was not found` | Template not downloaded to a `vztmpl` storage (§2.3) |
| `Storage … is not active` | Wrong `--storage`; check `pvesm status` |
| `Requested IP … is already in use` | IP preflight working correctly — pick a free address |
| Technitium API login fails | Stored secret ≠ Technitium's actual admin password (§5.2) |
| Caddy install fine, config calls fail | Admin API not reachable on `:2019` from the host |
| VPN fails on the TUN device | Proxmox < 8.2 has no `pct set --dev0`; ADR-0038 prints the manual lines |
| Exposure `unhealthy` with a CA | ACME issuance still settling; publish already retries, but check `pct exec <vmid> -- journalctl -u caddy` |
| ~11 test failures, timeouts at 5000ms | You ran `bun test` instead of `node --test` (§1) |

Useful while debugging:

```sh
pct exec <vmid> -- systemctl status caddy
pct exec <vmid> -- journalctl -u caddy -n 50
pct exec <vmid> -- journalctl -u dns -n 50        # Technitium
```

---

## 8. What to feed back

The acceptance suite is the unproven part. Worth capturing on the first run:

- Which assertions failed because the suite is wrong versus the product.
- Whether the Technitium install completes inside the bounded retry budget on
  a VM-hosted Proxmox (it is slower than bare metal).
- Whether `caddy-internal-ca` and `step-ca` exposures actually come back
  trusted, since the CA paths have the least real-hardware exposure.
- Whether the background tracking pass in §5.6 adopts within one command cycle
  or needs a second invocation to surface notices.
