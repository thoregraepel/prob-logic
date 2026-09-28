// Factor definitions for the logical factor graph.
//
// A factor is a non-negative potential over a tuple of discrete variables:
//
//     f(x_{v1}, ..., x_{vk})  ->  R>=0
//
// Every factor carries an explicit dense `table` when it is small enough
// (row-major, LAST variable varying fastest). The table is what variable
// elimination and the generic sum-product routine consume. Gate and counting
// factors additionally expose an O(k) dynamic-programming message routine so
// they stay usable at arities where a table would be hopeless.

const MAX_TABLE = 1 << 16; // 65536 entries

export const KIND = {
  PRIOR: "PRIOR",
  EVIDENCE: "EVIDENCE",
  AND: "AND",
  OR: "OR",
  NOT: "NOT",
  XOR: "XOR",
  IMPLIES: "IMPLIES",
  IMPLIES_NOT: "IMPLIES_NOT",
  IFF: "IFF",
  IMPLIES_G: "IMPLIES_G",
  IMPLIES_NOT_G: "IMPLIES_NOT_G",
  IFF_G: "IFF_G",
  EXACTLY_ONE: "EXACTLY_ONE",
  AT_MOST_ONE: "AT_MOST_ONE",
  PARAM_LINK: "PARAM_LINK",
  THETA_PRIOR: "THETA_PRIOR",
};

/** Kinds whose messages can be computed in O(arity) without a table. */
const DP_KINDS = new Set([
  KIND.AND, KIND.OR, KIND.NOT, KIND.XOR,
  KIND.EXACTLY_ONE, KIND.AT_MOST_ONE,
]);

export function strides(card) {
  const s = new Array(card.length);
  let acc = 1;
  for (let i = card.length - 1; i >= 0; i--) {
    s[i] = acc;
    acc *= card[i];
  }
  return s;
}

export function tableSize(card) {
  return card.reduce((a, b) => a * b, 1);
}

/**
 * Create a factor. `fn(assignment) -> weight` defines the potential; a dense
 * table is materialised eagerly when the state space is small enough.
 */
function makeFactor({ id, kind, label, vars, card, fn, meta = {} }) {
  const size = tableSize(card);
  let table = null;
  if (size <= MAX_TABLE) {
    table = new Float64Array(size);
    const st = strides(card);
    const assign = new Array(card.length).fill(0);
    for (let idx = 0; idx < size; idx++) {
      for (let d = 0; d < card.length; d++) assign[d] = Math.floor(idx / st[d]) % card[d];
      table[idx] = fn(assign);
    }
  }
  return { id, kind, label, vars, card, table, fn, meta, size };
}

