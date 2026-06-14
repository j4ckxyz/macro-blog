#!/usr/bin/env bash
#
# Install Macroblog as a systemd service that starts on boot.
# Run from the install directory:  sudo ./setup-service.sh
#
set -euo pipefail

[ "$(id -u)" = "0" ] || { echo "Please run with sudo."; exit 1; }

DIR="$(cd "$(dirname "$0")" && pwd)"
RUN_USER="${SUDO_USER:-$(whoami)}"
BUN_BIN="$(sudo -u "$RUN_USER" bash -lc 'command -v bun' || command -v bun)"
[ -n "$BUN_BIN" ] || { echo "bun not found for user $RUN_USER"; exit 1; }

UNIT=/etc/systemd/system/macroblog.service
sed -e "s|__USER__|$RUN_USER|" \
    -e "s|__DIR__|$DIR|" \
    -e "s|__BUN__|$BUN_BIN|" \
    "$DIR/macroblog.service" > "$UNIT"

systemctl daemon-reload
systemctl enable macroblog
systemctl restart macroblog

echo "✓ macroblog service installed and started."
echo "  Logs:    journalctl -u macroblog -f"
echo "  Status:  systemctl status macroblog"
