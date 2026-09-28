// Application state and wiring.

import { h, mount, $ } from "./dom.js";
import { GraphView } from "./graph.js";
import { layeredLayout } from "./layout.js";
import { renderEditor } from "./panels.js";
import { renderResults } from "./results.js";
import { aboutContent } from "./about.js";
import { segmented } from "./widgets.js";
import { compile } from "../engine/compile.js";
import { solve, buildView, ENGINES } from "../engine/infer.js";
import { runBP, BP_DEFAULTS } from "../engine/bp.js";
import { GIBBS_DEFAULTS } from "../engine/gibbs.js";
import { rankTests, greedyPlan } from "../engine/voi.js";
import { buildExample, EXAMPLES } from "../examples/index.js";
import {
  emptyModel, makeNode, makeRule, makeConstraint, makeParam, makeTest,
  deleteNode, deleteParam, cloneModel,
} from "../engine/model.js";

const state = {
  model: null,
  settings: { engine: "bp", bp: { ...BP_DEFAULTS }, gibbs: { ...GIBBS_DEFAULTS } },
  selection: null,
  tab: "beliefs",
  sortBeliefs: "model",
  voiObjective: "target",
  planBudget: 50,
  planScore: "efficiency",
  plan: null,
  comparison: null,
  positions: new Map(),
  moved: new Set(),
  signature: "",
  scrollToSelection: false,
};

let graph = null;
const refs = {};

// ---------------------------------------------------------------------------
// core recompute

function recompute({ relayout = false, keepComparison = false } = {}) {
  const t0 = performance.now();
  state.compiled = compile(state.model);
  // Let the sampler record a running estimate for the target question.
  state.settings.gibbs.traceVar = state.compiled.nodeVar.get(state.model.target) ?? null;
  state.result = solve(state.compiled, state.settings);
  state.view = buildView(state.compiled, state.result);
  // The explanation panel always needs messages, which only BP produces.
  state.bpResult = state.settings.engine === "bp"
    ? state.result
    : runBP(state.compiled, state.settings.bp);
  if (!keepComparison) state.comparison = null;
  state.voiRows = null;
  state.voiRowsForSelection = null;
  if (state.tab === "voi" || state.tab === "explain") computeVoi();
  ensureLayout(relayout);
  state.lastMs = performance.now() - t0;
  render();
}

function voiSettings() {
  // Sampling is far too slow to run once per hypothetical outcome.
  return state.settings.engine === "gibbs" ? { engine: "bp", bp: state.settings.bp } : state.settings;
}

function computeVoi() {
  if (!state.model.tests.length || !state.model.target) { state.voiRows = []; state.voiRowsForSelection = []; return; }
  try {
    const { rows } = rankTests(state.compiled, voiSettings(), state.model, state.model.target, state.voiObjective, state.result.beliefs);
    state.voiRows = rows;
    const selId = state.selection?.type === "node" ? state.selection.id : state.model.target;
    if (selId === state.model.target) {
      state.voiRowsForSelection = rows;
    } else {
      const r = rankTests(state.compiled, voiSettings(), state.model, selId, "target", state.result.beliefs);
      state.voiRowsForSelection = r.rows;
    }
  } catch (err) {
    state.voiRows = [];
    state.voiRowsForSelection = [];
    console.warn("value-of-information failed", err);
  }
}

function ensureLayout(force) {
  // Wrap layers at roughly the canvas width so wide models stay legible
  // instead of shrinking to an unreadable ribbon when fitted.
  const canvasWidth = $("#canvas")?.clientWidth || 700;
  const laid = layeredLayout(state.compiled, { maxRowWidth: Math.max(560, canvasWidth * 1.4) });
  const sig = laid.nodes.map((n) => n.id).sort().join("|");
  const changed = sig !== state.signature;
  const next = new Map();
  for (const n of laid.nodes) {
    const prev = state.positions.get(n.id);
    const keep = prev && !force && (!changed || state.moved.has(n.id));
    next.set(n.id, keep ? prev : laid.positions.get(n.id));
  }
  if (force) state.moved.clear();
  state.positions = next;
  state.signature = sig;
  if (changed || force) state.needsFit = true;
}

// ---------------------------------------------------------------------------
// render

