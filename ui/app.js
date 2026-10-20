/* Copyright (C) 2026 G. Austin Servantes
 * SPDX-License-Identifier: GPL-3.0-or-later */
/* SkyTray forecast window. State is pushed in from Python via App.setState(). */
"use strict";

const ICONS = "../icons/meteocons/";
const WMO = {
  0: ["Clear", "clear-{dn}"], 1: ["Mostly clear", "clear-{dn}"],
  2: ["Partly cloudy", "partly-cloudy-{dn}"], 3: ["Overcast", "overcast"],
  45: ["Fog", "fog-{dn}"], 48: ["Freezing fog", "fog-{dn}"],
  51: ["Light drizzle", "drizzle"], 53: ["Drizzle", "drizzle"], 55: ["Heavy drizzle", "drizzle"],
  56: ["Freezing drizzle", "sleet"], 57: ["Freezing drizzle", "sleet"],
  61: ["Light rain", "rain"], 63: ["Rain", "rain"], 65: ["Heavy rain", "rain"],
  66: ["Freezing rain", "sleet"], 67: ["Freezing rain", "sleet"],
  71: ["Light snow", "snow"], 73: ["Snow", "snow"], 75: ["Heavy snow", "snow"], 77: ["Snow grains", "snow"],
  80: ["Light showers", "partly-cloudy-{dn}-rain"], 81: ["Showers", "partly-cloudy-{dn}-rain"],
  82: ["Heavy showers", "partly-cloudy-{dn}-rain"],
  85: ["Snow showers", "partly-cloudy-{dn}-snow"], 86: ["Heavy snow showers", "partly-cloudy-{dn}-snow"],
  95: ["Thunderstorms", "thunderstorms-{dn}-rain"], 96: ["Thunderstorms, hail", "thunderstorms-rain"],
  99: ["Severe thunderstorms, hail", "thunderstorms-rain"],
};
const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
const SVGNS = "http://www.w3.org/2000/svg";
function sv(tag, attrs = {}, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (text != null) e.textContent = text;
  return e;
}
function post(msg) {
  try { window.webkit.messageHandlers.app.postMessage(JSON.stringify(msg)); }
  catch (e) { console.log("post failed", msg, e); }
}

const wmoText = c => (WMO[c] || ["Unknown"])[0];
const iconUrl = (c, day) => ICONS + ((WMO[c] || [0, "not-available"])[1]).replace("{dn}", day ? "day" : "night") + ".svg";
const img = (src, alt = "") => el("img", { src, alt, loading: "lazy" });
const compass = d => d == null ? "" : COMPASS[Math.round((d % 360) / 22.5) % 16];

