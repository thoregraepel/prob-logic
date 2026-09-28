// A library of worked models. Each one is written with a tiny builder so the
// logical structure stays readable.

import { emptyModel, makeNode, makeRule, makeConstraint, makeParam, makeTest } from "../engine/model.js";

class Builder {
  constructor(name, description) {
    this.m = emptyModel(name);
    this.m.description = description;
    this.m.guide = [];
    this.k = {};
  }
  guide(...lines) { this.m.guide.push(...lines); return this; }
  prop(key, label, p, opts = {}) {
    const n = makeNode({ label, prior: p === null ? null : { type: "bernoulli", p }, ...opts });
    this.m.nodes.push(n); this.k[key] = n.id; return n.id;
  }
  betaProp(key, label, a, b, opts = {}) {
    const n = makeNode({ label, prior: { type: "beta", a, b, bins: 21 }, ...opts });
    this.m.nodes.push(n); this.k[key] = n.id; return n.id;
  }
  paramProp(key, label, paramKey, opts = {}) {
    const n = makeNode({ label, prior: { type: "param", paramId: this.k[paramKey] }, ...opts });
    this.m.nodes.push(n); this.k[key] = n.id; return n.id;
  }
  compound(key, label, op, inputKeys) {
    const n = makeNode({ label, kind: "compound", op, inputs: inputKeys.map((i) => this.k[i]), prior: null });
    this.m.nodes.push(n); this.k[key] = n.id; return n.id;
  }
  param(key, label, a, b, note = "", bins = 21) {
    const p = makeParam({ label, a, b, bins, note });
    this.m.params.push(p); this.k[key] = p.id; return p.id;
  }
  rule(ants, cons, opts = {}) {
    const rel = opts.param ? { type: "param", paramId: this.k[opts.param] }
      : opts.beta ? { type: "beta", a: opts.beta[0], b: opts.beta[1], bins: 21 }
      : { type: "fixed", p: opts.p ?? 1 };
    const r = makeRule({
      ants: (Array.isArray(ants) ? ants : [ants]).map((a) => this.k[a]),
      antOp: opts.antOp || "AND", cons: this.k[cons], type: opts.type || "implies",
      rel, label: opts.label || "",
    });
    this.m.rules.push(r); if (opts.key) this.k[opts.key] = r.id; return r.id;
  }
  mutex(type, memberKeys, label = "") {
    const c = makeConstraint({ type, members: memberKeys.map((k) => this.k[k]), label });
    this.m.constraints.push(c); return c.id;
  }
  evidence(key, value) {
    this.m.nodes.find((n) => n.id === this.k[key]).evidence = { type: "hard", value };
    return this;
  }
  soft(key, l0, l1) {
    this.m.nodes.find((n) => n.id === this.k[key]).evidence = { type: "soft", l0, l1 };
    return this;
  }
  /** A test with sensitivity = P(pos | true) and specificity = P(neg | false). */
  test(key, label, targetKey, cost, sens, spec, note = "") {
    const t = makeTest({
      label, target: this.k[targetKey], cost, note,
      outcomes: [
        { name: "positive", l0: 1 - spec, l1: sens },
        { name: "negative", l0: spec, l1: 1 - sens },
      ],
    });
    this.m.tests.push(t); this.k[key] = t.id; return t.id;
  }
  target(key) { this.m.target = this.k[key]; return this; }
  done() { return this.m; }
}

// ---------------------------------------------------------------------------

function warmUp() {
  const b = new Builder(
    "Warm-up: evidence flowing both ways",
    "The canonical shape. Two propositions A₁, A₂ imply B; B implies two consequences C₁, C₂. Evidence enters at the leaves and the marginal of B is what we want."
  );
  b.guide(
    "B starts at 10%. Set C₁ to TRUE and watch B rise — that is abductive support flowing backwards along an implication.",
    "Now set C₂ to FALSE. A hard rule B → C₂ makes this modus tollens: B collapses.",
    "Set A₁ TRUE with its rule at reliability 1 and B is forced true no matter what else you do — modus ponens.",
    "Switch the engine to Exact and back to Loopy BP: on this tree they agree to machine precision."
  );
  b.prop("A1", "A₁", 0.30, { note: "A possible cause of B." });
  b.prop("A2", "A₂", 0.20, { note: "Another possible cause of B." });
  b.prop("B", "B", 0.10, { note: "The proposition we care about." });
  b.prop("C1", "C₁", 0.40, { note: "A consequence of B." });
  b.prop("C2", "C₂", 0.50, { note: "Another consequence of B." });
  b.rule("A1", "B", { p: 0.9 });
  b.rule("A2", "B", { p: 1.0 });
  b.rule("B", "C1", { p: 0.95 });
  b.rule("B", "C2", { p: 0.8 });
  b.soft("C1", 0.25, 0.75);
  b.test("tC1", "Look for C₁", "C1", 1, 0.9, 0.9);
  b.test("tC2", "Look for C₂", "C2", 1, 0.85, 0.85);
  b.test("tA1", "Check A₁", "A1", 4, 0.95, 0.95);
  b.test("tB", "Measure B directly", "B", 20, 0.99, 0.99);
  b.target("B");
  return b.done();
}

