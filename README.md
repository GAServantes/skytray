# SkyTray

A weather indicator for the GNOME top bar on Ubuntu 24.04. It shows a condition
icon and the temperature all the time. One click shows the next 12 hours, and a
window has the full forecast plus an animated radar you can play and scrub.

It is a single-instance Python/GTK3 `Gtk.Application` with an
AyatanaAppIndicator tray icon. The forecast window is a WebKit2 (4.1) view of
`ui/index.html`. No API keys or accounts are needed.

## Install

Requirements: Ubuntu 24.04 (or another GNOME desktop) with the AppIndicator
extension enabled (Ubuntu has it on by default), plus
`python3-gi gir1.2-gtk-3.0 gir1.2-webkit2-4.1 gir1.2-ayatanaappindicator3-0.1 python3-gi-cairo`.

```bash
git clone https://github.com/GAServantes/skytray.git ~/skytray
~/skytray/install.sh          # launcher, `skytray` command, start at login; starts it
~/skytray/install.sh --remove # undo
```

The app runs from the cloned folder, so keep it there. On first run it finds
your location from your IP address; change it under Settings (⚙).

## Using it

- **Top bar:** the icon (Meteocons colour by default, or monochrome GNOME
  symbolic icons) and the temperature. A ⚠ is appended while an NWS alert is
  active.
- **Click (menu):**
  - current conditions, feels-like, today's high and low, and wind
  - a precipitation nowcast ("Rain starting around 3:15 PM"), from Open-Meteo
    15-minute data
  - any NWS alerts
  - the next N hours (12 by default)
  - Forecast & details…, Radar…, Refresh, Settings…, Quit
- **Window tabs:**
  - **Now:** hero conditions, NWS text forecast, a 6-hour precipitation chart
    (shown only when precipitation is expected), a 24-hour strip, and detail
    tiles: wind, humidity, pressure trend, UV, clouds and visibility,
    sunrise/sunset, AQI, moon.
  - **Hourly:** a temperature and feels-like chart and a precipitation-chance
    chart, with a crosshair tooltip. Night hours are shaded. Ranges are 48 h,
    7 days or 16 days, with a full table below.
  - **16-Day:** daily rows with a low–high range bar. Click a day to see the
    NWS narrative, extra facts and that day's hours. Days 8–16 are marked
    lower confidence.
  - **Past 7 Days:** summary tiles (total precipitation, warmest, coldest,
    wettest day), an hourly temperature and precipitation-amount chart, and a
    daily table. Nothing is stored locally: `past_days=7` on the same
    Open-Meteo request returns it. It's model analysis, not station readings.
  - **Radar:** past NEXRAD composite scans plus HRRR simulated-reflectivity
    forecast frames (shown in purple, "Forecast · HRRR model").
    - Controls: play/pause, step, a "Now" button, and a time-scaled scrub
      slider.
    - Past window: 1–24 h. Future window: off to 18 h.
    - Speed and opacity are adjustable.
    - Keys: Space plays or pauses, ←/→ step, Home/End jump to the ends, N
      jumps to now.
  - **Alerts:** only shown while alerts are active.
  - **⚙ Settings:** location search (city or ZIP), IP location, units, icon
    style, refresh interval, menu hours, start at login.

CLI (forwarded to the running instance): `skytray [--details | --radar |
--refresh | --quit]`. There is also a symlink at `~/.local/bin/skytray`.

## Data sources (none need API keys)

| What | Source | Notes |
|---|---|---|
| Forecast (current, 15-min, hourly, 16-day, past 7 days) | api.open-meteo.com | `past_days=7`, so hourly/daily arrays start 7 days back and forecast views filter from now/today; `timeformat=unixtime`, so all times are formatted in the location's timezone |
| Air quality | air-quality-api.open-meteo.com | optional |
| Alerts and text forecast | api.weather.gov | US only; the `/points` lookup is cached in config as `_nws_points` |
| Observed radar | IEM `ridge::USCOMP-N0Q-YYYYMMDDHHMM` tiles | the scan list comes from `mesonet.agron.iastate.edu/json/radar.py?operation=list` |
| Forecast radar | IEM `hrrr::REFD-F{min:04d}-{run}` tiles | 15-min steps to F1080. Runs appear about 1.5 h late; `hrrrRun()` probes tiles to find the newest complete run |
| Radar outside the US | RainViewer `weather-maps.json` | past frames only (no nowcast now), max native zoom 7 |
| Basemap | Esri Canvas World Dark/Light Gray, Base + Reference | **CARTO basemaps now return "API KEY REQUIRED" tiles**, so don't switch back |
| Geocoding | geocoding-api.open-meteo.com | called from JS in Settings |
| First-run location | ip-api.com (http) | |