/** Evaluate a factor at a full local assignment (used by Gibbs sampling). */
export function factorValue(f, assign) {
  if (f.table) {
    const st = strides(f.card);
    let idx = 0;
    for (let d = 0; d < f.card.length; d++) idx += assign[d] * st[d];
    return f.table[idx];
  }
  return f.fn(assign);
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function priorFactor(id, v, p, label = "prior") {
  return makeFactor({
    id, kind: KIND.PRIOR, label, vars: [v], card: [2],
    fn: (a) => (a[0] === 1 ? p : 1 - p),
    meta: { p },
  });
}

/** Unary likelihood factor: weights[x] = P(observation | X = x). */
export function evidenceFactor(id, v, weights, label = "evidence", meta = {}) {
  return makeFactor({
    id, kind: KIND.EVIDENCE, label, vars: [v], card: [2],
    fn: (a) => weights[a[0]],
    meta: { weights, ...meta },
  });
}

/** Deterministic gate: vars = [out, in0, in1, ...]. */
export function gateFactor(id, kind, out, inputs, label) {
  const vars = [out, ...inputs];
  const card = vars.map(() => 2);
  const apply = (bits) => {
    switch (kind) {
      case KIND.AND: return bits.every((b) => b === 1) ? 1 : 0;
      case KIND.OR: return bits.some((b) => b === 1) ? 1 : 0;
      case KIND.NOT: return bits[0] === 1 ? 0 : 1;
      case KIND.XOR: return bits.reduce((p, b) => p ^ b, 0);
      default: throw new Error("not a gate: " + kind);
    }
  };
  return makeFactor({
    id, kind, label: label || kind, vars, card,
    fn: (a) => (a[0] === apply(a.slice(1)) ? 1 : 0),
  });
}

const RULE_BASE = {
  // base[a][b] = 1 when the relation is satisfied
  [KIND.IMPLIES]: [[1, 1], [0, 1]],
  [KIND.IMPLIES_NOT]: [[1, 1], [1, 0]],
  [KIND.IFF]: [[1, 0], [0, 1]],
};

/**
 * Soft logical rule with a fixed reliability p:
 *
 *     f(a, b) = p * [relation holds] + (1 - p) * 1
 *
 * p = 1 is a hard constraint; p = 0 makes the rule vacuous.
 */
export function ruleFactor(id, kind, a, b, p, label) {
  const base = RULE_BASE[kind];
  if (!base) throw new Error("not a rule kind: " + kind);
  return makeFactor({
    id, kind, label: label || kind, vars: [a, b], card: [2, 2],
    fn: (x) => p * base[x[0]][x[1]] + (1 - p),
    meta: { p },
  });
}

/**
 * Rule whose validity is itself a random variable R:
 *
 *     f(a, b, r) = r ? [relation holds] : 1
 *
 * Observing a counterexample (a=1, b=0 for an implication) drives P(R=1) down,
 * which is how the model learns about the relationship itself.
 */
export function gatedRuleFactor(id, kind, a, b, r, label) {
  const baseKind = { [KIND.IMPLIES_G]: KIND.IMPLIES, [KIND.IMPLIES_NOT_G]: KIND.IMPLIES_NOT, [KIND.IFF_G]: KIND.IFF }[kind];
  const base = RULE_BASE[baseKind];
  if (!base) throw new Error("not a gated rule kind: " + kind);
  return makeFactor({
    id, kind, label: label || kind, vars: [a, b, r], card: [2, 2, 2],
    fn: (x) => (x[2] === 1 ? base[x[0]][x[1]] : 1),
  });
}

/** Mutual exclusivity over a set of propositions. */
export function mutexFactor(id, kind, members, label) {
  const card = members.map(() => 2);
  return makeFactor({
    id, kind, label: label || kind, vars: members.slice(), card,
    fn: (a) => {
      let n = 0;
      for (const v of a) n += v;
      return kind === KIND.EXACTLY_ONE ? (n === 1 ? 1 : 0) : n <= 1 ? 1 : 0;
    },
  });
}

/** Categorical prior over a discretised parameter theta. */
export function thetaPriorFactor(id, v, weights, label = "Beta prior") {
  return makeFactor({
    id, kind: KIND.THETA_PRIOR, label, vars: [v], card: [weights.length],
    fn: (a) => weights[a[0]],
    meta: { weights },
  });
}

/** Links a parameter theta to a Bernoulli draw: f(theta, x) = theta^x (1-theta)^(1-x). */
export function paramLinkFactor(id, theta, x, values, label = "θ → X") {
  return makeFactor({
    id, kind: KIND.PARAM_LINK, label, vars: [theta, x], card: [values.length, 2],
    fn: (a) => (a[1] === 1 ? values[a[0]] : 1 - values[a[0]]),
    meta: { values },
  });
}

// ---------------------------------------------------------------------------
// Sum-product messages
// ---------------------------------------------------------------------------

function leaveOneOut(values, init, combine) {
  // prefix/suffix products, avoiding division so zeros are handled exactly
  const n = values.length;
  const pre = new Array(n + 1).fill(init);
  const suf = new Array(n + 1).fill(init);
  for (let i = 0; i < n; i++) pre[i + 1] = combine(pre[i], values[i]);
  for (let i = n - 1; i >= 0; i--) suf[i] = combine(suf[i + 1], values[i]);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = combine(pre[i], suf[i + 1]);
  return { out, all: pre[n] };
}

const mul = (a, b) => a * b;

/** Generic sum-product over the dense table. O(|states| * arity). */
export function genericMessages(f, incoming) {
  const n = f.vars.length;
  const st = strides(f.card);
  const out = f.card.map((c) => new Array(c).fill(0));
  const idxs = new Array(n).fill(0);
  const pre = new Array(n + 1).fill(1);
  const suf = new Array(n + 1).fill(1);
  for (let idx = 0; idx < f.size; idx++) {
    const w = f.table[idx];
    if (w === 0) continue;
    for (let d = 0; d < n; d++) idxs[d] = Math.floor(idx / st[d]) % f.card[d];
    for (let d = 0; d < n; d++) pre[d + 1] = pre[d] * incoming[d][idxs[d]];
    suf[n] = 1;
    for (let d = n - 1; d >= 0; d--) suf[d] = suf[d + 1] * incoming[d][idxs[d]];
    for (let d = 0; d < n; d++) out[d][idxs[d]] += w * pre[d] * suf[d + 1];
  }
  return out;
}

/** O(arity) messages for gates and counting constraints. */
export function dpMessages(f, incoming) {
  switch (f.kind) {
    case KIND.NOT: {
      const [mo, mi] = incoming;
      return [[mi[1], mi[0]], [mo[1], mo[0]]];
    }
    case KIND.AND: {
      const mo = incoming[0];
      const mi = incoming.slice(1);
      const ones = leaveOneOut(mi.map((m) => m[1]), 1, mul);
      const tot = leaveOneOut(mi.map((m) => m[0] + m[1]), 1, mul);
      const toOut = [tot.all - ones.all, ones.all];
      const res = [toOut];
      for (let j = 0; j < mi.length; j++) {
        const othersAll1 = ones.out[j];
        const othersTot = tot.out[j];
        res.push([
          mo[0] * othersTot,
          mo[1] * othersAll1 + mo[0] * (othersTot - othersAll1),
        ]);
      }
      return res;
    }
    case KIND.OR: {
      const mo = incoming[0];
      const mi = incoming.slice(1);
      const zeros = leaveOneOut(mi.map((m) => m[0]), 1, mul);
      const tot = leaveOneOut(mi.map((m) => m[0] + m[1]), 1, mul);
      const res = [[zeros.all, tot.all - zeros.all]];
      for (let j = 0; j < mi.length; j++) {
        const othersAll0 = zeros.out[j];
        const othersTot = tot.out[j];
        res.push([
          mo[0] * othersAll0 + mo[1] * (othersTot - othersAll0),
          mo[1] * othersTot,
        ]);
      }
      return res;
    }
    case KIND.XOR: {
      // out XOR in1 XOR ... = 0, i.e. an even-parity constraint over all vars.
      const s = leaveOneOut(incoming.map((m) => m[0] + m[1]), 1, mul);
      const d = leaveOneOut(incoming.map((m) => m[0] - m[1]), 1, mul);
      return incoming.map((_, j) => [
        (s.out[j] + d.out[j]) / 2,
        (s.out[j] - d.out[j]) / 2,
      ]);
    }
    case KIND.EXACTLY_ONE:
    case KIND.AT_MOST_ONE: {
      const n = incoming.length;
      // counts capped at 2 ("two or more"), which both constraints forbid
      const fwd = [[1, 0, 0]];
      for (let i = 0; i < n; i++) {
        const p = fwd[i];
        const q = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          if (p[c] === 0) continue;
          q[c] += p[c] * incoming[i][0];
          q[Math.min(c + 1, 2)] += p[c] * incoming[i][1];
        }
        fwd.push(q);
      }
      const bwd = new Array(n + 1);
      bwd[n] = [1, 0, 0];
      for (let i = n - 1; i >= 0; i--) {
        const p = bwd[i + 1];
        const q = [0, 0, 0];
        for (let c = 0; c < 3; c++) {
          if (p[c] === 0) continue;
          q[c] += p[c] * incoming[i][0];
          q[Math.min(c + 1, 2)] += p[c] * incoming[i][1];
        }
        bwd[i] = q;
      }
      const exact = f.kind === KIND.EXACTLY_ONE;
      return incoming.map((_, j) => {
        const a = fwd[j], b = bwd[j + 1];
        const one = a[0] * b[0];
        let zero = a[0] * b[1] + a[1] * b[0];
        if (!exact) zero += a[0] * b[0];
        return [zero, one];
      });
    }
    default:
      throw new Error("no DP routine for " + f.kind);
  }
}

/** Messages from a factor to each of its variables, given the incoming messages. */
export function factorMessages(f, incoming) {
  if (f.table && f.size <= 4096) return genericMessages(f, incoming);
  if (DP_KINDS.has(f.kind)) return dpMessages(f, incoming);
  if (f.table) return genericMessages(f, incoming);
  throw new Error(`factor ${f.id} (${f.kind}) is too large and has no DP routine`);
}

export const SYMBOL = {
  [KIND.PRIOR]: "π",
  [KIND.EVIDENCE]: "!",
  [KIND.AND]: "∧",
  [KIND.OR]: "∨",
  [KIND.NOT]: "¬",
  [KIND.XOR]: "⊕",
  [KIND.IMPLIES]: "→",
  [KIND.IMPLIES_NOT]: "⊸",
  [KIND.IFF]: "↔",
  [KIND.IMPLIES_G]: "→?",
  [KIND.IMPLIES_NOT_G]: "⊸?",
  [KIND.IFF_G]: "↔?",
  [KIND.EXACTLY_ONE]: "=1",
  [KIND.AT_MOST_ONE]: "≤1",
  [KIND.PARAM_LINK]: "θ",
  [KIND.THETA_PRIOR]: "B",
};
