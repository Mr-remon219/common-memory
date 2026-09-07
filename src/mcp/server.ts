import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { McpIngress } from './ingress.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const identity = { submissionId: id, conversationId: id.optional() };
const safeErrors = new Set(['SUBMISSION_DISABLED', 'CONTEXT_UNAVAILABLE', 'INVALID_TEXT_SIZE', 'INVALID_SUBMISSION_ID', 'SUBMISSION_CONFLICT', 'CANCELLED']);
function result(value: object) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: { ...value } };
}
export function createMcpServer(ingress: McpIngress): McpServer {
  const server = new McpServer({ name: 'common-memory', version: '0.2.0' });
  server.registerTool('memory_submit_user_turn', {
    description: 'Submit one complete user expression verbatim, not an assistant summary. Requires local host opt-in. Accepted means durably queued, not remembered. Reuse the same submission/conversation IDs when retrying. Cancellation after acceptance does not retract evidence.',
    inputSchema: z.object({ ...identity, contextId: z.string().max(160), text: z.string().min(1).max(ingress.config.disclosure.maxTotalBytes) }).strict(),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async (input, ctx) => {
    try { return result(ingress.submit(input, ctx.mcpReq.signal)); }
    catch (error) {
      const code = error instanceof Error && safeErrors.has(error.message) ? error.message : 'MEMORY_UNAVAILABLE';
      return { ...result({ code }), isError: true };
    }
  });
  server.registerTool('memory_status', {
    description: 'Read this connection’s allowed contexts or one submission’s processing state. Processed can mean ignored; no memory or conversation bodies are returned.',
    inputSchema: z.object({ submissionId: id.optional(), conversationId: id.optional() }).strict(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async input => {
    try {
      if (!input.submissionId && input.conversationId) return { ...result({ code: 'INVALID_SUBMISSION_ID' }), isError: true };
      return result(input.submissionId ? { submission: ingress.status({ submissionId: input.submissionId, conversationId: input.conversationId }) } : ingress.info());
    } catch { return { ...result({ code: 'MEMORY_UNAVAILABLE' }), isError: true }; }
  });
  return server;
}
