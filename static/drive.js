/* Graphical A-to-B drive. Three 1 km paths, manual arrows, and self-drive from the saved style. */
(function () {
  const PATHS = [
    {
      name: "Street",
      blurb: "1.0 km · 40 km/h · speed breakers",
      limit: 40,
      tone: ["#1c3330", "#16302a"],
      obstacles: [
        { m: 150, kind: "breaker" },
        { m: 340, kind: "breaker" },
        { m: 500, kind: "hurdle" },
        { m: 690, kind: "breaker" },
        { m: 860, kind: "breaker" },
      ],
    },
    {
      name: "Avenue",
      blurb: "1.0 km · 60 km/h · breakers and hurdles",
      limit: 60,
      tone: ["#2a261c", "#241f18"],
      obstacles: [
        { m: 220, kind: "breaker" },
        { m: 470, kind: "hurdle" },
        { m: 710, kind: "breaker" },
        { m: 900, kind: "hurdle" },
      ],
    },
    {
      name: "Ring road",
      blurb: "1.0 km · 90 km/h · open, one of each",
      limit: 90,
      tone: ["#1a2838", "#162433"],
      obstacles: [
        { m: 260, kind: "hurdle" },
        { m: 620, kind: "breaker" },
      ],
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
  let px = 4;

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

  function pushLog(text) {
    sim.log.unshift(text);
    sim.log = sim.log.slice(0, 8);
    const box = document.getElementById("drive-log");
    if (box) {
      box.textContent = "";
      for (const line of sim.log) box.appendChild(Object.assign(document.createElement("div"), { textContent: line }));
    }
    capture(text);
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
    if (t.includes("stopped") || t.includes("hit at")) return "alert";
    if (t.includes("unlocked") || t.includes("over the")) return "watch";
    return "info";
  }

  function capture(text) {
    if (!text || text.startsWith("At point A")) return;
    const item = {
      at: performance.now(),
      kind: eventKind(text),
      text: text.slice(0, 240),
      severity: eventSeverity(text),
      speed_kmh: kmh(),
      gear: sim.gear,
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
      long_accel: 0,
      pedal: keys.up || pad.up ? 45 : 0,
      brake_pct: keys.brake ? 80 : keys.down || pad.down ? 40 : 0,
      path: path.name,
      limit_kmh: path.limit,
      heading: sim.path * 12,
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
    pushLog("At point A. Shift to Drive, or start self-drive.");
    syncButtons();
  }

  function kmh() {
    return Math.abs(sim.speed) * 3.6;
  }

  function mount() {
    if (mounted || !window.Relay) return;
    const panel = document.getElementById("panel-drive");
    panel.textContent = "";
    panel.appendChild(h("h2", "Drive"));
    panel.appendChild(h("p", "Three roads, each 1.0 km from A to B. Arrow keys drive. The buttons are the car. Self-drive uses the numbers saved for that driver: cruise, braking, doors, windows, belt, lock, wipers.", "lede"));

    const head = div("drive-head");
    const sel = document.createElement("select");
    sel.id = "drive-driver";
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
    name.id = "drive-new-name";
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
    panel.appendChild(h("p", "", "meta"));
    panel.lastChild.id = "drive-caption";

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
    canvas = document.createElement("canvas");
    canvas.id = "drive-canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", "Car moving from point A to point B");
    stage.appendChild(canvas);
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
    readout.id = "drive-readout";
    panel.appendChild(readout);
    const log = div("drive-log");
    log.id = "drive-log";
    panel.appendChild(log);

    ctx = canvas.getContext("2d");
    mounted = true;
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    refresh();
    resetCar();
    if (active) setActive(true);
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
    const sel = document.getElementById("drive-driver");
    const keep = window.Relay.state.selectedId;
    sel.textContent = "";
    for (const d of window.Relay.state.drivers) {
      const opt = document.createElement("option");
      opt.value = d.id;
      opt.textContent = `${d.name} — ${d.city}`;
      sel.appendChild(opt);
    }
    if (keep && window.Relay.state.drivers.some((d) => d.id === keep)) sel.value = keep;
    if (previous && previous !== sel.value) resetCar();
    sim.driverId = sel.value || null;
    updateCaption();
  }

  function updateCaption() {
    const node = document.getElementById("drive-caption");
    const d = driver();
    if (!node || !d) return;
    const p = d.params;
    const over = Math.round(p.speeding_bias * 100);
    node.textContent = `${d.vehicle_name}. Pulls away at ${p.accel_mps2} m/s², brakes at ${p.brake_mps2} m/s². Self-drive settles near ${p.cruise_kmh} km/h, and will hold about ${over}% over a limit. Doors ${p.door_cycles_per_trip}, windows ${p.window_changes_per_trip}, shifts ${p.gear_shifts_per_trip}.`;
  }

  function setActive(on) {
    active = !!on;
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
    if (!canvas || !active) return;
    const width = canvas.parentElement.clientWidth || 800;
    const height = width < 720 ? 460 : 560;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.width = "100%";
    canvas.style.height = `${height}px`;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.floor(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    px = Math.max(2.4, (width - width * 0.24 - 80) / 200);
    draw();
  }

  function frame(now) {
    if (!active) {
      looping = false;
      return;
    }
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    step(dt);
    draw();
    syncButtons();
    const readout = document.getElementById("drive-readout");
    const d = driver();
    if (readout && d) {
      const open = Object.values(sim.doors).some((v) => v > 0.4);
      const warn = [];
      if (open && kmh() > 3) warn.push("door open while moving");
      if (!sim.belt && kmh() > 8) warn.push("belt off");
      if (!sim.locked && sim.arrived) warn.push("left unlocked");
      if (kmh() > PATHS[sim.path].limit + 1 && sim.gear === "D") warn.push("over the limit");
      readout.textContent = `${d.name} · ${sim.mode === "auto" ? "self-drive" : "manual"} · ${PATHS[sim.path].name} · ${kmh().toFixed(0)} km/h · ${sim.gear} · ${(sim.meters / 1000).toFixed(2)} / 1.00 km${warn.length ? " · " + warn.join(", ") : ""}`;
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
    noteVision();
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
    habitsWhileMoving();
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
      } else if (dist < 88) {
        const alt = clearPath(obs.m);
        if (alt != null && alt !== sim.path && dist < 78) {
          sim.path = alt;
          pushLog(`Around the hurdle, onto ${PATHS[alt].name}`);
        } else if (dist < 48) target = Math.min(target, 10);
      }
    }
    const left = 1000 - sim.meters;
    if (left < 90) target = Math.min(target, 22);
    if (left < 28) target = 0;
    return target / 3.6;
  }

  function clearPath(meter) {
    const order = [sim.path - 1, sim.path + 1, 0, 1, 2];
    for (const i of order) {
      if (i < 0 || i > 2 || i === sim.path) continue;
      const blocked = PATHS[i].obstacles.some((o) => {
        const dist = o.m - meter;
        if (o.kind === "hurdle") return Math.abs(dist) < 40;
        return dist > -8 && dist < 60;
      });
      if (!blocked) return i;
    }
    return null;
  }

  function crossObstacles() {
    const path = PATHS[sim.path];
    for (const obs of path.obstacles) {
      const forward = sim.prevMeters < obs.m && sim.meters >= obs.m;
      const back = sim.prevMeters > obs.m && sim.meters <= obs.m;
      if (!forward && !back) continue;
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
      } else if (speedKmh > 16) {
        sim.speed = 0;
        sim.shake = 1.2;
        sim.meters = forward ? obs.m - 1.4 : obs.m + 1.4;
        sim.hits.hurdles += 1;
        pushLog(`Hurdle at ${obs.m} m. Stopped — slow down or take another path.`);
      } else {
        sim.bounce = 0.4;
        pushLog(`Crept past the hurdle at ${obs.m} m`);
      }
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
      window.Relay.setStatus("Self-drive off. Arrow keys drive.");
      return;
    }
    startAuto();
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
    const input = document.getElementById("drive-new-name");
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
      input.value = "";
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
    document.querySelectorAll("#panel-drive [data-ctl]").forEach((node) => {
      const on = !!pressed[node.dataset.ctl];
      if (node.dataset.ctl.startsWith("mode-") || node.dataset.ctl.startsWith("gear-") || node.dataset.ctl.startsWith("door-") || node.dataset.ctl.startsWith("path-") || ["mirrors", "wipers", "belt", "lock", "lamps", "high", "hazard"].includes(node.dataset.ctl)) {
        node.setAttribute("aria-pressed", on ? "true" : "false");
      }
    });
    const autoBtn = document.querySelector('#panel-drive [data-ctl="mode-auto"]');
    if (autoBtn) autoBtn.textContent = sim.mode === "auto" && sim.phase !== "arrive" ? "Stop self-drive" : "Self-drive";
    const mirrorBtn = document.querySelector('#panel-drive [data-ctl="mirrors"]');
    if (mirrorBtn) mirrorBtn.textContent = sim.mirrorsFolded ? "Unfold mirrors" : "Fold mirrors";
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
    if (selected && path.limit >= 80 && params().autopilot_share >= 0.35 && sim.mode === "auto") {
      ctx.fillStyle = "rgba(143, 206, 122, 0.85)";
      ctx.fillText("Autosteer", 78, top + 38);
    }
  }

  const VISION = {
    Street: { parked: [[45, 1], [620, -1]], pedestrian: [[130, true], [740, true]], lead: [80, 0.72], oncoming: null, bays: [968, 986] },
    Avenue: { parked: [[160, 1], [640, -1]], pedestrian: [[390, true]], lead: [120, 0.78], oncoming: [940, 1.05], bays: [972] },
    "Ring road": { parked: [], pedestrian: [[200, false]], lead: [140, 0.82], oncoming: null, bays: [984] },
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
    ctx.translate(carX, ground - hop);
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

  window.Drive = { mount, refresh, setActive, resize };
})();
