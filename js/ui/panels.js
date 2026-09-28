// Left rail: the model editor.

import { h, mount } from "./dom.js";
import { meter, field, select, num, prob, text, button, segmented, chip, section, betaChart } from "./widgets.js";
import { EXAMPLES } from "../examples/index.js";
import { RULE_TYPES, CONSTRAINT_TYPES, OPS, ruleText, validateModel } from "../engine/model.js";
import { fmtNum, fmtPct } from "../engine/util.js";

export function renderEditor(root, state, actions) {
  const m = state.model;
  const issues = validateModel(m);
  mount(root,
    modelSection(state, actions, issues),
    examplesSection(state, actions),
    propositionsSection(state, actions),
    rulesSection(state, actions),
    constraintsSection(state, actions),
    paramsSection(state, actions),
    testsSection(state, actions),
    dataSection(state, actions));
  const sel = root.querySelector(".card.sel");
  if (sel && state.scrollToSelection) {
    sel.scrollIntoView({ block: "nearest" });
    state.scrollToSelection = false;
  }
}

// ---------------------------------------------------------------------------

function modelSection(state, actions, issues) {
  const m = state.model;
  const errs = issues.filter((i) => i.level === "error");
  const warns = issues.filter((i) => i.level === "warn").concat(
    (state.compiled?.warnings || []).map((t) => ({ level: "warn", text: t })));
  return section("Model", { open: true, id: "sec-model" },
    field("Name", text(m.name, (v) => actions.update((mm) => { mm.name = v; }))),
    h("p", { class: "desc" }, m.description || ""),
    field("Rule semantics",
      segmented(m.semantics || "causal", [
        { value: "causal", label: "Causal (noisy-OR)", hint: "Rules into a node merge into one conditional. Priors stay meaningful." },
        { value: "constraint", label: "Logical constraint", hint: "Each rule is its own potential: worlds that break it are down-weighted." },
      ], (v) => actions.update((mm) => { mm.semantics = v; })),
      m.semantics === "constraint"
        ? "Each rule down-weights the worlds that break it. Purely logical, but adding a rule shifts marginals even with no evidence."
        : "Rules pointing at the same node merge into one noisy-OR conditional, with that node's prior as the leak term."),
    m.guide && m.guide.length ? h("div", { class: "guide" },
      h("div", { class: "guide-title" }, "Things to try"),
      h("ol", {}, m.guide.map((g) => h("li", {}, g)))) : null,
    errs.length ? h("div", { class: "issues error" }, errs.map((i) => h("div", {}, "⚠ " + i.text))) : null,
    warns.length ? h("div", { class: "issues warn" }, warns.map((i) => h("div", {}, "· " + i.text))) : null);
}

function examplesSection(state, actions) {
  return section("Examples", { open: !state.model.exampleId ? true : state.openExamples !== false, id: "sec-examples" },
    h("div", { class: "examples" },
      EXAMPLES.map((e) => h("button", {
        type: "button",
        class: "example" + (state.model.exampleId === e.id ? " on" : ""),
        onclick: () => actions.loadExample(e.id),
      }, h("span", { class: "ex-title" }, e.title), h("span", { class: "ex-tag" }, e.tag)))));
}

// ---------------------------------------------------------------------------

function propositionsSection(state, actions) {
  const m = state.model;
  const view = state.view;
  return section(`Propositions (${m.nodes.length})`, {
    id: "sec-nodes",
    actions: h("span", { class: "sec-actions" },
      button("+ proposition", (e) => { e.stopPropagation(); actions.addNode(false); }, { class: "mini" }),
      button("+ compound", (e) => { e.stopPropagation(); actions.addNode(true); }, { class: "mini" })),
  },
    h("div", { class: "cards" }, m.nodes.map((n) => nodeCard(n, state, actions, view))));
}