function render() {
  renderEditor(refs.editor, state, actions);
  renderResults(refs.results, state, actions);
  renderHeader();
  graph.setData({
    compiled: state.compiled, result: state.result, view: state.view,
    positions: state.positions, selection: state.selection,
  });
  if (state.needsFit) { graph.fit(); state.needsFit = false; }
  refs.status.textContent = `${state.compiled.vars.length} variables · ${state.compiled.factors.length} factors · ${state.lastMs.toFixed(0)} ms`;
}

function renderHeader() {
  mount(refs.engineSlot,
    segmented(state.settings.engine, ENGINES.map((e) => ({
      value: e.id, label: { bp: "Loopy BP", exact: "Exact", gibbs: "Sampling" }[e.id], hint: e.hint,
    })), actions.setEngine));
}

// ---------------------------------------------------------------------------
// actions

const actions = {
  set(patch, recomputeVoi = false) {
    Object.assign(state, patch);
    if (recomputeVoi) computeVoi();
    render();
  },
  setTab(tab) {
    state.tab = tab;
    if ((tab === "voi" || tab === "explain") && !state.voiRows) computeVoi();
    render();
  },
  select(sel) {
    state.selection = sel;
    state.scrollToSelection = !!sel;
    if (sel && (state.tab === "explain" || state.tab === "voi")) computeVoi();
    render();
  },
  update(mutator) {
    mutator(state.model);
    state.plan = null;
    recompute();
    autosave();
  },
  setEngine(id) {
    state.settings.engine = id;
    recompute({ keepComparison: true });
  },
  setEngineOpt(engine, key, value) {
    state.settings[engine][key] = value;
    recompute({ keepComparison: true });
  },
  loadExample(id) {
    loadModel(buildExample(id));
  },
  addNode(compound) {
    actions.update((m) => {
      const n = compound
        ? makeNode({ label: "New ∧", kind: "compound", op: "AND", inputs: m.nodes.slice(0, 2).map((x) => x.id), prior: null })
        : makeNode({ label: nextLabel(m) });
      m.nodes.push(n);
      state.selection = { type: "node", id: n.id };
    });
  },
  addRule() {
    actions.update((m) => {
      if (m.nodes.length < 2) return;
      const r = makeRule({ ants: [m.nodes[0].id], cons: m.nodes[1].id, rel: { type: "fixed", p: 0.9 } });
      m.rules.push(r);
      state.selection = { type: "rule", id: r.id };
    });
  },
  addConstraint() {
    actions.update((m) => {
      const c = makeConstraint({ members: m.nodes.slice(0, Math.min(3, m.nodes.length)).map((n) => n.id) });
      m.constraints.push(c);
      state.selection = { type: "constraint", id: c.id };
    });
  },
  addParam() {
    actions.update((m) => {
      const p = makeParam({ label: `θ${m.params.length + 1}` });
      m.params.push(p);
      state.selection = { type: "param", id: p.id };
    });
  },
  addTest() {
    actions.update((m) => {
      if (!m.nodes.length) return;
      const t = makeTest({ label: "New experiment", target: m.target || m.nodes[0].id, cost: 10 });
      m.tests.push(t);
      state.selection = { type: "test", id: t.id };
    });
  },
  deleteNode(id) { actions.update((m) => { deleteNode(m, id); state.selection = null; }); },
  deleteRule(id) { actions.update((m) => { m.rules = m.rules.filter((r) => r.id !== id); state.selection = null; }); },
  deleteConstraint(id) { actions.update((m) => { m.constraints = m.constraints.filter((c) => c.id !== id); state.selection = null; }); },
  deleteParam(id) { actions.update((m) => { deleteParam(m, id); state.selection = null; }); },
  deleteTest(id) { actions.update((m) => { m.tests = m.tests.filter((t) => t.id !== id); state.selection = null; }); },

  performTest(testId, outcomeIndex) {
    actions.update((m) => {
      const t = m.tests.find((x) => x.id === testId);
      if (!t) return;
      if (outcomeIndex === null) {
        const row = (state.voiRows || []).find((r) => r.testId === testId);
        const probs = row ? row.outcomes.map((o) => o.prob) : t.outcomes.map(() => 1 / t.outcomes.length);
        let u = Math.random(), acc = 0, pick = probs.length - 1;
        for (let i = 0; i < probs.length; i++) { acc += probs[i]; if (u < acc) { pick = i; break; } }
        t.performed = pick;
      } else {
        t.performed = outcomeIndex;
      }
    });
  },
  simulatePlan() {
    try {
      state.plan = greedyPlan(state.model, voiSettings(), compile, state.model.target, {
        budget: state.planBudget, maxSteps: 8, objective: state.voiObjective, scoreBy: state.planScore,
        seed: (Math.random() * 1e9) | 0,
      });
    } catch (err) {
      state.plan = { steps: [], spent: 0 };
      console.warn(err);
    }
    render();
  },
  applyPlan() {
    if (!state.plan) return;
    const steps = state.plan.steps;
    actions.update((m) => {
      for (const s of steps) {
        const t = m.tests.find((x) => x.id === s.testId);
        if (t) t.performed = s.outcomeIndex;
      }
    });
    state.plan = null;
    render();
  },
  compareEngines() {
    const rows = [];
    const targetVar = state.compiled.nodeVar.get(state.model.target);
    let exactBeliefs = null;
    for (const id of ["exact", "bp", "gibbs"]) {
      const res = solve(state.compiled, { ...state.settings, engine: id });
      const fellBack = res.fellBackFrom === id;
      if (id === "exact" && !fellBack) exactBeliefs = res.beliefs;
      rows.push({
        engine: id,
        label: ENGINES.find((e) => e.id === id).label,
        p: fellBack ? null : (targetVar !== undefined ? res.beliefs[targetVar][1] : null),
        beliefs: fellBack ? null : res.beliefs,
        ms: fellBack ? null : res.ms,
        note: res.note,
      });
    }
    for (const r of rows) {
      if (!exactBeliefs || !r.beliefs || r.engine === "exact") { r.maxDiff = r.engine === "exact" && exactBeliefs ? 0 : null; continue; }
      let m = 0;
      for (let i = 0; i < exactBeliefs.length; i++)
        for (let x = 0; x < exactBeliefs[i].length; x++)
          m = Math.max(m, Math.abs(exactBeliefs[i][x] - r.beliefs[i][x]));
      r.maxDiff = m;
    }
    state.comparison = {
      rows,
      note: exactBeliefs
        ? "Δ is the largest absolute difference over every variable in the graph, against exact inference."
        : "Exact inference was unavailable on this model, so there is no ground truth to compare against.",
    };
    render();
  },

  relayout() { ensureLayout(true); state.needsFit = true; render(); },
  clearEvidence() {
    actions.update((m) => {
      for (const n of m.nodes) n.evidence = null;
      for (const t of m.tests) t.performed = null;
    });
  },
  blankModel() {
    const m = emptyModel("Blank model");
    m.nodes = [makeNode({ label: "A" }), makeNode({ label: "B" })];
    m.rules = [makeRule({ ants: [m.nodes[0].id], cons: m.nodes[1].id, rel: { type: "fixed", p: 0.9 } })];
    m.target = m.nodes[1].id;
    loadModel(m);
  },
  exportModel() {
    const blob = new Blob([JSON.stringify(stripModel(state.model), null, 2)], { type: "application/json" });
    const a = h("a", { href: URL.createObjectURL(blob), download: (state.model.name || "model").replace(/\W+/g, "-").toLowerCase() + ".json" });
    document.body.appendChild(a); a.click(); a.remove();
  },
  importModel() {
    const input = h("input", { type: "file", accept: "application/json,.json" });
    input.addEventListener("change", async () => {
      const f = input.files[0];
      if (!f) return;
      try { loadModel(normalise(JSON.parse(await f.text()))); }
      catch (err) { alert("Could not read that file: " + err.message); }
    });
    input.click();
  },
  copyLink() {
    writeHash();
    navigator.clipboard?.writeText(location.href).then(
      () => flash("Link copied — the whole model is in the URL."),
      () => flash("Could not copy; the URL bar has it."));
  },
};

