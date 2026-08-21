#!/usr/bin/env bash
# NominaConnect installer (Node.js version) — curl this into your Proxmox server
# For a native binary version (no Node.js required), use install-native.sh instead
# Usage: curl -fsSL https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/install.sh | bash
set -euo pipefail

REPO="BunnyGamezsc/NominaConnect"
BRANCH="main"
INSTALL_DIR="/opt/nominaconnect"
BIN_LINK="/usr/local/bin/nomina"

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║       NominaConnect Installer         ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# --- Pre-flight checks ---
if [ "$(id -u)" -ne 0 ]; then
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

# --- Install pnpm if missing ---
if ! command -v pnpm &>/dev/null; then
  echo "📦 Installing pnpm..."
  npm install -g pnpm@latest
fi
echo "✔  pnpm $(pnpm -v) detected"

# --- Clone or update ---
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "📥 Updating existing installation..."
  git -C "$INSTALL_DIR" fetch origin "$BRANCH" --quiet
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH" --quiet
else
  echo "📥 Cloning NominaConnect..."
  rm -rf "$INSTALL_DIR"
  git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO.git" "$INSTALL_DIR"
fi

# --- Install dependencies ---
echo "📦 Installing dependencies..."
cd "$INSTALL_DIR"
pnpm install --frozen-lockfile --prod 2>/dev/null || pnpm install --prod

# --- Create symlink ---
chmod +x "$INSTALL_DIR/bin/nomina.js"
ln -sf "$INSTALL_DIR/bin/nomina.js" "$BIN_LINK"

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
