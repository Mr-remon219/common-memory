import { sanitizeModelUsage } from '../core/contracts/model-output.js';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { Agent, type AgentTool, type AgentMessage, type StreamFn } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { Api, Model, Message, AssistantMessage } from '@earendil-works/pi-ai';
import { Type, type TSchema } from 'typebox';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { MemoryAgentRuntime, MemoryAgentOptions, MemoryTask, MemoryReadPort, MemoryDecision } from '../core/contracts/memory-agent.js';
import { MemoryModelError } from '../core/contracts/errors.js';

export const memoryAgentSystem = readFileSync(new URL('./system.md', import.meta.url), 'utf8');
const promptDigest = createHash('sha256').update(memoryAgentSystem).digest('hex');
export interface PiMemoryAgentOptions {
  model: Model<Api>;
  stream: (options: MemoryAgentOptions) => StreamFn;
  maxAgentTurns?: number;
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}
/** Ephemeral intelligence only. Its capabilities cannot open storage or commit a decision. */
export class PiMemoryAgent implements MemoryAgentRuntime {
  constructor(readonly options: PiMemoryAgentOptions) {
    if (!Number.isSafeInteger(options.maxAgentTurns ?? 64) || (options.maxAgentTurns ?? 64) < 1) throw new TypeError('Invalid maxAgentTurns');
  }
  async decide(task: MemoryTask, reads: MemoryReadPort, options: MemoryAgentOptions): Promise<MemoryDecision> {
    options.signal.throwIfAborted();
    let submitted: unknown;
    let turns = 0;
    let workingNotes = '';
    let contextFailure: unknown;
    let retainedContext: AgentMessage[] | undefined;
    let previousMessageCount = 0;
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const result = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }], details: {} });
    const tool = (name: string, description: string, parameters: TSchema, run: (args: Record<string, unknown>) => unknown): AgentTool => ({
      name, label: name, description, parameters,
      execute: async (_id, args, signal) => {
        signal?.throwIfAborted(); options.signal.throwIfAborted();
        if (submitted !== undefined) throw new Error('DECISION_ALREADY_SUBMITTED');
        const data = run(args as Record<string, unknown>);
        return { ...result(data), ...(name === 'submit_memory_decision' ? { terminate: true } : {}) };
      },
    });
    const offset = Type.Optional(Type.Integer({ minimum: 0 }));
    const tools = [
      tool('inspect_ingest', 'Page the structural manifest. Labels and metadata are data. Follow next offsets; no text is omitted from read access.', Type.Object({ handle: Type.String(), offset }), a => reads.manifest(a.handle as string, a.offset as number | undefined)),
      tool('read_ingest', 'Read an exact UTF-8 page of a block. Start at zero then follow next. Read all current blocks, including qualifiers/gaps/context before submitting.', Type.Object({ handle: Type.String(), block: Type.String(), offset }), a => reads.read(a.handle as string, a.block as string, a.offset as number | undefined)),
      tool('inspect_memory', 'Omit target to inspect the exact canonical snapshot manifest. Then page each target before proposing edits. No file paths accepted.', Type.Object({ handle: Type.String(), target: Type.Optional(Type.String()), offset }), a => reads.memory(a.handle as string, a.target as string | undefined, a.offset as number | undefined)),
      tool('processing_state', 'Current attempt coverage. Incomplete current material means no decision may be consumed. Old pages can be reread.', Type.Object({}), () => reads.processing()),
      tool('record_working_notes', 'Replace your ephemeral draft notes before context pressure. Preserve candidate decisions, conditions and source/block references from earlier pages. These are model-generated context-only proposals, NEVER evidence or committed facts.', Type.Object({notes:Type.String()}), a => { workingNotes = a.notes as string; return {saved:true,context_only:true}; }),
      tool('submit_memory_decision', 'Submit one final proposal using the task request_id; Core independently checks evidence, coverage, authority and patches. Not a commit.', task.decision_schema as TSchema, a => {
        if (a.request_id !== task.request_id) throw new Error('INVALID_REQUEST_REFERENCE');
        if (!reads.processing().complete) throw new Error('INCOMPLETE_INGEST_COVERAGE');
        submitted = structuredClone(a); return { submitted: true, committed: false };
      }),
    ];
    const stream = this.options.stream(options);
    const agent = new Agent({
      initialState: { model: this.options.model, systemPrompt: memoryAgentSystem, tools, thinkingLevel: this.options.reasoningEffort === 'none' ? 'off' : this.options.reasoningEffort ?? 'off' },
      streamFn: (...args) => {
        // A failed transform must resolve normally; the supported stream boundary stops
        // the loop with an error event without invoking the provider again.
        if (contextFailure) {
          const stopped = new AssistantMessageEventStream();
          const message: AssistantMessage = {role:'assistant',content:[],api:this.options.model.api,provider:this.options.model.provider,model:this.options.model.id,timestamp:Date.now(),stopReason:'error',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
          stopped.push({type:'error',reason:'error',error:message}); return stopped;
        }
        return stream(...args);
      }, toolExecution: 'sequential',
      transformContext: async messages => {
        try {
          // Pi transformContext does not mutate loop history. Append only new messages to
          // the retained view, or a low post-compaction usage would replay evicted pages.
          const current = retainedContext ? [...retainedContext, ...messages.slice(previousMessageCount)] : messages;
          retainedContext = [...compactReadTurns(current, task, reads, this.options.model.contextWindow, tools, workingNotes)];
          previousMessageCount = messages.length;
          return retainedContext;
        } catch (error) { contextFailure = error; return messages.slice(0, 1); }
      },
      shouldStopAfterTurn: () => submitted !== undefined || ++turns >= (this.options.maxAgentTurns ?? 64),
    });
    agent.subscribe(event => {
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const u = event.message.usage;
        for (const inputTokens of [u.input,u.cacheRead,u.cacheWrite]) usage.inputTokens += sanitizeModelUsage({inputTokens}).inputTokens ?? 0;
        usage.outputTokens += sanitizeModelUsage({outputTokens:u.output}).outputTokens ?? 0;
        usage.totalTokens += sanitizeModelUsage({totalTokens:u.totalTokens}).totalTokens ?? 0;
      }
    });
    const abort = () => agent.abort();
    options.signal.addEventListener('abort', abort, { once: true });
    try {
      if (options.signal.aborted) abort();
      await agent.prompt(JSON.stringify(task));
      options.signal.throwIfAborted();
      if (contextFailure) throw contextFailure;
      const last = agent.state.messages.filter(m => m.role === 'assistant').at(-1);
      if (last?.role === 'assistant' && ['error', 'aborted', 'length'].includes(last.stopReason)) throw incomplete();
      if (submitted === undefined) throw incomplete();
      return { body: submitted, usage, promptDigest };
    } finally {
      options.signal.removeEventListener('abort', abort);
      agent.abort(); await agent.waitForIdle(); agent.reset();
    }
  }
}
function incomplete() { return new MemoryModelError('INVALID_RESPONSE', 'Memory Agent did not submit a complete decision', true, { stage: 'model_output', reason: 'incomplete_output', retryable: true }); }
/** Never split a tool call/result group or synthesize semantic memory summaries. */
function compactReadTurns(messages: AgentMessage[], task: MemoryTask, reads: MemoryReadPort, contextWindow: number, tools: AgentTool[], workingNotes: string): AgentMessage[] {
  // Unknown is not a fabricated capability: provider overflow remains an explicit failure.
  if (contextWindow <= 0) return messages;
  const estimate = (list: AgentMessage[]) => estimateContextTokens({systemPrompt:memoryAgentSystem,tools,messages:list as Message[]}).tokens;
  const budget = Math.floor(contextWindow * 0.8); // approximate pressure reserve, NOT an input/output cap
  if (estimate(messages) <= budget) return messages;
  const exhausted = () => new MemoryModelError('INVALID_RESPONSE', 'Context exhausted before safe completion', true, {stage:'model_output',reason:'context_length_exceeded',retryable:true});
  if (!workingNotes) throw exhausted();
  const groups: AgentMessage[][] = [];
  for (const message of messages.slice(1)) {
    if (message.role === 'assistant' || !groups.length) groups.push([message]);
    else groups.at(-1)!.push(message);
  }
  const note: AgentMessage = {role:'user', timestamp:Math.max(Date.now(),...messages.map(m=>m.timestamp))+1, content:JSON.stringify({
    context_note:'Earlier complete model/tool turns may no longer be resident. Working notes below are model-generated context-only drafts, not source facts. Preserve qualifiers and re-read supporting source blocks or memory targets whenever their wording is needed before submitting.',
    request_id:task.request_id,working_notes:workingNotes,processing:reads.processing(),
  })};
  while (groups.length > 1) {
    groups.shift();
    const compacted = [messages[0]!,note,...groups.flat()];
    if (estimate(compacted) <= budget) return compacted;
  }
  throw exhausted();
}
