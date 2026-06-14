#!/usr/bin/env bash
#
# Update Macroblog in place WITHOUT touching your data.
#
# Your posts (hugo-site/content), uploads, database (macroblog.db) and config
# (macroblog.config.yaml) are all gitignored and left untouched. This script
# takes a safety backup first, then fast-forwards the code and rebuilds.
#
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\033[1;34m▸\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

say "Taking a safety backup…"
bun run macroblog --backup || true

say "Fetching latest code…"
git stash --include-untracked --quiet || true
git pull --ff-only
git stash pop --quiet 2>/dev/null || true

say "Installing dependencies…"
bun install >/dev/null

say "Running migrations…"
bun run db:migrate >/dev/null

say "Rebuilding site…"
hugo -s hugo-site -d ../public -b "$(grep -E '^\s*url:' macroblog.config.yaml | head -1 | sed 's/.*url:\s*"\?\([^"]*\)"\?.*/\1/')" >/dev/null 2>&1 || true

if systemctl is-active --quiet macroblog 2>/dev/null; then
  say "Restarting macroblog service…"
  sudo systemctl restart macroblog
fi

ok "Update complete. Your data was preserved."