function chestClinic() {
  const b = new Builder(
    "Medical diagnosis: the chest clinic",
    "A patient arrives coughing and short of breath. Risk factors make diseases plausible; diseases make symptoms plausible. Which disease, and which test should we order?"
  );
  b.guide(
    "Cough and dyspnoea are already observed. Bronchitis explains both cheaply, so it dominates — this is Occam's razor falling out of the arithmetic.",
    "Open Experiments: the £2 smoking history and the £5 weight question beat the £900 CT scan on bits-per-pound, even though the CT is by far the most informative single test.",
    "Perform the chest X-ray with a positive result. Cancer and TB both jump; then a positive sputum test explains the X-ray away and cancer falls back.",
    "Set 'Smoker' to TRUE and everything downstream re-balances."
  );
  b.prop("smoker", "Smoker", 0.25);
  b.prop("travel", "TB exposure", 0.05, { note: "Recent travel to a high-incidence region." });
  b.prop("cancer", "Lung cancer", 0.02);
  b.prop("tb", "Tuberculosis", 0.01);
  b.prop("bronch", "Bronchitis", 0.15);
  b.prop("xray", "Abnormal chest X-ray", 0.05, { note: "Latent until imaging is actually done." });
  b.prop("cough", "Persistent cough", 0.10);
  b.prop("dysp", "Dyspnoea", 0.10);
  b.prop("weight", "Unexplained weight loss", 0.05);
  b.rule("smoker", "cancer", { p: 0.16 });
  b.rule("smoker", "bronch", { p: 0.45 });
  b.rule("travel", "tb", { p: 0.08 });
  b.rule("cancer", "xray", { p: 0.95 });
  b.rule("tb", "xray", { p: 0.90 });
  b.rule("cancer", "weight", { p: 0.60 });
  b.rule("cancer", "cough", { p: 0.50 });
  b.rule("tb", "cough", { p: 0.70 });
  b.rule("bronch", "cough", { p: 0.88 });
  b.rule("cancer", "dysp", { p: 0.60 });
  b.rule("bronch", "dysp", { p: 0.70 });
  b.mutex("at-most-one", ["cancer", "tb"], "at most one primary disease");
  b.evidence("cough", true);
  b.evidence("dysp", true);
  b.test("tx", "Chest X-ray", "xray", 120, 0.95, 0.92, "Cheap imaging; sensitive but not specific.");
  b.test("tct", "CT scan", "cancer", 900, 0.96, 0.94, "Reads out the cancer node almost directly.");
  b.test("tsp", "Sputum culture", "tb", 60, 0.85, 0.99, "Slow but near-conclusive when positive.");
  b.test("twt", "Weight history", "weight", 5, 0.90, 0.85, "One question at the bedside.");
  b.test("tsm", "Smoking history", "smoker", 2, 0.95, 0.90);
  b.target("cancer");
  return b.done();
}

