import type { ObservationOutcome } from './runtime.js';

/** Host-neutral outcome guidance shared by MCP and native integrations. No transport authority. */
export interface StatusIdentity { submissionId?: string | undefined; conversationId?: string | undefined; importId?: string | undefined; requestId?: string | undefined }
export interface NextStep {
  action: 'poll' | 'read' | 'review' | 'correct' | 'discover' | 'wait';
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
  const condition = processingCondition(outcome);
  if (condition === 'configuration') return {action:'wait',message:'Waiting for saved model, credentials or network configuration to be repaired. Common Memory resumes this same task after a configuration change within its persistent recovery budget. Do not poll repeatedly or submit a new ID.'};
  if (condition === 'cancelled') return {action:'wait',message:'This task was explicitly cancelled and will not resume automatically. Keep its original ID; only an explicit user retry may resume it.'};
  if (condition === 'budget') return {action:'wait',message:'The persistent automatic recovery budget is exhausted. Reconnection, restart and resubmission must not reset it. Report the retained task and original ID; automatic polling will not resume it.'};
  if (condition === 'limits') return {action:'wait',message:'Waiting for a model turn/context limit to be repaired. The task and counters are retained; saved configuration changes may resume it within the remaining recovery budget. Do not repeatedly poll or truncate its source.'};
  if (condition === 'quarantined') return {action:'correct',message:'This material is quarantined. Check its controlled diagnostic, provenance and authorization. Ordinary retry, new IDs or removing qualifiers must not bypass isolation.'};
  if (condition === 'stopped') return {action:'correct',message:'Automatic processing has stopped for a non-recoverable condition. Report the controlled issue/diagnostic and original ID; repair the cause before an explicit retry. Do not repeatedly poll or resubmit.'};
  return {action:'poll',tool:'memory_status',arguments:args,retryAfterMs:outcome.retryAt == null ? 2000 : Math.max(2000,outcome.retryAt-Date.now()),message:'Still queued/running or waiting for retry. Keep these exact IDs. Check after the suggested delay, with a bounded number of checks; if still pending, report queued rather than remembered. The writer must remain running.'};
}

export type ProcessingCondition = 'active' | 'configuration' | 'cancelled' | 'budget' | 'limits' | 'quarantined' | 'stopped';
/** Shared classification for human status and agent guidance; raw provider text is never used. */
export function processingCondition(item: {state:string;jobState?:string|null;issue?:string|null;diagnostic?:{reason:string}|null;automaticRecoveries?:number}): ProcessingCondition {
  if (item.state === 'quarantined' || item.jobState === 'quarantined') return 'quarantined';
  if (!['dead','paused'].includes(item.jobState ?? item.state)) return 'active';
  const reason=item.diagnostic?.reason;
  if (item.issue === 'CANCELLED' || reason === 'cancelled') return 'cancelled';
  if (item.issue === 'RECOVERY_BUDGET_EXHAUSTED' || reason === 'retry_budget_exhausted' || (item.automaticRecoveries ?? 0) >= 5) return 'budget';
  if (['AUTHENTICATION','PROXY_AUTHENTICATION','CONFIGURATION'].includes(item.issue ?? '') || ['authentication','proxy_authentication','model_not_found'].includes(reason ?? '')) return 'configuration';
  if (['AGENT_TURN_LIMIT','CONTEXT_LIMIT'].includes(item.issue ?? '') || ['agent_turn_limit','context_length_exceeded'].includes(reason ?? '')) return 'limits';
  return 'stopped';
}

/** Fixed outcome wording only; never display a model's arbitrary reason as a diagnostic. */
export function editResultMessage(result: import('./contract.js').EditResult): string {
  return {modified:'已修改记忆。请读取当前授权 Markdown 核实结果。',already_satisfied:'当前记忆已满足请求，没有强制写入。请读取当前授权 Markdown 核实。',clarification_required:'需要澄清：本次没有修改。请在原生调整页面提供更明确、完整的需求。',refused:'本次未执行修改。请检查请求及当前授权范围，由用户审阅。'}[result];
}
