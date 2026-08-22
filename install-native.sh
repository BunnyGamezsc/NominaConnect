#!/usr/bin/env bash
# NominaConnect native installer/updater — curl this into your Proxmox server
# This version downloads pre-compiled binaries, no Node.js required
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install-native.sh | bash              # latest release
#   curl -fsSL https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install-native.sh | bash -s v1.1.2    # specific version
#   curl -fsSL https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install-native.sh | bash -s dev       # dev channel (latest pre-release binary, no Node.js)
#   curl -fsSL https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install-native.sh | FORCE=1 bash      # force reinstall
#
# Re-running the installer upgrades an existing installation in place.
# The previous binary is kept at $INSTALL_DIR/nomina.bak for manual rollback.
set -euo pipefail

REPO="BunnyGamezsc/NominaConnect"
BRANCH="main"
INSTALL_DIR="${NOMINA_INSTALL_DIR:-/opt/nominaconnect}"
BIN_LINK="${NOMINA_BIN_LINK:-/usr/local/bin/nomina}"
VERSION_FILE="$INSTALL_DIR/VERSION"

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║   NominaConnect Native Installer       ║"
echo "  ║     (No Node.js required)             ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# --- Pre-flight checks ---
# Root is only required for the default system paths.
if [ "$(id -u)" -ne 0 ] && [ -z "${NOMINA_INSTALL_DIR:-}" ]; then
  echo "⚠  This installer needs root. Re-running with sudo..."
  exec sudo bash "$0" "$@"
fi

# Detect platform
ARCH=$(uname -m)
OS=$(uname -s)

case "$OS" in
  Linux)
    case "$ARCH" in
      x86_64)
        BINARY="nomina-linux-x64"
        ;;
      aarch64|arm64)
        BINARY="nomina-linux-arm64"
        ;;
      *)
        echo "❌ Unsupported architecture: $ARCH"
        echo "   Supported: x86_64, aarch64/arm64"
        echo "   Use the Node.js installer instead: curl -fsSL https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install.sh | bash"
        exit 1
        ;;
    esac
    ;;
  Darwin)
    BINARY="nomina"
    ;;
  *)
    echo "❌ Unsupported OS: $OS"
    echo "   Supported: Linux, macOS"
    echo "   Use the Node.js installer instead: curl -fsSL https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install.sh | bash"
    exit 1
    ;;
esac

echo "✔  Detected platform: $OS $ARCH"
echo "✔  Will download: $BINARY"

# --- HTTP helpers ---
if command -v curl &>/dev/null; then
  http_get()     { curl -fsSL "$1"; }
  http_download(){ curl -fsSL -o "$2" "$1"; }
elif command -v wget &>/dev/null; then
  http_get()     { wget -qO- "$1"; }
  http_download(){ wget -q -O "$2" "$1"; }
else
  echo "❌ Neither curl nor wget found. Please install one of them."
  exit 1
fi

latest_tag() {
  http_get "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/' || true
}

# --- Resolve target version ---
REQUESTED_VERSION="${1:-${NOMINA_VERSION:-}}"

latest_prerelease_tag() {
  local body
  body="$(http_get "https://api.github.com/repos/$REPO/releases?per_page=30" 2>/dev/null || true)"
  [ -n "$body" ] || return 0
  printf '%s\n' "$body" \
    | awk '
        /"tag_name":/ { tag=$0; sub(/.*"tag_name"[ ]*:[ ]*"/,"",tag); sub(/".*/,"",tag) }
        /"prerelease":[ ]*true/ { if (tag != "") { print tag; exit } }
      '
}

TARGET_VERSION=""
if [ "$REQUESTED_VERSION" = "dev" ]; then
  echo "🔬 Dev channel selected. Resolving latest dev pre-release..."
  DEV_TAG="$(latest_prerelease_tag)"
  if [ -n "$DEV_TAG" ]; then
    TARGET_VERSION="$DEV_TAG"
    echo "✔  Latest dev build: $TARGET_VERSION"
  else
    echo "⚠  No dev pre-release found."
    echo "📥 Falling back to the Node.js installer on the '${NOMINA_DEV_BRANCH:-dev}' branch..."
    DEV_INSTALLER="$(mktemp)"
    http_get "https://raw.githubusercontent.com/$REPO/${NOMINA_DEV_BRANCH:-dev}/install.sh" > "$DEV_INSTALLER"
    exec bash "$DEV_INSTALLER" dev
  fi