function nodeCard(n, state, actions, view) {
  const selected = state.selection?.type === "node" && state.selection.id === n.id;
  const info = view?.nodes.get(n.id);
  const upd = (fn) => actions.update((mm) => fn(mm.nodes.find((x) => x.id === n.id)));
  const others = state.model.nodes.filter((x) => x.id !== n.id);

  const header = h("div", { class: "card-head", onclick: () => actions.select(selected ? null : { type: "node", id: n.id }) },
    h("span", { class: "card-title" }, n.label),
    n.kind === "compound" ? chip(n.op) : null,
    n.evidence ? chip(n.evidence.type === "hard" ? (n.evidence.value ? "TRUE" : "FALSE") : "soft", "obs") : null,
    info ? h("span", { class: "card-p" }, fmtPct(info.p, 1)) : null);

  if (!selected) {
    return h("div", { class: "card", dataset: { id: n.id } }, header,
      info ? meter(info.p, { compact: true, showValue: false }) : null);
  }

  const priorType = n.kind === "compound" ? "derived" : (n.prior ? n.prior.type : "none");
  const ev = n.evidence;
  const evMode = !ev ? "unknown" : ev.type === "soft" ? "soft" : ev.value ? "true" : "false";

  return h("div", { class: "card sel", dataset: { id: n.id } }, header,
    h("div", { class: "card-body" },
      field("Label", text(n.label, (v) => upd((x) => { x.label = v; }))),
      n.kind === "compound"
        ? h("div", {},
            field("Operator", segmented(n.op, OPS.map((o) => ({ value: o, label: o })), (v) => upd((x) => { x.op = v; }))),
            field("Inputs", h("div", { class: "checklist" }, others.map((o) =>
              h("label", { class: "check" },
                h("input", {
                  type: "checkbox", checked: n.inputs.includes(o.id),
                  onchange: (e) => upd((x) => {
                    x.inputs = e.target.checked ? [...x.inputs, o.id] : x.inputs.filter((i) => i !== o.id);
                  }),
                }), o.label)))),
            h("p", { class: "note" }, "A compound node is deterministic: its value is fixed by its inputs through the gate factor."))
        : priorControls(n, state, actions, priorType, upd),
      field("Evidence", segmented(evMode, [
        { value: "unknown", label: "unknown" },
        { value: "true", label: "TRUE" },
        { value: "false", label: "FALSE" },
        { value: "soft", label: "soft" },
      ], (v) => upd((x) => {
        x.evidence = v === "unknown" ? null
          : v === "soft" ? { type: "soft", l0: 0.3, l1: 0.7 }
          : { type: "hard", value: v === "true" };
      }))),
      evMode === "soft" ? h("div", { class: "row2" },
        field("P(obs | false)", num(ev.l0, (v) => upd((x) => { x.evidence.l0 = v; }), { min: 0, max: 1, step: 0.05 })),
        field("P(obs | true)", num(ev.l1, (v) => upd((x) => { x.evidence.l1 = v; }), { min: 0, max: 1, step: 0.05 })),
        h("p", { class: "note" }, `Likelihood ratio ${fmtNum(ev.l1 / Math.max(ev.l0, 1e-9), 2)} : 1 in favour of TRUE.`)) : null,
      field("Note", text(n.note || "", (v) => upd((x) => { x.note = v; }), { placeholder: "optional" })),
      h("div", { class: "card-foot" },
        button("Delete", () => actions.deleteNode(n.id), { class: "danger mini" }),
        button("Make target", () => actions.update((mm) => { mm.target = n.id; }), { class: "mini" }))));
}

