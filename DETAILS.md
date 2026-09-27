# What this is for, and where it could go

Companion to [`README.md`](README.md). The README is the usage reference; this is the argument for
why the problem is worth solving and which parts are open for someone to pick up.

## The problem this actually solves

Backend teams increasingly want an LLM to make a *small, bounded decision*: which team owns this
alert, how severe is this error, does this migration need two reviewers. The usual implementation is
a prompt ending in "respond with JSON" and a parser hoping for the best. That fails in ways that are
hard to reason about: the model can name a category that does not exist, omit a field, or return text
where a number belonged, and every one of those becomes a runtime exception in a control-flow path
that used to be a switch statement.

Decision models address this by returning a **typed value drawn from an answer space you declared**,
with a probability attached. Code branches on it directly. That is a real improvement — but it moves
the difficulty rather than removing it. Now the risk is not malformed output, it is **a confidently
wrong label arriving in a shape your code trusts**. A parser exception is loud; a 0.95-probability
route to the wrong team is silent.

So the load-bearing question is not "can it emit valid JSON" but **"is it better than what I already
have, on my data, at the decisions I care about."**

**That question is currently unanswerable from anything published.** There is no held-out benchmark
for decision models in this space, and the material that exists is vendor-authored. This package is
the harness that lets an individual engineer answer it in about ten minutes.

## The specific design choice that makes it useful

Every domain ships with **two answerers scored identically**:

- a hosted decision model (needs a key), and
- a deterministic local heuristic baseline (needs nothing).

The baseline is not filler. It is the **control group**, and it is deliberately a real, tuned lexical
+ numeric scorer rather than a strawman. If a paid model cannot beat a keyword scorer on your log
taxonomy, the per-token spend is not justified — and no benchmark published by someone selling the
model will tell you that. Conversely, the baseline's failures localise exactly where learned
semantics earn their keep.

Run `npm run eval` and the bundled fixtures make the argument for you:

| Domain | Baseline choice accuracy | What the failure mode says |
|---|---|---|
| `log_error` | 83.3% | keyword overlap works well when error text is lexically distinctive |
| `pr_triage` | 83.3% | same — change-type vocabulary is stable and predictable |
| `incident_route` | **58.3%** | `"other"` chosen 41.7% of the time; `payments` F1 = **0.00** |
| `deploy_risk` | **58.3%** | `should_block` recall **0.60** — it misses dangerous deploys |

Routing is where lexical matching dies outright. "My payout has failed three times" shares almost no
vocabulary with the string "charges, refunds, payouts, settlement" — it takes world knowledge to know
a failed payout is a payments problem. That is the honest, reproducible case for a learned decision
model, made on numbers you generated locally rather than in a blog post.

Note also what is *not* claimed: these 48 fixtures are synthetic and small. They demonstrate the
method and expose the baseline's structural weakness. They do not certify anyone's accuracy.

## The part I would most want a reviewer's opinion on

The safety layer is **architectural, not aspirational** — that is the design idea here, separate from
Jev specifically.

Two properties, both under test:

1. **No policy can emit a destructive action.** There is no code path from a model answer to
   `delete`, `drop`, or automatic rollback. The most a model can cause is `require_manual_approval`.
2. **A wrong probability cannot bypass a hold.** Risk is checked on two independent axes — the
   `should_block` noul *and* the ordinal risk level — so over-confidence in one cannot open the gate
   alone:

```
node src/cli.js ask --domain deploy_risk \
  --json '{"summary":"rolling deploy touching 12 services at once","services_affected":12}'

should_block: p = 0.10                    # the answerer wrongly says "safe"
decision.action: require_manual_approval  # still held
decision.reason: risk high >= 3           # caught on the independent axis
```

This matters because the two error directions are not symmetric. A false "risky" costs an engineer
 thirty seconds of clicking approve. A false "safe" is an outage at 3am with an audit trail showing
 your automation waved it through. The design should encode that asymmetry, and it should be testable
 — hence `policies never auto-execute a destructive action` in the suite.

The generalisable claim: **any** probabilistic decision input into a privileged code path wants a
threshold policy that is (a) per-domain, (b) tuned by cost-of-mistake, and (c) incapable of being the
sole authority for an irreversible action. That holds whether the upstream is Jev, a chat model, or
your own fine-tune.

## Where this could go — open directions

Nothing below is built. Listed because they are the natural next increments and I would rather
someone pick one than have this stall.

**Highest value, lowest glamour: real fixtures.** Replace `data/*.jsonl` with 200–500 labeled rows
from actual postmortems, closed tickets, and merged PRs. This is the prerequisite for every other
item and needs no new code. If you contribute anything, contribute this.

**Cost-of-mistake weighting.** `binaryMetrics` already sweeps thresholds and reports the best F1, but
it treats a false positive and a false negative as equally bad. They are not. Let a caller declare
`{fnCost: 20, fpCost: 1}` — an outage versus an annoying approval prompt — and pick the threshold
minimising expected cost instead of maximising F1. The report structure already supports it; this is
roughly 30 lines.

**Confidence as a real quantity.** The baseline emits a lexical-overlap pseudo-confidence, and the
client trusts whatever probability the API returns. Neither is calibrated. A reliability diagram over
your own fixtures — binned predicted-p vs realised rate — would show whether 0.8 means 80%. A model
that is accurate but uncalibrated is still dangerous, because your thresholds are cut on the
probability axis. I suspect this is where the interesting results are.

**Per-domain regression gating.** `npm run eval` is deterministic for the baseline. Snapshot the
numbers, diff them in CI, and fail on degradation. Free, and it catches both your schema edits and
silent upstream model revisions — relevant because the endpoint here is alpha-flagged.

**A second control group.** Add a zero-cost prompt-to-JSON path against a regular chat model, so the
comparison becomes three-way: *keyword scorer vs chat model with a JSON prompt vs actual decision
model.* My guess is the middle option is closer to the third than people expect, and the harness
makes that checkable.

**Self-hosted mode.** Wire `--mode jev` to
[`simple-jev`](https://github.com/featherless-ai/simple-jev) instead of a hosted endpoint. Same
schemas, same eval, no egress, and it unlocks the fine-tuning path the hosted API does not offer.
The domain separation in `makeAnswerer()` exists so this is a new adapter, not a refactor.

**Labelled-data capture.** The boring flywheel: log every real decision and the human's correction,
then periodically re-score. Corrections on traffic you actually served are worth more than any
synthetic set here.

## What this deliberately is not

- **Not a general LLM wrapper.** Only bounded decisions — classification, ordered severity, binary
  probability. Deliberately no free-text generation, so the answer space stays checkable.
- **Not an autonomous remediation system.** It proposes; a human or a pre-existing policy disposes.
  The deploy-risk path is the strongest argument for keeping it that way.
- **Not evidence that Jev is good or bad.** No key was available when this was written, and the
  client is built to fail loudly rather than fabricate a response, so **no live numbers are claimed
  anywhere in this repo**. The `jev` mode is plumbing against a documented shape, not a benchmark.
  Run it yourself and find out — that is the entire point of shipping the control group.

## Contributing

Find a wrong answer space, a metric that misleads you, or a case where the baseline beats something
much more expensive — those are the contributions this project is short on. The schemas in
`src/schemas.js` are where the actual domain judgement lives, and the `criteria` strings are worth
editing hard: they are the only place you can teach the system what *your* team means by
"`capacity`" versus "`dependency`".

Open an issue with a fixture set from your own incident history, even a small one. Real labels are
the scarce resource here.
