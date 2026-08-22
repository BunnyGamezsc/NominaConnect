#!/usr/bin/env bash
# NominaConnect native installer — curl this into your Proxmox server
# This version downloads pre-compiled binaries, no Node.js required
# Usage: curl -fsSL https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install-native.sh | bash
set -euo pipefail

REPO="BunnyGamezsc/NominaConnect"
BRANCH="main"
INSTALL_DIR="/opt/nominaconnect"
BIN_LINK="/usr/local/bin/nomina"

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║   NominaConnect Native Installer       ║"
echo "  ║     (No Node.js required)             ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# --- Pre-flight checks ---
if [ "$(id -u)" -ne 0 ]; then
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
        echo "   Note: Cross-platform builds require additional setup"
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

# Check for curl or wget
if command -v curl &>/dev/null; then
  DOWNLOAD_CMD="curl -fsSL"
  API_CMD="curl -fsSL"
elif command -v wget &>/dev/null; then
  DOWNLOAD_CMD="wget -qO-"
  API_CMD="wget -qO-"
else
  echo "❌ Neither curl nor wget found. Please install one of them."
  exit 1
fi

# --- Get latest release version ---
echo "🔍 Checking for latest release..."
LATEST_RELEASE=$($API_CMD "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')

if [ -z "$LATEST_RELEASE" ]; then
  echo "⚠  Could not determine latest release. Using 'latest' tag."
  LATEST_RELEASE="latest"
else
  echo "✔  Found latest release: $LATEST_RELEASE"
fi

# --- Download binary ---
echo "📥 Downloading NominaConnect binary..."
BINARY_URL="https://github.com/$REPO/releases/download/$LATEST_RELEASE/$BINARY"

# Create install directory
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# Download binary
if ! $DOWNLOAD_CMD "$BINARY_URL" > "$INSTALL_DIR/nomina" 2>/dev/null; then
  echo "⚠  Release download failed. Trying fallback to dist folder..."
  BINARY_URL="https://raw.githubusercontent.com/$REPO/$BRANCH/dist/$BINARY"
  if ! $DOWNLOAD_CMD "$BINARY_URL" > "$INSTALL_DIR/nomina" 2>/dev/null; then
    echo "❌ Failed to download binary from both release and dist folder."
    echo "   This platform may not have a pre-built binary available."
    echo "   Use the Node.js installer instead: curl -fsSL https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install.sh | bash"
    exit 1
  fi
fi
chmod +x "$INSTALL_DIR/nomina"

# Create symlink
ln -sf "$INSTALL_DIR/nomina" "$BIN_LINK"

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║     ✅ NominaConnect installed!        ║"
echo "  ║                                       ║"
echo "  ║  Run:  nomina                         ║"
echo "  ║  Help: nomina --help                  ║"
echo "  ║  Path: $BIN_LINK              ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""
echo "  Get started: cd into your project dir and run 'nomina'"
echo ""