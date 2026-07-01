#!/usr/bin/env bash
set -euo pipefail

# Install the GRBL axis bridge as a Jetson Nano systemd service.
#
# Run this once from the project root on the Jetson:
#
#   bash deploy/jetson/install_axis_bridge_service.sh
#
# After installation, the bridge starts automatically at boot and listens on:
#
#   http://127.0.0.1:8765

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVICE_NAME="pcb-axis-bridge.service"
SERVICE_PATH="/etc/systemd/system/${SERVICE_NAME}"
PYTHON_BIN="${PYTHON_BIN:-$(command -v python3)}"
SERVICE_USER="${SERVICE_USER:-$(id -un)}"

if [[ -z "${PYTHON_BIN}" ]]; then
  echo "python3 was not found. Install Python 3 before installing the service." >&2
  exit 1
fi

if [[ ! -f "${PROJECT_ROOT}/pyproject.toml" ]]; then
  echo "Could not find pyproject.toml. Run this from inside the project checkout." >&2
  exit 1
fi

echo "[SETUP] Installing Python package in editable mode..."
"${PYTHON_BIN}" -m pip install -e "${PROJECT_ROOT}"

if getent group dialout >/dev/null; then
  echo "[SETUP] Adding ${SERVICE_USER} to dialout so it can open /dev/ttyUSB*..."
  sudo usermod -a -G dialout "${SERVICE_USER}"
  SUPPLEMENTARY_GROUPS="SupplementaryGroups=dialout"
else
  SUPPLEMENTARY_GROUPS=""
fi

echo "[SETUP] Writing ${SERVICE_PATH}..."
sudo tee "${SERVICE_PATH}" >/dev/null <<SERVICE
[Unit]
Description=PCB Inspector GRBL Axis Bridge
After=multi-user.target

[Service]
Type=simple
User=${SERVICE_USER}
${SUPPLEMENTARY_GROUPS}
WorkingDirectory=${PROJECT_ROOT}
Environment=PYTHONUNBUFFERED=1
ExecStart=${PYTHON_BIN} -m pcb_inspector.main axis-bridge
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
SERVICE

echo "[SETUP] Enabling and starting ${SERVICE_NAME}..."
sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"

echo "[SETUP] Axis bridge service installed."
echo "[SETUP] Status: sudo systemctl status ${SERVICE_NAME}"
echo "[SETUP] Logs:   journalctl -u ${SERVICE_NAME} -f"
echo "[SETUP] If serial permission fails, reboot the Jetson once and retry."
