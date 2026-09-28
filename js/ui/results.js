// Right rail: beliefs, explanation, experiments and engine diagnostics.

import { h, mount } from "./dom.js";
import { meter, field, select, num, button, segmented, chip, sparkline, divergingBars, betaChart } from "./widgets.js";
import { fmtPct, fmtNum, logOdds } from "../engine/util.js";
import { incomingMessages } from "../engine/bp.js";
import { ENGINES } from "../engine/infer.js";
import { SYMBOL } from "../engine/factors.js";

export const TABS = [
  { id: "beliefs", label: "Beliefs" },
  { id: "explain", label: "Explain" },
  { id: "voi", label: "Experiments" },
  { id: "engines", label: "Engines" },
];

export function renderResults(root, state, actions) {
  const body = {
    beliefs: beliefsTab,
    explain: explainTab,
    voi: voiTab,
    engines: enginesTab,
  }[state.tab] || beliefsTab;
  mount(root,
    h("div", { class: "tabs", role: "tablist" }, TABS.map((t) => h("button", {
      type: "button", class: "tab" + (state.tab === t.id ? " on" : ""), role: "tab",
      "aria-selected": String(state.tab === t.id),
      onclick: () => actions.setTab(t.id),
    }, t.label))),
    h("div", { class: "tab-body" }, body(state, actions)));
}

// ---------------------------------------------------------------------------

function beliefsTab(state, actions) {
  const { model, view, compiled, result } = state;
  const rows = model.nodes.map((n) => ({ n, info: view.nodes.get(n.id) })).filter((r) => r.info);
  if (state.sortBeliefs === "p") rows.sort((a, b) => b.info.p - a.info.p);
  const aux = compiled.vars.map((v, i) => ({ v, i })).filter((x) => x.v.kind === "aux");
  const rules = [...view.rules.entries()];

  return h("div", {},
    h("div", { class: "toolbar" },
      h("span", { class: "muted small" }, `total uncertainty ${fmtNum(view.totalEntropy, 2)} bits`),
      segmented(state.sortBeliefs || "model", [
        { value: "model", label: "model order" },
        { value: "p", label: "by probability" },
      ], (v) => actions.set({ sortBeliefs: v }))),
    result.inconsistent ? h("div", { class: "issues error" }, "⚠ " + result.note) : null,
    h("div", { class: "belief-list" }, rows.map(({ n, info }) => beliefRow(n, info, state, actions))),
    aux.length ? h("div", { class: "subgroup" },
      h("h4", {}, "Derived antecedents"),
      aux.map(({ v, i }) => h("div", { class: "belief-row" },
        h("span", { class: "belief-name mono", title: v.label }, v.label),
        meter(result.beliefs[i][1], { compact: true })))) : null,
    rules.length ? h("div", { class: "subgroup" },
      h("h4", {}, "Do the rules hold?"),
      h("p", { class: "note" }, "Rules whose reliability is being inferred. These are the model's beliefs about its own relationships."),
      rules.map(([ruleId, info]) => {
        const r = model.rules.find((x) => x.id === ruleId);
        const name = (r && r.label) || compiled.vars[info.varIndex].label.replace(/^holds: /, "");
        return h("div", { class: "belief-row clickable", onclick: () => actions.select({ type: "rule", id: ruleId }) },
          h("span", { class: "belief-name mono", title: name }, name),
          meter(info.p, { compact: true }));
      })) : null,
    view.params.length ? h("div", { class: "subgroup" },
      h("h4", {}, "Parameters"),
      view.params.map((p) => h("div", { class: "param-row" },
        h("div", { class: "param-head" },
          h("span", { class: "belief-name" }, p.label),
          h("span", { class: "mono" }, `mean ${fmtNum(p.mean, 3)} ± ${fmtNum(p.std, 3)}`)),
        betaChart(p.values, p.posterior, p.prior, { mean: p.mean, height: 48, ariaLabel: `${p.label} posterior` })))) : null);
}

