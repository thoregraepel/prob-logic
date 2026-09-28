// Compile the user-facing model into a factor graph.
//
// Two semantics are offered for a rule "A → B with strength p", because the
// choice matters more than anything else in the model and the playground should
// make it visible:
//
//  causal      All rules pointing at B are merged into ONE noisy-OR conditional
//              P(B=1 | parents) = [1 - (1-leak) * prod_pos (1-p_i)^{a_i}]
//                                 * prod_inhibit (1-q_j)^{a_j}
//              with the node's own prior as the leak. A root node's marginal
//              then equals the prior you typed, observing a consequence raises
//              its causes, and p=1 still gives exact modus ponens / tollens.
//
//  constraint  Each rule is its own undirected potential
//              f(a,b) = p * [a -> b] + (1-p)
//              i.e. "worlds that break the rule are down-weighted by 1-p". This
//              is the purer logical reading, but it is not modular: adding a
//              rule out of B changes B's marginal even with no evidence at all.
//
// Biconditionals, rules whose consequent is a compound node, mutual-exclusion
// constraints, priors, evidence and performed tests behave the same either way.

import * as F from "./factors.js";
import { betaGrid } from "./util.js";
import { tableSize } from "./factors.js";

const RULE_KIND = {
  implies: F.KIND.IMPLIES,
  "implies-not": F.KIND.IMPLIES_NOT,
  iff: F.KIND.IFF,
};
const RULE_KIND_G = {
  implies: F.KIND.IMPLIES_G,
  "implies-not": F.KIND.IMPLIES_NOT_G,
  iff: F.KIND.IFF_G,
};

const MAX_CPT = 1 << 18;

