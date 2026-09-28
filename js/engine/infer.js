// One entry point for the three engines, plus convenience views of the result.

import { compile, withExtraFactors } from "./compile.js";
import { runBP } from "./bp.js";
import { runExact } from "./exact.js";
import { runGibbs } from "./gibbs.js";
import { entropyBits, gridMean, gridStd } from "./util.js";

export const ENGINES = [
  { id: "bp", label: "Loopy belief propagation", hint: "Sum-product messages. Exact on trees, fast, approximate when the graph has loops." },
  { id: "exact", label: "Exact (variable elimination)", hint: "Ground truth. Costs exponential time in the treewidth." },
  { id: "gibbs", label: "Gibbs sampling", hint: "MCMC over assignments. Struggles with hard constraints." },
];

export function solve(compiled, settings = {}) {
  const engine = settings.engine || "bp";
  const t0 = (typeof performance !== "undefined" ? performance : Date).now();
  let res;
  if (engine === "exact") res = runExact(compiled, settings.exact || {});
  else if (engine === "gibbs") res = runGibbs(compiled, settings.gibbs || {});
  else res = runBP(compiled, settings.bp || {});
  if (res.unavailable) {
    const fallback = runBP(compiled, settings.bp || {});
    res = { ...fallback, fellBackFrom: engine, note: `${res.note} Fell back to loopy BP.` };
  }
  res.ms = (typeof performance !== "undefined" ? performance : Date).now() - t0;
  return res;
}

export function buildView(compiled, result) {
  const nodes = new Map();
  const params = [];
  const rules = new Map();
  compiled.vars.forEach((v, i) => {
    const b = result.beliefs[i];
    if (v.kind === "param") {
      params.push({
        varIndex: i, id: v.id, label: v.label, values: v.values, prior: v.prior,
        posterior: b, mean: gridMean(v.values, b), std: gridStd(v.values, b),
        priorMean: gridMean(v.values, v.prior), beta: v.beta,
        ownerNode: v.ownerNode, ownerRule: v.ownerRule, paramId: v.paramId,
      });
    } else if (v.kind === "rule") {
      rules.set(v.ruleId, { varIndex: i, p: b[1], entropy: entropyBits(b) });
    } else if (v.nodeId) {
      nodes.set(v.nodeId, {
        varIndex: i, p: b[1], dist: b, entropy: entropyBits(b),
        stderr: result.stderr ? result.stderr[i] : null,
      });
    } else if (v.kind === "aux") {
      nodes.set(v.id, { varIndex: i, p: b[1], dist: b, entropy: entropyBits(b), aux: true, label: v.label });
    }
  });
  const totalEntropy = compiled.vars.reduce(
    (s, v, i) => s + (v.kind === "prop" || v.kind === "compound" ? entropyBits(result.beliefs[i]) : 0), 0);
  return { nodes, params, rules, totalEntropy };
}

export function marginal(compiled, result, nodeId) {
  const vi = compiled.nodeVar.get(nodeId);
  return vi === undefined ? null : result.beliefs[vi];
}

export { compile, withExtraFactors, entropyBits };
