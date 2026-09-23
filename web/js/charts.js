// Hand-rolled SVG/HTML charts. Nothing fancy, no chart library: a log scale,
// a few paths, and hover handling.

import { money, verdict, FEATURE_LABEL } from "./format.js";

const SVG = "http://www.w3.org/2000/svg";

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function logScale([d0, d1], [r0, r1]) {
  const l0 = Math.log(d0);
  const l1 = Math.log(d1);
  const s = (v) => r0 + ((Math.log(Math.min(Math.max(v, d0), d1)) - l0) / (l1 - l0)) * (r1 - r0);
  s.domain = [d0, d1];
  return s;
}

const MONEY_TICKS = [0.5, 1, 2, 5, 10, 20, 50, 100, 200];

function tickText(v) {
  return v < 1 ? `${v * 1000}k` : `${v}m`;
}

// Tooltip shared by every chart. Content is built with textContent only,
// player names come from an API.

const tip = () => document.getElementById("tooltip");

export function showTooltip(event, rows) {
  const t = tip();
  t.replaceChildren();
  for (const row of rows) {
    const div = document.createElement("div");
    div.className = row.cls;
    if (row.pair) {
      const a = document.createElement("span");
      a.textContent = row.pair[0];
      const b = document.createElement("b");
      b.textContent = row.pair[1];
      div.append(a, b);
    } else {
      div.textContent = row.text;
    }
    t.appendChild(div);
  }
  t.hidden = false;
  const pad = 14;
  const { innerWidth: w, innerHeight: h } = window;
  const box = t.getBoundingClientRect();
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  if (x + box.width > w - 8) x = event.clientX - box.width - pad;
  if (y + box.height > h - 8) y = event.clientY - box.height - pad;
  t.style.left = `${Math.max(8, x)}px`;
  t.style.top = `${Math.max(8, y)}px`;
}

export function hideTooltip() {
  tip().hidden = true;
}

export function playerTooltip(event, p, model) {
  showTooltip(event, [
    { cls: "tt-name", text: p.name },
    { cls: "tt-sub", text: `${p.team} · ${p.position} · ${Math.floor(p.age)}` },
    { cls: "tt-row", pair: ["Market", money(p.value)] },
    { cls: "tt-row", pair: ["Model", money(p[model])] },
  ]);
}

// The price scale on the valuation slip: one log axis, a dot for the model,
// a ring for the market, a coloured band between them.

export function createGapScale(container) {
  const AXIS_Y = 44;
  const svg = el("svg", { role: "img" }, container);
  const axis = el("g", {}, svg);
  // the moving parts are created once and slid around with CSS transforms,
  // redrawing them would kill the transition
  const band = el("rect", { class: "band", x: 0, y: AXIS_Y - 3, width: 1, height: 6 }, svg);
  const market = el("g", { class: "marker" }, svg);
  el("circle", { r: 6, fill: "var(--sheet)", stroke: "var(--ink)", "stroke-width": 2 }, market);
  const model = el("g", { class: "marker" }, svg);
  el("circle", { r: 7, fill: "var(--ink)" }, model);
  const labelModel = el("text", { class: "marker-label", y: 18, "text-anchor": "middle" }, svg);
  const labelMarket = el("text", { class: "marker-label", y: 18, "text-anchor": "middle" }, svg);

  let width = 0;
  let x = null;
  let last = null;

  function layoutAxis() {
    width = container.clientWidth || 400;
    svg.setAttribute("viewBox", `0 0 ${width} 70`);
    x = logScale([0.3, 250], [8, width - 8]);
    axis.replaceChildren();
    el("line", { class: "axis-line", x1: 8, x2: width - 8, y1: AXIS_Y, y2: AXIS_Y }, axis);
    for (const v of MONEY_TICKS) {
      const g = el("g", { class: "tick", transform: `translate(${x(v)},0)` }, axis);
      el("line", { y1: AXIS_Y - 3, y2: AXIS_Y + 3 }, g);
      const t = el("text", { y: AXIS_Y + 17, "text-anchor": "middle" }, g);
      t.textContent = tickText(v);
    }
  }

  function draw(modelValue, marketValue) {
    last = [modelValue, marketValue];
    if (!x || container.clientWidth !== width) layoutAxis();

    const hasMarket = Number.isFinite(marketValue);
    const xm = x(modelValue);
    model.style.transform = `translate(${xm}px, ${AXIS_Y}px)`;

    market.style.display = hasMarket ? "" : "none";
    band.style.display = hasMarket ? "" : "none";
    labelMarket.style.display = hasMarket ? "" : "none";

    const labels = [{ node: labelModel, x: xm, text: `model ${money(modelValue)}` }];
    if (hasMarket) {
      const xk = x(marketValue);
      market.style.transform = `translate(${xk}px, ${AXIS_Y}px)`;
      const lo = Math.min(xm, xk);
      band.style.transform = `translate(${lo}px, 0) scaleX(${Math.max(Math.abs(xk - xm), 1)})`;
      const kind = verdict(modelValue, marketValue);
      band.style.fill = kind === "up" ? "var(--bargain)" : kind === "down" ? "var(--overpriced)" : "var(--fair)";
      labels.push({ node: labelMarket, x: xk, text: `market ${money(marketValue)}` });
    }

    // labels sit above their marker, nudged apart when the two are close
    labels.sort((a, b) => a.x - b.x);
    const half = 52;
    if (labels.length === 2 && labels[1].x - labels[0].x < half * 2 + 8) {
      const mid = (labels[0].x + labels[1].x) / 2;
      labels[0].x = mid - half - 4;
      labels[1].x = mid + half + 4;
    }
    // then slide the whole group back inside the edges, keeping the spacing
    const shiftRight = Math.max(0, half - labels[0].x);
    const shiftLeft = Math.max(0, labels[labels.length - 1].x - (width - half));
    for (const l of labels) {
      l.node.textContent = l.text;
      l.node.setAttribute("x", l.x + shiftRight - shiftLeft);
    }

    svg.setAttribute(
      "aria-label",
      hasMarket ? `Model ${money(modelValue)}, market ${money(marketValue)}` : `Model ${money(modelValue)}`
    );
  }

  new ResizeObserver(() => {
    if (last && container.clientWidth !== width) {
      layoutAxis();
      draw(...last);
    }
  }).observe(container);
  return { draw };
}