// ---------------------------------------------------------------------------
// helpers

function nextLabel(m) {
  const used = new Set(m.nodes.map((n) => n.label));
  for (const c of "PQRSTUVWXYZABCDEFGHIJKLMNO") if (!used.has(c)) return c;
  return "N" + (m.nodes.length + 1);
}

function stripModel(m) {
  const out = cloneModel(m);
  for (const n of out.nodes) {
    const p = state.positions.get(`v:${n.id}`);
    if (p) { n.x = Math.round(p.x); n.y = Math.round(p.y); }
  }
  return out;
}

function normalise(m) {
  const base = emptyModel(m.name || "Imported model");
  const out = { ...base, ...m };
  out.nodes = (m.nodes || []).map((n) => makeNode(n));
  out.rules = (m.rules || []).map((r) => makeRule(r));
  out.constraints = (m.constraints || []).map((c) => makeConstraint(c));
  out.params = (m.params || []).map((p) => makeParam(p));
  out.tests = (m.tests || []).map((t) => makeTest(t));
  out.semantics = m.semantics === "constraint" ? "constraint" : "causal";
  if (!out.target || !out.nodes.some((n) => n.id === out.target)) out.target = out.nodes[0]?.id ?? null;
  return out;
}

function loadModel(m) {
  state.model = m;
  state.selection = null;
  state.plan = null;
  state.comparison = null;
  state.positions = new Map();
  state.moved = new Set();
  state.signature = "";
  for (const n of m.nodes) if (n.x !== null && n.x !== undefined) state.positions.set(`v:${n.id}`, { x: n.x, y: n.y });
  recompute({ relayout: false });
  state.needsFit = true;
  graph.fit();
  autosave();
}

