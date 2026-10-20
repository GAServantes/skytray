#!/usr/bin/env python3
"""SkyTray - a weather indicator for the GNOME top bar.

The top bar shows a condition icon and the current temperature.  Clicking it
opens a menu with the next 12 hours, any NWS alerts and a precipitation
nowcast.  From the menu, "Forecast & details" opens a window with the full
hourly/16-day forecast, and "Radar" opens an animated radar map that can be
played and scrubbed (past NEXRAD scans plus HRRR forecast radar).

Data: Open-Meteo (forecast, air quality, geocoding; no API key), the US
National Weather Service (alerts and text forecasts), and Iowa Environmental
Mesonet (radar tiles; RainViewer is used outside the US).

Command line (forwarded to the running instance):
  skytray              start (tray icon)
  skytray --details    open the forecast window
  skytray --radar      open the forecast window on the radar tab
  skytray --refresh    fetch new data now
  skytray --quit       quit the running instance
"""
import datetime
import json
import os
import sys
import threading
import time
import urllib.parse
import urllib.request
import warnings
from zoneinfo import ZoneInfo

warnings.filterwarnings("ignore", category=DeprecationWarning)

import gi  # noqa: E402

gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
gi.require_version("WebKit2", "4.1")
gi.require_version("AyatanaAppIndicator3", "0.1")
from gi.repository import AyatanaAppIndicator3 as AppIndicator  # noqa: E402
from gi.repository import Gdk, GdkPixbuf, Gio, GLib, Gtk, WebKit2  # noqa: E402

APP_ID = os.environ.get("SKYTRAY_APP_ID", "io.github.local.SkyTray")
HERE = os.path.dirname(os.path.realpath(__file__))
ICON_DIR = os.path.join(HERE, "icons", "meteocons")
UI_DIR = os.path.join(HERE, "ui")
DATA_DIR = os.environ.get(
    "SKYTRAY_HOME", os.path.join(GLib.get_user_data_dir(), "skytray"))
CACHE_DIR = (os.path.join(os.environ["SKYTRAY_HOME"], "cache") if "SKYTRAY_HOME" in os.environ
             else os.path.join(GLib.get_user_cache_dir(), "skytray"))
AUTOSTART_FILE = os.path.join(GLib.get_user_config_dir(), "autostart", "skytray.desktop")
VERSION = "1.3"
USER_AGENT = f"SkyTray/{VERSION} (personal desktop weather indicator)"
WINDOW_BG = {True: "#0d0f13", False: "#eef1f5"}  # matches --bg in ui/style.css

DEFAULTS = {
    "lat": None,            # None = look up from IP address on first run
    "lon": None,
    "place": "",
    "units": "imperial",    # imperial | metric
    "icon_style": "color",  # color (Meteocons) | symbolic (monochrome, theme)
    "refresh_minutes": 10,
    "menu_hours": 12,       # hourly rows in the tray menu
    "radar_past_hours": 2,
    "radar_future_hours": 6,
    "radar_opacity": 0.75,
    "radar_speed": 1.0,
    "window_size": [1100, 800],
}