// Feature importance: HTML bars so the widths can animate with plain CSS,
// rows reorder with a FLIP animation when the model changes.

export function createImportance(container) {
  const rows = new Map();
  const list = document.createElement("div");
  list.className = "imp-list";
  container.appendChild(list);

  function update(importance) {
    const entries = Object.entries(importance).sort((a, b) => b[1] - a[1]);
    const max = Math.max(...entries.map(([, v]) => v), 0.01);

    const before = new Map();
    for (const [key, row] of rows) before.set(key, row.getBoundingClientRect().top);

    for (const [key, value] of entries) {
      let row = rows.get(key);
      if (!row) {
        row = document.createElement("div");
        row.className = "imp-row";
        row.tabIndex = 0;
        row.innerHTML = '<span class="imp-label"></span><span class="imp-track"><span class="imp-bar"></span></span><span class="imp-value mono"></span>';
        row.querySelector(".imp-label").textContent = FEATURE_LABEL[key] ?? key;
        rows.set(key, row);
      }
      list.appendChild(row);
      const width = Math.max(0, value) / max;
      row.querySelector(".imp-bar").style.width = `${(width * 100).toFixed(1)}%`;
      row.querySelector(".imp-value").textContent = value < 0.005 ? "~0" : value.toFixed(2);
      row.title = `${FEATURE_LABEL[key] ?? key}: shuffling it drops R² by ${value.toFixed(3)}`;
    }

    for (const [key, row] of rows) {
      const old = before.get(key);
      if (old == null) continue;
      const delta = old - row.getBoundingClientRect().top;
      if (!delta) continue;
      row.animate([{ transform: `translateY(${delta}px)` }, { transform: "none" }], {
        duration: 380,
        easing: "cubic-bezier(0.2, 0.7, 0.2, 1)",
      });
    }
  }

  return { update };
}

// Predicted against actual, log-log. Points coloured by the verdict, the
// dotted diagonal is perfect agreement, the solid line is the best fit.

