import { externalPreflight } from "../core/safety/external-preflight.js";
import type { Fact } from "../core/contracts/types.js";
import type { RemoteDisclosurePolicy } from "../memory-manager/contracts/disclosure.js";
import { validateDisclosurePolicy } from "../memory-manager/contracts/disclosure.js";
import type { MemoryModelPort } from "../memory-manager/contracts/model-port.js";
import type { RecallPlannerInput, RecallPlannerOptions, RecallPlannerOutcome, RecallPlannerPort } from "./contracts.js";
import { recallPlanSchema } from "./plan-schema.js";
import { validateRecallRouteDecision } from "./plan-validator.js";
import { RECALL_ROUTER_PROMPT_V1 } from "./recall-prompt.js";

export class RemoteRecallPlanner implements RecallPlannerPort {
  readonly #model: MemoryModelPort;
  readonly #policy: RemoteDisclosurePolicy;

  constructor(options: { model: MemoryModelPort; disclosurePolicy: RemoteDisclosurePolicy }) {
    validateDisclosurePolicy(options.disclosurePolicy);
    this.#model = options.model;
    this.#policy = Object.freeze({
      ...options.disclosurePolicy,
      allowedScopes: Object.freeze([...options.disclosurePolicy.allowedScopes]),
      allowedProvenance: Object.freeze([...options.disclosurePolicy.allowedProvenance]),
    });
  }

  async plan(input: RecallPlannerInput, options: RecallPlannerOptions): Promise<RecallPlannerOutcome> {
    const candidates = input.initialResults
      .filter(({ fact }) => this.#policy.allowedScopes.includes(scopeToken(fact)) && this.#policy.allowedProvenance.includes(fact.provenance.type))
      .map(({ fact, match_reasons }) => ({
        fact_id: fact.id,
        statement: fact.statement,
        kind: fact.kind,
        scope: scopeToken(fact),
        priority: fact.priority,
        tags: fact.tags,
        match_reasons,
      }));
    const projection = deepFreeze({
      contract_version: "recall_router_input_v1",
      request_id: input.requestId,
      based_on_knowledge_revision: input.knowledgeRevision,
      query: input.request.query,
      initial_retrieval_degraded: input.initialRetrievalDegraded,
      candidates,
    });
    externalPreflight(projection, this.#policy);
    const result = await this.#model.analyze(
      { prompt: RECALL_ROUTER_PROMPT_V1, projection, schema: recallPlanSchema, schemaName: "recall_plan_v1" },
      { requestId: input.requestId, deadlineMs: options.deadlineMs, ...(options.signal ? { signal: options.signal } : {}) },
    );
    if (result.kind === "refusal") return { kind: "refusal", usage: result.usage };
    return {
      kind: "decision",
      decision: validateRecallRouteDecision(result.body, { requestId: input.requestId, knowledgeRevision: input.knowledgeRevision, request: input.request }),
      usage: result.usage,
    };
  }
}

function scopeToken(fact: Fact): string { return fact.scope.type === "global" ? "global" : `${fact.scope.type}:${fact.scope.id}`; }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