function beliefRow(n, info, state, actions) {
  const selected = state.selection?.type === "node" && state.selection.id === n.id;
  const isTarget = state.model.target === n.id;
  return h("div", {
    class: "belief-row clickable" + (selected ? " sel" : ""),
    onclick: () => actions.select({ type: "node", id: n.id }),
  },
    h("span", { class: "belief-name", title: n.note || n.label }, n.label,
      isTarget ? h("span", { class: "target-dot", title: "query target" }, "◆") : null,
      n.evidence ? h("span", { class: "obs-mark", title: "observed" },
        n.evidence.type === "hard" ? (n.evidence.value ? "✓" : "✗") : "~") : null),
    meter(info.p, { compact: true, sub: info.stderr ? "±" + fmtPct(1.96 * info.stderr, 1) : null }));
}

// ---------------------------------------------------------------------------

function explainTab(state, actions) {
  const { model, compiled, bpResult, view } = state;
  const sel = state.selection?.type === "node" ? state.selection.id : model.target;
  const node = model.nodes.find((n) => n.id === sel);
  if (!node) return h("p", { class: "note" }, "Select a proposition in the graph to see why it believes what it believes.");
  const vi = compiled.nodeVar.get(node.id);
  const info = view.nodes.get(node.id);
  const msgs = incomingMessages(compiled, bpResult, vi);

  const rows = msgs.map(({ factor, message }) => {
    const l = (logOdds(message[1]) - 0) / Math.LN2;
    const others = factor.vars.filter((u) => u !== vi).map((u) => compiled.vars[u].label);
    return {
      name: shortFactorName(factor, compiled, vi),
      value: l,
      title: `${factor.label}${others.length ? " · with " + others.join(", ") : ""}`,
      factor,
    };
  }).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

  const totalBits = rows.reduce((s, r) => s + r.value, 0);
  const voiRows = (state.voiRowsForSelection || []).slice(0, 3);

  return h("div", {},
    h("div", { class: "explain-head" },
      h("h3", {}, node.label),
      node.note ? h("p", { class: "note" }, node.note) : null,
      meter(info.p, { label: "P(true)", digits: 2 }),
      h("p", { class: "note" }, `marginal entropy ${fmtNum(info.entropy, 3)} bits of a possible 1.000`)),
    h("h4", {}, "Where the belief comes from"),
    h("p", { class: "note" },
      "Belief is the product of the messages arriving from each neighbouring factor, so in log-odds it is a plain sum. ",
      "Each bar is one factor's contribution, in bits of evidence: blue pushes towards TRUE, red towards FALSE."),
    divergingBars(rows),
    state.model.semantics === "causal" && rows.some((r) => r.factor.meta && r.factor.meta.cpt && r.factor.vars[0] === vi)
      ? h("p", { class: "note" }, "In causal mode this node's own prior is the leak term inside its conditional, so it does not appear as a separate bar.")
      : null,
    h("p", { class: "note mono" },
      `Σ = ${totalBits >= 0 ? "+" : "−"}${Math.abs(totalBits).toFixed(2)} bits  ⟹  P = ${fmtPct(info.p, 2)}`),
    state.settings.engine !== "bp"
      ? h("p", { class: "note warn" }, "This decomposition always comes from belief propagation, even when the displayed marginals come from another engine.")
      : null,
    h("h4", {}, "What would move it most"),
    voiRows.length
      ? h("table", { class: "grid" },
          h("thead", {}, h("tr", {}, h("th", {}, "experiment"), h("th", {}, "EIG"), h("th", {}, "cost"), h("th", {}, "bits/£"))),
          h("tbody", {}, voiRows.map((r) => h("tr", {},
            h("td", {}, r.label),
            h("td", { class: "num" }, fmtNum(r.eig, 3)),
            h("td", { class: "num" }, String(r.cost)),
            h("td", { class: "num" }, isFinite(r.efficiency) ? fmtNum(r.efficiency, 3) : "∞")))))
      : h("p", { class: "note" }, "No unperformed experiments target this question."));
}