function priorControls(n, state, actions, priorType, upd) {
  const params = state.model.params;
  const pv = state.view?.params.find((p) => p.ownerNode === n.id || (n.prior?.type === "param" && p.paramId === n.prior.paramId));
  return h("div", {},
    field("Prior", segmented(priorType, [
      { value: "bernoulli", label: "fixed", hint: "A single number." },
      { value: "beta", label: "Beta", hint: "A distribution over the probability — learned from evidence." },
      { value: "param", label: "shared", hint: "Draw from a Beta parameter shared with other propositions." },
      { value: "none", label: "uniform", hint: "No prior factor at all." },
    ], (v) => upd((x) => {
      if (v === "bernoulli") x.prior = { type: "bernoulli", p: 0.5 };
      else if (v === "beta") x.prior = { type: "beta", a: 2, b: 2, bins: 21 };
      else if (v === "param") x.prior = { type: "param", paramId: params[0]?.id ?? null };
      else x.prior = null;
    }))),
    priorType === "bernoulli" ? field("P(true)", prob(n.prior.p, (v) => upd((x) => { x.prior.p = v; }))) : null,
    priorType === "beta" ? h("div", {},
      h("div", { class: "row2" },
        field("α", num(n.prior.a, (v) => upd((x) => { x.prior.a = Math.max(v, 0.05); }), { min: 0.05, step: 0.5 })),
        field("β", num(n.prior.b, (v) => upd((x) => { x.prior.b = Math.max(v, 0.05); }), { min: 0.05, step: 0.5 }))),
      pv ? betaChart(pv.values, pv.posterior, pv.prior, { mean: pv.mean, height: 56 }) : null,
      pv ? h("p", { class: "note" }, `prior mean ${fmtNum(pv.priorMean, 3)} → posterior mean ${fmtNum(pv.mean, 3)} (sd ${fmtNum(pv.std, 3)})`) : null) : null,
    priorType === "param" ? (params.length
      ? field("Parameter", select(n.prior.paramId, params.map((p) => ({ value: p.id, label: p.label })), (v) => upd((x) => { x.prior.paramId = v; })))
      : h("p", { class: "note warn" }, "No shared parameters defined yet — add one in the Parameters section.")) : null);
}

// ---------------------------------------------------------------------------

function rulesSection(state, actions) {
  const m = state.model;
  return section(`Rules (${m.rules.length})`, {
    id: "sec-rules",
    actions: button("+ rule", (e) => { e.stopPropagation(); actions.addRule(); }, { class: "mini" }),
  }, h("div", { class: "cards" }, m.rules.map((r) => ruleCard(r, state, actions))));
}

