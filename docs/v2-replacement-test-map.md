# V2 regression replacement map

Old Fact/Proposal/Review serialization, FTS/Recall/ranking/context pack, governance/Undo,
Fact compiler/policy and old extraction scheduler tests are intentionally retired with
their product surfaces, not interpreted as V2 successes.

Preserved invariants are re-established under `tests/v2`: source authentication and
ambiguous-delivery quarantine; durable delivered observations independent of assistant
success; FIFO/retry/lease fencing; atomic Markdown/receipt recovery and CAS; unchanged
Section bytes; invalid decisions produce zero canonical pollution; full-turn limits.
Provider request bounds, credential protection, refusal/timeout/cancellation and local
configuration privacy retain their dedicated existing adapter/config tests.

Mocked maintenance responses test the contract/executor only, not model semantic quality.