const App = {
  state: null, tab: "now", hourlyRange: 48, openDays: new Set(),

  // ---------- entry points from Python
  setState(s) {
    this.state = s;
    document.documentElement.dataset.theme = s.dark ? "dark" : "light";
    $("#refresh").classList.remove("spin");
    const err = $("#error");
    err.hidden = !s.error; err.textContent = s.error || "";
    this.render();
    if (window.Radar) Radar.onState(s);
  },
  setBusy(b) { $("#refresh").classList.toggle("spin", !!b); },
  showTab(t) {
    if (t === "alerts" && !this.alerts().length) t = "now";
    this.tab = t;
    $$("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === t));
    $$(".tab").forEach(p => p.classList.toggle("active", p.id === "panel-" + t));
    if (t === "radar" && window.Radar) Radar.activate();
    else if (window.Radar) Radar.deactivate();
    if (t === "hourly") this.renderHourly();
    if (t === "history" && this.om) this.renderHistory();   // chart width depends on being visible
    $("main").scrollTop = 0;
  },

  // ---------- formatting
  get cfg() { return this.state.config; },
  get om() { return this.state && this.state.weather && this.state.weather.om; },
  get imperial() { return this.cfg.units === "imperial"; },
  get tz() { return (this.om && this.om.timezone) || undefined; },
  fmt(ts, opts) {
    return new Intl.DateTimeFormat(undefined, { timeZone: this.tz, hour12: this.imperial, ...opts })
      .format(new Date(ts * 1000));
  },
  hour(ts) { return this.imperial ? this.fmt(ts, { hour: "numeric" }).replace(" ", " ") : this.fmt(ts, { hour: "2-digit", minute: "2-digit" }); },
  clock(ts) { return this.fmt(ts, { hour: "numeric", minute: "2-digit" }); },
  dayKey(ts) { return this.fmt(ts, { year: "numeric", month: "2-digit", day: "2-digit" }); },
  deg(v) { return v == null ? "–" : Math.round(v) + "°"; },
  speed(v) { return v == null ? "–" : Math.round(v) + (this.imperial ? " mph" : " km/h"); },
  amount(v) {
    if (v == null) return "–";
    return this.imperial ? (v < 0.005 && v > 0 ? "<0.01" : v.toFixed(2)) + " in" : v.toFixed(1) + " mm";
  },
  snow(v) {  // Open-Meteo snowfall: inches (imperial) or cm
    return this.imperial ? v.toFixed(1) + " in" : v.toFixed(1) + " cm";
  },
  vis(v) {  // feet (imperial) or metres
    if (v == null) return "–";
    return this.imperial ? (v / 5280 >= 10 ? "10+ mi" : (v / 5280).toFixed(1) + " mi")
                         : (v / 1000 >= 10 ? "10+ km" : (v / 1000).toFixed(1) + " km");
  },
  pressure(v) { return v == null ? "–" : this.imperial ? (v * 0.02953).toFixed(2) + " inHg" : Math.round(v) + " hPa"; },
  duration(s) { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return `${h}h ${m}m`; },

  hourlyRows(fromNow = true, limit = 9999) {
    const h = this.om.hourly, now = Date.now() / 1000, rows = [];
    for (let i = 0; i < h.time.length && rows.length < limit; i++) {
      if (fromNow && h.time[i] + 3600 <= now) continue;
      const r = {}; for (const k in h) r[k] = h[k][i]; rows.push(r);
    }
    return rows;
  },
  dailyRows() {
    const d = this.om.daily, rows = [];
    for (let i = 0; i < d.time.length; i++) { const r = {}; for (const k in d) r[k] = d[k][i]; rows.push(r); }
    return rows;
  },
  alerts() { const n = this.state && this.state.weather && this.state.weather.nws; return (n && n.alerts) || []; },

  nowcast() {
    const m = this.om.minutely_15; if (!m || !m.time) return null;
    const th = this.imperial ? 0.004 : 0.1, now = Date.now() / 1000;
    const steps = m.time.map((t, i) => ({ t, wet: (m.precipitation[i] || 0) >= th, snow: (m.snowfall[i] || 0) > 0 }))
      .filter(s => s.t + 900 > now);
    if (!steps.length) return null;
    const kind = steps.some(s => s.wet && s.snow) ? "Snow" : "Rain";
    if (steps[0].wet) {
      const end = steps.find(s => !s.wet);
      return end ? `${kind} ending around ${this.clock(end.t)}` : `${kind} continuing for the next few hours`;
    }
    const start = steps.find(s => s.wet);
    return start ? `${kind} starting around ${this.clock(start.t)}` : null;
  },

  // ---------- render
  render() {
    const s = this.state;
    $("#place-name").textContent = s.config.place || (s.config.lat != null ? `${s.config.lat.toFixed(2)}, ${s.config.lon.toFixed(2)}` : "Locating…");
    this.renderSettings();
    document.body.classList.toggle("no-data", !this.om);
    if (!this.om) { $("#updated").textContent = s.error ? "" : "Loading…"; return; }
    $("#updated").textContent = "Updated " + new Date(s.fetchedAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const n = this.alerts().length;
    $("#tab-alerts").hidden = !n;
    $("#alert-count").textContent = n || "";
    this.renderNow();
    this.renderHourly();
    this.renderDaily();
    this.renderHistory();
    this.renderAlerts();
  },

  renderNow() {
    const c = this.om.current, now = Date.now() / 1000;
    const today = this.dailyRows().find(d => this.dayKey(d.time) === this.dayKey(now)) || this.dailyRows()[0];
    $("#hero").dataset.sky = skyKind(c.weather_code, c.is_day);
    $("#hero-icon").src = iconUrl(c.weather_code, c.is_day);
    $("#hero-temp").textContent = this.deg(c.temperature_2m);
    $("#hero-cond").textContent = wmoText(c.weather_code);
    $("#hero-feels").textContent = this.deg(c.apparent_temperature);
    $("#hero-hi").textContent = this.deg(today.temperature_2m_max);
    $("#hero-lo").textContent = this.deg(today.temperature_2m_min);
    const nc = this.nowcast();
    const ncEl = $("#nowcast");
    ncEl.textContent = nc || "No rain or snow expected in the next 6 hours";
    ncEl.classList.toggle("wet", !!nc);

    // NWS narrative for the current and next period
    const nws = this.state.weather.nws, box = $("#nws-now");
    box.replaceChildren();
    if (nws && nws.periods && nws.periods.length) {
      for (const p of nws.periods.slice(0, 2))
        box.append(el("div", { class: "nws-period" }, el("div", { class: "nws-name", text: p.name }), el("p", { text: p.detailedForecast })));
    }

    // alert banners
    const strip = $("#alert-strip"); strip.replaceChildren();
    for (const a of this.alerts()) {
      const severe = ["Severe", "Extreme"].includes(a.severity);
      strip.append(el("a", { class: "alert-banner" + (severe ? " severe" : ""), href: "#", onclick: e => { e.preventDefault(); this.showTab("alerts"); } },
        el("span", { class: "alert-ico", text: "⚠" }), el("b", { text: a.event }), el("span", { text: a.headline || "" })));
    }

    this.renderMinutecast();
    this.renderStrip();
    this.renderTiles(c, today);
  },

  // Next 24 hours: columns with a temperature curve running through them.
  renderStrip() {
    const st = $("#strip-24"); st.replaceChildren();
    const rows = this.hourlyRows(true, 25), now = Date.now() / 1000;
    const COL = 64, CURVE = 56;
    if (!rows.length) return;
    const temps = rows.map(r => r.temperature_2m).filter(v => v != null);
    const tmin = Math.min(...temps), tmax = Math.max(...temps), span = Math.max(1, tmax - tmin);
    const y = v => 22 + (CURVE - 30) * (1 - (v - tmin) / span);
    const inner = el("div", { class: "strip-inner", style: `width:${rows.length * COL}px` });
    const svg = sv("svg", { class: "strip-curve", width: rows.length * COL, height: CURVE, viewBox: `0 0 ${rows.length * COL} ${CURVE}` });
    const pts = rows.map((r, i) => [i * COL + COL / 2, y(r.temperature_2m ?? tmin)]);
    svg.append(sv("path", { d: smoothPath(pts), fill: "none", stroke: "var(--temp)", "stroke-width": 2, "stroke-linecap": "round" }));
    rows.forEach((r, i) => {
      const hr = +this.fmt(r.time, { hour: "numeric", hour12: false }) % 24;
      if (hr === 0 && i > 0) svg.append(sv("line", { x1: i * COL, x2: i * COL, y1: 0, y2: CURVE, class: "strip-midnight" }));
      svg.append(sv("circle", { cx: pts[i][0], cy: pts[i][1], r: 3, fill: "var(--temp)", stroke: "var(--surface)", "stroke-width": 2 }));
      svg.append(sv("text", { x: pts[i][0], y: pts[i][1] - 9, "text-anchor": "middle", class: "strip-temp" }, this.deg(r.temperature_2m)));
    });
    const cols = el("div", { class: "strip-cols" });
    rows.forEach((r, i) => {
      const isNow = r.time <= now;
      const hr = +this.fmt(r.time, { hour: "numeric", hour12: false }) % 24;
      const pop = r.precipitation_probability || 0;
      cols.append(el("div", { class: "h" + (isNow ? " now" : ""), title: wmoText(r.weather_code), style: `width:${COL}px` },
        el("div", { class: "l", text: isNow ? "Now" : hr === 0 ? this.fmt(r.time, { weekday: "short" }) : this.hour(r.time) }),
        img(iconUrl(r.weather_code, r.is_day), wmoText(r.weather_code)),
        el("div", { class: "curve-space", style: `height:${CURVE}px` }),
        el("div", { class: "pop" + (pop >= 30 ? " hi" : ""), text: pop >= 10 ? "💧" + pop + "%" : "" })));
    });
    inner.append(cols, svg);
    svg.style.top = "74px";
    st.append(inner);
  },

  renderTiles(c, today) {
    const tiles = $("#tiles"); tiles.replaceChildren();
    const aq = this.state.weather.aq, now = Date.now() / 1000;
    const tile = ({ icon, label, value, unit, graphic, note, cls }) => tiles.append(el("div", { class: "tile" + (cls ? " " + cls : "") },
      el("div", { class: "k" }, img(ICONS + icon + ".svg"), el("span", { text: label })),
      el("div", { class: "tile-body" },
        el("div", { class: "tile-val" }, el("span", { class: "v", text: value }), unit ? el("span", { class: "u", text: unit }) : null),
        graphic || null),
      note ? el("div", { class: "s", text: note }) : null));
    const spd = v => [String(Math.round(v)), this.imperial ? "mph" : "km/h"];

    // Wind
    const [ws, wu] = spd(c.wind_speed_10m);
    tile({ icon: "wind", label: "Wind", value: ws, unit: wu, graphic: windDial(c.wind_direction_10m),
           note: `${beaufort(c.wind_speed_10m, this.imperial)} from the ${compass(c.wind_direction_10m)} · gusts ${this.speed(c.wind_gusts_10m)}` });

    // Sun (wide)
    // After sunset the tile is about tomorrow: its sunrise, arc and day length.
    const afterSunset = now >= today.sunset;
    const sunDay = afterSunset ? (this.dailyRows().find(d => d.sunrise > now) || today) : today;
    const rise = sunDay.sunrise, set = sunDay.sunset;
    const next = now < rise ? ["Sunrise", rise] : ["Sunset", set];
    const until = Math.max(0, next[1] - now);
    tile({ icon: next[0] === "Sunset" ? "sunset" : "sunrise", label: next[0], value: this.clock(next[1]), cls: "wide",
           graphic: sunArc(rise, set, now, this.clock(rise), this.clock(set)),
           note: `in ${this.duration(until)} · ${this.duration(sunDay.daylight_duration)} of daylight ${afterSunset ? "tomorrow" : "today"}` });

    // Precipitation
    const pToday = today.precipitation_probability_max ?? 0;
    const upcoming = this.hourlyRows(true, 24).reduce((s, r) => s + (r.precipitation || 0), 0);
    tile({ icon: "raindrops", label: "Precipitation", value: this.amount(upcoming).split(" ")[0], unit: (this.imperial ? "in" : "mm") + " next 24 h",
           graphic: meter(pToday, 100, "var(--precip)", `${pToday}% chance today`),
           note: upcoming > 0 ? `${this.amount(today.precipitation_sum)} expected today` : "Dry for the next 24 hours" });

    // Humidity
    tile({ icon: "humidity", label: "Humidity", value: String(c.relative_humidity_2m), unit: "%",
           graphic: meter(c.relative_humidity_2m, 100, "var(--accent)", null),
           note: `Dew point ${this.deg(c.dew_point_2m)} · ${dewComfort(c.dew_point_2m, this.imperial)}` });

    // UV
    const uv = c.uv_index ?? 0;
    const peak = this.hourlyRows(false).filter(r => this.dayKey(r.time) === this.dayKey(now)).reduce((a, b) => (b.uv_index ?? 0) > (a.uv_index ?? 0) ? b : a, { uv_index: -1 });
    tile({ icon: "uv-index", label: "UV index", value: uv.toFixed(uv < 10 ? 1 : 0), unit: uvText(uv),
           graphic: scale(uv, 12, UV_SCALE),
           note: peak.time ? (peak.time > now ? `Peaks at ${Math.round(peak.uv_index)} around ${this.hour(peak.time)}` : `Peaked at ${Math.round(peak.uv_index)} today`) : "" });

    // Air quality
    if (aq && aq.us_aqi != null && this.state.inUS)
      tile({ icon: "smoke", label: "Air quality", value: String(aq.us_aqi), unit: "US AQI", graphic: scale(aq.us_aqi, 300, AQI_SCALE),
             note: `${aqiText(aq.us_aqi)} · PM2.5 ${Math.round(aq.pm2_5)} µg/m³` });
    else if (aq && aq.european_aqi != null)
      tile({ icon: "smoke", label: "Air quality", value: String(aq.european_aqi), unit: "EAQI", note: `PM2.5 ${Math.round(aq.pm2_5)} µg/m³` });

    // Pressure with a 24 h trend line (12 h back, 12 h ahead)
    const hrs = this.hourlyRows(false), ni = hrs.findIndex(r => r.time > now);
    const win = hrs.slice(Math.max(0, ni - 12), ni + 12).map(r => r.pressure_msl);
    const pv = this.pressure(c.pressure_msl).split(" ");
    const spark = sparkline(win, Math.min(12, ni), "var(--text-2)");
    tile({ icon: "barometer", label: "Pressure", value: pv[0], unit: pv[1],
           graphic: spark && el("div", {}, spark, el("div", { class: "spark-axis" }, el("span", { text: "−12 h" }), el("span", { text: "now" }), el("span", { text: "+12 h" }))),
           note: this.pressureTrend() });

    // Clouds & visibility
    tile({ icon: c.is_day ? "partly-cloudy-day" : "partly-cloudy-night", label: "Cloud cover", value: String(c.cloud_cover), unit: "%",
           graphic: meter(c.cloud_cover, 100, "var(--text-2)", null),
           note: c.cloud_cover < 12 ? "Clear skies" : c.cloud_cover < 40 ? "Mostly clear" : c.cloud_cover < 70 ? "Partly cloudy" : c.cloud_cover < 90 ? "Mostly cloudy" : "Overcast" });

    // Visibility
    const miles = (c.visibility ?? 0) / (this.imperial ? 5280 : 1609.34);
    const vv = this.vis(c.visibility).split(" ");
    tile({ icon: "fog", label: "Visibility", value: vv[0], unit: vv[1],
           graphic: meter(Math.min(miles, 10), 10, "var(--text-2)", null),
           note: miles >= 6 ? "Clear view" : miles >= 3 ? "Slight haze" : miles >= 1 ? "Hazy or misty" : miles >= 0.25 ? "Fog" : "Dense fog" });

    // Moon
    const mp = moonPhase(Date.now());
    const phases = el("div", { class: "moon-phases" });
    const moonDates = [["New", "moon-new", 0], ["First quarter", "moon-first-quarter", 0.25], ["Full", "moon-full", 0.5], ["Last quarter", "moon-last-quarter", 0.75]]
      .map(([name, icon, target]) => [name, icon, moonNext(Date.now(), target)]).sort((a, b) => a[2] - b[2]);
    for (const [name, icon, t] of moonDates) {
      phases.append(el("div", { title: name + " moon" }, img(ICONS + icon + ".svg"), el("div", { text: this.fmt(t / 1000, { month: "short", day: "numeric" }) })));
    }
    tile({ icon: mp.icon, label: "Moon", value: mp.name, cls: "moon wide",
           graphic: el("div", { class: "moon-body" }, img(ICONS + mp.icon + ".svg"), phases),
           note: `${Math.round(mp.illum * 100)}% lit · full moon ${this.fmt(mp.nextFull / 1000, { month: "short", day: "numeric" })}` });
  },

  pressureTrend() {
    const rows = this.hourlyRows(false), now = Date.now() / 1000;
    const i = rows.findIndex(r => r.time > now);
    if (i < 4) return "";
    const d = rows[i].pressure_msl - rows[i - 4].pressure_msl;
    return Math.abs(d) < 0.8 ? "Steady" : d > 0 ? "Rising" : "Falling";
  },

  renderMinutecast() {
    const m = this.om.minutely_15, box = $("#minutecast");
    const now = Date.now() / 1000;
    if (!m || !m.time) { box.hidden = true; return; }
    const pts = m.time.map((t, i) => ({ t, v: m.precipitation[i] || 0 })).filter(p => p.t + 900 > now);
    if (!pts.some(p => p.v > 0)) { box.hidden = true; return; }
    box.hidden = false;
    const host = $("#minutecast-chart"); host.replaceChildren();
    const W = host.clientWidth || 800, H = 110, L = 44, R = 8, T = 8, B = 20;
    const max = Math.max(...pts.map(p => p.v)) * 1.15;
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, height: H });
    const bw = (W - L - R) / pts.length;
    [0, 0.5, 1].forEach(f => {
      const y = T + (H - T - B) * (1 - f);
      svg.append(sv("line", { class: "grid", x1: L, x2: W - R, y1: y, y2: y }));
      svg.append(sv("text", { x: L - 6, y: y + 4, "text-anchor": "end" }, this.imperial ? (max * f).toFixed(2) : (max * f).toFixed(1)));
    });
    pts.forEach((p, i) => {
      const h = (H - T - B) * p.v / max, x = L + i * bw + 1;
      if (h > 0) {
        const r = sv("rect", { x, y: H - B - h, width: Math.max(1, bw - 2), height: h, rx: 2, fill: "var(--precip)" });
        r.addEventListener("pointermove", e => showTip(e, [el("div", { class: "tt-h", text: this.clock(p.t) }), el("div", { class: "row" }, el("b", { text: this.amount(p.v) }), el("span", { text: "in 15 min" }))]));
        r.addEventListener("pointerleave", hideTip);
        svg.append(r);
      }
      if (i % 4 === 0) svg.append(sv("text", { x: x + bw / 2, y: H - 4, "text-anchor": "middle" }, this.clock(p.t)));
    });
    host.append(svg);
  },

  // ---------- hourly
  renderHourly() {
    if (!this.om) return;
    const rows = this.hourlyRows(true, this.hourlyRange);
    this.drawHourlyChart($("#hourly-chart"), rows);
    const t = $("#hourly-table"); t.replaceChildren();
    t.append(el("thead", {}, el("tr", {}, ...["Time", "", "Conditions", "Temp", "Feels", "Precip", "Amount", "Wind", "Gust", "Humidity", "UV", "Cloud"]
      .map((h, i) => el("th", { class: i === 2 ? "cond" : null, text: h })))));
    const tb = el("tbody"); let lastDay = null;
    for (const r of rows) {
      const dk = this.dayKey(r.time);
      if (dk !== lastDay) {
        tb.append(el("tr", { class: "dayrow" }, el("td", { colspan: 12, text: this.fmt(r.time, { weekday: "long", month: "short", day: "numeric" }) })));
        lastDay = dk;
      }
      tb.append(el("tr", {},
        el("td", { text: this.hour(r.time) }),
        el("td", {}, img(iconUrl(r.weather_code, r.is_day))),
        el("td", { class: "cond", text: wmoText(r.weather_code) }),
        el("td", { text: this.deg(r.temperature_2m) }),
        el("td", { text: this.deg(r.apparent_temperature) }),
        el("td", { text: (r.precipitation_probability ?? 0) + "%" }),
        el("td", { text: r.precipitation > 0 ? this.amount(r.precipitation) : "–" }),
        el("td", { text: `${this.speed(r.wind_speed_10m)} ${compass(r.wind_direction_10m)}` }),
        el("td", { text: this.speed(r.wind_gusts_10m) }),
        el("td", { text: r.relative_humidity_2m + "%" }),
        el("td", { text: r.uv_index == null ? "–" : Math.round(r.uv_index) }),
        el("td", { text: r.cloud_cover + "%" })));
    }
    t.append(tb);
  },

  drawHourlyChart(host, rows, mode = "chance") {
    host.replaceChildren();
    const W = host.clientWidth; if (!W || rows.length < 2) return;
    const L = 40, R = 12, P1T = 26, P1H = 170, GAP = 34, P2H = 70, B = 22;
    const H = P1T + P1H + GAP + P2H + B;
    const n = rows.length, x = i => L + i * (W - L - R) / (n - 1);
    const temps = rows.flatMap(r => [r.temperature_2m, r.apparent_temperature]);
    let tmin = Math.floor(Math.min(...temps) / 5) * 5, tmax = Math.ceil(Math.max(...temps) / 5) * 5;
    if (tmax - tmin < 10) tmax = tmin + 10;
    const yT = v => P1T + P1H * (1 - (v - tmin) / (tmax - tmin));
    const amt = mode === "amount";
    const pv = r => amt ? (r.precipitation || 0) : (r.precipitation_probability || 0);
    const pmax = amt ? Math.max(this.imperial ? 0.1 : 2.5, ...rows.map(pv)) : 100;
    const p2top = P1T + P1H + GAP, yP = v => p2top + P2H * (1 - v / pmax);
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, height: H, role: "img", "aria-label": "Hourly temperature and precipitation chance" });

    // night shading: one band per run of night hours (separate rects leave hairline seams)
    const half = (W - L - R) / (n - 1) / 2;
    for (let i = 0; i < n; i++) {
      if (rows[i].is_day) continue;
      let j = i; while (j + 1 < n && !rows[j + 1].is_day) j++;
      const x0 = Math.max(L, x(i) - half), x1 = Math.min(W - R, x(j) + half);
      svg.append(sv("rect", { x: x0, y: P1T, width: x1 - x0, height: p2top + P2H - P1T, fill: "var(--night)" }));
      i = j;
    }
    // temperature grid
    const step = (tmax - tmin) > 40 ? 20 : 10;
    for (let v = Math.ceil(tmin / step) * step; v <= tmax; v += step) {
      svg.append(sv("line", { class: "grid", x1: L, x2: W - R, y1: yT(v), y2: yT(v) }));
      svg.append(sv("text", { x: L - 6, y: yT(v) + 4, "text-anchor": "end" }, v + "°"));
    }
    [0, 0.5, 1].forEach(f => {
      const v = f * pmax;
      svg.append(sv("line", { class: "grid", x1: L, x2: W - R, y1: yP(v), y2: yP(v) }));
      svg.append(sv("text", { x: L - 6, y: yP(v) + 4, "text-anchor": "end" },
        amt ? v.toFixed(this.imperial ? 2 : 1) : Math.round(v) + "%"));
    });
    svg.append(sv("text", { class: "panel-title", x: L, y: P1T - 10 }, "Temperature"));
    const legend = sv("g", { transform: `translate(${L + 100}, ${P1T - 14})` });
    legend.append(sv("line", { x1: 0, x2: 14, y1: 0, y2: 0, stroke: "var(--temp)", "stroke-width": 2 }));
    legend.append(sv("text", { x: 18, y: 4 }, "Actual"));
    legend.append(sv("line", { x1: 70, x2: 84, y1: 0, y2: 0, stroke: "var(--temp)", "stroke-width": 2, "stroke-dasharray": "3 3", opacity: 0.6 }));
    legend.append(sv("text", { x: 88, y: 4 }, "Feels like"));
    svg.append(legend);
    svg.append(sv("text", { class: "panel-title", x: L, y: p2top - 10 }, amt ? `Precipitation per hour (${this.imperial ? "in" : "mm"})` : "Chance of precipitation"));

    // day boundaries and x labels
    const everyH = n <= 48 ? 3 : n <= 168 ? 12 : 24;
    rows.forEach((r, i) => {
      const hr = +this.fmt(r.time, { hour: "numeric", hour12: false }) % 24;
      if (hr === 0 && i > 0) {
        svg.append(sv("line", { class: "dayline", x1: x(i), x2: x(i), y1: P1T, y2: p2top + P2H }));
        svg.append(sv("text", { class: "lbl", x: x(i) + 4, y: P1T + 12 }, this.fmt(r.time, { weekday: "short" }) + " " + this.fmt(r.time, { day: "numeric" })));
      }
      if (hr % everyH === 0)
        svg.append(sv("text", { x: x(i), y: H - 6, "text-anchor": "middle" }, n <= 48 ? this.hour(r.time) : (hr === 0 ? this.fmt(r.time, { weekday: "short" }) : this.hour(r.time))));
    });

    // precip bars
    const bw = Math.max(1, Math.min(14, (W - L - R) / n - 2));
    rows.forEach((r, i) => {
      const v = pv(r); if (!v) return;
      svg.append(sv("rect", { x: x(i) - bw / 2, y: yP(v), width: bw, height: p2top + P2H - yP(v), rx: Math.min(2, bw / 2), fill: "var(--precip)" }));
    });
    // lines
    const path = key => rows.map((r, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yT(r[key]).toFixed(1)}`).join("");
    svg.append(sv("path", { d: path("apparent_temperature"), fill: "none", stroke: "var(--temp)", "stroke-width": 2, "stroke-dasharray": "3 3", opacity: 0.6 }));
    svg.append(sv("path", { d: path("temperature_2m"), fill: "none", stroke: "var(--temp)", "stroke-width": 2, "stroke-linejoin": "round" }));
    // selective direct labels: highs and lows per day
    const byDay = {};
    rows.forEach((r, i) => { (byDay[this.dayKey(r.time)] ||= []).push(i); });
    if (n <= 168) for (const idx of Object.values(byDay)) {
      if (idx.length < 6) continue;
      const hi = idx.reduce((a, b) => rows[b].temperature_2m > rows[a].temperature_2m ? b : a);
      const lo = idx.reduce((a, b) => rows[b].temperature_2m < rows[a].temperature_2m ? b : a);
      svg.append(sv("text", { class: "lbl", x: x(hi), y: yT(rows[hi].temperature_2m) - 8, "text-anchor": "middle" }, this.deg(rows[hi].temperature_2m)));
      svg.append(sv("text", { class: "lbl", x: x(lo), y: yT(rows[lo].temperature_2m) + 16, "text-anchor": "middle" }, this.deg(rows[lo].temperature_2m)));
    }

    // crosshair + tooltip
    const cross = sv("line", { class: "cross", y1: P1T, y2: p2top + P2H, visibility: "hidden" });
    const dot = sv("circle", { r: 4, fill: "var(--temp)", stroke: "var(--surface)", "stroke-width": 2, visibility: "hidden" });
    svg.append(cross, dot);
    const hit = sv("rect", { x: L, y: 0, width: W - L - R, height: H, fill: "transparent" });
    hit.addEventListener("pointermove", e => {
      const b = svg.getBoundingClientRect();
      const px = (e.clientX - b.left) * (W / b.width);
      const i = Math.max(0, Math.min(n - 1, Math.round((px - L) / ((W - L - R) / (n - 1)))));
      const r = rows[i];
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x(i)); dot.setAttribute("cy", yT(r.temperature_2m)); dot.setAttribute("visibility", "visible");
      showTip(e, this.hourTip(r, amt));
    });
    hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTip(); });
    svg.append(hit);
    host.append(svg);
  },

  hourTip(r, history = false) {
    const row = (v, k, color) => el("div", { class: "row" }, el("b", { text: v }), el("span", {}, color ? el("i", { class: "key", style: `background:${color}` }) : null, k));
    return [
      el("div", { class: "tt-h" }, img(iconUrl(r.weather_code, r.is_day)),
        this.fmt(r.time, { weekday: "short", hour: "numeric", minute: this.imperial ? undefined : "2-digit" }) + " · " + wmoText(r.weather_code)),
      row(this.deg(r.temperature_2m), "Temperature", "var(--temp)"),
      row(this.deg(r.apparent_temperature), "Feels like"),
      history ? null : row((r.precipitation_probability ?? 0) + "%", "Precip chance", "var(--precip)"),
      history ? row(this.amount(r.precipitation || 0), "Precipitation", "var(--precip)")
              : r.precipitation > 0 ? row(this.amount(r.precipitation), "Amount") : null,
      row(`${this.speed(r.wind_speed_10m)} ${compass(r.wind_direction_10m)}`, "Wind"),
      row(r.relative_humidity_2m + "%", "Humidity"),
    ];
  },

  // ---------- daily
  renderDaily() {
    const list = $("#daily-list"); list.replaceChildren();
    const todayKey = this.dayKey(Date.now() / 1000);
    const all = this.dailyRows(), t0 = Math.max(0, all.findIndex(d => this.dayKey(d.time) === todayKey));
    const days = all.slice(t0);
    const lo = Math.min(...days.map(d => d.temperature_2m_min));
    const hi = Math.max(lo + 1, ...days.map(d => d.temperature_2m_max));
    const periods = (this.state.weather.nws && this.state.weather.nws.periods) || [];
    days.forEach((d, i) => {
      if (i === 7) list.append(el("div", { class: "divider", text: "Extended outlook — lower confidence" }));
      const key = this.dayKey(d.time);
      const name = key === todayKey ? "Today" : i === 1 ? "Tomorrow" : this.fmt(d.time, { weekday: "long" });
      const left = (d.temperature_2m_min - lo) / (hi - lo) * 100, width = (d.temperature_2m_max - d.temperature_2m_min) / (hi - lo) * 100;
      const wrap = el("div", { class: "day" + (i >= 7 ? " low-conf" : "") + (this.openDays.has(key) ? " open" : "") });
      const row = el("div", { class: "day-row", onclick: () => { wrap.classList.toggle("open"); this.openDays.has(key) ? this.openDays.delete(key) : this.openDays.add(key); } },
        el("div", {}, el("div", { class: "dn", text: name }), el("div", { class: "dd", text: this.fmt(d.time, { month: "short", day: "numeric" }) })),
        img(iconUrl(d.weather_code, true), wmoText(d.weather_code)),
        el("div", { class: "cond", text: wmoText(d.weather_code) }),
        el("div", { class: "pop", text: d.precipitation_probability_max >= 10 ? "💧" + d.precipitation_probability_max + "%" : "" }),
        el("div", { class: "lo", text: this.deg(d.temperature_2m_min) }),
        el("div", { class: "rangebar" }, el("i", { style: `left:${left}%;width:${Math.max(width, 2)}%` })),
        el("div", { class: "hi", text: this.deg(d.temperature_2m_max) }),
        el("div", { class: "wind", text: `${this.speed(d.wind_speed_10m_max)} ${compass(d.wind_direction_10m_dominant)}` }));
      const det = el("div", { class: "day-detail" });
      const ps = periods.filter(p => this.dayKey(Date.parse(p.startTime) / 1000) === key);
      if (ps.length) det.append(el("div", { class: "nws" }, ps.map(p => el("p", {}, el("b", { text: p.name + ": " }), p.detailedForecast))));
      const f = (k, v) => el("div", {}, el("span", { text: k + " " }), v);
      det.append(el("div", { class: "facts" },
        f("Feels like", `${this.deg(d.apparent_temperature_min)} – ${this.deg(d.apparent_temperature_max)}`),
        f("Precip", `${this.amount(d.precipitation_sum)} over ${Math.round(d.precipitation_hours)}h`),
        d.snowfall_sum > 0 ? f("Snow", this.snow(d.snowfall_sum)) : null,
        f("Gusts", this.speed(d.wind_gusts_10m_max)),
        f("UV max", String(Math.round(d.uv_index_max ?? 0))),
        f("Sunrise", this.clock(d.sunrise)), f("Sunset", this.clock(d.sunset)),
        f("Daylight", this.duration(d.daylight_duration))));
      const strip = el("div", { class: "strip" });
      this.hourlyRows(false).filter(r => this.dayKey(r.time) === key).forEach(r => {
        const pop = r.precipitation_probability;
        strip.append(el("div", { class: "h" }, el("div", { class: "l", text: this.hour(r.time) }),
          img(iconUrl(r.weather_code, r.is_day)), el("div", { class: "t", text: this.deg(r.temperature_2m) }),
          el("div", { class: "p", text: pop >= 10 ? pop + "%" : "" })));
      });
      det.append(strip);
      wrap.append(row, det);
      list.append(wrap);
    });
  },

  // ---------- past 7 days
  renderHistory() {
    const now = Date.now() / 1000, todayKey = this.dayKey(now);
    const rows = this.hourlyRows(false).filter(r => r.time <= now);
    const all = this.dailyRows(), t0 = all.findIndex(d => this.dayKey(d.time) === todayKey);
    const days = all.slice(0, Math.max(0, t0)).reverse();   // most recent first
    if (this.tab === "history") this.drawHourlyChart($("#history-chart"), rows, "amount");

    const sum = $("#history-summary"); sum.replaceChildren();
    if (days.length) {
      const warm = days.reduce((a, b) => b.temperature_2m_max > a.temperature_2m_max ? b : a);
      const cold = days.reduce((a, b) => b.temperature_2m_min < a.temperature_2m_min ? b : a);
      const wet = days.reduce((a, b) => (b.precipitation_sum || 0) > (a.precipitation_sum || 0) ? b : a);
      const total = days.reduce((s, d) => s + (d.precipitation_sum || 0), 0);
      const snow = days.reduce((s, d) => s + (d.snowfall_sum || 0), 0);
      const day = d => this.fmt(d.time, { weekday: "short", month: "short", day: "numeric" });
      const stat = (icon, k, v, s) => sum.append(el("div", { class: "stat" },
        img(ICONS + icon + ".svg"),
        el("div", {}, el("div", { class: "k", text: k }), el("div", { class: "v", text: v }), el("div", { class: "s", text: s }))));
      stat("raindrops", "Total precipitation", this.amount(total), `${days.filter(d => d.precipitation_sum >= (this.imperial ? 0.01 : 0.2)).length} of ${days.length} days had rain`);
      if (snow > 0) stat("snowflake", "Total snowfall", this.snow(snow), "");
      stat("thermometer-warmer", "Warmest", this.deg(warm.temperature_2m_max), day(warm));
      stat("thermometer-colder", "Coldest", this.deg(cold.temperature_2m_min), day(cold));
      if (wet.precipitation_sum > 0) stat("umbrella", "Wettest day", this.amount(wet.precipitation_sum), day(wet));
    }

    const t = $("#history-table"); t.replaceChildren();
    t.append(el("thead", {}, el("tr", {}, ...["Day", "", "Conditions", "High", "Low", "Precip", "Wet hours", "Max wind", "Gusts", "UV max"]
      .map((h, i) => el("th", { class: i === 2 ? "cond" : null, text: h })))));
    const tb = el("tbody");
    for (const d of days) {
      tb.append(el("tr", {},
        el("td", { text: this.fmt(d.time, { weekday: "short", month: "short", day: "numeric" }) }),
        el("td", {}, img(iconUrl(d.weather_code, true))),
        el("td", { class: "cond", text: wmoText(d.weather_code) }),
        el("td", { text: this.deg(d.temperature_2m_max) }),
        el("td", { text: this.deg(d.temperature_2m_min) }),
        el("td", { text: d.precipitation_sum > 0 ? this.amount(d.precipitation_sum) + (d.snowfall_sum > 0 ? ` (${this.snow(d.snowfall_sum)} snow)` : "") : "–" }),
        el("td", { text: Math.round(d.precipitation_hours || 0) || "–" }),
        el("td", { text: `${this.speed(d.wind_speed_10m_max)} ${compass(d.wind_direction_10m_dominant)}` }),
        el("td", { text: this.speed(d.wind_gusts_10m_max) }),
        el("td", { text: String(Math.round(d.uv_index_max ?? 0)) })));
    }
    t.append(tb);
  },

  renderAlerts() {
    const box = $("#alerts-list"); box.replaceChildren();
    for (const a of this.alerts()) {
      const severe = ["Severe", "Extreme"].includes(a.severity);
      const when = [a.onset && "From " + this.fmt(Date.parse(a.onset) / 1000, { weekday: "short", hour: "numeric", minute: "2-digit" }),
                    (a.ends || a.expires) && "until " + this.fmt(Date.parse(a.ends || a.expires) / 1000, { weekday: "short", hour: "numeric", minute: "2-digit" })].filter(Boolean).join(" ");
      box.append(el("div", { class: "card alert-card" + (severe ? " severe" : "") },
        el("h3", { text: a.event }),
        el("div", { text: a.headline || "" }),
        el("div", { class: "muted", text: [when, a.severity, a.senderName].filter(Boolean).join(" · ") }),
        el("pre", { text: a.description || "" }),
        a.instruction ? el("pre", {}, el("b", { text: "What to do: " }), a.instruction) : null));
    }
  },

  // ---------- settings
  renderSettings() {
    const c = this.cfg;
    const seg = (id, val) => $$(`#${id} button`).forEach(b => b.classList.toggle("active", b.dataset.v === String(val)));
    seg("set-units", c.units); seg("set-icon", c.icon_style); seg("set-refresh", c.refresh_minutes); seg("set-hours", c.menu_hours);
    $("#set-autostart").checked = this.state.autostart;
    $("#loc-current").textContent = c.lat != null ? `Current: ${c.place || "—"} (${c.lat.toFixed(3)}, ${c.lon.toFixed(3)})` : "";
  },
  bindSettings() {
    const seg = (id, key, conv = v => v) => $(`#${id}`).addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      post({ cmd: "settings", values: { [key]: conv(b.dataset.v) } });
      this.state.config[key] = conv(b.dataset.v); this.renderSettings();
    });
    seg("set-units", "units"); seg("set-icon", "icon_style");
    seg("set-refresh", "refresh_minutes", Number); seg("set-hours", "menu_hours", Number);
    $("#set-autostart").addEventListener("change", e => { post({ cmd: "settings", values: { autostart: e.target.checked } }); this.state.autostart = e.target.checked; });
    $("#loc-ip").addEventListener("click", () => { post({ cmd: "locate-ip" }); $("#loc-results").replaceChildren(); });
    let timer;
    $("#loc-search").addEventListener("input", e => {
      clearTimeout(timer);
      const q = e.target.value.trim();
      if (q.length < 2) { $("#loc-results").replaceChildren(); return; }
      timer = setTimeout(() => this.searchPlace(q), 300);
    });
  },
  async searchPlace(q) {
    const box = $("#loc-results"), seq = this.searchSeq = (this.searchSeq || 0) + 1;
    try {
      const isZip = /^\d{5}$/.test(q);
      const url = `https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name=${encodeURIComponent(q)}` + (isZip ? "&countryCode=US" : "");
      const d = await (await fetch(url)).json();
      if (seq !== this.searchSeq) return;  // a newer search is in flight
      box.replaceChildren();
      for (const r of d.results || []) {
        const label = [r.name, r.admin1, r.country_code !== "US" ? r.country : null].filter(Boolean).join(", ");
        box.append(el("button", { onclick: () => {
          post({ cmd: "settings", values: { lat: r.latitude, lon: r.longitude, place: [r.name, r.admin1].filter(Boolean).join(", ") } });
          box.replaceChildren(); $("#loc-search").value = "";
        } }, label, el("span", { class: "muted", text: `  ${r.latitude.toFixed(2)}, ${r.longitude.toFixed(2)}` })));
      }
      if (!box.children.length) box.append(el("div", { class: "muted", text: "No matches" }));
    } catch (e) { box.replaceChildren(el("div", { class: "muted", text: "Search failed: " + e })); }
  },

  init() {
    $("#tabs").addEventListener("click", e => { const b = e.target.closest("button"); if (b) this.showTab(b.dataset.tab); });
    document.addEventListener("click", e => { const a = e.target.closest("[data-goto]"); if (a) { e.preventDefault(); this.showTab(a.dataset.goto); } });
    $("#refresh").addEventListener("click", () => { this.setBusy(true); post({ cmd: "refresh" }); });
    $("#hourly-range").addEventListener("click", e => {
      const b = e.target.closest("button"); if (!b) return;
      this.hourlyRange = +b.dataset.range;
      $$("#hourly-range button").forEach(x => x.classList.toggle("active", x === b));
      this.renderHourly();
    });
    this.bindSettings();
    let rt;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if (this.om) { this.renderHourly(); this.renderMinutecast(); this.renderHistory(); } }, 150); });
  },
};

