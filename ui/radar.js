/* Copyright (C) 2026 G. Austin Servantes
 * SPDX-License-Identifier: GPL-3.0-or-later */
/* SkyTray radar: past NEXRAD composite scans + HRRR forecast reflectivity (US, via
 * Iowa Environmental Mesonet), or RainViewer elsewhere. Each frame is a Leaflet tile
 * layer; all frames stay loaded and only the current one is visible, so playback and
 * scrubbing are instant once tiles are in. */
"use strict";

const IEM = "https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/";
const MIN = 60000;
const HRRR_MAX_F = 1080;  // HRRR sub-hourly reflectivity goes out 18 h in 15 min steps

const Radar = {
  map: null, frames: [], idx: 0, playing: false, timer: null, active: false,
  built: false, buildSeq: 0, loc: null, marker: null, opacity: 0.75, speed: 1,
  runCache: null,

  onState(s) {
    this.state = s;
    const c = s.config;
    this.opacity = c.radar_opacity; this.speed = c.radar_speed;
    $("#r-past").value = String(c.radar_past_hours);
    $("#r-future").value = String(c.radar_future_hours);
    $("#r-speed").value = String(c.radar_speed);
    $("#r-opacity").value = String(c.radar_opacity);
    const loc = c.lat != null ? [c.lat, c.lon] : null;
    const moved = loc && (!this.loc || loc[0] !== this.loc[0] || loc[1] !== this.loc[1]);
    const themeChanged = this.theme !== (s.dark ? "dark" : "light");
    this.loc = loc;
    if (this.map) {
      if (themeChanged) this.setBasemap();
      if (moved) { this.map.setView(loc, 7); this.placeMarker(); this.build(); }
    }
  },

  activate() {
    this.active = true;
    if (!this.map) this.createMap();
    else this.map.invalidateSize();
    if (!this.built || Date.now() - this.builtAt > 5 * MIN) this.build(true);
    // Pick up new scans while the tab stays open (not mid-playback: a rebuild restarts it).
    clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      if (this.active && !this.playing && Date.now() - this.builtAt > 5 * MIN) this.build(true);
    }, MIN);
  },
  deactivate() {
    this.active = false;
    clearInterval(this.refreshTimer);
    this.pause();
  },

  createMap() {
    const loc = this.loc || [39.5, -98.35];
    this.map = L.map("map", { zoomControl: true, fadeAnimation: false, minZoom: 3, maxZoom: 12, attributionControl: true })
      .setView(loc, this.loc ? 7 : 4);
    this.map.createPane("radar").style.zIndex = 350;
    this.map.createPane("labels").style.zIndex = 450;
    this.map.getPane("labels").style.pointerEvents = "none";
    this.setBasemap();
    this.placeMarker();
    this.bindControls();
  },

  setBasemap() {
    this.theme = this.state && this.state.dark ? "dark" : "light";
    const style = this.theme === "dark" ? "Dark" : "Light";
    if (this.base) this.map.removeLayer(this.base);
    if (this.labels) this.map.removeLayer(this.labels);
    const esri = `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${style}_Gray_`;
    this.base = L.tileLayer(esri + "Base/MapServer/tile/{z}/{y}/{x}", { attribution: "Basemap © Esri, HERE, Garmin, © OpenStreetMap", maxZoom: 12 }).addTo(this.map);
    this.labels = L.tileLayer(esri + "Reference/MapServer/tile/{z}/{y}/{x}", { pane: "labels", maxZoom: 12 }).addTo(this.map);
  },

  placeMarker() {
    if (!this.loc || !this.map) return;
    if (this.marker) this.marker.setLatLng(this.loc);
    else this.marker = L.circleMarker(this.loc, { radius: 6, color: "#fff", weight: 2, fillColor: "#2a78d6", fillOpacity: 1, pane: "labels" }).addTo(this.map);
  },

  inUS() { return this.state && this.state.inUS; },

  // ---------------------------------------------------------------- frames
  async build(keepPosition = false) {
    const seq = ++this.buildSeq;
    const wasPlaying = this.playing || !this.built;
    const keepT = keepPosition && this.frames[this.idx] ? this.frames[this.idx].t : null;
    this.pause();
    this.setLoading("Finding radar frames…");
    let frames;
    try {
      frames = this.inUS() ? await this.iemFrames() : await this.rainviewerFrames();
    } catch (e) {
      this.setLoading("Radar unavailable: " + e.message);
      return;
    }
    if (seq !== this.buildSeq) return;  // superseded by a newer build
    for (const f of this.frames) this.map.removeLayer(f.layer);
    this.frames = frames;
    this.loaded = 0;
    frames.forEach((f, i) => {
      f.layer = L.tileLayer(f.url, {
        opacity: 0, pane: "radar", maxNativeZoom: f.maxNative, maxZoom: 12, zIndex: i,
        updateWhenIdle: true, keepBuffer: 1, className: "radar-frame",
        attribution: f.attribution,
      });
      f.layer.on("loading", () => { if (f.ready) { f.ready = false; this.loaded--; this.updateLoading(); } });
      f.layer.on("load", () => { if (!f.ready) { f.ready = true; this.loaded++; this.updateLoading(); } });
      f.layer.addTo(this.map);
    });
    this.built = true; this.builtAt = Date.now();
    this.setupTimeline();
    const nowIdx = this.nowIndex();
    let start = nowIdx;
    if (keepT != null) start = frames.reduce((b, f, i) => Math.abs(f.t - keepT) < Math.abs(frames[b].t - keepT) ? i : b, 0);
    this.show(wasPlaying ? 0 : start);
    this.updateLoading();
    if (wasPlaying && this.active) this.play();
  },

  async iemFrames() {
    const c = this.state.config, now = Date.now();
    const pastH = c.radar_past_hours, futH = c.radar_future_hours;
    const stepPast = pastH <= 2 ? 5 : pastH <= 6 ? 10 : pastH <= 12 ? 20 : 30;
    let scans = [];
    try {
      const q = `https://mesonet.agron.iastate.edu/json/radar.py?operation=list&radar=USCOMP&product=N0Q&start=${iso(now - pastH * 60 * MIN - 5 * MIN)}&end=${iso(now)}`;
      const d = await (await fetch(q)).json();
      scans = d.scans.map(s => Date.parse(s.ts));
    } catch (e) {
      // fall back to assuming a 5-minute cadence ending 10 minutes ago
      for (let t = floorTo(now - 10 * MIN, 5); t >= now - pastH * 60 * MIN; t -= 5 * MIN) scans.unshift(t);
    }
    if (!scans.length) throw new Error("no recent scans");
    const last = scans[scans.length - 1];
    const past = scans.filter(t => t === last || (new Date(t).getUTCMinutes() % stepPast === 0 && last - t >= stepPast * MIN / 2));
    const frames = past.map(t => ({
      t, kind: "obs", maxNative: 10,
      url: `${IEM}ridge::USCOMP-N0Q-${stamp(t)}/{z}/{x}/{y}.png`,
      attribution: 'Radar: <a href="https://mesonet.agron.iastate.edu/">IEM</a> NEXRAD',
    }));
    if (futH > 0) {
      const run = await this.hrrrRun(futH);
      if (run) {
        const stepF = futH <= 6 ? 15 : 30;
        for (let t = ceilTo(last + MIN, stepF); t <= now + futH * 60 * MIN; t += stepF * MIN) {
          const f = Math.round((t - run) / MIN);
          if (f < 15 || f > HRRR_MAX_F || f % 15) continue;
          frames.push({
            t, kind: "fc", maxNative: 9, run,
            url: `${IEM}hrrr::REFD-F${String(f).padStart(4, "0")}-${stamp(run)}/{z}/{x}/{y}.png`,
            attribution: 'Forecast: NOAA HRRR via IEM',
          });
        }
      }
    }
    return frames;
  },

  // Latest HRRR run that has tiles out to the requested horizon (runs appear ~1.5 h late).
  async hrrrRun(futH) {
    const now = Date.now();
    if (this.runCache && now - this.runCache.at < 10 * MIN && this.runCache.h >= futH) return this.runCache.run;
    const [tx, ty] = tileXY(this.loc || [39.5, -98.35], 4);
    const top = floorTo(now, 60);
    for (let h = 1; h <= 6; h++) {
      const run = top - h * 60 * MIN;
      const need = Math.min(HRRR_MAX_F, Math.ceil((now + futH * 60 * MIN - run) / MIN / 15) * 15);
      const ok = await probe(`${IEM}hrrr::REFD-F0015-${stamp(run)}/4/${tx}/${ty}.png`) &&
                 await probe(`${IEM}hrrr::REFD-F${String(need).padStart(4, "0")}-${stamp(run)}/4/${tx}/${ty}.png`);
      if (ok) { this.runCache = { run, at: now, h: futH }; return run; }
    }
    return null;
  },

  async rainviewerFrames() {
    const d = await (await fetch("https://api.rainviewer.com/public/weather-maps.json")).json();
    const all = [...(d.radar.past || []).map(f => ({ ...f, kind: "obs" })), ...(d.radar.nowcast || []).map(f => ({ ...f, kind: "fc" }))];
    return all.map(f => ({
      t: f.time * 1000, kind: f.kind, maxNative: 7,
      url: `${d.host}${f.path}/256/{z}/{x}/{y}/2/1_1.png`,
      attribution: '<a href="https://www.rainviewer.com/api.html">RainViewer</a>',
    }));
  },

  nowIndex() {
    let i = 0;
    this.frames.forEach((f, k) => { if (f.kind === "obs") i = k; });
    return i;
  },

  // ---------------------------------------------------------------- display
  show(i) {
    if (!this.frames.length) return;
    i = Math.max(0, Math.min(this.frames.length - 1, i));
    const prev = this.frames[this.idx];
    if (prev && prev.layer) prev.layer.setOpacity(0);
    this.idx = i;
    const f = this.frames[i];
    f.layer.setOpacity(this.opacity);
    $("#r-slider").value = String(Math.round((f.t - this.t0) / MIN));
    const tz = App.tz, h12 = App.imperial;
    $("#stamp-time").textContent = new Intl.DateTimeFormat(undefined, { timeZone: tz, hour12: h12, hour: "numeric", minute: "2-digit", weekday: "short" }).format(new Date(f.t));
    const sub = $("#stamp-sub");
    const rel = Math.round((f.t - Date.now()) / MIN);
    if (f.kind === "fc") { sub.textContent = `Forecast · in ${fmtDur(rel)} · HRRR model`; sub.classList.add("fc"); }
    else { sub.textContent = rel > -3 ? "Latest scan" : `Observed · ${fmtDur(-rel)} ago`; sub.classList.remove("fc"); }
  },

  setupTimeline() {
    const fr = this.frames; if (!fr.length) return;
    this.t0 = fr[0].t; this.t1 = fr[fr.length - 1].t;
    const s = $("#r-slider");
    s.min = "0"; s.max = String(Math.max(1, Math.round((this.t1 - this.t0) / MIN)));
    const ticks = $("#r-ticks"); ticks.replaceChildren();
    const span = this.t1 - this.t0 || 1, pos = t => ((t - this.t0) / span * 100) + "%";
    const totalH = span / 60 / MIN;
    const every = totalH <= 4 ? 30 : totalH <= 10 ? 60 : totalH <= 20 ? 120 : totalH <= 30 ? 180 : 360;
    const fmt = new Intl.DateTimeFormat(undefined, { timeZone: App.tz, hour12: App.imperial, hour: "numeric", minute: every < 60 ? "2-digit" : undefined });
    for (let t = ceilTo(this.t0, every); t <= this.t1; t += every * MIN) {
      ticks.append(el("span", { style: `left:${pos(t)}`, text: fmt.format(new Date(t)) }));
    }
    const ni = this.nowIndex(), fc = fr.find(f => f.kind === "fc");
    if (fc) {
      ticks.append(el("div", { class: "fc-zone", style: `left:${pos(fr[ni].t)};right:0` }));
      ticks.append(el("span", { class: "now-mark", style: `left:${pos(fr[ni].t)};top:-38px`, text: "Now" }));
    }
  },

  setLoading(text) {
    const b = $("#radar-loading");
    b.hidden = !text; b.textContent = text || "";
  },
  updateLoading() {
    const n = this.frames.length;
    if (this.loaded >= n) this.setLoading(null);
    else this.setLoading(`Loading frames ${this.loaded}/${n}…`);
  },

  // ---------------------------------------------------------------- playback
  play() {
    if (!this.frames.length) return;
    this.playing = true;
    $("#r-play").textContent = "⏸";
    if (this.idx >= this.frames.length - 1) this.show(0);
    this.schedule();
  },
  pause() {
    this.playing = false;
    clearTimeout(this.timer);
    $("#r-play").textContent = "▶";
  },
  schedule() {
    clearTimeout(this.timer);
    const last = this.idx >= this.frames.length - 1;
    const atNow = this.idx === this.nowIndex() && this.idx < this.frames.length - 1;
    const base = 450 / this.speed;
    const delay = last ? 1800 : atNow ? base + 700 : base;  // hold at the end, pause briefly at "now"
    this.timer = setTimeout(() => {
      if (!this.playing) return;
      // Wait for the next frame's tiles rather than flashing an empty map.
      const next = last ? 0 : this.idx + 1;
      const f = this.frames[next];
      if (!f.ready && !this.waited) { this.waited = true; this.schedule(); return; }
      this.waited = false;
      this.show(next);
      this.schedule();
    }, delay);
  },

  bindControls() {
    $("#r-play").addEventListener("click", () => this.playing ? this.pause() : this.play());
    $("#r-prev").addEventListener("click", () => { this.pause(); this.show(this.idx - 1); });
    $("#r-next").addEventListener("click", () => { this.pause(); this.show(this.idx + 1); });
    $("#r-now").addEventListener("click", () => { this.pause(); this.show(this.nowIndex()); });
    $("#r-slider").addEventListener("input", e => {
      this.pause();
      const t = this.t0 + (+e.target.value) * MIN;
      let best = 0;
      this.frames.forEach((f, i) => { if (Math.abs(f.t - t) < Math.abs(this.frames[best].t - t)) best = i; });
      if (best !== this.idx) this.show(best);
    });
    $("#r-slider").addEventListener("change", () => this.show(this.idx));  // snap thumb to the frame
    const save = values => { Object.assign(this.state.config, values); post({ cmd: "settings", values }); };
    $("#r-past").addEventListener("change", e => { save({ radar_past_hours: +e.target.value }); this.build(); });
    $("#r-future").addEventListener("change", e => { save({ radar_future_hours: +e.target.value }); this.build(); });
    $("#r-speed").addEventListener("change", e => { this.speed = +e.target.value; save({ radar_speed: this.speed }); });
    $("#r-opacity").addEventListener("input", e => {
      this.opacity = +e.target.value;
      const f = this.frames[this.idx]; if (f) f.layer.setOpacity(this.opacity);
    });
    $("#r-opacity").addEventListener("change", e => save({ radar_opacity: +e.target.value }));
    document.addEventListener("keydown", e => {
      // Leave keys alone in form fields (sliders and selects use the arrows themselves).
      if (!this.active || e.target.matches("input, select, textarea")) return;
      // A focused button would also "click" on Space keyup and undo the toggle.
      if (e.target.matches("button")) e.target.blur();
      if (e.key === " ") { e.preventDefault(); this.playing ? this.pause() : this.play(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); this.pause(); this.show(this.idx - 1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); this.pause(); this.show(this.idx + 1); }
      else if (e.key === "Home") { this.pause(); this.show(0); }
      else if (e.key === "End") { this.pause(); this.show(this.frames.length - 1); }
      else if (e.key.toLowerCase() === "n") { this.pause(); this.show(this.nowIndex()); }
    });
  },
};

// ---------------------------------------------------------------- helpers
function pad(n) { return String(n).padStart(2, "0"); }
function stamp(t) { const d = new Date(t); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`; }
function iso(t) { return new Date(t).toISOString().slice(0, 16) + "Z"; }
function floorTo(t, min) { return Math.floor(t / (min * MIN)) * min * MIN; }
function ceilTo(t, min) { return Math.ceil(t / (min * MIN)) * min * MIN; }
function fmtDur(m) { m = Math.abs(m); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? " " + (m % 60) + " min" : ""}`; }
function tileXY([lat, lon], z) {
  const n = 2 ** z, r = lat * Math.PI / 180;
  return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n)];
}
function probe(url) {
  return new Promise(res => { const i = new Image(); i.onload = () => res(true); i.onerror = () => res(false); i.src = url; });
}

window.Radar = Radar;
