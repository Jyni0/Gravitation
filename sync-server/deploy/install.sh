#!/bin/sh
# Installs gravitation-sync as a systemd service on Debian / Ubuntu.
#
#   sudo sh install.sh ./gravitation-sync          # binary next to this script
#
# Then put it behind HTTPS (see Caddyfile) or give it a certificate in
# /etc/gravitation-sync.env, and create an invite:
#   sudo -u gravitation-sync gravitation-sync --data /var/lib/gravitation-sync invite
set -eu

BIN="${1:-./gravitation-sync}"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)"; exit 1; }
[ -f "$BIN" ] || { echo "binary not found: $BIN"; exit 1; }

install -m 0755 "$BIN" /usr/local/bin/gravitation-sync

if ! id gravitation-sync >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/gravitation-sync --shell /usr/sbin/nologin gravitation-sync
fi
install -d -m 0700 -o gravitation-sync -g gravitation-sync /var/lib/gravitation-sync

if [ ! -f /etc/gravitation-sync.env ]; then
  cat > /etc/gravitation-sync.env <<'EOF'
# Behind Caddy/nginx on the same host (recommended):
GSYNC_LISTEN=127.0.0.1:8443
GSYNC_TRUST_PROXY=true

# Or serve HTTPS directly (certificate readable by the gravitation-sync user):
#GSYNC_LISTEN=0.0.0.0:8443
#GSYNC_TLS_CERT=/etc/gravitation-sync/fullchain.pem
#GSYNC_TLS_KEY=/etc/gravitation-sync/privkey.pem
EOF
  chmod 0644 /etc/gravitation-sync.env
fi

install -m 0644 "$HERE/gravitation-sync.service" /etc/systemd/system/gravitation-sync.service
systemctl daemon-reload
systemctl enable --now gravitation-sync
systemctl --no-pager --lines=5 status gravitation-sync || true

echo
echo "Installed. Create an invite for your first device:"
echo "  sudo -u gravitation-sync gravitation-sync --data /var/lib/gravitation-sync invite"
