// Compatibility entrypoint; Work and Codex share one host adapter and durable inbox.
export { enqueueCodexEvent, consumeCodexInbox, codexProcessInstance, setupHostAdapter } from './host-session.js';
export type { CodexEvent, HostClient } from './host-session.js';