# WMO weather code -> (description, meteocons base, symbolic base)
# Meteocons names ending in "-{dn}" get "day" or "night" filled in.
WMO = {
    0: ("Clear", "clear-{dn}", "weather-clear"),
    1: ("Mostly clear", "clear-{dn}", "weather-few-clouds"),
    2: ("Partly cloudy", "partly-cloudy-{dn}", "weather-few-clouds"),
    3: ("Overcast", "overcast", "weather-overcast"),
    45: ("Fog", "fog-{dn}", "weather-fog"),
    48: ("Freezing fog", "fog-{dn}", "weather-fog"),
    51: ("Light drizzle", "drizzle", "weather-showers-scattered"),
    53: ("Drizzle", "drizzle", "weather-showers-scattered"),
    55: ("Heavy drizzle", "drizzle", "weather-showers"),
    56: ("Freezing drizzle", "sleet", "weather-showers"),
    57: ("Freezing drizzle", "sleet", "weather-showers"),
    61: ("Light rain", "rain", "weather-showers-scattered"),
    63: ("Rain", "rain", "weather-showers"),
    65: ("Heavy rain", "rain", "weather-showers"),
    66: ("Freezing rain", "sleet", "weather-showers"),
    67: ("Freezing rain", "sleet", "weather-showers"),
    71: ("Light snow", "snow", "weather-snow"),
    73: ("Snow", "snow", "weather-snow"),
    75: ("Heavy snow", "snow", "weather-snow"),
    77: ("Snow grains", "snow", "weather-snow"),
    80: ("Light showers", "partly-cloudy-{dn}-rain", "weather-showers-scattered"),
    81: ("Showers", "partly-cloudy-{dn}-rain", "weather-showers"),
    82: ("Heavy showers", "partly-cloudy-{dn}-rain", "weather-showers"),
    85: ("Snow showers", "partly-cloudy-{dn}-snow", "weather-snow"),
    86: ("Heavy snow showers", "partly-cloudy-{dn}-snow", "weather-snow"),
    95: ("Thunderstorms", "thunderstorms-{dn}-rain", "weather-storm"),
    96: ("Thunderstorms, hail", "thunderstorms-rain", "weather-storm"),
    99: ("Severe thunderstorms, hail", "thunderstorms-rain", "weather-storm"),
}
COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
FIGURE_SPACE = " "  # same width as a digit; used to line up menu rows


def wmo_text(code):
    return WMO.get(code, ("Unknown", "not-available", "weather-severe-alert"))[0]


def meteocon(code, is_day):
    name = WMO.get(code, (None, "not-available", None))[1]
    return name.replace("{dn}", "day" if is_day else "night")


def symbolic(code, is_day):
    name = WMO.get(code, (None, None, "weather-severe-alert"))[2]
    if not is_day and name in ("weather-clear", "weather-few-clouds"):
        name += "-night"
    return name + "-symbolic"


def compass(deg):
    return COMPASS[int((deg % 360) / 22.5 + 0.5) % 16] if deg is not None else ""


def http_json(url, params=None, timeout=15, headers=None):
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def in_us(lat, lon):
    """Rough box for NWS/NEXRAD coverage (CONUS, Alaska, Hawaii, Puerto Rico)."""
    return ((24 <= lat <= 50 and -125 <= lon <= -66)
            or (51 <= lat <= 72 and -170 <= lon <= -129)
            or (18 <= lat <= 23 and -161 <= lon <= -154)
            or (17 <= lat <= 19 and -68 <= lon <= -65))


# ---------------------------------------------------------------- config

class Config(dict):
    def __init__(self):
        super().__init__(DEFAULTS)
        self.path = os.path.join(DATA_DIR, "config.json")
        try:
            with open(self.path) as f:
                saved = json.load(f)
            self.update({k: v for k, v in saved.items() if k in DEFAULTS or k.startswith("_")})
        except (OSError, ValueError):
            pass

    def save(self):
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(self, f, indent=2)
        os.replace(tmp, self.path)


# ---------------------------------------------------------------- data

def locate_by_ip():
    d = http_json("http://ip-api.com/json/", timeout=8)
    if d.get("status") != "success":
        raise RuntimeError("IP lookup failed")
    place = ", ".join(x for x in (d.get("city"), d.get("region")) if x)
    return d["lat"], d["lon"], place


