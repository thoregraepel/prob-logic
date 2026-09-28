# Probabilistic Logic Playground

Write down propositions and the logical relationships between them. The app compiles that into a
**factor graph**, attaches whatever evidence you have, and computes the marginal probability of every
proposition by **message passing**. It also ranks the experiments you could run next by expected
information gain per unit cost, and will plan a whole sequence for you.

Built from `prob-logic-spec.md`. No build step, no dependencies.

## Running it

ES modules need to be served over HTTP (opening `index.html` from the filesystem will not work):

```sh
node serve.mjs 8080      # then open http://localhost:8080/
# or: python3 -m http.server 8080
```

Verify the inference engines:

```sh
node tests/run-tests.mjs
```

48 checks, all against brute-force enumeration of the joint distribution or against known analytic
values. Nothing to install.

## What is in it

| Capability | Where |
|---|---|
| Binary propositions with fixed, Beta, or shared-Beta priors | `js/engine/model.js` |
| Implication →, exclusion ⊸, equivalence ↔, with a strength / reliability | `js/engine/compile.js` |
| Compound nodes: AND, OR, NOT, XOR gates — so you can write `(A₁ ∧ A₂) → B` | `js/engine/factors.js` |
| Mutual exclusion: exactly-one and at-most-one, with O(k) messages | `js/engine/factors.js` |
| Uncertain rules: infer whether a relationship holds at all | `js/engine/compile.js` |
| Hierarchical Bayes: Beta priors shared across propositions or rules | `js/engine/compile.js` |
| Loopy belief propagation | `js/engine/bp.js` |
| Exact inference by variable elimination | `js/engine/exact.js` |
| Gibbs sampling, with block moves and constraint relaxation | `js/engine/gibbs.js` |
| Expected information gain, cost-aware ranking, greedy planning | `js/engine/voi.js` |
| Eight worked examples | `js/examples/index.js` |
| Interactive editor, graph canvas, explanation panel | `js/ui/` |

## Two readings of "A implies B"

The single most consequential modelling decision, so both are available and switchable in the editor.

**Causal (noisy-OR)** — the default. Every rule pointing at `B` merges into one conditional:

```
P(B = 1 | parents) = [1 - (1-leak) · ∏_causes (1-pᵢ)^aᵢ] · ∏_inhibitors (1-qⱼ)^aⱼ
```

with `B`'s own prior as the leak. Marginals equal the priors you typed when nothing fires, `p = 1`
still gives exact modus ponens and modus tollens, and observing an effect raises its causes.

**Logical constraint** — the purer reading. Each rule is its own potential:

```
f(a, b) = p · [a → b] + (1 - p)
```

`p = 1` deletes the world where `a` is true and `b` is false. Correct, but not modular: a single hard
rule `A → B` with uniform priors leaves `P(A) = 1/3`, because one of four worlds is gone. Both
behaviours are asserted in the test suite.

## Layout

```
index.html            the shell
css/app.css           one stylesheet, light + dark
js/engine/            model, compilation, three inference engines, value of information
js/examples/index.js  the worked models
js/ui/                canvas, editor, results, about
tests/run-tests.mjs   verification suite
serve.mjs             static server
```

The **About** button inside the app has the full write-up: the factor library, the sum-product
equations, how the log-odds explanation decomposition works, the EIG derivation, how Beta parameters
are discretised, and what the app deliberately does not do.
