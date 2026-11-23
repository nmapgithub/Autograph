/* Graphical A-to-B drive. The 2D tab is the side view. The 3D tab is the same roads from behind the car. */
(function () {
  const PATHS = [
    {
      name: "Street",
      blurb: "1.0 km · 40 km/h · speed breakers",
      limit: 40,
      tone: ["#1c3330", "#16302a"],
      obstacles: [],
    },
    {
      name: "Avenue",
      blurb: "1.0 km · 60 km/h · breakers and hurdles",
      limit: 60,
      tone: ["#2a261c", "#241f18"],
      obstacles: [],
    },
    {
      name: "Ring road",
      blurb: "1.0 km · 90 km/h · open, one of each",
      limit: 90,
      tone: ["#1a2838", "#162433"],
      obstacles: [],
    },
  ];

  const DOORS = [
    ["df", "Driver"],
    ["dr", "Rear"],
    ["pf", "Passenger"],
    ["pr", "Pass. rear"],
    ["frunk", "Frunk"],
    ["trunk", "Trunk"],
  ];

  const sim = blank();
  let mounted = false;
  let active = false;
  let looping = false;
  let last = 0;
  let canvas;
  let ctx;
  let canvas3;
  let ctx3;
  let view = "";
  let px = 4;
  let pendingDeal = true;

  function blank() {
    return {
      driverId: null,
      path: 0,
      pathAnim: 0,
      meters: 0,
      prevMeters: 0,
      speed: 0,
      gear: "P",
      shifts: 0,
      mode: "manual",
      phase: "manual",
      phaseT: 0,
      doorStep: 0,
      doorOpening: true,
      plan: [],
      reverses: 0,
      shuffle: "out",
      arrived: false,
      belt: true,
      locked: true,
      lights: false,
      high: false,
      hazard: false,
      wipers: false,
      rain: false,
      wiper: 0,
      mirrorsFolded: false,
      mirrorKick: 0,
      nextNudge: 200,
      window: 0,
      windowTarget: 0,
      didWindow: false,
      didShut: false,
      doors: { df: 0, dr: 0, pf: 0, pr: 0, frunk: 0, trunk: 0 },
      doorTarget: { df: 0, dr: 0, pf: 0, pr: 0, frunk: 0, trunk: 0 },
      bounce: 0,
      shake: 0,
      wheel: 0,
      hardStop: false,
      hint: "",
      hits: { breakers: 0, hurdles: 0 },
      log: [],
      seen: {},
      lane: 1,
      laneAnim: 1,
      laneTarget: 1,
      blinker: "off",
      blinkUntil: 0,
      policy: "avoid",
      latAccel: 0,
      longAccel: 0,
      prevSpeed: 0,
      impactAccel: 0,
      impactUntil: 0,
      aebUntil: 0,
      aebHold: false,
      dodgeId: "",
      hitIds: {},
    };
  }

  const keys = { up: false, down: false, brake: false };
  const pad = { up: false, down: false };

  function driver() {
    const relay = window.Relay;
    if (!relay) return null;
    return relay.state.drivers.find((d) => d.id === sim.driverId) || relay.state.drivers.find((d) => d.id === relay.state.selectedId) || relay.state.drivers[0];
  }

  function params() {
    const d = driver();
    return d ? d.params : { cruise_kmh: 60, speeding_bias: 0, accel_mps2: 1.4, brake_mps2: 1.8, hard_brake_rate: 0, hard_accel_rate: 0, autopilot_share: 0, gear_shifts_per_trip: 4, door_cycles_per_trip: 2, window_changes_per_trip: 0, mirror_adjustments_per_trip: 0, wiper_tendency: 0, seatbelt_compliance: 1, lock_compliance: 1 };
  }

  function pushLog(text, fields) {
    sim.log.unshift(text);
    sim.log = sim.log.slice(0, 8);
    for (const id of ["drive-log", "drive3d-log"]) {
      const box = document.getElementById(id);
      if (!box) continue;
      box.textContent = "";
      for (const line of sim.log) box.appendChild(Object.assign(document.createElement("div"), { textContent: line }));
    }
    capture(text, fields);
  }

  const rec = {
    token: 0,
    runId: null,
    driverId: null,
    mode: null,
    active: false,
    acc: 0,
    pending: [],
    events: [],
    pre: [],
    chain: Promise.resolve(),
  };

  function eventKind(text) {
    const t = text.toLowerCase();
    if (t.includes("collision")) return "collision";
    if (t.includes("lane change")) return "lane_change";
    if (t.includes("emergency braking")) return "aeb";
    if (t.includes("gear")) return "gear_shift";
    if (t.includes("door") || t.includes("frunk") || t.includes("trunk")) return "door";
    if (t.includes("breaker")) return "speed_breaker";
    if (t.includes("hurdle")) return "hurdle";
    if (t.includes("belt")) return "seatbelt";
    if (t.includes("lock")) return "lock";
    if (t.includes("window")) return "window";
    if (t.includes("mirror")) return "mirror";
    if (t.includes("path")) return "path";
    if (t.includes("wheel")) return "takeover";
    return "note";
  }

  function eventSeverity(text) {
    const t = text.toLowerCase();
    if (t.includes("collision") || t.includes("stopped") || t.includes("hit at")) return "alert";
    if (t.includes("emergency braking")) return "watch";
    if (t.includes("unlocked") || t.includes("over the")) return "watch";
    return "info";
  }

  function capture(text, fields) {
    if (!text || text.startsWith("At point A")) return;
    const item = {
      at: performance.now(),
      kind: eventKind(text),
      text: text.slice(0, 240),
      severity: eventSeverity(text),
      speed_kmh: kmh(),
      gear: sim.gear,
      fields: fields || {},
    };
    if (!rec.active) {
      rec.pre.push(item);
      if (rec.pre.length > 30) rec.pre.shift();
      return;
    }
    rec.events.push(item);
  }

  function snapshot() {
    const path = PATHS[sim.path];
    const p = params();
    const doors = {};
    for (const id of ["df", "dr", "pf", "pr"]) doors[id] = sim.doors[id] > 0.5;
    return {
      at: performance.now(),
      meters: Math.round(sim.meters * 10) / 10,
      speed_kmh: Math.round(kmh() * 10) / 10,
      gear: sim.gear,
      long_accel: Math.round((performance.now() < sim.impactUntil ? sim.impactAccel : sim.longAccel) * 100) / 100,
      lat_accel: Math.round(sim.latAccel * 100) / 100,
      pedal: keys.up || pad.up ? 45 : 0,
      brake_pct: performance.now() < sim.aebUntil || keys.brake ? 100 : keys.down || pad.down ? 40 : 0,
      path: path.name,
      limit_kmh: path.limit,
      heading: sim.path * 12 + (sim.laneTarget - sim.laneAnim) * 8,
      turn: sim.blinker === "left" ? "TurnSignalStateLeft" : sim.blinker === "right" ? "TurnSignalStateRight" : "TurnSignalStateOff",
      aeb: performance.now() < sim.aebUntil,
      doors,
      window_pct: Math.round(sim.window * 100),
      wiper: !!sim.wipers,
      rain: !!sim.rain,
      belt: !!sim.belt,
      locked: !!sim.locked,
      lights: !!sim.lights,
      high: !!sim.high,
      hazard: !!sim.hazard,
      mirrors_folded: !!sim.mirrorsFolded,
      mirror_nudge: sim.mirrorKick > 0.85,
      frunk: sim.doors.frunk > 0.5,
      trunk: sim.doors.trunk > 0.5,
      autopilot: sim.mode === "auto" && path.limit >= 80 && p.autopilot_share >= 0.35,
      mode: rec.mode || (sim.mode === "auto" ? "self-drive" : "manual"),
    };
  }

  function stamp(items, now) {
    return items.map((item) => {
      const copy = Object.assign({}, item);
      copy.age_ms = Math.max(0, Math.round(now - item.at));
      delete copy.at;
      return copy;
    });
  }

  function takePayload(finished) {
    if (!rec.pending.length && !rec.events.length && !(finished && rec.runId)) return null;
    const relay = window.Relay;
    const d = (relay && rec.driverId && relay.state.drivers.find((item) => item.id === rec.driverId)) || driver();
    if (!d) return null;
    const now = performance.now();
    const body = {
      driver_id: d.id,
      run_id: rec.runId,
      mode: rec.mode || "manual",
      path: PATHS[sim.path].name,
      finished: !!finished,
      samples: stamp(rec.pending, now),
      events: stamp(rec.events, now),
    };
    rec.pending = [];
    rec.events = [];
    return body;
  }

  function enqueue(body, token) {
    rec.chain = rec.chain.then(async () => {
      try {
        const res = await fetch("/api/drives", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          keepalive: !!body.finished,
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!data.run || !window.Relay || !window.Relay.noteDrive) return;
        if (!body.finished && rec.token === token && rec.active) {
          const first = !rec.runId;
          rec.runId = data.run.id;
          if (first) window.Relay.noteDrive(data.run);
          return;
        }
        if (body.finished) window.Relay.noteDrive(data.run);
      } catch (_err) {
        /* the next batch retries the live trip */
      }
    });
  }

  function flush(finished) {
    const body = takePayload(finished);
    if (!body) return;
    enqueue(body, rec.token);
  }

  function begin(mode) {
    if (rec.active && rec.mode === mode) return;
    if (rec.active) finishNow();
    if (sim.meters <= 45 && pendingDeal) {
      scatterRoads();
      pushLog(`New placement. ${sceneLine()}`);
    }
    const who = driver();
    rec.token += 1;
    rec.active = true;
    rec.mode = mode;
    rec.driverId = who ? who.id : null;
    rec.runId = null;
    rec.acc = 0;
    rec.pending = [];
    rec.events = rec.pre.splice(0, rec.pre.length);
    rec.pending.push(snapshot());
  }

  function finishNow() {
    if (!rec.active && !rec.runId) return;
    const token = rec.token;
    const body = takePayload(true);
    rec.active = false;
    rec.mode = null;
    rec.driverId = null;
    rec.runId = null;
    rec.pending = [];
    rec.events = [];
    pendingDeal = true;
    if (body) enqueue(body, token);
  }

  function maybeLog(dt) {
    const moving = Math.abs(sim.speed) > 0.4;
    if (!rec.active && !sim.arrived && moving) begin(sim.mode === "auto" ? "self-drive" : "manual");
    if (!rec.active) return;
    rec.acc += dt;
    if (rec.acc < 0.5) return;
    rec.acc = 0;
    rec.pending.push(snapshot());
    if (rec.pending.length >= 2 || rec.events.length >= 6) flush(false);
  }

  window.addEventListener("pagehide", () => {
    if (!rec.active && !rec.pending.length && !rec.events.length) return;
    const body = takePayload(true);
    rec.active = false;
    if (!body) return;
    fetch("/api/drives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    });
  });

  function setGear(next) {
    if (sim.gear === next) return;
    if ((next === "P" || next === "R") && Math.abs(sim.speed) > 0.8 && !(next === "R" && sim.speed < 0)) {
      sim.hint = "Almost stop before that shift.";
      return;
    }
    sim.gear = next;
    sim.shifts += 1;
    if ((next === "D" || next === "R") && !rec.active) begin("manual");
    pushLog(`Gear ${next}`);
  }

  function applyHabits() {
    const p = params();
    sim.belt = p.seatbelt_compliance >= 0.9;
    sim.locked = p.lock_compliance >= 0.8;
    sim.rain = p.wiper_tendency >= 0.45;
    sim.wipers = sim.rain;
    sim.lights = false;
    sim.high = false;
    sim.hazard = false;
  }

  function resetCar() {
    finishNow();
    const path = sim.path;
    const pathAnim = sim.pathAnim;
    const driverId = sim.driverId;
    const fresh = blank();
    Object.assign(sim, fresh);
    sim.path = path;
    sim.pathAnim = pathAnim;
    sim.driverId = driverId;
    applyHabits();
    scatterRoads();
    pushLog(`At point A. ${sceneLine()} Shift to Drive, or start self-drive.`);
    syncButtons();
  }

  function sceneLine() {
    const path = PATHS[sim.path];
    const people = VISION[path.name].pedestrian.length;
    const breaks = path.obstacles.filter((o) => o.kind === "breaker").map((o) => `${o.m} m`);
    const hurdles = path.obstacles.filter((o) => o.kind === "hurdle").map((o) => `${o.m} m`);
    const who = people === 1 ? "1 person" : `${people} people`;
    return `Breakers ${breaks.join(", ") || "none"}. Hurdles ${hurdles.join(", ") || "none"}. ${who}.`;
  }

  function scatterRoads() {
    const recipes = {
      Street: { breakers: [3, 5], hurdles: [0, 1], people: [1, 3], cross: 0.6 },
      Avenue: { breakers: [1, 3], hurdles: [1, 2], people: [1, 2], cross: 0.5 },
      "Ring road": { breakers: [0, 2], hurdles: [0, 1], people: [0, 2], cross: 0.3 },
    };
    for (const path of PATHS) {
      const recipe = recipes[path.name];
      const used = [];
      const take = (gap) => {
        for (let n = 0; n < 60; n += 1) {
          const m = Math.round(70 + Math.random() * 860);
          if (used.every((u) => Math.abs(u - m) >= gap)) {
            used.push(m);
            return m;
          }
        }
        const m = Math.round(70 + Math.random() * 860);
        used.push(m);
        return m;
      };
      const count = (pair) => pair[0] + Math.floor(Math.random() * (pair[1] - pair[0] + 1));
      const obstacles = [];
      for (let i = 0; i < count(recipe.breakers); i += 1) obstacles.push({ m: take(75), kind: "breaker" });
      for (let i = 0; i < count(recipe.hurdles); i += 1) obstacles.push({ m: take(75), kind: "hurdle" });
      obstacles.sort((a, b) => a.m - b.m);
      path.obstacles = obstacles;
      const people = [];
      for (let i = 0; i < count(recipe.people); i += 1) people.push([take(60), Math.random() < recipe.cross]);
      people.sort((a, b) => a[0] - b[0]);
      VISION[path.name].pedestrian = people;
    }
    sim.seen = {};
    sim.hitIds = {};
    sim.dodgeId = "";
    sim.lane = 1;
    sim.laneAnim = 1;
    sim.laneTarget = 1;
    sim.blinker = "off";
    sim.aebHold = false;
    pendingDeal = false;
  }

  function kmh() {
    return Math.abs(sim.speed) * 3.6;
  }

  const SHELLS = {
    drive: {
      title: "2D Drive",
      lede: "Side view of three roads, each 1.0 km from A to B. Arrow keys drive. The buttons are the car. Self-drive uses the numbers saved for that driver: cruise, braking, doors, windows, belt, lock, wipers. Speed breakers, hurdles, and people are placed again for each drive.",
      canvas: "drive-canvas",
      label: "Car moving from point A to point B, side view",
    },
    drive3d: {
      title: "3D Drive",
      lede: "The same three roads, from just behind the car. Arrow keys drive. Left and right move across to Street, Avenue, or Ring road. Gear, doors, windows, and lamps are the same car as 2D Drive, and the trip is logged the same way. Speed breakers, hurdles, and people are placed again for each drive.",
      canvas: "drive3d-canvas",
      label: "Car moving from point A to point B, seen from behind",
    },
  };

  function mount() {
    if (mounted || !window.Relay) return;
    buildShell("drive");
    buildShell("drive3d");
    canvas = document.getElementById("drive-canvas");
    canvas3 = document.getElementById("drive3d-canvas");
    ctx = canvas.getContext("2d");
    ctx3 = canvas3.getContext("2d");
    mounted = true;
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    refresh();
    resetCar();
    if (active) setActive(view || "drive");
  }

  function buildShell(which) {
    const spec = SHELLS[which];
    const panel = document.getElementById(`panel-${which}`);
    panel.textContent = "";
    panel.appendChild(h("h2", spec.title));
    panel.appendChild(h("p", spec.lede, "lede"));

    const head = div("drive-head");
    const sel = document.createElement("select");
    sel.id = `${which}-driver`;
    sel.addEventListener("change", () => {
      window.Relay.state.selectedId = sel.value;
      window.Relay.renderDriver();
      window.Relay.renderRun();
      sim.driverId = sel.value;
      resetCar();
      const d = driver();
      window.Relay.setStatus(d ? `${d.name} is at point A.` : "");
      updateCaption();
    });
    const name = document.createElement("input");
    name.id = `${which}-new-name`;
    name.placeholder = "Add a driver";
    name.autocomplete = "off";
    const add = button("Add driver", addDriver);
    head.append(sel, name, add);
    const modes = div("row");
    const self = button("Self-drive", toggleAuto, "mode-auto");
    modes.append(
      button("Drive manually", takeWheel, "mode-manual"),
      self,
      button("Reset to A", () => {
        resetCar();
        window.Relay.setStatus("Back at point A.");
      })
    );
    head.appendChild(modes);
    panel.appendChild(head);
    const policy = div("drive-policy");
    policy.hidden = true;
    policy.dataset.role = "policy";
    policy.append(
      h("span", "Self-drive can avoid everyone, or mix it: some lane changes, some collisions."),
      button("Avoid collisions", () => choosePolicy("avoid")),
      button("Hybrid", () => choosePolicy("hybrid")),
      button("Cancel", hidePolicy)
    );
    panel.appendChild(policy);
    panel.appendChild(h("p", "", "meta"));
    panel.lastChild.id = `${which}-caption`;

    const picks = div("path-pick");
    PATHS.forEach((p, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "path-card";
      b.dataset.ctl = `path-${i}`;
      b.innerHTML = `<strong>${p.name}</strong><small>${p.blurb}</small>`;
      b.addEventListener("click", () => choosePath(i));
      picks.appendChild(b);
    });
    panel.appendChild(picks);

    const groups = div("drive-groups");
    groups.appendChild(group("Gear", ["P", "R", "N", "D"].map((g) => toggle(`gear-${g}`, g, () => {
      if (sim.mode === "auto") takeWheel();
      setGear(g);
    }))));
    groups.appendChild(group("Doors", DOORS.map(([id, label]) => toggle(`door-${id}`, label, () => {
      sim.doorTarget[id] = sim.doorTarget[id] > 0.5 ? 0 : 1;
      if (sim.doorTarget[id] > 0.5) pushLog(`${label} open`);
    }))));
    groups.appendChild(group("Cabin", [
      button("Windows down", () => { sim.windowTarget = Math.min(1, sim.windowTarget + 0.5); pushLog("Window down"); }),
      button("Windows up", () => { sim.windowTarget = Math.max(0, sim.windowTarget - 0.5); pushLog("Window up"); }),
      toggle("mirrors", "Mirrors", () => { sim.mirrorsFolded = !sim.mirrorsFolded; pushLog(sim.mirrorsFolded ? "Mirrors folded" : "Mirrors unfolded"); }),
      toggle("wipers", "Wipers", () => { sim.wipers = !sim.wipers; }),
      toggle("belt", "Seatbelt", () => { sim.belt = !sim.belt; pushLog(sim.belt ? "Belt on" : "Belt off"); }),
      toggle("lock", "Lock", () => { sim.locked = !sim.locked; pushLog(sim.locked ? "Locked" : "Unlocked"); }),
    ]));
    groups.appendChild(group("Lamps", [
      toggle("lamps", "Lamps", () => { sim.lights = !sim.lights; }),
      toggle("high", "High beam", () => { sim.high = !sim.high; if (sim.high) sim.lights = true; }),
      toggle("hazard", "Hazards", () => { sim.hazard = !sim.hazard; }),
    ]));
    panel.appendChild(groups);

    const stage = div("drive-stage");
    const viewCanvas = document.createElement("canvas");
    viewCanvas.id = spec.canvas;
    viewCanvas.setAttribute("role", "img");
    viewCanvas.setAttribute("aria-label", spec.label);
    stage.appendChild(viewCanvas);
    panel.appendChild(stage);

    const padWrap = div("drive-pad-row");
    const padBox = div("drive-pad");
    const up = button("↑", null, "pad-up");
    const left = button("←", () => choosePath(sim.path - 1), "pad-left");
    const down = button("↓", null, "pad-down");
    const right = button("→", () => choosePath(sim.path + 1), "pad-right");
    hold(up, "up");
    hold(down, "down");
    padBox.append(up, left, down, right);
    const help = h("p", "Arrow keys, or these buttons. Up accelerates, down brakes, left and right change path. Space is a hard brake. The car's pull and stop use that driver's acceleration and braking.", "footnote");
    padWrap.append(padBox, help);
    panel.appendChild(padWrap);

    const readout = h("p", "", "drive-readout mono");
    readout.id = `${which}-readout`;
    panel.appendChild(readout);
    const log = div("drive-log");
    log.id = `${which}-log`;
    panel.appendChild(log);
  }

  function h(tag, text, className) {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    if (className) node.className = className;
    return node;
  }

  function div(className) {
    return h("div", "", className);
  }

  function button(label, fn, ctl) {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = label;
    if (ctl) node.dataset.ctl = ctl;
    if (ctl && ctl.startsWith("pad-")) node.classList.add(ctl);
    if (fn) node.addEventListener("click", fn);
    return node;
  }

  function toggle(ctl, label, fn) {
    const node = button(label, fn, ctl);
    return node;
  }

  function group(title, nodes) {
    const row = div("drive-group");
    row.appendChild(h("span", title, "drive-label"));
    for (const node of nodes) row.appendChild(node);
    return row;
  }

  function hold(node, which) {
    const on = (event) => {
      event.preventDefault();
      pad[which] = true;
      if (sim.mode === "auto") takeWheel();
    };
    const off = () => { pad[which] = false; };
    node.addEventListener("pointerdown", on);
    node.addEventListener("pointerup", off);
    node.addEventListener("pointercancel", off);
    node.addEventListener("pointerleave", off);
  }

  function refresh() {
    if (!mounted || !window.Relay) return;
    const previous = sim.driverId;
    const keep = window.Relay.state.selectedId;
    let chosen = "";
    for (const id of ["drive-driver", "drive3d-driver"]) {
      const sel = document.getElementById(id);
      if (!sel) continue;
      sel.textContent = "";
      for (const d of window.Relay.state.drivers) {
        const opt = document.createElement("option");
        opt.value = d.id;
        opt.textContent = `${d.name} — ${d.city}`;
        sel.appendChild(opt);
      }
      if (keep && window.Relay.state.drivers.some((d) => d.id === keep)) sel.value = keep;
      chosen = sel.value;
    }
    if (previous && previous !== chosen) resetCar();
    sim.driverId = chosen || null;
    updateCaption();
  }

  function updateCaption() {
    const d = driver();
    if (!d) return;
    const p = d.params;
    const over = Math.round(p.speeding_bias * 100);
    const text = `${d.vehicle_name}. Pulls away at ${p.accel_mps2} m/s², brakes at ${p.brake_mps2} m/s². Self-drive settles near ${p.cruise_kmh} km/h, and will hold about ${over}% over a limit. Doors ${p.door_cycles_per_trip}, windows ${p.window_changes_per_trip}, shifts ${p.gear_shifts_per_trip}.`;
    for (const id of ["drive-caption", "drive3d-caption"]) {
      const node = document.getElementById(id);
      if (node) node.textContent = text;
    }
  }

  function setActive(name) {
    if (name === true) name = "drive";
    view = name === "drive" || name === "drive3d" ? name : "";
    active = !!view;
    if (!mounted) return;
    if (!active) return;
    refresh();
    resize();
    if (!looping) {
      looping = true;
      last = performance.now();
      requestAnimationFrame(frame);
    }
  }

  function resize() {
    if (!active) return;
    const node = view === "drive3d" ? canvas3 : canvas;
    const context = view === "drive3d" ? ctx3 : ctx;
    if (!node || !context) return;
    const width = node.parentElement.clientWidth || 800;
    const height = width < 720 ? 460 : 560;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    node.style.width = "100%";
    node.style.height = `${height}px`;
    node.width = Math.max(1, Math.floor(width * dpr));
    node.height = Math.floor(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (view !== "drive3d") px = Math.max(2.4, (width - width * 0.24 - 80) / 200);
    if (view === "drive3d") draw3d();
    else draw();
  }

  function frame(now) {
    if (!active) {
      looping = false;
      return;
    }
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    step(dt);
    if (view === "drive3d") draw3d();
    else draw();
    syncButtons();
    const d = driver();
    if (d) {
      const open = Object.values(sim.doors).some((v) => v > 0.4);
      const warn = [];
      if (open && kmh() > 3) warn.push("door open while moving");
      if (!sim.belt && kmh() > 8) warn.push("belt off");
      if (!sim.locked && sim.arrived) warn.push("left unlocked");
      if (kmh() > PATHS[sim.path].limit + 1 && sim.gear === "D") warn.push("over the limit");
      const laneName = sim.laneAnim < -0.35 ? "left lane" : "right lane";
      const text = `${d.name} · ${sim.mode === "auto" ? "self-drive" : "manual"} · ${PATHS[sim.path].name} · ${laneName} · ${kmh().toFixed(0)} km/h · ${sim.gear} · ${(sim.meters / 1000).toFixed(2)} / 1.00 km${warn.length ? " · " + warn.join(", ") : ""}`;
      for (const id of ["drive-readout", "drive3d-readout"]) {
        const readout = document.getElementById(id);
        if (readout) readout.textContent = text;
      }
    }
    requestAnimationFrame(frame);
  }

  function step(dt) {
    sim.pathAnim += (sim.path - sim.pathAnim) * Math.min(1, dt * 4);
    sim.bounce = Math.max(0, sim.bounce - dt * 2.2);
    sim.shake = Math.max(0, sim.shake - dt * 2.4);
    sim.mirrorKick = Math.max(0, sim.mirrorKick - dt * 1.6);
    sim.hint = "";
    for (const id of Object.keys(sim.doors)) sim.doors[id] = toward(sim.doors[id], sim.doorTarget[id], 2.4 * dt);
    sim.window = toward(sim.window, sim.windowTarget, 1.2 * dt);
    if (sim.wipers) sim.wiper += dt * (sim.rain ? 2.6 : 1.05);
    sim.wheel += sim.speed * dt * 1.4;

    if (sim.mode === "auto") autoStep(dt);
    else manualStep(dt);

    if (sim.meters < 0) {
      sim.meters = 0;
      if (sim.speed < 0) sim.speed = 0;
    }
    if (sim.meters > 1000) {
      sim.meters = 1000;
      if (sim.speed > 0) sim.speed = 0;
    }
    crossObstacles();
    resolveContacts();
    updateLane(dt);
    noteVision();
    sim.longAccel = (sim.speed - sim.prevSpeed) / Math.max(dt, 0.016);
    sim.prevSpeed = sim.speed;
    sim.prevMeters = sim.meters;
    if (sim.mode === "manual" && sim.meters >= 1000 && !sim.arrived) {
      sim.arrived = true;
      pushLog("Point B. Shift to Park.");
      finishNow();
    }
    maybeLog(dt);
  }

  function manualStep(dt) {
    const p = params();
    const throttle = keys.up || pad.up;
    const braking = keys.down || pad.down || keys.brake;
    if (throttle && sim.mode === "auto") return;
    if (braking) {
      const b = keys.brake ? Math.max(p.brake_mps2, 4.6) : p.brake_mps2;
      sim.speed = toward(sim.speed, 0, b * dt);
    } else if (throttle && sim.gear === "D") {
      let a = p.accel_mps2;
      if (sim.meters < 40 && p.hard_accel_rate >= 0.25) a = Math.max(a, 2.9);
      sim.speed = toward(sim.speed, 130 / 3.6, a * dt);
    } else if (throttle && sim.gear === "R") {
      sim.speed = toward(sim.speed, -8, p.accel_mps2 * dt);
    } else if (throttle) {
      sim.hint = sim.gear === "P" ? "Shift out of Park." : "Neutral rolls, it does not pull.";
      coast(dt);
    } else {
      coast(dt);
    }
    sim.meters += sim.speed * dt;
  }

  function coast(dt) {
    const drag = 0.25 + Math.abs(sim.speed) * 0.08;
    sim.speed = toward(sim.speed, 0, drag * dt);
  }

  function autoStep(dt) {
    const p = params();
    if (sim.phase === "doors") {
      sim.speed = toward(sim.speed, 0, 3 * dt);
      if (!sim.plan.length) {
        sim.phase = "shuffle";
        sim.shuffle = "out";
        return;
      }
      const id = sim.plan[sim.doorStep];
      sim.doorTarget[id] = sim.doorOpening ? 1 : 0;
      sim.phaseT -= dt;
      if (sim.phaseT <= 0) {
        if (sim.doorOpening) {
          sim.doorOpening = false;
          sim.phaseT = 0.28;
        } else {
          sim.doorStep += 1;
          sim.doorOpening = true;
          sim.phaseT = 0.32;
          if (sim.doorStep >= sim.plan.length) {
            sim.phase = "shuffle";
            sim.shuffle = "out";
            for (const key of Object.keys(sim.doorTarget)) sim.doorTarget[key] = 0;
          }
        }
      }
      return;
    }
    if (sim.phase === "shuffle") {
      if (sim.reverses <= 0) {
        sim.phase = "cruise";
        setGear("D");
        return;
      }
      if (sim.shuffle === "out") {
        setGear("D");
        sim.speed = toward(sim.speed, 2.4, p.accel_mps2 * dt);
        sim.meters += sim.speed * dt;
        if (sim.meters >= 10) sim.shuffle = "back";
      } else {
        setGear("R");
        sim.speed = toward(sim.speed, -2.2, p.accel_mps2 * dt);
        sim.meters += sim.speed * dt;
        if (sim.meters <= 4) {
          sim.reverses -= 1;
          sim.shuffle = "out";
        }
      }
      return;
    }
    if (sim.phase === "arrive") {
      sim.speed = 0;
      return;
    }
    if (Object.keys(sim.hitIds).length) {
      sim.speed = 0;
      sim.aebHold = true;
      return;
    }
    habitsWhileMoving();
    considerAvoid();
    const target = desiredMs();
    if (sim.speed < target - 0.12) {
      let a = p.accel_mps2;
      if (sim.meters < 50 && p.hard_accel_rate >= 0.25) a = Math.max(a, 2.9);
      sim.speed = toward(sim.speed, target, a * dt);
    } else if (sim.speed > target + 0.12) {
      const b = sim.hardStop ? Math.max(p.brake_mps2, 4.5) : p.brake_mps2;
      sim.speed = toward(sim.speed, target, b * dt);
    }
    if (sim.gear !== "D") setGear("D");
    sim.meters += sim.speed * dt;
    if (sim.meters >= 997 && sim.speed < 0.6) finishAuto();
  }

  function habitsWhileMoving() {
    const p = params();
    if (!sim.belt && sim.meters > 70 + (1 - p.seatbelt_compliance) * 80) {
      sim.belt = true;
      pushLog("Belt fastened");
    }
    if (!sim.didWindow && p.window_changes_per_trip > 0 && sim.meters > 260) {
      sim.windowTarget = Math.min(1, 0.28 * p.window_changes_per_trip);
      sim.didWindow = true;
      pushLog("Window down");
    }
    if (sim.didWindow && !sim.didShut && sim.meters > 860) {
      sim.windowTarget = 0;
      sim.didShut = true;
      pushLog("Windows up");
    }
    if (p.mirror_adjustments_per_trip > 0 && sim.meters > sim.nextNudge) {
      sim.mirrorKick = 1;
      sim.mirrorsFolded = false;
      sim.nextNudge += 900 / p.mirror_adjustments_per_trip;
      pushLog("Mirror nudged");
    }
  }

  function desiredMs() {
    const p = params();
    const path = PATHS[sim.path];
    let target = Math.min(p.cruise_kmh, path.limit * (1 + p.speeding_bias));
    sim.hardStop = false;
    for (const obs of path.obstacles) {
      const dist = obs.m - sim.meters;
      if (dist < -2 || dist > 130) continue;
      if (obs.kind === "breaker") {
        const late = p.hard_brake_rate >= 0.3;
        const reach = late ? 26 : 72;
        const over = late ? Math.min(target, 34) : 15;
        if (dist < reach) {
          target = Math.min(target, over);
          if (late && dist < 26) sim.hardStop = true;
        }
      }
    }
    if (sim.aebHold) {
      target = 0;
      sim.hardStop = true;
      sim.aebUntil = performance.now() + 400;
    }
    const left = 1000 - sim.meters;
    if (left < 90) target = Math.min(target, 22);
    if (left < 28) target = 0;
    return target / 3.6;
  }

  function crossObstacles() {
    const path = PATHS[sim.path];
    for (const obs of path.obstacles) {
      const forward = sim.prevMeters < obs.m && sim.meters >= obs.m;
      const back = sim.prevMeters > obs.m && sim.meters <= obs.m;
      if (!forward && !back || obs.kind !== "breaker") continue;
      const speedKmh = kmh();
      if (obs.kind === "breaker") {
        sim.bounce = 1;
        sim.hits.breakers += 1;
        if (speedKmh > 30) {
          sim.speed *= 0.55;
          sim.shake = 1;
          pushLog(`Speed breaker at ${obs.m} m, hit at ${speedKmh.toFixed(0)} km/h`);
        } else {
          pushLog(`Speed breaker at ${obs.m} m, eased over`);
        }
      }
    }
  }

  const LANE = 1.15;

  function carWorldX() {
    return roadCenter(sim.pathAnim) + sim.laneAnim * LANE;
  }

  function roadActors(index) {
    const cx = roadCenter(index);
    const spec = VISION[PATHS[index].name];
    const list = [];
    for (const obs of PATHS[index].obstacles) {
      if (obs.kind !== "hurdle") continue;
      list.push({ id: `hurdle-${obs.m}`, kind: "hurdle", label: "hurdle", m: obs.m, x: cx + LANE, halfL: 0.5, halfW: 1.15, avoid: obs.avoid !== false });
    }
    if (!spec) return list;
    for (const ped of spec.pedestrian) {
      const meter = ped[0];
      const crosses = ped[1];
      const stepping = crosses && Math.abs(sim.meters - meter) < 18;
      list.push({
        id: `ped-${meter}`,
        kind: "pedestrian",
        label: crosses ? "pedestrian" : "pedestrian on the sidewalk",
        m: meter,
        x: stepping || crosses ? cx + LANE : cx + 4.6,
        hitX: stepping ? cx + LANE : cx + 4.6,
        halfL: 0.35,
        halfW: 0.4,
        avoid: ped.length < 3 ? true : ped[2] !== false,
        anticipate: !!crosses,
      });
    }
    const leadZ = spec.lead[0] + sim.meters * spec.lead[1];
    list.push({ id: "lead", kind: "vehicle", label: "vehicle ahead", m: leadZ, x: cx + LANE, halfL: 2.3, halfW: 0.95, avoid: spec.leadAvoid !== false });
    if (spec.oncoming) {
      list.push({
        id: "oncoming",
        kind: "vehicle",
        label: "oncoming vehicle",
        m: spec.oncoming[0] - sim.meters * spec.oncoming[1],
        x: cx - 2.55,
        halfL: 2.3,
        halfW: 0.95,
        avoid: true,
      });
    }
    return list;
  }

  function actorHitX(actor) {
    return actor.hitX != null ? actor.hitX : actor.x;
  }

  function beginLaneChange(target) {
    if (sim.laneTarget === target) return;
    const dir = target < sim.laneAnim ? "left" : "right";
    sim.laneTarget = target;
    sim.blinker = dir;
    sim.blinkUntil = performance.now() + 3200;
    const signal = dir === "left" ? "TurnSignalStateLeft" : "TurnSignalStateRight";
    const side = dir === "left" ? "Left" : "Right";
    const autopilot = sim.mode === "auto" && PATHS[sim.path].limit >= 80 && params().autopilot_share >= 0.35;
    pushLog(`Lane change ${dir}. Tesla LightsTurnSignal ${signal}, AutopilotActive ${autopilot}. VSS Vehicle.Body.Lights.DirectionIndicator.${side}.IsSignaling. LateralAcceleration is on the samples while the indicator is on.`, {
      object: "lane",
      tesla: {
        LightsTurnSignal: signal,
        AutopilotActive: autopilot,
        AutomaticEmergencyBrakingOff: false,
      },
      vss: {
        "Vehicle.Body.Lights.DirectionIndicator.Left.IsSignaling": dir === "left",
        "Vehicle.Body.Lights.DirectionIndicator.Right.IsSignaling": dir === "right",
      },
    });
  }

  function considerAvoid() {
    if (sim.mode !== "auto" || sim.phase !== "cruise") return;
    const actors = roadActors(sim.path).filter((actor) => actor.anticipate !== false);
    const holding = actors.find((actor) => actor.id === sim.dodgeId);
    if (holding && holding.m > sim.meters - 6) return;
    sim.dodgeId = "";
    sim.aebHold = false;
    const laneX = roadCenter(sim.path) + sim.laneTarget * LANE;
    const threats = actors.filter((actor) => {
      const dist = actor.m - sim.meters;
      if (dist < 8 || dist > 72) return false;
      return Math.abs(actor.x - laneX) < 0.95 + actor.halfW;
    }).sort((a, b) => a.m - b.m);
    if (!threats.length) {
      if (sim.laneTarget !== 1) {
        const homeX = roadCenter(sim.path) + LANE;
        const blocked = actors.some((actor) => {
          const dist = actor.m - sim.meters;
          if (dist < 8 || dist > 60) return false;
          if (actor.avoid === false) return false;
          return Math.abs(actor.x - homeX) < 0.95 + actor.halfW;
        });
        if (!blocked) beginLaneChange(1);
      }
      return;
    }
    const threat = threats[0];
    const dodge = sim.policy === "avoid" || threat.avoid;
    if (!dodge) return;
    const other = sim.laneTarget > 0 ? -1 : 1;
    const otherX = roadCenter(sim.path) + other * LANE;
    const blocked = actors.some((actor) => {
      if (actor.id === threat.id) return false;
      if (actor.avoid === false) return false;
      if (Math.abs(actor.m - threat.m) > 16) return false;
      return Math.abs(actor.x - otherX) < 0.95 + actor.halfW;
    });
    if (blocked) {
      sim.aebHold = true;
      if (!sim.seen[`aeb-${threat.id}`]) {
        sim.seen[`aeb-${threat.id}`] = true;
        pushLog(`Automatic emergency braking for ${threat.label}. Tesla BrakePedal true, AutomaticEmergencyBrakingOff false. VSS Vehicle.ADAS.ABS.IsEngaged.`, {
          object: threat.kind,
          tesla: { BrakePedal: true, AutomaticEmergencyBrakingOff: false, LongitudinalAcceleration: -4.5 },
          vss: { "Vehicle.ADAS.ABS.IsEngaged": true, "Vehicle.Chassis.Brake.PedalPosition": 80 },
        });
      }
      return;
    }
    beginLaneChange(other);
    sim.dodgeId = threat.id;
  }

  function updateLane(dt) {
    const before = sim.laneAnim;
    sim.laneAnim = toward(sim.laneAnim, sim.laneTarget, dt * 1.4);
    sim.latAccel = Math.max(-3.2, Math.min(3.2, ((sim.laneAnim - before) / Math.max(dt, 0.016)) * 1.7));
    if (Math.abs(sim.laneAnim - sim.laneTarget) < 0.08 && performance.now() > sim.blinkUntil) sim.blinker = "off";
  }

  function resolveContacts() {
    if (sim.gear !== "D" && sim.gear !== "R") return;
    const carX = carWorldX();
    for (const actor of roadActors(sim.path)) {
      const hx = actorHitX(actor);
      const along = Math.abs(actor.m - sim.meters);
      const side = Math.abs(hx - carX);
      if (along >= 2.15 + actor.halfL || side >= 0.93 + actor.halfW) continue;
      const approach = sim.speed;
      const gap = 2.15 + actor.halfL;
      if (kmh() < 4) {
        if (approach > 0) sim.meters = Math.min(sim.meters, actor.m - gap);
        if (approach < 0) sim.meters = Math.max(sim.meters, actor.m + gap);
        sim.speed = 0;
        continue;
      }
      if (sim.hitIds[actor.id]) {
        sim.speed = 0;
        continue;
      }
      sim.hitIds[actor.id] = true;
      sim.speed = 0;
      sim.shake = 1.2;
      sim.hazard = true;
      sim.meters = approach >= 0 ? actor.m - gap : actor.m + gap;
      sim.impactAccel = actor.kind === "pedestrian" ? -6.4 : -7.5;
      sim.impactUntil = performance.now() + 1400;
      sim.aebUntil = sim.impactUntil;
      sim.hits.hurdles += 1;
      pushLog(`Collision with ${actor.label}. Tesla BrakePedal true, LongitudinalAcceleration ${sim.impactAccel} m/s^2, LateralAcceleration ${sim.latAccel.toFixed(2)} m/s^2, AutomaticEmergencyBrakingOff false, LightsHazardsActive true. VSS Vehicle.ADAS.ABS.IsEngaged, Vehicle.ADAS.ESC.IsEngaged.`, {
        object: actor.kind,
        tesla: {
          BrakePedal: true,
          LongitudinalAcceleration: sim.impactAccel,
          LateralAcceleration: Math.round(sim.latAccel * 100) / 100,
          AutomaticEmergencyBrakingOff: false,
          LightsHazardsActive: true,
        },
        vss: {
          "Vehicle.ADAS.ABS.IsEngaged": true,
          "Vehicle.ADAS.ESC.IsEngaged": true,
          "Vehicle.Chassis.Brake.PedalPosition": 100,
          "Vehicle.Acceleration.Longitudinal": sim.impactAccel,
        },
      });
    }
  }

  function finishAuto() {
    sim.phase = "arrive";
    sim.meters = 1000;
    sim.speed = 0;
    setGear("P");
    sim.doorTarget.df = 1;
    sim.arrived = true;
    const p = params();
    sim.locked = p.lock_compliance >= 0.75;
    const d = driver();
    pushLog(sim.locked ? `${d.name} parked at B and locked.` : `${d.name} parked at B and left it unlocked.`);
    finishNow();
    window.Relay.setStatus(`${d.name} reached B on a 1 km path.`);
  }

  function toward(value, target, maxDelta) {
    const delta = target - value;
    if (Math.abs(delta) <= maxDelta) return target;
    return value + Math.sign(delta) * maxDelta;
  }

  function choosePath(index) {
    const next = Math.max(0, Math.min(2, index));
    if (next === sim.path) return;
    sim.path = next;
    pushLog(`Path ${PATHS[next].name}`);
  }

  function takeWheel() {
    if (sim.mode === "manual" && sim.phase === "manual") return;
    const closeSelf = rec.active && rec.mode === "self-drive";
    sim.mode = "manual";
    sim.phase = "manual";
    pushLog("You have the wheel.");
    if (closeSelf) finishNow();
  }

  function toggleAuto() {
    if (sim.mode === "auto" && sim.phase !== "arrive") {
      takeWheel();
      hidePolicy();
      window.Relay.setStatus("Self-drive off. Arrow keys drive.");
      return;
    }
    document.querySelectorAll("[data-role='policy']").forEach((node) => {
      node.hidden = false;
    });
    window.Relay.setStatus("Choose avoid collisions, or hybrid.");
  }

  function hidePolicy() {
    document.querySelectorAll("[data-role='policy']").forEach((node) => {
      node.hidden = true;
    });
  }

  function choosePolicy(policy) {
    hidePolicy();
    sim.policy = policy;
    startAuto();
    applyPolicy(policy);
    window.Relay.setStatus(policy === "avoid" ? "Self-drive will change lanes to avoid collisions." : "Hybrid self-drive avoids some and collides with others.");
  }

  function applyPolicy(policy) {
    sim.policy = policy;
    for (const path of PATHS) {
      const hurdles = path.obstacles.filter((obs) => obs.kind === "hurdle");
      for (const obs of hurdles) obs.avoid = policy === "avoid";
      const spec = VISION[path.name];
      if (spec) {
        spec.pedestrian = spec.pedestrian.map((ped) => [ped[0], ped[1], policy === "avoid" || !ped[1]]);
        spec.leadAvoid = policy === "avoid";
      }
      if (policy !== "hybrid") continue;
      const items = hurdles.map((obs) => ({ m: obs.m, name: `hurdle at ${obs.m} m`, set: (value) => { obs.avoid = value; } }));
      if (spec) {
        spec.pedestrian.forEach((ped, i) => {
          if (!ped[1]) return;
          items.push({ m: ped[0], name: `pedestrian at ${ped[0]} m`, set: (value) => { spec.pedestrian[i][2] = value; } });
        });
        items.push({ m: spec.lead[0], name: "vehicle ahead", set: (value) => { spec.leadAvoid = value; } });
      }
      if (!items.length) continue;
      items.sort((a, b) => a.m - b.m);
      if (items.length === 1) items[0].set(false);
      else {
        items.forEach((item) => item.set(true));
        items[1].set(false);
        for (let i = 2; i < items.length; i += 1) items[i].set(Math.random() < 0.5);
      }
    }
    noteHybrid(policy);
  }

  function noteHybrid(policy) {
    if (policy !== "hybrid") return;
    const path = PATHS[sim.path];
    const spec = VISION[path.name];
    const dodge = [];
    const hit = [];
    for (const obs of path.obstacles) {
      if (obs.kind !== "hurdle") continue;
      (obs.avoid === false ? hit : dodge).push(`hurdle at ${obs.m} m`);
    }
    if (spec) {
      for (const ped of spec.pedestrian) {
        if (!ped[1]) continue;
        (ped[2] === false ? hit : dodge).push(`pedestrian at ${ped[0]} m`);
      }
      (spec.leadAvoid === false ? hit : dodge).push("vehicle ahead");
    }
    pushLog(`Hybrid. Lane change for ${dodge.join(", ") || "nothing"}. Collision for ${hit.join(", ") || "nothing"}.`);
  }

  function startAuto() {
    if (sim.meters > 990) resetCar();
    else if (rec.active) finishNow();
    const p = params();
    const d = driver();
    sim.speed = 0;
    sim.gear = "P";
    sim.mode = "auto";
    sim.phase = "doors";
    sim.phaseT = 0.34;
    sim.doorStep = 0;
    sim.doorOpening = true;
    sim.arrived = false;
    const order = ["df", "pf", "trunk", "dr", "pr", "frunk"];
    const n = Math.max(0, Math.min(6, p.door_cycles_per_trip | 0));
    sim.plan = order.slice(0, n);
    sim.reverses = Math.min(3, Math.max(0, Math.round((p.gear_shifts_per_trip - 4) / 2)));
    sim.shuffle = "out";
    sim.didWindow = false;
    sim.didShut = false;
    sim.nextNudge = 200;
    applyHabits();
    sim.locked = false;
    begin("self-drive");
    pushLog(`${d.name} is driving ${PATHS[sim.path].name} the way they usually do.`);
    window.Relay.setStatus(`${d.name} is self-driving the ${PATHS[sim.path].name}, 1.0 km.`);
  }

  async function addDriver() {
    const input = document.getElementById(view === "drive3d" ? "drive3d-new-name" : "drive-new-name");
    const name = input.value.trim();
    if (!name) {
      window.Relay.setStatus("Type a name, then add the driver.");
      return;
    }
    window.Relay.setStatus("Adding driver…");
    try {
      const created = await window.Relay.api("/api/drivers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      window.Relay.state.drivers = (await window.Relay.api("/api/drivers")).drivers;
      window.Relay.state.selectedId = created.id;
      window.Relay.renderFleet();
      window.Relay.renderDriver();
      window.Relay.renderRun();
      document.getElementById("drive-new-name").value = "";
      document.getElementById("drive3d-new-name").value = "";
      refresh();
      sim.driverId = created.id;
      resetCar();
      window.Relay.setStatus(`${created.name} is at point A. Arrow keys drive. Edit Driver to change how the car behaves.`);
    } catch (err) {
      window.Relay.setStatus(err.message);
    }
  }

  function onKeyDown(event) {
    if (!active) return;
    const tag = event.target && event.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (sim.mode === "auto") takeWheel();
      keys.up = true;
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      if (sim.mode === "auto") takeWheel();
      keys.down = true;
    } else if (event.key === "ArrowLeft" && !event.repeat) {
      event.preventDefault();
      choosePath(sim.path - 1);
    } else if (event.key === "ArrowRight" && !event.repeat) {
      event.preventDefault();
      choosePath(sim.path + 1);
    } else if (event.key === " " || event.code === "Space") {
      event.preventDefault();
      if (sim.mode === "auto") takeWheel();
      keys.brake = true;
    }
  }

  function onKeyUp(event) {
    if (event.key === "ArrowUp") keys.up = false;
    if (event.key === "ArrowDown") keys.down = false;
    if (event.key === " " || event.code === "Space") keys.brake = false;
  }

  function syncButtons() {
    if (!mounted) return;
    const pressed = {
      "gear-P": sim.gear === "P",
      "gear-R": sim.gear === "R",
      "gear-N": sim.gear === "N",
      "gear-D": sim.gear === "D",
      mirrors: sim.mirrorsFolded,
      wipers: sim.wipers,
      belt: sim.belt,
      lock: sim.locked,
      lamps: sim.lights,
      high: sim.high,
      hazard: sim.hazard,
      "mode-auto": sim.mode === "auto" && sim.phase !== "arrive",
      "mode-manual": sim.mode === "manual",
    };
    for (const [id] of DOORS) pressed[`door-${id}`] = sim.doorTarget[id] > 0.5;
    for (let i = 0; i < 3; i++) pressed[`path-${i}`] = sim.path === i;
    document.querySelectorAll("#panel-drive [data-ctl], #panel-drive3d [data-ctl]").forEach((node) => {
      const on = !!pressed[node.dataset.ctl];
      if (node.dataset.ctl.startsWith("mode-") || node.dataset.ctl.startsWith("gear-") || node.dataset.ctl.startsWith("door-") || node.dataset.ctl.startsWith("path-") || ["mirrors", "wipers", "belt", "lock", "lamps", "high", "hazard"].includes(node.dataset.ctl)) {
        node.setAttribute("aria-pressed", on ? "true" : "false");
      }
    });
    const autoLabel = sim.mode === "auto" && sim.phase !== "arrive" ? "Stop self-drive" : "Self-drive";
    document.querySelectorAll('#panel-drive [data-ctl="mode-auto"], #panel-drive3d [data-ctl="mode-auto"]').forEach((node) => {
      node.textContent = autoLabel;
    });
    const mirrorLabel = sim.mirrorsFolded ? "Unfold mirrors" : "Fold mirrors";
    document.querySelectorAll('#panel-drive [data-ctl="mirrors"], #panel-drive3d [data-ctl="mirrors"]').forEach((node) => {
      node.textContent = mirrorLabel;
    });
  }

  function geom(height) {
    const banner = 72;
    const lh = (height - banner) / 3;
    return { banner, lh };
  }

  function worldX(meter, width) {
    const carX = Math.max(150, width * 0.22);
    return carX + (meter - sim.meters) * px;
  }

  function draw() {
    if (!ctx || !canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    if (w < 2 || h < 2) return;
    const shake = sim.shake > 0 ? Math.sin(performance.now() / 30) * 5 * sim.shake : 0;
    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.translate(shake, 0);
    drawBanner(w);
    const { banner, lh } = geom(h);
    for (let i = 0; i < 3; i++) drawLane(i, banner + lh * i, lh, w);
    drawCar(w, h);
    if (sim.rain) drawRain(w, h);
    if (sim.arrived) drawArrival(w);
    ctx.restore();
  }

  function drawBanner(w) {
    const sky = ctx.createLinearGradient(0, 0, 0, 72);
    sky.addColorStop(0, "#243044");
    sky.addColorStop(0.55, "#6a5344");
    sky.addColorStop(1, "#e2b07a");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, 72);
    ctx.fillStyle = "rgba(255, 214, 160, 0.9)";
    ctx.beginPath();
    ctx.arc(w * 0.72, 26, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1b140f";
    ctx.font = "600 13px Segoe UI, sans-serif";
    ctx.fillText("A  ·  Home", 16, 24);
    ctx.fillText("B  ·  Work", 130, 24);
    ctx.font = "12px Segoe UI, sans-serif";
    ctx.fillText(`${(sim.meters / 1000).toFixed(2)} / 1.00 km`, 16, 44);
    const d = driver();
    if (d) ctx.fillText(d.name, 16, 62);
    ctx.textAlign = "right";
    ctx.font = "700 28px Consolas, monospace";
    ctx.fillText(`${kmh().toFixed(0)}`, w - 16, 32);
    ctx.font = "12px Segoe UI, sans-serif";
    ctx.fillText(`km/h   ${sim.gear}`, w - 16, 52);
    ctx.textAlign = "left";
    drawMinimap(w);
  }

  function drawMinimap(w) {
    if (w < 760) return;
    const x0 = w * 0.42;
    PATHS.forEach((p, i) => {
      const y = 46 + i * 8;
      ctx.fillStyle = "rgba(20,16,12,0.35)";
      ctx.fillRect(x0, y, 120, 5);
      ctx.fillStyle = i === sim.path ? "#d08a3a" : "rgba(236,231,220,0.7)";
      ctx.fillRect(x0, y, 120 * (sim.meters / 1000), 5);
      for (const obs of p.obstacles) {
        ctx.fillStyle = obs.kind === "hurdle" ? "#e15a45" : "#f2c14e";
        ctx.fillRect(x0 + 120 * (obs.m / 1000) - 1, y - 1, 3, 7);
      }
    });
  }

  function drawLane(index, top, lh, w) {
    const path = PATHS[index];
    const selected = index === sim.path;
    const sky = ctx.createLinearGradient(0, top, 0, top + lh);
    sky.addColorStop(0, path.tone[0]);
    sky.addColorStop(1, path.tone[1]);
    ctx.fillStyle = sky;
    ctx.fillRect(0, top, w, lh);
    const ground = top + lh * 0.78;
    const roadTop = ground - Math.min(54, lh * 0.42);
    const roadH = ground - roadTop + 8;
    if (index === 0) drawTrees(top, roadTop, w);
    if (index === 1) drawShops(top, roadTop, w);
    if (index === 2) drawHills(top, roadTop, w);
    ctx.fillStyle = selected ? "#3c4238" : "#2c312b";
    roundRect(0, roadTop, w, roadH, 0);
    ctx.fill();
    ctx.fillStyle = selected ? "#d08a3a" : "#5c564c";
    ctx.fillRect(0, roadTop, w, 3);
    ctx.fillStyle = "rgba(236,231,220,0.55)";
    const period = 46;
    const scroll = (sim.meters * px) % period;
    for (let x = -scroll; x < w; x += period) ctx.fillRect(x, roadTop + roadH * 0.48, 22, 3);
    for (const obs of path.obstacles) {
      const x = worldX(obs.m, w);
      if (x < -80 || x > w + 80) continue;
      if (obs.kind === "breaker") drawBreaker(x, ground);
      else drawHurdle(x, ground);
    }
    drawVision(path, ground, w);
    drawMarker(0, "A", ground, w);
    drawMarker(1000, "B", ground, w);
    ctx.fillStyle = selected ? "#f4efe4" : "#a8a292";
    ctx.font = "600 13px Segoe UI, sans-serif";
    ctx.fillText(path.name, 12, top + 20);
    ctx.font = "12px Segoe UI, sans-serif";
    ctx.fillText(`${path.limit} km/h`, 12, top + 38);
    if (selected) {
      ctx.fillStyle = "#d08a3a";
      ctx.fillText(sim.laneAnim < -0.35 ? "Left lane" : "Right lane", 78, top + 20);
    }
    if (selected && path.limit >= 80 && params().autopilot_share >= 0.35 && sim.mode === "auto") {
      ctx.fillStyle = "rgba(143, 206, 122, 0.85)";
      ctx.fillText("Autosteer", 78, top + 38);
    }
  }

  const VISION = {
    Street: { parked: [[45, 1], [620, -1]], pedestrian: [], lead: [80, 0.72], oncoming: null, bays: [968, 986] },
    Avenue: { parked: [[160, 1], [640, -1]], pedestrian: [], lead: [120, 0.78], oncoming: [940, 1.05], bays: [972] },
    "Ring road": { parked: [], pedestrian: [], lead: [140, 0.82], oncoming: null, bays: [984] },
  };

  function noteVision() {
    const spec = VISION[PATHS[sim.path].name];
    if (!spec) return;
    const notices = [];
    for (const [meter, side] of spec.parked) {
      const range = meter - sim.meters;
      if (range > 0 && range < 48) notices.push([`parked-${meter}`, `Camera: parked car ${range.toFixed(0)} m ${side > 0 ? "on the right" : "on the left"}`]);
    }
    for (const [meter, crosses] of spec.pedestrian) {
      const range = meter - sim.meters;
      if (range > 0 && range < 40) {
        const stepping = crosses && Math.abs(sim.meters - meter) < 16;
        notices.push([`ped-${meter}`, stepping ? `Camera: pedestrian stepping out, ${range.toFixed(0)} m` : `Camera: pedestrian on the sidewalk, ${range.toFixed(0)} m`]);
      }
    }
    const leadRange = spec.lead[0] + sim.meters * spec.lead[1] - sim.meters;
    if (leadRange > 2 && leadRange < 55) notices.push(["lead", `Camera: vehicle ahead, ${leadRange.toFixed(0)} m`]);
    if (spec.oncoming) {
      const range = spec.oncoming[0] - sim.meters * spec.oncoming[1] - sim.meters;
      if (range > 0 && range < 50) notices.push(["oncoming", `Camera: oncoming vehicle, ${range.toFixed(0)} m`]);
    }
    for (const obs of PATHS[sim.path].obstacles) {
      const range = obs.m - sim.meters;
      if (range > 0 && range < 35) notices.push([`${obs.kind}-${obs.m}`, `Camera: ${obs.kind === "hurdle" ? "obstacle" : "speed breaker"} ahead, ${range.toFixed(0)} m`]);
    }
    for (const meter of spec.bays) {
      const range = meter - sim.meters;
      if (range > -4 && range < 28 && kmh() < 25) notices.push([`bay-${meter}`, `Camera: open parking bay, ${Math.max(0, range).toFixed(0)} m`]);
    }
    for (const [id, text] of notices) {
      if (sim.seen[id]) continue;
      sim.seen[id] = true;
      pushLog(text);
    }
  }

  function drawVision(path, ground, w) {
    const spec = VISION[path.name];
    if (!spec) return;
    for (const [meter] of spec.parked) drawSideCar(worldX(meter, w), ground, "#6d7c8a");
    for (const [meter, crosses] of spec.pedestrian) {
      const stepping = crosses && Math.abs(sim.meters - meter) < 16;
      drawPerson(worldX(meter, w), ground, stepping ? -6 : -16);
    }
    drawSideCar(worldX(spec.lead[0] + sim.meters * spec.lead[1], w), ground, "#8fb4d4");
    if (spec.oncoming) drawSideCar(worldX(spec.oncoming[0] - sim.meters * spec.oncoming[1], w), ground, "#c4b49a");
    for (const meter of spec.bays) drawBay(worldX(meter, w), ground);
  }

  function drawSideCar(x, ground, color) {
    if (x < -50 || x > 4000) return;
    ctx.fillStyle = color;
    roundRect(x - 18, ground - 22, 36, 14, 3);
    ctx.fill();
    ctx.fillStyle = "#d5dde6";
    ctx.fillRect(x - 6, ground - 28, 16, 7);
    ctx.fillStyle = "#1b1f24";
    ctx.beginPath();
    ctx.arc(x - 10, ground - 8, 4, 0, Math.PI * 2);
    ctx.arc(x + 10, ground - 8, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPerson(x, ground, lift) {
    if (x < -30 || x > 4000) return;
    const y = ground + lift;
    ctx.fillStyle = "#f4efe4";
    ctx.beginPath();
    ctx.arc(x, y - 22, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#f4efe4";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 18);
    ctx.lineTo(x, y - 6);
    ctx.moveTo(x, y - 14);
    ctx.lineTo(x - 5, y - 8);
    ctx.moveTo(x, y - 14);
    ctx.lineTo(x + 5, y - 8);
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x - 4, y);
    ctx.moveTo(x, y - 6);
    ctx.lineTo(x + 4, y);
    ctx.stroke();
  }

  function drawBay(x, ground) {
    if (x < -40 || x > 4000) return;
    ctx.strokeStyle = "rgba(143, 206, 122, 0.85)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x - 16, ground - 6, 32, 8);
  }

  function drawTrees(top, roadTop, w) {
    for (let i = 0; i < 16; i++) {
      const m = i * 70 + 15;
      const x = worldX(m, w);
      if (x < -40 || x > w + 40) continue;
      ctx.fillStyle = "#5a4632";
      ctx.fillRect(x, roadTop - 28, 4, 28);
      ctx.fillStyle = i % 2 ? "#2f6b45" : "#3d7d52";
      ctx.beginPath();
      ctx.arc(x + 2, roadTop - 36, 14, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawShops(top, roadTop, w) {
    for (let i = 0; i < 12; i++) {
      const m = i * 90;
      const x = worldX(m, w);
      if (x < -70 || x > w + 20) continue;
      const bh = 34 + (i % 3) * 12;
      ctx.fillStyle = i % 2 ? "#4a4036" : "#3d4a58";
      ctx.fillRect(x, roadTop - bh, 48, bh);
      ctx.fillStyle = "rgba(242, 193, 78, 0.55)";
      ctx.fillRect(x + 6, roadTop - bh + 8, 10, 12);
      ctx.fillRect(x + 22, roadTop - bh + 8, 10, 12);
    }
  }

  function drawHills(top, roadTop, w) {
    ctx.fillStyle = "#1e3a44";
    ctx.beginPath();
    ctx.moveTo(0, roadTop);
    for (let x = 0; x <= w; x += 20) {
      const m = sim.meters + (x - w * 0.22) / px;
      const y = roadTop - 18 - Math.sin(m / 80) * 10 - Math.cos(m / 140) * 8;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, roadTop);
    ctx.fill();
  }

  function drawMarker(meter, label, ground, w) {
    const x = worldX(meter, w);
    if (x < -20 || x > w + 20) return;
    ctx.fillStyle = "#d9d3c6";
    ctx.fillRect(x, ground - 46, 3, 46);
    ctx.fillStyle = label === "A" ? "#8fce7a" : "#d08a3a";
    roundRect(x + 3, ground - 44, 22, 18, 4);
    ctx.fill();
    ctx.fillStyle = "#141612";
    ctx.font = "700 12px Segoe UI, sans-serif";
    ctx.fillText(label, x + 8, ground - 31);
  }

  function drawBreaker(x, ground) {
    ctx.save();
    ctx.translate(x, ground);
    ctx.fillStyle = "#1a1c18";
    ctx.beginPath();
    ctx.moveTo(-34, 0);
    ctx.quadraticCurveTo(0, -16, 34, 0);
    ctx.fill();
    for (let i = -3; i <= 2; i++) {
      ctx.fillStyle = i % 2 === 0 ? "#f2c14e" : "#141612";
      ctx.beginPath();
      ctx.moveTo(i * 9, -2);
      ctx.lineTo(i * 9 + 8, -2);
      ctx.lineTo(i * 9 + 10, 0);
      ctx.lineTo(i * 9 + 2, 0);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawHurdle(x, ground) {
    ctx.save();
    ctx.translate(x, ground);
    ctx.fillStyle = "#c4552a";
    ctx.beginPath();
    ctx.moveTo(-38, 0);
    ctx.lineTo(-28, -18);
    ctx.lineTo(-18, 0);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(18, 0);
    ctx.lineTo(28, -18);
    ctx.lineTo(38, 0);
    ctx.fill();
    ctx.fillStyle = "#f2c14e";
    ctx.fillRect(-6, -16, 5, 5);
    ctx.fillRect(22, -16, 5, 5);
    ctx.fillStyle = "#e8e2d6";
    ctx.fillRect(-22, -36, 44, 8);
    ctx.fillStyle = "#e15a45";
    ctx.fillRect(-22, -36, 14, 8);
    ctx.fillRect(6, -36, 14, 8);
    ctx.fillStyle = "#d9d3c6";
    ctx.fillRect(-16, -28, 4, 28);
    ctx.fillRect(12, -28, 4, 28);
    ctx.restore();
  }

  function drawCar(w, h) {
    const { banner, lh } = geom(h);
    const base = banner + lh * sim.pathAnim;
    const ground = base + lh * 0.78;
    const hop = Math.sin(sim.bounce * Math.PI) * 12 * sim.bounce;
    const carX = Math.max(150, w * 0.22);
    const braking = (keys.down || pad.down || keys.brake || sim.hardStop) && kmh() > 2;
    const paint = (driver() && driver().color) || "#d08a3a";
    ctx.save();
    ctx.translate(carX, ground - hop + sim.laneAnim * 10);
    if (sim.blinker !== "off" && Math.floor(performance.now() / 280) % 2 === 0) {
      ctx.fillStyle = "#ffb03a";
      ctx.fillRect(sim.blinker === "left" ? 168 : 24, -64, 10, 6);
    }
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.ellipse(96, 4, 78, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    drawWheel(46, -2, sim.wheel);
    drawWheel(150, -2, sim.wheel);
    ctx.fillStyle = shade(paint, -28);
    roundRect(18, -30, 164, 26, 8);
    ctx.fill();
    ctx.fillStyle = paint;
    ctx.beginPath();
    ctx.moveTo(24, -28);
    ctx.lineTo(48, -30);
    ctx.lineTo(70, -58);
    ctx.lineTo(132, -60);
    ctx.lineTo(156, -32);
    ctx.lineTo(184, -28);
    ctx.quadraticCurveTo(192, -16, 180, -8);
    ctx.lineTo(22, -8);
    ctx.quadraticCurveTo(12, -16, 24, -28);
    ctx.fill();
    ctx.fillStyle = shade(paint, 18);
    ctx.fillRect(78, -30, 46, 6);
    ctx.fillStyle = sim.rain ? "rgba(170, 198, 210, 0.55)" : "rgba(186, 214, 224, 0.78)";
    ctx.beginPath();
    ctx.moveTo(74, -54);
    ctx.lineTo(128, -56);
    ctx.lineTo(146, -34);
    ctx.lineTo(78, -34);
    ctx.closePath();
    ctx.fill();
    if (sim.window > 0.05) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(74, -54);
      ctx.lineTo(128, -56);
      ctx.lineTo(146, -34);
      ctx.lineTo(78, -34);
      ctx.closePath();
      ctx.clip();
      ctx.fillStyle = "rgba(16, 20, 24, 0.72)";
      ctx.fillRect(74, -58, 76, 24 * sim.window);
      ctx.restore();
    }
    if (sim.wipers) {
      const sweep = Math.sin(sim.wiper * Math.PI * 2);
      ctx.strokeStyle = "#1c140e";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(96, -36);
      ctx.lineTo(96 + sweep * 18, -50);
      ctx.moveTo(118, -36);
      ctx.lineTo(118 + sweep * 14, -52);
      ctx.stroke();
    }
    ctx.fillStyle = "#1b1814";
    ctx.beginPath();
    ctx.arc(108, -46, 6, 0, Math.PI * 2);
    ctx.fill();
    if (sim.belt) {
      ctx.strokeStyle = "#d08a3a";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(100, -38);
      ctx.lineTo(116, -50);
      ctx.stroke();
    }
    drawOpenedDoors();
    drawMirror();
    const beam = sim.hazard ? (Math.floor(performance.now() / 280) % 2 === 0) : sim.lights;
    ctx.fillStyle = beam ? (sim.high ? "#fff4c4" : "#ffe7a3") : "#d9d3c6";
    ctx.beginPath();
    ctx.ellipse(176, -18, 7, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    if (beam) {
      const reach = sim.high ? 90 : 42;
      const glow = ctx.createLinearGradient(180, -18, 180 + reach, -18);
      glow.addColorStop(0, "rgba(255, 236, 180, 0.45)");
      glow.addColorStop(1, "rgba(255, 236, 180, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.moveTo(180, -24);
      ctx.lineTo(180 + reach, -36);
      ctx.lineTo(180 + reach, 0);
      ctx.lineTo(180, -12);
      ctx.fill();
    }
    ctx.fillStyle = braking || (sim.hazard && Math.floor(performance.now() / 280) % 2 === 0) ? "#ff5a4a" : "#8c2e28";
    ctx.fillRect(16, -20, 8, 6);
    if (sim.gear === "D" || sim.gear === "R") {
      ctx.fillStyle = "rgba(120, 170, 255, 0.35)";
      ctx.fillRect(70, -6, 52, 3);
    }
    ctx.restore();
  }

  function drawOpenedDoors() {
    const paint = (driver() && driver().color) || "#d08a3a";
    const slabs = [
      ["dr", 38, false],
      ["df", 88, false],
      ["pr", 42, true],
      ["pf", 96, true],
    ];
    for (const [id, x, far] of slabs) {
      const amt = sim.doors[id];
      if (amt < 0.08) continue;
      ctx.fillStyle = "#14181c";
      ctx.fillRect(x + 2, -50, 28, 18);
      ctx.fillStyle = shade(paint, far ? 20 : -18);
      ctx.globalAlpha = far ? 0.8 : 1;
      ctx.beginPath();
      ctx.moveTo(x, -48);
      ctx.lineTo(x + 32, -48);
      ctx.lineTo(x + 32 + 26 * amt, -48 + 52 * amt);
      ctx.lineTo(x + 8 * amt, -48 + 52 * amt);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "rgba(12, 10, 8, 0.55)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (sim.doors.frunk > 0.04) {
      ctx.save();
      ctx.translate(156, -30);
      ctx.rotate(-0.7 * sim.doors.frunk);
      ctx.fillStyle = shade(paint, 10);
      ctx.fillRect(0, -6, 32, 8);
      ctx.restore();
    }
    if (sim.doors.trunk > 0.04) {
      ctx.save();
      ctx.translate(48, -30);
      ctx.rotate(0.8 * sim.doors.trunk);
      ctx.fillStyle = shade(paint, -8);
      ctx.fillRect(-28, -6, 30, 8);
      ctx.restore();
    }
  }

  function drawMirror() {
    const kick = sim.mirrorKick * 6;
    ctx.save();
    ctx.translate(150, -32 + (sim.mirrorsFolded ? 4 : kick));
    ctx.rotate(sim.mirrorsFolded ? 0.9 : -0.3);
    ctx.fillStyle = "#1c1e1a";
    ctx.fillRect(0, -3, 16, 5);
    ctx.fillStyle = "#9ec4d4";
    ctx.fillRect(12, -5, 6, 8);
    ctx.restore();
  }

  function drawWheel(x, y, angle) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = "#141612";
    ctx.beginPath();
    ctx.arc(0, 0, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#c8c2b6";
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#2a2c28";
    ctx.lineWidth = 2;
    ctx.rotate(angle);
    for (let i = 0; i < 5; i++) {
      ctx.rotate((Math.PI * 2) / 5);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(0, 8);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawRain(w, h) {
    ctx.strokeStyle = "rgba(210, 220, 230, 0.35)";
    ctx.lineWidth = 1;
    const shift = (performance.now() / 18) % 40;
    for (let i = 0; i < 70; i++) {
      const x = (i * 47 + shift) % (w + 30) - 10;
      const y = (i * 29 + shift * 2) % h;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 6, y + 14);
      ctx.stroke();
    }
  }

  function drawArrival(w) {
    ctx.fillStyle = "rgba(20, 22, 18, 0.72)";
    roundRect(w / 2 - 120, 86, 240, 36, 10);
    ctx.fill();
    ctx.fillStyle = "#f4efe4";
    ctx.font = "600 16px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Arrived at B", w / 2, 110);
    ctx.textAlign = "left";
  }

  function roundRect(x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
  }

  function shade(hex, amt) {
    const raw = (hex || "#d08a3a").replace("#", "");
    const num = parseInt(raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw, 16);
    const ch = (shift) => Math.max(0, Math.min(255, ((num >> shift) & 255) + amt));
    return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
  }

  function roadCenter(index) {
    return (index - 1) * 16;
  }

  function draw3d() {
    if (!ctx3 || !canvas3) return;
    const g = ctx3;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas3.width / dpr;
    const h = canvas3.height / dpr;
    if (w < 2 || h < 2) return;
    const camX = carWorldX();
    const camY = 2.05 + Math.max(0, sim.bounce) * 0.45;
    const camZ = sim.meters - 6.4;
    const focal = Math.min(w, h) * 1.08;
    const horizon = h * 0.40;
    const yaw = (sim.path - sim.pathAnim) * 0.42;

    function project(x, y, z) {
      const dz = z - camZ;
      if (dz < 0.5) return null;
      return {
        x: w / 2 + ((x - camX) / dz) * focal,
        y: horizon - ((y - camY) / dz) * focal,
        s: focal / dz,
      };
    }

    function toWorld(lx, ly, lz, cx, cz, turn) {
      const c = Math.cos(turn);
      const s = Math.sin(turn);
      return [cx + lx * c + lz * s, ly, cz - lx * s + lz * c];
    }

    const faces = [];
    function addFace(pts, color) {
      let z = 0;
      for (const p of pts) z += p[2];
      faces.push({ pts, color, z: z / pts.length });
    }

    function addBox(x, y, z, sx, sy, sz, color) {
      const x0 = x - sx / 2;
      const x1 = x + sx / 2;
      const y0 = y;
      const y1 = y + sy;
      const z0 = z - sz / 2;
      const z1 = z + sz / 2;
      addFace([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], shade(color, 36));
      addFace([[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]], shade(color, -50));
      addFace([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], color);
      addFace([[x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]], shade(color, -28));
      addFace([[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]], shade(color, -16));
      addFace([[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], shade(color, 10));
    }

    const sky = g.createLinearGradient(0, 0, 0, horizon + 20);
    sky.addColorStop(0, "#1a2744");
    sky.addColorStop(0.55, "#8a5a48");
    sky.addColorStop(1, "#e4bc8a");
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "rgba(255, 214, 160, 0.92)";
    g.beginPath();
    g.arc(w * 0.78, horizon * 0.42, 18, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#163224";
    g.fillRect(0, horizon - 2, w, h - horizon + 2);

    const zNear = sim.meters - 2;
    const zFar = sim.meters + 170;
    for (let i = 0; i < 3; i++) {
      const cx = roadCenter(i);
      const selected = i === sim.path;
      const asphalt = selected ? "#4a5144" : "#34382f";
      const verge = i === 2 ? "#1e3344" : i === 1 ? "#2a2618" : "#1c3328";
      for (let z = zFar; z > zNear; z -= 10) {
        const z0 = z - 10;
        addFace([[cx - 22, 0, z0], [cx + 22, 0, z0], [cx + 22, 0, z], [cx - 22, 0, z]], verge);
        addFace([[cx - 3.7, 0.02, z0], [cx + 3.7, 0.02, z0], [cx + 3.7, 0.02, z], [cx - 3.7, 0.02, z]], asphalt);
        addFace([[cx - 3.7, 0.03, z0], [cx - 3.45, 0.03, z0], [cx - 3.45, 0.03, z], [cx - 3.7, 0.03, z]], "#d08a3a");
        addFace([[cx + 3.45, 0.03, z0], [cx + 3.7, 0.03, z0], [cx + 3.7, 0.03, z], [cx + 3.45, 0.03, z]], "#d08a3a");
        if (Math.floor(z / 10) % 2 === 0) {
          addFace([[cx - 0.12, 0.04, z0 + 2], [cx + 0.12, 0.04, z0 + 2], [cx + 0.12, 0.04, z0 + 6], [cx - 0.12, 0.04, z0 + 6]], "rgba(236,231,220,0.8)");
        }
      }
      const scenery = i === 0 ? "tree" : i === 1 ? "shop" : "hill";
      for (let z = Math.floor(zNear / 18) * 18; z < zFar; z += 18) {
        const n = Math.abs(Math.sin(z * 12.9898 + i * 78.233) * 43758.5453) % 1;
        if (scenery === "tree") {
          addBox(cx - 6.4, 0, z, 0.45, 2.4 + n * 1.6, 0.45, "#6a4a32");
          addBox(cx - 6.4, 2.2 + n, z, 2.4, 2.2 + n, 2.4, n > 0.5 ? "#2f6a45" : "#3d7a52");
          addBox(cx + 6.6, 0, z + 8, 0.4, 2.1, 0.4, "#6a4a32");
          addBox(cx + 6.6, 1.9, z + 8, 2.1, 1.8, 2.1, "#2a5c3c");
        } else if (scenery === "shop") {
          addBox(cx + 8.2, 0, z, 5.5, 3.4 + n * 2.2, 7, n > 0.5 ? "#8d6848" : "#6e5a48");
          addBox(cx - 8.4, 0, z + 6, 4.2, 2.8, 6, "#5c6a72");
        } else {
          addBox(cx - 9, 0, z, 8, 1.4 + n * 2.4, 10, "#3d5a48");
          addBox(cx + 10, 0, z + 7, 7, 1.1 + n, 9, "#314e40");
        }
      }
      for (const obs of PATHS[i].obstacles) {
        if (obs.m < zNear - 2 || obs.m > zFar) continue;
        if (obs.kind === "breaker") addBox(cx, 0.02, obs.m, 6.6, 0.16, 0.9, "#e2b14a");
        else addBox(cx + LANE, 0.02, obs.m, 2.2, 0.85, 0.7, "#c4523c");
      }
      const spec = VISION[PATHS[i].name];
      if (spec) {
        for (const [meter, side] of spec.parked) addBox(cx + side * 3.15, 0.02, meter, 1.8, 1.35, 4.2, "#6d7c8a");
        const leadZ = spec.lead[0] + sim.meters * spec.lead[1];
        addBox(cx + LANE, 0.02, leadZ, 1.85, 1.4, 4.4, "#8fb4d4");
        if (spec.oncoming) addBox(cx - 2.55, 0.02, spec.oncoming[0] - sim.meters * spec.oncoming[1], 1.85, 1.4, 4.4, "#c4b49a");
        for (const [meter, crosses] of spec.pedestrian) {
          const step = crosses && Math.abs(sim.meters - meter) < 18 ? cx + LANE : cx + 4.6;
          addBox(step, 0.9, meter, 0.45, 0.45, 0.45, "#f4efe4");
          addBox(step, 0, meter, 0.4, 0.9, 0.28, "#d08a3a");
        }
        for (const meter of spec.bays) {
          addFace(
            [[cx + 2.2, 0.05, meter - 2.2], [cx + 4.8, 0.05, meter - 2.2], [cx + 4.8, 0.05, meter + 2.2], [cx + 2.2, 0.05, meter + 2.2]],
            "rgba(236,231,220,0.28)"
          );
        }
      }
      addBox(cx - 4.8, 0, 6, 0.12, 1.7, 1.3, "#f4efe4");
      addBox(cx - 4.8, 0, 994, 0.12, 1.7, 1.3, "#8fce7a");
    }

    const d = driver();
    const body = d && d.color ? d.color : "#8fce7a";
    const cx = carWorldX();
    const cz = sim.meters;
    const blinkOn = sim.blinker !== "off" && Math.floor(performance.now() / 280) % 2 === 0;
    function carBox(lx, ly, lz, sx, sy, sz, color) {
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const corners = [];
      for (const dx of [-sx / 2, sx / 2]) {
        for (const dy of [0, sy]) {
          for (const dz of [-sz / 2, sz / 2]) {
            const wx = lx + dx;
            const wz = lz + dz;
            corners.push(toWorld(wx * c + wz * s, ly + dy, -wx * s + wz * c, cx, cz, 0));
          }
        }
      }
      const p = (ix, iy, iz) => corners[ix * 4 + iy * 2 + iz];
      addFace([p(0, 1, 0), p(1, 1, 0), p(1, 1, 1), p(0, 1, 1)], shade(color, 36));
      addFace([p(0, 0, 1), p(1, 0, 1), p(1, 0, 0), p(0, 0, 0)], shade(color, -50));
      addFace([p(0, 0, 0), p(1, 0, 0), p(1, 1, 0), p(0, 1, 0)], color);
      addFace([p(1, 0, 1), p(0, 0, 1), p(0, 1, 1), p(1, 1, 1)], shade(color, -28));
      addFace([p(0, 0, 1), p(0, 0, 0), p(0, 1, 0), p(0, 1, 1)], shade(color, -16));
      addFace([p(1, 0, 0), p(1, 0, 1), p(1, 1, 1), p(1, 1, 0)], shade(color, 10));
    }
    carBox(0, 0.28, 0.05, 1.86, 0.58, 4.5, body);
    carBox(0, 0.86, -0.25, 1.68, 0.5, 2.15, shade(body, -18));
    carBox(0, 1.02, -1.05, 1.2, 0.34, 0.06, "#1a242c");
    const braking = keys.brake || keys.down || pad.down;
    const glow = sim.lights ? (sim.high ? "#fff1c2" : "#ffe08a") : null;
    if (glow) {
      carBox(-0.62, 0.42, 2.28, 0.28, 0.16, 0.08, glow);
      carBox(0.62, 0.42, 2.28, 0.28, 0.16, 0.08, glow);
    }
    carBox(-0.62, 0.48, -2.2, 0.32, 0.16, 0.06, braking ? "#ff5a42" : "#8a2e28");
    carBox(0.62, 0.48, -2.2, 0.32, 0.16, 0.06, braking ? "#ff5a42" : "#8a2e28");
    const blink = Math.floor(performance.now() / 280) % 2 === 0;
    if (sim.hazard && blink) {
      carBox(-0.88, 0.5, 2.15, 0.12, 0.12, 0.08, "#ffb03a");
      carBox(0.88, 0.5, 2.15, 0.12, 0.12, 0.08, "#ffb03a");
      carBox(-0.88, 0.55, -2.15, 0.12, 0.12, 0.08, "#ffb03a");
      carBox(0.88, 0.55, -2.15, 0.12, 0.12, 0.08, "#ffb03a");
    } else if (blinkOn) {
      const side = sim.blinker === "left" ? -0.9 : 0.9;
      carBox(side, 0.5, 2.15, 0.12, 0.12, 0.08, "#ffb03a");
      carBox(side, 0.55, -2.15, 0.12, 0.12, 0.08, "#ffb03a");
    }

    function swung(hingeLx, hingeLz, length, yawDoor, y, height, color) {
      const c = Math.cos(yaw + yawDoor);
      const s = Math.sin(yaw + yawDoor);
      const hx = cx + hingeLx * Math.cos(yaw) + hingeLz * Math.sin(yaw);
      const hz = cz - hingeLx * Math.sin(yaw) + hingeLz * Math.cos(yaw);
      const ex = hx + length * s;
      const ez = hz - length * c;
      addFace(
        [[hx, y, hz], [ex, y, ez], [ex, y + height, ez], [hx, y + height, hz]],
        color
      );
    }
    const doorOpen = (id) => sim.doors[id] > 0.04;
    if (doorOpen("df")) swung(-0.94, 0.85, 0.92, -sim.doors.df * 1.15, 0.38, 0.72, shade(body, -8));
    if (doorOpen("dr")) swung(-0.94, -0.15, 0.82, -sim.doors.dr * 1.15, 0.38, 0.72, shade(body, -8));
    if (doorOpen("pf")) swung(0.94, 0.85, 0.92, sim.doors.pf * 1.15, 0.38, 0.72, shade(body, 8));
    if (doorOpen("pr")) swung(0.94, -0.15, 0.82, sim.doors.pr * 1.15, 0.38, 0.72, shade(body, 8));
    if (doorOpen("frunk")) addBox(cx, 0.95 + sim.doors.frunk * 0.55, cz + 1.7, 1.5, 0.06, 0.9, shade(body, 18));
    if (doorOpen("trunk")) addBox(cx, 0.95 + sim.doors.trunk * 0.7, cz - 1.85, 1.5, 0.06, 0.85, shade(body, 12));

    faces.sort((a, b) => b.z - a.z);
    const shake = sim.shake > 0 ? Math.sin(performance.now() / 28) * 6 * sim.shake : 0;
    g.save();
    g.translate(shake, 0);
    for (const face of faces) {
      const pts = face.pts.map((p) => project(p[0], p[1], p[2]));
      if (pts.some((p) => !p)) continue;
      g.beginPath();
      g.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
      g.closePath();
      g.fillStyle = face.color;
      g.fill();
    }

    function wheel(lx, lz) {
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      const p = project(cx + lx * c + lz * s, 0.3, cz - lx * s + lz * c);
      if (!p) return;
      const radius = Math.max(2, p.s * 0.3);
      g.fillStyle = "#141612";
      g.beginPath();
      g.arc(p.x, p.y, radius, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = "#c8c2b6";
      g.lineWidth = Math.max(1, radius * 0.18);
      g.beginPath();
      g.arc(p.x, p.y, radius * 0.45, sim.wheel, sim.wheel + Math.PI * 1.5);
      g.stroke();
    }
    wheel(-1.05, -1.55);
    wheel(1.05, -1.55);

    if (sim.lights) {
      const reach = sim.high ? 46 : 22;
      g.fillStyle = sim.high ? "rgba(255, 236, 190, 0.16)" : "rgba(255, 214, 140, 0.13)";
      for (const side of [-0.55, 0.55]) {
        const a = project(cx + side - 0.35, 0.04, cz + 2.4);
        const b = project(cx + side + 0.35, 0.04, cz + 2.4);
        const c0 = project(cx + side + 1.1, 0.04, cz + reach);
        const d0 = project(cx + side - 1.1, 0.04, cz + reach);
        if (!a || !b || !c0 || !d0) continue;
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.lineTo(c0.x, c0.y);
        g.lineTo(d0.x, d0.y);
        g.closePath();
        g.fill();
      }
    }

    if (sim.rain) {
      g.strokeStyle = "rgba(210, 220, 230, 0.35)";
      g.lineWidth = 1;
      const shift = (performance.now() / 16) % 40;
      for (let i = 0; i < 80; i++) {
        const x = (i * 47 + shift) % (w + 30) - 10;
        const y = (i * 29 + shift * 2) % h;
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x - 7, y + 16);
        g.stroke();
      }
    }
    if (sim.wipers) {
      const sweep = Math.sin(sim.wiper * 2.4);
      g.strokeStyle = "rgba(236,231,220,0.55)";
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(w * 0.38, h * 0.62);
      g.quadraticCurveTo(w * (0.46 + sweep * 0.04), h * 0.42, w * (0.58 + sweep * 0.08), h * 0.58);
      g.stroke();
    }

    if (sim.arrived) {
      g.fillStyle = "rgba(20, 22, 18, 0.72)";
      g.fillRect(w / 2 - 110, 18, 220, 32);
      g.fillStyle = "#f4efe4";
      g.font = "600 16px Segoe UI, sans-serif";
      g.textAlign = "center";
      g.fillText("Arrived at B", w / 2, 40);
    }

    g.fillStyle = "rgba(16, 18, 14, 0.55)";
    g.fillRect(10, h - 78, 360, 68);
    g.textAlign = "left";
    g.fillStyle = "#f4efe4";
    g.font = "700 32px Consolas, monospace";
    g.fillText(`${kmh().toFixed(0)}`, 18, h - 46);
    g.font = "13px Segoe UI, sans-serif";
    g.fillText(`km/h   ${sim.gear}   ${PATHS[sim.path].name}   ${PATHS[sim.path].limit} limit`, 18, h - 26);
    g.fillText(`${(sim.meters / 1000).toFixed(2)} / 1.00 km${d ? "   " + d.name : ""}`, 18, h - 8);
    const bits = [];
    if (sim.lights) bits.push(sim.high ? "High beam" : "Lamps");
    if (sim.wipers) bits.push("Wipers");
    if (!sim.belt) bits.push("Belt off");
    if (!sim.locked) bits.push("Unlocked");
    if (sim.window > 0.2) bits.push("Windows down");
    if (bits.length) {
      g.textAlign = "right";
      g.fillStyle = "#f4efe4";
      g.fillText(bits.join("  ·  "), w - 16, h - 12);
    }
    g.restore();
  }

  window.Drive = { mount, refresh, setActive, resize };
})();
