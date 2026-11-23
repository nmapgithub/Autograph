const TABS = [
  ["fleet", "Fleet"],
  ["driver", "Driver"],
  ["run", "Run"],
  ["drive", "Drive"],
  ["timeline", "Timeline"],
  ["logs", "Logs"],
  ["ueba", "UEBA"],
  ["signals", "Signals"],
];

const state = {
  tab: "fleet",
  meta: null,
  drivers: [],
  selectedId: "usman",
  view: null,
  runs: [],
  board: [],
  log: { offset: 0, phase: "", rows: [], matched: 0, focusId: null },
  chartMode: "day",
  eventFilter: "all",
  catalog: [],
};

const $ = (id) => document.getElementById(id);

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let detail = await res.text();
    try {
      detail = JSON.parse(detail).detail || detail;
    } catch (_err) {
      /* keep text */
    }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.json();
}

function setStatus(text) {
  $("status").textContent = text || "";
}

function driverById(id) {
  return state.drivers.find((d) => d.id === id);
}

function selected() {
  return driverById(state.selectedId) || state.drivers[0];
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", month: "short", day: "numeric" });
}

function band(score) {
  if (score == null) return "none";
  if (score < 25) return "low";
  if (score < 55) return "watch";
  return "high";
}

function showTab(name) {
  state.tab = name;
  for (const [id] of TABS) {
    $(`panel-${id}`).hidden = id !== name;
  }
  window.scrollTo(0, 0);
  document.querySelectorAll("#nav button").forEach((btn) => {
    btn.setAttribute("aria-selected", btn.dataset.tab === name ? "true" : "false");
  });
  if (window.Drive) Drive.setActive(name === "drive");
  if (name === "timeline") {
    if (!state.view && state.runs.length) {
      hydrateLatest().then(() => {
        renderTimeline();
        drawCharts();
      });
    } else {
      drawCharts();
    }
  }
  if (name === "ueba") drawScoreChart();
  if (name === "logs") {
    api("/api/runs")
      .then((data) => {
        state.runs = data.runs;
        renderLogs();
        loadSamples();
      })
      .catch((err) => setStatus(err.message));
  }
}

function buildNav() {
  const nav = $("nav");
  nav.textContent = "";
  for (const [id, label] of TABS) {
    const btn = el("button", label);
    btn.dataset.tab = id;
    btn.setAttribute("aria-selected", id === state.tab ? "true" : "false");
    btn.addEventListener("click", () => showTab(id));
    nav.appendChild(btn);
  }
}

function renderFleet() {
  const panel = $("panel-fleet");
  panel.textContent = "";
  panel.appendChild(el("h2", "Fleet"));
  panel.appendChild(el("p", "Three drivers, three cars, one lab. Each day becomes time-series logs a gateway could have shipped: Tesla fleet fields, a COVESA VSS tree, and CAN frames.", "lede"));
  const grid = el("div", null, "grid");
  for (const driver of state.drivers) {
    const card = el("div", null, "card");
    card.style.borderLeftColor = driver.color;
    card.appendChild(el("h3", driver.name));
    card.appendChild(el("p", `${driver.role} · ${driver.city}`, "role"));
    const stats = el("div", null, "stats");
    const bits = [
      ["VIN", driver.vin],
      ["Odometer", `${Number(driver.odometer_km).toFixed(1)} km`],
      ["State of charge", `${Number(driver.soc).toFixed(1)}%`],
      ["Cruise", `${driver.params.cruise_kmh} km/h`],
    ];
    for (const [k, v] of bits) {
      const cell = el("div");
      cell.appendChild(el("span", k));
      cell.appendChild(document.createTextNode(String(v)));
      stats.appendChild(cell);
    }
    card.appendChild(stats);
    const row = el("div", null, "row");
    const open = el("button", "Edit style");
    open.addEventListener("click", () => {
      state.selectedId = driver.id;
      renderDriver();
      renderRun();
      showTab("driver");
    });
    const run = el("button", "Run a day", "primary");
    run.addEventListener("click", () => runOne(driver.id, false));
    row.append(open, run);
    card.appendChild(row);
    grid.appendChild(card);
  }
  panel.appendChild(grid);
  const actions = el("div", null, "row");
  actions.style.marginTop = "14px";
  const all = el("button", "Run a day for every driver", "primary");
  all.addEventListener("click", runFleet);
  actions.appendChild(all);
  panel.appendChild(actions);
  const note = el("p", "Parked and charging stretches are sampled every 30–60 seconds. Driving, doors, and gear changes use the interval you set. 500 ms matches the Tesla fleet bucket.", "footnote");
  panel.appendChild(note);
}

