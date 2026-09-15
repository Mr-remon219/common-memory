import * as z from 'zod/v4';
import { DIAGNOSTIC_REASONS, DIAGNOSTIC_STAGES } from '../core/contracts/diagnostic.js';
export { nextForAcceptance, nextForOutcome } from '../v2/service-guidance.js';

/** Transport framing budget, not a source-text or model context limit. */
export const MCP_MAX_MESSAGE_BYTES = 1024 * 1024;
export const contextIdSchema = z.string().max(160).regex(/^(global|project:[A-Za-z0-9_-]{1,128})$/)
  .describe('Use an exact context ID from memory_status({}). global is personal memory; project:<id> is a registered project, not a path or project name.');
export const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const submissionIdentity = {
  submissionId: idSchema.describe('Stable ID for this complete user expression, e.g. a UUID. Keep unchanged on retry and in status queries.'),
  conversationId: idSchema.optional().describe('Stable conversation ID. If supplied, repeat it in every retry and status query; omission uses a different namespace.'),
};
export const statusInput = z.object({
  submissionId: submissionIdentity.submissionId.optional(),
  conversationId: submissionIdentity.conversationId,
  importId: idSchema.optional().describe('The original importId; mutually exclusive with submissionId and conversationId.'),
}).strict();
const nextSchema = z.object({
  action: z.enum(['poll', 'read', 'review', 'correct', 'discover', 'wait']),
  message: z.string(),
  tool: z.enum(['memory_status', 'memory_read']).optional(),
  arguments: z.object({submissionId:idSchema.optional(),conversationId:idSchema.optional(),importId:idSchema.optional(),contextId:contextIdSchema.optional()}).strict().optional(),
  retryAfterMs: z.number().int().nonnegative().optional(),
}).strict();
export type NextStep = z.infer<typeof nextSchema>;
export const acceptanceOutput = z.object({
  taskId:z.string().optional(), accepted: z.literal(true), duplicate: z.boolean(), state: z.string(), contextId: contextIdSchema, next: nextSchema,
}).strict();
export const readOutput = z.object({
  guidance:z.string().optional(),
  contexts: z.array(z.string()),
  documents: z.array(z.object({target:z.string(),content:z.string(),bytes:z.number().int().nonnegative(),empty:z.boolean()}).strict()),
  empty: z.boolean(),
}).strict();
const outcomeSchema = z.object({
  editResult:z.enum(['modified','already_satisfied','clarification_required','refused']).optional(),
  state:z.string(),issue:z.string().nullable(),retainedIn:z.array(z.string()),jobId:z.string().nullable(),jobState:z.string().nullable(),
  attempts:z.number().int().nonnegative(),automaticRecoveries:z.number().int().nonnegative().optional(),retryAt:z.number().nullable(),
  diagnostic:z.object({stage:z.enum(DIAGNOSTIC_STAGES),reason:z.enum(DIAGNOSTIC_REASONS),retryable:z.boolean(),httpStatus:z.number().int().optional(),proxyStatus:z.number().int().optional()}).strict().nullable(),
}).strict();
// Object-root schema preserves the existing wire envelopes on legacy and current MCP.
export const statusOutput = z.object({
  capabilities:z.array(z.enum(['relay','init','read'])).optional(),
  submissionEnabled:z.boolean().optional(),initEnabled:z.boolean().optional(),readEnabled:z.boolean().optional(),contexts:z.array(z.string()).optional(),
  limits:z.object({maxInputBytes:z.number().nullable(),maxMessageBytes:z.number(),maxSourceBytes:z.number().nullable().optional(),deprecatedLimits:z.array(z.string()).optional()}).strict().optional(),
  submission:outcomeSchema.nullable().optional(),import:outcomeSchema.nullable().optional(),next:nextSchema,
}).strict();

const errorHelp: Record<string, string> = {
  SUBMISSION_DISABLED:'This connection cannot submit user turns. Call memory_status({}); local relay opt-in and user_explicit disclosure must be authorized by the user.',
  INIT_DISABLED:'This connection cannot import. Call memory_status({}); an init profile and agent_observation disclosure must be authorized by the user.',
  READ_DISABLED:'This connection cannot read memory. Use a read-enabled connection; do not switch scope to bypass permissions.',
  STATUS_UNAVAILABLE:'Item status requires the matching relay or init profile on the original client. A read-only connection can only call memory_status({}).',
  CONTEXT_UNAVAILABLE:'Call memory_status({}) for currently authorized context IDs. Do not guess a project ID or silently redirect its data to global.',
  INVALID_TEXT_SIZE:'Supply nonempty complete material within the configured UTF-8 byte limit (imports include their envelope). Do not truncate or drop conditions; ask the user to adjust limits or choose a smaller complete source.',
  INVALID_SUBMISSION_ID:'Use memory_status({}), or submissionId with the original optional conversationId, or importId alone. IDs use 1–128 ASCII letters, digits, underscore or hyphen.',
  INVALID_IMPORT_LABEL:'Use a source label of 1–64 ASCII letters, digits, spaces, dot, underscore, colon or hyphen, starting with a letter or digit. Put full source details in understanding/gaps.',
  INVALID_IMPORT_BASIS:'Choose saved_memories, chat_history, current_conversation, project_context, mixed or unknown based on material actually accessed.',
  SUBMISSION_CONFLICT:'This ID already identifies different content or scope. Retry with the original payload. Use a new ID only for genuinely new material, not to bypass this conflict.',
  CANCELLED:'The operation was cancelled. Check status with the original IDs before retrying; cancellation does not retract an already accepted item.',
  SENSITIVE_CONTENT_REJECTED:'The complete source exceeded a configured byte limit or failed sensitive-content checks. Do not truncate or rename fields to bypass checks; ask the user to review the material and limits.',
  MEMORY_UNAVAILABLE:'The backend could not complete this operation. Ask the user to inspect Common Memory configuration/status. If acceptance was uncertain, check the original IDs before retrying. Internal details are withheld.',
};
export function toolFailure(error: unknown) {
  const supplied = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.message : '';
  const code = Object.hasOwn(errorHelp,supplied) ? supplied : 'MEMORY_UNAVAILABLE';
  const value = {code,message:errorHelp[code]!};
  return {content:[{type:'text' as const,text:JSON.stringify(value)}],structuredContent:value,isError:true};
}
