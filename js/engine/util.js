// Small numeric helpers shared by the inference engines and the UI.

export function sum(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

/** Normalise a non-negative vector in place-safe fashion. Returns null if the mass is zero. */
export function normalize(v) {
  const s = sum(v);
  if (!(s > 0) || !isFinite(s)) return null;
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / s;
  return out;
}

/** Normalise, falling back to the uniform distribution when the mass vanishes. */
export function normalizeSafe(v) {
  return normalize(v) || v.map(() => 1 / v.length);
}

/** Shannon entropy in bits. */
export function entropyBits(dist) {
  let h = 0;
  for (const p of dist) if (p > 0) h -= p * Math.log2(p);
  return h;
}

export function logOdds(p) {
  const q = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
  return Math.log(q / (1 - q));
}

/** log Gamma (Lanczos) — used only for Beta densities on a grid. */
export function lnGamma(z) {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

export function lnBetaPdf(x, a, b) {
  if (x <= 0 || x >= 1) return -Infinity;
  return (
    (a - 1) * Math.log(x) +
    (b - 1) * Math.log(1 - x) +
    lnGamma(a + b) - lnGamma(a) - lnGamma(b)
  );
}

/**
 * Discretise Beta(a, b) onto a midpoint grid of `bins` cells on (0, 1).
 * Returns the grid points and the normalised cell masses.
 */
export function betaGrid(a, b, bins) {
  const values = [];
  const logw = [];
  for (let k = 0; k < bins; k++) {
    const v = (k + 0.5) / bins;
    values.push(v);
    logw.push(lnBetaPdf(v, a, b));
  }
  const m = Math.max(...logw.filter(isFinite));
  const w = logw.map((l) => (isFinite(l) ? Math.exp(l - m) : 0));
  return { values, weights: normalizeSafe(w) };
}

/** Mean of a distribution over grid values. */
export function gridMean(values, dist) {
  let m = 0;
  for (let i = 0; i < values.length; i++) m += values[i] * dist[i];
  return m;
}

export function gridStd(values, dist) {
  const m = gridMean(values, dist);
  let v = 0;
  for (let i = 0; i < values.length; i++) v += dist[i] * (values[i] - m) ** 2;
  return Math.sqrt(Math.max(v, 0));
}

/** Deterministic PRNG so every run in the playground is reproducible. */
export function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return function rng() {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleDiscrete(dist, u) {
  let acc = 0;
  for (let i = 0; i < dist.length; i++) {
    acc += dist[i];
    if (u < acc) return i;
  }
  return dist.length - 1;
}

export function fmtPct(p, digits = 1) {
  if (!isFinite(p)) return "—";
  return (100 * p).toFixed(digits) + "%";
}

export function fmtNum(x, digits = 3) {
  if (!isFinite(x)) return "—";
  if (x === 0) return "0";
  const a = Math.abs(x);
  if (a >= 1000 || a < 1e-3) return x.toExponential(2);
  return x.toFixed(digits);
}

let idCounter = 0;
export function uid(prefix = "id") {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36).slice(-4)}${idCounter.toString(36)}`;
}
