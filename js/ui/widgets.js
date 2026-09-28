// Chart and control primitives.
//
// Colour follows the job, not the entity: a single probability is a magnitude
// (one blue meter against a neutral track), an evidence decomposition is a
// polarity (blue supports / red opposes with a neutral zero line), and the
// engine comparison is identity (categorical slots 1–3, always direct-labelled).

import { h, s } from "./dom.js";
import { fmtPct, fmtNum } from "../engine/util.js";

/** Horizontal probability meter with the value direct-labelled. */
export function meter(p, opts = {}) {
  const { width = null, label = null, tone = "series-1", showValue = true, digits = 1, sub = null } = opts;
  const pct = Math.max(0, Math.min(1, p)) * 100;
  return h("div", { class: "meter" + (opts.compact ? " meter-compact" : ""), style: width ? { width } : null },
    label !== null && h("span", { class: "meter-label" }, label),
    h("span", { class: "meter-track" },
      h("span", { class: "meter-fill", style: { width: pct + "%", background: `var(--${tone})` } })),
    showValue && h("span", { class: "meter-value" }, fmtPct(p, digits)),
    sub && h("span", { class: "meter-sub" }, sub));
}

/** Diverging bar: negative arm red (opposes), positive arm blue (supports). */
export function divergingBars(rows, opts = {}) {
  const max = Math.max(1e-9, ...rows.map((r) => Math.abs(r.value)));
  const scale = opts.max || max;
  return h("div", { class: "dbars" },
    rows.map((r) =>
      h("div", { class: "dbar-row", title: r.title || "" },
        h("span", { class: "dbar-name" }, r.name),
        h("span", { class: "dbar-track" },
          h("span", { class: "dbar-zero" }),
          h("span", {
            class: "dbar-fill",
            style: {
              background: r.value >= 0 ? "var(--series-1)" : "var(--series-8)",
              width: (50 * Math.min(1, Math.abs(r.value) / scale)) + "%",
              left: r.value >= 0 ? "50%" : "auto",
              right: r.value < 0 ? "50%" : "auto",
              borderRadius: r.value >= 0 ? "0 2px 2px 0" : "2px 0 0 2px",
            },
          })),
        h("span", { class: "dbar-value" }, (r.value >= 0 ? "+" : "−") + Math.abs(r.value).toFixed(2)))));
}

/** Histogram over a discretised parameter, with the prior drawn behind. */
export function betaChart(values, posterior, prior, opts = {}) {
  const w = opts.width || 240, hgt = opts.height || 64, pad = 2;
  const n = values.length;
  const bw = (w - pad * 2) / n;
  const top = Math.max(...posterior, ...(prior || [0])) * 1.08 || 1;
  const bars = (dist, cls) => dist.map((v, i) =>
    s("rect", {
      class: cls, x: pad + i * bw + 0.75, width: Math.max(bw - 1.5, 0.5),
      y: hgt - (v / top) * (hgt - 2), height: Math.max((v / top) * (hgt - 2), 0.5), rx: 1,
    }));
  const meanX = (m) => pad + m * (w - pad * 2);
  return s("svg", { class: "betachart", viewBox: `0 0 ${w} ${hgt}`, width: "100%", height: hgt, role: "img",
      "aria-label": opts.ariaLabel || "parameter posterior" },
    prior && s("g", { class: "prior-bars" }, bars(prior, "bar-prior")),
    s("g", {}, bars(posterior, "bar-post")),
    opts.mean !== undefined && s("line", { class: "mean-line", x1: meanX(opts.mean), x2: meanX(opts.mean), y1: 0, y2: hgt }));
}

/** Single-series sparkline on a log scale, for the BP residual trace. */
export function sparkline(values, opts = {}) {
  const w = opts.width || 240, hgt = opts.height || 46;
  if (!values.length) return h("div", { class: "muted small" }, "no trace");
  const vals = opts.log ? values.map((v) => Math.log10(Math.max(v, 1e-16))) : values.slice();
  const lo = opts.min !== undefined ? opts.min : Math.min(...vals);
  const hi = opts.max !== undefined ? opts.max : Math.max(...vals);
  const span = hi - lo || 1;
  const pts = vals.map((v, i) =>
    `${(i / Math.max(1, vals.length - 1)) * (w - 4) + 2},${hgt - 2 - ((v - lo) / span) * (hgt - 4)}`).join(" ");
  return s("svg", { class: "sparkline", viewBox: `0 0 ${w} ${hgt}`, width: "100%", height: hgt, role: "img",
      "aria-label": opts.ariaLabel || "trace" },
    opts.rule !== undefined && s("line", { class: "spark-rule", x1: 2, x2: w - 2,
      y1: hgt - 2 - ((opts.rule - lo) / span) * (hgt - 4), y2: hgt - 2 - ((opts.rule - lo) / span) * (hgt - 4) }),
    s("polyline", { class: "spark-line", points: pts }));
}

// --- form controls ---------------------------------------------------------

export function field(label, control, hint) {
  return h("label", { class: "field" },
    h("span", { class: "field-label" }, label),
    control,
    hint && h("span", { class: "field-hint" }, hint));
}

export function select(value, options, onchange, attrs = {}) {
  return h("select", { ...attrs, onchange: (e) => onchange(e.target.value) },
    options.map((o) => h("option", { value: o.value, selected: o.value === value }, o.label)));
}

export function num(value, onchange, attrs = {}) {
  const input = h("input", {
    type: "number", value, ...attrs,
    onchange: (e) => onchange(parseFloat(e.target.value)),
  });
  return input;
}

export function prob(value, onchange, attrs = {}) {
  const row = h("span", { class: "prob-input" });
  const input = h("input", {
    type: "range", min: 0, max: 1, step: 0.01, value, ...attrs,
    oninput: (e) => { out.textContent = fmtPct(parseFloat(e.target.value), 0); },
    onchange: (e) => onchange(parseFloat(e.target.value)),
  });
  const out = h("output", { class: "prob-out" }, fmtPct(value, 0));
  row.append(input, out);
  return row;
}

export function text(value, onchange, attrs = {}) {
  return h("input", { type: "text", value, ...attrs, onchange: (e) => onchange(e.target.value) });
}

export function button(label, onclick, attrs = {}) {
  return h("button", { type: "button", ...attrs, onclick }, label);
}

export function segmented(value, options, onchange, attrs = {}) {
  return h("div", { class: "segmented", role: "group", ...attrs },
    options.map((o) => h("button", {
      type: "button", class: o.value === value ? "seg on" : "seg",
      title: o.hint || "", "aria-pressed": String(o.value === value),
      onclick: () => onchange(o.value),
    }, o.label)));
}

export function chip(label, tone = "") {
  return h("span", { class: "chip " + tone }, label);
}

export function section(title, opts, ...body) {
  const { open = true, actions = null, id = null, note = null } = opts || {};
  const det = h("details", { class: "section", open, id },
    h("summary", {}, h("span", { class: "sec-title" }, title), actions),
    note && h("p", { class: "sec-note" }, note),
    ...body);
  return det;
}
