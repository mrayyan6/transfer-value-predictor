import { predict } from "./model.js";
import { money, signed, signedMoney, gapPct, verdict, VERDICT_TEXT, fmtDate, tweenText } from "./format.js";
import { createGapScale, createImportance, createScatter, playerTooltip, hideTooltip } from "./charts.js";

const $ = (sel) => document.querySelector(sel);

const SLIDERS = [
  { key: "age", label: "Age", step: 0.1, fmt: (v) => v.toFixed(1) },
  { key: "minutes_played", label: "Minutes played", step: 1, fmt: (v) => Math.round(v).toLocaleString("en-GB") },
  { key: "goals", label: "Goals", step: 1 },
  { key: "assists", label: "Assists", step: 1 },
  { key: "shots_on_target", label: "Shots on target", step: 1 },
  { key: "key_passes", label: "Key passes", step: 1 },
  { key: "tackles", label: "Tackles", step: 1 },
];

const MODEL_NAME = { linear: "linear model", forest: "random forest" };

const state = {
  league: null,
  model: "linear",
  mode: "player",
  playerId: null,
  inputs: null,
  board: { key: "gap", dir: "desc", pos: "All", limit: 15 },
  scatterPos: "All",
};

let meta;
let players = [];
let byId = new Map();
const models = {};

let gapScale;
let importance;
let scatter;
let lastStamp = "";

// data

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

async function ensureModels(league) {
  if (!models[league]) {
    const key = meta.leagues[league].key;
    const [linear, forest] = await Promise.all([
      loadJSON(`data/models/${key}_linear.json`),
      loadJSON(`data/models/${key}_forest.json`),
    ]);
    models[league] = { linear, forest };
  }
  return models[league];
}

const leaguePlayers = () => players.filter((p) => p.league === state.league);
const currentModel = () => models[state.league][state.model];
const selected = () => byId.get(state.playerId);

function inputsFor(p) {
  const out = { team: p.team, team_ppg: p.team_ppg, position: p.position };
  for (const s of SLIDERS) out[s.key] = p[s.key];
  return out;
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

function averageInputs() {
  const pool = leaguePlayers();
  const teams = meta.leagues[state.league].teams;
  const mid = teams[Math.floor(teams.length / 2)];
  const out = { team: mid.team, team_ppg: mid.team_ppg, position: "Midfielder" };
  for (const s of SLIDERS) {
    const m = median(pool.map((p) => p[s.key]));
    out[s.key] = s.key === "age" ? Math.round(m) : m;
  }
  return out;
}

function differs(a, b) {
  // range inputs hand back 24.700000000000003 for 24.7
  return typeof a === "number" ? Math.abs(a - b) > 1e-6 : a !== b;
}

function inputsChanged() {
  if (state.mode !== "player") return false;
  const base = inputsFor(selected());
  return Object.keys(base).some((k) => differs(base[k], state.inputs[k]));
}

// For a real player the headline number is the out of fold prediction (the
// honest one). What-if changes are applied on top of it as a ratio from the
// final model, so an untouched slider always shows the same number as the
// board and the chart.
function valuation() {
  const m = currentModel();
  const now = predict(m, state.inputs);
  if (state.mode === "build") return now;
  const p = selected();
  const base = predict(m, inputsFor(p));
  return p[state.model] * (now / base);
}

// controls

function setChecked(group, value) {
  for (const b of group.querySelectorAll("button")) {
    b.setAttribute("aria-checked", String(b.dataset.value === value));
  }
}

function buildLeaguePicker() {
  const group = $("#league-picker");
  for (const league of Object.keys(meta.leagues)) {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "radio");
    b.dataset.value = league;
    b.textContent = league;
    b.addEventListener("click", () => setLeague(league));
    group.appendChild(b);
  }
}

function renderControls() {
  setChecked($("#league-picker"), state.league);
  setChecked($("#model-picker"), state.model);
  setChecked($("#mode-switch"), state.mode);
  const m = meta.leagues[state.league].metrics[state.model];
  $("#model-hint").textContent = `R² ${m.r2.toFixed(2)} on players it never saw, typical miss ${money(m.mae_m)}.`;
}

// the slip

