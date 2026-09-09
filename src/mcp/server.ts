import { MEMORY_READ_GUIDANCE, MEMORY_READ_DESCRIPTION } from '../v2/read-guidance.js';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { McpIngress } from './ingress.js';
import { IMPORT_BASES, MAX_IMPORT_GAPS_BYTES, MAX_IMPORT_UNDERSTANDING_BYTES } from '../v2/import.js';
import { renderMemoryView } from '../v2/reader.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const identity = { submissionId: id, conversationId: id.optional() };
const safeErrors = new Set(['SUBMISSION_DISABLED', 'INIT_DISABLED', 'READ_DISABLED', 'STATUS_UNAVAILABLE', 'CONTEXT_UNAVAILABLE', 'INVALID_TEXT_SIZE', 'INVALID_SUBMISSION_ID', 'INVALID_IMPORT_LABEL', 'INVALID_IMPORT_BASIS', 'SUBMISSION_CONFLICT', 'CANCELLED']);
function result(value: object, text = JSON.stringify(value)) {
  return { content: [{ type: 'text' as const, text }], structuredContent: { ...value } };
}
function failure(error: unknown) {
  const code = error instanceof Error && safeErrors.has(error.message) ? error.message : 'MEMORY_UNAVAILABLE';
  return { ...result({ code }), isError: true };
}
const INSTRUCTIONS: Record<'relay' | 'init' | 'read', string> = {
  read: MEMORY_READ_GUIDANCE,
  init: 'Common Memory Init: call memory_init only when the user explicitly requests memory import, migration or initialization. Submit only existing material actually visible to you; direct quotations are allowed and remain agent-reported data. Name the actual sources and coverage gaps. Preserve dates, conditions, project scope and uncertainty; exclude this migration session’s execution status and unsupported new claims. Never turn missing knowledge into negative facts about the user. Never include secrets. Approval to migrate does not verify each claim. Accepted means queued; use memory_status with the same importId and ask the user to review the destination with common-memory show. These are soft semantic defenses, not Core guarantees of truth or completeness. Nothing here reads memory.',
  relay: 'Common Memory relay: submit complete user expressions verbatim for background memory maintenance; check processing state with memory_status.',
};

export function createMcpServer(ingress: McpIngress): McpServer {
  const instructions = ingress.capabilities.map(c => INSTRUCTIONS[c]).join('\n\n');
  const server = new McpServer({ name: 'common-memory', version: '0.2.0' }, { instructions });
  if (ingress.has('relay')) server.registerTool('memory_submit_user_turn', {
    description: 'Submit one complete user expression verbatim, not an assistant summary. Requires local host opt-in. Accepted means durably queued, not remembered. Reuse the same submission/conversation IDs when retrying. Cancellation after acceptance does not retract evidence.',
    inputSchema: z.object({ ...identity, contextId: z.string().max(160), text: z.string().min(1).max(ingress.config.disclosure.maxTotalBytes) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input, ctx) => {
    try { return result(ingress.submit(input, ctx.mcpReq.signal)); }
    catch (error) { return failure(error); }
  });
  if (ingress.has('init')) server.registerTool('memory_init', {
    description: `Import existing material actually visible to you about the user (contextId "global") or current project (contextId "project:<id>"). Call only when the user explicitly asks to import or migrate memory. In "understanding" (≤${MAX_IMPORT_UNDERSTANDING_BYTES} bytes), quote or faithfully summarize selected existing material; even quotations remain agent-reported, never authenticated user statements. Preserve original dates, historical goals, conditions, project scope and tentative wording. Set "basis" from the material actually read; use "sourceLabel" as a source label, and describe specific sources, coverage and uncertainty in "understanding" or "gaps". Do not infer source or full ChatGPT memory coverage from the product or mode name. Keep inaccessible or unknown information in "gaps", not as negative user facts. Exclude this migration session's connection, import, readback and other execution status, unsupported new assertions, secrets, credentials and anything the user did not intend to share. Leave unsupported guesses for review outside the import. User approval to migrate does not establish truth. Accepted means durably queued; Core structural validation cannot guarantee provenance accuracy or prevent all unsupported or contradictory additions. Poll memory_status with the same importId; reuse the importId with the identical payload when retrying. Review the actual destination with common-memory show; an isolated trial does not guarantee the same result on another run.`,
    inputSchema: z.object({
      importId: id,
      contextId: z.string().max(160),
      sourceLabel: z.string().min(1).max(64),
      basis: z.enum(IMPORT_BASES),
      understanding: z.string().min(1).max(MAX_IMPORT_UNDERSTANDING_BYTES),
      gaps: z.string().max(MAX_IMPORT_GAPS_BYTES).optional(),
    }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input, ctx) => {
    try { return result(ingress.init(input, ctx.mcpReq.signal)); }
    catch (error) { return failure(error); }
  });
  if (ingress.has('read')) server.registerTool('memory_read', {
    description: MEMORY_READ_DESCRIPTION,
    inputSchema: z.object({ contextId: z.string().max(160).optional() }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async input => {
    try { const view = ingress.read(input.contextId); return result(view, renderMemoryView(view)); }
    catch (error) { return failure(error); }
  });
  server.registerTool('memory_status', {
    description: 'Without arguments: this connection\'s capabilities and allowed context IDs. With submissionId or importId: that item\'s processing state, the documents it is retained in (retainedIn), and a diagnostic code. "processed" with an empty retainedIn means the Core kept nothing. No memory or conversation bodies are returned.',
    inputSchema: z.object({ submissionId: id.optional(), conversationId: id.optional(), importId: id.optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async input => {
    try {
      if (input.importId !== undefined) { if (input.submissionId || input.conversationId) return failure(new Error('INVALID_SUBMISSION_ID')); return result({ import: ingress.initStatus(input.importId) }); }
      if (!input.submissionId && input.conversationId) return failure(new Error('INVALID_SUBMISSION_ID'));
      return result(input.submissionId ? { submission: ingress.status({ submissionId: input.submissionId, conversationId: input.conversationId }) } : ingress.info());
    } catch (error) { return failure(error); }
  });
  return server;
}