def fetch_weather(req):
    """Fetch everything for `req` (a snapshot: lat, lon, units, nws_points).

    Runs on a worker thread, so it never touches the live config. Returns a dict
    for the UI; raises only if the core forecast fails."""
    lat, lon = req["lat"], req["lon"]
    imperial = req["units"] == "imperial"
    unit_params = ({"temperature_unit": "fahrenheit", "wind_speed_unit": "mph",
                    "precipitation_unit": "inch"} if imperial else {"wind_speed_unit": "kmh"})
    om = http_json("https://api.open-meteo.com/v1/forecast", {
        "latitude": lat, "longitude": lon, "timezone": "auto", "timeformat": "unixtime",
        "forecast_days": 16, "past_days": 7,
        "current": ",".join([
            "temperature_2m", "relative_humidity_2m", "apparent_temperature", "is_day",
            "precipitation", "weather_code", "cloud_cover", "pressure_msl", "wind_speed_10m",
            "wind_direction_10m", "wind_gusts_10m", "visibility", "dew_point_2m", "uv_index"]),
        "minutely_15": "precipitation,snowfall",
        "forecast_minutely_15": 24,
        "hourly": ",".join([
            "temperature_2m", "apparent_temperature", "relative_humidity_2m", "dew_point_2m",
            "precipitation_probability", "precipitation", "snowfall", "weather_code",
            "cloud_cover", "visibility", "wind_speed_10m", "wind_direction_10m",
            "wind_gusts_10m", "uv_index", "is_day", "pressure_msl"]),
        "daily": ",".join([
            "weather_code", "temperature_2m_max", "temperature_2m_min",
            "apparent_temperature_max", "apparent_temperature_min", "sunrise", "sunset",
            "daylight_duration", "uv_index_max", "precipitation_sum", "snowfall_sum",
            "precipitation_hours", "precipitation_probability_max", "wind_speed_10m_max",
            "wind_gusts_10m_max", "wind_direction_10m_dominant"]),
        **unit_params,
    })
    out = {"om": om, "aq": None, "nws": None, "errors": []}
    try:
        out["aq"] = http_json("https://air-quality-api.open-meteo.com/v1/air-quality", {
            "latitude": lat, "longitude": lon, "current": "us_aqi,european_aqi,pm2_5,ozone",
            "timeformat": "unixtime"})["current"]
    except Exception as e:  # noqa: BLE001 - optional extra
        out["errors"].append(f"air quality: {e}")
    if in_us(lat, lon):
        try:
            out["nws"] = fetch_nws(req)
        except Exception as e:  # noqa: BLE001 - optional extra
            out["errors"].append(f"NWS: {e}")
    return out


def fetch_nws(req):
    lat, lon = round(req["lat"], 4), round(req["lon"], 4)
    key = f"{lat},{lon}"
    points = req.get("nws_points") or {}
    if points.get("key") != key:
        p = http_json(f"https://api.weather.gov/points/{key}")["properties"]
        points = {"key": key, "forecast": p["forecast"], "office": p.get("cwa"),
                  "radar": p.get("radarStation")}
    # "points" goes back to the main thread, which caches it in the config
    nws = {"office": points.get("office"), "radar": points.get("radar"),
           "points": points, "periods": [], "alerts": []}
    try:
        units = "us" if req["units"] == "imperial" else "si"
        nws["periods"] = [
            {k: p.get(k) for k in ("name", "startTime", "endTime", "isDaytime", "temperature",
                                   "temperatureUnit", "shortForecast", "detailedForecast")}
            for p in http_json(points["forecast"], {"units": units})["properties"]["periods"]]
    except Exception:  # noqa: BLE001 - NWS gridpoint forecasts are often briefly unavailable
        pass
    alerts = http_json("https://api.weather.gov/alerts/active", {"point": key})
    for a in alerts.get("features", []):
        p = a["properties"]
        nws["alerts"].append({k: p.get(k) for k in (
            "event", "headline", "severity", "urgency", "onset", "ends", "expires",
            "description", "instruction", "senderName")})
    return nws


# ---------------------------------------------------------------- helpers for the menu

