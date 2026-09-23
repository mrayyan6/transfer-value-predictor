// Small formatting helpers. Values are always in EUR millions.

const MINUS = "−";

export function money(m) {
  if (m == null || !Number.isFinite(m)) return "n/a";
  if (m >= 100) return `€${Math.round(m)}m`;
  if (m >= 1) return `€${m.toFixed(1)}m`;
  return `€${Math.round(m * 1000)}k`;
}

export function signed(n, digits = 0, suffix = "") {
  const v = Number(n.toFixed(digits));
  if (v === 0) return `0${suffix}`;
  return `${v > 0 ? "+" : MINUS}${Math.abs(v).toFixed(digits)}${suffix}`;
}

export function signedMoney(m) {
  if (Math.abs(m) < 0.05) return "no change";
  return `${m > 0 ? "+" : MINUS}${money(Math.abs(m))}`;
}

// How far apart model and market are, as the % the model adds or takes off.
export function gapPct(model, market) {
  return (model / market - 1) * 100;
}

// Symmetric thresholds in log space: 25% over or 20% under counts as a real gap.
export function verdict(model, market) {
  const r = model / market;
  if (r >= 1.25) return "up";
  if (r <= 0.8) return "down";
  return "fair";
}

export const VERDICT_TEXT = {
  up: "Undervalued",
  down: "Overpriced",
  fair: "About right",
};

export function fmtDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export const FEATURE_LABEL = {
  age: "Age",
  minutes_played: "Minutes",
  goals: "Goals",
  assists: "Assists",
  shots_on_target: "Shots on target",
  key_passes: "Key passes",
  tackles: "Tackles",
  team_ppg: "Club strength",
  position: "Position",
};

// Tween a number shown in an element, so prices slide instead of jumping.
const running = new WeakMap();
const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

export function tweenText(el, to, fmt, duration = 420) {
  const from = Number(el.dataset.value);
  el.dataset.value = String(to);
  if (reduceMotion || !Number.isFinite(from) || !Number.isFinite(to) || from === to) {
    el.textContent = fmt(to);
    return;
  }
  cancelAnimationFrame(running.get(el));
  const start = performance.now();
  // interpolate in log space, a jump from 2m to 80m should feel even
  const a = Math.log(Math.max(from, 0.01));
  const b = Math.log(Math.max(to, 0.01));
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const e = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(Math.exp(a + (b - a) * e));
    if (t < 1) running.set(el, requestAnimationFrame(step));
  };
  running.set(el, requestAnimationFrame(step));
}
