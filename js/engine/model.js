// The user-facing model: propositions, rules, constraints, parameters, tests.
// This is what the editor manipulates and what gets serialised to JSON.
// `compile.js` turns it into a factor graph.

import { uid } from "./util.js";

export const OPS = ["AND", "OR", "NOT", "XOR"];
export const RULE_TYPES = [
  { id: "implies", label: "implies", glyph: "→", hint: "A → B: A being true forces B true" },
  { id: "implies-not", label: "excludes", glyph: "⊸", hint: "A → ¬B: A being true forces B false" },
  { id: "iff", label: "equivalent", glyph: "↔", hint: "A ↔ B: A and B must agree" },
];
export const CONSTRAINT_TYPES = [
  { id: "exactly-one", label: "exactly one", glyph: "=1" },
  { id: "at-most-one", label: "at most one", glyph: "≤1" },
];

export function emptyModel(name = "Untitled model") {
  return {
    id: uid("m"),
    name,
    description: "",
    nodes: [],
    rules: [],
    constraints: [],
    params: [],
    tests: [],
    target: null,
  };
}

export function makeNode(partial = {}) {
  return {
    id: partial.id || uid("n"),
    label: partial.label || "P",
    note: partial.note || "",
    kind: partial.kind || "prop",
    op: partial.op || "AND",
    inputs: partial.inputs ? partial.inputs.slice() : [],
    prior: partial.prior === undefined ? { type: "bernoulli", p: 0.5 } : partial.prior,
    evidence: partial.evidence || null,
    x: partial.x ?? null,
    y: partial.y ?? null,
  };
}

export function makeRule(partial = {}) {
  return {
    id: partial.id || uid("r"),
    label: partial.label || "",
    ants: partial.ants ? partial.ants.slice() : [],
    antOp: partial.antOp || "AND",
    cons: partial.cons || null,
    type: partial.type || "implies",
    rel: partial.rel || { type: "fixed", p: 1 },
    x: partial.x ?? null,
    y: partial.y ?? null,
  };
}

export function makeConstraint(partial = {}) {
  return {
    id: partial.id || uid("c"),
    label: partial.label || "",
    type: partial.type || "exactly-one",
    members: partial.members ? partial.members.slice() : [],
    x: partial.x ?? null,
    y: partial.y ?? null,
  };
}

export function makeParam(partial = {}) {
  return {
    id: partial.id || uid("p"),
    label: partial.label || "θ",
    a: partial.a ?? 2,
    b: partial.b ?? 2,
    bins: partial.bins ?? 21,
    note: partial.note || "",
  };
}

export function makeTest(partial = {}) {
  return {
    id: partial.id || uid("t"),
    label: partial.label || "Test",
    target: partial.target || null,
    cost: partial.cost ?? 1,
    note: partial.note || "",
    // outcomes[i] = { name, l0 = P(outcome | target=false), l1 = P(outcome | target=true) }
    outcomes: partial.outcomes
      ? partial.outcomes.map((o) => ({ ...o }))
      : [
          { name: "positive", l0: 0.1, l1: 0.9 },
          { name: "negative", l0: 0.9, l1: 0.1 },
        ],
    performed: partial.performed ?? null,
  };
}

export function cloneModel(m) {
  return JSON.parse(JSON.stringify(m));
}

export function nodeById(model, id) {
  return model.nodes.find((n) => n.id === id) || null;
}

export function labelOf(model, id) {
  const n = nodeById(model, id);
  return n ? n.label : "?";
}

/** Human-readable rendering of a rule, e.g. "A1 ∧ A2 → B". */
export function ruleText(model, rule) {
  const glyph = RULE_TYPES.find((t) => t.id === rule.type)?.glyph || "→";
  const join = rule.antOp === "OR" ? " ∨ " : " ∧ ";
  const ant = rule.ants.length ? rule.ants.map((a) => labelOf(model, a)).join(join) : "⊤";
  return `${ant} ${glyph} ${labelOf(model, rule.cons)}`;
}