/** Name a factor from the point of view of the variable it is sending to. */
function shortFactorName(factor, compiled, vi) {
  const label = (u) => compiled.vars[u].label;
  const others = factor.vars.filter((u) => u !== vi);
  if (factor.kind === "PRIOR") return `prior ${factor.label}`;
  if (factor.kind === "EVIDENCE") return `evidence: ${factor.label}`;
  if (factor.kind === "THETA_PRIOR") return "Beta prior";
  if (factor.kind === "PARAM_LINK") return factor.vars[0] === vi ? `draws: ${label(factor.vars[1])}` : `parameter ${label(factor.vars[0])}`;
  if (factor.meta && factor.meta.cpt) {
    if (factor.vars[0] === vi) return others.length ? `its causes: ${others.map(label).join(", ")}` : "its own prior (leak)";
    return `effect: ${label(factor.vars[0])}`;
  }
  const glyph = SYMBOL[factor.kind] || "f";
  const gate = ["AND", "OR", "NOT", "XOR"].includes(factor.kind);
  if (gate) return factor.vars[0] === vi ? `${glyph} of ${others.map(label).join(", ")}` : `gate ${glyph} → ${label(factor.vars[0])}`;
  if (["IMPLIES", "IMPLIES_NOT", "IFF", "IMPLIES_G", "IMPLIES_NOT_G", "IFF_G"].includes(factor.kind))
    return factor.vars[0] === vi ? `rule ${glyph} ${label(factor.vars[1])}` : `rule ${label(factor.vars[0])} ${glyph}`;
  if (others.length <= 3) return `${glyph} ${others.map(label).join(", ")}`;
  return `${glyph} ${others.slice(0, 2).map(label).join(", ")} +${others.length - 2}`;
}

// ---------------------------------------------------------------------------

function voiTab(state, actions) {
  const { model, view } = state;
  const targetNode = model.nodes.find((n) => n.id === model.target);
  const rows = state.voiRows || [];
  const performed = model.tests.filter((t) => t.performed !== null && t.performed !== undefined);
  const spent = performed.reduce((s, t) => s + (t.cost || 0), 0);
  const maxEig = Math.max(1e-9, ...rows.map((r) => r.eig));
  // Loopy BP can return a whisper of negative mutual information; say so rather
  // than printing "-2.7e-6 bits" as if it meant something.
  const tiny = (x) => Math.abs(x) < 5e-4;
  const bits = (x) => (tiny(x) ? "≈0" : fmtNum(x, 3)) + " bits";
  const perCost = (r) => tiny(r.eig) ? "≈0 bits/£" : (isFinite(r.efficiency) ? fmtNum(r.efficiency, 3) : "∞") + " bits/£";
  const anyNegative = rows.some((r) => r.eig < -1e-9 && !tiny(r.eig));

  return h("div", {},
    h("div", { class: "stack" },
      field("Question", select(model.target || "", model.nodes.map((n) => ({ value: n.id, label: n.label })),
        (v) => actions.update((mm) => { mm.target = v; }))),
      field("Reduce the uncertainty in", segmented(state.voiObjective || "target", [
        { value: "target", label: "this question", hint: "Entropy of the selected node." },
        { value: "total", label: "every proposition", hint: "Summed marginal entropy over all propositions." },
      ], (v) => actions.set({ voiObjective: v }, true)))),
    targetNode ? h("p", { class: "note" },
      `Now: P(${targetNode.label}) = ${fmtPct(view.nodes.get(targetNode.id)?.p ?? 0, 1)}, `,
      `${fmtNum(state.voiObjective === "total" ? view.totalEntropy : (view.nodes.get(targetNode.id)?.entropy ?? 0), 3)} bits of uncertainty. `,
      `Spent so far: £${spent}.`) : null,

    rows.length
      ? h("div", { class: "voi-list" }, rows.map((r) => h("div", { class: "voi-card" },
          h("div", { class: "voi-top" },
            h("span", { class: "voi-name" }, r.label),
            chip("£" + r.cost),
            h("span", { class: "voi-eff mono", title: "Expected bits gained per unit of cost" }, perCost(r))),
          h("div", { class: "voi-gain" },
            h("span", { class: "eig-bar" },
              h("span", { class: "eig-fill", style: { width: (100 * Math.max(0, r.eig) / maxEig) + "%" } })),
            h("span", { class: "eig-val mono" }, bits(r.eig))),
          h("div", { class: "voi-outcomes" },
            r.outcomes.map((o, i) => o.prob > 1e-9
              ? h("button", {
                  type: "button", class: "mini outcome",
                  title: `Record this result. P(${targetNode?.label}) would become ${fmtPct(o.posterior, 1)}.`,
                  onclick: () => actions.performTest(r.testId, i),
                }, `${o.name} ${fmtPct(o.prob, 0)} → ${fmtPct(o.posterior, 0)}`)
              : null),
            button("run & sample", () => actions.performTest(r.testId, null), { class: "mini run",
              title: "Perform it and draw an outcome from the predictive distribution" })))))
      : h("p", { class: "note" }, "No experiments left to run. Add some in the editor."),
    anyNegative ? h("p", { class: "note warn" },
      "Some gains came out negative. Expected information gain is a mutual information and cannot really be below zero — this is loopy BP's approximation error. Switch to the exact engine to see the true values.") : null,

    h("h4", {}, "Automatic plan"),
    h("p", { class: "note" }, "Greedily buy the best-scoring experiment, sample its result, repeat. This is the active-reasoning loop."),
    h("div", { class: "toolbar wrap" },
      field("Budget £", num(state.planBudget ?? 50, (v) => actions.set({ planBudget: v }), { min: 0, step: 5, class: "tiny" })),
      field("Rank by", segmented(state.planScore || "efficiency", [
        { value: "efficiency", label: "bits/£" }, { value: "eig", label: "bits" },
      ], (v) => actions.set({ planScore: v })))),
    h("div", { class: "btn-row pad" },
      button("Simulate plan", actions.simulatePlan, { class: "primary mini" }),
      state.plan ? button("Apply to model", actions.applyPlan, { class: "mini" }) : null,
      state.plan ? button("Discard", () => actions.set({ plan: null }), { class: "mini" }) : null),
    state.plan ? planTable(state.plan, targetNode) : null,

    performed.length ? h("div", { class: "subgroup" },
      h("h4", {}, `Results already in (£${spent})`),
      performed.map((t) => h("div", { class: "belief-row done" },
        h("span", { class: "belief-name" }, t.label, ": ", h("strong", {}, t.outcomes[t.performed].name)),
        button("undo", () => actions.update((mm) => { mm.tests.find((x) => x.id === t.id).performed = null; }), { class: "mini" })))) : null);
}