class Weather:
    """Convenience accessors over the fetched payload."""

    def __init__(self, payload, cfg):
        self.p = payload
        self.om = payload["om"]
        self.cfg = cfg
        try:
            self.tz = ZoneInfo(self.om.get("timezone") or "UTC")
        except Exception:  # noqa: BLE001
            self.tz = datetime.timezone.utc

    @property
    def cur(self):
        return self.om["current"]

    def deg(self, v):
        return f"{round(v)}°" if v is not None else "–"

    def speed(self, v):
        return f"{round(v)} {'mph' if self.cfg['units'] == 'imperial' else 'km/h'}"

    def local(self, ts):
        return datetime.datetime.fromtimestamp(ts, self.tz)

    def hour_label(self, ts):
        d = self.local(ts)
        return d.strftime("%-I %p") if self.cfg["units"] == "imperial" else d.strftime("%H:%M")

    def clock(self, ts):
        d = self.local(ts)
        return d.strftime("%-I:%M %p") if self.cfg["units"] == "imperial" else d.strftime("%H:%M")

    def upcoming_hours(self, n):
        h = self.om["hourly"]
        now = time.time()
        idx = [i for i, t in enumerate(h["time"]) if t > now][:n]
        return [{k: h[k][i] for k in h} for i in idx]

    def today(self):
        d = self.om["daily"]
        today = self.local(time.time()).date()
        for i, t in enumerate(d["time"]):
            if self.local(t).date() == today:
                return {k: d[k][i] for k in d}
        return {k: d[k][0] for k in d}

    def nowcast(self):
        """A short sentence about precipitation in the next ~6 hours, or None."""
        m = self.om.get("minutely_15") or {}
        times, precip = m.get("time") or [], m.get("precipitation") or []
        snow = m.get("snowfall") or [0] * len(precip)
        thresh = 0.004 if self.cfg["units"] == "imperial" else 0.1
        now = time.time()
        steps = [(t, (p or 0) >= thresh, (s or 0) > 0)
                 for t, p, s in zip(times, precip, snow) if t + 900 > now]
        if not steps:
            return None
        kind = "Snow" if any(s for _, w, s in steps if w) else "Rain"
        if steps[0][1]:
            for t, wet, _ in steps:
                if not wet:
                    return f"{kind} ending around {self.clock(t)}"
            return f"{kind} continuing for the next few hours"
        for t, wet, _ in steps:
            if wet:
                return f"{kind} starting around {self.clock(t)}"
        return None


# ---------------------------------------------------------------- icons