function renderSlip({ fresh = false } = {}) {
  const slip = $("#slip");
  const value = valuation();
  const isBuild = state.mode === "build";
  const inp = state.inputs;
  slip.classList.toggle("build", isBuild);
  $("#figure-market").style.display = isBuild ? "none" : "";

  if (isBuild) {
    $("#slip-meta").textContent = `${inp.team} · ${inp.position} · age ${Math.floor(inp.age)}`;
    $("#slip-name").textContent = "Your player";
    $("#value-model-sub").textContent = `${MODEL_NAME[state.model]}, trained on the whole league`;
  } else {
    const p = selected();
    $("#slip-meta").textContent = `${p.team} · ${p.position} · age ${Math.floor(p.age)}`;
    $("#slip-name").textContent = p.name;
    const changed = inputsChanged();
    $("#value-model-sub").textContent = changed
      ? `was ${money(p[state.model])} with the real stats`
      : `${MODEL_NAME[state.model]}, this player wasn't in its training set`;
    if (fresh) $("#value-market").dataset.value = "";
    tweenText($("#value-market"), p.value, money);
    $("#value-market-sub").textContent = `Transfermarkt, ${fmtDate(meta.valuesAsOf)}`;
  }
  tweenText($("#value-model"), value, money);

  const market = isBuild ? NaN : selected().value;
  gapScale.draw(value, market);
  renderReceipt();

  const stamp = $("#stamp");
  const verdictEl = $("#slip-verdict");
  verdictEl.replaceChildren();

  if (isBuild) {
    stamp.textContent = "";
    stamp.className = "stamp";
    lastStamp = "";
    verdictEl.append("A player with these numbers would go for around ", strong(money(value)), ".");
    renderComparables(value);
    return;
  }

  $("#comparables").hidden = true;
  const kind = verdict(value, market);
  const pct = gapPct(value, market);
  stamp.className = `stamp ${kind}`;
  stamp.textContent = kind === "fair" ? VERDICT_TEXT.fair : `${VERDICT_TEXT[kind]} ${signed(pct, 0, "%")}`;
  const stampKey = `${state.playerId}:${kind}:${state.model}`;
  if (stampKey !== lastStamp) {
    stamp.classList.remove("hit");
    void stamp.offsetWidth; // restart the animation
    stamp.classList.add("hit");
    lastStamp = stampKey;
  }

  const diff = Math.abs(value - market);
  if (inputsChanged()) {
    const p = selected();
    verdictEl.append("With your changes the model moves ", strong(signedMoney(value - p[state.model])), " from the real stats.");
  } else if (kind === "up") {
    verdictEl.append("The model would pay ", strong(`${money(diff)} more`), " than the market does. Either the market is sleeping on this one, or there's something the numbers can't see.");
  } else if (kind === "down") {
    verdictEl.append("The market pays ", strong(`${money(diff)} more`), " than last season's numbers justify. Reputation, potential, a long contract: the model can't tell which.");
  } else {
    verdictEl.append("Model and market are within ", strong(money(diff)), " of each other. Nothing to see here.");
  }
}