function showTip(e, content) {
  const t = $("#tooltip"); t.replaceChildren(...content.filter(Boolean)); t.hidden = false;
  const w = t.offsetWidth, h = t.offsetHeight;
  let x = e.clientX + 16, y = e.clientY + 16;
  if (x + w > innerWidth - 8) x = e.clientX - w - 16;
  if (y + h > innerHeight - 8) y = e.clientY - h - 16;
  t.style.left = x + "px"; t.style.top = y + "px";
}
function hideTip() { $("#tooltip").hidden = true; }
function uvText(u) { return u == null ? "" : u < 3 ? "Low" : u < 6 ? "Moderate" : u < 8 ? "High" : u < 11 ? "Very high" : "Extreme"; }
function aqiText(a) { return a <= 50 ? "Good" : a <= 100 ? "Moderate" : a <= 150 ? "Unhealthy for sensitive groups" : a <= 200 ? "Unhealthy" : a <= 300 ? "Very unhealthy" : "Hazardous"; }
function moonPhase(ms) {
  const syn = 29.530588853, ref = Date.UTC(2000, 0, 6, 18, 14);
  const age = (((ms - ref) / 86400000) % syn + syn) % syn, f = age / syn;
  const illum = (1 - Math.cos(2 * Math.PI * f)) / 2;
  const names = [["New moon", "moon-new"], ["Waxing crescent", "moon-waxing-crescent"], ["First quarter", "moon-first-quarter"],
    ["Waxing gibbous", "moon-waxing-gibbous"], ["Full moon", "moon-full"], ["Waning gibbous", "moon-waning-gibbous"],
    ["Last quarter", "moon-last-quarter"], ["Waning crescent", "moon-waning-crescent"]];
  const [name, icon] = names[Math.round(f * 8) % 8];
  const toFull = ((0.5 - f + 1) % 1) * syn;
  return { name, icon, illum, nextFull: ms + (toFull < 0.5 ? toFull + syn : toFull) * 86400000 };
}

