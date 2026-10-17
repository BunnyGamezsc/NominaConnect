import { isPrivateIpv4 } from "./host-ssh-adapter.js";

export const PROXY_SSH_ADMIN_PORT = 22223;
const DIRECTORY = "/etc/nominaconnect/proxy-ssh";
const SERVICE = "/etc/systemd/system/ssh.service.d/nomina-host-ssh.conf";
const SOCKET = "/etc/systemd/system/ssh.socket.d/nomina-host-ssh.conf";
/** Quote a single shell argument in generated proxy administration scripts. */
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

/** Render owned service/socket drop-ins for the proxy's private administration port. */
function settings(ip) {
  return {
    service: `[Service]\nExecStart=\nExecStart=/usr/sbin/sshd -D -p ${PROXY_SSH_ADMIN_PORT} -o ListenAddress=${ip}\n`,
    socket: `[Socket]\nListenStream=\nListenStream=${ip}:${PROXY_SSH_ADMIN_PORT}\n`
  };
}

// Only the explicitly managed proxy is changed. Its original SSH configuration,
// keys, enabled state and authenticated sessions remain intact. Two owned
// drop-ins temporarily relocate its administrative listener to a private port.
/** Temporarily relocate stock proxy SSH administration while preserving operator settings. */
export function createProxySshAdapter({ exec }) {
  /** Execute a bounded script only against the explicitly managed private proxy LXC. */
  const run = (request, script) => {
    if (!Number.isInteger(request.vmid) || !isPrivateIpv4(request.ip)) throw new Error("Proxy SSH administration requires the managed private proxy LXC.");
    return exec(request.vmid, { binary: "/bin/bash", args: ["-c", `set -eu\n${script}`], timeoutMs: 30_000 });
  };
  /** Render ownership checks that reject unsafe files or unrelated systemd overrides. */
  function guard(request) {
    const expected = settings(request.ip);
    return `
for target in ${DIRECTORY} ${SERVICE} ${SOCKET}; do
  if [ -e "$target" ] || [ -L "$target" ]; then
    test ! -L "$target"
    test "$(stat -c %u "$target")" = 0
    test $(( $(stat -c %a "$target") % 100 / 10 & 2 )) = 0
    test $(( $(stat -c %a "$target") % 10 & 2 )) = 0
  fi
done
if [ -d ${DIRECTORY} ]; then
  test "$(cat ${DIRECTORY}/address)" = ${quote(request.ip)}
  for name in service-active socket-active; do
    case "$(cat ${DIRECTORY}/$name)" in active|inactive) ;; *) exit 1 ;; esac
  done
  [ ! -e ${SERVICE} ] || test "$(cat ${SERVICE})" = ${quote(expected.service.trimEnd())}
  [ ! -e ${SOCKET} ] || test "$(cat ${SOCKET})" = ${quote(expected.socket.trimEnd())}
else
  test ! -e ${SERVICE}
  test ! -e ${SOCKET}
fi
for dropin in $(systemctl show --property=DropInPaths --value ssh.service ssh.socket); do
  case "$dropin" in ${SERVICE}|${SOCKET}) test -d ${DIRECTORY} ;; *) echo 'Proxy SSH has operator overrides; refusing to replace them' >&2; exit 1 ;; esac
done
`;
  }
  /** Classify port 22 as clear, already managed or safely relocatable without mutations. */
  async function preflight(request) {
    const result = await run(request, `${guard(request)}
if [ -d ${DIRECTORY} ]; then echo managed; exit 0; fi
listeners=$(ss -H -ltnp 'sport = :22')
if [ -z "$listeners" ]; then echo clear; exit 0; fi
# A generic listener or custom administrative service is never taken over.
test -x /usr/sbin/sshd
systemctl cat ssh.service | grep -Fx 'ExecStart=/usr/sbin/sshd -D $SSHD_OPTS' >/dev/null
test "$(systemctl show --property=FragmentPath --value ssh.service)" = /lib/systemd/system/ssh.service || test "$(systemctl show --property=FragmentPath --value ssh.service)" = /usr/lib/systemd/system/ssh.service
for process in $(printf '%s\n' "$listeners" | grep -o '"[^"]*"'); do
  case "$process" in '"sshd"'|'"systemd"') ;; *) echo 'Port 22 belongs to an unmanaged process' >&2; exit 1 ;; esac
done
printf '%s\n' "$listeners" | grep 'users:' >/dev/null
if [ -f /etc/default/ssh ]; then
  test -z "$(sed -n 's/^[[:space:]]*SSHD_OPTS=//p' /etc/default/ssh | tr -d '\"\\047[:space:]')" || { echo 'Custom SSHD_OPTS must be preserved; proxy SSH cannot be relocated automatically' >&2; exit 1; }
fi
check_config() {
  awk -v main=/etc/ssh/sshd_config '
    { sub(/#.*/, ""); directive=tolower($1) }
    directive == "match" { exit 1 }
    directive == "include" && (FILENAME != main || NF != 2 || $2 != "/etc/ssh/sshd_config.d/*.conf") { exit 1 }
  ' "$1" || { echo 'Custom SSH Match or Include rules cannot be safely relocated automatically' >&2; exit 1; }
}
check_config /etc/ssh/sshd_config
for config in /etc/ssh/sshd_config.d/*.conf; do
  [ ! -f "$config" ] || check_config "$config"
done
test -z "$(ss -H -ltn 'sport = :${PROXY_SSH_ADMIN_PORT}')" || { echo 'Proxy SSH administration port ${PROXY_SSH_ADMIN_PORT} is occupied' >&2; exit 1; }
/usr/sbin/sshd -t -p ${PROXY_SSH_ADMIN_PORT} -o ListenAddress=${request.ip}
test "$(/usr/sbin/sshd -T -p ${PROXY_SSH_ADMIN_PORT} -o ListenAddress=${request.ip} | sed -n 's/^listenaddress //p')" = ${quote(`${request.ip}:${PROXY_SSH_ADMIN_PORT}`)}
echo relocate`);
    return String(result.stdout ?? "").trim();
  }
  /** Remove owned drop-ins and restore recorded service/socket activity after forwarding stops. */
  async function restore(request) {
    await run(request, `
if [ ! -d ${DIRECTORY} ]; then exit 0; fi
${guard(request)}
test -z "$(ss -H -ltn 'sport = :22')" || { echo 'Remove port 22 forwarding before restoring proxy SSH administration' >&2; exit 1; }
service_active=$(cat ${DIRECTORY}/service-active)
socket_active=$(cat ${DIRECTORY}/socket-active)
systemctl stop ssh.socket ssh.service
rm -f ${SERVICE} ${SOCKET}
systemctl daemon-reload
if [ "$socket_active" = active ]; then systemctl start ssh.socket; fi
if [ "$service_active" = active ]; then systemctl start ssh.service; fi
rm -f ${DIRECTORY}/address ${DIRECTORY}/service-active ${DIRECTORY}/socket-active
rmdir ${DIRECTORY}
rmdir /etc/systemd/system/ssh.service.d /etc/systemd/system/ssh.socket.d 2>/dev/null || true`);
  }
  return Object.freeze({
    preflight,
    /** Relocate stock administration and restore it if preparation fails. */
    async prepare(request) {
      const state = await preflight(request);
      if (state === "clear") return false;
      const expected = settings(request.ip);
      try {
        await run(request, `${guard(request)}
if [ ! -d ${DIRECTORY} ]; then
  install -d -m 0700 ${DIRECTORY}
  printf '%s\n' ${quote(request.ip)} > ${DIRECTORY}/address
  for name in service socket; do
    if systemctl is-active --quiet ssh.$name; then echo active; else echo inactive; fi > ${DIRECTORY}/$name-active
  done
  chmod 0600 ${DIRECTORY}/*
fi
systemctl stop ssh.socket ssh.service
install -d -m 0755 /etc/systemd/system/ssh.service.d /etc/systemd/system/ssh.socket.d
printf '%s' ${quote(expected.service)} > ${SERVICE}.tmp
chmod 0644 ${SERVICE}.tmp
mv ${SERVICE}.tmp ${SERVICE}
printf '%s' ${quote(expected.socket)} > ${SOCKET}.tmp
chmod 0644 ${SOCKET}.tmp
mv ${SOCKET}.tmp ${SOCKET}
systemctl daemon-reload
if [ "$(cat ${DIRECTORY}/socket-active)" = active ]; then systemctl start ssh.socket; fi
if [ "$(cat ${DIRECTORY}/service-active)" = active ]; then systemctl start ssh.service; fi
test -z "$(ss -H -ltn 'sport = :22')"
ss -H -ltn 'sport = :${PROXY_SSH_ADMIN_PORT}' | grep -F ${quote(`${request.ip}:${PROXY_SSH_ADMIN_PORT}`)} >/dev/null`);
        return state !== "managed";
      } catch (error) {
        try { await restore(request); }
        catch (cleanup) { throw new Error(`${error.message}; proxy SSH recovery retained at ${DIRECTORY}: ${cleanup.message}`); }
        throw error;
      }
    },
    restore
  });
}
