// The factor-graph canvas: SVG rendering, pan, zoom, drag and selection.

import { s, h, clear } from "./dom.js";
import { graphNodes, graphEdges, bounds } from "./layout.js";
import { SYMBOL, KIND } from "../engine/factors.js";
import { fmtPct, fmtNum, gridMean } from "../engine/util.js";

const EVIDENCE_GLYPH = { true: "✓", false: "✗", soft: "~" };

export class GraphView {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.cb = callbacks;
    this.transform = { x: 0, y: 0, k: 1 };
    this.svg = s("svg", { class: "graph", xmlns: "http://www.w3.org/2000/svg" },
      s("defs", {},
        s("marker", { id: "arrow", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" },
          s("path", { d: "M0,0 L8,4 L0,8 z", class: "arrowhead" }))),
      this.viewport = s("g", { class: "viewport" },
        this.edgeLayer = s("g", { class: "edges" }),
        this.nodeLayer = s("g", { class: "nodes" })));
    this.tip = h("div", { class: "graph-tip", hidden: true });
    container.append(this.svg, this.tip);
    this._wireCanvas();
  }

  // --- data ---------------------------------------------------------------
  setData({ compiled, result, view, positions, selection }) {
    this.compiled = compiled;
    this.result = result;
    this.view = view;
    this.positions = positions;
    this.selection = selection;
    this.nodes = graphNodes(compiled);
    this.edges = graphEdges(compiled);
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.render();
  }

  neighbourhood(sel) {
    if (!sel) return null;
    const ids = new Set();
    const varIdsOfNode = (nodeId) => `v:${nodeId}`;
    let seedVars = [];
    if (sel.type === "node") seedVars = [this.compiled.index.get(varIdsOfNode(sel.id))];
    else if (sel.type === "param") seedVars = [this.compiled.paramVar.get(sel.id)];
    else if (sel.type === "rule" || sel.type === "constraint") {
      this.compiled.factors.forEach((f, fi) => {
        if (f.id.endsWith(":" + sel.id)) { ids.add(f.id); f.vars.forEach((vi) => ids.add(this.compiled.vars[vi].id)); }
      });
      return ids;
    }
    for (const vi of seedVars) {
      if (vi === undefined) continue;
      ids.add(this.compiled.vars[vi].id);
      for (const { factor } of this.compiled.adj[vi]) {
        ids.add(this.compiled.factors[factor].id);
        this.compiled.factors[factor].vars.forEach((u) => ids.add(this.compiled.vars[u].id));
      }
    }
    return ids.size ? ids : null;
  }

  render() {
    clear(this.edgeLayer);
    clear(this.nodeLayer);
    const focus = this.neighbourhood(this.selection);
    this.edgeEls = [];
    for (const e of this.edges) {
      const fid = this.compiled.factors[e.factorIndex].id;
      const vid = this.compiled.vars[e.varIndex].id;
      const dim = focus && !(focus.has(fid) && focus.has(vid));
      const line = s("line", {
        class: "edge" + (dim ? " dim" : "") + (e.dir === "out" ? " directed" : ""),
        "marker-end": e.dir === "out" ? "url(#arrow)" : null,
      });
      this.edgeEls.push({ el: line, from: fid, to: vid });
      this.edgeLayer.appendChild(line);
    }
    this.nodeEls = new Map();
    for (const n of this.nodes) {
      const g = n.type === "var" ? this._varNode(n) : this._factorNode(n);
      const dim = focus && !focus.has(n.id);
      if (dim) g.classList.add("dim");
      this.nodeEls.set(n.id, g);
      this.nodeLayer.appendChild(g);
    }
    this._placeAll();
  }