export function compile(model) {
  const causal = (model.semantics || "causal") === "causal";
  const vars = [];
  const factors = [];
  const index = new Map();
  const warnings = [];

  const addVar = (v) => {
    if (index.has(v.id)) return index.get(v.id);
    index.set(v.id, vars.length);
    vars.push(v);
    return vars.length - 1;
  };
  const addFactor = (f) => { factors.push(f); return factors.length - 1; };

  // --- shared Beta parameters -------------------------------------------
  const paramVar = new Map();
  const makeParamVar = (id, label, a, b, bins, meta) => {
    const grid = betaGrid(a, b, bins);
    const vi = addVar({
      id: `v:par:${id}`, label, card: bins, kind: "param",
      values: grid.values, prior: grid.weights, beta: { a, b }, ...meta,
    });
    addFactor(F.thetaPriorFactor(`f:bprior:${id}`, vi, grid.weights, `Beta(${a}, ${b})`));
    return vi;
  };
  for (const p of model.params) paramVar.set(p.id, makeParamVar(p.id, p.label, p.a, p.b, p.bins, { paramId: p.id }));

  // --- one binary variable per proposition -------------------------------
  const nodeVar = new Map();
  for (const n of model.nodes) {
    nodeVar.set(n.id, addVar({
      id: `v:${n.id}`, label: n.label, card: 2,
      kind: n.kind === "compound" ? "compound" : "prop",
      nodeId: n.id, domain: ["false", "true"],
    }));
  }
  const isCompound = new Map(model.nodes.map((n) => [n.id, n.kind === "compound"]));

  // --- antecedents and rule-validity variables ---------------------------
  // Done up front because the causal CPTs need them as parents.
  const ruleInfo = new Map();
  for (const r of model.rules) {
    const consV = nodeVar.get(r.cons);
    const antVs = r.ants.map((a) => nodeVar.get(a)).filter((x) => x !== undefined);
    if (consV === undefined || !antVs.length) continue;

    let antV, antLabel;
    if (antVs.length === 1) {
      antV = antVs[0];
      antLabel = vars[antV].label;
    } else {
      antLabel = r.ants.map((a) => model.nodes.find((n) => n.id === a)?.label ?? "?")
        .join(r.antOp === "OR" ? " ∨ " : " ∧ ");
      antV = addVar({ id: `v:ant:${r.id}`, label: antLabel, card: 2, kind: "aux", ruleId: r.id, domain: ["false", "true"] });
      addFactor(F.gateFactor(`f:antgate:${r.id}`, F.KIND[r.antOp], antV, antVs, r.antOp));
    }

    const rel = r.rel || { type: "fixed", p: 1 };
    let relV;
    if (rel.type !== "fixed") {
      relV = addVar({
        id: `v:rel:${r.id}`, label: `holds: ${shortRule(model, r)}`, card: 2,
        kind: "rule", ruleId: r.id, domain: ["broken", "holds"],
      });
      let pv;
      if (rel.type === "param") {
        pv = paramVar.get(rel.paramId);
        if (pv === undefined) warnings.push(`Rule ${shortRule(model, r)}: unknown reliability parameter`);
      } else {
        pv = makeParamVar(`rule:${r.id}`, `ρ: ${shortRule(model, r)}`, rel.a, rel.b, rel.bins || 21, { ownerRule: r.id });
      }
      if (pv !== undefined) addFactor(F.paramLinkFactor(`f:rlink:${r.id}`, pv, relV, vars[pv].values, "ρ → holds"));
    }
    ruleInfo.set(r.id, { rule: r, antV, antLabel, consV, relV, rel, strength: rel.type === "fixed" ? rel.p : 1 });
  }

  // Which rules get folded into a causal CPT, and which stay as potentials?
  const cptRules = new Map(); // consequent nodeId -> [ruleInfo]
  const looseRules = [];
  for (const r of model.rules) {
    const info = ruleInfo.get(r.id);
    if (!info) continue;
    const foldable = causal && r.type !== "iff" && !isCompound.get(r.cons);
    if (foldable) {
      if (!cptRules.has(r.cons)) cptRules.set(r.cons, []);
      cptRules.get(r.cons).push(info);
    } else {
      looseRules.push(info);
      if (causal && isCompound.get(r.cons))
        warnings.push(`${shortRule(model, r)}: the consequent is a compound node, so this rule stays an undirected constraint.`);
    }
  }

  // --- gates, priors and causal CPTs -------------------------------------
  for (const n of model.nodes) {
    const vi = nodeVar.get(n.id);
    if (n.kind === "compound") {
      const ins = n.inputs.map((i) => nodeVar.get(i)).filter((x) => x !== undefined);
      if (!ins.length) continue;
      addFactor(F.gateFactor(`f:gate:${n.id}`, F.KIND[n.op], vi, ins, n.op));
      continue;
    }

    const parents = cptRules.get(n.id) || [];
    const prior = n.prior && n.prior.type !== "none" ? n.prior : null;

    // The leak term: either a number, or a Beta-distributed parameter variable.
    let leakP = 0.5, leakVar;
    if (prior && prior.type === "bernoulli") leakP = prior.p;
    else if (prior && prior.type === "beta")
      leakVar = makeParamVar(`node:${n.id}`, `θ: ${n.label}`, prior.a, prior.b, prior.bins || 21, { ownerNode: n.id });
    else if (prior && prior.type === "param") {
      leakVar = paramVar.get(prior.paramId);
      if (leakVar === undefined) { warnings.push(`${n.label}: unknown parameter, using a uniform prior`); leakP = 0.5; }
    }

    if (!parents.length) {
      // plain prior
      if (leakVar !== undefined) addFactor(F.paramLinkFactor(`f:plink:${n.id}`, leakVar, vi, vars[leakVar].values, `θ → ${n.label}`));
      else if (prior) addFactor(F.priorFactor(`f:prior:${n.id}`, vi, leakP, `P = ${leakP}`));
      continue;
    }

    // noisy-OR conditional over [B, (theta), ...antecedents, ...validity vars]
    const pvars = [vi];
    const pcard = [2];
    if (leakVar !== undefined) { pvars.push(leakVar); pcard.push(vars[leakVar].card); }
    const slots = [];
    for (const info of parents) {
      let antSlot = pvars.indexOf(info.antV);
      if (antSlot < 0) { pvars.push(info.antV); pcard.push(2); antSlot = pvars.length - 1; }
      let relSlot = -1;
      if (info.relV !== undefined) { pvars.push(info.relV); pcard.push(2); relSlot = pvars.length - 1; }
      slots.push({ info, antSlot, relSlot, inhibit: info.rule.type === "implies-not", strength: info.strength });
    }

    if (tableSize(pcard) > MAX_CPT) {
      warnings.push(`${n.label} has too many parents for one conditional; its rules fall back to separate constraints.`);
      looseRules.push(...parents);
      if (leakVar !== undefined) addFactor(F.paramLinkFactor(`f:plink:${n.id}`, leakVar, vi, vars[leakVar].values, `θ → ${n.label}`));
      else if (prior) addFactor(F.priorFactor(`f:prior:${n.id}`, vi, leakP, `P = ${leakP}`));
      continue;
    }

    const leakSlot = leakVar !== undefined ? 1 : -1;
    const leakValues = leakVar !== undefined ? vars[leakVar].values : null;
    const fn = (a) => {
      const leak = leakSlot >= 0 ? leakValues[a[leakSlot]] : leakP;
      let quiet = 1 - leak;
      let inhib = 1;
      for (const s of slots) {
        const active = a[s.antSlot] === 1 && (s.relSlot < 0 || a[s.relSlot] === 1);
        if (!active) continue;
        if (s.inhibit) inhib *= 1 - s.strength;
        else quiet *= 1 - s.strength;
      }
      const p1 = (1 - quiet) * inhib;
      return a[0] === 1 ? p1 : 1 - p1;
    };
    addFactor({
      ...buildDense(`f:cpt:${n.id}`, F.KIND.IMPLIES, `noisy-OR → ${n.label}`, pvars, pcard, fn),
      meta: { cpt: true, nodeId: n.id, ruleIds: parents.map((p) => p.rule.id), leakP, leakVar },
    });
  }

  // --- rules kept as undirected potentials -------------------------------
  for (const info of looseRules) {
    const { rule: r, antV, consV, relV, rel } = info;
    if (relV === undefined) {
      addFactor(F.ruleFactor(`f:rule:${r.id}`, RULE_KIND[r.type], antV, consV, rel.p, ruleGlyph(r, rel.p)));
    } else {
      addFactor(F.gatedRuleFactor(`f:rule:${r.id}`, RULE_KIND_G[r.type], antV, consV, relV, ruleGlyph(r, null)));
    }
  }

  // --- evidence, tests, mutual exclusion ---------------------------------
  for (const n of model.nodes) {
    if (!n.evidence) continue;
    const vi = nodeVar.get(n.id);
    const e = n.evidence;
    const w = e.type === "hard" ? (e.value ? [0, 1] : [1, 0]) : [e.l0, e.l1];
    addFactor(F.evidenceFactor(`f:ev:${n.id}`, vi, w, e.type === "hard" ? (e.value ? "TRUE" : "FALSE") : "soft", { nodeId: n.id }));
  }
  for (const t of model.tests) {
    if (t.performed === null || t.performed === undefined) continue;
    const vi = nodeVar.get(t.target);
    const o = t.outcomes[t.performed];
    if (vi === undefined || !o) continue;
    addFactor(F.evidenceFactor(`f:test:${t.id}`, vi, [o.l0, o.l1], `${t.label}: ${o.name}`, { testId: t.id }));
  }
  for (const c of model.constraints) {
    const ms = c.members.map((m) => nodeVar.get(m)).filter((x) => x !== undefined);
    if (ms.length < 2) continue;
    const kind = c.type === "exactly-one" ? F.KIND.EXACTLY_ONE : F.KIND.AT_MOST_ONE;
    addFactor(F.mutexFactor(`f:mutex:${c.id}`, kind, ms, c.label || (c.type === "exactly-one" ? "exactly one" : "at most one")));
    if (ms.length > 18) warnings.push(`Constraint "${c.label || c.id}" has ${ms.length} members; exact inference will be slow.`);
  }

  const adj = vars.map(() => []);
  factors.forEach((f, fi) => f.vars.forEach((vi, slot) => adj[vi].push({ factor: fi, slot })));

  return { model, semantics: causal ? "causal" : "constraint", vars, factors, adj, nodeVar, paramVar, ruleInfo, index, warnings };
}

