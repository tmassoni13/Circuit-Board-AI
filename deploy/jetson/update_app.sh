#!/usr/bin/env bash
set -euo pipefail

# Update PCB Inline Inspector from its GitHub checkout on the Jetson Nano.
#
# Run this whenever you push changes from the development computer:
#
#   cd ~/Circuit-Board-AI
#   bash deploy/jetson/update_app.sh

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3)}"
AXIS_SERVICE_NAME="pcb-axis-bridge.service"
UI_SERVICE_NAME="pcb-inspector-ui.service"
ENV_PATH="/etc/pcb-inline-inspector.env"
DEFAULT_GEMINI_MODEL="gemini-3.1-flash-lite"
AUTOSTART_DIR="${HOME}/.config/autostart"
AUTOSTART_PATH="${AUTOSTART_DIR}/pcb-inline-inspector.desktop"
DESKTOP_DIR="${DESKTOP_DIR:-${HOME}/Desktop}"
if command -v xdg-user-dir >/dev/null 2>&1; then
  DESKTOP_DIR="$(xdg-user-dir DESKTOP)"
fi
APP_DESKTOP_PATH="${DESKTOP_DIR}/pcb-inline-inspector.desktop"
UPDATE_DESKTOP_PATH="${DESKTOP_DIR}/update-pcb-inline-inspector.desktop"
ICON_PATH="${PROJECT_ROOT}/assets/xadite-logo.png"

if [[ -z "${PYTHON_BIN}" ]]; then
  echo "python3 was not found." >&2
  exit 1
fi

if [[ ! -d "${PROJECT_ROOT}/.git" ]]; then
  echo "This project folder is not a Git checkout. Clone it from GitHub first." >&2
  exit 1
fi

cd "${PROJECT_ROOT}"

echo "[UPDATE] Pulling latest code from GitHub..."
git pull --ff-only
echo "[UPDATE] Current commit:"
git log -1 --oneline

echo "[UPDATE] Refreshing editable Python install..."
"${PYTHON_BIN}" -m pip install -e "${PROJECT_ROOT}"

echo "[UPDATE] Ensuring kiosk launcher is executable..."
chmod +x "${PROJECT_ROOT}/deploy/jetson/launch_kiosk.sh"
chmod +x "${PROJECT_ROOT}/deploy/jetson/update_app.sh"
chmod +x "${PROJECT_ROOT}/deploy/jetson/run_update.sh"

echo "[UPDATE] Refreshing desktop launchers..."
mkdir -p "${AUTOSTART_DIR}"
rm -f "${AUTOSTART_PATH}"
mkdir -p "${DESKTOP_DIR}"
cat > "${APP_DESKTOP_PATH}" <<DESKTOP
[Desktop Entry]
Type=Application
Name=PCB AI
Comment=Open the PCB AI app
Exec=${PROJECT_ROOT}/deploy/jetson/launch_kiosk.sh
Icon=${ICON_PATH}
Terminal=false
Categories=Utility;
DESKTOP

cat > "${UPDATE_DESKTOP_PATH}" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Update PCB AI
Comment=Pull the newest app from GitHub and restart services
Exec=${PROJECT_ROOT}/deploy/jetson/run_update.sh
Icon=${ICON_PATH}
Terminal=true
Categories=Utility;
DESKTOP

chmod +x "${APP_DESKTOP_PATH}" "${UPDATE_DESKTOP_PATH}"
if command -v gio >/dev/null 2>&1; then
  gio set "${APP_DESKTOP_PATH}" metadata::trusted true >/dev/null 2>&1 || true
  gio set "${UPDATE_DESKTOP_PATH}" metadata::trusted true >/dev/null 2>&1 || true
fi

echo "[UPDATE] Ensuring Gemini model is ${DEFAULT_GEMINI_MODEL}..."
if [[ -f "${ENV_PATH}" ]]; then
  if grep -q '^GEMINI_MODEL=' "${ENV_PATH}"; then
    sudo sed -i "s/^GEMINI_MODEL=.*/GEMINI_MODEL=${DEFAULT_GEMINI_MODEL}/" "${ENV_PATH}"
  else
    echo "GEMINI_MODEL=${DEFAULT_GEMINI_MODEL}" | sudo tee -a "${ENV_PATH}" >/dev/null
  fi
else
  sudo tee "${ENV_PATH}" >/dev/null <<ENV
GEMINI_API_KEY=
GEMINI_MODEL=${DEFAULT_GEMINI_MODEL}
ENV
fi

echo "[UPDATE] Checking UI markers..."
if grep -n "image-analyze" "${PROJECT_ROOT}/user_interface.html" >/dev/null 2>&1; then
  grep -n "image-analyze" "${PROJECT_ROOT}/user_interface.html" | head -n 2
else
  echo "[WARNING] The Gemini image-log button marker was not found in user_interface.html."
  echo "[WARNING] If you expected it, make sure the Windows computer committed and pushed the change."
fi

echo "[UPDATE] Restarting services..."
sudo systemctl daemon-reload
sudo systemctl restart "${AXIS_SERVICE_NAME}"
sudo systemctl restart "${UI_SERVICE_NAME}"

echo "[UPDATE] UI service status:"
sudo systemctl --no-pager --lines=5 status "${UI_SERVICE_NAME}" || true

echo "[UPDATE] Done."
echo "[UPDATE] Open the desktop icon named 'PCB AI' to launch the app."
