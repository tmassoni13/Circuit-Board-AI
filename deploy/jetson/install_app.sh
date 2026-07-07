#!/usr/bin/env bash
set -euo pipefail

# Install PCB Inline Inspector as a Jetson Nano application.
#
# What this installs:
# - editable Python package from this Git checkout
# - automatic GRBL axis bridge service on port 8765
# - automatic UI server service on port 5500
# - desktop autostart entry that opens Chromium kiosk mode
#
# Normal use:
#
#   git clone <repo-url>
#   cd Circuit-Board-AI
#   bash deploy/jetson/install_app.sh
#
# After that, reboot the Jetson. The app should come up on the HDMI display.

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3)}"
SERVICE_USER="${SERVICE_USER:-$(id -un)}"
AXIS_SERVICE_NAME="pcb-axis-bridge.service"
UI_SERVICE_NAME="pcb-inspector-ui.service"
AXIS_SERVICE_PATH="/etc/systemd/system/${AXIS_SERVICE_NAME}"
UI_SERVICE_PATH="/etc/systemd/system/${UI_SERVICE_NAME}"
ENV_PATH="/etc/pcb-inline-inspector.env"
AUTOSTART_DIR="${HOME}/.config/autostart"
AUTOSTART_PATH="${AUTOSTART_DIR}/pcb-inline-inspector.desktop"

if [[ -z "${PYTHON_BIN}" ]]; then
  echo "python3 was not found. Install Python 3 before installing the app." >&2
  exit 1
fi

if [[ ! -f "${PROJECT_ROOT}/pyproject.toml" ]]; then
  echo "Could not find pyproject.toml. Run this from inside the project checkout." >&2
  exit 1
fi

echo "[SETUP] Installing Python package from ${PROJECT_ROOT}..."
"${PYTHON_BIN}" -m pip install -e "${PROJECT_ROOT}"

if [[ ! -f "${ENV_PATH}" ]]; then
  echo "[SETUP] Creating ${ENV_PATH}. Add your Gemini API key there before AI inspection."
  sudo tee "${ENV_PATH}" >/dev/null <<ENV
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash
ENV
fi

SUPPLEMENTARY_GROUPS=""
if getent group dialout >/dev/null; then
  echo "[SETUP] Adding ${SERVICE_USER} to dialout so it can open /dev/ttyUSB*..."
  sudo usermod -a -G dialout "${SERVICE_USER}"
  SUPPLEMENTARY_GROUPS="SupplementaryGroups=dialout"
fi

echo "[SETUP] Writing ${AXIS_SERVICE_PATH}..."
sudo tee "${AXIS_SERVICE_PATH}" >/dev/null <<SERVICE
[Unit]
Description=PCB Inspector GRBL Axis Bridge
After=multi-user.target

[Service]
Type=simple
User=${SERVICE_USER}
${SUPPLEMENTARY_GROUPS}
WorkingDirectory=${PROJECT_ROOT}
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONPATH=${PROJECT_ROOT}/src
ExecStart=${PYTHON_BIN} -m pcb_inspector.main axis-bridge
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
SERVICE

echo "[SETUP] Writing ${UI_SERVICE_PATH}..."
sudo tee "${UI_SERVICE_PATH}" >/dev/null <<SERVICE
[Unit]
Description=PCB Inline Inspector UI Server
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${PROJECT_ROOT}
Environment=PYTHONUNBUFFERED=1
Environment=PYTHONPATH=${PROJECT_ROOT}/src
EnvironmentFile=-${ENV_PATH}
ExecStart=${PYTHON_BIN} -m pcb_inspector.main serve-ui --host 127.0.0.1 --port 5500 --root ${PROJECT_ROOT}
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
SERVICE

echo "[SETUP] Installing desktop kiosk autostart..."
chmod +x "${PROJECT_ROOT}/deploy/jetson/launch_kiosk.sh"
mkdir -p "${AUTOSTART_DIR}"
cat > "${AUTOSTART_PATH}" <<DESKTOP
[Desktop Entry]
Type=Application
Name=PCB Inline Inspector
Comment=Open PCB Inline Inspector kiosk UI
Exec=${PROJECT_ROOT}/deploy/jetson/launch_kiosk.sh
Terminal=false
X-GNOME-Autostart-enabled=true
DESKTOP

echo "[SETUP] Enabling services..."
sudo systemctl daemon-reload
sudo systemctl enable "${AXIS_SERVICE_NAME}"
sudo systemctl enable "${UI_SERVICE_NAME}"
sudo systemctl restart "${AXIS_SERVICE_NAME}"
sudo systemctl restart "${UI_SERVICE_NAME}"

echo "[SETUP] Install complete."
echo "[SETUP] Reboot the Jetson once before production use:"
echo "        sudo reboot"
echo
echo "[SETUP] Service status:"
echo "        sudo systemctl status ${AXIS_SERVICE_NAME}"
echo "        sudo systemctl status ${UI_SERVICE_NAME}"
echo
echo "[SETUP] Live logs:"
echo "        journalctl -u ${AXIS_SERVICE_NAME} -f"
echo "        journalctl -u ${UI_SERVICE_NAME} -f"
