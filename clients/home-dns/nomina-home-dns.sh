#!/bin/sh
# Optional desktop client helper. It changes only this device's Tailscale DNS preference.
set -eu

PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export PATH
OS="$(uname -s)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/nominaconnect"
CONFIG="$CONFIG_DIR/home-dns.conf"
INSTALLED="$HOME/.local/bin/nomina-home-dns"
LABEL="com.nominaconnect.home-dns"

die() {
  printf 'Nomina home DNS: %s\n' "$*" >&2
  exit 1
}

tailscale_cli() {
  if command -v tailscale >/dev/null 2>&1; then
    command -v tailscale
  elif [ "$OS" = Darwin ] && [ -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ]; then
    printf '%s\n' /Applications/Tailscale.app/Contents/MacOS/Tailscale
  else
    die "Install the Tailscale CLI before setting up this addon."
  fi
}

valid_ip() {
  printf '%s\n' "$1" | awk -F. 'NF != 4 { exit 1 } { for (i=1; i<=4; i++) if ($i !~ /^[0-9]+$/ || $i > 255 || $i < 0) exit 1 }'
}

valid_host() {
  printf '%s\n' "$1" | LC_ALL=C grep -Eq '^([A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$'
}

router_identity() {
  if [ "$OS" = Darwin ]; then
    ROUTE="$(route -n get default 2>/dev/null)" || return 1
    ROUTER_IP="$(printf '%s\n' "$ROUTE" | awk '/^[[:space:]]*gateway:/{print $2; exit}')"
    ROUTER_INTERFACE="$(printf '%s\n' "$ROUTE" | awk '/^[[:space:]]*interface:/{print $2; exit}')"
    [ -n "$ROUTER_IP" ] && [ -n "$ROUTER_INTERFACE" ] || return 1
    ping -c 1 -W 1000 "$ROUTER_IP" >/dev/null 2>&1 || true
    ROUTER_MAC="$(arp -n "$ROUTER_IP" 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i=="at") {print $(i+1); exit}}')"
  elif [ "$OS" = Linux ]; then
    ROUTE="$(ip -4 route show default 2>/dev/null | awk 'NR==1 {print; exit}')" || return 1
    ROUTER_IP="$(printf '%s\n' "$ROUTE" | awk '{for (i=1; i<=NF; i++) if ($i=="via") {print $(i+1); exit}}')"
    ROUTER_INTERFACE="$(printf '%s\n' "$ROUTE" | awk '{for (i=1; i<=NF; i++) if ($i=="dev") {print $(i+1); exit}}')"
    [ -n "$ROUTER_IP" ] && [ -n "$ROUTER_INTERFACE" ] || return 1
    ping -c 1 -W 1 "$ROUTER_IP" >/dev/null 2>&1 || true
    ROUTER_MAC="$(ip -4 neigh show to "$ROUTER_IP" dev "$ROUTER_INTERFACE" 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i=="lladdr") {print $(i+1); exit}}')"
  else
    die "This addon supports macOS and Linux desktops."
  fi
  ROUTER_MAC="$(printf '%s' "$ROUTER_MAC" | tr '[:upper:]' '[:lower:]')"
  valid_ip "$ROUTER_IP" && printf '%s\n' "$ROUTER_MAC" | grep -Eq '^([[:xdigit:]]{1,2}:){5}[[:xdigit:]]{1,2}$'
}

dns_answer() {
  dig +short +time=2 +tries=1 @"$1" "$2" A 2>/dev/null |
    awk -F. 'NF == 4 { good=1; for (i=1; i<=4; i++) if ($i !~ /^[0-9]+$/ || $i > 255) good=0; if (good) print }'
}

read_config() {
  [ -f "$CONFIG" ] || die "Run setup on your home network first."
  {
    IFS= read -r HOME_DNS
    IFS= read -r PROBE_HOST
    IFS= read -r EXPECTED_IP
    IFS= read -r HOME_ROUTER_IP
    IFS= read -r HOME_ROUTER_MAC
  } < "$CONFIG"
  valid_ip "$HOME_DNS" && valid_ip "$EXPECTED_IP" &&
    valid_ip "$HOME_ROUTER_IP" && valid_host "$PROBE_HOST" ||
    die "The saved home DNS configuration is invalid."
}

