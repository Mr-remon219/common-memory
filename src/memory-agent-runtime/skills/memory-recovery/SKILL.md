---
name: memory-recovery
description: Recover safely after a rejected proposal, tool error, or interrupted model stream without inventing coverage, evidence, or authority.
---

# Memory recovery

Use this only after Core explicitly permits recovery.

1. Keep the same task request ID, Agent transcript, working notes, and Core read grant. A retry permit is not new authority.
2. Read the structured local error category. Never infer details from provider prose or repeat secrets, rejected arguments, or raw error text.
3. After a tool error, correct only that call. Use current handles and contiguous offsets. Check `processing_state`; never claim that interrupted or failed reads completed.
4. After a proposal rejection, change the rejected structure, evidence, target, or coverage issue and submit the entire corrected proposal using the original schema. For `UNAUTHORIZED_SCOPE`, `profile`/`preferences` require `applicability: global`; `project` is only for an authorized `project:*` destination. Preserve natural-language project/temporal qualifiers in the body. For unread-target/source errors, finish the exact paginated read instead of changing or inventing references. Core will validate everything again.
5. After a stream interruption, continue from retained messages. Preserve partial reasoning and source references, but re-read supporting source or target pages when exact wording is required.
6. If recovery is denied, cancellation is requested, the lease is lost, context cannot be preserved, or the turn limit is reached, stop. Do not create another retry loop.