function outage() {
  const b = new Builder(
    "Fault analysis: the site is down",
    "A web service is failing. Redundancy means some faults only matter in combination — the mirrored disk array only dies when BOTH disks die, which is an AND node feeding an implication."
  );
  b.guide(
    "Users are complaining and the monitor has fired. Every root cause is still on the table.",
    "The compound node 'Disk A ∧ Disk B' is what makes redundancy visible: each disk alone is likely-ish, their conjunction is not.",
    "Run the greedy planner in Experiments with a budget of 10 — it buys the £1 latency graph and the £4 database probe first.",
    "Set 'Switch failed' to FALSE by hand and watch the database branch absorb all the blame (explaining away, in reverse).",
    "This model has real loops, so it is the one place where loopy BP visibly disagrees with exact inference — compare the engines in the Engines tab."
  );
  b.prop("power", "Rack power lost", 0.01);
  b.prop("diskA", "Disk A failed", 0.06);
  b.prop("diskB", "Disk B failed", 0.06);
  b.compound("array", "Array lost", "AND", ["diskA", "diskB"]);
  b.prop("switch", "Switch failed", 0.03);
  b.prop("dbdown", "Database down", 0.02);
  b.prop("appdown", "App tier unreachable", 0.02);
  b.prop("site", "Site down", 0.02);
  b.prop("users", "Users complaining", 0.05);
  b.prop("alert", "Monitor alert", 0.05);
  b.prop("latency", "Elevated latency", 0.10);
  b.rule("power", "dbdown", { p: 0.99 });
  b.rule("array", "dbdown", { p: 0.99 });
  b.rule("switch", "appdown", { p: 0.95 });
  b.rule("power", "appdown", { p: 0.99 });
  b.rule("dbdown", "site", { p: 0.97 });
  b.rule("appdown", "site", { p: 0.97 });
  b.rule("site", "users", { p: 0.9 });
  b.rule("site", "alert", { p: 0.98 });
  b.rule("dbdown", "latency", { p: 0.7 });
  b.evidence("users", true);
  b.evidence("alert", true);
  b.test("ping", "Ping the switch", "switch", 1, 0.99, 0.99);
  b.test("smartA", "SMART report, disk A", "diskA", 2, 0.93, 0.97);
  b.test("smartB", "SMART report, disk B", "diskB", 2, 0.93, 0.97);
  b.test("pdu", "Walk to the rack", "power", 25, 0.99, 0.99);
  b.test("dbprobe", "Database health probe", "dbdown", 4, 0.97, 0.95);
  b.test("lat", "Read the latency graph", "latency", 1, 0.95, 0.9);
  b.target("dbdown");
  return b.done();
}

function scienceDebate() {
  const b = new Builder(
    "Scientific reasoning: three rival hypotheses",
    "Exactly one of three explanations for an astronomical anomaly is right. Each predicts different observations, and one hypothesis actively forbids an observation the others expect."
  );
  b.guide(
    "The 'exactly one' constraint is the engine of this example: raising one hypothesis necessarily lowers the other two.",
    "The lensing offset is already observed, which strongly favours the particle hypothesis and hurts modified gravity via the ⊸ (excludes) rule.",
    "Run the cheap recalibration experiment first — it costs almost nothing and can kill the systematics hypothesis outright.",
    "Try setting the direct-detection result to FALSE: the particle hypothesis is dented but survives, because its rule has reliability 0.6, not 1."
  );
  b.prop("h1", "H₁: new particle", 0.34);
  b.prop("h2", "H₂: modified gravity", 0.33);
  b.prop("h3", "H₃: systematic error", 0.33);
  b.prop("p1", "Direct-detection signal", 0.2);
  b.prop("p2", "Low-acceleration rotation law", 0.3);
  b.prop("p3", "Anomaly vanishes on recalibration", 0.2);
  b.prop("p4", "Bullet-cluster lensing offset", 0.3);
  b.mutex("exactly-one", ["h1", "h2", "h3"], "exactly one hypothesis is true");
  b.rule("h1", "p1", { p: 0.6 });
  b.rule("h1", "p4", { p: 0.95 });
  b.rule("h2", "p2", { p: 0.9 });
  b.rule("h2", "p4", { type: "implies-not", p: 0.85 });
  b.rule("h3", "p3", { p: 0.9 });
  b.rule("h3", "p1", { type: "implies-not", p: 0.9 });
  b.evidence("p4", true);
  b.soft("p2", 0.4, 0.6);
  b.test("dd", "Direct-detection run", "p1", 500, 0.9, 0.95, "A year of underground detector time.");
  b.test("recal", "Independent recalibration", "p3", 15, 0.95, 0.9, "A week of someone's time.");
  b.test("lens", "New lensing survey", "p4", 300, 0.95, 0.95);
  b.test("rot", "Rotation-curve catalogue", "p2", 40, 0.9, 0.85);
  b.target("h1");
  return b.done();
}

