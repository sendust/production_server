#!/bin/bash
# Install CasparCG as a systemd system service and let the sendust playlist backend control it.
#   sudo ./deploy/install_casparcg_service.sh [user] [casparcg dir]
# defaults: the user who ran sudo, ~user/casparcgserver (must contain run_caspar.sh)
#
# - /etc/systemd/system/casparcg.service   runs <casparcg dir>/run_caspar.sh as <user>
# - /etc/sudoers.d/sendust-casparcg        <user> may run exactly:
#       systemctl start|stop|restart|enable|disable casparcg.service   (no password, nothing else)
# The service is installed but neither enabled (autostart) nor started: use the settings page.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
USER_NAME="${1:-${SUDO_USER:-}}"
[ -n "$USER_NAME" ] && [ "$USER_NAME" != root ] || { echo "usage: sudo $0 <user> [casparcg dir]"; exit 1; }
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
CASPAR_DIR="${2:-$HOME_DIR/casparcgserver}"
[ -x "$CASPAR_DIR/run_caspar.sh" ] || { echo "$CASPAR_DIR/run_caspar.sh not found / not executable"; exit 1; }
SYSTEMCTL="$(command -v systemctl)"
UNIT=casparcg.service

cat > /etc/systemd/system/$UNIT <<UNITEOF
[Unit]
Description=CasparCG Server (sendust playlist)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$CASPAR_DIR
ExecStart=$CASPAR_DIR/run_caspar.sh
# DeckLink outputs need a few seconds after a stop before a new CasparCG can open them
ExecStopPost=/bin/sleep 8
TimeoutStopSec=30
StandardOutput=append:$CASPAR_DIR/log/stdout_gpu.log
StandardError=inherit
Restart=no

[Install]
WantedBy=multi-user.target
UNITEOF

RULE=/etc/sudoers.d/sendust-casparcg
TMP="$(mktemp)"
{
  echo "# sendust playlist backend: control the CasparCG service from the settings page"
  for a in start stop restart enable disable; do
    echo "$USER_NAME ALL=(root) NOPASSWD: $SYSTEMCTL $a $UNIT"
  done
} > "$TMP"
visudo -cf "$TMP" >/dev/null || { echo "sudoers check failed"; rm -f "$TMP"; exit 1; }
install -m 0440 -o root -g root "$TMP" "$RULE"
rm -f "$TMP"

mkdir -p "$CASPAR_DIR/log" && chown "$USER_NAME": "$CASPAR_DIR/log"
systemctl daemon-reload
echo "installed /etc/systemd/system/$UNIT and $RULE"
echo "If CasparCG is running by hand now, stop it in the settings page, then [시작]."
