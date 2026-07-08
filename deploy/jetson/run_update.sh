#!/usr/bin/env bash
set -euo pipefail

# Small wrapper used by the clickable desktop updater.
# Keeping this as a real script avoids fragile quoting inside the .desktop file.

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "${PROJECT_ROOT}"
bash deploy/jetson/update_app.sh

echo
echo "Update complete. Press Enter to close."
read -r _
