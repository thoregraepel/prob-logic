// Verification suite: run with `node tests/run-tests.mjs` from the project root.
// Everything is checked against brute-force enumeration of the joint.

import * as F from "../js/engine/factors.js";
import { compile } from "../js/engine/compile.js";
import { runBP } from "../js/engine/bp.js";
import { runExact } from "../js/engine/exact.js";
import { runGibbs } from "../js/engine/gibbs.js";
import { rankTests } from "../js/engine/voi.js";
import { makeNode, makeRule, makeConstraint, makeParam, makeTest, emptyModel } from "../js/engine/model.js";
import { makeRng, normalize, entropyBits } from "../js/engine/util.js";

let pass = 0, fail = 0;
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
function check(name, ok, detail = "") {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${detail}`); }
}
function section(t) { console.log(`\n${t}`); }

// --- brute force ------------------------------------------------------------
function bruteForce(compiled) {
  const { vars, factors } = compiled;
  const total = vars.reduce((a, v) => a * v.card, 1);
  if (total > 4e6) throw new Error("too big for brute force: " + total);
  const counts = vars.map((v) => new Array(v.card).fill(0));
  const assign = new Array(vars.length).fill(0);
  let Z = 0;
  for (let idx = 0; idx < total; idx++) {
    let rem = idx;
    for (let i = vars.length - 1; i >= 0; i--) { assign[i] = rem % vars[i].card; rem = Math.floor(rem / vars[i].card); }
    let w = 1;
    for (const f of factors) {
      w *= F.factorValue(f, f.vars.map((vi) => assign[vi]));
      if (w === 0) break;
    }
    if (w === 0) continue;
    Z += w;
    for (let i = 0; i < vars.length; i++) counts[i][assign[i]] += w;
  }
  return { Z, beliefs: counts.map((c) => normalize(c) || c.map(() => 1 / c.length)) };
}

function maxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) for (let x = 0; x < a[i].length; x++) m = Math.max(m, Math.abs(a[i][x] - b[i][x]));
  return m;
}

// --- 1. factor message routines --------------------------------------------
section("Factor message routines: O(k) DP vs dense sum-product");
{
  const rng = makeRng(99);
  const randMsg = () => normalize([rng() + 0.05, rng() + 0.05]);
  const cases = [];
  for (const k of [1, 2, 3, 5]) {
    cases.push(F.gateFactor("g", F.KIND.AND, 0, Array.from({ length: k }, (_, i) => i + 1)));
    cases.push(F.gateFactor("g", F.KIND.OR, 0, Array.from({ length: k }, (_, i) => i + 1)));
    cases.push(F.gateFactor("g", F.KIND.XOR, 0, Array.from({ length: k }, (_, i) => i + 1)));
  }
  cases.push(F.gateFactor("g", F.KIND.NOT, 0, [1]));
  for (const k of [2, 3, 4, 6]) {
    cases.push(F.mutexFactor("m", F.KIND.EXACTLY_ONE, Array.from({ length: k }, (_, i) => i)));
    cases.push(F.mutexFactor("m", F.KIND.AT_MOST_ONE, Array.from({ length: k }, (_, i) => i)));
  }
  let worst = 0, worstKind = "";
  for (const f of cases) {
    for (let trial = 0; trial < 20; trial++) {
      const incoming = f.vars.map(() => randMsg());
      const a = F.genericMessages(f, incoming).map((m) => normalize(m) || m);
      const b = F.dpMessages(f, incoming).map((m) => normalize(m) || m);
      const d = maxDiff(a, b);
      if (d > worst) { worst = d; worstKind = `${f.kind}/${f.vars.length}`; }
    }
  }
  check("DP messages match dense enumeration for every gate & counting factor", worst < 1e-9, `worst ${worst.toExponential(2)} at ${worstKind}`);
}

// --- model builders ---------------------------------------------------------
function diamondModel() {
  const m = emptyModel("diamond");
  const A1 = makeNode({ label: "A1", prior: { type: "bernoulli", p: 0.3 } });
  const A2 = makeNode({ label: "A2", prior: { type: "bernoulli", p: 0.2 } });
  const B = makeNode({ label: "B", prior: { type: "bernoulli", p: 0.1 } });
  const C1 = makeNode({ label: "C1", prior: { type: "bernoulli", p: 0.4 } });
  const C2 = makeNode({ label: "C2", prior: { type: "bernoulli", p: 0.5 } });
  m.nodes = [A1, A2, B, C1, C2];
  m.rules = [
    makeRule({ ants: [A1.id], cons: B.id, rel: { type: "fixed", p: 0.9 } }),
    makeRule({ ants: [A2.id], cons: B.id, rel: { type: "fixed", p: 1 } }),
    makeRule({ ants: [B.id], cons: C1.id, rel: { type: "fixed", p: 0.95 } }),
    makeRule({ ants: [B.id], cons: C2.id, rel: { type: "fixed", p: 0.8 } }),
  ];
  m.nodes[3].evidence = { type: "hard", value: true };
  m.nodes[4].evidence = { type: "soft", l0: 0.2, l1: 0.8 };
  m.target = B.id;
  return m;
}

function loopyModel() {
  const m = emptyModel("loopy");
  const n = (l, p) => makeNode({ label: l, prior: { type: "bernoulli", p } });
  const A = n("A", 0.4), B = n("B", 0.5), C = n("C", 0.3), D = n("D", 0.6), E = n("E", 0.5);
  const comp = makeNode({ label: "A∧B", kind: "compound", op: "AND", inputs: [A.id, B.id], prior: null });
  m.nodes = [A, B, C, D, E, comp];
  m.rules = [
    makeRule({ ants: [comp.id], cons: C.id, rel: { type: "fixed", p: 0.9 } }),
    makeRule({ ants: [C.id], cons: D.id, rel: { type: "fixed", p: 0.85 } }),
    makeRule({ ants: [D.id], cons: A.id, rel: { type: "fixed", p: 0.7 } }),     // closes a loop
    makeRule({ ants: [C.id, D.id], antOp: "OR", cons: E.id, rel: { type: "fixed", p: 0.95 } }),
    makeRule({ ants: [E.id], cons: B.id, type: "implies-not", rel: { type: "fixed", p: 0.4 } }),
  ];
  m.nodes[4].evidence = { type: "soft", l0: 0.3, l1: 0.7 };
  m.target = C.id;
  return m;
}

function mutexModel() {
  const m = emptyModel("multiple choice");
  const opts = ["O1", "O2", "O3", "O4"].map((l) => makeNode({ label: l, prior: { type: "bernoulli", p: 0.25 } }));
  const clue = makeNode({ label: "Clue", prior: { type: "bernoulli", p: 0.5 }, evidence: { type: "hard", value: true } });
  m.nodes = [...opts, clue];
  m.constraints = [makeConstraint({ type: "exactly-one", members: opts.map((o) => o.id) })];
  m.rules = [
    makeRule({ ants: [clue.id], cons: opts[0].id, type: "implies-not", rel: { type: "fixed", p: 1 } }),
    makeRule({ ants: [clue.id], cons: opts[1].id, type: "implies-not", rel: { type: "fixed", p: 0.8 } }),
  ];
  m.target = opts[2].id;
  return m;
}

function hierarchicalModel() {
  const m = emptyModel("hierarchical");
  const theta = makeParam({ label: "θ", a: 2, b: 2, bins: 9 });
  m.params = [theta];
  const xs = [0, 1, 2, 3].map((i) => makeNode({ label: "X" + i, prior: { type: "param", paramId: theta.id } }));
  xs[0].evidence = { type: "hard", value: true };
  xs[1].evidence = { type: "hard", value: true };
  xs[2].evidence = { type: "hard", value: true };
  m.nodes = xs;
  m.target = xs[3].id;
  return m;
}

function uncertainRuleModel() {
  const m = emptyModel("uncertain rule");
  const rho = makeParam({ label: "ρ", a: 1, b: 1, bins: 9 });
  m.params = [rho];
  const nodes = [];
  const rules = [];
  for (let i = 0; i < 3; i++) {
    const a = makeNode({ label: `A${i}`, prior: { type: "bernoulli", p: 0.5 }, evidence: { type: "hard", value: true } });
    const b = makeNode({ label: `B${i}`, prior: { type: "bernoulli", p: 0.5 }, evidence: { type: "hard", value: i < 2 } });
    nodes.push(a, b);
    rules.push(makeRule({ ants: [a.id], cons: b.id, rel: { type: "param", paramId: rho.id } }));
  }
  m.nodes = nodes;
  m.rules = rules;
  m.target = nodes[0].id;
  return m;
}

// --- 2. exact vs brute force ------------------------------------------------
section("Exact variable elimination vs brute-force enumeration");
for (const [name, mk] of [["diamond", diamondModel], ["loopy", loopyModel], ["mutex", mutexModel], ["hierarchical", hierarchicalModel], ["uncertain rule", uncertainRuleModel]])
for (const sem of ["causal", "constraint"]) {
  const compiled = compile(Object.assign(mk(), { semantics: sem }));
  const bf = bruteForce(compiled);
  const ex = runExact(compiled);
  check(`${name} [${sem}]: exact marginals match`, !ex.unavailable && maxDiff(ex.beliefs, bf.beliefs) < 1e-9,
    ex.unavailable ? ex.note : `max diff ${maxDiff(ex.beliefs, bf.beliefs).toExponential(2)}`);
  if (!ex.unavailable && ex.logZ !== null && isFinite(ex.logZ))
    check(`${name} [${sem}]: log Z matches`, near(ex.logZ, Math.log(bf.Z), 1e-6), `${ex.logZ} vs ${Math.log(bf.Z)}`);
}

// --- 3. BP on trees is exact ------------------------------------------------
section("Loopy BP");
{
  const compiled = compile(diamondModel());
  const bf = bruteForce(compiled);
  const bp = runBP(compiled, { maxIters: 500, damping: 0 });
  check("tree-structured model: BP is exact", bp.converged && maxDiff(bp.beliefs, bf.beliefs) < 1e-6,
    `converged=${bp.converged} diff=${maxDiff(bp.beliefs, bf.beliefs).toExponential(2)}`);
}
for (const sem of ["causal", "constraint"]) {
  const compiled = compile(Object.assign(loopyModel(), { semantics: sem }));
  const bf = bruteForce(compiled);
  const bp = runBP(compiled, { maxIters: 2000, damping: 0.2 });
  const d = maxDiff(bp.beliefs, bf.beliefs);
  // Loops are exactly where BP is allowed to be wrong; we only insist it settles
  // down and stays in the right neighbourhood.
  check(`loopy model [${sem}]: BP converges and stays near exact`, bp.converged && d < 0.12, `diff ${d.toFixed(4)}`);
}
{
  const compiled = compile(mutexModel());
  const bf = bruteForce(compiled);
  const bp = runBP(compiled, { maxIters: 2000, damping: 0.2 });
  check("exactly-one constraint: BP matches exact", maxDiff(bp.beliefs, bf.beliefs) < 1e-5,
    `diff ${maxDiff(bp.beliefs, bf.beliefs).toExponential(2)}`);
}
{
  const compiled = compile(hierarchicalModel());
  const bf = bruteForce(compiled);
  const bp = runBP(compiled, { maxIters: 2000, damping: 0.2 });
  check("Beta-Bernoulli hierarchy: BP matches exact", maxDiff(bp.beliefs, bf.beliefs) < 1e-5,
    `diff ${maxDiff(bp.beliefs, bf.beliefs).toExponential(2)}`);
  // conjugacy check: 3 successes under Beta(2,2) -> posterior mean 5/7
  const compiledH = compile(hierarchicalModel());
  const ex = runExact(compiledH);
  const pi = compiledH.vars.findIndex((v) => v.kind === "param");
  const mean = compiledH.vars[pi].values.reduce((s, v, i) => s + v * ex.beliefs[pi][i], 0);
  check("Beta(2,2) + 3 successes ≈ posterior mean 5/7", Math.abs(mean - 5 / 7) < 0.02, `got ${mean.toFixed(4)}`);
}

// --- 4. Gibbs ---------------------------------------------------------------
section("Gibbs sampling");
{
  const compiled = compile(diamondModel());
  const bf = bruteForce(compiled);
  const g = runGibbs(compiled, { samples: 60000, burnIn: 3000, seed: 5, epsilon: 1e-9 });
  const d = maxDiff(g.beliefs, bf.beliefs);
  check("soft-constraint model: Gibbs within Monte Carlo error of exact", d < 0.02, `diff ${d.toFixed(4)}`);
}

// --- 5. value of information ------------------------------------------------
section("Value of information");
{
  const m = diamondModel();
  const B = m.nodes[2];
  m.tests = [
    makeTest({ label: "Perfect", target: B.id, cost: 10, outcomes: [{ name: "pos", l0: 0, l1: 1 }, { name: "neg", l0: 1, l1: 0 }] }),
    makeTest({ label: "Noisy", target: B.id, cost: 0.1, outcomes: [{ name: "pos", l0: 0.3, l1: 0.7 }, { name: "neg", l0: 0.7, l1: 0.3 }] }),
    makeTest({ label: "Useless", target: B.id, cost: 1, outcomes: [{ name: "pos", l0: 0.5, l1: 0.5 }, { name: "neg", l0: 0.5, l1: 0.5 }] }),
  ];
  const compiled = compile(m);
  const settings = { engine: "exact" };
  const { rows, baseBeliefs } = rankTests(compiled, settings, m, B.id, "target");
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
  const h0 = entropyBits(baseBeliefs[compiled.nodeVar.get(B.id)]);
  check("a perfect test removes exactly H(B) bits", near(byLabel.Perfect.eig, h0, 1e-9), `${byLabel.Perfect.eig} vs ${h0}`);
  check("an uninformative test has zero EIG", near(byLabel.Useless.eig, 0, 1e-9), String(byLabel.Useless.eig));
  check("a noisy test lies strictly in between", byLabel.Noisy.eig > 1e-6 && byLabel.Noisy.eig < h0 - 1e-6, String(byLabel.Noisy.eig));
  check("every EIG is non-negative", rows.every((r) => r.eig > -1e-12));
  check("rows come back ordered by bits per unit cost", rows.every((r, i) => i === 0 || rows[i - 1].efficiency >= r.efficiency - 1e-12), rows.map((r) => `${r.label}:${r.efficiency.toFixed(3)}`).join(" "));
  check("the cheap noisy test outranks the expensive perfect one", rows[0].label === "Noisy", rows.map((r) => r.label).join(","));
  const total = rankTests(compiled, settings, m, B.id, "total").rows.find((r) => r.label === "Perfect");
  check("total-uncertainty objective also reports non-negative gain", total.eig > 0, String(total.eig));
}

// --- 6. logical sanity ------------------------------------------------------
section("Logical behaviour");
{
  // modus ponens and modus tollens under a hard rule
  const m = emptyModel("mp");
  const A = makeNode({ label: "A", prior: { type: "bernoulli", p: 0.5 } });
  const B = makeNode({ label: "B", prior: { type: "bernoulli", p: 0.5 } });
  m.nodes = [A, B];
  m.rules = [makeRule({ ants: [A.id], cons: B.id, rel: { type: "fixed", p: 1 } })];
  const run = (mm) => {
    const c = compile(mm);
    const r = runExact(c);
    return { c, r, p: (id) => r.beliefs[c.nodeVar.get(id)][1] };
  };
  m.nodes[0].evidence = { type: "hard", value: true };
  check("modus ponens: A true ⟹ B true", near(run(m).p(B.id), 1, 1e-12));
  m.nodes[0].evidence = null;
  m.nodes[1].evidence = { type: "hard", value: false };
  check("modus tollens: B false ⟹ A false", near(run(m).p(A.id), 0, 1e-12));
  m.nodes[1].evidence = null;
  // Causal semantics are modular: a rule out of A leaves A's marginal at its prior.
  const pACausal = run(m).p(A.id);
  check("causal: a rule out of A leaves A's prior untouched", near(pACausal, 0.5, 1e-9), String(pACausal));
  // Constraint semantics are not: the rule deletes the (A=1, B=0) world outright.
  m.semantics = "constraint";
  const pAConstraint = run(m).p(A.id);
  check("constraint: the same rule pushes A down to 1/3", near(pAConstraint, 1 / 3, 1e-9), String(pAConstraint));
  m.semantics = "causal";
  m.nodes[1].evidence = { type: "hard", value: true };
  const pA = run(m).p(A.id);
  check("affirming the consequent raises A but never proves it", pA > pACausal + 1e-6 && pA < 1, `${pACausal.toFixed(3)} -> ${pA.toFixed(3)}`);

  // contradiction detection
  const bad = emptyModel("bad");
  const X = makeNode({ label: "X", evidence: { type: "hard", value: true } });
  const Y = makeNode({ label: "Y", evidence: { type: "hard", value: false } });
  bad.nodes = [X, Y];
  bad.rules = [makeRule({ ants: [X.id], cons: Y.id, rel: { type: "fixed", p: 1 } })];
  const c = compile(bad);
  check("contradictory evidence is reported", runExact(c).inconsistent === true);

  // uncertain rules: a counterexample should lower belief that the rule holds
  const ur = compile(uncertainRuleModel());
  const urRes = runExact(ur);
  const rhoIdx = ur.vars.findIndex((v) => v.kind === "param");
  const rhoMean = ur.vars[rhoIdx].values.reduce((s, v, i) => s + v * urRes.beliefs[rhoIdx][i], 0);
  check("2 confirmations + 1 counterexample pulls ρ below its 0.5 prior", rhoMean < 0.5 && rhoMean > 0.1, `ρ̄ = ${rhoMean.toFixed(3)}`);
  const holdsIdx = ur.vars.findIndex((v) => v.kind === "rule");
  check("the broken instance is the one flagged as not holding", urRes.beliefs[holdsIdx][1] < 1);
}

section("Causal (noisy-OR) semantics");
{
  const m = emptyModel("noisy-or");
  const A = makeNode({ label: "A", prior: { type: "bernoulli", p: 0.5 }, evidence: { type: "hard", value: true } });
  const B = makeNode({ label: "B", prior: { type: "bernoulli", p: 0.5 }, evidence: { type: "hard", value: true } });
  const C = makeNode({ label: "C", prior: { type: "bernoulli", p: 0 } });
  m.nodes = [A, B, C];
  m.rules = [
    makeRule({ ants: [A.id], cons: C.id, rel: { type: "fixed", p: 0.5 } }),
    makeRule({ ants: [B.id], cons: C.id, rel: { type: "fixed", p: 0.5 } }),
  ];
  const c1 = compile(m);
  const r1 = runExact(c1);
  check("two independent causes of strength 0.5 give 1 - 0.5^2 = 0.75",
    near(r1.beliefs[c1.nodeVar.get(C.id)][1], 0.75, 1e-12), String(r1.beliefs[c1.nodeVar.get(C.id)][1]));

  // leak: with no cause active the node sits at its own prior
  m.nodes[0].evidence = { type: "hard", value: false };
  m.nodes[1].evidence = { type: "hard", value: false };
  m.nodes[2].prior = { type: "bernoulli", p: 0.2 };
  const c2 = compile(m);
  check("with every cause off the node falls back to its prior (the leak)",
    near(runExact(c2).beliefs[c2.nodeVar.get(C.id)][1], 0.2, 1e-12));

  // an inhibitor at full strength vetoes the effect
  m.nodes[0].evidence = { type: "hard", value: true };
  m.rules[1].type = "implies-not";
  m.rules[1].rel = { type: "fixed", p: 1 };
  m.nodes[1].evidence = { type: "hard", value: true };
  const c3 = compile(m);
  check("a full-strength ⊸ inhibitor vetoes the effect",
    near(runExact(c3).beliefs[c3.nodeVar.get(C.id)][1], 0, 1e-12));

  // observing an effect raises its cause above the prior
  const m2 = emptyModel("abduction");
  const X = makeNode({ label: "X", prior: { type: "bernoulli", p: 0.1 } });
  const Y = makeNode({ label: "Y", prior: { type: "bernoulli", p: 0.05 } });
  m2.nodes = [X, Y];
  m2.rules = [makeRule({ ants: [X.id], cons: Y.id, rel: { type: "fixed", p: 0.8 } })];
  const cA = compile(m2);
  check("no evidence: the cause sits exactly at its prior", near(runExact(cA).beliefs[cA.nodeVar.get(X.id)][1], 0.1, 1e-12));
  m2.nodes[1].evidence = { type: "hard", value: true };
  const cB = compile(m2);
  const pX = runExact(cB).beliefs[cB.nodeVar.get(X.id)][1];
  check("observing the effect raises the cause well above its prior", pX > 0.4 && pX < 1, String(pX));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
