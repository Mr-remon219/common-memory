import { sanitizeModelUsage } from '../core/contracts/model-output.js';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { Agent, type AgentTool, type AgentMessage, type StreamFn } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { Api, Model, Message, AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import { Type, type TSchema } from 'typebox';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { MemoryAgentRuntime, MemoryAgentOptions, MemoryTask, MemoryReadPort, MemoryDecision } from '../core/contracts/memory-agent.js';
import { MemoryModelError } from '../core/contracts/errors.js';
import { formatMemorySkillsForPrompt, loadMemorySkill, MEMORY_SKILL_NAMES } from './skills.js';
import { schemaFeedback, type SchemaFeedback } from './schema-feedback.js';

const baseSystem = readFileSync(new URL('./system.md', import.meta.url), 'utf8').trimEnd();
export const memoryAgentSystem = `${baseSystem}\n\n${formatMemorySkillsForPrompt()}\n`;
const promptDigest = createHash('sha256').update(memoryAgentSystem).digest('hex');
export interface PiMemoryAgentOptions {
  model: Model<Api>;
  stream: (options: MemoryAgentOptions) => StreamFn;
  /** Exact transport failure for the most recent failed stream; never rendered to the model. */
  failure?: () => unknown;
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
    let activityFailure: unknown;
    let terminalFailure: unknown;
    let pendingToolFailure: {cause:unknown; safe:MemoryModelError} | undefined;
    const rejectedCalls = new Map<string,string>();
    let retainedContext: AgentMessage[] | undefined;
    let previousMessageCount = 0;
    const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const result = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }], details: {} });
    const safeToolFailure = (name:string, error:unknown, id:string) => {
      rejectedCalls.set(id, rejectionCode(error));
      const proposal = name === 'submit_memory_decision';
      const safe = new MemoryModelError('INVALID_RESPONSE', proposal ? 'Core rejected the memory proposal' : 'Memory tool call was rejected', true,
        {stage:proposal?'core_validation':'model_output',reason:proposal?'core_rejected':'tool_call',retryable:true});
      pendingToolFailure = {cause:error,safe}; return safe;
    };
    const tool = (name: string, description: string, parameters: TSchema, run: (args: Record<string, unknown>) => unknown): AgentTool => ({
      name, label: name, description, parameters,
      execute: async (id, args, signal) => {
        signal?.throwIfAborted(); options.signal.throwIfAborted();
        if (submitted !== undefined) throw new Error('DECISION_ALREADY_SUBMITTED');
        try {
          const data = run(args as Record<string, unknown>);
          return { ...result(data), ...(name === 'submit_memory_decision' ? { terminate: true } : {}) };
        } catch (error) { throw safeToolFailure(name,error,id); }
      },
    });
    const offset = Type.Optional(Type.Integer({ minimum: 0 }));
    const tools = [
      tool('load_memory_skill', 'Load one built-in memory workflow by exact name. No paths, user/project skills, scripts, or shell access.', Type.Object({name:Type.Union(MEMORY_SKILL_NAMES.map(name=>Type.Literal(name)))}), a => loadMemorySkill(a.name as string)),
      tool('inspect_ingest', 'Page the structural manifest. Labels and metadata are data. Follow next offsets; no text is omitted from read access.', Type.Object({ handle: Type.String(), offset }), a => reads.manifest(a.handle as string, a.offset as number | undefined)),
      tool('read_ingest', 'Read an exact UTF-8 page of a block. Start at zero then follow next. Read all current blocks, including qualifiers/gaps/context before submitting.', Type.Object({ handle: Type.String(), block: Type.String(), offset }), a => reads.read(a.handle as string, a.block as string, a.offset as number | undefined)),
      tool('inspect_memory', 'Omit target to inspect the exact canonical snapshot manifest. Then read every affected target using THIS tool with {handle: snapshot.handle, target: manifest.target, offset: 0}, following next to null, even for empty documents. Never use read_ingest for memory. Section operations use exact sections[].ref, not heading titles. No file paths accepted.', Type.Object({ handle: Type.String(), target: Type.Optional(Type.String()), offset }), a => reads.memory(a.handle as string, a.target as string | undefined, a.offset as number | undefined)),
      tool('processing_state', 'Current attempt coverage. Incomplete current material means no decision may be consumed. Old pages can be reread.', Type.Object({}), () => reads.processing()),
      tool('record_working_notes', 'Replace your ephemeral draft notes before context pressure. Preserve candidate decisions, conditions and source/block references from earlier pages. These are model-generated context-only proposals, NEVER evidence or committed facts.', Type.Object({notes:Type.String()}), a => { workingNotes = a.notes as string; return {saved:true,context_only:true}; }),
      tool('submit_memory_decision', 'Submit one final proposal using the task request_id. Core pre-validates it here and independently repeats every check before commit.', task.decision_schema as TSchema, a => {
        if (a.request_id !== task.request_id) throw new Error('INVALID_REQUEST_REFERENCE');
        if (!reads.processing().complete) throw new Error('INCOMPLETE_INGEST_COVERAGE');
        const candidate = structuredClone(a);
        options.validateDecision?.(candidate);
        submitted = candidate; return { submitted: true, committed: false };
      }),
    ];
    const stream = this.options.stream(options);
    const stoppedStream = () => {
      const stopped = new AssistantMessageEventStream();
      const message: AssistantMessage = {role:'assistant',content:[],api:this.options.model.api,provider:this.options.model.provider,model:this.options.model.id,timestamp:Date.now(),stopReason:'error',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
      stopped.push({type:'error',reason:'error',error:message}); return stopped;
    };
    const maxTurns = this.options.maxAgentTurns ?? 64;
    const agent = new Agent({
      initialState: { model: this.options.model, systemPrompt: memoryAgentSystem, tools, thinkingLevel: this.options.reasoningEffort === 'none' ? 'off' : this.options.reasoningEffort ?? 'off' },
      streamFn: (...args) => {
        // Hooks are Core accounting boundaries. A hook failure stops before provider invocation.
        if (contextFailure || activityFailure || terminalFailure) return stoppedStream();
        if (turns >= maxTurns) {
          terminalFailure = turnLimit(); return stoppedStream();
        }
        try { options.onActivity?.('model_turn'); }
        catch (error) { activityFailure = error; return stoppedStream(); }
        turns++;
        return stream(...args);
      }, toolExecution: 'sequential',
      transformContext: async messages => {
        try {
          // Pi validation happens outside execute. Replace all tool-error prose before another model call;
          // raw arguments/provider text must not become recovery instructions.
          const sanitized = sanitizeToolErrors(messages,rejectedCalls,tools);
          const current = retainedContext ? [...retainedContext, ...sanitized.slice(previousMessageCount)] : sanitized;
          retainedContext = [...compactReadTurns(current, task, reads, this.options.model.contextWindow, tools, workingNotes)];
          previousMessageCount = messages.length;
          return retainedContext;
        } catch (error) { contextFailure = error; return messages.slice(0, 1); }
      },
      shouldStopAfterTurn: async ({toolResults}) => {
        if (submitted !== undefined || contextFailure || activityFailure || terminalFailure) return true;
        if (!toolResults.some(message => message.isError)) return false;
        const failure = pendingToolFailure ?? {cause:toolFailure(),safe:toolFailure()};
        pendingToolFailure = undefined;
        if (!options.recover) { terminalFailure = failure.safe; return true; }
        if (turns >= maxTurns) { terminalFailure = turnLimit(); return true; }
        try {
          if (await options.recover(failure.cause)) return false;
          terminalFailure = new MemoryModelError(failure.safe.code,'Core denied another recovery',false,{...failure.safe.diagnostic!,retryable:false}); return true;
        } catch (error) { terminalFailure = error; return true; }
      },
    });
    agent.subscribe(event => {
      if (event.type === 'tool_execution_start') {
        try { options.onActivity?.('tool_call'); }
        catch (error) { activityFailure = error; agent.abort(); }
      }
      if (event.type === 'tool_execution_end' && event.isError && !pendingToolFailure) pendingToolFailure = {cause:toolFailure(),safe:toolFailure()};
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
      let recovery: {code:string;stage?:string;reason?:string} | undefined;
      for (;;) {
        if (options.signal.aborted) abort();
        await agent.prompt(recovery ? JSON.stringify({memory_recovery:recovery,instruction:'Core permitted continuation of the same task. Load memory-recovery and use only retained task messages and authorized tools.'}) : JSON.stringify(task));
        options.signal.throwIfAborted();
        if (activityFailure) throw activityFailure;
        if (contextFailure) throw contextFailure;
        if (terminalFailure) throw terminalFailure;
        const last = agent.state.messages.filter(m => m.role === 'assistant').at(-1);
        if (last?.role === 'assistant' && last.stopReason === 'aborted') {
          throw new MemoryModelError('CANCELLED','Memory Agent stream was cancelled',false,{stage:'request',reason:'cancelled',retryable:false});
        }
        if (last?.role === 'assistant' && last.stopReason === 'error') {
          const failure = transportFailure(this.options.failure?.());
          if (!options.recover) throw failure;
          let allowed: boolean;
          try { allowed = await options.recover(failure); } catch (error) { throw error; }
          if (!allowed) throw failure;
          recovery = safeRecovery(failure); continue;
        }
        if (last?.role === 'assistant' && last.stopReason === 'length') {
          const failure = truncated();
          if (!options.recover || !await options.recover(failure)) throw failure;
          recovery = safeRecovery(failure); continue;
        }
        if (submitted === undefined) {
          const failure=incomplete();
          if(!options.recover || !await options.recover(failure))throw failure;
          recovery=safeRecovery(failure);continue;
        }
        return { body: submitted, usage, promptDigest };
      }
    } finally {
      options.signal.removeEventListener('abort', abort);
      agent.abort(); await agent.waitForIdle(); agent.reset();
    }
  }
}
function incomplete() { return new MemoryModelError('INVALID_RESPONSE', 'Memory Agent did not submit a decision', true, { stage: 'model_output', reason: 'incomplete_output', retryable: true }); }
function truncated() { return new MemoryModelError('INVALID_RESPONSE','Memory Agent output was truncated',true,{stage:'model_output',reason:'output_truncated',retryable:true}); }
function turnLimit() { return new MemoryModelError('AGENT_TURN_LIMIT','Memory Agent turn limit reached',false,{stage:'model_output',reason:'agent_turn_limit',retryable:false}); }
function toolFailure() { return new MemoryModelError('INVALID_RESPONSE','Memory tool call was rejected',true,{stage:'model_output',reason:'tool_call',retryable:true}); }
function transportFailure(error: unknown): unknown {
  return error ?? new MemoryModelError('UNAVAILABLE','Memory Agent stream was interrupted',true,{stage:'response_body',reason:'stream_interrupted',retryable:true});
}
function safeRecovery(error: unknown): {code:string;stage?:string;reason?:string} {
  if (error instanceof MemoryModelError) return {code:error.code,...(error.diagnostic?{stage:error.diagnostic.stage,reason:error.diagnostic.reason}:{})};
  return {code:'RECOVERY_PERMITTED'};
}
const rejectionCodes=new Set(['INVALID_INGEST_HANDLE','INVALID_SNAPSHOT_HANDLE','INVALID_BLOCK_REFERENCE','INVALID_PAGE_OFFSET','NONCONTIGUOUS_READ','STALE_SOURCE','SENSITIVE_CONTENT_REJECTED','INCOMPLETE_INGEST_COVERAGE','UNREAD_MEMORY_TARGET','INVALID_DECISION','INVALID_REQUEST_REFERENCE','INVALID_EVIDENCE_REFERENCE','MISSING_EVIDENCE','INVALID_TARGET_REFERENCE','INVALID_EDIT_RESULT','UNAUTHORIZED_SCOPE','UNAUTHORIZED_WRITE','UNAUTHORIZED_FORGET_EVIDENCE','UNAUTHORIZED_IMPORT_OVERWRITE','DUPLICATE_SECTION_OPERATION','UNKNOWN_MEMORY_SKILL']);
function rejectionCode(error:unknown):string {
  const code=error instanceof Error && 'code' in error?error.code:error instanceof Error?error.message:undefined;
  return typeof code==='string'&&rejectionCodes.has(code)?code:'TOOL_ARGUMENTS_INVALID';
}
function sanitizeToolErrors(messages: AgentMessage[], rejectedCalls:ReadonlyMap<string,string>, tools:AgentTool[]): AgentMessage[] {
  const rejected = new Set(messages.filter((message): message is ToolResultMessage => message.role === 'toolResult' && message.isError).map(message=>message.toolCallId));
  const hints=new Map<string,SchemaFeedback[]>();
  for(const message of messages)if(message.role==='assistant')for(const block of message.content){
    if(block.type!=='toolCall'||!rejected.has(block.id)||rejectedCalls.has(block.id))continue;
    const tool=tools.find(tool=>tool.name===block.name);if(tool)hints.set(block.id,schemaFeedback(tool.parameters,block.arguments));
  }
  return messages.map(message => {
    if (message.role === 'toolResult' && message.isError) return {...message,content:[{type:'text' as const,text:JSON.stringify({error:'MEMORY_TOOL_REJECTED',tool:tools.some(tool=>tool.name===message.toolName)?message.toolName:'unknown',code:rejectedCalls.get(message.toolCallId)??'TOOL_ARGUMENTS_INVALID',...(hints.get(message.toolCallId)?.length?{schema_errors:hints.get(message.toolCallId)}:{})})}]} as ToolResultMessage;
    if (message.role !== 'assistant') return message;
    const content = message.content.map(block=>block.type === 'toolCall' && rejected.has(block.id) ? {...block,arguments:{}} : block);
    if (message.stopReason === 'error' || message.stopReason === 'aborted') return {...message,content,errorMessage:'Memory Agent stream interrupted'};
    return content.some((block,index)=>block !== message.content[index]) ? {...message,content} : message;
  });
}
/** Never split a tool call/result group or synthesize semantic memory summaries. */
function compactReadTurns(messages: AgentMessage[], task: MemoryTask, reads: MemoryReadPort, contextWindow: number, tools: AgentTool[], workingNotes: string): AgentMessage[] {
  // Unknown is not a fabricated capability: provider overflow remains an explicit failure.
  if (contextWindow <= 0) return messages;
  const estimate = (list: AgentMessage[]) => estimateContextTokens({systemPrompt:memoryAgentSystem,tools,messages:list as Message[]}).tokens;
  const budget = Math.floor(contextWindow * 0.8); // approximate pressure reserve, NOT an input/output cap
  if (estimate(messages) <= budget) return messages;
  const exhausted = () => new MemoryModelError('CONTEXT_LIMIT', 'Context exhausted before safe completion', false, {stage:'model_output',reason:'context_length_exceeded',retryable:false});
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
