import { inputLimits } from '../core/safety/external-preflight.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CommonMemoryConfig } from '../config/config.js';
import { queueMemoryEdit, validateMemoryEdit } from '../v2/edit-ingress.js';
import { RuntimeStore } from '../v2/runtime.js';
import { ProjectRegistry } from '../v2/registry.js';
import { readAuthorizedMemory } from '../v2/reader.js';
import { queueAgentImport, type AgentImportSubmission } from '../v2/agent-ingress.js';
import { nextForAcceptance, nextForOutcome } from '../v2/service-guidance.js';
import { retryAuthorizedJob, scopedQueueStatus } from '../v2/service-status.js';

export interface NativeIdentity { importId?: string; requestId?: string }
export interface MemoryHost { cwd: string; sessionId: string }
/** Native adapter: browsing never needs a Writer/model/key. Every action reloads authorization. */
export class PiMemoryService {
  constructor(readonly options: {
    config: () => CommonMemoryConfig;
    activeStore: () => {dataRoot:string;store:RuntimeStore} | undefined;
    wake: () => void;
  }) {}
  contexts(host: MemoryHost, human = false) {
    const config = this.options.config(), registry = new ProjectRegistry(config.dataRoot);
    const projects = human ? registry.list() : [registry.resolve(host.cwd)].filter(p => p !== undefined && p !== null);
    return [{id:'global',name:'Global'},...projects.map(p => ({id:`project:${p!.id}`,name:p!.name}))]
      .filter(c => config.disclosure.allowedScopes.includes(c.id));
  }
  read(host: MemoryHost, contextId?: string, human = false) {
    const config = this.options.config(), contexts = this.contexts(host,human).map(c => c.id);
    if (contextId !== undefined && !contexts.includes(contextId)) throw new Error('CONTEXT_UNAVAILABLE');
    return readAuthorizedMemory({dataRoot:config.dataRoot,contexts:contextId === undefined ? contexts : [contextId]});
  }
  info(host: MemoryHost, human = false) {
    const config = this.options.config(), contexts = this.contexts(host,human);
    return {
      contexts, readEnabled:contexts.length>0,
      captureEnabled:config.disclosure.allowedProvenance.includes('user_explicit') && this.contexts(host).length>0,
      initEnabled:config.disclosure.allowedProvenance.includes('agent_observation') && contexts.length>0,
      adjustmentContexts:contexts.filter(c => config.disclosure.allowedProvenance.includes('user_explicit') && config.writableScopes.includes(c.id)),
      ...inputLimits(config.disclosure),
    };
  }
  #withStore<T>(create: boolean, fn: (store:RuntimeStore)=>T): T | null {
    const config = this.options.config(), active = this.options.activeStore();
    if (active?.dataRoot === config.dataRoot) return fn(active.store);
    if (!create && !existsSync(join(config.dataRoot,'runtime.sqlite'))) return null;
    const store = new RuntimeStore(config.dataRoot,{sqliteTimeoutMs:100});
    try { return fn(store); } finally { store.close(); }
  }
  #namespace(host: MemoryHost, kind: 'init' | 'adjust') { return `pi-${kind}:${JSON.stringify(host.sessionId)}`; }
  status(host: MemoryHost, identity: NativeIdentity = {}, human = false) {
    if (identity.importId !== undefined && identity.requestId !== undefined) throw new Error('INVALID_SUBMISSION_ID');
    const info = this.info(host,human), contexts = info.contexts.map(c=>c.id);
    const modelContexts = this.contexts(host).map(c=>c.id);
    const id = identity.importId ?? identity.requestId;
    if (id !== undefined) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('INVALID_SUBMISSION_ID');
      const outcome = this.#withStore(false,s=>s.observationOutcome(this.#namespace(host,identity.importId!==undefined?'init':'adjust'),id,contexts));
      return {...info,item:outcome,next:nextForOutcome(outcome,identity,modelContexts)};
    }
    const queue = this.#withStore(false,s=>scopedQueueStatus(s,contexts)) ?? {observations:[],jobStates:[],jobs:[]};
    const recent = this.#withStore(false,s=>{
      if(!contexts.length)return [];
      const placeholders=contexts.map(()=>'?').join(',');
      return s.db.prepare(`SELECT entryId,sessionId,scope FROM observations WHERE sessionId IN (?,?) AND scope IN (${placeholders}) ORDER BY id DESC LIMIT 20`)
        .all(this.#namespace(host,'init'),this.#namespace(host,'adjust'),...contexts).map(r=>{
          const identity = r.sessionId===this.#namespace(host,'init') ? {importId:String(r.entryId)} : {requestId:String(r.entryId)};
          const outcome = s.observationOutcome(String(r.sessionId),String(r.entryId),contexts)!;
          return {...identity,contextId:String(r.scope),outcome,next:nextForOutcome(outcome,identity,modelContexts)};
        });
    }) ?? [];
    return {...info,queue,recent,next:{action:'discover' as const,message:'User turns are captured automatically; do not submit summaries or duplicate them. Open /memory to browse, adjust, import or recover. Processed does not mean remembered. Use memory_read to verify authorized destinations.'}};
  }
  /** Call only after an actual host user confirmation, never a model-supplied approved flag. */
  import(host: MemoryHost, input: AgentImportSubmission, signal?: AbortSignal, human = false) {
    const config = this.options.config(), info = this.info(host,human);
    // Check before creating any queue. Core rechecks all input constraints at enqueue.
    if (!info.initEnabled) throw new Error('INIT_DISABLED');
    if (!info.contexts.some(c=>c.id===input.contextId)) throw new Error('CONTEXT_UNAVAILABLE');
    const accepted = this.#withStore(true,s=>queueAgentImport(s,this.#namespace(host,'init'),input,{contexts:info.contexts.map(c=>c.id),enabled:info.initEnabled,maxBytes:config.disclosure.maxTotalBytes,limits:config.disclosure},signal))!;
    this.#wake();
    return {...accepted,importId:input.importId,next:nextForAcceptance(accepted.state,{importId:input.importId})};
  }
  /** Only text entered in the native user editor reaches this method; no model write tool. */
  adjust(host: MemoryHost, scope: string, prompt: string, requestId: string = randomUUID()) {
    const config = this.options.config(), info = this.info(host,true);
    if (!info.adjustmentContexts.some(c=>c.id===scope)) throw new Error('ADJUSTMENT_DISABLED');
    const input = {sessionId:this.#namespace(host,'adjust'),requestId,text:prompt,scope};
    const access = {allowedScopes:info.adjustmentContexts.map(c=>c.id),writableScopes:config.writableScopes,allowedProvenance:config.disclosure.allowedProvenance,limits:config.disclosure};
    validateMemoryEdit(input,access);
    const accepted = this.#withStore(true,store=>queueMemoryEdit(store,input,access))!;
    this.#wake();return {...accepted,requestId,next:nextForAcceptance(accepted.state,{requestId})};
  }
  flush() {
    const queued=this.#withStore(false,s=>{s.requestFlush();return true;}) ?? false;
    if(queued)this.#wake();return queued;
  }
  retry(host: MemoryHost, id: string) {
    const config=this.options.config();
    const result=this.#withStore(false,s=>{retryAuthorizedJob(s,id,this.contexts(host,true).map(c=>c.id),config.disclosure.allowedProvenance);return true;});
    if(!result)throw new Error('RETRY_UNAVAILABLE');this.#wake();
  }
  #wake() { try { this.options.wake(); } catch { /* Acceptance is durable even if the drain cannot start. Status remains authoritative. */ } }
}