function multipleChoice() {
  const b = new Builder(
    "Multiple choice: exactly one answer is right",
    "Four options, exactly one correct. Partial knowledge and elimination clues interact — ruling out one option redistributes its probability over the rest."
  );
  b.guide(
    "Start by setting 'Option A has wrong units' to TRUE. A drops to zero and B, C, D each absorb a third of its mass.",
    "Then raise your recall of the lecture: the ↔ tie to option C sharpens fast.",
    "Compare the tests: the £25 derivation wins on bits-per-pound here, because eliminating one of four options barely moves option C. Cheap is not automatically efficient.",
    "This is how 'exactly one' differs from four independent propositions: information about one option is information about all of them."
  );
  b.prop("a", "Option A correct", 0.25);
  b.prop("bb", "Option B correct", 0.25);
  b.prop("c", "Option C correct", 0.25);
  b.prop("d", "Option D correct", 0.25);
  b.mutex("exactly-one", ["a", "bb", "c", "d"], "exactly one answer is correct");
  b.prop("ua", "Option A has wrong units", 0.4);
  b.prop("ub", "Option B has wrong units", 0.4);
  b.prop("sign", "Answer must be negative", 0.5);
  b.prop("recall", "I recall the lecture slide", 0.35);
  b.rule("ua", "a", { type: "implies-not", p: 1.0 });
  b.rule("ub", "bb", { type: "implies-not", p: 1.0 });
  b.rule("sign", "d", { type: "implies-not", p: 0.9 });
  b.rule("recall", "c", { p: 0.8 });
  b.test("dima", "Dimensional analysis on A", "ua", 1, 0.97, 0.97);
  b.test("dimb", "Dimensional analysis on B", "ub", 1, 0.97, 0.97);
  b.test("limit", "Check the limiting case", "sign", 3, 0.9, 0.9);
  b.test("derive", "Derive the answer in full", "c", 25, 0.99, 0.99);
  b.test("friend", "Ask a classmate", "c", 5, 0.7, 0.7);
  b.target("c");
  return b.done();
}

function interlock() {
  const b = new Builder(
    "Compound gates: a reactor interlock",
    "AND, OR, NOT and XOR nodes built from the gate factors. Two redundant sensors that disagree (XOR) are evidence of a sensor fault, which explains the alarm away."
  );
  b.guide(
    "The alarm is ringing and the two temperature sensors disagree — sensor A says hot, sensor B says cold.",
    "Watch 'Sensors disagree' (an XOR node) light up, pushing 'Sensor fault' up and 'Overheating' back down. That is explaining away.",
    "Set sensor B to TRUE so both agree: the fault hypothesis collapses and overheating takes the blame.",
    "'Overheating' is an AND node: it needs high temperature AND high pressure, so a single hot reading is not enough."
  );
  b.prop("temp", "Temperature high", 0.08);
  b.prop("pres", "Pressure high", 0.10);
  b.compound("over", "Overheating", "AND", ["temp", "pres"]);
  b.prop("sa", "Sensor A reads hot", 0.1);
  b.prop("sb", "Sensor B reads hot", 0.1);
  b.compound("dis", "Sensors disagree", "XOR", ["sa", "sb"]);
  b.prop("fault", "Sensor fault", 0.03);
  b.prop("alarm", "Interlock alarm", 0.05);
  b.prop("cool", "Coolant flow normal", 0.9);
  b.compound("nocool", "Coolant fault", "NOT", ["cool"]);
  b.rule("temp", "sa", { p: 0.92 });
  b.rule("temp", "sb", { p: 0.92 });
  b.rule("dis", "fault", { p: 0.75 });
  b.rule("over", "alarm", { p: 0.99 });
  b.rule("fault", "alarm", { p: 0.35 });
  b.rule("nocool", "temp", { p: 0.8 });
  b.evidence("alarm", true);
  b.evidence("sa", true);
  b.evidence("sb", false);
  b.test("thermo", "Independent thermocouple", "temp", 30, 0.97, 0.95);
  b.test("gauge", "Read the pressure gauge", "pres", 5, 0.95, 0.95);
  b.test("flow", "Coolant flow meter", "cool", 8, 0.95, 0.95);
  b.test("swap", "Swap sensor A", "fault", 60, 0.9, 0.9);
  b.target("over");
  return b.done();
}

