#!/usr/bin/env bash
# One-time EC2 bootstrap for TimeSync.
#
#   - Installs Caddy (auto-HTTPS reverse proxy)
#   - Creates a systemd unit that reads TIMESYNC_DOMAIN from your .env
#   - Reloads Caddy so it picks up the current Caddyfile
#
# Usage (run on the EC2 box, NOT locally):
#
#     ssh ec2-user@<your-instance>
#     cd ~/TimeSync
#     bash setup_server.sh
#
# Prerequisites the script checks for:
#   1. ~/TimeSync/.env contains a line like:  TIMESYNC_DOMAIN=your.domain.com
#   2. Ports 80 and 443 are open in the EC2 Security Group (script reminds you)
#   3. DNS A record for $TIMESYNC_DOMAIN points at this instance's public IP

set -euo pipefail

APP_DIR="${HOME}/TimeSync"
CADDYFILE_SRC="${APP_DIR}/Caddyfile"
ENV_FILE="${APP_DIR}/.env"

echo "==> TimeSync server bootstrap"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: ${ENV_FILE} not found. Create it first." >&2
  exit 1
fi

if ! grep -q '^TIMESYNC_DOMAIN=' "$ENV_FILE"; then
  echo "ERROR: TIMESYNC_DOMAIN= line missing from ${ENV_FILE}" >&2
  echo "       Add a line like: TIMESYNC_DOMAIN=timesync.example.com" >&2
  exit 1
fi

# ---- Install Caddy if missing ---------------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Installing Caddy (this requires sudo)..."
  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64)  CADDY_ARCH=amd64 ;;
    aarch64) CADDY_ARCH=arm64 ;;
    *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
  esac

  TMP=$(mktemp -d)
  curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${CADDY_ARCH}" -o "$TMP/caddy"
  chmod +x "$TMP/caddy"
  sudo mv "$TMP/caddy" /usr/local/bin/caddy

  # Dedicated system user
  if ! id caddy >/dev/null 2>&1; then
    sudo useradd --system \
      --home /var/lib/caddy \
      --create-home \
      --shell /usr/sbin/nologin \
      --user-group \
      --comment "Caddy web server" \
      caddy || true
  fi

  # Allow binding low ports without root
  sudo setcap 'cap_net_bind_service=+ep' /usr/local/bin/caddy

  sudo mkdir -p /etc/caddy /var/log/caddy
  sudo chown -R caddy:caddy /var/log/caddy
  echo "==> Caddy installed: $(/usr/local/bin/caddy version | head -1)"
else
  echo "==> Caddy already installed: $(caddy version | head -1)"
fi

# ---- Wire Caddyfile + EnvironmentFile -------------------------------------

# Symlink the repo Caddyfile into /etc/caddy so deploys overwrite live config
sudo ln -sf "$CADDYFILE_SRC" /etc/caddy/Caddyfile

# Caddy systemd unit reads vars from this file (we copy from .env so we
# only expose what's needed to Caddy)
TIMESYNC_DOMAIN_VALUE=$(grep -E '^TIMESYNC_DOMAIN=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
sudo tee /etc/caddy/timesync.env >/dev/null <<EOF
TIMESYNC_DOMAIN=${TIMESYNC_DOMAIN_VALUE}
EOF
sudo chown root:caddy /etc/caddy/timesync.env
sudo chmod 640 /etc/caddy/timesync.env

# ---- systemd unit ---------------------------------------------------------
sudo tee /etc/systemd/system/caddy.service >/dev/null <<'UNIT'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network.target network-online.target
Requires=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
EnvironmentFile=/etc/caddy/timesync.env
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable caddy
sudo systemctl restart caddy
sleep 2
sudo systemctl --no-pager status caddy | head -15 || true

echo
echo "==> Done. If Caddy started cleanly, visit https://${TIMESYNC_DOMAIN_VALUE}"
echo
echo "Reminders:"
echo "  - Open ports 80 and 443 in your EC2 Security Group (Custom TCP, source 0.0.0.0/0)"
echo "  - Make sure DNS A record for ${TIMESYNC_DOMAIN_VALUE} points to this instance's public IP"
echo "  - The first request may take ~10s while Caddy provisions a Let's Encrypt cert"
echo "  - You can now safely close port 8080 in the security group; Flask only listens on 127.0.0.1"
