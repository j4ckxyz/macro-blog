#!/usr/bin/env bash
#
# Local setup for a cloned Macroblog repo (Raspberry Pi / Ubuntu / any Linux).
# For a fresh machine, prefer the one-liner installer in the README.
#
set -euo pipefail
cd "$(dirname "$0")"

HUGO_VERSION="${HUGO_VERSION:-0.147.0}"
if [ "$(id -u)" = "0" ]; then BIN_DIR="/usr/local/bin"; else BIN_DIR="$HOME/.local/bin"; fi
mkdir -p "$BIN_DIR"; export PATH="$BIN_DIR:$PATH"

# Bun
command -v bun >/dev/null || { curl -fsSL https://bun.sh/install | bash; export PATH="$HOME/.bun/bin:$PATH"; }

# Hugo (detect ARM64 vs x86)
if ! command -v hugo >/dev/null; then
  ARCH=$(uname -m)
  if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then HUGO_ARCH="arm64"; else HUGO_ARCH="amd64"; fi
  curl -fsSL "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_linux-${HUGO_ARCH}.tar.gz" \
    | tar xz -C "$BIN_DIR" hugo
fi

# Dependencies
bun install

# Config from template if not present (never overwrite existing data)
if [ ! -f macroblog.config.yaml ]; then
  cp macroblog.config.yaml.example macroblog.config.yaml
  bun run macroblog --gen-secret
fi

# Migrations
bun run db:migrate

echo "✓ Macroblog set up."
echo "→ Set your password:   bun run macroblog --set-password"
echo "→ Start it:            bun run start"
echo "→ Run as a service:    sudo ./setup-service.sh"
echo "→ Admin UI:            http://127.0.0.1:3000/admin/"
