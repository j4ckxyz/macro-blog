#!/usr/bin/env bash
#
# Macroblog one-command installer.
#
#   curl -fsSL https://raw.githubusercontent.com/j4ckxyz/macro-blog/main/install.sh | bash
#
# Installs Bun + Hugo (if missing), fetches Macroblog, installs deps, generates
# a session secret, prompts for a password, builds the site, and tells you
# exactly how to reach it. Designed to be safe by default: the server binds to
# 127.0.0.1 and refuses to run without a password.
#
set -euo pipefail

REPO="${MACROBLOG_REPO:-https://github.com/j4ckxyz/macro-blog}"
BRANCH="${MACROBLOG_BRANCH:-main}"
INSTALL_DIR="${MACROBLOG_DIR:-$HOME/macroblog}"
HUGO_VERSION="${HUGO_VERSION:-0.147.0}"

say()  { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

need_cmd() { command -v "$1" >/dev/null 2>&1; }

# --- Determine a bin dir we can write to ---
if [ "$(id -u)" = "0" ]; then BIN_DIR="/usr/local/bin"; else BIN_DIR="$HOME/.local/bin"; fi
mkdir -p "$BIN_DIR"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) export PATH="$BIN_DIR:$PATH";; esac

# --- Bun ---
if ! need_cmd bun; then
  say "Installing Bun…"
  curl -fsSL https://bun.sh/install | bash >/dev/null
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
need_cmd bun || die "Bun installation failed. See https://bun.sh"
ok "Bun $(bun --version)"

# --- Hugo (extended) ---
if ! need_cmd hugo; then
  say "Installing Hugo extended ${HUGO_VERSION}…"
  ARCH="$(uname -m)"
  case "$ARCH" in
    aarch64|arm64) HUGO_ARCH="arm64" ;;
    x86_64|amd64)  HUGO_ARCH="amd64" ;;
    *) die "Unsupported architecture: $ARCH" ;;
  esac
  TMP="$(mktemp -d)"
  curl -fsSL "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_linux-${HUGO_ARCH}.tar.gz" \
    | tar xz -C "$TMP" hugo
  mv "$TMP/hugo" "$BIN_DIR/hugo"
  rm -rf "$TMP"
fi
need_cmd hugo || die "Hugo installation failed."
ok "Hugo $(hugo version | head -c 40)…"

# --- Fetch / update Macroblog ---
if [ -d "$INSTALL_DIR/.git" ]; then
  say "Updating existing install at $INSTALL_DIR…"
  git -C "$INSTALL_DIR" pull --ff-only origin "$BRANCH"
else
  say "Cloning Macroblog into $INSTALL_DIR…"
  git clone --branch "$BRANCH" --depth 1 "$REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

say "Installing dependencies…"
bun install >/dev/null
ok "Dependencies installed"

# --- Config (preserve existing) ---
if [ ! -f macroblog.config.yaml ]; then
  cp macroblog.config.yaml.example macroblog.config.yaml
  ok "Created macroblog.config.yaml"
  bun run macroblog --gen-secret >/dev/null
  ok "Generated session secret"
else
  warn "macroblog.config.yaml already exists — leaving it untouched"
fi

# --- Password (interactive only) ---
if grep -q 'password_hash: ""' macroblog.config.yaml 2>/dev/null; then
  if [ -t 0 ]; then
    say "Set your admin password:"
    bun run macroblog --set-password
  else
    warn "No password set. Run:  cd $INSTALL_DIR && bun run macroblog --set-password"
  fi
fi

# --- Migrate + build ---
bun run db:migrate >/dev/null && ok "Database ready"
say "Building site…"
hugo -s hugo-site -d ../public -b "$(grep -E '^\s*url:' macroblog.config.yaml | head -1 | sed 's/.*url:\s*"\?\([^"]*\)"\?.*/\1/')" >/dev/null 2>&1 || warn "Initial build will run on first start"

PORT="$(grep -E '^\s*port:' macroblog.config.yaml | head -1 | grep -oE '[0-9]+' || echo 3000)"
cat <<EOF

$(ok "Macroblog is installed at $INSTALL_DIR")

  Start it:        cd $INSTALL_DIR && bun run start
  Admin UI:        http://127.0.0.1:${PORT}/admin/
  Your blog:       http://127.0.0.1:${PORT}/

Make it reachable from the internet (pick one):

  • Cloudflare Tunnel (recommended, no open ports, free TLS):
      cloudflared tunnel --url http://127.0.0.1:${PORT}
    then point your domain at the tunnel. Update "site.url" in
    macroblog.config.yaml to your https domain and rebuild.

  • VPS with a reverse proxy (Caddy gives you automatic HTTPS):
      yoursite.com { reverse_proxy 127.0.0.1:${PORT} }

  • Run as a service:   sudo ./setup-service.sh

Back up anytime:   bun run macroblog --backup
EOF
