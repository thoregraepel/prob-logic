// Gibbs sampling over the factor graph.
//
// Hard logical constraints make single-site Gibbs reducible (a deterministic
// gate can pin its inputs), so two mitigations are provided: an epsilon floor
// on factor values, and block moves over exactly-one groups. The sampler is
// here mainly as a contrast to message passing — watching it fail on tight
// constraints is part of the lesson.

import { factorValue, KIND } from "./factors.js";
import { makeRng, sampleDiscrete, normalize } from "./util.js";

export const GIBBS_DEFAULTS = {
  samples: 20000,
  burnIn: 2000,
  epsilon: 1e-6,
  seed: 12345,
  blockMoves: true,
};

export function runGibbs(compiled, opts = {}) {
  const o = { ...GIBBS_DEFAULTS, ...opts };
  const { vars, factors, adj } = compiled;
  const rng = makeRng(o.seed);
  const n = vars.length;

  const val = (f, assign) => Math.max(factorValue(f, assign), o.epsilon);

  // initialise from a random assignment, then a short greedy pass to find
  // something with non-trivial weight
  const state = vars.map((v) => Math.floor(rng() * v.card));

  const localAssign = (f) => f.vars.map((vi) => state[vi]);

  const conditional = (vi) => {
    const c = vars[vi].card;
    const w = new Array(c).fill(1);
    for (const { factor, slot } of adj[vi]) {
      const f = factors[factor];
      const a = localAssign(f);
      for (let x = 0; x < c; x++) {
        a[slot] = x;
        w[x] *= val(f, a);
      }
      a[slot] = state[vi];
    }
    return normalize(w) || w.map(() => 1 / c);
  };

  // exactly-one groups get a joint move over their n legal configurations
  const blocks = o.blockMoves
    ? factors.filter((f) => f.kind === KIND.EXACTLY_ONE).map((f) => ({
        members: f.vars.slice(),
        touching: [...new Set(f.vars.flatMap((vi) => adj[vi].map((e) => e.factor)))],
      }))
    : [];

  const blockMove = (blk) => {
    const weights = blk.members.map((_, pick) => {
      const saved = blk.members.map((vi) => state[vi]);
      blk.members.forEach((vi, k) => { state[vi] = k === pick ? 1 : 0; });
      let w = 1;
      for (const fi of blk.touching) w *= val(factors[fi], localAssign(factors[fi]));
      blk.members.forEach((vi, k) => { state[vi] = saved[k]; });
      return w;
    });
    const d = normalize(weights);
    if (!d) return;
    const pick = sampleDiscrete(d, rng());
    blk.members.forEach((vi, k) => { state[vi] = k === pick ? 1 : 0; });
  };

  const counts = vars.map((v) => new Array(v.card).fill(0));
  const total = o.burnIn + o.samples;
  const traceVar = opts.traceVar ?? null;
  const trace = [];
  let kept = 0;
  let traceHits = 0;

  for (let s = 0; s < total; s++) {
    for (let vi = 0; vi < n; vi++) {
      const d = conditional(vi);
      state[vi] = sampleDiscrete(d, rng());
    }
    for (const blk of blocks) blockMove(blk);
    if (s >= o.burnIn) {
      kept++;
      for (let vi = 0; vi < n; vi++) counts[vi][state[vi]]++;
      if (traceVar !== null) {
        if (state[traceVar] === 1) traceHits++;
        if (kept % Math.max(1, Math.floor(o.samples / 120)) === 0) trace.push(traceHits / kept);
      }
    }
  }

  const beliefs = counts.map((c) => normalize(c) || c.map(() => 1 / c.length));
  // Monte Carlo standard error for binary variables (ignoring autocorrelation)
  const stderr = beliefs.map((b, i) =>
    vars[i].card === 2 ? Math.sqrt(Math.max(b[1] * (1 - b[1]), 0) / kept) : null
  );

  return {
    engine: "gibbs", beliefs, stderr, trace, samples: kept, converged: true, iters: total,
    note: `${kept.toLocaleString()} sweeps kept after ${o.burnIn.toLocaleString()} burn-in. Hard constraints are relaxed by ε=${o.epsilon}, so estimates are slightly biased.`,
  };
}
