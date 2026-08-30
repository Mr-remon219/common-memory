import { Ajv2020 } from "ajv/dist/2020.js";
import type { RecallRequest } from "../core/contracts/dto.js";
import type { Revision } from "../core/contracts/types.js";
import { recallPlanSchema } from "./plan-schema.js";
import type { RecallRouteDecision } from "./contracts.js";
import { RecallPlannerError } from "./contracts.js";

const validate = new Ajv2020({ strict: true, allErrors: true }).compile(recallPlanSchema);

export function validateRecallRouteDecision(value: unknown, expected: { requestId: string; knowledgeRevision: Revision; request: RecallRequest }): RecallRouteDecision {
  if (!validate(value)) throw new RecallPlannerError();
  const decision = value as RecallRouteDecision;
  if (decision.request_id !== expected.requestId || decision.based_on_knowledge_revision !== expected.knowledgeRevision) throw new RecallPlannerError();
  const original = expected.request.query.trim();
  const queries = decision.queries.map((query) => query.trim());
  if (queries.some((query) => !query || Buffer.byteLength(query, "utf8") > 4_096) || new Set(queries).size !== queries.length) throw new RecallPlannerError();
  if (decision.mode === "algorithm" && (queries.length !== 1 || queries[0] !== original)) throw new RecallPlannerError();
  if (decision.mode === "hybrid" && queries[0] !== original) throw new RecallPlannerError();
  return { ...decision, queries };
}