elif [ -n "$REQUESTED_VERSION" ] && [ "$REQUESTED_VERSION" != "latest" ]; then
  case "$REQUESTED_VERSION" in
    v*) TARGET_VERSION="$REQUESTED_VERSION" ;;
    *)  TARGET_VERSION="v$REQUESTED_VERSION" ;;
  esac
else
  echo "🔍 Checking for latest release..."
  TARGET_VERSION="$(latest_tag)"
  if [ -z "$TARGET_VERSION" ]; then
    echo "⚠  Could not determine latest release. Using 'latest' tag."
    TARGET_VERSION="latest"
  fi
fi

if [ "$TARGET_VERSION" = "latest" ]; then
  DOWNLOAD_REF="$BRANCH"
else
  DOWNLOAD_REF="$TARGET_VERSION"
  echo "✔  Target version: $TARGET_VERSION"
fi

# --- Detect current installation ---
CURRENT_VERSION="none"
if [ -f "$VERSION_FILE" ]; then
  CURRENT_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
fi
if [ ! -x "$INSTALL_DIR/nomina" ]; then
  CURRENT_VERSION="none"
fi

case "$CURRENT_VERSION" in
  none)
    echo "📥 Installing NominaConnect $TARGET_VERSION..."
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
  unknown|"")
    echo "⬆  Existing installation detected (version unknown). Updating to $TARGET_VERSION..."
    ;;
  *)
    echo "⬆  Upgrading NominaConnect $CURRENT_VERSION → $TARGET_VERSION..."
    ;;
esac

# --- Download new binary to temp file (existing install stays untouched until swap) ---
mkdir -p "$INSTALL_DIR"
TMP_BIN="$INSTALL_DIR/.nomina.download"

echo "📥 Downloading NominaConnect binary ($TARGET_VERSION)..."
RELEASE_URL="https://github.com/$REPO/releases/download/$DOWNLOAD_REF/$BINARY"
if ! http_download "$RELEASE_URL" "$TMP_BIN" || [ ! -s "$TMP_BIN" ]; then
  echo "⚠  Release download failed. Trying fallback to dist folder..."
  DIST_URL="https://raw.githubusercontent.com/$REPO/$DOWNLOAD_REF/dist/$BINARY"
  if ! http_download "$DIST_URL" "$TMP_BIN" || [ ! -s "$TMP_BIN" ]; then
    rm -f "$TMP_BIN"
    echo "❌ Failed to download $TARGET_VERSION from both release and dist folder."
    if [ "$CURRENT_VERSION" != "none" ]; then
      echo "   Your existing installation ($CURRENT_VERSION) is unchanged."
    else
      echo "   This platform may not have a pre-built binary available."
      echo "   Use the Node.js installer instead: curl -fsSL https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install.sh | bash"
    fi
    exit 1
  fi
fi

chmod +x "$TMP_BIN"

# --- Swap in the new binary (backup old one for rollback) ---
if [ -x "$INSTALL_DIR/nomina" ]; then
  cp -f "$INSTALL_DIR/nomina" "$INSTALL_DIR/nomina.bak"
fi
mv -f "$TMP_BIN" "$INSTALL_DIR/nomina"
printf '%s\n' "$TARGET_VERSION" > "$VERSION_FILE"

mkdir -p "$(dirname "$BIN_LINK")"
ln -sf "$INSTALL_DIR/nomina" "$BIN_LINK"

ACTION="installed"
[ "$CURRENT_VERSION" != "none" ] && ACTION="upgraded"

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║  ✅ NominaConnect $ACTION!             ║"
echo "  ║                                       ║"
echo "  ║  Version: $TARGET_VERSION"
echo "  ║  Run:  nomina                         ║"
echo "  ║  Help: nomina --help                  ║"
echo "  ║  Path: $BIN_LINK              ║"
if [ -f "$INSTALL_DIR/nomina.bak" ]; then
echo "  ║  Rollback copy: $INSTALL_DIR/nomina.bak"
fi
echo "  ╚═══════════════════════════════════════╝"
echo ""
echo "  Get started: cd into your project dir and run 'nomina'"
echo ""