function planTable(plan, targetNode) {
  if (!plan.steps.length) return h("p", { class: "note warn" }, "Nothing was worth buying: every experiment is either unaffordable or uninformative.");
  return h("table", { class: "grid" },
    h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "experiment"), h("th", {}, "result"),
      h("th", { class: "num" }, "P before"), h("th", { class: "num" }, "P after"), h("th", { class: "num" }, "£"))),
    h("tbody", {}, plan.steps.map((s, i) => h("tr", {},
      h("td", { class: "num" }, String(i + 1)),
      h("td", {}, s.label),
      h("td", {}, s.outcome),
      h("td", { class: "num" }, fmtPct(s.before, 1)),
      h("td", { class: "num" }, fmtPct(s.after, 1)),
      h("td", { class: "num" }, String(s.cost))))),
    h("tfoot", {}, h("tr", {},
      h("td", { colspan: 5 }, `entropy ${fmtNum(plan.steps[0].entropyBefore, 3)} → ${fmtNum(plan.steps.at(-1).entropyAfter, 3)} bits`),
      h("td", { class: "num" }, String(plan.spent)))));
}

// ---------------------------------------------------------------------------

function enginesTab(state, actions) {
  const { settings, result, compiled } = state;
  const bp = settings.bp, gb = settings.gibbs;
  const engine = settings.engine;
  const cmp = state.comparison;

  return h("div", {},
    field("Engine", segmented(engine, ENGINES.map((e) => ({ value: e.id, label: e.label.split(" ")[0], hint: e.hint })),
      (v) => actions.setEngine(v)), ENGINES.find((e) => e.id === engine)?.hint),

    h("div", { class: "statline" },
      chip(`${compiled.vars.length} variables`),
      chip(`${compiled.factors.length} factors`),
      chip(`${result.ms?.toFixed(1) ?? "?"} ms`),
      result.converged ? chip("converged", "good") : chip("not converged", "bad"),
      result.inconsistent ? chip("inconsistent", "bad") : null),
    result.note ? h("p", { class: "note warn" }, result.note) : null,

    engine === "bp" ? h("div", {},
      h("h4", {}, "Belief propagation"),
      h("div", { class: "row3" },
        field("max iterations", num(bp.maxIters, (v) => actions.setEngineOpt("bp", "maxIters", Math.max(1, Math.round(v))), { min: 1, step: 50 })),
        field("damping", num(bp.damping, (v) => actions.setEngineOpt("bp", "damping", Math.min(0.95, Math.max(0, v))), { min: 0, max: 0.95, step: 0.05 })),
        field("schedule", select(bp.schedule, [{ value: "sequential", label: "sequential" }, { value: "parallel", label: "parallel" }],
          (v) => actions.setEngineOpt("bp", "schedule", v)))),
      h("p", { class: "note" }, `Residual per iteration (log₁₀), ${result.iters} iterations. Flat-and-falling means it settled; a plateau or sawtooth means the loops are fighting.`),
      sparkline(result.residuals || [], { log: true, height: 54, ariaLabel: "BP residual trace" })) : null,

    engine === "gibbs" ? h("div", {},
      h("h4", {}, "Gibbs sampler"),
      h("div", { class: "row2" },
        field("samples", num(gb.samples, (v) => actions.setEngineOpt("gibbs", "samples", Math.max(100, Math.round(v))), { min: 100, step: 1000 })),
        field("burn-in", num(gb.burnIn, (v) => actions.setEngineOpt("gibbs", "burnIn", Math.max(0, Math.round(v))), { min: 0, step: 500 }))),
      h("div", { class: "row2" },
        field("ε (constraint relaxation)", num(gb.epsilon, (v) => actions.setEngineOpt("gibbs", "epsilon", Math.max(0, v)), { min: 0, step: 1e-6 })),
        field("seed", num(gb.seed, (v) => actions.setEngineOpt("gibbs", "seed", Math.round(v)), { step: 1 }))),
      result.trace && result.trace.length
        ? h("div", {}, h("p", { class: "note" }, "Running estimate for the target proposition:"),
            sparkline(result.trace, { height: 54, min: 0, max: 1, ariaLabel: "Gibbs running estimate" }))
        : null,
      h("p", { class: "note" }, "A hard logical constraint has zero probability outside its support, which can trap single-site Gibbs. ε relaxes every factor by that much so the chain stays ergodic — at the price of a small bias.")) : null,

    engine === "exact" ? h("p", { class: "note" }, "Variable elimination with a greedy min-size ordering. Exact, but the cost grows exponentially with the width of the elimination order, so large mutual-exclusion groups or many Beta parameters can make it fall back to BP.") : null,

    h("h4", {}, "Compare the engines"),
    h("p", { class: "note" }, "Runs all three on the current model and reports the marginal of the target question plus the largest disagreement over every variable."),
    button("Run comparison", actions.compareEngines, { class: "primary mini" }),
    cmp ? comparisonTable(cmp, state) : null);
}

