#!/usr/bin/env bash
set -euo pipefail

# Launch the PCB Inline Inspector UI on the Jetson HDMI display.
#
# This script is used by the desktop autostart entry created by
# `install_app.sh`. It waits for the local UI server, then opens Chromium in
# kiosk mode pointed at the app.

APP_URL="${APP_URL:-http://127.0.0.1:5500/user_interface.html}"

for _ in {1..60}; do
  if command -v curl >/dev/null 2>&1 && curl -fsS "${APP_URL}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if command -v chromium-browser >/dev/null 2>&1; then
  exec chromium-browser --kiosk "${APP_URL}"
fi

if command -v chromium >/dev/null 2>&1; then
  exec chromium --kiosk "${APP_URL}"
fi

if command -v google-chrome >/dev/null 2>&1; then
  exec google-chrome --kiosk "${APP_URL}"
fi

echo "No supported Chromium browser was found. Open ${APP_URL} manually." >&2
exit 1