// itemised like a receipt: exactly what went into the price
function renderReceipt() {
  const inp = state.inputs;
  const base = state.mode === "player" ? inputsFor(selected()) : null;
  const teams = meta.leagues[state.league].teams;
  const place = teams.find((t) => t.team === inp.team)?.league_position;
  const lines = [];
  if (base) lines.push(["Appearances", selected().appearances, false]);
  for (const s of SLIDERS) {
    if (s.key === "age") continue;
    const fmt = s.fmt ?? ((v) => String(Math.round(v)));
    lines.push([s.label, fmt(inp[s.key]), base ? differs(base[s.key], inp[s.key]) : false]);
  }
  lines.push(["Club finished", place ? ordinal(place) : "n/a", base ? base.team !== inp.team : false]);

  const list = $("#receipt-list");
  list.replaceChildren();
  for (const [label, value, edited] of lines) {
    const li = document.createElement("li");
    if (edited) li.className = "edited";
    const l = document.createElement("span");
    l.textContent = label;
    const lead = document.createElement("span");
    lead.className = "lead";
    const b = document.createElement("b");
    b.textContent = value;
    li.append(l, lead, b);
    list.appendChild(li);
  }
  $("#receipt .receipt-label").textContent = base ? "Last season, as the model saw it" : "What the model is shown";
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

function strong(text) {
  const s = document.createElement("strong");
  s.textContent = text;
  return s;
}

function renderComparables(value) {
  const list = $("#comparables-list");
  list.replaceChildren();
  const close = leaguePlayers()
    .map((p) => ({ p, d: Math.abs(Math.log(p.value / value)) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 4);
  for (const { p } of close) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.type = "button";
    const name = document.createElement("span");
    name.textContent = `${p.name}, ${p.team}`;
    const val = document.createElement("span");
    val.className = "mono";
    val.textContent = money(p.value);
    b.append(name, val);
    b.addEventListener("click", () => selectPlayer(p.id));
    li.appendChild(b);
    list.appendChild(li);
  }
  $("#comparables").hidden = false;
}

// what-if sliders

function renderWhatIf() {
  const teamSelect = $("#input-team");
  teamSelect.replaceChildren();
  for (const t of meta.leagues[state.league].teams) {
    const o = document.createElement("option");
    o.value = t.team;
    o.textContent = `${t.league_position}. ${t.team}`;
    teamSelect.appendChild(o);
  }
  teamSelect.value = state.inputs.team;
  $("#input-position").value = state.inputs.position;

  const wrap = $("#sliders");
  wrap.replaceChildren();
  const ranges = meta.leagues[state.league].ranges;
  for (const s of SLIDERS) {
    let [lo, hi] = ranges[s.key];
    if (s.key === "age") [lo, hi] = [Math.floor(lo), Math.ceil(hi)];
    if (s.key === "minutes_played") [lo, hi] = [600, 3420];
    const row = document.createElement("div");
    row.className = "slider";
    const id = `slider-${s.key}`;
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = s.label;
    const out = document.createElement("output");
    out.htmlFor = id;
    const input = document.createElement("input");
    Object.assign(input, { type: "range", id, min: lo, max: hi, step: s.step });
    input.value = state.inputs[s.key];
    input.addEventListener("input", () => {
      state.inputs[s.key] = Number(input.value);
      syncSlider(row, s, input, out);
      afterInputChange();
    });
    row.append(label, out, input);
    wrap.appendChild(row);
    syncSlider(row, s, input, out);
  }
  syncReset();
  $("#whatif-intro").textContent =
    state.mode === "build"
      ? "Start from a middle of the road player and make them whoever you like."
      : "Drag anything below and the price moves with it. Try moving them to a relegation side.";
}

function syncSlider(row, s, input, out) {
  const fmt = s.fmt ?? ((v) => String(Math.round(v)));
  const v = Number(input.value);
  const pct = ((v - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty("--pct", `${pct}%`);
  out.replaceChildren(fmt(v));
  if (state.mode === "player") {
    const base = selected()[s.key];
    const changed = differs(base, v);
    row.classList.toggle("changed", changed);
    if (changed) {
      const was = document.createElement("span");
      was.className = "was";
      was.textContent = fmt(base);
      out.appendChild(was);
    }
  } else {
    row.classList.remove("changed");
  }
}

function syncReset() {
  const btn = $("#whatif-reset");
  if (state.mode === "build") {
    btn.textContent = "Back to an average player";
    btn.hidden = false;
  } else {
    btn.textContent = "Reset to real stats";
    btn.hidden = !inputsChanged();
  }
}

let frame = 0;
function afterInputChange() {
  syncReset();
  cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => renderSlip());
}

// the board

function boardRows() {
  const pos = state.board.pos;
  const rows = leaguePlayers()
    .filter((p) => pos === "All" || p.position === pos)
    // sorted by euros rather than %: otherwise 35 year olds valued at 300k
    // top the list every time with +400%
    .map((p) => ({ p, pred: p[state.model], gap: p[state.model] - p.value }));
  const { key, dir } = state.board;
  const sign = dir === "asc" ? 1 : -1;
  const get = {
    name: (r) => r.p.name,
    team: (r) => r.p.team,
    age: (r) => r.p.age,
    value: (r) => r.p.value,
    pred: (r) => r.pred,
    gap: (r) => r.gap,
  }[key];
  rows.sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * sign;
  });
  return rows;
}

function renderBoard() {
  const rows = boardRows();
  const body = $("#board-table tbody");
  body.replaceChildren();
  for (const { p, pred, gap } of rows.slice(0, state.board.limit)) {
    const tr = document.createElement("tr");
    tr.tabIndex = 0;
    if (p.id === state.playerId && state.mode === "player") tr.classList.add("selected");

    const name = document.createElement("td");
    name.className = "player-cell";
    name.textContent = p.name;
    const sub = document.createElement("small");
    sub.textContent = `${p.position} · ${p.team}`;
    name.appendChild(sub);

    const team = document.createElement("td");
    team.className = "hide-sm";
    team.textContent = p.team;

    const cells = [
      ["num", Math.floor(p.age)],
      ["num", money(p.value)],
      ["num", money(pred)],
    ].map(([cls, text]) => {
      const td = document.createElement("td");
      td.className = cls;
      td.textContent = text;
      return td;
    });

    const gapTd = document.createElement("td");
    gapTd.className = "num";
    const kind = verdict(pred, p.value);
    const wrap = document.createElement("span");
    wrap.className = "gap-cell";
    const bar = document.createElement("span");
    bar.className = "bar";
    const fill = document.createElement("span");
    fill.className = kind === "fair" ? (gap >= 0 ? "up fair" : "down fair") : kind;
    // square root so a 5m gap is still visible next to a 60m one
    fill.style.width = `${Math.min(Math.sqrt(Math.abs(gap) / 50), 1) * 30}px`;
    bar.appendChild(fill);
    const txt = document.createElement("span");
    txt.className = "gap-text";
    txt.textContent = signedMoney(gap);
    const pct = document.createElement("small");
    pct.textContent = signed(gapPct(pred, p.value), 0, "%");
    txt.appendChild(pct);
    wrap.append(bar, txt);
    gapTd.appendChild(wrap);

    tr.append(name, team, ...cells, gapTd);
    const open = () => {
      selectPlayer(p.id);
      $("#slip").scrollIntoView({ behavior: "smooth", block: "nearest" });
    };
    tr.addEventListener("click", open);
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter") open();
    });
    tr.addEventListener("pointermove", (e) => playerTooltip(e, p, state.model));
    tr.addEventListener("pointerleave", hideTooltip);
    body.appendChild(tr);
  }

  for (const th of document.querySelectorAll("#board-table th")) {
    if (th.dataset.sort === state.board.key) {
      th.setAttribute("aria-sort", state.board.dir === "asc" ? "ascending" : "descending");
    } else {
      th.removeAttribute("aria-sort");
    }
  }
  const more = $("#board-more");
  more.hidden = rows.length <= state.board.limit;
  more.textContent = `Show more (${rows.length - state.board.limit} left)`;
}