function renderDriver() {
  const panel = $("panel-driver");
  panel.textContent = "";
  panel.appendChild(el("h2", "Driver setup"));
  const driver = selected();
  if (!driver) return;
  const pickRow = el("div", null, "row");
  const pick = document.createElement("select");
  for (const d of state.drivers) {
    const opt = el("option", `${d.name} — ${d.city}`);
    opt.value = d.id;
    pick.appendChild(opt);
  }
  pick.value = driver.id;
  pick.addEventListener("change", () => {
    state.selectedId = pick.value;
    renderDriver();
    renderRun();
  });
  pickRow.appendChild(pick);
  const name = document.createElement("input");
  name.value = "";
  name.placeholder = "Add a driver";
  const add = el("button", "Add");
  add.addEventListener("click", async () => {
    if (!name.value.trim()) return;
    setStatus("Adding driver…");
    try {
      const created = await api("/api/drivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.value.trim() }),
      });
      state.drivers = (await api("/api/drivers")).drivers;
      state.selectedId = created.id;
      renderFleet();
      renderDriver();
      renderRun();
      if (window.Drive) Drive.refresh();
      setStatus(`${created.name} starts from Usman's calm route. Change the numbers, then run a day.`);
    } catch (err) {
      setStatus(err.message);
    }
  });
  pickRow.append(name, add);
  panel.appendChild(pickRow);
  panel.dataset.driverId = driver.id;
  panel.appendChild(el("p", `${driver.vehicle_name} · ${driver.vin} · ${driver.home.label} to ${driver.work.label}`, "meta"));

  const form = el("div", null, "form-grid");
  let group = "";
  for (const spec of state.meta.params) {
    if (spec.group !== group) {
      group = spec.group;
      form.appendChild(el("h3", group, "group-title"));
    }
    const label = el("label", spec.label, "field");
    label.appendChild(el("small", spec.help + (spec.unit ? ` (${spec.unit})` : "")));
    const input = document.createElement("input");
    input.type = "number";
    input.min = spec.min;
    input.max = spec.max;
    input.step = spec.step;
    input.value = driver.params[spec.key];
    input.dataset.param = spec.key;
    label.appendChild(input);
    form.appendChild(label);
  }
  panel.appendChild(form);
  const row = el("div", null, "row");
  row.style.marginTop = "12px";
  const save = el("button", "Save style", "primary");
  save.addEventListener("click", saveDriver);
  const reset = el("button", "Rewind odometer and baseline");
  reset.addEventListener("click", async () => {
    setStatus("Rewinding…");
    try {
      await api(`/api/drivers/${driver.id}/reset`, { method: "POST" });
      state.drivers = (await api("/api/drivers")).drivers;
      renderFleet();
      renderDriver();
      setStatus("Odometer, charge, and the personal baseline are back to the factory day.");
    } catch (err) {
      setStatus(err.message);
    }
  });
  row.append(save, reset);
  panel.appendChild(row);
}

function readParams() {
  const params = {};
  document.querySelectorAll("[data-param]").forEach((input) => {
    params[input.dataset.param] = Number(input.value);
  });
  return params;
}

