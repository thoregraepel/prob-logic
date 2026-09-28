// The "About" reference: how to use the playground and what it does internally.

import { h } from "./dom.js";

const eq = (t) => h("pre", { class: "eq" }, t);
const p = (...c) => h("p", {}, ...c);
const code = (t) => h("code", {}, t);

export function aboutContent() {
  return h("article", { class: "about" },
    h("h2", {}, "Probabilistic inference on logical relationships"),
    p("Write down propositions and the logical relationships between them. The app turns that into a ",
      h("strong", {}, "factor graph"), ", attaches whatever evidence you have, and computes the marginal probability of every proposition by message passing. ",
      "It also works out which experiment you should run next, and how much that is worth."),

    h("h3", {}, "Using it"),
    h("ol", {},
      h("li", {}, h("strong", {}, "Pick an example"), " from the left rail. Each one comes with a short list of things to try."),
      h("li", {}, h("strong", {}, "Click any node"), " — in the graph or in the Beliefs list — to open its editor and see its explanation."),
      h("li", {}, h("strong", {}, "Set evidence"), " with the unknown / TRUE / FALSE / soft control. Soft evidence is a likelihood, not a probability: you supply P(observation | proposition)."),
      h("li", {}, h("strong", {}, "Watch the Experiments tab"), ". It ranks every experiment you could buy by expected information gain, and the planner will run a whole sequence for you."),
      h("li", {}, h("strong", {}, "Switch engines"), " in the Engines tab and compare. Exact inference is the ground truth; loopy BP is fast but can drift; Gibbs sampling shows you what hard constraints do to MCMC.")),
    p("Drag nodes to rearrange, scroll to zoom, double-click the background to fit. Everything runs locally; ",
      code("Copy link"), " puts the entire model in the URL so you can share or bookmark it."),

    h("h3", {}, "The model"),
    p("A factor graph is a product of non-negative potentials over discrete variables:"),
    eq("P(x₁, …, xₙ)  =  (1/Z) · ∏ₐ fₐ(xₐ)        where xₐ is the tuple of variables factor a touches"),
    p("Every proposition is one binary variable. Everything else — priors, rules, gates, observations, mutual exclusion, parameters — is a factor. ",
      "Z is the partition function; if it comes out zero, your constraints contradict each other and the app says so."),

    h("h4", {}, "Factors in the library"),
    h("table", { class: "grid" },
      h("thead", {}, h("tr", {}, h("th", {}, "factor"), h("th", {}, "potential"), h("th", {}, "notes"))),
      h("tbody", {},
        h("tr", {}, h("td", {}, "prior π"), h("td", { class: "mono" }, "f(x) = p if x else 1−p"), h("td", {}, "one number per proposition")),
        h("tr", {}, h("td", {}, "evidence !"), h("td", { class: "mono" }, "f(x) = P(obs | x)"), h("td", {}, "hard evidence is the degenerate case [0,1]")),
        h("tr", {}, h("td", {}, "AND ∧ / OR ∨ / NOT ¬ / XOR ⊕"), h("td", { class: "mono" }, "f(y, x₁…xₖ) = [y = op(x)]"), h("td", {}, "deterministic; gives compound nodes")),
        h("tr", {}, h("td", {}, "implication →"), h("td", { class: "mono" }, "see below"), h("td", {}, "two possible readings — the choice matters")),
        h("tr", {}, h("td", {}, "exclusion ⊸"), h("td", { class: "mono" }, "A → ¬B"), h("td", {}, "an inhibitor")),
        h("tr", {}, h("td", {}, "equivalence ↔"), h("td", { class: "mono" }, "p·[a = b] + (1−p)"), h("td", {}, "always symmetric, so always a constraint")),
        h("tr", {}, h("td", {}, "exactly-one =1 / at-most-one ≤1"), h("td", { class: "mono" }, "[Σᵢ xᵢ = 1]"), h("td", {}, "O(k) messages by a count DP")),
        h("tr", {}, h("td", {}, "Beta prior B"), h("td", { class: "mono" }, "f(θₖ) ∝ θₖ^{α−1}(1−θₖ)^{β−1}"), h("td", {}, "on a midpoint grid over (0,1)")),
        h("tr", {}, h("td", {}, "parameter link θ"), h("td", { class: "mono" }, "f(θ, x) = θ if x else 1−θ"), h("td", {}, "a Bernoulli draw from a random rate")))),

    h("h4", {}, "Two readings of “A implies B”"),
    p("This is the most consequential modelling choice in the app, so both are available and you can flip between them in the editor."),
    h("p", {}, h("strong", {}, "Logical constraint."), " Down-weight every world that breaks the rule:"),
    eq("f(a, b) = p · [a → b] + (1 − p)"),
    p("Pure and symmetric: with p = 1 the rule simply deletes the world (A true, B false), which gives you exact modus ponens and modus tollens. ",
      "But it is ", h("em", {}, "not modular"), ": adding a rule out of A changes A's marginal even with no evidence anywhere. ",
      "With a uniform prior on both, a single hard rule A → B leaves P(A) = 1/3, not 1/2, because one of four worlds has been removed. ",
      "That is correct, and it is also why a chain of such rules makes a well-connected node look implausible before you have observed anything."),
    h("p", {}, h("strong", {}, "Causal (noisy-OR)."), " Merge every rule pointing at B into one conditional distribution:"),
    eq("P(B = 1 | parents)  =  [ 1 − (1 − leak) · ∏_{i ∈ causes} (1 − pᵢ)^{aᵢ} ] · ∏_{j ∈ inhibitors} (1 − qⱼ)^{aⱼ}"),
    p("The leak is B's own prior, so B's marginal equals the number you typed whenever none of its causes fire. ",
      "pᵢ reads as “P(B | this cause alone)”. Two independent causes of strength ½ give 1 − ¼ = 0.75. ",
      "p = 1 still gives exact modus ponens and modus tollens, observing an effect still raises its causes, and rival causes still explain each other away — but now the priors mean what they say. ",
      "This is the default, and it is what makes the diagnosis examples behave sensibly."),
    p(h("em", {}, "Biconditionals"), " are inherently symmetric, so they stay constraint factors in both modes."),

    h("h4", {}, "Compound nodes"),
    p("A compound node is a deterministic gate: ", code("A₁ ∧ A₂"), " is a variable pinned to the conjunction of its inputs by an AND factor. ",
      "You can then point rules at it, which is how you express ", code("(A₁ ∧ A₂) → B"), ". ",
      "The fault-analysis example uses this for a mirrored disk array: each disk failing is plausible, both failing together is not."),

    h("h4", {}, "Mutually exclusive propositions"),
    p("An ", code("exactly-one"), " constraint over k propositions is a single factor that zeroes out every assignment with a count other than one. ",
      "Naively that is 2ᵏ work per message; the app uses a forward/backward dynamic program over the running count (capped at “two or more”, since both constraint types forbid it), which is O(k). ",
      "This is what makes multiple-choice questions behave properly: eliminating one option redistributes its mass over the survivors rather than leaving it stranded."),

    h("h3", {}, "Inference"),
    h("h4", {}, "Sum-product belief propagation"),
    eq("m_{i→a}(x)  =  ∏_{b ∈ N(i) \\ a} m_{b→i}(x)\n" +
       "m_{a→i}(x)  =  Σ_{x_a : xᵢ = x} fₐ(x_a) · ∏_{j ∈ N(a) \\ i} m_{j→a}(x_j)\n" +
       "b_i(x)      ∝  ∏_{a ∈ N(i)} m_{a→i}(x)"),
    p("Messages are renormalised every step so long chains of near-hard constraints do not underflow. ",
      "On a tree this is exact. With loops it is an approximation that may oscillate, which is what the damping control and the residual trace in the Engines tab are for. ",
      "The fault-analysis example has genuine loops and is the place to look: loopy BP puts “rack power lost” near 31% where the exact answer is 10%."),

    h("h4", {}, "Exact inference"),
    p("Variable elimination with a greedy minimum-size ordering, run once per query variable. It gives ground truth and the log partition function, ",
      "at a cost exponential in the width of the elimination order — so it can refuse on large models and fall back to BP, and it says when it does."),

    h("h4", {}, "Gibbs sampling"),
    p("Sweep through the variables resampling each from its conditional given the rest. Two things go wrong with logic, and the playground shows both. ",
      "Deterministic factors make the chain reducible: an AND gate can pin its own inputs, so no single-variable move is legal. ",
      "The sampler therefore relaxes every factor by a floor ε and adds block moves over exactly-one groups (resampling which member is true, jointly). ",
      "Turn ε down to zero on a model with hard constraints and watch it get stuck — that is the lesson, not a bug."),

    h("h3", {}, "Explaining a belief"),
    p("Because the belief is a product of incoming messages, the log-odds is a sum:"),
    eq("log₂ [ b(1) / b(0) ]  =  Σₐ log₂ [ m_{a→i}(1) / m_{a→i}(0) ]"),
    p("So every neighbouring factor contributes an independent, additive number of bits, and the Explain tab just draws those as a diverging bar chart. ",
      "The decomposition always comes from belief propagation, even when the numbers on display came from exact inference or sampling, because only message passing produces per-factor terms."),

    h("h3", {}, "Deciding what to measure"),
    p("For a candidate experiment with outcomes o and a query Q, the expected information gain is the mutual information I(Q; O):"),
    eq("P(o)     =  Σₓ P(target = x) · P(o | target = x)\n" +
       "EIG(t)   =  H(Q) − Σ_o P(o) · H(Q | o)        [bits]\n" +
       "value    =  EIG(t) / cost(t)                  [bits per unit spent]"),
    p("Each outcome is evaluated by literally re-running inference with that outcome's likelihood factor attached. ",
      "Under exact inference EIG is never negative; loopy BP can produce a small negative value, which is a useful warning that the approximation is straining. ",
      "You can score against the entropy of one question or against the summed entropy of everything."),
    p("The planner is greedy: score every affordable experiment, buy the best, sample its outcome from the current predictive distribution, repeat until the budget runs out or nothing is worth its price. ",
      "Greedy is not optimal — information can be complementary, so a pair of experiments may be worth more than the sum of its parts — but it is the standard baseline and it is cheap."),

    h("h3", {}, "Distributions over distributions"),
    p("A proposition's prior can be a fixed number, or a Beta distribution, or a Beta ", h("em", {}, "shared"), " with other propositions. ",
      "The Beta is discretised onto a grid of midpoints and carried as an ordinary categorical variable, so the same message passing handles it with no special cases. ",
      "With a 21-point grid the posterior mean is accurate to about three decimal places against the analytic conjugate answer."),
    p("Sharing is where it gets interesting. In the supplier example, ten components share one defect rate θ ~ Beta(1,1). ",
      "Inspecting six of them (two defective, four good) moves θ̄ to exactly 3/8, and the four uninspected components inherit that number. ",
      "With independent fixed priors, inspecting one component would tell you nothing at all about the others."),

    h("h3", {}, "Beliefs about the relationships themselves"),
    p("A rule's reliability can also be unknown. Set it to “learn (Beta)” or bind it to a shared parameter, and the app adds a binary variable ",
      code("holds"), " for that rule, with the Beta parameter as its prior:"),
    eq("f(a, b, r)  =  [a → b]  if r = 1\n             =  1        if r = 0"),
    p("A counterexample — antecedent true, consequent false — proves that instance of the rule did not hold, which drags the shared reliability down. ",
      "A confirming instance is weaker evidence, because the consequent might have been true anyway. ",
      "The drug/rash example shows exactly that asymmetry: four confirmations and two counterexamples move ρ̄ from 0.50 to about 0.58, not to 4/6."),

    h("h3", {}, "What it does not do"),
    h("ul", {},
      h("li", {}, "Only binary propositions (plus discretised parameters). No multi-valued or continuous variables."),
      h("li", {}, "Greedy one-step lookahead for experiment selection, not a full sequential decision problem."),
      h("li", {}, "No structure learning: the propositions and rules are yours to write, only their parameters can be inferred."),
      h("li", {}, "Loopy BP gives no error bars. Compare against exact inference when the model has loops — that is what the comparison button is for."),
      h("li", {}, "In causal mode a cyclic set of rules is still a perfectly well-defined factor graph, but it is no longer a Bayesian network, so the conditionals no longer compose as a generative story.")),

    h("h3", {}, "Checking the arithmetic"),
    p("The engines ship with a verification suite that checks every factor's fast message routine against dense enumeration, ",
      "both semantics against brute-force enumeration of the joint, BP against exact on trees and loops, Gibbs against exact, ",
      "the Beta-Bernoulli posterior against its analytic conjugate value, and the information-theoretic identities that EIG must satisfy. ",
      "Run it with ", code("node tests/run-tests.mjs"), "."));
}