export function createScatter(container, { onPick }) {
  const svg = el("svg", { role: "img", "aria-label": "Model value against market value for every player" }, container);
  let data = [];
  let opts = {};
  let points = [];

  function draw(players, options) {
    data = players;
    opts = options;
    render();
  }

  function render() {
    // hidden tab: nothing to measure yet, the ResizeObserver redraws once it shows
    if (!container.clientWidth) return;
    const width = container.clientWidth - 12;
    const height = Math.round(Math.min(520, Math.max(320, width * 0.72)));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.style.height = `${height}px`;
    svg.replaceChildren();

    const m = { top: 12, right: 16, bottom: 44, left: 52 };
    const domain = [0.3, 250];
    const x = logScale(domain, [m.left, width - m.right]);
    const y = logScale(domain, [height - m.bottom, m.top]);

    const grid = el("g", { class: "grid" }, svg);
    for (const v of MONEY_TICKS) {
      el("line", { x1: x(v), x2: x(v), y1: m.top, y2: height - m.bottom }, grid);
      el("line", { x1: m.left, x2: width - m.right, y1: y(v), y2: y(v) }, grid);
      const tx = el("text", { class: "tick-label", x: x(v), y: height - m.bottom + 16, "text-anchor": "middle" }, svg);
      tx.textContent = `€${tickText(v)}`;
      const ty = el("text", { class: "tick-label", x: m.left - 8, y: y(v) + 4, "text-anchor": "end" }, svg);
      ty.textContent = `€${tickText(v)}`;
    }
    const xt = el("text", { class: "axis-title", x: (m.left + width - m.right) / 2, y: height - 6, "text-anchor": "middle" }, svg);
    xt.textContent = "Market value (Transfermarkt)";
    const yt = el("text", { class: "axis-title", transform: `translate(13,${(m.top + height - m.bottom) / 2}) rotate(-90)`, "text-anchor": "middle" }, svg);
    yt.textContent = "Model value";

    el("line", { class: "diag", x1: x(domain[0]), y1: y(domain[0]), x2: x(domain[1]), y2: y(domain[1]) }, svg);

    // least squares in log space, same as the matplotlib version in model.py
    const lx = data.map((p) => Math.log(p.value));
    const ly = data.map((p) => Math.log(p[opts.model]));
    const mx = lx.reduce((a, b) => a + b, 0) / lx.length;
    const my = ly.reduce((a, b) => a + b, 0) / ly.length;
    let sxy = 0;
    let sxx = 0;
    lx.forEach((v, i) => {
      sxy += (v - mx) * (ly[i] - my);
      sxx += (v - mx) ** 2;
    });
    const slope = sxy / sxx;
    const icpt = my - slope * mx;
    const fitAt = (v) => Math.exp(icpt + slope * Math.log(v));
    const fx0 = 0.5;
    const fx1 = 220;
    el("line", { class: "fit", x1: x(fx0), y1: y(fitAt(fx0)), x2: x(fx1), y2: y(fitAt(fx1)) }, svg);

    const dots = el("g", {}, svg);
    points = data.map((p) => {
      const kind = verdict(p[opts.model], p.value);
      const faded = opts.position !== "All" && p.position !== opts.position;
      const c = el("circle", {
        class: `dot ${kind}${faded ? " faded" : ""}${p.id === opts.selected ? " selected" : ""}`,
        cx: x(p.value),
        cy: y(p[opts.model]),
        r: p.id === opts.selected ? 6.5 : 4.5,
      }, dots);
      return { p, c, cx: x(p.value), cy: y(p[opts.model]), faded };
    });

    const sel = points.find((pt) => pt.p.id === opts.selected);
    if (sel) {
      dots.appendChild(sel.c); // on top
      const label = el("text", {
        class: "selected-label",
        x: sel.cx + (sel.cx > width - 140 ? -10 : 10),
        y: sel.cy - 10,
        "text-anchor": sel.cx > width - 140 ? "end" : "start",
      }, svg);
      label.textContent = sel.p.name;
    }

    // one invisible layer catches the pointer and finds the nearest dot,
    // so nobody has to land on a 9px circle
    const hit = el("rect", { x: m.left, y: m.top, width: width - m.left - m.right, height: height - m.top - m.bottom, fill: "transparent" }, svg);
    let hovered = null;
    const nearest = (evt) => {
      const pt = svg.createSVGPoint();
      pt.x = evt.clientX;
      pt.y = evt.clientY;
      const local = pt.matrixTransform(svg.getScreenCTM().inverse());
      let best = null;
      let bestD = 28 * 28;
      for (const q of points) {
        if (q.faded) continue;
        const d = (q.cx - local.x) ** 2 + (q.cy - local.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = q;
        }
      }
      return best;
    };
    hit.addEventListener("pointermove", (evt) => {
      const q = nearest(evt);
      if (hovered && hovered !== q) hovered.c.classList.remove("hover");
      hovered = q;
      if (q) {
        q.c.classList.add("hover");
        hit.style.cursor = "pointer";
        playerTooltip(evt, q.p, opts.model);
      } else {
        hit.style.cursor = "default";
        hideTooltip();
      }
    });
    hit.addEventListener("pointerleave", () => {
      if (hovered) hovered.c.classList.remove("hover");
      hovered = null;
      hideTooltip();
    });
    hit.addEventListener("click", (evt) => {
      const q = nearest(evt);
      if (q) {
        hideTooltip();
        onPick(q.p);
      }
    });
  }

  new ResizeObserver(() => data.length && render()).observe(container);
  return { draw };
}
