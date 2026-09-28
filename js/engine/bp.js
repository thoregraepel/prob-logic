// Loopy belief propagation (sum-product) on the factor graph.
//
//   variable -> factor:   m_{i->a}(x) = prod_{b in N(i)\a} m_{b->i}(x)
//   factor -> variable:   m_{a->i}(x) = sum_{x_a: x_i = x} f_a(x_a) prod_{j != i} m_{j->a}(x_j)
//   belief:               b_i(x) proportional to prod_{a in N(i)} m_{a->i}(x)
//
// Messages are renormalised at every step so long chains of hard constraints do
// not underflow. On a tree this is exact; with loops it is an approximation and
// may oscillate, which is why damping and a residual trace are exposed.

import { factorMessages } from "./factors.js";
import { normalize } from "./util.js";

export const BP_DEFAULTS = {
  maxIters: 300,
  tol: 1e-9,
  damping: 0.1,
  schedule: "sequential", // or "parallel"
};

export function runBP(compiled, opts = {}) {
  const o = { ...BP_DEFAULTS, ...opts };
  const { vars, factors, adj } = compiled;

  // factor -> variable messages, uniform to start
  const msg = factors.map((f) => f.card.map((c) => new Array(c).fill(1 / c)));
  const residuals = [];
  let inconsistent = false;
  let converged = false;
  let iters = 0;

  const v2f = (vi, skipFactor, skipSlot) => {
    const c = vars[vi].card;
    const out = new Array(c).fill(1);
    for (const { factor, slot } of adj[vi]) {
      if (factor === skipFactor && slot === skipSlot) continue;
      const m = msg[factor][slot];
      for (let x = 0; x < c; x++) out[x] *= m[x];
    }
    const n = normalize(out);
    if (!n) { inconsistent = true; return out.map(() => 1 / c); }
    return n;
  };

  const updateFactor = (fi, target) => {
    const f = factors[fi];
    const incoming = f.vars.map((vi, slot) => v2f(vi, fi, slot));
    let out;
    try {
      out = factorMessages(f, incoming);
    } catch (err) {
      inconsistent = true;
      return 0;
    }
    let res = 0;
    for (let slot = 0; slot < out.length; slot++) {
      let n = normalize(out[slot]);
      if (!n) { inconsistent = true; n = out[slot].map(() => 1 / out[slot].length); }
      const prev = target[fi][slot];
      const next = new Array(n.length);
      for (let x = 0; x < n.length; x++) {
        next[x] = o.damping * prev[x] + (1 - o.damping) * n[x];
        res = Math.max(res, Math.abs(next[x] - prev[x]));
      }
      target[fi][slot] = next;
    }
    return res;
  };

  for (let it = 0; it < o.maxIters; it++) {
    iters = it + 1;
    let res = 0;
    if (o.schedule === "parallel") {
      const next = msg.map((m) => m.map((v) => v.slice()));
      for (let fi = 0; fi < factors.length; fi++) res = Math.max(res, updateFactor(fi, next));
      for (let fi = 0; fi < factors.length; fi++) msg[fi] = next[fi];
    } else {
      for (let fi = 0; fi < factors.length; fi++) res = Math.max(res, updateFactor(fi, msg));
    }
    residuals.push(res);
    if (res < o.tol) { converged = true; break; }
  }

  const beliefs = vars.map((v, vi) => {
    const out = new Array(v.card).fill(1);
    for (const { factor, slot } of adj[vi]) {
      const m = msg[factor][slot];
      for (let x = 0; x < v.card; x++) out[x] *= m[x];
    }
    return normalize(out) || out.map(() => 1 / v.card);
  });

  return {
    engine: "bp", beliefs, iters, converged, residuals, inconsistent,
    messages: msg,
    note: inconsistent
      ? "Messages collapsed to zero mass — the constraints may be contradictory."
      : converged ? null : `Did not converge in ${o.maxIters} iterations (residual ${residuals.at(-1)?.toExponential(2)}).`,
  };
}

/**
 * Incoming factor->variable messages for one variable, used by the explanation
 * panel: each one is an independent piece of evidence about that variable.
 */
export function incomingMessages(compiled, result, vi) {
  return compiled.adj[vi].map(({ factor, slot }) => ({
    factor: compiled.factors[factor],
    factorIndex: factor,
    message: result.messages[factor][slot],
  }));
}
