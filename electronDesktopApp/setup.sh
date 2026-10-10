#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

npm ci
node -e "require('electron')" >/dev/null
if [[ ! -x .venv/bin/python ]]; then python3 -m venv .venv; fi
.venv/bin/python -m pip install -r requirements.lock.txt
HF_HOME="$PWD/.cache/huggingface" .venv/bin/python -m voice.prepare_models
npm run typecheck
npm run build
./scripts/make-launcher.sh

printf '\nSetup complete. Run ./launch.sh or copy "ScreenSpot Voice.desktop" to your Desktop.\n'