  _varNode(n) {
    const v = this.compiled.vars[n.varIndex];
    const b = this.result.beliefs[n.varIndex];
    const { w, h: hh } = n.size;
    const selected = this._isSelected(n);
    const g = s("g", { class: `gnode var ${v.kind}` + (selected ? " sel" : ""), dataset: { id: n.id } });
    const rect = s("rect", { class: "vbox", x: -w / 2, y: -hh / 2, width: w, height: hh, rx: 9 });
    g.appendChild(rect);

    if (v.kind === "param") {
      const mean = gridMean(v.values, b);
      g.appendChild(s("text", { class: "vlabel", y: -hh / 2 + 13 }, v.label));
      g.appendChild(s("text", { class: "vsub", y: -hh / 2 + 25 }, `mean ${fmtNum(mean, 3)}`));
      const bw = (w - 16) / b.length;
      const top = Math.max(...b) || 1;
      const base = hh / 2 - 5;
      b.forEach((p, i) => g.appendChild(s("rect", {
        class: "vhist", x: -w / 2 + 8 + i * bw + 0.4, width: Math.max(bw - 0.8, 0.4),
        y: base - (p / top) * 18, height: Math.max((p / top) * 18, 0.4),
      })));
      g.appendChild(s("line", { class: "vhist-base", x1: -w / 2 + 8, x2: w / 2 - 8, y1: base + 0.5, y2: base + 0.5 }));
      return g;
    }

    const p = b[1];
    g.appendChild(s("text", { class: "vlabel", y: v.kind === "prop" || v.kind === "compound" ? -3 : 1 }, trim(v.label, 20)));
    if (v.kind === "prop" || v.kind === "compound") {
      g.appendChild(s("text", { class: "vvalue", y: 9 }, fmtPct(p, 1)));
      const track = w - 18;
      g.appendChild(s("rect", { class: "vtrack", x: -track / 2, y: hh / 2 - 8, width: track, height: 4, rx: 2 }));
      g.appendChild(s("rect", { class: "vfill", x: -track / 2, y: hh / 2 - 8, width: Math.max(track * p, p > 0 ? 1.5 : 0), height: 4, rx: 2 }));
    } else {
      g.appendChild(s("text", { class: "vvalue small", y: 11 }, fmtPct(p, 1)));
    }

    const node = v.nodeId ? this.compiled.model.nodes.find((x) => x.id === v.nodeId) : null;
    if (node && node.evidence) {
      const kind = node.evidence.type === "hard" ? String(node.evidence.value) : "soft";
      g.classList.add("obs", "obs-" + kind);
      g.appendChild(s("circle", { class: "obs-dot", cx: -w / 2 + 1, cy: -hh / 2 + 1, r: 7.5 }));
      g.appendChild(s("text", { class: "obs-glyph", x: -w / 2 + 1, y: -hh / 2 + 4.5 }, EVIDENCE_GLYPH[kind]));
    }
    return g;
  }

  _factorNode(n) {
    const f = this.compiled.factors[n.factorIndex];
    const selected = this._isSelected(n);
    const g = s("g", { class: `gnode factor k-${f.kind}` + (selected ? " sel" : ""), dataset: { id: n.id } });
    g.appendChild(s("rect", { class: "fbox", x: -11, y: -11, width: 22, height: 22, rx: 6 }));
    g.appendChild(s("text", { class: "fglyph", y: 4 }, f.meta && f.meta.cpt ? "→" : SYMBOL[f.kind] || "f"));
    return g;
  }

  _isSelected(n) {
    const sel = this.selection;
    if (!sel) return false;
    if (sel.type === "node" && n.type === "var") return this.compiled.vars[n.varIndex].nodeId === sel.id;
    if (sel.type === "param" && n.type === "var") return this.compiled.vars[n.varIndex].paramId === sel.id;
    if ((sel.type === "rule" || sel.type === "constraint") && n.type === "factor")
      return this.compiled.factors[n.factorIndex].id.endsWith(":" + sel.id);
    return false;
  }