function ruleCard(r, state, actions) {
  const m = state.model;
  const selected = state.selection?.type === "rule" && state.selection.id === r.id;
  const upd = (fn) => actions.update((mm) => fn(mm.rules.find((x) => x.id === r.id)));
  const relInfo = state.view?.rules.get(r.id);
  const pv = state.view?.params.find((p) => p.ownerRule === r.id || (r.rel?.type === "param" && p.paramId === r.rel.paramId));

  const header = h("div", { class: "card-head", onclick: () => actions.select(selected ? null : { type: "rule", id: r.id }) },
    h("span", { class: "card-title mono" }, ruleText(m, r)),
    r.rel.type === "fixed"
      ? (r.rel.p < 0.999 ? chip(fmtPct(r.rel.p, 0)) : chip("hard"))
      : chip(relInfo ? `holds ${fmtPct(relInfo.p, 0)}` : "uncertain", "learn"));

  if (!selected) return h("div", { class: "card", dataset: { id: r.id } }, header);

  const relType = r.rel.type;
  return h("div", { class: "card sel", dataset: { id: r.id } }, header,
    h("div", { class: "card-body" },
      field("Antecedents", h("div", { class: "checklist" }, m.nodes.map((o) =>
        h("label", { class: "check" },
          h("input", {
            type: "checkbox", checked: r.ants.includes(o.id),
            onchange: (e) => upd((x) => { x.ants = e.target.checked ? [...x.ants, o.id] : x.ants.filter((i) => i !== o.id); }),
          }), o.label)))),
      r.ants.length > 1 ? field("Combine antecedents with",
        segmented(r.antOp, [{ value: "AND", label: "AND ∧" }, { value: "OR", label: "OR ∨" }], (v) => upd((x) => { x.antOp = v; }))) : null,
      field("Relation", segmented(r.type, RULE_TYPES.map((t) => ({ value: t.id, label: `${t.glyph} ${t.label}`, hint: t.hint })), (v) => upd((x) => { x.type = v; }))),
      field("Consequent", select(r.cons, m.nodes.map((o) => ({ value: o.id, label: o.label })), (v) => upd((x) => { x.cons = v; }))),
      field(state.model.semantics === "constraint" ? "Reliability" : "Causal strength",
        segmented(relType, [
          { value: "fixed", label: "known", hint: "A fixed number you supply." },
          { value: "beta", label: "learn (Beta)", hint: "Treat the rule's validity as unknown and infer it." },
          { value: "param", label: "shared", hint: "Share one reliability across several rules." },
        ], (v) => upd((x) => {
          if (v === "fixed") x.rel = { type: "fixed", p: 0.9 };
          else if (v === "beta") x.rel = { type: "beta", a: 1, b: 1, bins: 21 };
          else x.rel = { type: "param", paramId: m.params[0]?.id ?? null };
        })),
        state.model.semantics === "constraint"
          ? "p is the weight removed from worlds that break the rule. p = 1 is a hard logical constraint."
          : "p = P(consequent | this antecedent alone). p = 1 gives exact modus ponens and modus tollens."),
      relType === "fixed" ? field("p", prob(r.rel.p, (v) => upd((x) => { x.rel.p = v; }))) : null,
      relType === "beta" ? h("div", {},
        h("div", { class: "row2" },
          field("α", num(r.rel.a, (v) => upd((x) => { x.rel.a = Math.max(v, 0.05); }), { min: 0.05, step: 0.5 })),
          field("β", num(r.rel.b, (v) => upd((x) => { x.rel.b = Math.max(v, 0.05); }), { min: 0.05, step: 0.5 }))),
        pv ? betaChart(pv.values, pv.posterior, pv.prior, { mean: pv.mean, height: 56 }) : null,
        pv ? h("p", { class: "note" }, `ρ prior mean ${fmtNum(pv.priorMean, 3)} → posterior mean ${fmtNum(pv.mean, 3)}`) : null,
        h("p", { class: "note" }, "An extra binary variable records whether this rule holds for this instance; its prior is the Beta parameter.")) : null,
      relType === "param" ? (m.params.length
        ? field("Parameter", select(r.rel.paramId, m.params.map((p) => ({ value: p.id, label: p.label })), (v) => upd((x) => { x.rel.paramId = v; })))
        : h("p", { class: "note warn" }, "No shared parameters defined yet.")) : null,
      relInfo ? h("p", { class: "note" }, `P(this rule holds | evidence) = ${fmtPct(relInfo.p, 1)}`) : null,
      h("div", { class: "card-foot" }, button("Delete", () => actions.deleteRule(r.id), { class: "danger mini" }))));
}

// ---------------------------------------------------------------------------