class Icons:
    """Colour tray/menu icons rendered from the Meteocons SVGs and cropped to their content."""

    def __init__(self):
        os.makedirs(CACHE_DIR, exist_ok=True)
        self.cache = {}

    def svg(self, name):
        path = os.path.join(ICON_DIR, name + ".svg")
        return path if os.path.exists(path) else os.path.join(ICON_DIR, "not-available.svg")

    def tray_png(self, name, size=64):
        """Path to a tightly cropped PNG (Meteocons have wide margins, which look tiny in a panel)."""
        out = os.path.join(CACHE_DIR, f"tray-{name}-{size}.png")
        if not os.path.exists(out):
            pb = GdkPixbuf.Pixbuf.new_from_file_at_size(self.svg(name), size * 2, size * 2)
            pb = self.crop(pb)
            w, h = pb.get_width(), pb.get_height()
            s = size / max(w, h)
            pb = pb.scale_simple(max(1, round(w * s)), max(1, round(h * s)),
                                 GdkPixbuf.InterpType.HYPER)
            canvas = GdkPixbuf.Pixbuf.new(GdkPixbuf.Colorspace.RGB, True, 8, size, size)
            canvas.fill(0)
            pb.copy_area(0, 0, pb.get_width(), pb.get_height(), canvas,
                         (size - pb.get_width()) // 2, (size - pb.get_height()) // 2)
            canvas.savev(out, "png", [], [])
        return out

    def pixbuf(self, name, size=24):
        key = (name, size)
        if key not in self.cache:
            self.cache[key] = GdkPixbuf.Pixbuf.new_from_file_at_size(self.tray_png(name), size, size)
        return self.cache[key]

    @staticmethod
    def crop(pb):
        w, h, rs, n = pb.get_width(), pb.get_height(), pb.get_rowstride(), pb.get_n_channels()
        px = pb.get_pixels()
        x0, y0, x1, y1 = w, h, -1, -1
        for y in range(h):
            row = y * rs
            for x in range(w):
                if px[row + x * n + 3] > 8:
                    if x < x0:
                        x0 = x
                    if x > x1:
                        x1 = x
                    y0 = min(y0, y)
                    y1 = y
        if x1 < 0:
            return pb
        return pb.new_subpixbuf(x0, y0, x1 - x0 + 1, y1 - y0 + 1)


# ---------------------------------------------------------------- forecast window

class ForecastWindow(Gtk.ApplicationWindow):
    def __init__(self, app, tab):
        super().__init__(application=app, title="SkyTray")
        self.app = app
        self.ready = False
        self.pending_tab = tab
        w, h = app.cfg["window_size"]
        self.set_default_size(w, h)
        self.set_icon_from_file(app.icons.tray_png("partly-cloudy-day", 64))

        ucm = WebKit2.UserContentManager()
        ucm.register_script_message_handler("app")
        ucm.connect("script-message-received::app", self.on_message)
        self.view = WebKit2.WebView.new_with_user_content_manager(ucm)
        s = self.view.get_settings()
        s.set_allow_file_access_from_file_urls(True)
        s.set_allow_universal_access_from_file_urls(True)
        s.set_enable_developer_extras(True)
        s.set_enable_write_console_messages_to_stdout(True)
        s.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.ALWAYS)
        s.set_user_agent_with_application_details("SkyTray", "1.0")
        self.set_background(app.dark_mode())
        self.view.connect("load-changed", self.on_load)
        self.view.connect("decide-policy", self.on_policy)
        self.add(self.view)
        self.view.load_uri(GLib.filename_to_uri(os.path.join(UI_DIR, "index.html")))
        self.connect("configure-event", self.on_configure)
        self.connect("destroy", self.on_destroy)
        self.show_all()

    def set_background(self, dark):
        # Shown for a moment before the page paints; keep it the page's colour.
        rgba = Gdk.RGBA()
        rgba.parse(WINDOW_BG[dark])
        self.view.set_background_color(rgba)

    def on_policy(self, view, decision, kind):
        # External links (NWS pages, attributions) open in the default browser.
        if kind == WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION or (
                kind == WebKit2.PolicyDecisionType.NAVIGATION_ACTION
                and decision.get_navigation_action().get_request().get_uri().startswith("http")):
            uri = decision.get_navigation_action().get_request().get_uri()
            Gio.AppInfo.launch_default_for_uri(uri, None)
            decision.ignore()
            return True
        return False

    def on_configure(self, *_):
        if not self.is_maximized():
            self.app.cfg["window_size"] = list(self.get_size())

    def on_destroy(self, *_):
        self.app.cfg.save()
        self.app.window = None

    def on_load(self, view, event):
        if event == WebKit2.LoadEvent.FINISHED:
            self.ready = True
            self.push_state()
            self.show_tab(self.pending_tab)

    def js(self, code):
        if self.ready:
            self.view.evaluate_javascript(code, -1, None, None, None, None, None)

    def push_state(self):
        a = self.app
        state = {
            "config": {k: v for k, v in a.cfg.items() if not k.startswith("_")},
            "dark": a.dark_mode(),
            "weather": a.payload,
            "fetchedAt": a.data_time,
            "error": a.last_error,
            "autostart": os.path.exists(AUTOSTART_FILE),
            "inUS": a.cfg["lat"] is not None and in_us(a.cfg["lat"], a.cfg["lon"]),
        }
        self.js(f"window.App && App.setState({json.dumps(state)});")

    def show_tab(self, tab):
        if tab:
            self.js(f"window.App && App.showTab({json.dumps(tab)});")

    def on_message(self, ucm, result):
        try:
            msg = json.loads(result.get_js_value().to_string())
        except Exception:  # noqa: BLE001
            return
        cmd = msg.get("cmd")
        if cmd == "refresh":
            self.app.refresh(force=True)
        elif cmd == "settings":
            self.app.apply_settings(msg.get("values") or {})
        elif cmd == "locate-ip":
            self.app.locate(ip=True)
        elif cmd == "open" and str(msg.get("url", "")).startswith(("https://", "http://")):
            Gio.AppInfo.launch_default_for_uri(msg["url"], None)


# ---------------------------------------------------------------- application

