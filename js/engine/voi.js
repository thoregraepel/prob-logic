// Value of information: which experiment should we run next?
//
// For a candidate test t with outcomes o and a query variable Q:
//
//   P(o)      = sum_x P(target = x) P(o | target = x)
//   EIG(t)    = H(Q) - sum_o P(o) H(Q | o)              [bits]
//
// EIG is the mutual information I(Q; O), so it is never negative in exact
// inference (loopy BP can produce tiny negative values, which is itself a
// useful signal). Dividing by the cost gives bits per unit spent.

import { evidenceFactor } from "./factors.js";
import { withExtraFactors } from "./compile.js";
import { solve } from "./infer.js";
import { entropyBits, sampleDiscrete, makeRng } from "./util.js";

function totalEntropy(compiled, beliefs) {
  let h = 0;
  compiled.vars.forEach((v, i) => {
    if (v.kind === "prop" || v.kind === "compound") h += entropyBits(beliefs[i]);
  });
  return h;
}

/**
 * @param objective "target" (entropy of one query node) or "total"
 *                  (summed marginal entropy of every proposition).
 */
export function evaluateTest(compiled, settings, test, queryVarIndex, baseBeliefs, objective = "target") {
  const targetVar = compiled.nodeVar.get(test.target);
  if (targetVar === undefined) return null;
  const base = baseBeliefs[targetVar];
  const h0 = objective === "total"
    ? totalEntropy(compiled, baseBeliefs)
    : entropyBits(baseBeliefs[queryVarIndex]);

  const outcomes = [];
  let expected = 0;
  for (let k = 0; k < test.outcomes.length; k++) {
    const o = test.outcomes[k];
    const prob = base[0] * o.l0 + base[1] * o.l1;
    if (!(prob > 1e-12)) {
      outcomes.push({ name: o.name, prob: 0, posterior: null, entropy: 0, dist: null });
      continue;
    }
    const extra = evidenceFactor(`voi:${test.id}:${k}`, targetVar, [o.l0, o.l1], `${test.label}=${o.name}`);
    const hypothetical = withExtraFactors(compiled, [extra]);
    const res = solve(hypothetical, settings);
    const h = objective === "total"
      ? totalEntropy(hypothetical, res.beliefs)
      : entropyBits(res.beliefs[queryVarIndex]);
    expected += prob * h;
    outcomes.push({
      name: o.name, prob, entropy: h,
      posterior: res.beliefs[queryVarIndex][1],
      dist: res.beliefs[queryVarIndex],
      beliefs: res.beliefs,
    });
  }
  const eig = h0 - expected;
  const cost = Math.max(test.cost ?? 0, 0);
  return {
    testId: test.id, label: test.label, cost, objective,
    h0, expectedH: expected, eig,
    efficiency: cost > 0 ? eig / cost : eig > 0 ? Infinity : 0,
    outcomes,
  };
}

/** Score every test that has not been performed yet. */
export function rankTests(compiled, settings, model, queryNodeId, objective = "target", baseBeliefs = null) {
  const queryVar = compiled.nodeVar.get(queryNodeId);
  if (queryVar === undefined) return { rows: [], baseBeliefs: null };
  const base = baseBeliefs || solve(compiled, settings).beliefs;
  const rows = [];
  for (const t of model.tests) {
    if (t.performed !== null && t.performed !== undefined) continue;
    const r = evaluateTest(compiled, settings, t, queryVar, base, objective);
    if (r) rows.push(r);
  }
  rows.sort((a, b) => (b.efficiency - a.efficiency) || (b.eig - a.eig));
  return { rows, baseBeliefs: base };
}

/**
 * Greedy active-reasoning plan. Repeatedly picks the best-scoring test,
 * samples an outcome from the current predictive distribution, applies it, and
 * continues until the budget runs out or no test is worth its price.
 */
export function greedyPlan(model, settings, compileFn, queryNodeId, options = {}) {
  const {
    budget = Infinity, maxSteps = 8, minEig = 1e-3, objective = "target",
    scoreBy = "efficiency", seed = 7,
  } = options;
  const rng = makeRng(seed);
  const work = JSON.parse(JSON.stringify(model));
  const steps = [];
  let spent = 0;

  for (let step = 0; step < maxSteps; step++) {
    const compiled = compileFn(work);
    const { rows, baseBeliefs } = rankTests(compiled, settings, work, queryNodeId, objective);
    const qv = compiled.nodeVar.get(queryNodeId);
    const before = baseBeliefs[qv];
    const affordable = rows.filter((r) => spent + r.cost <= budget);
    if (!affordable.length) break;
    affordable.sort((a, b) => (b[scoreBy] - a[scoreBy]) || (b.eig - a.eig));
    const best = affordable[0];
    if (!(best.eig > minEig)) break;

    const probs = best.outcomes.map((o) => o.prob);
    const pick = sampleDiscrete(probs, rng());
    const test = work.tests.find((t) => t.id === best.testId);
    test.performed = pick;
    spent += best.cost;

    const after = compileFn(work);
    const post = solve(after, settings);
    steps.push({
      testId: best.testId, label: best.label, cost: best.cost, eig: best.eig,
      efficiency: best.efficiency, outcome: best.outcomes[pick].name, outcomeIndex: pick,
      before: before[1], after: post.beliefs[after.nodeVar.get(queryNodeId)][1],
      entropyBefore: entropyBits(before),
      entropyAfter: entropyBits(post.beliefs[after.nodeVar.get(queryNodeId)]),
      spent,
    });
  }
  return { steps, model: work, spent };
}
