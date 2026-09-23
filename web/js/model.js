// Runs the exported models in the browser. Mirrors the sklearn pipelines in
// model.py: both predict log(value in EUR m), so everything ends in Math.exp.

export function predictLinear(m, player) {
  let y = m.intercept;
  m.numeric.forEach((col, i) => {
    y += (m.coef[i] * (player[col] - m.mean[i])) / m.scale[i];
  });
  // age squared, scaled the same way sklearn did it
  y += (m.ageSq.coef * (player.age * player.age - m.ageSq.mean)) / m.ageSq.scale;
  // the first position (Defender) is the baseline, so it has no entry
  y += m.position[player.position] ?? 0;
  return Math.exp(y);
}

export function predictForest(m, player) {
  // sklearn casts inputs to float32 before walking the trees, Math.fround
  // does the same so edge cases like age 26.2 take the same branch
  const x = m.columns.map((c) =>
    Math.fround(c.startsWith("position=") ? (player.position === c.slice(9) ? 1 : 0) : player[c])
  );
  let sum = 0;
  for (const t of m.trees) {
    let node = 0;
    while (t.f[node] !== -1) {
      node = x[t.f[node]] <= t.t[node] ? t.l[node] : t.r[node];
    }
    sum += t.v[node];
  }
  return Math.exp(sum / m.trees.length);
}

export function predict(m, player) {
  return m.type === "linear" ? predictLinear(m, player) : predictForest(m, player);
}
