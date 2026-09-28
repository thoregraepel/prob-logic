// Exact inference by variable elimination.
//
// Slower than BP but gives ground truth on small models, which is what makes
// the playground honest: you can see exactly how far loopy BP drifts.

import { strides, tableSize } from "./factors.js";
import { normalize } from "./util.js";

const DEFAULT_MAX_CLUSTER = 1 << 22;

function potentialFromFactor(f) {
  if (!f.table) return null;
  // reorder into ascending variable order
  const order = f.vars.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const vars = order.map((o) => o[0]);
  if (new Set(vars).size !== vars.length) return null; // repeated variable in one factor
  const card = order.map((o) => f.card[o[1]]);
  const size = f.table.length;
  const stOld = strides(f.card);
  const stNew = strides(card);
  const table = new Float64Array(size);
  const idxs = new Array(vars.length);
  for (let i = 0; i < size; i++) {
    for (let d = 0; d < vars.length; d++) idxs[d] = Math.floor(i / stNew[d]) % card[d];
    let oi = 0;
    for (let d = 0; d < vars.length; d++) oi += idxs[d] * stOld[order[d][1]];
    table[i] = f.table[oi];
  }
  return { vars, card, table, logScale: 0 };
}

function rescale(p) {
  let m = 0;
  for (let i = 0; i < p.table.length; i++) if (p.table[i] > m) m = p.table[i];
  if (m > 0 && (m > 1e100 || m < 1e-100)) {
    for (let i = 0; i < p.table.length; i++) p.table[i] /= m;
    p.logScale += Math.log(m);
  }
  return p;
}

function multiply(a, b) {
  const varSet = [...new Set([...a.vars, ...b.vars])].sort((x, y) => x - y);
  const cardOf = new Map();
  a.vars.forEach((v, i) => cardOf.set(v, a.card[i]));
  b.vars.forEach((v, i) => cardOf.set(v, b.card[i]));
  const card = varSet.map((v) => cardOf.get(v));
  const size = tableSize(card);
  const st = strides(card);
  const sa = strides(a.card);
  const sb = strides(b.card);
  const pa = a.vars.map((v) => varSet.indexOf(v));
  const pb = b.vars.map((v) => varSet.indexOf(v));
  const table = new Float64Array(size);
  const idxs = new Array(varSet.length);
  for (let i = 0; i < size; i++) {
    for (let d = 0; d < varSet.length; d++) idxs[d] = Math.floor(i / st[d]) % card[d];
    let ia = 0;
    for (let d = 0; d < a.vars.length; d++) ia += idxs[pa[d]] * sa[d];
    let ib = 0;
    for (let d = 0; d < b.vars.length; d++) ib += idxs[pb[d]] * sb[d];
    table[i] = a.table[ia] * b.table[ib];
  }
  return rescale({ vars: varSet, card, table, logScale: a.logScale + b.logScale });
}

function sumOut(p, v) {
  const pos = p.vars.indexOf(v);
  if (pos < 0) return p;
  const vars = p.vars.filter((_, i) => i !== pos);
  const card = p.card.filter((_, i) => i !== pos);
  const size = tableSize(card);
  const table = new Float64Array(size);
  const st = strides(p.card);
  const stN = strides(card);
  const idxs = new Array(p.vars.length);
  for (let i = 0; i < p.table.length; i++) {
    const w = p.table[i];
    if (w === 0) continue;
    for (let d = 0; d < p.vars.length; d++) idxs[d] = Math.floor(i / st[d]) % p.card[d];
    let j = 0, k = 0;
    for (let d = 0; d < p.vars.length; d++) {
      if (d === pos) continue;
      j += idxs[d] * stN[k];
      k++;
    }
    table[j] += w;
  }
  return rescale({ vars, card, table, logScale: p.logScale });
}

/** Greedy min-size elimination order over `targets`. */
function eliminationOrder(potentials, targets, cardOf) {
  const remaining = new Set(targets);
  const buckets = potentials.map((p) => new Set(p.vars));
  const order = [];
  while (remaining.size) {
    let best = null, bestCost = Infinity;
    for (const v of remaining) {
      const cluster = new Set();
      for (const b of buckets) if (b.has(v)) for (const u of b) cluster.add(u);
      let cost = 1;
      for (const u of cluster) cost *= cardOf(u);
      if (cost < bestCost) { bestCost = cost; best = v; }
    }
    order.push(best);
    const cluster = new Set();
    const kept = [];
    for (const b of buckets) {
      if (b.has(best)) { for (const u of b) cluster.add(u); }
      else kept.push(b);
    }
    cluster.delete(best);
    kept.push(cluster);
    buckets.length = 0;
    buckets.push(...kept);
    remaining.delete(best);
  }
  return order;
}

function eliminate(potentials, order, maxCluster) {
  let pots = potentials.slice();
  for (const v of order) {
    const hit = pots.filter((p) => p.vars.includes(v));
    const rest = pots.filter((p) => !p.vars.includes(v));
    if (!hit.length) continue;
    let prod = hit[0];
    for (let i = 1; i < hit.length; i++) {
      const projected = tableSize([...new Set([...prod.vars, ...hit[i].vars])].map((u) => {
        const j = prod.vars.indexOf(u);
        return j >= 0 ? prod.card[j] : hit[i].card[hit[i].vars.indexOf(u)];
      }));
      if (projected > maxCluster) throw new Error(`intermediate table of ${projected} entries exceeds the exact-inference budget`);
      prod = multiply(prod, hit[i]);
    }
    pots = rest.concat([sumOut(prod, v)]);
  }
  return pots;
}

export function runExact(compiled, opts = {}) {
  const maxCluster = opts.maxCluster || DEFAULT_MAX_CLUSTER;
  const { vars, factors } = compiled;
  const potentials = [];
  for (const f of factors) {
    const p = potentialFromFactor(f);
    if (!p) return { engine: "exact", unavailable: true, note: `Factor "${f.label}" is too large for exact inference.` };
    potentials.push(p);
  }
  const cardOf = (v) => vars[v].card;
  const all = vars.map((_, i) => i);

  try {
    const beliefs = [];
    let logZ = null;
    for (const q of all) {
      const others = all.filter((v) => v !== q);
      const order = eliminationOrder(potentials, others, cardOf);
      const left = eliminate(potentials, order, maxCluster);
      let prod = left[0] || { vars: [q], card: [vars[q].card], table: new Float64Array(vars[q].card).fill(1), logScale: 0 };
      for (let i = 1; i < left.length; i++) prod = multiply(prod, left[i]);
      // prod may still carry constants over no variables
      let dist;
      if (prod.vars.length === 0) {
        dist = new Array(vars[q].card).fill(1 / vars[q].card);
      } else {
        const pos = prod.vars.indexOf(q);
        dist = Array.from({ length: vars[q].card }, (_, x) => prod.table[x * strides(prod.card)[pos]]);
      }
      if (logZ === null) {
        let s = 0;
        for (const v of prod.table) s += v;
        logZ = prod.logScale + Math.log(s);
        if (prod.vars.length > 1) logZ = null; // only trustworthy when everything else was eliminated
      }
      const n = normalize(dist);
      beliefs.push(n || dist.map(() => 1 / vars[q].card));
      if (!n) logZ = -Infinity;
    }
    const inconsistent = logZ === -Infinity;
    return {
      engine: "exact", beliefs, logZ, inconsistent, converged: true, iters: 1,
      note: inconsistent ? "The model is contradictory: no assignment satisfies all constraints." : null,
    };
  } catch (err) {
    return { engine: "exact", unavailable: true, note: String(err.message || err) };
  }
}
