import { isIP, createConnection } from "node:net";

// These ports belong to platform services or gateway administration. SSH is
// deliberately deferred until it has its own administration-preserving policy.
const RESERVED_PORTS = new Set([22, 53, 80, 443, 2019, 5380, 8080, 9000]);
const DIRECTORY = "/etc/nominaconnect/tcp";
const TAILNET_DIRECTORY = "/etc/nominaconnect/tcp-tailnet";
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const unit = (port) => `nomina-tcp-${port}`;

export function validateTcpEndpoint({ ip, backendIp, backendPort, listenerPort, hostname }) {
  if (isIP(ip) !== 4 || isIP(backendIp) !== 4) {
    throw new Error("TCP exposures require recorded IPv4 listener and backend addresses.");
  }
  if (!/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/i.test(hostname)) throw new Error("Invalid TCP hostname.");
  for (const port of [backendPort, listenerPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("TCP ports must be between 1 and 65535.");
  }
  if (RESERVED_PORTS.has(listenerPort)) throw new Error(`TCP listener port ${listenerPort} is reserved for platform services or gateway administration.`);
  if (backendIp === ip && backendPort === listenerPort) throw new Error("TCP backend cannot point back at its own listener.");
}

export function tcpUnits(record) {
  const name = unit(record.listenerPort);
  return {
    socket: `[Unit]\nDescription=TCP forwarding for ${record.hostname}\n\n[Socket]\nListenStream=${record.ip}:${record.listenerPort}\nNoDelay=true\nFreeBind=true\n\n[Install]\nWantedBy=sockets.target\n`,
    service: `[Unit]\nDescription=TCP forwarding for ${record.hostname}\nRequires=${name}.socket\nAfter=${name}.socket\n\n[Service]\nExecStart=/lib/systemd/systemd-socket-proxyd ${record.backendIp}:${record.backendPort}\nRestart=on-failure\nNoNewPrivileges=yes\n`
  };
}

export function probeTcp(ip, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: ip, port: Number(port) });
    const finish = (reachable) => { socket.destroy(); resolve(reachable); };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("connect", () => finish(true));
  });
}

// Each port file is an explicitly managed gateway resource. The boot firewall
// calls this script after rebuilding the web/DNS chains, so TCP survives both
// LXC reboot and Tailscale reconfiguration without widening the web allowlist.
export function tcpTailnetScript(gatewayIp) {
  if (isIP(gatewayIp) !== 4) throw new Error("A gateway IPv4 address is required.");
  return `#!/bin/sh
set -eu
rules=$(mktemp)
trap 'rm -f "$rules"' EXIT
{
echo '*raw'
echo ':NOMINA_TCP_INGRESS - [0:0]'
for file in ${TAILNET_DIRECTORY}/*; do
  [ -f "$file" ] || continue
  port=\${file##*/}; target=$(cat "$file")
  echo "-A NOMINA_TCP_INGRESS -d ${gatewayIp} -p tcp --dport $port -j ACCEPT"
done
echo '-A NOMINA_TCP_INGRESS -j RETURN'
echo 'COMMIT'
echo '*filter'
echo ':NOMINA_TCP_FORWARD - [0:0]'
for file in ${TAILNET_DIRECTORY}/*; do
  [ -f "$file" ] || continue
  port=\${file##*/}; target=$(cat "$file")
  echo "-A NOMINA_TCP_FORWARD -d $target -p tcp --dport $port -j ACCEPT"
done
echo 'COMMIT'
echo '*nat'
echo ':NOMINA_TCP_DNAT - [0:0]'
echo ':NOMINA_TCP_SNAT - [0:0]'
for file in ${TAILNET_DIRECTORY}/*; do
  [ -f "$file" ] || continue
  port=\${file##*/}; target=$(cat "$file")
  echo "-A NOMINA_TCP_DNAT -d ${gatewayIp} -p tcp --dport $port -j DNAT --to-destination $target:$port"
  echo "-A NOMINA_TCP_SNAT -d $target -p tcp --dport $port -m conntrack --ctstate DNAT --ctorigdst ${gatewayIp} --ctorigdstport $port -j MASQUERADE"
done
echo 'COMMIT'
} > "$rules"
iptables-restore --noflush < "$rules"
iptables -t raw -D PREROUTING -i tailscale0 -j NOMINA_TCP_INGRESS 2>/dev/null || true
iptables -t raw -I PREROUTING 1 -i tailscale0 -j NOMINA_TCP_INGRESS
iptables -C FORWARD -i tailscale0 -j NOMINA_TCP_FORWARD 2>/dev/null || iptables -I FORWARD 1 -i tailscale0 -j NOMINA_TCP_FORWARD
iptables -t nat -C PREROUTING -i tailscale0 -j NOMINA_TCP_DNAT 2>/dev/null || iptables -t nat -I PREROUTING 1 -i tailscale0 -j NOMINA_TCP_DNAT
iptables -t nat -C POSTROUTING -j NOMINA_TCP_SNAT 2>/dev/null || iptables -t nat -I POSTROUTING 1 -j NOMINA_TCP_SNAT
`;
}

