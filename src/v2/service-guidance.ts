import type { ObservationOutcome } from './runtime.js';

/** Host-neutral outcome guidance shared by MCP and native integrations. No transport authority. */
export interface StatusIdentity { submissionId?: string | undefined; conversationId?: string | undefined; importId?: string | undefined; requestId?: string | undefined }
export interface NextStep {
  action: 'poll' | 'read' | 'review' | 'correct' | 'discover';
  message: string;
  tool?: 'memory_status' | 'memory_read';
  arguments?: StatusIdentity & {contextId?: string};
  retryAfterMs?: number;
}
export function nextForAcceptance(state: string, args: StatusIdentity): NextStep {
  return {action:'poll',tool:'memory_status',arguments:args,retryAfterMs:state === 'pending' ? 2000 : 0,message:'Accepted, not necessarily remembered. Query this exact identity for current job state and destinations, including on duplicate replay. Keep the writer running; use bounded checks, not a tight polling loop.'};
}
export function nextForOutcome(outcome: ObservationOutcome | null, args: StatusIdentity, readContexts: readonly string[]): NextStep {
  if (!outcome) return {action:'correct',message:'No visible item matches these IDs on this connection. Check the original client/profile and exact IDs, including conversationId; do not invent a new ID to retry.'};
  if (outcome.state === 'processed') {
    if (outcome.editResult === 'clarification_required' || outcome.editResult === 'refused') return {action:'review',message:editResultMessage(outcome.editResult)};
    const destinations = [...new Set((outcome.retainedIn ?? []).map(target => target.startsWith('project:') ? target : 'global'))];
    if (!readContexts.length || destinations.some(context => !readContexts.includes(context))) return {action:'review',message:'Processing finished. This connection cannot read all relevant destinations. Use a read-enabled Common Memory connection authorized for them, or ask the user to review common-memory show. Empty retainedIn means no current source links, not proof that nothing changed.'};
    return {action:'read',tool:'memory_read',arguments:destinations.length === 1 ? {contextId:destinations[0]!} : {},message:'Processing finished. Read the authorized destination to verify current memory. Empty retainedIn means no current source links, not proof that nothing changed (e.g. forget/maintenance).'};
  }
  if (['dead','quarantined'].includes(outcome.state) || outcome.jobState === 'dead') return {action:'review',message:'Automatic processing has stopped. Inspect issue/diagnostic; ask the user to review Common Memory Processing Status. Do not resubmit with a new ID or remove qualifiers to bypass rejection.'};
  return {action:'poll',tool:'memory_status',arguments:args,retryAfterMs:outcome.retryAt == null ? 2000 : Math.max(2000,outcome.retryAt-Date.now()),message:'Still queued/running or waiting for retry. Keep these exact IDs. Check after the suggested delay, with a bounded number of checks; if still pending, report queued rather than remembered. The writer must remain running.'};
}

/** Fixed outcome wording only; never display a model's arbitrary reason as a diagnostic. */
export function editResultMessage(result: import('./contract.js').EditResult): string {
  return {modified:'已修改记忆。请读取当前授权 Markdown 核实结果。',already_satisfied:'当前记忆已满足请求，没有强制写入。请读取当前授权 Markdown 核实。',clarification_required:'需要澄清：本次没有修改。请在原生调整页面提供更明确、完整的需求。',refused:'本次未执行修改。请检查请求及当前授权范围，由用户审阅。'}[result];
}