  _placeAll() {
    for (const n of this.nodes) {
      const p = this.positions.get(n.id);
      const el = this.nodeEls.get(n.id);
      if (p && el) el.setAttribute("transform", `translate(${p.x},${p.y})`);
    }
    for (const e of this.edgeEls) {
      const a = this.positions.get(e.from);
      const b = this.positions.get(e.to);
      if (!a || !b) continue;
      const target = this.byId.get(e.to);
      const end = clipToRect(a, b, target.size);
      e.el.setAttribute("x1", a.x); e.el.setAttribute("y1", a.y);
      e.el.setAttribute("x2", end.x); e.el.setAttribute("y2", end.y);
    }
  }

  fit(animate = false) {
    const box = bounds(this.nodes, this.positions);
    const r = this.container.getBoundingClientRect();
    const k = Math.min(r.width / box.w, r.height / box.h, 1.6);
    this.transform = { k, x: r.width / 2 - (box.x + box.w / 2) * k, y: r.height / 2 - (box.y + box.h / 2) * k };
    this._applyTransform();
  }

  zoomBy(factor) {
    const r = this.container.getBoundingClientRect();
    this._zoomAt(r.width / 2, r.height / 2, factor);
  }

  _applyTransform() {
    const { x, y, k } = this.transform;
    this.viewport.setAttribute("transform", `translate(${x},${y}) scale(${k})`);
  }

  _zoomAt(px, py, factor) {
    const t = this.transform;
    const k = Math.min(Math.max(t.k * factor, 0.2), 3.5);
    t.x = px - (px - t.x) * (k / t.k);
    t.y = py - (py - t.y) * (k / t.k);
    t.k = k;
    this._applyTransform();
  }

  _wireCanvas() {
    const svg = this.svg;
    let drag = null;

    svg.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = this.container.getBoundingClientRect();
      this._zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
    }, { passive: false });

    svg.addEventListener("pointerdown", (e) => {
      const g = e.target.closest(".gnode");
      const r = this.container.getBoundingClientRect();
      svg.setPointerCapture(e.pointerId);
      if (g) {
        const id = g.dataset.id;
        const p = this.positions.get(id);
        drag = { kind: "node", id, el: g, startX: e.clientX, startY: e.clientY, ox: p.x, oy: p.y, moved: false };
      } else {
        drag = { kind: "pan", startX: e.clientX, startY: e.clientY, ox: this.transform.x, oy: this.transform.y, moved: false };
      }
      this.tip.hidden = true;
    });

    svg.addEventListener("pointermove", (e) => {
      if (!drag) { this._hover(e); return; }
      const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.kind === "pan") {
        this.transform.x = drag.ox + dx;
        this.transform.y = drag.oy + dy;
        this._applyTransform();
      } else {
        this.positions.set(drag.id, { x: drag.ox + dx / this.transform.k, y: drag.oy + dy / this.transform.k });
        this._placeAll();
      }
    });

    const finish = (e) => {
      if (!drag) return;
      if (drag.kind === "node" && !drag.moved) this._select(drag.id);
      if (drag.kind === "node" && drag.moved && this.cb.onMove) this.cb.onMove(drag.id, this.positions.get(drag.id));
      if (drag.kind === "pan" && !drag.moved && this.cb.onSelect) this.cb.onSelect(null);
      drag = null;
    };
    svg.addEventListener("pointerup", finish);
    svg.addEventListener("pointercancel", finish);
    svg.addEventListener("pointerleave", () => { this.tip.hidden = true; });
    svg.addEventListener("dblclick", (e) => { if (!e.target.closest(".gnode")) this.fit(); });
  }

  _select(id) {
    if (!this.cb.onSelect) return;
    const n = this.byId.get(id);
    if (!n) return;
    if (n.type === "var") {
      const v = this.compiled.vars[n.varIndex];
      if (v.nodeId) return this.cb.onSelect({ type: "node", id: v.nodeId });
      if (v.paramId) return this.cb.onSelect({ type: "param", id: v.paramId });
      if (v.ruleId) return this.cb.onSelect({ type: "rule", id: v.ruleId });
      if (v.ownerRule) return this.cb.onSelect({ type: "rule", id: v.ownerRule });
      if (v.ownerNode) return this.cb.onSelect({ type: "node", id: v.ownerNode });
      return;
    }
    const f = this.compiled.factors[n.factorIndex];
    const id2 = f.id.split(":").slice(-1)[0];
    if (f.id.startsWith("f:rule:") || f.id.startsWith("f:antgate:") || f.id.startsWith("f:rlink:"))
      return this.cb.onSelect({ type: "rule", id: id2 });
    if (f.id.startsWith("f:mutex:")) return this.cb.onSelect({ type: "constraint", id: id2 });
    if (f.meta && f.meta.nodeId) return this.cb.onSelect({ type: "node", id: f.meta.nodeId });
    if (f.id.startsWith("f:gate:") || f.id.startsWith("f:prior:") || f.id.startsWith("f:ev:") || f.id.startsWith("f:cpt:") || f.id.startsWith("f:plink:"))
      return this.cb.onSelect({ type: "node", id: id2 });
    if (f.meta && f.meta.testId) return this.cb.onSelect({ type: "test", id: f.meta.testId });
  }

  _hover(e) {
    const g = e.target.closest(".gnode");
    if (!g) { this.tip.hidden = true; return; }
    const n = this.byId.get(g.dataset.id);
    if (!n) return;
    const r = this.container.getBoundingClientRect();
    this.tip.innerHTML = this._tipHtml(n);
    this.tip.hidden = false;
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    this.tip.style.left = Math.min(Math.max(e.clientX - r.left + 14, 4), r.width - tw - 4) + "px";
    this.tip.style.top = Math.max(e.clientY - r.top - th - 12, 4) + "px";
  }

  _tipHtml(n) {
    const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    if (n.type === "var") {
      const v = this.compiled.vars[n.varIndex];
      const b = this.result.beliefs[n.varIndex];
      if (v.kind === "param")
        return `<strong>${esc(v.label)}</strong><br>Beta(${v.beta.a}, ${v.beta.b}) prior on ${v.card} grid points<br>posterior mean ${fmtNum(gridMean(v.values, b), 4)}`;
      const kindText = { prop: "proposition", compound: "compound node", aux: "derived antecedent", rule: "rule validity" }[v.kind] || v.kind;
      return `<strong>${esc(v.label)}</strong><br>${kindText}<br>P(true) = ${fmtPct(b[1], 2)}`;
    }
    const f = this.compiled.factors[n.factorIndex];
    const names = f.vars.map((vi) => esc(this.compiled.vars[vi].label)).join(", ");
    const desc = describeFactor(f);
    return `<strong>${esc(f.label)}</strong><br>${desc}<br><span class="tip-vars">over ${names}</span>`;
  }
}

