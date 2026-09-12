/** Source: openai/codex rust-v0.153.4 and rust-v0.154.0 protocol/{protocol,items,user_input,models}.rs.
 * Extra fields may evolve; unknown discriminants cannot be silently skipped as non-evidence. */
export const MIN_ROLLOUT_VERSION = '0.153.4';
export function supportsRolloutVersion(value: unknown): boolean {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)) return false;
  const [major,minor,patch] = value.split('.').map(BigInt) as [bigint,bigint,bigint];
  const [minMajor,minMinor,minPatch] = MIN_ROLLOUT_VERSION.split('.').map(BigInt) as [bigint,bigint,bigint];
  return major > minMajor || major === minMajor && (minor > minMinor || minor === minMinor && patch >= minPatch);
}
export function admitSessionMeta(value: unknown): void {
  const row = record(value);
  if (row.type !== 'session_meta' || !supportsRolloutVersion(record(row.payload).cli_version)) throw new Error('CODEX_UNSUPPORTED_VERSION');
}
function record(value: unknown): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CODEX_UNKNOWN_TRANSCRIPT');
  return value as Record<string,unknown>;
}
const EVENT_TYPES = new Set([
  'error', 'warning', 'auth_recovery_started', 'auth_recovery_completed', 'guardian_warning',
  'realtime_conversation_started', 'realtime_conversation_realtime', 'realtime_conversation_closed', 'realtime_conversation_sdp', 'model_reroute',
  'model_verification', 'turn_moderation_metadata', 'safety_buffering', 'context_compacted', 'thread_rolled_back',
  'task_started', 'thread_settings_applied', 'task_complete', 'token_count', 'agent_message',
  'user_message', 'agent_reasoning', 'agent_reasoning_raw_content', 'agent_reasoning_section_break', 'session_configured',
  'environment_connected', 'environment_disconnected', 'thread_goal_updated', 'thread_queue_changed', 'mcp_startup_update',
  'mcp_startup_complete', 'mcp_tool_call_begin', 'mcp_tool_call_end', 'web_search_begin', 'web_search_end',
  'image_generation_begin', 'image_generation_end', 'exec_command_begin', 'exec_command_output_delta', 'terminal_interaction',
  'exec_command_end', 'view_image_tool_call', 'exec_approval_request', 'request_permissions', 'request_user_input',
  'dynamic_tool_call_request', 'dynamic_tool_call_response', 'elicitation_request', 'apply_patch_approval_request', 'guardian_assessment',
  'deprecation_notice', 'stream_error', 'patch_apply_begin', 'patch_apply_updated', 'patch_apply_end',
  'turn_diff', 'realtime_conversation_list_voices_response', 'plan_update', 'turn_aborted', 'shutdown_complete',
  'entered_review_mode', 'exited_review_mode', 'raw_response_item', 'raw_response_completed', 'item_started',
  'item_completed', 'hook_started', 'hook_completed', 'agent_message_content_delta', 'plan_delta',
  'reasoning_content_delta', 'reasoning_raw_content_delta', 'collab_agent_spawn_begin', 'collab_agent_spawn_end', 'collab_agent_interaction_begin',
  'collab_agent_interaction_end', 'collab_waiting_begin', 'collab_waiting_end', 'collab_close_begin', 'collab_close_end',
  'collab_resume_begin', 'collab_resume_end', 'sub_agent_activity', 'turn_started', 'turn_complete',
]);
const TURN_ITEM_TYPES = new Set([
  'UserMessage', 'FunctionCallOutput', 'HookPrompt', 'AgentMessage', 'Plan',
  'Reasoning', 'CommandExecution', 'DynamicToolCall', 'CollabAgentToolCall', 'SubAgentActivity',
  'WebSearch', 'ImageView', 'Extension', 'ImageGeneration', 'EnteredReviewMode',
  'ExitedReviewMode', 'FileChange', 'McpToolCall', 'ContextCompaction',
]);
const USER_INPUT_TYPES = new Set(['text', 'image', 'local_image', 'audio', 'local_audio', 'skill', 'mention']);
const RESPONSE_ITEM_TYPES = new Set([
  'additional_tools', 'message', 'agent_message', 'reasoning', 'local_shell_call',
  'function_call', 'tool_search_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output',
  'tool_search_output', 'web_search_call', 'image_generation_call', 'compaction', 'configuration_update',
  'compaction_trigger', 'context_compaction', 'other', 'compaction_summary',
]);
export function validateDiscriminants(type: string, payload: Record<string,unknown>): void {
  const known = (set:Set<string>, value:unknown) => {if (typeof value !== 'string' || !set.has(value)) throw new Error('CODEX_UNKNOWN_TRANSCRIPT');};
  if (type === 'response_item') {
    known(RESPONSE_ITEM_TYPES, payload.type);
    if (payload.type === 'message' || payload.type === 'additional_tools') known(new Set(['user','assistant','system','developer','tool']), payload.role);
  }
  if (type !== 'event_msg') return;
  known(EVENT_TYPES, payload.type);
  if (payload.type === 'item_completed' || payload.type === 'item_started') {
    const item = record(payload.item); known(TURN_ITEM_TYPES,item.type);
    if (item.type === 'UserMessage') {
      if (!Array.isArray(item.content)) throw new Error('CODEX_UNKNOWN_TRANSCRIPT');
      for (const input of item.content) {
        const part = record(input); known(USER_INPUT_TYPES,part.type);
        if (part.type === 'text' && typeof part.text !== 'string') throw new Error('CODEX_UNKNOWN_TRANSCRIPT');
      }
    }
  }
  if (payload.type === 'raw_response_item') validateDiscriminants('response_item',record(payload.item));
}
