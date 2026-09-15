import { randomUUID } from 'node:crypto';
import type { CommonMemoryConfig } from '../config/config.js';
import { readAuthorizedMemory } from '../v2/reader.js';
import type { AgentImportSubmission } from '../v2/agent-ingress.js';
import { nextForAcceptance, nextForOutcome } from '../v2/service-guidance.js';
import { ServiceClient } from '../service/client.js';
import { piInfo } from '../service/operations.js';
import { piProcessInstance } from './extraction-runtime.js';

export interface NativeIdentity {importId?:string;requestId?:string}
export interface MemoryHost {cwd:string;sessionId:string}
export interface PiServicePort {call<T=unknown>(operation:string,payload?:unknown,options?:{requestId?:string;signal?:AbortSignal;timeoutMs?:number;wake?:boolean}):Promise<T>}
interface PiStatusResult {item?:import('../v2/runtime.js').ObservationOutcome|null;queue?:ReturnType<typeof import('../v2/service-status.js').scopedQueueStatus>;recent?:{importId?:string;requestId?:string;contextId:string;outcome:import('../v2/runtime.js').ObservationOutcome}[]}
/** Pi channel facade. Canonical reads stay local; all runtime state uses private IPC. */
export class PiMemoryService {
  readonly #client:PiServicePort;
  constructor(readonly options:{config:()=>CommonMemoryConfig;client?:PiServicePort}){this.#client=options.client??new ServiceClient({kind:'pi',processInstance:piProcessInstance});}
  async #admit<T>(operation:string,payload:unknown,options:{requestId:string;signal?:AbortSignal}):Promise<T>{try{return await this.#client.call<T>(operation,payload,options);}catch(error){if(!(error instanceof Error)||error.message!=='DELIVERY_UNCERTAIN')throw error;return this.#client.call<T>(operation,payload,options);}}
  contexts(host:MemoryHost,human=false){return this.info(host,human).contexts;}
  read(host:MemoryHost,contextId?:string,human=false){const config=this.options.config(),contexts=this.contexts(host,human).map(c=>c.id);if(contextId!==undefined&&!contexts.includes(contextId))throw new Error('CONTEXT_UNAVAILABLE');return readAuthorizedMemory({dataRoot:config.dataRoot,contexts:contextId===undefined?contexts:[contextId]});}
  info(host:MemoryHost,human=false){return piInfo(this.options.config(),host.cwd,human);}
  async status(host:MemoryHost,identity:NativeIdentity={},human=false){
    if(identity.importId!==undefined&&identity.requestId!==undefined)throw new Error('INVALID_SUBMISSION_ID');
    const info=this.info(host,human),modelContexts=this.contexts(host).map(c=>c.id);
    const value=await this.#client.call<PiStatusResult>(human?'pi.ui.status':'pi.status',{...host,identity},{wake:false});
    if(identity.importId!==undefined||identity.requestId!==undefined)return {...info,item:value.item??null,next:nextForOutcome(value.item??null,identity,modelContexts)};
    return {...info,queue:value.queue??{observations:[],jobStates:[],jobs:[]},recent:value.recent??[],next:{action:'discover' as const,message:'User turns are captured automatically; do not submit summaries or duplicate them. Open /memory to browse, adjust, import or recover. Processed does not mean remembered. Use memory_read to verify authorized destinations.'}};
  }
  /** Call only after actual host user confirmation, never a model-supplied approved flag. */
  async import(host:MemoryHost,input:AgentImportSubmission,signal?:AbortSignal,human=false){
    const info=this.info(host,human);if(!info.initEnabled)throw new Error('INIT_DISABLED');if(!info.contexts.some(c=>c.id===input.contextId))throw new Error('CONTEXT_UNAVAILABLE');
    const accepted=await this.#admit<{taskId:string;accepted:true;duplicate:boolean;state:string;contextId:string}>(human?'pi.ui.import':'pi.import',{...host,input},{requestId:`pi-import-${input.importId}`,...(signal?{signal}:{})});
    return {...accepted,importId:input.importId,next:nextForAcceptance(accepted.state,{importId:input.importId})};
  }
  async adjust(host:MemoryHost,scope:string,prompt:string,requestId:string=randomUUID()){
    const info=this.info(host,true);if(!info.adjustmentContexts.some(c=>c.id===scope))throw new Error('ADJUSTMENT_DISABLED');
    const accepted=await this.#admit<{taskId:string;accepted:true;duplicate:boolean;state:string;contextId:string}>('pi.ui.adjust',{...host,scope,prompt,requestId},{requestId:`pi-adjust-${requestId}`});return {...accepted,requestId,next:nextForAcceptance(accepted.state,{requestId})};
  }
  async flush(host:MemoryHost){return this.#client.call<boolean>('pi.flush',host).then(()=>true);}
  async retry(host:MemoryHost,id:string){await this.#admit('pi.ui.retry',{...host,id},{requestId:`pi-retry-${randomUUID()}`});}
  async cancel(host:MemoryHost,id:string){return this.#admit<{cancelled:boolean;id:string}>('pi.ui.cancel',{...host,id},{requestId:`pi-cancel-${randomUUID()}`});}
}

const help:Record<string,string>={
  NOT_CONFIGURED:'尚未配置 Common Memory。请运行 common-memory 完成配置，再 /reload。',SERVICE_NOT_INSTALLED:'Common Memory 独立服务尚未安装。请重新打开 Common Memory 并应用 Agent Integration。',SERVICE_UNAVAILABLE:'Common Memory 独立服务未响应；本次请求没有确认接受。',DELIVERY_UNCERTAIN:'到独立服务的响应中断；请求可能已接受。请保留原 ID 查询状态，不要更换 ID。',SERVICE_DISABLED:'Common Memory 独立服务已停止；本页面不会自行重新启用。',SERVICE_CONFIGURATION_CHANGED:'Common Memory 配置已更新；请重启独立服务后重试。',CHANNEL_NOT_REGISTERED:'当前 Pi 渠道尚未登记；请重开 Common Memory 并 /reload。',
  CONTEXT_UNAVAILABLE:'该范围当前不可读。请用 memory_status 或 /memory 查看授权范围，不要猜测项目 ID。',INIT_DISABLED:'未授权导入 Agent 材料。请在 Common Memory 配置中由用户授权 agent_observation；本页面不会自动扩大权限。',ADJUSTMENT_DISABLED:'该范围未授权用户表达或写入。请检查 Common Memory 的来源、读取与写入授权。',IMPORT_CONFIRMATION_REQUIRED:'导入必须由用户确认。请在交互式 Pi 中使用 /memory，不能用参数代替授权。',INVALID_SUBMISSION_ID:'使用原始 importId 或 requestId（两者选一），1–128 位字母、数字、下划线或短横线。',INVALID_TEXT_SIZE:'材料必须完整且非空，并符合已配置字节限制。不要截断正文或删除限定条件。',INVALID_IMPORT_LABEL:'来源标签格式无效。',INVALID_IMPORT_BASIS:'请选择材料实际来源。',SUBMISSION_CONFLICT:'这个 ID 已对应不同内容或范围。请保留原 ID 和原材料核对状态。',RETRY_UNAVAILABLE:'该任务不可重试。',TASK_UNAVAILABLE:'该任务不在当前完整授权范围内。',CANCELLED:'已取消等待；若服务已接受，请用原 ID 查询状态。',SENSITIVE_CONTENT_REJECTED:'材料未通过敏感内容或字节限制检查，没有提交。'};
export function nativeFailure(error:unknown):Error{const controlled=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'?error.code:error instanceof Error?error.message:'';const code=Object.hasOwn(help,controlled)?controlled:'MEMORY_UNAVAILABLE';return new Error(`${code}: ${help[code]??'记忆操作暂不可用。请检查 Common Memory 服务；若投递状态不确定，先查原 ID。'}`);}
export type NativeStatus=Awaited<ReturnType<PiMemoryService['status']>>;