## Files

| Path | Purpose |
|---|---|
| `skytray.py` | Tray app, data fetching, menu, window host |
| `install.sh` | Per-user install/remove (launcher, icon, symlink, autostart) |
| `ui/index.html`, `app.js`, `radar.js`, `style.css` | Forecast window |
| `icons/meteocons/` | Meteocons v2 static fill SVGs (MIT, Bas Milius) |
| `vendor/leaflet.*` | Leaflet 1.9.4 (BSD-2, `vendor/LICENSE-leaflet`) |
| `~/.local/share/skytray/config.json` | Settings (only `DEFAULTS` keys and `_`-prefixed cache keys are loaded) |
| `~/.cache/skytray/tray-*.png` | Tray icons, rendered from SVG and cropped tight (Meteocons have wide margins) |
| `~/.config/autostart/skytray.desktop` | Start at login |
| `~/.local/share/applications/skytray.desktop` | Launcher; opens the window, with a Radar action |

## How it works / gotchas

- Python → page: `App.setState(json)` is pushed on load and after every fetch.
  Page → Python: `webkit.messageHandlers.app.postMessage(JSON)` with commands
  `refresh`, `settings`, `locate-ip` and `open`.
- The refresh timer ticks every 60 s and fetches when the data is older than
  `refresh_minutes`, so it catches up right after suspend. The menu is only
  rebuilt on the hour or after a fetch, because rebuilding closes an open menu.
- Radar: every frame is its own Leaflet tile layer and all of them stay on the
  map, so scrubbing is instant. Only the current frame has opacity > 0.
  Playback waits one extra tick for a frame whose tiles haven't loaded.
- The dark or light theme comes from gsettings `color-scheme` and is passed to
  the page as `data-theme`.

## Testing

```bash
S=/some/scratch; mkdir -p $S/home
echo '{"lat": 39.74, "lon": -104.99, "place": "Test"}' > $S/home/config.json
export SKYTRAY_HOME=$S/home SKYTRAY_APP_ID=io.github.local.SkyTrayTest
./skytray.py &                           # separate test instance and tray icon
./skytray.py --snapshot hourly out.png 3 # WebKit snapshot of a tab after 3 s
./skytray.py --js 'Radar.show(0)'        # run JS in the open window
./skytray.py --quit
```

- A test instance keeps its config and cache under `SKYTRAY_HOME`, apart from the real one.
- JS `console.log` output goes to the instance's stdout.
- **`--snapshot` doesn't capture the radar overlay** (WebKit's snapshot drops
  composited layers). Use a portal screenshot to check the radar.
- To inspect the tray menu without clicking, call
  `com.canonical.dbusmenu.GetLayout` on `/org/ayatana/NotificationItem/skytray/Menu`.

After editing, restart with `./skytray.py --quit; nohup ./skytray.py >/dev/null 2>&1 &`.

## History

- 2026-09-29 v1: tray icon and label, hourly menu, nowcast, NWS alerts,
  forecast window (Now/Hourly/16-Day/Alerts/Settings), and radar with IEM
  NEXRAD + HRRR forecast frames, play and scrub.
- 2026-09-29 v1.1: Past 7 Days tab (Open-Meteo `past_days=7`), radar past window up to 24 h.
- 2026-09-29 v1.2: redesign. Condition-tinted hero; 24 h strip with a temperature curve; detail tiles each with their own graphic (wind compass, sun arc, UV/AQI scales, meters, pressure sparkline, moon phases) and a plain-words note; history stat row. The last good payload is cached in `~/.cache/skytray/last.json` (shown with a notice when a fetch fails; Open-Meteo had a 503 outage during this work).
- 2026-10-19 v1.3: review fixes.
  - A fetch that was running when you changed location or units no longer
    overwrites the new settings with old-place data (it used to also block the
    new fetch for up to 10 minutes). Forced refreshes queue behind a running one.
  - The NWS point lookup is cached from the main thread instead of the worker.
  - A failed "Use my IP location" no longer retries forever when a location is
    already set.
  - The window follows the system light/dark switch live; the WebKit background
    matches the page (no flash).
  - Radar refreshes itself every 5 minutes while the tab is open (when paused),
    and keyboard controls no longer double-fire on focused buttons or sliders.
  - Location search ignores out-of-order responses; small guards for missing
    data.
  - `install.sh`, `.gitignore` and the Leaflet licence for publishing;
    `SKYTRAY_HOME` test instances get their own cache.