// ---------- tile graphics
const UV_SCALE = [[3, "#3fae49", "Low"], [6, "#f2c200", "Moderate"], [8, "#f28c28", "High"], [11, "#e0402b", "Very high"], [12, "#9b5de5", "Extreme"]];
const AQI_SCALE = [[50, "#3fae49", "Good"], [100, "#f2c200", "Moderate"], [150, "#f28c28", "Sensitive"], [200, "#e0402b", "Unhealthy"], [300, "#9b5de5", "Very unhealthy"]];

function skyKind(code, day) {
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 51) return "rain";
  if (code === 45 || code === 48) return "fog";
  if (code === 3) return "cloudy";
  return day ? "day" : "night";
}
function smoothPath(p) {
  if (p.length < 2) return "";
  let d = `M${p[0][0]},${p[0][1]}`;
  for (let i = 0; i < p.length - 1; i++) {
    const [x0, y0] = p[Math.max(0, i - 1)], [x1, y1] = p[i], [x2, y2] = p[i + 1], [x3, y3] = p[Math.min(p.length - 1, i + 2)];
    const c1 = [x1 + (x2 - x0) / 6, y1 + (y2 - y0) / 6], c2 = [x2 - (x3 - x1) / 6, y2 - (y3 - y1) / 6];
    d += `C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${x2},${y2}`;
  }
  return d;
}
function windDial(dir) {
  const s = sv("svg", { class: "dial", viewBox: "-50 -50 100 100", width: 84, height: 84, role: "img", "aria-label": `Wind from ${compass(dir)}` });
  s.append(sv("circle", { r: 40, class: "dial-ring" }));
  for (let a = 0; a < 360; a += 30) {
    const r = a % 90 ? 36 : 33, rad = a * Math.PI / 180;
    s.append(sv("line", { x1: Math.sin(rad) * r, y1: -Math.cos(rad) * r, x2: Math.sin(rad) * 40, y2: -Math.cos(rad) * 40, class: "dial-tick" }));
  }
  [["N", 0, -24], ["E", 25, 4], ["S", 0, 31], ["W", -25, 4]].forEach(([t, x, y]) => s.append(sv("text", { x, y, "text-anchor": "middle", class: "dial-label" }, t)));
  if (dir != null) {
    // arrow points the way the wind is blowing (from `dir`, toward dir+180)
    const g = sv("g", { transform: `rotate(${dir + 180})` });
    g.append(sv("path", { d: "M0,-30 L7,-14 L2,-16 L2,26 L-2,26 L-2,-16 L-7,-14 Z", class: "dial-arrow" }));
    s.append(g);
  }
  return s;
}
function sunArc(rise, set, now, riseLbl, setLbl) {
  const W = 280, H = 96, x0 = 34, x1 = W - 34, base = 70, h = 56;
  const P = f => [x0 + (x1 - x0) * f, base - h * Math.sin(Math.PI * f)];
  const path = (fa, fb) => { let d = ""; for (let i = 0; i <= 48; i++) { const [x, y] = P(fa + (fb - fa) * i / 48); d += (i ? "L" : "M") + x.toFixed(1) + "," + y.toFixed(1); } return d; };
  const s = sv("svg", { class: "sunarc", viewBox: `0 0 ${W} ${H}`, width: "100%", height: H });
  s.append(sv("line", { x1: 6, x2: W - 6, y1: base, y2: base, class: "horizon" }));
  s.append(sv("path", { d: path(0, 1), class: "arc-track" }));
  const f = Math.max(0, Math.min(1, (now - rise) / (set - rise)));
  if (f > 0) s.append(sv("path", { d: path(0, f), class: "arc-done" }));
  if (now > rise && now < set) { const [x, y] = P(f); s.append(sv("circle", { cx: x, cy: y, r: 7, class: "sun-dot" })); }
  s.append(sv("text", { x: x0, y: H - 4, "text-anchor": "middle", class: "arc-lbl" }, riseLbl));
  s.append(sv("text", { x: x1, y: H - 4, "text-anchor": "middle", class: "arc-lbl" }, setLbl));
  return s;
}
function meter(v, max, color, label) {
  const pct = Math.max(0, Math.min(100, v / max * 100));
  return el("div", { class: "meter-wrap" },
    el("div", { class: "meter" }, el("i", { style: `width:${pct}%;background:${color}` })),
    label ? el("div", { class: "meter-lbl", text: label }) : null);
}
function scale(v, max, bands) {
  const wrap = el("div", { class: "scale-wrap" });
  const bar = el("div", { class: "scale" });
  let prev = 0;
  for (const [end, color, name] of bands) {
    bar.append(el("i", { style: `flex:${end - prev};background:${color}`, title: name }));
    prev = end;
  }
  const pct = Math.max(0, Math.min(100, v / max * 100));
  bar.append(el("b", { class: "scale-mark", style: `left:${pct}%` }));
  wrap.append(bar);
  return wrap;
}
function sparkline(vals, nowIdx, color) {
  vals = vals.filter(v => v != null);
  if (vals.length < 2) return null;
  const W = 200, H = 40, lo = Math.min(...vals), hi = Math.max(...vals), sp = Math.max(0.5, hi - lo);
  const pts = vals.map((v, i) => [i * W / (vals.length - 1), 4 + (H - 8) * (1 - (v - lo) / sp)]);
  const s = sv("svg", { class: "spark", viewBox: `0 0 ${W} ${H}`, width: "100%", height: H, preserveAspectRatio: "none" });
  s.append(sv("path", { d: smoothPath(pts), fill: "none", stroke: color, "stroke-width": 2, "vector-effect": "non-scaling-stroke" }));
  const n = pts[Math.min(nowIdx, pts.length - 1)];
  s.append(sv("line", { x1: n[0], x2: n[0], y1: 0, y2: H, class: "spark-now", "vector-effect": "non-scaling-stroke" }));
  return s;
}
function moonNext(ms, target) {  // next time the lunar phase fraction reaches `target` (0 new, .5 full)
  const syn = 29.530588853, ref = Date.UTC(2000, 0, 6, 18, 14);
  const f = ((((ms - ref) / 86400000) % syn + syn) % syn) / syn;
  let d = ((target - f + 1) % 1) * syn; if (d < 0.3) d += syn;
  return ms + d * 86400000;
}
function beaufort(v, imperial) {
  const mph = imperial ? v : v / 1.609;
  return mph < 1 ? "Calm" : mph < 4 ? "Light air" : mph < 8 ? "Light breeze" : mph < 13 ? "Gentle breeze" : mph < 19 ? "Moderate breeze"
    : mph < 25 ? "Fresh breeze" : mph < 32 ? "Strong breeze" : mph < 39 ? "Near gale" : mph < 47 ? "Gale" : "Strong gale";
}
function dewComfort(d, imperial) {
  const f = imperial ? d : d * 9 / 5 + 32;
  return f < 50 ? "dry" : f < 60 ? "comfortable" : f < 65 ? "a little sticky" : f < 70 ? "humid" : "oppressive";
}

App.init();
window.App = App;