const help: Record<string,string> = {
  NOT_CONFIGURED:'尚未配置 Common Memory。请运行 common-memory 完成配置，再 /reload。',
  CONTEXT_UNAVAILABLE:'该范围当前不可读。请用 memory_status 或 /memory 查看授权范围，不要猜测项目 ID。',
  INIT_DISABLED:'未授权导入 Agent 材料。请在 Common Memory 配置中由用户授权 agent_observation；本页面不会自动扩大权限。',
  ADJUSTMENT_DISABLED:'该范围未授权用户表达或写入。请检查 Common Memory 的来源、读取与写入授权。',
  IMPORT_CONFIRMATION_REQUIRED:'导入必须由用户确认。请在交互式 Pi 中使用 /memory，不能用参数代替授权。',
  INVALID_SUBMISSION_ID:'使用原始 importId 或 requestId（两者选一），1–128 位字母、数字、下划线或短横线。',
  INVALID_TEXT_SIZE:'材料必须完整且非空，并符合已配置字节限制。不要截断正文或删除限定条件。',
  INVALID_IMPORT_LABEL:'来源标签需以字母或数字开头，1–64 位 ASCII 字母、数字、空格、点、下划线、冒号或短横线。',
  INVALID_IMPORT_BASIS:'请选择材料实际来源，不确定时使用 unknown。',
  SUBMISSION_CONFLICT:'这个 ID 已对应不同内容或范围。请保留原 ID 和原材料核对状态，不要换 ID 绕过冲突。',
  RETRY_UNAVAILABLE:'该任务不可重试：仅当前完整授权范围内、来源授权有效的失败终态任务可由用户重试。',
  CANCELLED:'已取消。若之前已接受提交，取消不会撤回材料，请用原 ID 查询状态。',
  SENSITIVE_CONTENT_REJECTED:'材料未通过敏感内容或字节限制检查，没有提交。请检查输入与配置，勿以拆分或截断绕过校验。',
};
export function nativeFailure(error: unknown): Error {
  const controlled=error && typeof error==='object' && 'code' in error && typeof error.code==='string' ? error.code : error instanceof Error ? error.message : '';
  const code=Object.hasOwn(help,controlled)?controlled:'MEMORY_UNAVAILABLE';
  return new Error(`${code}: ${help[code] ?? '记忆操作暂不可用。请检查 Common Memory 配置与本地存储；若提交状态不确定，先查原 ID，不要重复提交。'}`);
}
export type NativeStatus = ReturnType<PiMemoryService['status']>;
