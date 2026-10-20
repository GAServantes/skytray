#!/usr/bin/env bash
# Install SkyTray for the current user: launcher, icon, `skytray` command and
# start-at-login. Run from the repo; the app keeps running from this folder.
#   ./install.sh            install (and start it)
#   ./install.sh --remove   remove the launcher, icon, command and autostart entry
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/scalable/apps"
BIN="$HOME/.local/bin"
AUTOSTART="$HOME/.config/autostart"

if [[ "${1:-}" == "--remove" ]]; then
  "$HERE/skytray.py" --quit 2>/dev/null || true
  rm -f "$APPS/skytray.desktop" "$ICONS/skytray.svg" "$BIN/skytray" "$AUTOSTART/skytray.desktop"
  echo "SkyTray removed (settings stay in ~/.local/share/skytray)."
  exit 0
fi

missing=()
python3 - <<'PY' || missing+=(python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1 gir1.2-ayatanaappindicator3-0.1 python3-gi-cairo)
import gi
gi.require_version("Gtk", "3.0"); gi.require_version("WebKit2", "4.1")
gi.require_version("AyatanaAppIndicator3", "0.1")
from gi.repository import Gtk, WebKit2, AyatanaAppIndicator3  # noqa: F401
PY
if ((${#missing[@]})); then
  echo "Missing GTK/WebKit/AppIndicator bindings. Install them with:"
  echo "  sudo apt install ${missing[*]}"
  exit 1
fi
if ! gnome-extensions list --enabled 2>/dev/null | grep -q appindicator; then
  echo "Note: the AppIndicator GNOME extension isn't enabled; the top-bar icon needs it"
  echo "      (Ubuntu ships it as ubuntu-appindicators@ubuntu.com)."
fi

mkdir -p "$APPS" "$ICONS" "$BIN" "$AUTOSTART"
cp "$HERE/icons/meteocons/partly-cloudy-day.svg" "$ICONS/skytray.svg"
ln -sf "$HERE/skytray.py" "$BIN/skytray"
cat > "$APPS/skytray.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=SkyTray
Comment=Weather in the top bar, forecast and radar
Exec="$HERE/skytray.py" --details
Icon=skytray
Terminal=false
Categories=Utility;
Keywords=weather;forecast;radar;
Actions=Radar;

[Desktop Action Radar]
Name=Radar
Exec="$HERE/skytray.py" --radar
DESK
cat > "$AUTOSTART/skytray.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=SkyTray
Comment=Weather in the top bar
Exec="$HERE/skytray.py"
Icon=skytray
Terminal=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=5
DESK
gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
update-desktop-database -q "$APPS" 2>/dev/null || true
nohup "$HERE/skytray.py" >/dev/null 2>&1 &
echo "SkyTray installed and started. It finds your location from your IP on first run;"
echo "change it under Settings (⚙) in the forecast window."
