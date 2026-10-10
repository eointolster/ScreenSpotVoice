#!/usr/bin/env bash
set -euo pipefail
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cat >"$app_dir/ScreenSpot Voice.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=ScreenSpot Voice
Comment=Local screen-aware voice guide
Exec=$app_dir/launch.sh
Path=$app_dir
Icon=$app_dir/static/icon.svg
Terminal=false
Categories=Utility;
StartupNotify=true
DESKTOP
chmod +x "$app_dir/ScreenSpot Voice.desktop"
printf 'Created %s/ScreenSpot Voice.desktop\n' "$app_dir"
