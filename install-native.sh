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
    exit 1
    ;;
esac

echo "✔  Detected platform: $OS $ARCH"
echo "✔  Will download: $BINARY"

# Check for curl or wget
if command -v curl &>/dev/null; then
  DOWNLOAD_CMD="curl -fsSL"
elif command -v wget &>/dev/null; then
  DOWNLOAD_CMD="wget -qO-"
else
  echo "❌ Neither curl nor wget found. Please install one of them."
  exit 1
fi

# --- Download binary ---
echo "📥 Downloading NominaConnect binary..."
BINARY_URL="https://github.com/$REPO/releases/download/latest/$BINARY" || \
BINARY_URL="https://raw.githubusercontent.com/$REPO/$BRANCH/dist/$BINARY"

# Create install directory
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"

# Download binary
$DOWNLOAD_CMD "$BINARY_URL" > "$INSTALL_DIR/nomina"
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