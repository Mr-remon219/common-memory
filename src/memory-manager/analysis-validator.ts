import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { memoryAnalysisSchema } from "./contracts/analysis-schema.js";
import type { AnalysisRequestContext, MemoryAnalysis, MemoryAnalysisAction } from "./contracts/analysis.js";
import { MemoryManagerError } from "./contracts/errors.js";

const ajv = new Ajv2020({ strict: true, allErrors: true });
(addFormatsModule as unknown as (instance: Ajv2020) => Ajv2020)(ajv);
const validate = ajv.compile(memoryAnalysisSchema);
const MAX_STATEMENT = 10_000; const MAX_REASON = 4_000; const MAX_TAG = 128;

export function validateMemoryAnalysis(value: unknown, context: AnalysisRequestContext): MemoryAnalysis {
  if (!validate(value)) invalid("analysis.schema", sanitize(validate.errors));
  const analysis = value as MemoryAnalysis;
  if (analysis.request_id !== context.requestId || analysis.based_on_knowledge_revision !== context.knowledgeRevision || analysis.based_on_store_revision !== context.storeRevision) invalid("analysis.echo_mismatch");
  if (new Set(analysis.actions.map((action) => JSON.stringify(action))).size !== analysis.actions.length) invalid("analysis.duplicate_action");
  const writeActions = analysis.actions.filter((action) => action.action !== "no_op");
  if (writeActions.length > context.maxWriteActions) invalid("analysis.action_budget");
  if (analysis.actions.some((action) => action.action === "no_op") && analysis.actions.length !== 1) invalid("analysis.no_op_mixed");
  const touched = new Set<string>();
  for (const [index, action] of analysis.actions.entries()) validateAction(action, context, touched, index);
  unique(analysis.abstained_reason_codes, "/abstained_reason_codes");
  return analysis;
}
function validateAction(action: MemoryAnalysisAction, context: AnalysisRequestContext, touched: Set<string>, index: number): void {
  const path = `/actions/${index}`;
  unique(action.target_fact_ids, `${path}/target_fact_ids`); unique(action.evidence_refs, `${path}/evidence_refs`); unique(action.tags, `${path}/tags`);
  if (action.action !== "no_op" && action.evidence_refs.length !== 1) invalid("analysis.single_evidence_required", [{ field_path: `${path}/evidence_refs` }]);
  if (action.expires_at !== null && Number.isNaN(Date.parse(action.expires_at))) invalid("analysis.datetime", [{ field_path: `${path}/expires_at` }]);
  if (action.statement !== null && (byteLength(action.statement) === 0 || action.statement.length > MAX_STATEMENT)) invalid("analysis.string_length", [{ field_path: `${path}/statement` }]);
  if (action.reason.length === 0 || action.reason.length > MAX_REASON || action.tags.some((tag) => tag.length === 0 || tag.length > MAX_TAG)) invalid("analysis.string_length", [{ field_path: path }]);
  if (action.scope !== null && !context.allowedScopes.has(action.scope)) invalid("analysis.scope_not_allowed", [{ field_path: `${path}/scope` }]);
  for (const ref of action.evidence_refs) if (!context.evidenceRefs.has(ref)) invalid("analysis.unknown_evidence", [{ field_path: `${path}/evidence_refs` }]);
  for (const id of action.target_fact_ids) {
    if (!context.candidateFactIds.has(id)) invalid("analysis.unknown_target", [{ field_path: `${path}/target_fact_ids` }]);
    if (touched.has(id)) invalid("analysis.target_overlap", [{ field_path: `${path}/target_fact_ids` }]); touched.add(id);
  }
  if (context.mode === "extract" && !new Set(["add", "modify", "replace", "expire", "no_op"]).has(action.action)) invalid("analysis.mode_action", [{ field_path: `${path}/action` }]);
  if (context.mode === "consolidate" && new Set(["modify", "replace", "expire"]).has(action.action)) invalid("analysis.mode_action", [{ field_path: `${path}/action` }]);
}
function unique(values: readonly string[], fieldPath: string): void { if (new Set(values).size !== values.length) invalid("analysis.duplicate", [{ field_path: fieldPath }]); }
function byteLength(value: string): number { return Buffer.byteLength(value, "utf8"); }
function sanitize(errors: ErrorObject[] | null | undefined): object[] { return (errors ?? []).map(({ instancePath, keyword }) => ({ field_path: instancePath || "/", rule_id: `schema.${keyword}` })); }
function invalid(rule: string, violations: readonly object[] = []): never { throw new MemoryManagerError("INVALID_ANALYSIS", "Memory analysis failed validation", { rule_id: rule, violations }); }