function wireBoard() {
  for (const th of document.querySelectorAll("#board-table th")) {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.board.key === key) {
        state.board.dir = state.board.dir === "asc" ? "desc" : "asc";
      } else {
        state.board.key = key;
        state.board.dir = key === "name" || key === "team" ? "asc" : "desc";
      }
      renderBoard();
    });
  }
  $("#board-more").addEventListener("click", () => {
    state.board.limit += 15;
    renderBoard();
  });
}

function paintBoardChips() {
  renderChips($("#board-position"), state.board.pos, (pos) => {
    state.board.pos = pos;
    state.board.limit = 15;
    paintBoardChips();
    renderBoard();
  });
}

function paintScatterChips() {
  renderChips($("#scatter-position"), state.scatterPos, (pos) => {
    state.scatterPos = pos;
    paintScatterChips();
    renderScatter();
  });
}

function renderChips(container, current, onPick) {
  container.replaceChildren();
  for (const pos of ["All", ...meta.positions]) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = pos === "All" ? "Everyone" : `${pos}s`;
    b.setAttribute("aria-pressed", String(pos === current));
    b.addEventListener("click", () => onPick(pos));
    container.appendChild(b);
  }
}

// the ticker

function renderTicker() {
  const pool = leaguePlayers()
    .filter((p) => p.value >= 5 && p.minutes_played >= 1000)
    .map((p) => ({ p, gap: Math.log(p[state.model] / p.value) }))
    .sort((a, b) => b.gap - a.gap);
  const ups = pool.slice(0, 7);
  const downs = pool.slice(-7).reverse();
  const items = [];
  for (let i = 0; i < 7; i++) {
    if (ups[i]) items.push(ups[i]);
    if (downs[i]) items.push(downs[i]);
  }
  const track = $("#ticker-track");
  track.replaceChildren();
  // two copies so the loop is seamless, the second one is hidden from screen readers
  for (const copy of [0, 1]) {
    for (const { p, gap } of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `ticker-item ${gap >= 0 ? "up" : "down"}`;
      if (copy) {
        b.tabIndex = -1;
        b.setAttribute("aria-hidden", "true");
      }
      const who = document.createElement("span");
      who.className = "who";
      who.textContent = p.name;
      const vals = document.createElement("span");
      vals.textContent = `${money(p.value)} → ${money(p[state.model])}`;
      const g = document.createElement("span");
      g.className = "gap";
      g.textContent = signed(gapPct(p[state.model], p.value), 0, "%");
      b.append(who, vals, g);
      b.addEventListener("click", () => selectPlayer(p.id));
      track.appendChild(b);
    }
  }
}