function ruleLearning() {
  const b = new Builder(
    "Learning a rule: does the drug cause the rash?",
    "Six patients, one shared rule. Each instance of 'took the drug → developed a rash' either holds or is broken, and whether it holds is a Bernoulli draw from a shared reliability ρ with a Beta(1,1) prior."
  );
  b.guide(
    "Four patients who took the drug developed a rash, two did not. ρ̄ moves from 0.50 to about 0.58 — less than 4/6, because a rash is only weak evidence that the rule fired (the patient might have had a rash anyway) while a missing rash is decisive proof that it did not.",
    "Open the Parameters section to see the full posterior over ρ, not just its mean.",
    "Patient 7 took the drug and has not been examined. Their rash probability is ρ̄ + (1−ρ̄)·prior — the model has genuinely learned about the relationship, not just the facts.",
    "Flip one of the 'no rash' patients to TRUE and watch the entire ρ posterior shift."
  );
  b.param("rho", "ρ (rule reliability)", 1, 1, "Prior belief that 'drug → rash' holds for a given patient.");
  const outcomes = [true, true, true, true, false, false];
  outcomes.forEach((v, i) => {
    b.prop(`x${i}`, `Patient ${i + 1} took drug`, 0.5);
    b.prop(`r${i}`, `Patient ${i + 1} rash`, 0.1);
    b.evidence(`x${i}`, true);
    b.evidence(`r${i}`, v);
    b.rule(`x${i}`, `r${i}`, { param: "rho" });
  });
  b.prop("x6", "Patient 7 took drug", 0.5);
  b.prop("r6", "Patient 7 rash", 0.1);
  b.evidence("x6", true);
  b.rule("x6", "r6", { param: "rho" });
  b.test("exam", "Examine patient 7", "r6", 10, 0.98, 0.98);
  b.target("r6");
  return b.done();
}

function supplierBatch() {
  const b = new Builder(
    "Hierarchy: a new supplier's defect rate",
    "Ten components from an unknown supplier. Each is defective with an unknown rate θ drawn from Beta(1,1) — a distribution over a distribution. Inspecting components teaches us about θ, which in turn tells us about the components we have not inspected."
  );
  b.guide(
    "Two components are known defective and four known good. θ̄ settles at exactly 3/8 — the Beta(1,1) + 2 successes / 4 failures posterior mean — and every uninspected component inherits that number.",
    "This is the difference between a fixed prior and a hierarchical one: with a fixed 0.5 prior, inspecting C₁ would tell you nothing about C₇.",
    "Inspect more components from the Experiments panel and watch the θ posterior narrow.",
    "Look at the expected information gain: early inspections are worth far more than late ones, because θ is already pinned down by then."
  );
  b.param("theta", "θ (batch defect rate)", 1, 1, "Unknown fraction of defective components in this shipment.");
  for (let i = 0; i < 10; i++) {
    b.paramProp(`c${i}`, `Component ${i + 1} defective`, "theta");
    b.prop(`f${i}`, `Unit ${i + 1} fails burn-in`, 0.02);
    b.rule(`c${i}`, `f${i}`, { p: 0.9 });
  }
  b.evidence("c0", true);
  b.evidence("c1", true);
  b.evidence("c2", false);
  b.evidence("c3", false);
  b.evidence("c4", false);
  b.evidence("c5", false);
  for (let i = 6; i < 10; i++) b.test(`ins${i}`, `Inspect component ${i + 1}`, `c${i}`, 5, 0.96, 0.96);
  b.test("burn", "Burn-in test, unit 7", "f6", 2, 0.9, 0.9);
  b.target("c6");
  return b.done();
}

export const EXAMPLES = [
  { id: "warmup", title: "Warm-up: A ⟹ B ⟹ C", tag: "basics", build: warmUp },
  { id: "clinic", title: "Medical diagnosis", tag: "diagnosis", build: chestClinic },
  { id: "outage", title: "Fault analysis", tag: "diagnosis", build: outage },
  { id: "science", title: "Rival hypotheses", tag: "mutual exclusion", build: scienceDebate },
  { id: "mcq", title: "Multiple choice", tag: "mutual exclusion", build: multipleChoice },
  { id: "interlock", title: "Compound gates", tag: "compound nodes", build: interlock },
  { id: "rulelearn", title: "Learning a rule", tag: "hierarchical", build: ruleLearning },
  { id: "supplier", title: "Hierarchical base rate", tag: "hierarchical", build: supplierBatch },
];

export function buildExample(id) {
  const e = EXAMPLES.find((x) => x.id === id) || EXAMPLES[0];
  const m = e.build();
  m.exampleId = e.id;
  return m;
}