class SkyTray(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID,
                         flags=Gio.ApplicationFlags.HANDLES_COMMAND_LINE)
        self.cfg = Config()
        self.icons = Icons()
        self.payload = None
        self.weather = None
        self.fetched_at = 0
        self.data_time = 0
        self.last_error = None
        self.fetching = False
        self.refetch_pending = False
        self.iface_settings = None
        self.window = None
        self.indicator = None
        self.menu = None
        self.menu_hour = None
        self.started = False

    # ---- lifecycle
    def do_command_line(self, cl):
        args = cl.get_arguments()[1:]
        if not self.started:
            self.started = True
            self.hold()
            self.setup()
        for a in args:
            if a == "--details":
                self.open_window("now")
            elif a == "--radar":
                self.open_window("radar")
            elif a == "--refresh":
                self.refresh(force=True)
            elif a == "--quit":
                self.quit()
            elif a == "--js" and self.window:
                # testing helper: run JavaScript in the open forecast window
                self.window.js(args[args.index(a) + 1])
                break
            elif a == "--snapshot" and len(args) >= 3:
                # testing helper: --snapshot TAB OUT.png [DELAY_S]
                i = args.index(a)
                self.snapshot(args[i + 1], args[i + 2], float(args[i + 3]) if len(args) > i + 3 else 4)
                break
            elif a in ("-h", "--help"):
                cl.print_literal(__doc__)
        return 0

    def setup(self):
        GLib.set_application_name("SkyTray")
        Gtk.Settings.get_default().set_property(
            "gtk-application-prefer-dark-theme", self.dark_mode())
        try:
            self.iface_settings = Gio.Settings.new("org.gnome.desktop.interface")
            self.iface_settings.connect("changed::color-scheme", self.on_theme_changed)
        except Exception:  # noqa: BLE001 - not on GNOME
            self.iface_settings = None
        self.indicator = AppIndicator.Indicator.new(
            "skytray", "weather-few-clouds-symbolic",
            AppIndicator.IndicatorCategory.APPLICATION_STATUS)
        self.indicator.set_title("SkyTray weather")
        self.indicator.set_status(AppIndicator.IndicatorStatus.ACTIVE)
        self.indicator.set_label("…", "100°")
        self.build_menu()
        self.load_cache()
        if self.cfg["lat"] is None:
            self.locate(ip=True)
        else:
            self.refresh(force=True)
        # Check every minute; fetch when the data is older than the interval.
        # This also catches up promptly after suspend/resume.
        GLib.timeout_add_seconds(60, self.tick)

    # Last good payload on disk, so the tray and window have something to show
    # right after login or while the forecast service is down.
    def cache_path(self):
        return os.path.join(CACHE_DIR, "last.json")

    def load_cache(self):
        try:
            with open(self.cache_path()) as f:
                c = json.load(f)
        except (OSError, ValueError):
            return
        if (c.get("lat"), c.get("lon"), c.get("units")) != (self.cfg["lat"], self.cfg["lon"], self.cfg["units"]):
            return
        if time.time() - c.get("fetched_at", 0) > 2 * 86400:
            return
        self.payload = c["payload"]
        self.weather = Weather(self.payload, self.cfg)
        self.fetched_at = 0          # still fetch fresh data straight away
        self.data_time = c["fetched_at"]
        self.update_ui()

    def save_cache(self):
        tmp = self.cache_path() + ".tmp"
        try:
            with open(tmp, "w") as f:
                json.dump({"lat": self.cfg["lat"], "lon": self.cfg["lon"], "units": self.cfg["units"],
                           "fetched_at": self.data_time, "payload": self.payload}, f)
            os.replace(tmp, self.cache_path())
        except OSError:
            pass

    def dark_mode(self):
        try:
            return Gio.Settings.new("org.gnome.desktop.interface").get_string(
                "color-scheme") == "prefer-dark"
        except Exception:  # noqa: BLE001
            return False

    def on_theme_changed(self, *_):
        dark = self.dark_mode()
        Gtk.Settings.get_default().set_property("gtk-application-prefer-dark-theme", dark)
        if self.window:
            self.window.set_background(dark)
            self.window.push_state()

    def tick(self):
        if time.time() - self.fetched_at > self.cfg["refresh_minutes"] * 60:
            self.refresh()
        elif self.weather and time.strftime("%H") != self.menu_hour:
            self.build_menu()  # roll the hourly rows on the hour (not every tick: it closes an open menu)
        return True

    # ---- data
    def run_bg(self, work, done):
        def runner():
            try:
                res, err = work(), None
            except Exception as e:  # noqa: BLE001
                res, err = None, e
            GLib.idle_add(done, res, err)
        threading.Thread(target=runner, daemon=True).start()

    def locate(self, ip=False):
        def done(res, err):
            if err:
                self.last_error = f"Couldn't find your location: {err}"
                self.update_ui()
                if self.cfg["lat"] is None:  # first run: keep trying; otherwise keep the old place
                    GLib.timeout_add_seconds(120, lambda: self.locate(ip=True) and False)
                return
            self.cfg["lat"], self.cfg["lon"], self.cfg["place"] = res
            self.cfg.save()
            self.refresh(force=True)
        self.run_bg(locate_by_ip, done)

    def refresh(self, force=False):
        if self.cfg["lat"] is None:
            return
        if self.fetching:
            if force:
                self.refetch_pending = True  # run again once the current fetch lands
            return
        if not force and time.time() - self.fetched_at < 60:
            return
        self.fetching = True
        self.refetch_pending = False
        if self.window:
            self.window.js("window.App && App.setBusy(true);")
        req = {"lat": self.cfg["lat"], "lon": self.cfg["lon"], "units": self.cfg["units"],
               "nws_points": self.cfg.get("_nws_points")}

        def done(res, err):
            self.fetching = False
            if (req["lat"], req["lon"], req["units"]) != (self.cfg["lat"], self.cfg["lon"], self.cfg["units"]):
                # Location or units changed mid-fetch: this result is for the old settings.
                self.refresh(force=True)
                return
            if self.refetch_pending:
                GLib.idle_add(lambda: self.refresh(force=True) and False)
            if err:
                self.last_error = f"Update failed ({err})"
                if self.weather:
                    self.last_error += f" · showing data from {self.weather.clock(self.data_time)}"
                # Retry sooner than the normal interval.
                self.fetched_at = time.time() - self.cfg["refresh_minutes"] * 60 + 120
            else:
                points = (res.get("nws") or {}).pop("points", None)
                if points and points != self.cfg.get("_nws_points"):
                    self.cfg["_nws_points"] = points
                    self.cfg.save()
                self.payload = res
                self.weather = Weather(res, self.cfg)
                self.fetched_at = self.data_time = time.time()
                self.last_error = None
                self.save_cache()
            self.update_ui()
        self.run_bg(lambda: fetch_weather(req), done)

    def apply_settings(self, values):
        changed_loc = False
        for k, v in values.items():
            if k in DEFAULTS and k not in ("window_size",):
                if k in ("lat", "lon") and v != self.cfg.get(k):
                    changed_loc = True
                self.cfg[k] = v
        if "autostart" in values:
            self.set_autostart(bool(values["autostart"]))
        self.cfg.save()
        refetch = changed_loc or "units" in values
        if refetch:
            self.payload = self.weather = None
            self.refresh(force=True)
        else:
            self.update_ui()

    def set_autostart(self, on):
        if on:
            os.makedirs(os.path.dirname(AUTOSTART_FILE), exist_ok=True)
            with open(AUTOSTART_FILE, "w") as f:
                f.write("[Desktop Entry]\nType=Application\nName=SkyTray\n"
                        "Comment=Weather in the top bar\n"
                        f"Exec=\"{os.path.join(HERE, 'skytray.py')}\"\nIcon=skytray\n"
                        "Terminal=false\nX-GNOME-Autostart-enabled=true\n"
                        "X-GNOME-Autostart-Delay=5\n")
        elif os.path.exists(AUTOSTART_FILE):
            os.remove(AUTOSTART_FILE)

    # ---- UI
    def update_ui(self):
        w = self.weather
        if w:
            c = w.cur
            if self.cfg["icon_style"] == "symbolic":
                self.indicator.set_icon_full(symbolic(c["weather_code"], c["is_day"]),
                                             wmo_text(c["weather_code"]))
            else:
                self.indicator.set_icon_full(
                    self.icons.tray_png(meteocon(c["weather_code"], c["is_day"])),
                    wmo_text(c["weather_code"]))
            label = w.deg(c["temperature_2m"])
            if w.p.get("nws") and w.p["nws"]["alerts"]:
                label += " ⚠"
            self.indicator.set_label(label, "100° ⚠")
        elif self.last_error:
            self.indicator.set_icon_full("weather-severe-alert-symbolic", "Error")
            self.indicator.set_label("?", "100°")
        else:
            self.indicator.set_label("…", "100°")
        self.build_menu()
        if self.window:
            self.window.push_state()

    def item(self, label, cb=None, icon=None, sensitive=True):
        if icon is not None:
            it = Gtk.ImageMenuItem(label=label)
            it.set_image(Gtk.Image.new_from_pixbuf(icon))
            it.set_always_show_image(True)
        else:
            it = Gtk.MenuItem(label=label)
        if cb:
            it.connect("activate", lambda *_: cb())
        it.set_sensitive(sensitive)
        self.menu.append(it)
        return it

    def sep(self):
        self.menu.append(Gtk.SeparatorMenuItem())

    def build_menu(self):
        self.menu = Gtk.Menu()
        self.menu_hour = time.strftime("%H")
        w = self.weather
        details = lambda: self.open_window("now")  # noqa: E731
        if w:
            c = w.cur
            t = w.today()
            self.item(f"{w.deg(c['temperature_2m'])}  {wmo_text(c['weather_code'])}"
                      f"  ·  feels {w.deg(c['apparent_temperature'])}",
                      details, self.icons.pixbuf(meteocon(c["weather_code"], c["is_day"]), 32))
            self.item(f"High {w.deg(t['temperature_2m_max'])}  ·  Low {w.deg(t['temperature_2m_min'])}"
                      f"  ·  Wind {w.speed(c['wind_speed_10m'])} {compass(c['wind_direction_10m'])}",
                      details)
            nc = w.nowcast()
            if nc:
                self.item("☂  " + nc, lambda: self.open_window("radar"))
            nws = w.p.get("nws") or {}
            for a in nws.get("alerts", [])[:4]:
                end = a.get("ends") or a.get("expires")
                until = ""
                if end:
                    try:
                        until = " until " + w.clock(datetime.datetime.fromisoformat(end).timestamp())
                    except ValueError:
                        pass
                self.item(f"⚠  {a['event']}{until}", lambda: self.open_window("alerts"))
            if self.last_error:
                self.item("⚠  " + self.last_error, sensitive=False)
            self.sep()
            rows = w.upcoming_hours(self.cfg["menu_hours"])
            hours = [w.hour_label(r["time"]) for r in rows]
            temps = [w.deg(r["temperature_2m"]) for r in rows]
            hw, tw = max(map(len, hours), default=0), max(map(len, temps), default=0)
            for r, hl, tl in zip(rows, hours, temps):
                pop = r.get("precipitation_probability") or 0
                text = (hl.rjust(hw, FIGURE_SPACE) + "    " + tl.rjust(tw, FIGURE_SPACE)
                        + ("    💧" + f"{pop}%" if pop >= 10 else "")
                        + "    " + wmo_text(r["weather_code"]).lower())
                self.item(text, lambda: self.open_window("hourly"),
                          self.icons.pixbuf(meteocon(r["weather_code"], r["is_day"]), 22))
            self.sep()
        elif self.last_error:
            self.item(self.last_error, sensitive=False)
            self.sep()
        else:
            self.item("Loading weather…", sensitive=False)
            self.sep()
        self.item("Forecast & details…", details)
        self.item("Radar…", lambda: self.open_window("radar"))
        self.sep()
        upd = "Refresh"
        if w:
            upd += f"   (updated {w.clock(self.data_time)})"
            if self.cfg["place"]:
                upd = f"{self.cfg['place']}  ·  " + upd
        self.item(upd, lambda: self.refresh(force=True))
        self.item("Settings…", lambda: self.open_window("settings"))
        self.item("Quit", self.quit)
        self.menu.show_all()
        self.indicator.set_menu(self.menu)

    def snapshot(self, tab, out, delay):
        self.open_window(tab)
        win = self.window

        def grab():
            def done(view, res):
                import cairo  # noqa: F401 - registers the foreign cairo type
                view.get_snapshot_finish(res).write_to_png(out)
                print("snapshot", out, flush=True)
            win.view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE,
                                  WebKit2.SnapshotOptions.NONE, None, done)
            return False
        GLib.timeout_add(int(delay * 1000), grab)

    def open_window(self, tab):
        if self.window is None:
            self.window = ForecastWindow(self, tab)
        else:
            self.window.show_tab(tab)
        self.window.present()


def main():
    app = SkyTray()
    return app.run(sys.argv)


if __name__ == "__main__":
    sys.exit(main())
