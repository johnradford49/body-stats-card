/* body-stats-card \u2014 InBody-style body composition card for Home Assistant
 * type: custom:body-stats-card
 */
const BSC_VERSION = "1.0.0";
const COLORS = { weight: "var(--primary-color, #03a9f4)", muscle: "#22c55e", fat: "#f97316", water: "#3b82f6" };
const LABELS = { weight: "Weight", muscle: "Muscle", fat: "Body fat", water: "Body water" };
// whether an increase is good (+1), bad (-1) or neutral (0)
const GOOD_DIR = { weight: 0, muscle: 1, fat: -1, water: 0 };
const ALL_TABS = ["weight", "percentage", "composition", "quadrant"];
const TAB_LABELS = { weight: "Weight", percentage: "Percentage", composition: "Composition", quadrant: "Body type" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const fmt = (v, d = 1) => (v == null ? "\u2013" : v.toFixed(d));

const FIGURES = {
  male: "M44,32 L56,32 L57,38 Q78,40 82,50 L88,112 Q89,120 84,120 L78,72 L74,72 L72,128 L70,206 Q70,212 62,212 L53,212 L51,132 L49,132 L47,212 L38,212 Q30,212 30,206 L28,128 L26,72 L22,72 L16,120 Q11,120 12,112 L18,50 Q22,40 43,38 Z",
  female: "M44,32 L56,32 L57,38 Q74,40 77,50 L84,112 Q85,120 80,120 L74,74 L70,74 Q66,96 74,130 L70,206 Q70,212 62,212 L53,212 L51,136 L49,136 L47,212 L38,212 Q30,212 30,206 L26,130 Q34,96 30,74 L26,74 L20,120 Q15,120 16,112 L23,50 Q26,40 43,38 Z",
};

class BodyStatsCard extends HTMLElement {
  static getConfigForm() {
    return {
      schema: [
        { name: "title", selector: { text: {} } },
        { name: "weight_entity", required: true, selector: { entity: { domain: "sensor" } } },
        { name: "fat_entity", selector: { entity: { domain: "sensor" } } },
        { name: "muscle_entity", selector: { entity: { domain: "sensor" } } },
        { name: "water_entity", selector: { entity: { domain: "sensor" } } },
        {
          type: "grid", name: "", schema: [
            { name: "height_cm", selector: { number: { min: 100, max: 230, step: 1, mode: "box", unit_of_measurement: "cm" } } },
            { name: "body_type", selector: { select: { mode: "dropdown", options: [{ value: "male", label: "Male" }, { value: "female", label: "Female" }] } } },
            { name: "days_to_show", selector: { number: { min: 7, max: 1825, step: 1, mode: "box", unit_of_measurement: "days" } } },
            { name: "default_tab", selector: { select: { mode: "dropdown", options: ALL_TABS.map((t) => ({ value: t, label: TAB_LABELS[t] })) } } },
          ],
        },
        { name: "tabs", selector: { select: { multiple: true, options: ALL_TABS.map((t) => ({ value: t, label: TAB_LABELS[t] })) } } },
        { name: "show_graph", selector: { boolean: {} } },
      ],
      computeLabel: (s) => ({
        title: "Title", weight_entity: "Weight sensor", fat_entity: "Body fat sensor", muscle_entity: "Muscle sensor",
        water_entity: "Body water sensor", height_cm: "Height (for BMI)", body_type: "Body figure", days_to_show: "Days of history",
        default_tab: "Default tab", tabs: "Tabs to show", show_graph: "Show graph",
      }[s.name]),
    };
  }

  static getStubConfig(hass) {
    const ids = Object.keys(hass?.states || {}).filter((e) => e.startsWith("sensor."));
    const find = (re, pred = () => true) => ids.find((e) => re.test(e) && pred(hass.states[e]));
    return {
      title: "Body stats",
      weight_entity: find(/weight/, (s) => s.attributes.unit_of_measurement === "kg") || find(/weight/) || "",
      fat_entity: find(/fat/) || "",
      muscle_entity: find(/muscle/) || "",
      water_entity: find(/water/, (s) => s.attributes.unit_of_measurement === "%") || "",
      body_type: "male",
      days_to_show: 90,
    };
  }

  setConfig(config) {
    if (!config.weight_entity) throw new Error("weight_entity is required");
    const tabs = (config.tabs && config.tabs.length ? config.tabs : ALL_TABS).filter((t) => ALL_TABS.includes(t));
    this._config = { days_to_show: 90, body_type: "male", show_graph: true, ...config, tabs };
    this._tab = tabs.includes(config.default_tab) ? config.default_tab : tabs[0];
    this._series = { weight: "weight", percentage: "fat" };
    this._idx = null; // selected weigh-in for composition / quadrant (null = latest)
    this._data = null;
    this._loadedKey = null;
    if (this._hass) this._maybeLoad(true);
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._maybeLoad(false);
  }

  connectedCallback() {
    if (!this._ro && window.ResizeObserver) {
      this._ro = new ResizeObserver((entries) => {
        const w = Math.round(entries[0].contentRect.width) - 24;
        if (w > 0 && Math.abs(w - (this._width || 0)) > 8) { this._width = w; if (this._data && this._config.show_graph !== false) this._render(); }
      });
    }
    this._ro?.observe(this);
  }
  disconnectedCallback() { this._ro?.disconnect(); }
  get _lang() { return this._hass?.locale?.language || undefined; }
  getCardSize() { return 7; }
  getGridOptions() { return { columns: 12, min_columns: 6, rows: "auto" }; }

  get _metrics() {
    const c = this._config;
    return { weight: c.weight_entity, fat: c.fat_entity, muscle: c.muscle_entity, water: c.water_entity };
  }

  _maybeLoad(force) {
    if (!this._hass || !this._config) return;
    const ents = Object.values(this._metrics).filter(Boolean);
    const key = ents.map((e) => `${e}:${this._hass.states[e]?.last_changed || ""}`).join("|") + `|${this._config.days_to_show}`;
    if (!force && key === this._loadedKey) return;
    this._loadedKey = key;
    clearTimeout(this._loadTimer);
    // short debounce: the scale publishes weight first and the other values a few seconds later
    this._loadTimer = setTimeout(() => this._load(), this._data ? 4000 : 0);
  }

  async _load() {
    const hass = this._hass;
    const m = this._metrics;
    const ents = Object.values(m).filter(Boolean);
    const end = new Date();
    const start = new Date(end.getTime() - this._config.days_to_show * 864e5);
    let hist = {}, stats = {};
    try {
      hist = await hass.callWS({
        type: "history/history_during_period", start_time: start.toISOString(), end_time: end.toISOString(),
        entity_ids: ents, minimal_response: true, no_attributes: true, significant_changes_only: false,
      });
    } catch (e) { console.warn("body-stats-card: history failed", e); }
    try {
      stats = await hass.callWS({
        type: "recorder/statistics_during_period", start_time: start.toISOString(), end_time: end.toISOString(),
        statistic_ids: ents, period: "day", types: ["mean"],
      });
    } catch (e) { /* entities without state_class have no statistics */ }
    this._data = this._buildWeighIns(hist || {}, stats || {});
    this._render();
  }

  _unitOf(key) {
    const id = this._metrics[key];
    return this._hass?.states[id]?.attributes?.unit_of_measurement || (key === "weight" ? "kg" : "%");
  }

  // Turn raw history into a list of distinct weigh-ins: {t, weight, fat, muscle, water}
  _buildWeighIns(hist, stats) {
    const m = this._metrics;
    const series = {};
    for (const [key, id] of Object.entries(m)) {
      if (!id) continue;
      series[key] = (hist[id] || [])
        .map((r) => ({ t: (r.lu ?? r.lc ?? r.last_updated) , v: num(r.s ?? r.state) }))
        .map((r) => ({ t: typeof r.t === "number" ? r.t * 1000 : Date.parse(r.t), v: r.v }))
        .filter((r) => r.v != null && Number.isFinite(r.t))
        .sort((a, b) => a.t - b.t);
    }
    const valueAt = (key, t) => {
      const s = series[key];
      if (!s) return null;
      let v = null;
      for (const r of s) { if (r.t <= t + 180e3) v = r.v; else break; } // allow values that arrive up to 3 min after weight
      return v;
    };
    const out = [];
    let prev = null;
    for (const r of series.weight || []) {
      // the scale re-reports the same reading when it reconnects; collapse repeats
      if (prev != null && Math.abs(r.v - prev) < 0.001) continue;
      prev = r.v;
      out.push({ t: r.t, weight: r.v, fat: valueAt("fat", r.t), muscle: valueAt("muscle", r.t), water: valueAt("water", r.t) });
    }
    // fill older days from long-term statistics (daily means) where history has been purged
    const first = out.length ? out[0].t : Infinity;
    const wStats = stats[m.weight] || [];
    const statAt = (key, start) => {
      const row = (stats[m[key]] || []).find((x) => this._ts(x.start) === start);
      return row ? num(row.mean) : null;
    };
    const older = wStats
      .map((x) => ({ t: this._ts(x.start), weight: num(x.mean) }))
      .filter((x) => x.weight != null && x.t + 864e5 <= first)
      .map((x) => ({ ...x, t: x.t + 432e5, fat: statAt("fat", x.t), muscle: statAt("muscle", x.t), water: statAt("water", x.t), daily: true }));
    // if a sensor has nothing at all at a given point, fall back to its current state for the latest weigh-in
    const all = [...older, ...out];
    if (all.length) {
      const last = all[all.length - 1];
      for (const key of ["fat", "muscle", "water"]) {
        if (last[key] == null && m[key]) last[key] = num(this._hass.states[m[key]]?.state);
      }
    } else {
      const w = num(this._hass.states[m.weight]?.state);
      if (w != null) {
        const s = this._hass.states[m.weight];
        all.push({ t: Date.parse(s.last_changed), weight: w, fat: num(this._hass.states[m.fat]?.state), muscle: num(this._hass.states[m.muscle]?.state), water: num(this._hass.states[m.water]?.state) });
      }
    }
    return all.map((w) => this._derive(w));
  }

  _ts(v) { return typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v); }

  // Compute kg and % for each component regardless of the sensor's native unit
  _derive(w) {
    const o = { ...w, kg: { weight: w.weight }, pct: {} };
    for (const key of ["fat", "muscle", "water"]) {
      const v = w[key];
      if (v == null || !w.weight) { o.kg[key] = null; o.pct[key] = null; continue; }
      if (this._unitOf(key) === "%") { o.pct[key] = v; o.kg[key] = (w.weight * v) / 100; }
      else { o.kg[key] = v; o.pct[key] = (v / w.weight) * 100; }
    }
    const h = num(this._config.height_cm);
    o.bmi = h ? w.weight / ((h / 100) ** 2) : null;
    return o;
  }

  // ---------- rendering ----------
  _render() {
    if (!this._config) return;
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    const c = this._config;
    const d = this._data || [];
    const latest = d[d.length - 1];
    let body;
    if (!this._data) body = `<div class="empty">Loading\u2026</div>`;
    else if (!latest) body = `<div class="empty">No weigh-ins found in the last ${c.days_to_show} days.</div>`;
    else body = this[`_tab_${this._tab}`]();

    const tabs = c.tabs.length > 1
      ? `<div class="tabs">${c.tabs.map((t) => `<button class="tab ${t === this._tab ? "on" : ""}" data-tab="${t}">${TAB_LABELS[t]}</button>`).join("")}</div>`
      : "";
    this.shadowRoot.innerHTML = `<style>${this._css()}</style>
      <ha-card>
        ${c.title ? `<div class="head"><div class="title">${esc(c.title)}</div>${this._staleness(latest)}</div>` : `<div class="head">${this._staleness(latest)}</div>`}
        ${tabs}
        <div class="body">${body}</div>
      </ha-card>`;
    this._bind();
  }

  _staleness(latest) {
    if (!latest) return "";
    const age = (Date.now() - latest.t) / 864e5;
    const cls = age > 30 ? "red" : age > 7 ? "orange" : "";
    const when = new Date(latest.t).toLocaleString(this._lang, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const rel = age < 1 ? "today" : age < 2 ? "yesterday" : `${Math.floor(age)} days ago`;
    return `<div class="last ${cls}" title="Last weigh-in">\u23f1 ${esc(when)} \u00b7 ${rel}</div>`;
  }

  _tiles(mode) {
    const d = this._data;
    const latest = d[d.length - 1], prev = d[d.length - 2];
    const keys = mode === "weight" ? ["weight", "muscle", "fat", "water"] : ["fat", "muscle", "water"];
    const unit = mode === "weight" ? "kg" : "%";
    const sel = this._series[mode];
    return `<div class="tiles">${keys.filter((k) => k === "weight" || this._metrics[k]).map((k) => {
      const v = mode === "weight" ? latest.kg[k] : latest.pct[k];
      const p = prev ? (mode === "weight" ? prev.kg[k] : prev.pct[k]) : null;
      const delta = v != null && p != null ? v - p : null;
      let dcls = "";
      if (delta != null && Math.abs(delta) >= 0.05 && GOOD_DIR[k]) dcls = Math.sign(delta) === GOOD_DIR[k] ? "good" : "bad";
      const dtxt = delta == null ? "" : `${delta > 0 ? "\u25b2" : delta < 0 ? "\u25bc" : "\u2022"} ${fmt(Math.abs(delta))}`;
      const sub = mode === "weight" && k !== "weight" && latest.pct[k] != null ? `${fmt(latest.pct[k])}%` : mode !== "weight" && latest.kg[k] != null ? `${fmt(latest.kg[k])} kg` : "";
      return `<button class="tile ${sel === k ? "sel" : ""}" data-series="${k}" style="--c:${COLORS[k]}">
          <span class="tl">${LABELS[k]}</span>
          <span class="tv">${fmt(v)}<small>${unit}</small></span>
          <span class="ts"><span class="sub">${sub}</span><span class="delta ${dcls}">${dtxt}</span></span>
        </button>`;
    }).join("")}</div>`;
  }

  _tab_weight() { return this._tiles("weight") + (this._config.show_graph !== false ? this._graph("weight") : ""); }
  _tab_percentage() { return this._tiles("percentage") + (this._config.show_graph !== false ? this._graph("percentage") : ""); }

  _graph(mode) {
    const key = this._series[mode];
    const pts = this._data.map((w) => ({ t: w.t, v: mode === "weight" ? w.kg[key] : w.pct[key], daily: w.daily })).filter((p) => p.v != null);
    if (pts.length < 2) return `<div class="empty small">Not enough weigh-ins yet to draw a trend.</div>`;
    const W = Math.max(260, Math.round(this._width || 400)), H = 190, L = 38, R = 8, T = 34, B = 22;
    this._gw = W;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    let vmin = Math.min(...pts.map((p) => p.v)), vmax = Math.max(...pts.map((p) => p.v));
    const pad = Math.max((vmax - vmin) * 0.15, 0.5);
    vmin -= pad; vmax += pad;
    const x = (t) => L + ((t - t0) / Math.max(t1 - t0, 1)) * (W - L - R);
    const y = (v) => T + (1 - (v - vmin) / (vmax - vmin)) * (H - T - B);
    const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
    const area = `${line}L${x(t1).toFixed(1)},${H - B}L${x(t0).toFixed(1)},${H - B}Z`;
    const ticks = [0, 0.5, 1].map((f) => vmin + f * (vmax - vmin));
    const dfmt = (t) => new Date(t).toLocaleDateString(this._lang, { day: "numeric", month: "short" });
    const unit = mode === "weight" ? "kg" : "%";
    this._graphPts = pts.map((p) => ({ ...p, x: x(p.t), y: y(p.v), unit, label: LABELS[key] }));
    return `<div class="graph" style="--c:${COLORS[key]}">
      <svg viewBox="0 0 ${W} ${H}">
        <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${COLORS[key]}" stop-opacity=".35"/><stop offset="1" stop-color="${COLORS[key]}" stop-opacity="0"/></linearGradient></defs>
        ${ticks.map((v) => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join("")}
        <path d="${area}" fill="url(#g)"/>
        <path d="${line}" class="ln"/>
        ${pts.length <= 60 ? this._graphPts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="3" class="pt ${p.daily ? "daily" : ""}"/>`).join("") : ""}
        <text class="ax" x="${L}" y="${H - 6}">${dfmt(t0)}</text>
        <text class="ax" x="${W - R}" y="${H - 6}" text-anchor="end">${dfmt(t1)}</text>
        <g class="hover" style="display:none"><line class="hl" y1="${T}" y2="${H - B}"/><circle r="5" class="hp"/></g>
        <rect class="overlay" x="${L}" y="0" width="${W - L - R}" height="${H}" fill="transparent"/>
      </svg>
      <div class="tip" style="display:none"></div>
    </div>`;
  }

  _nav() {
    const d = this._data;
    const i = this._idx ?? d.length - 1;
    const w = d[i];
    const date = new Date(w.t).toLocaleString(this._lang, w.daily ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    return `<div class="nav">
      <button class="nb" data-nav="-1" ${i <= 0 ? "disabled" : ""} aria-label="Previous weigh-in">\u2039</button>
      <span>${esc(date)}${w.daily ? " (daily avg)" : ""}${i === d.length - 1 ? " \u00b7 latest" : ""}</span>
      <button class="nb" data-nav="1" ${i >= d.length - 1 ? "disabled" : ""} aria-label="Next weigh-in">\u203a</button>
    </div>`;
  }

  _tab_composition() {
    const d = this._data;
    const w = d[this._idx ?? d.length - 1];
    const path = FIGURES[this._config.body_type === "female" ? "female" : "male"];
    const top = 5, bottom = 212, hgt = bottom - top;
    const figs = ["water", "muscle", "fat"].filter((k) => this._metrics[k]).map((k, i) => {
      const pct = w.pct[k];
      const fillH = pct == null ? 0 : Math.max(0, Math.min(100, pct)) / 100 * hgt;
      const id = `clip-${k}`;
      return `<div class="fig">
        <svg viewBox="0 0 100 216">
          <defs><clipPath id="${id}"><circle cx="50" cy="18" r="13"/><path d="${path}"/></clipPath></defs>
          <g clip-path="url(#${id})">
            <rect x="0" y="0" width="100" height="216" class="figbg"/>
            <rect x="0" y="${bottom - fillH}" width="100" height="${fillH}" fill="${COLORS[k]}" class="fill"/>
            <line x1="0" x2="100" y1="${bottom - fillH}" y2="${bottom - fillH}" stroke="#fff" stroke-opacity=".6" stroke-width="1"/>
          </g>
          <circle cx="50" cy="18" r="13" class="outline"/><path d="${path}" class="outline"/>
        </svg>
        <div class="fl" style="color:${COLORS[k]}">${fmt(pct)}%</div>
        <div class="fk">${fmt(w.kg[k])} kg</div>
        <div class="fn">${LABELS[k]}</div>
      </div>`;
    }).join("");
    return `${this._nav()}<div class="figs">${figs}</div>
      <div class="foot">Weight <b>${fmt(w.weight)} kg</b>${w.bmi ? ` \u00b7 BMI <b>${fmt(w.bmi)}</b>` : ""}</div>`;
  }

  _tab_quadrant() {
    const d = this._data;
    const i = this._idx ?? d.length - 1;
    const w = d[i];
    if (!this._config.height_cm) return `<div class="empty">Add <code>height_cm</code> to the card settings to plot BMI.</div>`;
    if (w.pct.fat == null) return `${this._nav()}<div class="empty">No body fat reading for this weigh-in.</div>`;
    const female = this._config.body_type === "female";
    // [min, low/normal boundary, normal/high boundary, max]
    const px = female ? [5, 18, 28, 45] : [0, 10, 20, 40];
    const by = [14, 18.5, 25, 36];
    const S = 300, P = 34; // grid area
    const cell = (S - P - 8) / 3;
    const pos = (v, b) => { // piecewise linear onto three equal bands
      v = Math.max(b[0], Math.min(b[3], v));
      const k = v < b[1] ? 0 : v < b[2] ? 1 : 2;
      return k + (v - b[k]) / (b[k + 1] - b[k]);
    };
    const X = (v) => P + pos(v, px) * cell;
    const Y = (v) => 8 + (3 - pos(v, by)) * cell;
    const names = [ // [bmiBand][fatBand]
      ["Thin", "Slim", "Skinny fat"],
      ["Athletic", "Healthy", "Hidden obesity"],
      ["Muscular", "Overweight", "Obesity"],
    ];
    const band = (v, b) => (v < b[1] ? 0 : v < b[2] ? 1 : 2);
    const bi = band(w.bmi, by), fi = band(w.pct.fat, px);
    const tone = (r, c) => (r === 1 && c === 1 ? "ok" : r === 1 && c === 0 ? "ok" : (r === 2 && c === 2) || (r === 1 && c === 2) || (r === 0 && c === 2) ? "bad" : "mid");
    let cells = "";
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      const x0 = P + c * cell, y0 = 8 + (2 - r) * cell;
      const on = r === bi && c === fi;
      cells += `<rect x="${x0}" y="${y0}" width="${cell}" height="${cell}" class="q ${tone(r, c)} ${on ? "on" : ""}"/>
        <text x="${x0 + cell / 2}" y="${y0 + cell / 2 + 4}" class="qn ${on ? "on" : ""}" text-anchor="middle">${names[r][c]}</text>`;
    }
    const trail = d.slice(Math.max(0, i - 8), i).filter((p) => p.bmi && p.pct.fat != null);
    const trailPath = [...trail, w].map((p, k) => `${k ? "L" : "M"}${X(p.pct.fat).toFixed(1)},${Y(p.bmi).toFixed(1)}`).join("");
    const axis = `
      ${[px[1], px[2]].map((v) => `<text class="ax" x="${X(v)}" y="${8 + 3 * cell + 14}" text-anchor="middle">${v}%</text>`).join("")}
      ${[by[1], by[2]].map((v) => `<text class="ax" x="${P - 4}" y="${Y(v) + 4}" text-anchor="end">${v}</text>`).join("")}
      <text class="ax lbl" x="${P + 1.5 * cell}" y="${8 + 3 * cell + 30}" text-anchor="middle">Body fat %</text>
      <text class="ax lbl" x="10" y="${8 + 1.5 * cell}" text-anchor="middle" transform="rotate(-90 10 ${8 + 1.5 * cell})">BMI</text>`;
    return `${this._nav()}
      <div class="quad"><svg viewBox="0 0 ${S} ${8 + 3 * cell + 36}">
        ${cells}${axis}
        ${trail.length ? `<path d="${trailPath}" class="trail"/>` : ""}
        ${trail.map((p) => `<circle cx="${X(p.pct.fat)}" cy="${Y(p.bmi)}" r="2.5" class="tp"/>`).join("")}
        <circle cx="${X(w.pct.fat)}" cy="${Y(w.bmi)}" r="7" class="dot"/>
      </svg></div>
      <div class="foot"><b>${names[bi][fi]}</b> \u00b7 BMI <b>${fmt(w.bmi)}</b> \u00b7 Body fat <b>${fmt(w.pct.fat)}%</b></div>`;
  }

  _bind() {
    const root = this.shadowRoot;
    root.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => { this._tab = b.dataset.tab; this._render(); }));
    root.querySelectorAll(".tile").forEach((b) => b.addEventListener("click", () => {
      const mode = this._tab;
      if (this._series[mode] === b.dataset.series) {
        const id = this._metrics[b.dataset.series];
        this.dispatchEvent(new CustomEvent("hass-more-info", { bubbles: true, composed: true, detail: { entityId: id } }));
      } else { this._series[mode] = b.dataset.series; this._render(); }
    }));
    root.querySelectorAll(".nb").forEach((b) => b.addEventListener("click", () => {
      const n = this._data.length;
      const cur = this._idx ?? n - 1;
      const next = Math.max(0, Math.min(n - 1, cur + Number(b.dataset.nav)));
      this._idx = next === n - 1 ? null : next;
      this._render();
    }));
    const svg = root.querySelector(".graph svg");
    if (svg && this._graphPts) {
      const ov = svg.querySelector(".overlay"), hov = svg.querySelector(".hover"), tip = root.querySelector(".tip");
      const move = (ev) => {
        const r = svg.getBoundingClientRect();
        const vx = ((ev.clientX - r.left) / r.width) * this._gw;
        let best = this._graphPts[0];
        for (const p of this._graphPts) if (Math.abs(p.x - vx) < Math.abs(best.x - vx)) best = p;
        hov.style.display = "";
        hov.querySelector("line").setAttribute("x1", best.x); hov.querySelector("line").setAttribute("x2", best.x);
        hov.querySelector("circle").setAttribute("cx", best.x); hov.querySelector("circle").setAttribute("cy", best.y);
        tip.style.display = "";
        tip.innerHTML = `<b>${fmt(best.v)} ${best.unit}</b><br>${new Date(best.t).toLocaleString(this._lang, { day: "numeric", month: "short", hour: best.daily ? undefined : "2-digit", minute: best.daily ? undefined : "2-digit" })}`;
        const left = (best.x / this._gw) * r.width;
        tip.style.left = `${Math.min(Math.max(left, 50), r.width - 50)}px`;
      };
      ov.addEventListener("pointermove", move);
      ov.addEventListener("pointerdown", move);
      ov.addEventListener("pointerleave", () => { hov.style.display = "none"; tip.style.display = "none"; });
    }
  }

  _css() {
    return `
      ha-card { padding: 0 0 12px; overflow: hidden; }
      .head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding: 14px 16px 6px; flex-wrap: wrap; }
      .title { font-size: 1.15em; font-weight: 500; color: var(--primary-text-color); }
      .last { font-size: .8em; color: var(--secondary-text-color); padding: 2px 8px; border-radius: 999px; background: var(--secondary-background-color, rgba(127,127,127,.12)); }
      .last.orange { color: #fff; background: #f59e0b; }
      .last.red { color: #fff; background: #ef4444; }
      .tabs { display:flex; gap:4px; margin: 4px 12px 10px; padding: 3px; border-radius: 12px; background: var(--secondary-background-color, rgba(127,127,127,.12)); }
      .tab { flex:1; border:0; background:none; color: var(--secondary-text-color); font: inherit; font-size:.85em; padding: 6px 4px; border-radius: 9px; cursor:pointer; }
      .tab.on { background: var(--card-background-color, #fff); color: var(--primary-text-color); font-weight:500; box-shadow: 0 1px 3px rgba(0,0,0,.15); }
      .body { padding: 0 12px; }
      .empty { padding: 24px 8px; text-align:center; color: var(--secondary-text-color); }
      .empty.small { padding: 12px; font-size: .9em; }
      .tiles { display:grid; grid-template-columns: repeat(auto-fit, minmax(84px, 1fr)); gap: 6px; }
      .tile { text-align:left; font:inherit; cursor:pointer; display:flex; flex-direction:column; gap:2px; padding: 8px 8px 8px 12px; border-radius: 12px; min-width:0;
        border: 1px solid var(--divider-color, rgba(127,127,127,.25)); background: none; color: var(--primary-text-color); position:relative; overflow:hidden; }
      .tile::before { content:""; position:absolute; left:0; top:0; bottom:0; width:4px; background: var(--c); }
      .tile.sel { border-color: var(--c); background: color-mix(in srgb, var(--c) 10%, transparent); }
      .tl { font-size:.78em; color: var(--secondary-text-color); }
      .tv { font-size: 1.35em; white-space:nowrap; font-weight: 600; line-height:1.2; }
      .tv small { font-size: .55em; font-weight: 400; margin-left: 2px; color: var(--secondary-text-color); }
      .ts { display:flex; flex-wrap:wrap; justify-content:space-between; font-size:.75em; color: var(--secondary-text-color); gap:6px; }
      .delta.good { color: #16a34a; } .delta.bad { color: #dc2626; }
      .graph { position:relative; margin-top: 10px; }
      .graph svg { width:100%; height:auto; display:block; }
      .grid { stroke: var(--divider-color, rgba(127,127,127,.25)); stroke-dasharray: 3 3; }
      .ax { fill: var(--secondary-text-color); font-size: 11px; }
      .ax.lbl { font-size: 10px; letter-spacing:.04em; text-transform: uppercase; }
      .ln { fill:none; stroke: var(--c); stroke-width: 2.5; vector-effect: non-scaling-stroke; stroke-linejoin: round; }
      .pt { fill: var(--card-background-color, #fff); stroke: var(--c); stroke-width: 2; vector-effect: non-scaling-stroke; }
      .pt.daily { fill: var(--c); stroke-width: 0; r: 1.8; }
      .hl { stroke: var(--secondary-text-color); stroke-dasharray: 2 2; vector-effect: non-scaling-stroke; }
      .hp { fill: var(--c); stroke: var(--card-background-color, #fff); stroke-width: 2; }
      .tip { position:absolute; top:0; transform: translateX(-50%); pointer-events:none; font-size:.78em; text-align:center; padding: 4px 8px; border-radius: 8px;
        background: var(--primary-text-color, #333); color: var(--card-background-color, #fff); white-space:nowrap; }
      .nav { display:flex; align-items:center; justify-content:space-between; font-size:.85em; color: var(--secondary-text-color); margin-bottom: 6px; }
      .nb { border:1px solid var(--divider-color, rgba(127,127,127,.25)); background:none; color: var(--primary-text-color); width: 32px; height: 28px; border-radius: 8px; font-size: 1.2em; line-height:1; cursor:pointer; }
      .nb:disabled { opacity: .3; cursor: default; }
      .figs { display:flex; justify-content: space-around; gap: 8px; }
      .fig { flex:1; max-width: 140px; text-align:center; }
      .fig svg { width: 100%; max-height: 220px; }
      .figbg { fill: color-mix(in srgb, var(--primary-text-color, #000) 9%, transparent); }
      .fill { transition: y .5s, height .5s; }
      .outline { fill:none; stroke: var(--divider-color, rgba(127,127,127,.4)); stroke-width: 1; }
      .fl { font-size: 1.3em; font-weight: 600; margin-top: 4px; }
      .fk { font-size: .85em; color: var(--primary-text-color); }
      .fn { font-size: .75em; color: var(--secondary-text-color); }
      .foot { text-align:center; font-size:.9em; color: var(--secondary-text-color); margin-top: 10px; }
      .foot b { color: var(--primary-text-color); }
      .quad { display:flex; justify-content:center; }
      .quad svg { width: 100%; max-width: 360px; }
      .q { stroke: var(--card-background-color, #fff); stroke-width: 2; }
      .q.ok { fill: rgba(34,197,94,.14); } .q.mid { fill: rgba(245,158,11,.13); } .q.bad { fill: rgba(239,68,68,.13); }
      .q.on.ok { fill: rgba(34,197,94,.38); } .q.on.mid { fill: rgba(245,158,11,.38); } .q.on.bad { fill: rgba(239,68,68,.38); }
      .qn { font-size: 10.5px; fill: var(--secondary-text-color); }
      .qn.on { fill: var(--primary-text-color); font-weight: 600; }
      .trail { fill:none; stroke: var(--secondary-text-color); stroke-opacity:.5; stroke-width: 1.2; stroke-dasharray: 3 2; }
      .tp { fill: var(--secondary-text-color); opacity: .6; }
      .dot { fill: var(--primary-color, #03a9f4); stroke: var(--card-background-color, #fff); stroke-width: 2.5; }
      code { font-size: .9em; }
    `;
  }
}

if (!customElements.get("body-stats-card")) customElements.define("body-stats-card", BodyStatsCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "body-stats-card")) {
  window.customCards.push({ type: "body-stats-card", name: "Body Stats", description: "InBody-style weight and body composition card", preview: true });
}
console.info(`%c BODY-STATS-CARD %c ${BSC_VERSION} `, "background:#22c55e;color:#fff;border-radius:3px 0 0 3px", "background:#333;color:#fff;border-radius:0 3px 3px 0");
