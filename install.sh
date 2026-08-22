#!/usr/bin/env bash
# NominaConnect installer/updater (Node.js version) — curl this into your Proxmox server
# For a native binary version (no Node.js required), use install-native.sh instead
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install.sh | bash              # latest release
#   curl -fsSL https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install.sh | bash -s v1.1.2    # specific version
#   curl -fsSL https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install.sh | bash -s dev       # dev branch (unstable)
#   curl -fsSL https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install.sh | FORCE=1 bash      # force reinstall
#
# Re-running the installer upgrades an existing installation in place.
set -euo pipefail

REPO="BunnyGamezsc/NominaConnect"
BRANCH="main"
INSTALL_DIR="${NOMINA_INSTALL_DIR:-/opt/nominaconnect}"
BIN_LINK="${NOMINA_BIN_LINK:-/usr/local/bin/nomina}"

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║       NominaConnect Installer         ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# --- Pre-flight checks ---
# Root is only required for the default system paths.
if [ "$(id -u)" -ne 0 ] && [ -z "${NOMINA_INSTALL_DIR:-}" ]; then
  echo "⚠  This installer needs root. Re-running with sudo..."
  exec sudo bash "$0" "$@"
fi

# Check for Node.js ≥ 22
if ! command -v node &>/dev/null; then
  echo "❌ Node.js is not installed."
  echo "   Install it first:  apt install -y nodejs npm"
  echo "   Or use NodeSource: curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs"
  exit 1
fi

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "❌ Node.js $NODE_MAJOR found, but NominaConnect requires Node.js ≥ 22."
  echo "   Upgrade: curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt install -y nodejs"
  exit 1
fi

echo "✔  Node.js $(node -v) detected"

# Check for git
if ! command -v git &>/dev/null; then
  echo "📦 Installing git..."
  apt-get update -qq && apt-get install -y -qq git
fi

# --- HTTP helper for the release API ---
http_get() {
  if command -v curl &>/dev/null; then curl -fsSL "$1"; else wget -qO- "$1"; fi
}

installed_version() {
  local pkg="$INSTALL_DIR/package.json"
  if [ -f "$pkg" ]; then
    node -p "JSON.parse(require('fs').readFileSync('$pkg', 'utf8')).version" 2>/dev/null || echo "unknown"
  else
    echo "none"
  fi
}

# --- Resolve target version ---
REQUESTED_VERSION="${1:-${NOMINA_VERSION:-}}"
REF=""
TARGET_VERSION=""
if [ "$REQUESTED_VERSION" = "dev" ]; then
  BRANCH="${NOMINA_DEV_BRANCH:-dev}"
  REF="$BRANCH"
  echo "🔬 Dev channel: tracking the '$BRANCH' branch (unstable)."
elif [ -n "$REQUESTED_VERSION" ] && [ "$REQUESTED_VERSION" != "latest" ]; then
  case "$REQUESTED_VERSION" in
    v*) TARGET_VERSION="$REQUESTED_VERSION" ;;
    *)  TARGET_VERSION="v$REQUESTED_VERSION" ;;
  esac
  REF="$TARGET_VERSION"
else
  echo "🔍 Checking for latest release..."
  LATEST="$(http_get "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/' || true)"
  if [ -n "$LATEST" ]; then
    TARGET_VERSION="$LATEST"
    REF="$LATEST"
  else
    echo "⚠  Could not determine latest release. Tracking '$BRANCH' branch."
    TARGET_VERSION=""
    REF="$BRANCH"
  fi
fi

# --- Detect current installation and decide action ---
CURRENT_RAW="$(installed_version)"
case "$CURRENT_RAW" in
  none)      CURRENT_VERSION="none" ;;
  unknown)   CURRENT_VERSION="unknown" ;;
  *)         CURRENT_VERSION="v$CURRENT_RAW" ;;
esac

case "$CURRENT_VERSION" in
  none)
    echo "📥 Installing NominaConnect ${TARGET_VERSION:-$REF}..."
    ;;
  "$TARGET_VERSION")
    if [ "${FORCE:-0}" != "1" ]; then
      echo "✔  NominaConnect $CURRENT_VERSION is already installed — up to date."
      echo "   Force reinstall:          ... | FORCE=1 bash"
      echo "   Install another version:  ... | bash -s v1.0.0"
      exit 0
    fi
    echo "🔄 Reinstalling NominaConnect $CURRENT_VERSION (forced)..."
    ;;
  unknown)
    echo "⬆  Existing installation detected (version unknown). Updating to ${TARGET_VERSION:-$REF}..."
    ;;
  *)
    echo "⬆  Upgrading NominaConnect $CURRENT_VERSION → ${TARGET_VERSION:-$REF}..."
    ;;
esac

# --- Clone or update ---
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "📥 Updating existing checkout to $REF..."
  if [ -n "$TARGET_VERSION" ]; then
    git -C "$INSTALL_DIR" fetch --depth 1 origin "refs/tags/$REF:refs/tags/$REF" --quiet
    git -C "$INSTALL_DIR" reset --hard "refs/tags/$REF" --quiet
  else
    git -C "$INSTALL_DIR" fetch origin "$BRANCH" --quiet
    git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH" --quiet
  fi
else
  echo "📥 Cloning NominaConnect ($REF)..."
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch "$REF" "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

# --- Install dependencies ---
echo "📦 Installing dependencies..."
cd "$INSTALL_DIR"

if ! command -v pnpm &>/dev/null; then
  echo "📦 Installing pnpm..."
  npm install -g pnpm@latest
fi
echo "✔  pnpm $(pnpm -v) detected"

pnpm install --frozen-lockfile --prod 2>/dev/null || pnpm install --prod

# --- Create symlink ---
chmod +x "$INSTALL_DIR/bin/nomina.js"
mkdir -p "$(dirname "$BIN_LINK")"
ln -sf "$INSTALL_DIR/bin/nomina.js" "$BIN_LINK"

INSTALLED="$(installed_version)"
ACTION="installed"
[ "$CURRENT_VERSION" != "none" ] && ACTION="upgraded"

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║  ✅ NominaConnect $ACTION!             ║"
echo "  ║                                       ║"
echo "  ║  Version: v$INSTALLED"
echo "  ║  Run:  nomina                         ║"
echo "  ║  Help: nomina --help                  ║"
echo "  ║  Path: $BIN_LINK              ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""
echo "  Get started: cd into your project dir and run 'nomina'"
echo ""
