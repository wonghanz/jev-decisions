# jev-decisions

Typed decision layer for backend engineering, plus the harness to prove whether it earns its keep.

Four production decisions get modelled here — log/error root-causing, incident routing, PR triage,
and deploy risk — each as a small, explicit **answer space** rather than a prompt asking an LLM to
"reply in JSON". Every domain ships with a labeled fixture set, a per-domain threshold policy, and a
**local heuristic baseline** so you can answer the only question that actually matters:

> Does a paid decision model beat a 200-line keyword scorer **on my data**?

You cannot answer that from a vendor's blog. You can answer it with `npm run eval`.

```bash
npm install
npm test          # 24 tests, no network, no keys
npm run eval      # baseline scored on bundled fixtures
npm run demo      # one worked example per domain
```

Zero runtime dependencies. Node 18+ (uses built-in `fetch` and `node:test`). No build step.

**Also read [`DETAILS.md`](DETAILS.md)** — why the control-group design matters, which number in the
table is the real argument, and the open directions worth picking up.

---

## Why this exists

"Decision models" (Jev, and the open `simple-jev` approach) return a **typed value with a
probability** instead of prose, so application code branches on it without parsing text. That is a
genuinely good idea for bounded backend tasks.

But the public material on them is vendor-authored, with **no held-out benchmarks anywhere**. So the
useful engineering artifact is not another tutorial — it is the eval harness that lets *you* produce
numbers for *your* workload. That is what this package is.

## The two answerers, scored the same way

| Mode | What it is | Needs |
|---|---|---|
| `baseline` | Deterministic lexical + numeric heuristics (`src/baseline.js`) | nothing |
| `jev` | Hosted decision API through OpenRouter (`src/client.js`) | `OPENROUTER_API_KEY` |

```bash
npm run eval                    # baseline
eval --mode jev                 # hosted model, same fixtures, same metrics
```

Compare the two reports. Anything the baseline already aces is not worth paying per-token for;
anything it fails badly is where a decision model may earn its place — or where your answer space is
wrong, which the `"other"` rate tells you.

### What the bundled run actually shows

`npm run eval` on the 48 synthetic fixtures shipped here, baseline mode:

| Domain | choice accuracy | notes |
|---|---|---|
| `log_error` | 83.3% | severity only 33.3% exact, MAE 0.92 |
| `pr_triage` | 83.3% | review-depth 41.7% exact |
| `incident_route` | 58.3% | `"other"` chosen **41.7%** of the time; `payments` F1 = 0.00 |
| `deploy_risk` | 58.3% | `"other"` 25%; `should_block` recall only 0.60 |

Read this as a demonstration of the *method*, not a claim about Jev. The fixtures are synthetic and
keyword-friendly, which flatters the baseline on classification and under-lines its real weakness:
lexical scoring has no world model, so it cannot route "my payout has failed three times" to a
payments team at all. Those two routing/risk domains are exactly where a decision model should win —
and `should_block` at recall 0.60 is precisely the failure mode you must not delegate blindly.

## The safety property, enforced not documented

Policies live in `src/policy.js` and are covered by tests. Two rules:

1. **No policy can emit a destructive action.** There is no code path from a model answer to
   `delete`, `drop`, or an automatic rollback. The worst outcome is `require_manual_approval`.
2. **A wrong probability cannot bypass a hold.** Risk is checked on two independent axes, so an
   over-confident `should_block` still gets caught by the ordinal rule:

```bash
$ node src/cli.js ask --domain deploy_risk \
    --json '{"summary":"rolling deploy touching 12 services at once","services_affected":12}'
  should_block: p = 0.10                 # baseline wrongly says "safe"
  decision.action: require_manual_approval
  decision.reason: risk high >= 3        # ordinal axis catches it
```

Routing defers to a human whenever the answerer picks `other` — an unsure model degrades to a person,
never to a guess.

## Layout

```
src/questions.js   choice/noul/score primitives, permissive response parsing, 32k input budget
src/schemas.js     the four answer spaces, with criteria written to disambiguate near-misses
src/baseline.js    deterministic lexical + numeric heuristics (the control group)
src/client.js      OpenRouter decision endpoint: retry w/ backoff, timeout, budget check
src/policy.js      per-domain thresholds and allowed actions
src/eval.js        precision/recall/F1, ordinal MAE & within-1, noul threshold sweep
src/redact.js      credential scrubbing before anything leaves the process
data/*.jsonl       48 labeled fixtures
```

## Using it as a library

```js
import { runPipeline } from 'jev-decisions';

const { answers, decision } = await runPipeline({
  domain: 'incident_route',
  state: { message: 'My payout has failed three times.', days_waiting: 3 },
  mode: 'jev',
});

if (decision.action === 'queue_for_human') await escalate(ticket.id);
else await routeToTeam(ticket.id, decision.action.slice('route:'.length));
```

Thresholds are data, not code:

```js
import { POLICIES } from 'jev-decisions';
POLICIES.incident_route.escalate_at = 0.65;   // tune on YOUR fixtures
```

## Bringing your own data

Add a line per decision you have history for and re-run:

```jsonc
{"id":"T-01","state":{"message":"...","days_waiting":3},
 "expected":{"team":"payments","urgency":"high","needs_human":true}}
```

Author labels from real postmortems and closed tickets, not from the taxonomy you wish you had.
Then watch the `"other"` rate: a high rate means **your answer space is wrong**, not the model. The
threshold sweep in the report exists because a shared 0.5 cutoff across domains is a bug — the cost
of a false "safe" deploy and a false "novel" log line are nothing alike.

## Secrets and egress

`state` leaves your boundary. `src/redact.js` scrubs AWS/OpenAI/HF/GitHub token shapes, JWTs,
`user:pass@host` URLs, and `password=`-style pairs before sending, and reports how many were removed
(`redactedFields`). Emails and card-like digit runs are opt-in because they alter meaning.

Redaction is a seatbelt, not a policy answer: decide what you will let a third party see, and set
retention and training-use terms with the vendor first. Keys come from env vars only —
`OPENROUTER_API_KEY`, never a literal, and never committed.

## Honest limitations

- **Fixtures are synthetic and small** (12/domain). Enough to exercise the harness and expose the
  baseline's blind spots; far too little to certify accuracy. Replace with your history.
- **No live Jev numbers are published here.** No key was available when this was written, and the
  client is built to fail loudly rather than fabricate — so nothing in this README is a claim about
  that model's quality. Run `--mode jev` yourself.
- **Wire format is partly inferred** from vendor docs. Parsing accepts several plausible shapes, and
  `/api/alpha/decisions` is alpha-flagged: an upstream revision can break it. Pin
  `typesafe/jev-1.13` rather than `~typesafe/jev-latest` if you depend on it.
- **The baseline is genuinely mediocre** on routing and risk, which is the point — a control group
  that always loses proves nothing.
- **Provider durability is unknown.** The vendor's footprint is thin and self-referential; keep the
  eval fixtures so you can move to a self-hosted [`simple-jev`](https://github.com/featherless-ai/simple-jev)
  (Apache-2.0, real fine-tuning path) if this disappears.

## See also

- `jev-backend-engineering-research.md` — the source-credibility assessment and API verification
  this package was built from.
- [OpenRouter Jev docs](https://openrouter.ai/docs/guides/community/jev) ·
  [featherless-ai/simple-jev](https://github.com/featherless-ai/simple-jev)

## License

MIT — see `LICENSE`.