// model tab

function renderModelTab() {
  const lm = meta.leagues[state.league].metrics;
  const m = lm[state.model];
  const other = state.model === "linear" ? "forest" : "linear";
  const o = lm[other];
  const tiles = [
    ["Typical miss (MAE)", money(m.mae_m), `${money(o.mae_m)} for the ${MODEL_NAME[other]}`],
    ["RMSE", money(m.rmse_m), `punishes big misses, ${money(o.rmse_m)} for the ${MODEL_NAME[other]}`],
    ["R² on euros", m.r2.toFixed(2), `${o.r2.toFixed(2)} for the ${MODEL_NAME[other]}`],
    ["R² on log value", m.r2_log.toFixed(2), `what it's trained on, ${m.n} players`],
  ];
  const wrap = $("#tiles");
  wrap.replaceChildren();
  for (const [label, value, note] of tiles) {
    const d = document.createElement("div");
    d.className = "tile";
    const l = document.createElement("span");
    l.className = "tile-label";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "tile-value";
    v.textContent = value;
    const n = document.createElement("span");
    n.className = "tile-note";
    n.textContent = note;
    d.append(l, v, n);
    wrap.appendChild(d);
  }

  importance.update(meta.leagues[state.league].importance[state.model]);

  const legend = $("#scatter-legend");
  legend.replaceChildren();
  for (const [cls, text] of [
    ["up", "model rates them 25%+ higher"],
    ["fair", "roughly agree"],
    ["down", "model rates them 20%+ lower"],
  ]) {
    const s = document.createElement("span");
    const i = document.createElement("i");
    i.style.background = cls === "up" ? "var(--bargain)" : cls === "down" ? "var(--overpriced)" : "var(--dot)";
    s.append(i, text);
    legend.appendChild(s);
  }
  for (const [cls, text] of [["key-line", "best fit"], ["key-diag", "perfect agreement"]]) {
    const s = document.createElement("span");
    const i = document.createElement("i");
    i.className = cls;
    s.append(i, text);
    legend.appendChild(s);
  }

  renderScatter();
}

function renderScatter() {
  scatter.draw(leaguePlayers(), {
    model: state.model,
    position: state.scatterPos,
    selected: state.mode === "player" ? state.playerId : null,
  });
}

// state changes

function renderAll({ fresh = true } = {}) {
  renderControls();
  renderWhatIf();
  renderSlip({ fresh });
  renderBoard();
  paintBoardChips();
  paintScatterChips();
  renderTicker();
  renderModelTab();
  writeHash();
}

function defaultPlayer(league) {
  return players.filter((p) => p.league === league).sort((a, b) => b.value - a.value)[0];
}

async function setLeague(league, playerId) {
  await ensureModels(league);
  state.league = league;
  const p = byId.get(playerId);
  state.playerId = p && p.league === league ? p.id : defaultPlayer(league).id;
  state.inputs = state.mode === "build" ? averageInputs() : inputsFor(selected());
  state.board.limit = 15;
  renderAll();
}

async function selectPlayer(id) {
  const p = byId.get(id);
  if (!p) return;
  state.mode = "player";
  if (p.league !== state.league) {
    await setLeague(p.league, id);
    return;
  }
  state.playerId = id;
  state.inputs = inputsFor(p);
  renderAll();
}

function setModel(kind) {
  state.model = kind;
  renderAll({ fresh: false });
}

function setMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  state.inputs = mode === "build" ? averageInputs() : inputsFor(selected());
  renderAll();
}

// url hash: #premier_league/linear/123456 or #la_liga/forest/build

function writeHash() {
  const key = meta.leagues[state.league].key;
  const tail = state.mode === "build" ? "build" : state.playerId;
  history.replaceState(null, "", `#${key}/${state.model}/${tail}`);
}

function readHash() {
  const [key, model, tail] = location.hash.slice(1).split("/");
  const league = Object.keys(meta.leagues).find((l) => meta.leagues[l].key === key);
  return {
    league,
    model: model === "forest" || model === "linear" ? model : null,
    build: tail === "build",
    playerId: Number(tail) || null,
  };
}

// search

