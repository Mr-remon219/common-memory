// Compatibility entrypoint; Work and Codex share one host adapter and durable inbox.
export { enqueueCodexEvent, consumeCodexInbox, codexProcessInstance, setupHostAdapter, hostQueueStatus, recoverCodexInbox } from './host-session.js';
export type { CodexEvent, HostClient, HostQueueStatus, HostRecoveryStatus } from './host-session.js';