/** Structural checks; returns a list of {level, text}. */
export function validateModel(model) {
  const issues = [];
  const ids = new Set(model.nodes.map((n) => n.id));
  const seen = new Set();
  for (const n of model.nodes) {
    if (seen.has(n.label)) issues.push({ level: "warn", text: `Duplicate label "${n.label}"` });
    seen.add(n.label);
    if (n.kind === "compound") {
      if (!n.inputs.length) issues.push({ level: "error", text: `${n.label}: compound node has no inputs` });
      if (n.op === "NOT" && n.inputs.length !== 1)
        issues.push({ level: "error", text: `${n.label}: NOT takes exactly one input` });
      for (const i of n.inputs)
        if (!ids.has(i)) issues.push({ level: "error", text: `${n.label}: unknown input` });
      if (n.prior) issues.push({ level: "warn", text: `${n.label}: compound nodes ignore priors` });
    }
  }
  // compound cycles
  const state = new Map();
  const walk = (id) => {
    if (state.get(id) === 1) return true;
    if (state.get(id) === 2) return false;
    state.set(id, 1);
    const n = model.nodes.find((x) => x.id === id);
    let cyc = false;
    if (n && n.kind === "compound") for (const i of n.inputs) if (walk(i)) cyc = true;
    state.set(id, 2);
    return cyc;
  };
  for (const n of model.nodes) if (n.kind === "compound" && walk(n.id))
    issues.push({ level: "error", text: `Cycle through compound node ${n.label}` });

  for (const r of model.rules) {
    if (!r.cons || !ids.has(r.cons)) issues.push({ level: "error", text: `Rule ${r.id}: missing consequent` });
    if (!r.ants.length) issues.push({ level: "error", text: `Rule ${r.id}: missing antecedent` });
    for (const a of r.ants) if (!ids.has(a)) issues.push({ level: "error", text: `Rule ${r.id}: unknown antecedent` });
    if (r.ants.includes(r.cons)) issues.push({ level: "warn", text: `${ruleText(model, r)} is self-referential` });
  }
  for (const c of model.constraints) {
    if (c.members.length < 2) issues.push({ level: "warn", text: `Constraint ${c.label || c.id} needs ≥2 members` });
  }
  for (const t of model.tests) {
    if (!t.target || !ids.has(t.target)) issues.push({ level: "error", text: `Test ${t.label}: unknown target` });
    for (const o of t.outcomes) {
      if (o.l0 < 0 || o.l1 < 0) issues.push({ level: "error", text: `Test ${t.label}: negative likelihood` });
    }
    const s0 = t.outcomes.reduce((s, o) => s + o.l0, 0);
    const s1 = t.outcomes.reduce((s, o) => s + o.l1, 0);
    if (Math.abs(s0 - 1) > 1e-6 || Math.abs(s1 - 1) > 1e-6)
      issues.push({ level: "warn", text: `Test ${t.label}: outcome likelihoods should sum to 1 for each truth value (got ${s0.toFixed(2)} / ${s1.toFixed(2)})` });
  }
  return issues;
}

/** Remove a node and every reference to it. */
export function deleteNode(model, id) {
  model.nodes = model.nodes.filter((n) => n.id !== id);
  for (const n of model.nodes) n.inputs = n.inputs.filter((i) => i !== id);
  model.nodes = model.nodes.filter((n) => !(n.kind === "compound" && n.inputs.length === 0));
  model.rules = model.rules.filter((r) => r.cons !== id && !r.ants.includes(id));
  for (const c of model.constraints) c.members = c.members.filter((m) => m !== id);
  model.constraints = model.constraints.filter((c) => c.members.length > 0);
  model.tests = model.tests.filter((t) => t.target !== id);
  if (model.target === id) model.target = model.nodes[0]?.id ?? null;
}

export function deleteParam(model, id) {
  model.params = model.params.filter((p) => p.id !== id);
  for (const n of model.nodes)
    if (n.prior && n.prior.type === "param" && n.prior.paramId === id) n.prior = { type: "bernoulli", p: 0.5 };
  for (const r of model.rules)
    if (r.rel && r.rel.type === "param" && r.rel.paramId === id) r.rel = { type: "fixed", p: 1 };
}