function constraintsSection(state, actions) {
  const m = state.model;
  return section(`Mutual exclusion (${m.constraints.length})`, {
    id: "sec-constraints",
    actions: button("+ constraint", (e) => { e.stopPropagation(); actions.addConstraint(); }, { class: "mini" }),
    note: "Groups where the options compete: raising one necessarily lowers the others.",
  }, h("div", { class: "cards" }, m.constraints.map((c) => {
    const selected = state.selection?.type === "constraint" && state.selection.id === c.id;
    const upd = (fn) => actions.update((mm) => fn(mm.constraints.find((x) => x.id === c.id)));
    const label = CONSTRAINT_TYPES.find((t) => t.id === c.type)?.label;
    const header = h("div", { class: "card-head", onclick: () => actions.select(selected ? null : { type: "constraint", id: c.id }) },
      h("span", { class: "card-title" }, c.label || label),
      chip(`${c.members.length} members`));
    if (!selected) return h("div", { class: "card", dataset: { id: c.id } }, header,
      h("div", { class: "card-sub mono" }, c.members.map((id) => m.nodes.find((n) => n.id === id)?.label).join(", ")));
    return h("div", { class: "card sel", dataset: { id: c.id } }, header,
      h("div", { class: "card-body" },
        field("Label", text(c.label || "", (v) => upd((x) => { x.label = v; }), { placeholder: label })),
        field("Type", segmented(c.type, CONSTRAINT_TYPES.map((t) => ({ value: t.id, label: `${t.glyph} ${t.label}` })), (v) => upd((x) => { x.type = v; }))),
        field("Members", h("div", { class: "checklist" }, m.nodes.map((o) =>
          h("label", { class: "check" },
            h("input", {
              type: "checkbox", checked: c.members.includes(o.id),
              onchange: (e) => upd((x) => { x.members = e.target.checked ? [...x.members, o.id] : x.members.filter((i) => i !== o.id); }),
            }), o.label)))),
        h("div", { class: "card-foot" }, button("Delete", () => actions.deleteConstraint(c.id), { class: "danger mini" }))));
  })));
}

function paramsSection(state, actions) {
  const m = state.model;
  return section(`Parameters (${m.params.length})`, {
    id: "sec-params",
    actions: button("+ parameter", (e) => { e.stopPropagation(); actions.addParam(); }, { class: "mini" }),
    note: "Beta-distributed quantities shared across propositions or rules — a distribution over a distribution.",
  }, h("div", { class: "cards" }, m.params.map((p) => {
    const selected = state.selection?.type === "param" && state.selection.id === p.id;
    const upd = (fn) => actions.update((mm) => fn(mm.params.find((x) => x.id === p.id)));
    const pv = state.view?.params.find((v) => v.paramId === p.id);
    const header = h("div", { class: "card-head", onclick: () => actions.select(selected ? null : { type: "param", id: p.id }) },
      h("span", { class: "card-title" }, p.label),
      chip(`Beta(${p.a}, ${p.b})`),
      pv ? h("span", { class: "card-p" }, fmtNum(pv.mean, 3)) : null);
    if (!selected) return h("div", { class: "card", dataset: { id: p.id } }, header,
      pv ? betaChart(pv.values, pv.posterior, pv.prior, { mean: pv.mean, height: 40 }) : null);
    return h("div", { class: "card sel", dataset: { id: p.id } }, header,
      h("div", { class: "card-body" },
        field("Label", text(p.label, (v) => upd((x) => { x.label = v; }))),
        h("div", { class: "row3" },
          field("α", num(p.a, (v) => upd((x) => { x.a = Math.max(v, 0.05); }), { min: 0.05, step: 0.5 })),
          field("β", num(p.b, (v) => upd((x) => { x.b = Math.max(v, 0.05); }), { min: 0.05, step: 0.5 })),
          field("grid", num(p.bins, (v) => upd((x) => { x.bins = Math.max(3, Math.min(101, Math.round(v))); }), { min: 3, max: 101, step: 2 }))),
        pv ? betaChart(pv.values, pv.posterior, pv.prior, { mean: pv.mean, height: 64 }) : null,
        pv ? h("p", { class: "note" }, `prior mean ${fmtNum(pv.priorMean, 3)} → posterior mean ${fmtNum(pv.mean, 3)} (sd ${fmtNum(pv.std, 3)}). Faint bars are the prior.`) : null,
        field("Note", text(p.note || "", (v) => upd((x) => { x.note = v; }))),
        h("div", { class: "card-foot" }, button("Delete", () => actions.deleteParam(p.id), { class: "danger mini" }))));
  })));
}

// ---------------------------------------------------------------------------

