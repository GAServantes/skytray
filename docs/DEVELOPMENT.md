# SkyTray — development notes

Read this before changing SkyTray. It covers how the app is put together, where
its data comes from and lives, how to test it without touching your real
settings, and the traps hit so far. The [README](../README.md) is the
user-facing page.

## Files and paths

| Path | Purpose |
|---|---|
| `skytray.py` | Tray app, data fetching, menu, window host |
| `install.sh` | Per-user install/remove (launcher, icon, symlink, autostart) |
| `ui/index.html`, `app.js`, `radar.js`, `style.css` | Forecast window |
| `icons/meteocons/` | Meteocons v2 static fill SVGs (MIT, Bas Milius) |
| `vendor/leaflet.*` | Leaflet 1.9.4 (BSD-2, `vendor/LICENSE-leaflet`) |
| `~/.local/share/skytray/config.json` | Settings (only `DEFAULTS` keys and `_`-prefixed cache keys are loaded) |
| `~/.cache/skytray/last.json` | Last good payload, shown with a notice when a fetch fails |
| `~/.cache/skytray/tray-*.png` | Tray icons, rendered from SVG and cropped tight (Meteocons have wide margins) |
| `~/.config/autostart/skytray.desktop` | Start at login |
| `~/.local/share/applications/skytray.desktop` | Launcher; opens the window, with a Radar action |

`VERSION` is near the top of `skytray.py`. Bump it, plus the README changelog,
on every change.

It is a single-instance Python/GTK3 `Gtk.Application` with an
AyatanaAppIndicator tray icon. The forecast window is a WebKit2 (4.1) view of
`ui/index.html`.

## Data sources, in detail

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
| Location from IP | ipinfo.io, falling back to ipwho.is (both HTTPS, no key) | only on first run or "Use my IP location"; was ip-api.com over plain http before 1.3.1 |

## How it works / gotchas

- Python → page: `App.setState(json)` is pushed on load and after every fetch.
  Page → Python: `webkit.messageHandlers.app.postMessage(JSON)` with commands
  `refresh`, `settings`, `locate-ip` and `open`.
- Fetches run on a worker thread against a snapshot of the request (lat, lon,
  units, NWS points), never the live config. A fetch that finishes after the
  location or units changed is dropped; forced refreshes queue behind a
  running one.
- The refresh timer ticks every 60 s and fetches when the data is older than
  `refresh_minutes`, so it catches up right after suspend. The menu is only
  rebuilt on the hour or after a fetch, because rebuilding closes an open menu.
- Radar: every frame is its own Leaflet tile layer and all of them stay on the
  map, so scrubbing is instant. Only the current frame has opacity > 0.
  Playback waits one extra tick for a frame whose tiles haven't loaded.
- The dark or light theme comes from gsettings `color-scheme` and is passed to
  the page as `data-theme`; the window follows a live switch.

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

- A test instance keeps its config and cache under `SKYTRAY_HOME`, apart from
  the real one.
- JS `console.log` output goes to the instance's stdout.
- **`--snapshot` doesn't capture the radar overlay** (WebKit's snapshot drops
  composited layers). Use a compositor screenshot to check the radar.
- To inspect the tray menu without clicking, call
  `com.canonical.dbusmenu.GetLayout` on
  `/org/ayatana/NotificationItem/skytray/Menu`.
- **Published screenshots use a made-up or public test location only**
  (the README's are Denver), never your own.

After editing, restart with
`./skytray.py --quit; nohup ./skytray.py >/dev/null 2>&1 &`.

### README screenshots

The images in `docs/screenshots/` were taken in an isolated headless GNOME
Shell (Ubuntu 26.04 container, `gnome-shell --unsafe-mode --headless`) with a
`SKYTRAY_HOME` test instance set to Denver and `TZ=America/Denver`:
`org.gnome.Shell.Screenshot.ScreenshotWindow` for the tabs (it includes the
radar overlay, unlike `--snapshot`), `Shell.Eval` to open the AppIndicator
menu plus `ScreenshotArea` for the menu, and repeated window shots of the
playing radar turned into `radar.gif` with ffmpeg (8 fps, 640 px wide).