function buildDense(id, kind, label, vars, card, fn) {
  const size = tableSize(card);
  const table = new Float64Array(size);
  const st = F.strides(card);
  const assign = new Array(card.length).fill(0);
  for (let idx = 0; idx < size; idx++) {
    for (let d = 0; d < card.length; d++) assign[d] = Math.floor(idx / st[d]) % card[d];
    table[idx] = fn(assign);
  }
  return { id, kind, label, vars, card, table, fn, size };
}

export function shortRule(model, r) {
  const label = (id) => model.nodes.find((n) => n.id === id)?.label ?? "?";
  const glyph = { implies: "→", "implies-not": "⊸", iff: "↔" }[r.type];
  return `${r.ants.map(label).join(r.antOp === "OR" ? " ∨ " : " ∧ ")} ${glyph} ${label(r.cons)}`;
}

function ruleGlyph(r, p) {
  const glyph = { implies: "→", "implies-not": "⊸", iff: "↔" }[r.type];
  if (p === null) return `${glyph}?`;
  return p >= 0.999 ? glyph : `${glyph} ${p}`;
}

/** Add extra factors, used for hypothetical conditioning in value-of-information. */
export function withExtraFactors(compiled, extras) {
  const factors = compiled.factors.concat(extras);
  const adj = compiled.vars.map((_, i) => compiled.adj[i].slice());
  extras.forEach((f, k) => {
    const fi = compiled.factors.length + k;
    f.vars.forEach((vi, slot) => adj[vi].push({ factor: fi, slot }));
  });
  return { ...compiled, factors, adj };
}