const ENGINE_TONE = { exact: "series-1", bp: "series-2", gibbs: "series-3" };

function comparisonTable(cmp, state) {
  const target = state.model.nodes.find((n) => n.id === state.model.target);
  return h("div", { class: "subgroup" },
    target ? h("p", { class: "note" }, `Target question: ${target.label}`) : null,
    h("table", { class: "grid" },
      h("thead", {}, h("tr", {},
        h("th", {}, "engine"),
        h("th", {}, "P(target)"),
        h("th", { class: "num" }, "Δ vs exact"),
        h("th", { class: "num" }, "ms"))),
      h("tbody", {}, cmp.rows.map((r) => h("tr", {},
        h("td", {}, h("span", { class: "swatch", style: { background: `var(--${ENGINE_TONE[r.engine]})` } }), r.label),
        h("td", {}, r.p === null ? h("span", { class: "muted" }, "unavailable")
          : meter(r.p, { compact: true, tone: ENGINE_TONE[r.engine], digits: 2 })),
        h("td", { class: "num" }, r.maxDiff === null ? "—" : fmtNum(r.maxDiff, 4)),
        h("td", { class: "num" }, r.ms === null ? "—" : r.ms.toFixed(1)))))),
    cmp.note ? h("p", { class: "note" }, cmp.note) : null);
}