async function saveDriver() {
  const driverId = $("panel-driver").dataset.driverId;
  const driver = driverById(driverId);
  if (!driver) return;
  setStatus("Saving…");
  try {
    await api(`/api/drivers/${driver.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ params: readParams() }),
    });
    state.drivers = (await api("/api/drivers")).drivers;
    state.selectedId = driver.id;
    renderFleet();
    renderDriver();
    renderRun();
    if (window.Drive) Drive.refresh();
    setStatus(`${driver.name}'s style saved.`);
  } catch (err) {
    setStatus(err.message);
  }
}

function renderRun() {
  const panel = $("panel-run");
  panel.textContent = "";
  panel.appendChild(el("h2", "Run a day"));
  const driver = selected();
  if (!driver) return;
  panel.appendChild(el("p", `The run uses ${driver.name}'s saved style. Edit numbers on Driver first, or save them there before a fleet run.`, "lede"));
  const form = el("div", null, "form-grid");
  const scenario = document.createElement("select");
  scenario.id = "scenario";
  for (const item of state.meta.scenarios) {
    const opt = el("option", item.label);
    opt.value = item.id;
    scenario.appendChild(opt);
  }
  scenario.value = "workday";
  form.appendChild(field("Scenario", scenario, "One commute is the fast path. Full day includes the gap, the drive home, and a charge."));
  const interval = document.createElement("select");
  interval.id = "interval";
  for (const [ms, label] of [[500, "500 ms — fleet bucket"], [1000, "1 second"], [2000, "2 seconds"]]) {
    const opt = el("option", label);
    opt.value = String(ms);
    interval.appendChild(opt);
  }
  interval.value = "1000";
  form.appendChild(field("Sample interval", interval, "Applies while the car is awake and moving, and during the door sequence."));
  const day = document.createElement("input");
  day.type = "date";
  day.id = "day";
  day.value = new Date().toISOString().slice(0, 10);
  form.appendChild(field("Calendar day", day, "Timestamps keep the driver's local offset."));
  const minutes = document.createElement("input");
  minutes.type = "number";
  minutes.id = "minutes";
  minutes.min = "5";
  minutes.max = "180";
  minutes.value = "20";
  form.appendChild(field("Timed drive minutes", minutes, "Used only for Timed drive. Distance follows cruise speed."));
  const seed = document.createElement("input");
  seed.type = "number";
  seed.id = "seed";
  seed.placeholder = "blank = random";
  form.appendChild(field("Seed", seed, "Same seed and style reproduce the same day."));
  const injectWrap = el("label", null, "field check");
  const inject = document.createElement("input");
  inject.type = "checkbox";
  inject.id = "inject";
  injectWrap.appendChild(inject);
  injectWrap.appendChild(document.createTextNode(" Inject a risky stretch (speed burst, belt off, door ajar, delayed lock). It is scored, and it is kept out of the personal baseline."));
  form.appendChild(injectWrap);
  panel.appendChild(form);
  const row = el("div", null, "row");
  row.style.marginTop = "12px";
  const go = el("button", `Run ${driver.name}`, "primary");
  go.id = "run-one";
  go.addEventListener("click", () => runOne(driver.id, true));
  const fleet = el("button", "Run every driver");
  fleet.addEventListener("click", runFleet);
  row.append(go, fleet);
  panel.appendChild(row);
}

function field(title, control, help) {
  const label = el("label", title, "field");
  label.appendChild(el("small", help));
  label.appendChild(control);
  return label;
}

function runBody(driverId, includeParams) {
  const seedRaw = $("seed") ? $("seed").value : "";
  return {
    driver_id: driverId,
    scenario: $("scenario") ? $("scenario").value : "workday",
    interval_ms: $("interval") ? Number($("interval").value) : 1000,
    day: $("day") ? $("day").value : null,
    duration_min: $("minutes") ? Number($("minutes").value) : 20,
    seed: seedRaw === "" ? null : Number(seedRaw),
    inject_anomalies: $("inject") ? $("inject").checked : false,
    params: includeParams ? readParams() : null,
    advance_odometer: true,
  };
}

async function runOne(driverId, includeParams) {
  setStatus(`Running ${driverById(driverId).name}… this writes the full log to disk.`);
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    const body = runBody(driverId, includeParams && !!document.querySelector("[data-param]"));
    const result = await api("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    state.view = result;
    state.drivers = (await api("/api/drivers")).drivers;
    state.runs = (await api("/api/runs")).runs;
    state.board = (await api("/api/ueba")).board;
    renderFleet();
    renderTimeline();
    renderLogs();
    renderUeba();
    showTab("timeline");
    const m = result.run.metrics;
    setStatus(`${result.run.driver_name}: ${m.samples} samples, ${m.events} events, ${m.distance_km.toFixed(1)} km, risk ${result.ueba.absolute.score}.`);
  } catch (err) {
    setStatus(err.message);
  } finally {
    document.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}

async function runFleet() {
  setStatus("Running Usman, Waqas, John, and anyone you added…");
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  try {
    const body = runBody(state.selectedId || "usman", false);
    const result = await api("/api/simulate/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    state.view = result.runs[result.runs.length - 1];
    state.drivers = (await api("/api/drivers")).drivers;
    state.runs = (await api("/api/runs")).runs;
    state.board = (await api("/api/ueba")).board;
    renderFleet();
    renderTimeline();
    renderUeba();
    showTab("ueba");
    setStatus(`Fleet day finished. ${result.runs.length} cars wrote logs.`);
  } catch (err) {
    setStatus(err.message);
  } finally {
    document.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}

function renderTimeline() {
  const panel = $("panel-timeline");
  panel.textContent = "";
  panel.appendChild(el("h2", "Timeline"));
  if (!state.view) {
    panel.appendChild(el("p", "Run a day and the speed trace, gear strip, and event list land here.", "lede"));
    return;
  }
  const run = state.view.run;
  const m = run.metrics;
  panel.appendChild(el("p", `${run.driver_name} · ${run.scenario} · ${run.day} · seed ${run.seed} · ${m.samples} telemetry rows · ${m.events} events`, "meta"));
  const modes = el("div", null, "chips");
  for (const [id, label] of [["day", "Full day"], ["drive", "Moving only"]]) {
    const btn = el("button", label);
    btn.setAttribute("aria-pressed", state.chartMode === id ? "true" : "false");
    btn.addEventListener("click", () => {
      state.chartMode = id;
      renderTimeline();
    });
    modes.appendChild(btn);
  }
  panel.appendChild(modes);
  const speed = document.createElement("canvas");
  speed.id = "speed-chart";
  speed.height = 280;
  speed.style.marginTop = "10px";
  const soc = document.createElement("canvas");
  soc.id = "soc-chart";
  soc.height = 140;
  soc.style.marginTop = "10px";
  panel.appendChild(speed);
  panel.appendChild(soc);
  const readout = el("p", "Hover the speed trace.", "mono");
  readout.id = "readout";
  panel.appendChild(readout);
  const summary = el("div", null, "stats");
  const bits = [
    ["Distance", `${m.distance_km.toFixed(1)} km`],
    ["Average", `${m.avg_speed_kmh.toFixed(0)} km/h`],
    ["Peak", `${m.max_speed_kmh.toFixed(0)} km/h`],
    ["Gear shifts", String(m.gear_shifts)],
    ["Door cycles", String(m.door_cycles)],
    ["Windows", String(m.window_changes)],
    ["Hard brakes", String(m.hard_brake_count)],
    ["Risk", String(state.view.ueba.absolute.score)],
  ];
  for (const [k, v] of bits) {
    const cell = el("div");
    cell.appendChild(el("span", k));
    cell.appendChild(document.createTextNode(v));
    summary.appendChild(cell);
  }
  panel.appendChild(summary);
  const filters = el("div", null, "chips");
  for (const [id, label] of [["all", "All events"], ["alert", "Alerts"], ["gear_shift", "Gear"], ["door", "Doors"], ["window", "Windows"], ["charge_state", "Charge"]]) {
    const btn = el("button", label);
    btn.setAttribute("aria-pressed", state.eventFilter === id ? "true" : "false");
    btn.addEventListener("click", () => {
      state.eventFilter = id;
      renderTimeline();
    });
    filters.appendChild(btn);
  }
  panel.appendChild(filters);
  const list = el("div");
  const events = filteredEvents();
  for (const event of events.slice(0, 250)) {
    const row = el("div", null, "event");
    row.appendChild(el("time", fmtTime(event["@timestamp"])));
    row.appendChild(el("strong", event.event, `sev-${event.severity}`));
    row.appendChild(el("span", eventDetail(event)));
    list.appendChild(row);
  }
  panel.appendChild(list);
  if (events.length > 250) panel.appendChild(el("p", `Showing 250 of ${events.length} events.`, "footnote"));
  panel.appendChild(el("h3", "One telemetry document"));
  const pre = el("pre", JSON.stringify(state.view.example, null, 2), "json");
  panel.appendChild(pre);
  const links = el("div", null, "row");
  links.appendChild(exportLink(run.id, "telemetry", "jsonl", "Download telemetry JSONL"));
  links.appendChild(exportLink(run.id, "events", "jsonl", "Download events JSONL"));
  links.appendChild(exportLink(run.id, "telemetry", "bulk", "OpenSearch bulk — telemetry"));
  links.appendChild(exportLink(run.id, "events", "bulk", "OpenSearch bulk — events"));
  panel.appendChild(links);
  requestAnimationFrame(drawCharts);
}

function exportLink(id, kind, fmt, label) {
  const a = el("a", label);
  a.href = `/api/runs/${id}/export?kind=${kind}&fmt=${fmt}`;
  a.setAttribute("download", "");
  return a;
}

function eventDetail(event) {
  const d = event.detail || {};
  if (event.event === "gear_shift") return `${d.from} → ${d.to} at ${event.context.speed_kmh} km/h`;
  if (event.event === "window") return `${d.window} command ${d.command_pct}%`;
  if (String(event.event).startsWith("door")) return `${d.door || ""} ${d.open ? "open" : "closed"}`.trim();
  const text = Object.entries(d).map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ");
  return text || event.phase;
}

function filteredEvents() {
  const events = (state.view && state.view.events) || [];
  if (state.eventFilter === "all") return events;
  if (state.eventFilter === "alert") return events.filter((e) => e.severity === "alert");
  if (state.eventFilter === "door") return events.filter((e) => String(e.event).includes("door") || e.event === "lock" || e.event === "unlock");
  return events.filter((e) => e.event === state.eventFilter);
}

function seriesForChart() {
  const series = (state.view && state.view.series) || [];
  if (state.chartMode === "day") return series;
  return series.filter((p) => p.phase === "driving" || p.phase === "maneuver" || p.phase === "access");
}

function drawCharts() {
  const speed = $("speed-chart");
  const soc = $("soc-chart");
  if (!speed || !soc) return;
  const points = seriesForChart();
  drawSpeed(speed, points);
  drawSoc(soc, points);
  speed.onmousemove = (ev) => hover(ev, speed, points);
  speed.onmouseleave = () => {
    const node = $("readout");
    if (node) node.textContent = "Hover the speed trace.";
  };
}

function xAt(points, index) {
  return state.chartMode === "drive" ? index : points[index].t;
}

function drawSpeed(canvas, points) {
  const ctx = prep(canvas, 280);
  const w = canvas.clientWidth;
  const h = 280;
  ctx.clearRect(0, 0, w, h);
  if (points.length < 2) {
    ctx.fillStyle = "#a8a292";
    ctx.fillText("Not enough samples to draw.", 16, 32);
    return;
  }
  const x0 = xAt(points, 0);
  const x1 = xAt(points, points.length - 1);
  const maxY = Math.max(40, ...points.map((p) => Math.max(p.speed, p.limit || 0))) * 1.1;
  const plotTop = 16;
  const plotH = 200;
  const gearTop = 236;
  const xOf = (_p, i) => 48 + ((xAt(points, i) - x0) / Math.max(1, x1 - x0)) * (w - 64);
  const yOf = (v) => plotTop + plotH - (v / maxY) * plotH;
  ctx.strokeStyle = "#31382c";
  ctx.fillStyle = "#a8a292";
  ctx.font = "12px Consolas, monospace";
  for (let v = 0; v <= maxY; v += maxY > 120 ? 40 : 20) {
    const y = yOf(v);
    ctx.beginPath();
    ctx.moveTo(48, y);
    ctx.lineTo(w - 16, y);
    ctx.stroke();
    ctx.fillText(String(Math.round(v)), 8, y + 4);
  }
  stroke(ctx, points, xOf, (p) => yOf(p.limit || 0), "#d08a3a");
  stroke(ctx, points, xOf, (p) => yOf(p.speed), "#8fce7a");
  const gearColor = { P: "#6d7268", R: "#d08a3a", N: "#7aa2d6", D: "#8fce7a" };
  for (let i = 0; i < points.length - 1; i++) {
    ctx.fillStyle = gearColor[points[i].gear] || "#6d7268";
    const left = xOf(points[i], i);
    const right = xOf(points[i + 1], i + 1);
    ctx.fillRect(left, gearTop, Math.max(1, right - left), 16);
  }
  ctx.fillStyle = "#a8a292";
  ctx.fillText("km/h  ·  amber is the posted limit  ·  green is vehicle speed  ·  strip is gear", 48, 272);
  canvas._map = { x0, x1, points, mode: state.chartMode };
}

function drawSoc(canvas, points) {
  const ctx = prep(canvas, 140);
  const w = canvas.clientWidth;
  const h = 140;
  ctx.clearRect(0, 0, w, h);
  if (points.length < 2) return;
  const x0 = xAt(points, 0);
  const x1 = xAt(points, points.length - 1);
  const xOf = (_p, i) => 48 + ((xAt(points, i) - x0) / Math.max(1, x1 - x0)) * (w - 64);
  const yOf = (v) => 16 + 90 - (v / 100) * 90;
  ctx.strokeStyle = "#31382c";
  ctx.fillStyle = "#a8a292";
  ctx.font = "12px Consolas, monospace";
  ctx.beginPath();
  ctx.moveTo(48, yOf(0));
  ctx.lineTo(w - 16, yOf(0));
  ctx.stroke();
  stroke(ctx, points, xOf, (p) => yOf(p.soc), "#7aa2d6");
  ctx.fillText("State of charge %", 48, 128);
}

function prep(canvas, height) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800;
  canvas.width = Math.max(320, w) * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function stroke(ctx, points, xOf, yOf, color) {
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xOf(p, i);
    const y = yOf(p, i);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

function hover(ev, canvas, points) {
  if (!canvas._map || points.length < 2) return;
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const { x0, x1, mode } = canvas._map;
  const ratio = (x - 48) / Math.max(1, rect.width - 64);
  let best = points[0];
  if (mode === "drive") {
    const idx = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
    best = points[idx];
  } else {
    const t = x0 + ratio * (x1 - x0);
    let bestD = Infinity;
    for (const p of points) {
      const d = Math.abs(p.t - t);
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
  }
  const node = $("readout");
  if (node) {
    node.textContent = `${fmtTime(new Date(best.t).toISOString())}  ${best.speed.toFixed(1)} km/h  limit ${best.limit.toFixed(0)}  gear ${best.gear}  SOC ${best.soc.toFixed(1)}%  ${best.phase}`;
  }
}

function renderLogs() {
  const panel = $("panel-logs");
  panel.textContent = "";
  panel.appendChild(el("h2", "Logs"));
  panel.appendChild(el("p", "Telemetry rows as they will sit in OpenSearch. Open a row for the Tesla fields, the VSS tree, the camera tracks, and the CAN frames. A Drive-tab trip shows up here as manual or self-drive. The Seen column is what the cameras reported: vehicles, pedestrians, obstacles, curbs, parking, and who is in the cabin.", "lede"));
  const row = el("div", null, "row");
  const pick = document.createElement("select");
  pick.id = "log-run";
  for (const run of state.runs) {
    const kind = run.scenario === "self-drive" ? "self-drive" : run.scenario === "manual" ? "manual drive" : run.scenario;
    const route = run.route ? ` · ${run.route}` : "";
    const opt = el("option", `${fmtTime(run.created_at)} · ${run.driver_name} · ${kind}${route} · ${run.samples} rows`);
    opt.value = run.id;
    pick.appendChild(opt);
  }
  const focus = state.log.focusId;
  if (focus && [...pick.options].some((opt) => opt.value === focus)) {
    pick.value = focus;
  } else if (state.view && [...pick.options].some((opt) => opt.value === state.view.run.id)) {
    pick.value = state.view.run.id;
  }
  const phase = document.createElement("select");
  phase.id = "log-phase";
  for (const name of ["", "driving", "maneuver", "access", "parked", "charging"]) {
    const opt = el("option", name || "All phases");
    opt.value = name;
    phase.appendChild(opt);
  }
  phase.value = state.log.phase;
  const prev = el("button", "Previous");
  const next = el("button", "Next");
  prev.addEventListener("click", () => {
    state.log.offset = Math.max(0, state.log.offset - 40);
    loadSamples();
  });
  next.addEventListener("click", () => {
    state.log.offset += 40;
    loadSamples();
  });
  pick.addEventListener("change", () => {
    state.log.offset = 0;
    loadSamples();
  });
  phase.addEventListener("change", () => {
    state.log.phase = phase.value;
    state.log.offset = 0;
    loadSamples();
  });
  row.append(pick, phase, prev, next);
  panel.appendChild(row);
  const tableWrap = el("div", null, "scroll");
  tableWrap.id = "log-table";
  tableWrap.style.marginTop = "12px";
  panel.appendChild(tableWrap);
  const pre = el("pre", "Select a row.", "json");
  pre.id = "log-json";
  panel.appendChild(pre);
}

async function loadSamples() {
  const pick = $("log-run");
  const wrap = $("log-table");
  if (!pick || !wrap || !pick.value) return;
  setStatus("Reading log rows…");
  try {
    const phase = state.log.phase ? `&phase=${state.log.phase}` : "";
    const data = await api(`/api/runs/${pick.value}/samples?offset=${state.log.offset}&limit=40${phase}`);
    wrap.textContent = "";
    const table = document.createElement("table");
    const head = document.createElement("tr");
    for (const name of ["Time", "Phase", "km/h", "Gear", "SOC", "Doors", "Windows", "Wiper", "Lock", "Belt", "Seen"]) {
      head.appendChild(el("th", name));
    }
    const thead = document.createElement("thead");
    thead.appendChild(head);
    table.appendChild(thead);
    const body = document.createElement("tbody");
    for (const doc of data.samples) {
      const r = doc.reading;
      const tr = document.createElement("tr");
      tr.className = "clickable";
      const windows = Object.values(r.windows_pct).every((v) => v < 1) ? "shut" : Object.entries(r.windows_pct).filter(([, v]) => v >= 1).map(([k, v]) => `${k} ${v}%`).join(" ");
      const cells = [
        fmtTime(doc["@timestamp"]),
        doc.phase,
        r.speed_kmh.toFixed(1),
        r.gear,
        r.soc.toFixed(1),
        r.doors_open.length ? r.doors_open.join(", ") : "shut",
        windows,
        r.wiper,
        r.locked ? "locked" : "open",
        r.belted ? "on" : "off",
        r.seen || "",
      ];
      for (const value of cells) tr.appendChild(el("td", value));
      tr.addEventListener("click", () => {
        $("log-json").textContent = JSON.stringify(doc, null, 2);
      });
      body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    if (state.tab === "logs") {
      setStatus(`${data.samples.length} rows from offset ${data.offset}. File holds ${data.total} telemetry documents.`);
    }
  } catch (err) {
    if (state.tab === "logs") setStatus(err.message);
  }
}

async function noteDrive(run) {
  if (!run) return;
  state.log.focusId = run.id;
  try {
    state.runs = (await api("/api/runs")).runs;
    state.drivers = (await api("/api/drivers")).drivers;
  } catch (_err) {
    return;
  }
  const kind = run.scenario === "self-drive" ? "self-drive" : "manual drive";
  const where = run.route ? ` on ${run.route}` : "";
  const rows = run.samples === 1 ? "1 row" : `${run.samples} rows`;
  if (state.tab === "fleet") renderFleet();
  if (state.tab === "logs") {
    renderLogs();
    loadSamples();
  }
  setStatus(`${run.driver_name}'s ${kind}${where} is in Logs, ${rows}.`);
}

async function hydrateLatest() {
  if (state.view || !state.runs.length) return;
  state.view = await api(`/api/runs/${state.runs[0].id}`);
}

function renderUeba() {
  const panel = $("panel-ueba");
  panel.textContent = "";
  panel.appendChild(el("h2", "UEBA"));
  panel.appendChild(el("p", "Absolute score uses fixed safety envelopes. Personal notes compare a driver with their own earlier days. Gear, windows, mirrors, and wipers describe the habit. They move the score when they show up as speeding, hard braking, an open door, or a car left unlocked.", "lede"));
  const canvas = document.createElement("canvas");
  canvas.id = "score-chart";
  canvas.height = 220;
  panel.appendChild(canvas);
  const tableWrap = el("div", null, "scroll");
  tableWrap.style.marginTop = "12px";
  const table = document.createElement("table");
  const keys = [
    ["distance_km", "Distance km", (v) => Number(v).toFixed(1)],
    ["avg_speed_kmh", "Avg km/h", (v) => Number(v).toFixed(0)],
    ["max_speed_kmh", "Peak km/h", (v) => Number(v).toFixed(0)],
    ["speeding_s", "Speeding s", (v) => Number(v).toFixed(0)],
    ["hard_brake_count", "Hard brakes", (v) => String(v)],
    ["hard_accel_count", "Hard launches", (v) => String(v)],
    ["gear_shifts", "Gear shifts", (v) => String(v)],
    ["reverse_count", "Reverse", (v) => String(v)],
    ["door_cycles", "Door cycles", (v) => String(v)],
    ["door_open_while_moving_s", "Door ajar s", (v) => Number(v).toFixed(0)],
    ["window_changes", "Windows", (v) => String(v)],
    ["mirror_events", "Mirrors", (v) => String(v)],
    ["wiper_s", "Wiper s", (v) => Number(v).toFixed(0)],
    ["seatbelt_off_s", "Belt off s", (v) => Number(v).toFixed(0)],
    ["unlocked_away_s", "Unlocked s", (v) => Number(v).toFixed(0)],
    ["end_soc", "End SOC", (v) => Number(v).toFixed(0)],
  ];
  const head = document.createElement("tr");
  head.appendChild(el("th", "Signal"));
  for (const item of state.board) head.appendChild(el("th", item.driver.name));
  const thead = document.createElement("thead");
  thead.appendChild(head);
  table.appendChild(thead);
  const body = document.createElement("tbody");
  const scoreRow = document.createElement("tr");
  scoreRow.appendChild(el("td", "Absolute risk"));
  for (const item of state.board) {
    const score = item.ueba ? item.ueba.absolute.score : null;
    const cell = el("td");
    const pill = el("span", score == null ? "—" : String(score), `band ${band(score)}`);
    cell.appendChild(pill);
    scoreRow.appendChild(cell);
  }
  body.appendChild(scoreRow);
  for (const [key, label, fmt] of keys) {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", label));
    for (const item of state.board) {
      const metrics = item.ueba && item.ueba.metrics;
      tr.appendChild(el("td", metrics ? fmt(metrics[key] || 0) : "—"));
    }
    body.appendChild(tr);
  }
  table.appendChild(body);
  tableWrap.appendChild(table);
  panel.appendChild(tableWrap);
  const cards = el("div", null, "grid");
  for (const item of state.board) {
    const card = el("div", null, "card");
    card.style.borderLeftColor = item.driver.color;
    card.appendChild(el("h3", item.driver.name));
    if (!item.ueba) {
      card.appendChild(el("p", "No day on file yet.", "meta"));
      cards.appendChild(card);
      continue;
    }
    const pill = el("span", `${item.ueba.absolute.band} ${item.ueba.absolute.score}`, `band ${item.ueba.absolute.band}`);
    card.appendChild(pill);
    for (const line of item.ueba.habit) card.appendChild(el("p", line));
    if (item.ueba.absolute.factors.length) {
      card.appendChild(el("h3", "Why the score moved"));
      for (const factor of item.ueba.absolute.factors) {
        const line = el("div", null, "factor");
        line.appendChild(el("span", factor.detail));
        line.appendChild(el("strong", String(factor.points)));
        card.appendChild(line);
      }
    }
    card.appendChild(el("p", item.ueba.personal.note, "footnote"));
    for (const anomaly of item.ueba.personal.items) card.appendChild(el("p", anomaly.detail));
    cards.appendChild(card);
  }
  panel.appendChild(cards);
  requestAnimationFrame(drawScoreChart);
}

function drawScoreChart() {
  const canvas = $("score-chart");
  if (!canvas) return;
  const ctx = prep(canvas, 220);
  const w = canvas.clientWidth;
  ctx.clearRect(0, 0, w, 220);
  const items = state.board.filter((item) => item.ueba);
  ctx.fillStyle = "#a8a292";
  ctx.font = "12px Consolas, monospace";
  if (!items.length) {
    ctx.fillText("Run a day to score the fleet.", 16, 32);
    return;
  }
  const gap = w / items.length;
  items.forEach((item, i) => {
    const score = item.ueba.absolute.score;
    const bh = (score / 100) * 150;
    const x = gap * i + gap * 0.25;
    ctx.fillStyle = item.driver.color;
    ctx.fillRect(x, 180 - bh, gap * 0.4, bh);
    ctx.fillStyle = "#ece7dc";
    ctx.fillText(item.driver.name, x, 200);
    ctx.fillText(String(score), x, 172 - bh);
  });
}

function renderSignals() {
  const panel = $("panel-signals");
  panel.textContent = "";
  panel.appendChild(el("h2", "How the logs are produced"));
  const prose = el("div", null, "prose");
  for (const paragraph of state.meta.standards) prose.appendChild(el("p", paragraph));
  panel.appendChild(prose);
  panel.appendChild(el("h2", "Signal catalog"));
  const wrap = el("div", null, "scroll");
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const name of ["Group", "Tesla field", "VSS path", "Tesla unit", "VSS unit", "CAN frame"]) {
    head.appendChild(el("th", name));
  }
  const thead = document.createElement("thead");
  thead.appendChild(head);
  table.appendChild(thead);
  const body = document.createElement("tbody");
  for (const signal of state.catalog) {
    const tr = document.createElement("tr");
    for (const value of [signal.group, signal.tesla, signal.vss, signal.unit_tesla, signal.unit_vss, signal.frame]) {
      tr.appendChild(el("td", value || "—"));
    }
    body.appendChild(tr);
    if (signal.note) {
      const note = document.createElement("tr");
      const cell = el("td", signal.note);
      cell.colSpan = 6;
      note.appendChild(cell);
      body.appendChild(note);
    }
  }
  table.appendChild(body);
  wrap.appendChild(table);
  panel.appendChild(wrap);
  panel.appendChild(el("p", "Bulk export is newline-delimited JSON with an OpenSearch action line in front of each document. Indexes: vehicle-telemetry and vehicle-events. Wiring the cluster is the next step.", "footnote"));
}

async function boot() {
  buildNav();
  setStatus("Loading the lab…");
  const [meta, drivers, runs, board, catalog] = await Promise.all([
    api("/api/meta"),
    api("/api/drivers"),
    api("/api/runs"),
    api("/api/ueba"),
    api("/api/catalog"),
  ]);
  state.meta = meta;
  state.drivers = drivers.drivers;
  state.runs = runs.runs;
  state.board = board.board;
  state.catalog = catalog.signals;
  state.selectedId = state.drivers[0] ? state.drivers[0].id : null;
  await hydrateLatest();
  renderFleet();
  renderDriver();
  renderRun();
  renderTimeline();
  renderLogs();
  renderUeba();
  renderSignals();
  setStatus("Ready. Run a day to write telemetry.");
  window.Relay = { state, api, setStatus, renderFleet, renderDriver, renderRun, noteDrive };
  if (window.Drive) Drive.mount();
  window.addEventListener("resize", () => {
    if (state.tab === "timeline") drawCharts();
    if (state.tab === "ueba") drawScoreChart();
    if (state.tab === "drive" && window.Drive) Drive.resize();
  });
}

boot().catch((err) => setStatus(err.message));
