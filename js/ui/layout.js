// Layered (Sugiyama-style) layout for the factor graph.
//
// Logical models have a natural reading direction — causes at the top,
// consequences below — so nodes are assigned to layers by longest path and then
// ordered within each layer by barycentre sweeps to cut edge crossings.

import { KIND } from "../engine/factors.js";

export const SIZES = {
  prop: { w: 118, h: 38 },
  compound: { w: 126, h: 38 },
  aux: { w: 118, h: 30 },
  rule: { w: 126, h: 30 },
  param: { w: 138, h: 56 },
  factor: { w: 24, h: 24 },
};

export function sizeOf(kind) {
  return SIZES[kind] || SIZES.prop;
}

/** Which variables flow into a factor, and which flow out of it. */
export function factorPorts(f) {
  switch (f.kind) {
    case KIND.PRIOR:
    case KIND.THETA_PRIOR:
      return { ins: [], outs: f.vars.slice() };
    case KIND.EVIDENCE:
      return { ins: f.vars.slice(), outs: [] };
    case KIND.PARAM_LINK:
      return { ins: [f.vars[0]], outs: [f.vars[1]] };
    case KIND.AND: case KIND.OR: case KIND.NOT: case KIND.XOR:
      return { ins: f.vars.slice(1), outs: [f.vars[0]] };
    case KIND.EXACTLY_ONE: case KIND.AT_MOST_ONE:
      return { ins: f.vars.slice(), outs: [] };
    case KIND.IMPLIES: case KIND.IMPLIES_NOT: case KIND.IFF:
      if (f.meta && f.meta.cpt) return { ins: f.vars.slice(1), outs: [f.vars[0]] };
      return { ins: [f.vars[0]], outs: [f.vars[1]] };
    case KIND.IMPLIES_G: case KIND.IMPLIES_NOT_G: case KIND.IFF_G:
      return { ins: [f.vars[0], f.vars[2]], outs: [f.vars[1]] };
    default:
      return { ins: f.vars.slice(), outs: [] };
  }
}

/** Nodes of the drawing: every variable plus every factor. */
export function graphNodes(compiled) {
  const nodes = [];
  compiled.vars.forEach((v, i) => nodes.push({
    id: v.id, type: "var", varIndex: i, kind: v.kind, label: v.label,
    size: sizeOf(v.kind === "compound" ? "compound" : v.kind),
  }));
  compiled.factors.forEach((f, i) => nodes.push({
    id: f.id, type: "factor", factorIndex: i, kind: f.kind, label: f.label, size: SIZES.factor,
  }));
  return nodes;
}

export function graphEdges(compiled) {
  const edges = [];
  compiled.factors.forEach((f, fi) => {
    const ports = factorPorts(f);
    f.vars.forEach((vi, slot) => {
      const dir = ports.outs.includes(vi) ? "out" : ports.ins.includes(vi) ? "in" : "none";
      edges.push({ factorIndex: fi, varIndex: vi, slot, dir, from: f.id, to: compiled.vars[vi].id });
    });
  });
  return edges;
}

