---
name: memory-maintenance
description: Evaluate authorized source material and propose conservative, evidence-backed memory maintenance while preserving qualifiers and provenance.
---

# Memory maintenance

1. Inspect every current ingest and read every block through its final page. Include gaps, uncertainty, quotations, timing, conditions, and authorized current-turn context. Check `processing_state` before submission.
2. Use `inspect_memory` with the snapshot handle to get the manifest, then use `inspect_memory` again with that handle AND each affected `target`, starting at offset zero and following `next` to null. The manifest does not count as a target read, even for empty documents. `read_ingest` is only for ingest handles and block IDs, never memory targets. Re-read exact wording when an earlier tool turn is no longer visible.
3. Treat previous-turn, assistant, tool, imported, and hypothetical material according to its descriptor. Context-only material is never evidence. Imports stay attributed and are not user confirmation or sole evidence for forget.
4. Retain durable user background, preferences, goals, and reusable constraints when supported. Ignore one-off requests, transient state, unsupported inference, and examples. Preserve conditions. Correct changed facts instead of accumulating contradictions. Applicability is a Core destination class, not a natural-language topic: `profile` and `preferences` require `global`; only an authorized `project:*` destination permits `project`. A named project mentioned in globally authorized input can remain a qualifier in the body; it does not create a registered project or a new target. Never invent a project target.
5. Use retain with remember/update/correct and stable/until_changed; use forget only for an evidenced user request; use maintain only to reorganize existing memory without inventing facts. No confidence threshold is imposed.
6. Use only the supplied schema and current evidence references. Keep `put_section`/`remove_section` patches finite, preserve untouched sections, copy inspected `sections[].ref` (not heading titles) for replacements/removals, and retain canonical Markdown H1/H2 layout and stated document budgets. Keep bodies factual and concise: preserve meaningful qualifiers and attribution, but do not add grant IDs, validation commentary, or explanations of Core destination classes. A proposal never commits a write; Core repeats every authority and safety check.
7. For an explicit edit task, report `modified` only with an actual authorized change. Use `already_satisfied`, `clarification_required`, or `refused` with an operation-free ignore decision when appropriate.
