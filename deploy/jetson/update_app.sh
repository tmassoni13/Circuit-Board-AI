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
echo "[UPDATE] Open the desktop icon named 'PCB Inline Inspector' or reboot the Jetson."