function flash(text) {
  refs.status.textContent = text;
  setTimeout(() => { refs.status.textContent = `${state.compiled.vars.length} variables · ${state.compiled.factors.length} factors`; }, 2600);
}

function encodeModel(m) {
  const bytes = new TextEncoder().encode(JSON.stringify(stripModel(m)));
  let s = "";
  for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeModel(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return normalise(JSON.parse(new TextDecoder().decode(bytes)));
}

const STORAGE_KEY = "problogic-model";

// The working model is autosaved locally so a refresh does not lose it; the URL
// only carries a model when the user explicitly asks for a link.
let saveTimer = null;
function autosave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(stripModel(state.model))); } catch { /* quota */ }
  }, 400);
}

function writeHash() {
  try { history.replaceState(null, "", "#m=" + encodeModel(state.model)); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// boot

export function boot() {
  refs.editor = $("#editor");
  refs.results = $("#results");
  refs.status = $("#status");
  refs.engineSlot = $("#engine-slot");

  graph = new GraphView($("#canvas"), {
    onSelect: (sel) => actions.select(sel),
    onMove: (id, pos) => {
      state.moved.add(id);
      const nodeId = id.startsWith("v:") ? id.slice(2) : null;
      const n = nodeId && state.model.nodes.find((x) => x.id === nodeId);
      if (n) { n.x = Math.round(pos.x); n.y = Math.round(pos.y); }
      autosave();
    },
  });

  $("#btn-fit").addEventListener("click", () => graph.fit());
  $("#btn-relayout").addEventListener("click", actions.relayout);
  $("#btn-zoom-in").addEventListener("click", () => graph.zoomBy(1.2));
  $("#btn-zoom-out").addEventListener("click", () => graph.zoomBy(1 / 1.2));

  const dlg = $("#about");
  mount($("#about-body"), aboutContent());
  $("#btn-about").addEventListener("click", () => dlg.showModal());
  $("#about-close").addEventListener("click", () => dlg.close());

  const themeBtn = $("#btn-theme");
  const stored = localStorage.getItem("problogic-theme");
  if (stored) document.documentElement.dataset.theme = stored;
  themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme
      || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("problogic-theme", next);
  });

  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.key === "Escape") actions.select(null);
    if (e.key === "f") graph.fit();
    if (e.key === "l") actions.relayout();
  });

  let initial = null;
  if (location.hash.startsWith("#m=")) {
    try { initial = decodeModel(location.hash.slice(3)); } catch { initial = null; }
  }
  if (!initial) {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) initial = normalise(JSON.parse(saved));
    } catch { initial = null; }
  }
  loadModel(initial || buildExample(EXAMPLES[0].id));
  window.addEventListener("resize", () => graph.fit());
}