export function layeredLayout(compiled, opts = {}) {
  const slotW = opts.slotW || 134;
  const rowH = opts.rowH || 68;
  const nodes = graphNodes(compiled);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const idOfVar = (vi) => compiled.vars[vi].id;

  // directed edges for layering
  const succ = new Map(nodes.map((n) => [n.id, []]));
  const pred = new Map(nodes.map((n) => [n.id, []]));
  const link = (a, b) => { succ.get(a).push(b); pred.get(b).push(a); };
  compiled.factors.forEach((f) => {
    const { ins, outs } = factorPorts(f);
    for (const vi of ins) link(idOfVar(vi), f.id);
    for (const vi of outs) link(f.id, idOfVar(vi));
    if (!ins.length && !outs.length) for (const vi of f.vars) link(idOfVar(vi), f.id);
  });

  // longest-path layering, capped so cycles cannot run away
  const layer = new Map(nodes.map((n) => [n.id, 0]));
  const cap = Math.min(nodes.length * 2 + 4, 80);
  for (let pass = 0; pass < cap; pass++) {
    let changed = false;
    for (const n of nodes) {
      for (const t of succ.get(n.id)) {
        const want = Math.min(layer.get(n.id) + 1, cap);
        if (layer.get(t) < want) { layer.set(t, want); changed = true; }
      }
    }
    if (!changed) break;
  }
  // pull nodes down to just above their earliest successor, so leaves do not float
  for (let pass = 0; pass < 4; pass++) {
    for (const n of nodes) {
      const ss = succ.get(n.id);
      if (!ss.length || !pred.get(n.id).length) continue;
      const minS = Math.min(...ss.map((t) => layer.get(t)));
      const maxP = Math.max(...pred.get(n.id).map((t) => layer.get(t)));
      const want = Math.max(maxP + 1, Math.min(layer.get(n.id), minS - 1));
      if (want !== layer.get(n.id) && want > maxP) layer.set(n.id, want);
    }
  }

  const layers = [];
  for (const n of nodes) {
    const l = layer.get(n.id);
    (layers[l] || (layers[l] = [])).push(n);
  }
  const used = layers.filter(Boolean);

  // undirected neighbours for barycentre ordering
  const nbr = new Map(nodes.map((n) => [n.id, []]));
  for (const [a, list] of succ) for (const b of list) { nbr.get(a).push(b); nbr.get(b).push(a); }

  const order = new Map();
  used.forEach((row) => row.forEach((n, i) => order.set(n.id, i)));
  for (let sweep = 0; sweep < 8; sweep++) {
    const rows = sweep % 2 === 0 ? used : used.slice().reverse();
    for (const row of rows) {
      const bary = new Map();
      for (const n of row) {
        const ns = nbr.get(n.id).map((m) => order.get(m)).filter((x) => x !== undefined);
        bary.set(n.id, ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : order.get(n.id));
      }
      row.sort((a, b) => bary.get(a.id) - bary.get(b.id) || a.id.localeCompare(b.id));
      row.forEach((n, i) => order.set(n.id, i));
    }
  }

  // Place each layer, wrapping very wide layers onto stacked sub-rows so big
  // models stay legible instead of collapsing to an unreadable ribbon.
  const maxRowWidth = opts.maxRowWidth || 1150;
  const pos = new Map();
  let y = 0;
  for (const row of used) {
    const widths = row.map((n) => (n.type === "factor" ? 46 : Math.max(n.size.w + 22, slotW)));
    const total = widths.reduce((a, b) => a + b, 0);
    const chunks = Math.max(1, Math.ceil(total / maxRowWidth));
    const per = Math.ceil(row.length / chunks);
    let sub = 0;
    let subRows = 0;
    for (let i = 0; i < row.length; i += per) {
      const slice = row.slice(i, i + per);
      const sw = widths.slice(i, i + per);
      const st = sw.reduce((a, b) => a + b, 0);
      const tallest = Math.max(...slice.map((n) => n.size.h));
      let x = -st / 2;
      slice.forEach((n, k) => {
        pos.set(n.id, { x: Math.round(x + sw[k] / 2), y: y + sub });
        x += sw[k];
      });
      sub += tallest + 16;
      subRows++;
    }
    y += rowH + (subRows - 1) * (sub / Math.max(subRows, 1));
  }

  return { positions: pos, nodes, byId, layers: used.length };
}

/** Bounding box of a set of positioned nodes. */
export function bounds(nodes, positions, pad = 48) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const p = positions.get(n.id);
    if (!p) continue;
    x0 = Math.min(x0, p.x - n.size.w / 2); x1 = Math.max(x1, p.x + n.size.w / 2);
    y0 = Math.min(y0, p.y - n.size.h / 2); y1 = Math.max(y1, p.y + n.size.h / 2);
  }
  if (!isFinite(x0)) return { x: 0, y: 0, w: 400, h: 300 };
  return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
}