export function createTcpAdapter({ exec, probe = probeTcp }) {
  const run = (vmid, script) => exec(vmid, { binary: "/bin/bash", args: ["-c", script], timeoutMs: 30_000 });
  async function records(vmid) {
    const result = await run(vmid, `for file in ${DIRECTORY}/*.json; do [ ! -f "$file" ] || cat "$file"; done`);
    return String(result?.stdout ?? "").trim().split("\n").filter(Boolean).map((line) => {
      const record = JSON.parse(line);
      validateTcpEndpoint(record);
      return record;
    });
  }
  async function checkOwnership(request, record) {
    const name = unit(record.listenerPort);
    const actual = await run(request.vmid, `cat /etc/systemd/system/${name}.socket /etc/systemd/system/${name}.service`);
    const backend = String(actual?.stdout ?? "").match(/^ExecStart=\/lib\/systemd\/systemd-socket-proxyd ([\d.]+):(\d+)$/m);
    if (!backend) throw new Error(`TCP unit ${name} cannot be safely replaced or removed.`);
    const expected = tcpUnits({ ...record, backendIp: backend[1], backendPort: Number(backend[2]) });
    // Permit a native backend edit, but preserve unsupported unit directives
    // and drop-ins instead of silently replacing them.
    await run(request.vmid, `set -eu
test -z "$(systemctl show --property=DropInPaths --value ${name}.socket ${name}.service)"
test "$(cat /etc/systemd/system/${name}.socket)" = ${quote(expected.socket.trimEnd())}
test "$(cat /etc/systemd/system/${name}.service)" = ${quote(expected.service.trimEnd())}`);
  }
  async function gatewayAddress(request) {
    if (!request.gatewayVmid) return;
    if (!request.gatewayIp) {
      const result = await exec(request.gatewayVmid, { binary: "/usr/bin/tailscale", args: ["ip", "-4"], timeoutMs: 30_000 });
      request.gatewayIp = String(result?.stdout ?? "").trim();
    }
    const octets = request.gatewayIp.split(".").map(Number);
    if (isIP(request.gatewayIp) !== 4 || octets[0] !== 100 || octets[1] < 64 || octets[1] > 127) {
      throw new Error("Tailscale did not report a usable IPv4 gateway address.");
    }
  }
  async function gateway(request, remove = false) {
    await gatewayAddress(request);
    if (!request.gatewayVmid || !request.gatewayIp) return;
    const script = tcpTailnetScript(request.gatewayIp);
    await run(request.gatewayVmid, `set -eu
test -x /usr/local/sbin/nomina-tailnet-firewall
install -m 0700 -d ${TAILNET_DIRECTORY}
${remove || !request.tailnet ? `rm -f ${TAILNET_DIRECTORY}/${request.listenerPort}` : `printf '%s\\n' ${quote(request.ip)} > ${TAILNET_DIRECTORY}/${request.listenerPort}`}
cat > /usr/local/sbin/nomina-tailnet-tcp <<'NOMINA_TCP_FIREWALL'
${script}NOMINA_TCP_FIREWALL
chmod 0700 /usr/local/sbin/nomina-tailnet-tcp
grep -q /usr/local/sbin/nomina-tailnet-tcp /usr/local/sbin/nomina-tailnet-firewall || printf '%s\\n' '[ ! -x /usr/local/sbin/nomina-tailnet-tcp ] || /usr/local/sbin/nomina-tailnet-tcp' >> /usr/local/sbin/nomina-tailnet-firewall
/usr/local/sbin/nomina-tailnet-tcp`);
  }
  return Object.freeze({
    async preflight(request) {
      validateTcpEndpoint(request);
      if (!Number.isInteger(request.vmid)) throw new Error("TCP forwarding requires the managed proxy LXC.");
      const current = await records(request.vmid);
      const owned = current.find((record) => record.listenerPort === request.listenerPort);
      if (owned && owned.hostname !== request.hostname) throw new Error(`TCP listener ${request.ip}:${request.listenerPort} is already owned by ${owned.hostname}.`);
      if (owned) await checkOwnership(request, owned);
      const name = unit(request.listenerPort);
      const result = await run(request.vmid, `set -eu
test -x /lib/systemd/systemd-socket-proxyd || { echo 'Debian systemd-socket-proxyd is required in the proxy LXC' >&2; exit 1; }
command -v ss >/dev/null || { echo 'iproute2 (ss) is required in the proxy LXC' >&2; exit 1; }
${owned ? "" : `test ! -e /etc/systemd/system/${name}.socket\ntest ! -e /etc/systemd/system/${name}.service`}
ss -H -ltn 'sport = :${request.listenerPort}'
${owned ? `systemctl is-active --quiet ${name}.socket || test -z "$(ss -H -ltn 'sport = :${request.listenerPort}')"` : ""}`);
      if (!owned && String(result?.stdout ?? "").trim()) throw new Error(`TCP listener port ${request.listenerPort} conflicts with an existing listener.`);
      if (request.gatewayVmid) {
        await gatewayAddress(request);
        if (isIP(request.gatewayIp) !== 4) throw new Error("The Tailscale gateway IP is missing.");
        await run(request.gatewayVmid, `set -eu
if [ -e ${TAILNET_DIRECTORY}/${request.listenerPort} ]; then
  ${owned ? `test "$(cat ${TAILNET_DIRECTORY}/${request.listenerPort})" = ${quote(request.ip)}` : `echo 'Gateway forwarding port is already occupied' >&2; exit 1`}
fi`.replaceAll("\n+", "\n"));
        const listeners = await run(request.gatewayVmid, `set -eu\nss -H -ltn 'sport = :${request.listenerPort}'\ntest -x /usr/local/sbin/nomina-tailnet-firewall`);
        if (String(listeners?.stdout ?? "").trim()) throw new Error(`Gateway port ${request.listenerPort} conflicts with an existing listener.`);
        const nat = await run(request.gatewayVmid, "iptables-save -t nat");
        for (const line of String(nat?.stdout ?? "").split("\n")) {
          if (!/ -j (DNAT|REDIRECT)\b/.test(line) || line.startsWith("-A NOMINA_TCP_")) continue;
          const ports = line.match(/--dports? ([\d,:]+)/)?.[1];
          if (!ports || ports.split(",").some((part) => {
            const [start, end = start] = part.split(":").map(Number);
            return request.listenerPort >= start && request.listenerPort <= end;
          })) throw new Error(`Gateway port ${request.listenerPort} conflicts with unmanaged forwarding.`);
        }
      }
    },
    async publish(request) {
      const record = Object.fromEntries(["hostname", "ip", "listenerPort", "backendIp", "backendPort", "tailnet"].map((key) => [key, request[key]]));
      const name = unit(record.listenerPort);
      const units = tcpUnits(record);
      // Close remote access before changing the backend or opting out.
      await gateway(request, true);
      await run(request.vmid, `set -eu
install -m 0700 -d ${DIRECTORY}
cat > /etc/systemd/system/${name}.socket <<'NOMINA_SOCKET'
${units.socket}NOMINA_SOCKET
cat > /etc/systemd/system/${name}.service <<'NOMINA_SERVICE'
${units.service}NOMINA_SERVICE
systemctl daemon-reload
systemctl stop ${name}.service
systemctl enable ${name}.socket
systemctl restart ${name}.socket
printf '%s\\n' ${quote(JSON.stringify(record))} > ${DIRECTORY}/${record.listenerPort}.json
systemctl is-active --quiet ${name}.socket`);
      await gateway(request);
      return { locator: { ip: request.ip, port: request.listenerPort }, warnings: [] };
    },
    async remove(request) {
      validateTcpEndpoint(request);
      const current = await records(request.vmid);
      const record = current.find((item) => item.hostname === request.hostname && item.listenerPort === request.listenerPort);
      if (!record) throw new Error(`TCP forwarding for ${request.hostname} is missing; refusing unscoped removal.`);
      await checkOwnership(request, record);
      await gateway(request, true);
      const name = unit(record.listenerPort);
      await run(request.vmid, `set -eu
systemctl disable --now ${name}.socket
systemctl stop ${name}.service
rm -f /etc/systemd/system/${name}.socket /etc/systemd/system/${name}.service ${DIRECTORY}/${record.listenerPort}.json
systemctl daemon-reload`);
    },
    async inspect(request) {
      await gatewayAddress(request);
      const resources = [];
      for (const record of await records(request.vmid)) {
        const name = unit(record.listenerPort);
        const result = await run(request.vmid, `set -eu\ncat /etc/systemd/system/${name}.socket /etc/systemd/system/${name}.service`);
        const content = String(result?.stdout ?? "");
        const listener = content.match(/^ListenStream=([\d.]+):(\d+)$/m);
        const backend = content.match(/^ExecStart=\/lib\/systemd\/systemd-socket-proxyd ([\d.]+):(\d+)$/m);
        if (!listener || !backend || Number(listener[2]) !== record.listenerPort) throw new Error(`Cannot inspect TCP unit ${name}.`);
        await checkOwnership(request, record);
        let tailnet = request.tailnet;
        if (request.gatewayVmid) {
          const remote = await run(request.gatewayVmid, `if [ -f ${TAILNET_DIRECTORY}/${record.listenerPort} ]; then cat ${TAILNET_DIRECTORY}/${record.listenerPort}; fi`);
          const destination = String(remote?.stdout ?? "").trim();
          if (destination && destination !== listener[1]) throw new Error("TCP gateway target differs from the managed listener.");
          tailnet = destination === listener[1];
        }
        resources.push({ ...record, tailnet, ip: listener[1], backendIp: backend[1], backendPort: Number(backend[2]), id: record.hostname, locator: { ip: listener[1], port: Number(listener[2]) } });
      }
      return { resources };
    },
    async healthCheckExposure(request) {
      try {
        validateTcpEndpoint(request);
        await gatewayAddress(request);
        const name = unit(request.listenerPort);
        await run(request.vmid, `systemctl is-enabled --quiet ${name}.socket && systemctl is-active --quiet ${name}.socket`);
        await run(request.vmid, `systemctl show --property=ExecStart --value ${name}.service | grep -F ${quote(`systemd-socket-proxyd ${request.backendIp}:${request.backendPort}`)}`);
        try {
          await run(request.vmid, `timeout 3 /bin/bash -c 'exec 3<>/dev/tcp/${request.backendIp}/${request.backendPort}'`);
        } catch {
          return { status: "unhealthy", tcp: "unreachable", reason: "TCP backend is unreachable from the proxy LXC." };
        }
        const listener = await probe(request.ip, request.listenerPort);
        if (!listener) return { status: "unhealthy", tcp: "unreachable", reason: "TCP listener is unreachable." };
        await run(request.vmid, `for attempt in 1 2 3; do systemctl is-active --quiet ${name}.service && exit 0; sleep 1; done; exit 1`);
        if (request.gatewayVmid) {
          // Verify the persisted port and live rules, including opt-out, rather
          // than treating a saved declaration as proof of remote protection.
          await run(request.gatewayVmid, `iptables -t raw -C PREROUTING -i tailscale0 -j NOMINA_TAILNET_INGRESS && iptables -t raw -C NOMINA_TAILNET_INGRESS -j DROP && iptables -t raw -C PREROUTING -i tailscale0 -j NOMINA_TCP_INGRESS && iptables -C FORWARD -i tailscale0 -j NOMINA_TCP_FORWARD && iptables -t nat -C PREROUTING -i tailscale0 -j NOMINA_TCP_DNAT && iptables -t nat -C POSTROUTING -j NOMINA_TCP_SNAT`);
          await run(request.gatewayVmid, request.tailnet
            ? `test "$(cat ${TAILNET_DIRECTORY}/${request.listenerPort})" = ${quote(request.ip)} && iptables -t raw -C NOMINA_TCP_INGRESS -d ${request.gatewayIp} -p tcp --dport ${request.listenerPort} -j ACCEPT && iptables -t nat -C NOMINA_TCP_DNAT -d ${request.gatewayIp} -p tcp --dport ${request.listenerPort} -j DNAT --to-destination ${request.ip}:${request.listenerPort} && iptables -C NOMINA_TCP_FORWARD -d ${request.ip} -p tcp --dport ${request.listenerPort} -j ACCEPT && iptables -t nat -C NOMINA_TCP_SNAT -d ${request.ip} -p tcp --dport ${request.listenerPort} -m conntrack --ctstate DNAT --ctorigdst ${request.gatewayIp} --ctorigdstport ${request.listenerPort} -j MASQUERADE`
            : `test ! -e ${TAILNET_DIRECTORY}/${request.listenerPort} && ! iptables -t raw -C NOMINA_TCP_INGRESS -d ${request.gatewayIp} -p tcp --dport ${request.listenerPort} -j ACCEPT`);
        }
        return { status: "healthy", tcp: "reachable", backend: "reachable", listener: "reachable", tailnet: request.gatewayVmid ? "configuration-verified" : "not-configured", application: "not-verified" };
      } catch (error) {
        return { status: "unhealthy", tcp: "unreachable", reason: `TCP forwarding could not be verified: ${error.message}` };
      }
    }
  });
}