function normalise(s) {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ø/gi, "o").toLowerCase();
}

function wireSearch() {
  const input = $("#player-search");
  const list = $("#search-results");
  let hits = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
  };

  const pick = (p) => {
    close();
    input.value = "";
    input.blur();
    selectPlayer(p.id);
  };

  const paint = () => {
    list.replaceChildren();
    if (!hits.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "Nobody by that name with 600+ minutes";
      list.appendChild(li);
    }
    hits.forEach((p, i) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.id = `hit-${i}`;
      li.setAttribute("aria-selected", String(i === active));
      const n = document.createElement("span");
      n.textContent = p.name;
      const s = document.createElement("span");
      s.className = "sub";
      s.textContent = `${p.team}${p.league !== state.league ? ` · ${p.league}` : ""}`;
      li.append(n, s);
      li.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        pick(p);
      });
      list.appendChild(li);
    });
    if (active >= 0) input.setAttribute("aria-activedescendant", `hit-${active}`);
    else input.removeAttribute("aria-activedescendant");
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  input.addEventListener("input", () => {
    const q = normalise(input.value.trim());
    if (!q) return close();
    hits = players
      .filter((p) => normalise(p.name).includes(q) || normalise(p.team).includes(q))
      .sort((a, b) => (a.league === state.league ? 0 : 1) - (b.league === state.league ? 0 : 1) || b.value - a.value)
      .slice(0, 8);
    active = hits.length ? 0 : -1;
    paint();
  });

  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      active = (active + step + hits.length) % hits.length;
      paint();
    } else if (e.key === "Enter" && hits[active]) {
      e.preventDefault();
      pick(hits[active]);
    } else if (e.key === "Escape") {
      close();
    }
  });
  input.addEventListener("blur", () => setTimeout(close, 100));
}

// tabs and theme

function wireTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const show = (tab) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
    }
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => show(tab));
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      show(next);
      next.focus();
    });
  });
}

function wireTheme() {
  $("#theme-toggle").addEventListener("click", () => {
    const root = document.documentElement;
    const dark = root.dataset.theme
      ? root.dataset.theme === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try {
      localStorage.setItem("theme", root.dataset.theme);
    } catch (e) {
      // private mode, the toggle still works for this visit
    }
  });
}

// go

async function init() {
  wireTheme();
  wireTabs();
  wireSearch();
  wireBoard();

  [meta, players] = await Promise.all([loadJSON("data/meta.json"), loadJSON("data/players.json")]);
  byId = new Map(players.map((p) => [p.id, p]));

  $("#edition-line").textContent = `Season ${meta.season} · values as of ${fmtDate(meta.valuesAsOf)} · ${players.length} players`;
  $("#exported-line").textContent = `numbers last rebuilt ${fmtDate(meta.exported)}`;

  gapScale = createGapScale($("#gap-scale"));
  importance = createImportance($("#importance-chart"));
  scatter = createScatter($("#scatter-chart"), { onPick: (p) => {
    selectPlayer(p.id);
    document.getElementById("tab-desk").click();
    window.scrollTo({ top: $("#slip").getBoundingClientRect().top + window.scrollY - 20, behavior: "smooth" });
  } });

  buildLeaguePicker();
  for (const b of document.querySelectorAll("#model-picker button")) {
    b.addEventListener("click", () => setModel(b.dataset.value));
  }
  for (const b of document.querySelectorAll("#mode-switch button")) {
    b.addEventListener("click", () => setMode(b.dataset.value));
  }
  $("#input-team").addEventListener("change", (e) => {
    const t = meta.leagues[state.league].teams.find((x) => x.team === e.target.value);
    state.inputs.team = t.team;
    state.inputs.team_ppg = t.team_ppg;
    afterInputChange();
  });
  $("#input-position").addEventListener("change", (e) => {
    state.inputs.position = e.target.value;
    afterInputChange();
  });
  $("#whatif-reset").addEventListener("click", () => {
    state.inputs = state.mode === "build" ? averageInputs() : inputsFor(selected());
    renderWhatIf();
    renderSlip();
  });

  const fromHash = readHash();
  if (fromHash.model) state.model = fromHash.model;
  if (fromHash.build) state.mode = "build";
  const league = fromHash.league ?? Object.keys(meta.leagues)[0];
  await setLeague(league, fromHash.playerId);
}

init().catch((err) => {
  console.error(err);
  $("#edition-line").textContent = "Couldn't load the data. Try a refresh.";
});