function describeFactor(f) {
  if (f.meta && f.meta.cpt) return "noisy-OR conditional combining every rule into this node";
  const map = {
    [KIND.PRIOR]: "prior belief",
    [KIND.THETA_PRIOR]: "Beta prior over a parameter",
    [KIND.EVIDENCE]: "observation likelihood",
    [KIND.PARAM_LINK]: "parameter → Bernoulli draw",
    [KIND.AND]: "AND gate", [KIND.OR]: "OR gate", [KIND.NOT]: "NOT gate", [KIND.XOR]: "XOR gate",
    [KIND.IMPLIES]: "implication constraint", [KIND.IMPLIES_NOT]: "exclusion constraint", [KIND.IFF]: "equivalence constraint",
    [KIND.IMPLIES_G]: "implication, valid only if the rule holds",
    [KIND.IMPLIES_NOT_G]: "exclusion, valid only if the rule holds",
    [KIND.IFF_G]: "equivalence, valid only if the rule holds",
    [KIND.EXACTLY_ONE]: "exactly one of these is true",
    [KIND.AT_MOST_ONE]: "at most one of these is true",
  };
  return map[f.kind] || f.kind;
}

function clipToRect(from, to, size) {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (dx === 0 && dy === 0) return to;
  const hw = size.w / 2 + 3, hh = size.h / 2 + 3;
  const tx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: to.x - dx * t, y: to.y - dy * t };
}

function trim(t, n) {
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