function testsSection(state, actions) {
  const m = state.model;
  return section(`Available experiments (${m.tests.length})`, {
    id: "sec-tests", open: false,
    actions: button("+ experiment", (e) => { e.stopPropagation(); actions.addTest(); }, { class: "mini" }),
    note: "Evidence you could buy. Scored by expected information gain in the Experiments panel.",
  }, h("div", { class: "cards" }, m.tests.map((t) => {
    const selected = state.selection?.type === "test" && state.selection.id === t.id;
    const upd = (fn) => actions.update((mm) => fn(mm.tests.find((x) => x.id === t.id)));
    const targetLabel = m.nodes.find((n) => n.id === t.target)?.label ?? "?";
    const header = h("div", { class: "card-head", onclick: () => actions.select(selected ? null : { type: "test", id: t.id }) },
      h("span", { class: "card-title" }, t.label),
      chip("£" + t.cost),
      t.performed !== null && t.performed !== undefined ? chip(t.outcomes[t.performed]?.name ?? "done", "obs") : null);
    if (!selected) return h("div", { class: "card", dataset: { id: t.id } }, header,
      h("div", { class: "card-sub" }, "observes " + targetLabel));
    return h("div", { class: "card sel", dataset: { id: t.id } }, header,
      h("div", { class: "card-body" },
        field("Label", text(t.label, (v) => upd((x) => { x.label = v; }))),
        h("div", { class: "row2" },
          field("Observes", select(t.target, m.nodes.map((o) => ({ value: o.id, label: o.label })), (v) => upd((x) => { x.target = v; }))),
          field("Cost", num(t.cost, (v) => upd((x) => { x.cost = Math.max(0, v); }), { min: 0, step: 1 }))),
        h("table", { class: "outcomes" },
          h("thead", {}, h("tr", {}, h("th", {}, "outcome"), h("th", {}, "P(o | false)"), h("th", {}, "P(o | true)"), h("th", {}))),
          h("tbody", {}, t.outcomes.map((o, i) => h("tr", {},
            h("td", {}, text(o.name, (v) => upd((x) => { x.outcomes[i].name = v; }), { class: "tiny" })),
            h("td", {}, num(o.l0, (v) => upd((x) => { x.outcomes[i].l0 = v; }), { min: 0, max: 1, step: 0.05, class: "tiny" })),
            h("td", {}, num(o.l1, (v) => upd((x) => { x.outcomes[i].l1 = v; }), { min: 0, max: 1, step: 0.05, class: "tiny" })),
            h("td", {}, t.outcomes.length > 2 ? button("×", () => upd((x) => { x.outcomes.splice(i, 1); }), { class: "mini danger" }) : null))))),
        button("+ outcome", () => upd((x) => { x.outcomes.push({ name: "outcome", l0: 0.5, l1: 0.5 }); }), { class: "mini" }),
        field("Result", select(t.performed === null || t.performed === undefined ? "" : String(t.performed),
          [{ value: "", label: "not performed" }, ...t.outcomes.map((o, i) => ({ value: String(i), label: o.name }))],
          (v) => upd((x) => { x.performed = v === "" ? null : parseInt(v, 10); }))),
        field("Note", text(t.note || "", (v) => upd((x) => { x.note = v; }))),
        h("div", { class: "card-foot" }, button("Delete", () => actions.deleteTest(t.id), { class: "danger mini" }))));
  })));
}

function dataSection(state, actions) {
  return section("Save & load", { open: false, id: "sec-data" },
    h("div", { class: "btn-row" },
      button("Export JSON", actions.exportModel, { class: "mini" }),
      button("Import JSON", actions.importModel, { class: "mini" }),
      button("Copy link", actions.copyLink, { class: "mini" }),
      button("Clear evidence", actions.clearEvidence, { class: "mini" }),
      button("Blank model", actions.blankModel, { class: "mini danger" })),
    h("p", { class: "note" }, "Everything runs in the browser; nothing is sent anywhere. “Copy link” puts the whole model in the URL."));
}
