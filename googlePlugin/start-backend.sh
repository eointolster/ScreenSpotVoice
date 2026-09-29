#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -x .venv/bin/python ]]; then
  echo 'Install the project-local Python environment first: python3 -m venv .venv && .venv/bin/pip install -r requirements.lock.txt' >&2
  exit 1
fi
exec .venv/bin/python -m backend.run
