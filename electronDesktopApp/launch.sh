#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$app_dir"

if [[ ! -x node_modules/electron/dist/electron || ! -x .venv/bin/python || ! -f models/kokoro-v1.0.onnx || ! -f dist/main.cjs ]]; then
  message="ScreenSpot Voice needs setup first. Open a terminal in $app_dir and run ./setup.sh"
  if command -v zenity >/dev/null 2>&1; then zenity --error --title='ScreenSpot Voice' --text="$message"; fi
  printf '%s\n' "$message" >&2
  exit 1
fi

mkdir -p logs
unset ELECTRON_RUN_AS_NODE
exec node_modules/electron/dist/electron . >>logs/desktop.log 2>&1
