# V2 bounded evaluation

`npm run build && node scripts/evaluate-v2.mjs` runs all 30 synthetic trajectories
through the actual Writer, runtime queue, protocol validator and Markdown commit path
under every-turn, fixed-six and hybrid scheduling. All policies flush their tail batch.
There are five retain, update, forget, ignore, conditional preference and project-scope
cases each. Variable pauses exercise idle maintenance. Fixtures contain explicit oracle
actions used only by the scripted model, never by production semantic admission.

The JSON report records final-state correctness, project-to-global scope errors, model
calls, serialized input bytes, real token usage when available, failed/retry outcomes,
and capture-to-model latency. Scripted token counts are zero (unknown/not measured),
not estimates. These comparisons measure execution and scheduling; they do not show
that any real model correctly interprets natural-language evidence. In particular,
conditional wording and ignore correctness are supplied by the oracle.

Real-model quality is separate, paid and opt-in:

```sh
COMMON_MEMORY_EVAL_CONFIRM=paid-remote-disclosure node scripts/evaluate-v2.mjs --real --limit=3
```

This uses configured credentials but creates isolated temporary runtime/canonical
roots, never writes production memory, and discloses synthetic fixture text only.
`--limit` is 1–30; total model calls have a hard cap of 630. No automatic provider
fallback is used. Final-state exact-match is deliberately strict and can count a
semantically correct paraphrase as a failure: inspect outputs before drawing quality
conclusions. Broader human-reviewed over-memory/generalization precision/recall and
real provider token/cost results remain unverified until this opt-in run is performed.

The final scripted evaluation is repeated ten times with freshly generated host IDs.
`v2-evaluation-repeat-results.json` records all 900 trajectory-policy executions.
Failure codes are retained in metrics rather than hiding failed calls behind a final
state match. A prior UUID/card-scanner false positive was reproduced and fixed; see
`v2-verification.md` for the regression record.