home_matches() {
  router_identity || return 1
  [ "$ROUTER_IP" = "$HOME_ROUTER_IP" ] &&
    [ "$ROUTER_MAC" = "$HOME_ROUTER_MAC" ] &&
    dns_answer "$HOME_DNS" "$PROBE_HOST" | grep -Fx "$EXPECTED_IP" >/dev/null
}

system_answer_matches() {
  if [ "$OS" = Darwin ]; then
    dscacheutil -q host -a name "$PROBE_HOST" 2>/dev/null |
      awk '/^[[:space:]]*ip_address:/{print $2}' | grep -Fx "$EXPECTED_IP" >/dev/null
  else
    getent ahostsv4 "$PROBE_HOST" 2>/dev/null |
      awk '{print $1}' | grep -Fx "$EXPECTED_IP" >/dev/null
  fi
}

ask_value() {
  PROMPT="$1"
  DEFAULT_VALUE="${2:-}"
  ESCAPED_PROMPT="$(printf '%s' "$PROMPT" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  ESCAPED_DEFAULT="$(printf '%s' "$DEFAULT_VALUE" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  if [ "$OS" = Darwin ] && command -v osascript >/dev/null 2>&1; then
    ANSWER="$(osascript -e "text returned of (display dialog \"$ESCAPED_PROMPT\" default answer \"$ESCAPED_DEFAULT\")" 2>/dev/null)" || return 1
    printf '%s\n' "${ANSWER:-$DEFAULT_VALUE}"
  elif command -v zenity >/dev/null 2>&1; then
    zenity --entry --title="Nomina home DNS" --text="$PROMPT" --entry-text="$DEFAULT_VALUE"
  else
    [ -t 0 ] || die "Pass the home DNS IP and managed hostname as setup arguments."
    if [ -n "$DEFAULT_VALUE" ]; then
      printf '%s [%s]: ' "$PROMPT" "$DEFAULT_VALUE" >&2
    else
      printf '%s: ' "$PROMPT" >&2
    fi
    IFS= read -r ANSWER
    printf '%s\n' "${ANSWER:-$DEFAULT_VALUE}"
  fi
}

setup() {
  [ "$OS" = Darwin ] || [ "$OS" = Linux ] || die "This addon supports macOS and Linux desktops."
  command -v dig >/dev/null 2>&1 || die "Install dig before setup (dnsutils on Debian/Ubuntu)."
  TAILSCALE="$(tailscale_cli)"
  HOME_DNS="${1:-}"
  PROBE_HOST="${2:-}"
  if [ -z "$HOME_DNS" ]; then
    DEFAULT_HOME_DNS="$(sed -n '1p' "$CONFIG" 2>/dev/null || true)"
    HOME_DNS="$(ask_value "Technitium LAN IPv4 address" "$DEFAULT_HOME_DNS")"
  fi
  if [ -z "$PROBE_HOST" ]; then
    DEFAULT_PROBE_HOST="$(sed -n '2p' "$CONFIG" 2>/dev/null || true)"
    PROBE_HOST="$(ask_value "A managed hostname, such as stats.bunny.internal" "$DEFAULT_PROBE_HOST")"
  fi
  valid_ip "$HOME_DNS" || die "Enter a valid Technitium IPv4 address."
  valid_host "$PROBE_HOST" || die "Enter a valid managed hostname."
  router_identity || die "The home router and its MAC address could not be identified."
  EXPECTED_IP="$(dns_answer "$HOME_DNS" "$PROBE_HOST" | awk 'NR==1 {print; exit}')"
  valid_ip "$EXPECTED_IP" || die "Technitium did not return an A record for $PROBE_HOST."
  TAILSCALE_BE_CLI=1 "$TAILSCALE" set --accept-dns=true ||
    die "Tailscale denied the DNS setting. On Linux, grant your user operator access first."

  umask 077
  mkdir -p "$CONFIG_DIR" "$HOME/.local/bin"
  printf '%s\n%s\n%s\n%s\n%s\n' "$HOME_DNS" "$PROBE_HOST" "$EXPECTED_IP" "$ROUTER_IP" "$ROUTER_MAC" > "$CONFIG"
  cp "$0" "$INSTALLED"
  chmod 0700 "$INSTALLED"
  if [ "$OS" = Darwin ]; then
    install_macos
  else
    install_linux
  fi
  printf 'Home DNS addon installed. Router %s (%s); %s resolves locally to %s.\n' \
    "$ROUTER_IP" "$ROUTER_MAC" "$PROBE_HOST" "$EXPECTED_IP"
}

install_macos() {
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  XML_PATH="$(printf '%s' "$INSTALLED" | sed -e 's/\&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$LABEL</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>$XML_PATH</string><string>tick</string></array>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>30</integer>
<key>StandardErrorPath</key><string>$HOME/Library/Logs/NominaHomeDNS.log</string>
</dict></plist>
EOF
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
}

install_linux() {
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/nomina-home-dns.service" <<EOF
[Unit]
Description=NominaConnect home DNS preference
[Service]
Type=oneshot
ExecStart=/bin/sh "$INSTALLED" tick
EOF
  cat > "$UNIT_DIR/nomina-home-dns.timer" <<EOF
[Unit]
Description=Check NominaConnect home network
[Timer]
OnStartupSec=15s
OnUnitActiveSec=30s
Unit=nomina-home-dns.service
[Install]
WantedBy=timers.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now nomina-home-dns.timer
  systemctl --user start nomina-home-dns.service
}

tick() {
  read_config
  TAILSCALE="$(tailscale_cli)"
  if home_matches; then
    TAILSCALE_BE_CLI=1 "$TAILSCALE" set --accept-dns=false
    # A router can answer the direct probe while handing clients another DNS
    # server. Restore tailnet DNS if the system resolver lacks the LAN record.
    sleep 2
    if ! system_answer_matches; then
      TAILSCALE_BE_CLI=1 "$TAILSCALE" set --accept-dns=true
      die "Local DNS does not resolve $PROBE_HOST to $EXPECTED_IP."
    fi
  else
    TAILSCALE_BE_CLI=1 "$TAILSCALE" set --accept-dns=true
  fi
}

status() {
  read_config
  if home_matches; then
    printf 'Home network verified. The next check will use local DNS.\n'
  else
    printf 'Home network not verified. The next check will use Tailscale DNS.\n'
  fi
}

ui() {
  if [ "$OS" = Darwin ] && command -v osascript >/dev/null 2>&1; then
    ACTION="$(osascript -e 'choose from list {"Install or edit home DNS", "Show status", "Uninstall"} with title "NominaConnect" with prompt "Home network DNS helper" default items {"Show status"}' 2>/dev/null)" ||
      return 0
    case "$ACTION" in
      "Install or edit home DNS") setup "" "" ;;
      "Show status") status ;;
      "Uninstall") uninstall ;;
      *) return 0 ;;
    esac
    osascript -e 'display notification "Action finished. See Terminal for details." with title "NominaConnect"' 2>/dev/null || true
  elif command -v zenity >/dev/null 2>&1; then
    ACTION="$(zenity --list --title="NominaConnect" --text="Home network DNS helper" --column="Action" "Install or edit home DNS" "Show status" "Uninstall")" ||
      return 0
    case "$ACTION" in
      "Install or edit home DNS") setup "" "" ;;
      "Show status") status ;;
      "Uninstall") uninstall ;;
      *) return 0 ;;
    esac
  else
    die "Install zenity for the Linux menu, or run setup, status, or uninstall in a terminal."
  fi
}

uninstall() {
  if [ "$OS" = Darwin ]; then
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
    rm -f "$PLIST"
  elif [ "$OS" = Linux ]; then
    systemctl --user disable --now nomina-home-dns.timer >/dev/null 2>&1 || true
    rm -f "$HOME/.config/systemd/user/nomina-home-dns.service" "$HOME/.config/systemd/user/nomina-home-dns.timer"
    systemctl --user daemon-reload
  fi
  TAILSCALE="$(tailscale_cli)"
  TAILSCALE_BE_CLI=1 "$TAILSCALE" set --accept-dns=true
  rm -f "$CONFIG" "$INSTALLED"
  printf 'Home DNS addon removed; Tailscale DNS is enabled.\n'
}

case "${1:-}" in
  setup) shift; setup "${1:-}" "${2:-}" ;;
  tick) tick ;;
  status) status ;;
  uninstall) uninstall ;;
  ui) ui ;;
  *) die "Use: $0 ui | setup [technitium-ip managed-hostname] | status | uninstall" ;;
esac
