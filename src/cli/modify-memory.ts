import { randomUUID } from 'node:crypto';
import type { CommonMemoryConfig } from '../config/config.js';
import { ProjectRegistry } from '../v2/registry.js';
import type { ObservationOutcome } from '../v2/runtime.js';
import { validateMemoryEdit } from '../v2/edit-ingress.js';
import { ServiceClient } from '../service/client.js';
import { setTimeout as delay } from 'node:timers/promises';

export interface ModifyMemoryResult {requestId:string;complete:boolean;outcome:ObservationOutcome;cancelled:boolean}
/** User-facing CLI channel. Admission and processing are owned by the service. */
export async function modifyMemory(config:CommonMemoryConfig,prompt:string,options:{workspace?:string;signal?:AbortSignal}={}):Promise<ModifyMemoryResult>{
  if(!prompt.trim())throw new Error('请填写想修改的内容。');if(!config.disclosure.allowedProvenance.includes('user_explicit'))throw new Error('当前配置未授权处理用户表达，没有提交修改。');let scope='global';if(options.workspace!==undefined){const project=new ProjectRegistry(config.dataRoot).resolve(options.workspace);if(!project)throw new Error('项目尚未登记，没有提交修改。');scope=`project:${project.id}`;}if(!config.disclosure.allowedScopes.includes(scope)||!config.writableScopes.includes(scope))throw new Error('当前记忆范围未授权读取或修改，没有提交修改。');
  const requestId=`tui:${randomUUID()}`,entryId='submitted',input={sessionId:requestId,requestId:entryId,text:prompt,scope};validateMemoryEdit(input,{allowedScopes:config.disclosure.allowedScopes,writableScopes:config.writableScopes,allowedProvenance:config.disclosure.allowedProvenance,limits:config.disclosure});options.signal?.throwIfAborted();const client=new ServiceClient({kind:'cli'});let admitted=false;
  try{
    const admissionOptions={requestId:`edit-${requestId.slice(4)}`,...(options.signal?{signal:options.signal}:{})};
    try{await client.call('edit.submit',input,admissionOptions);}catch(error){if(!(error instanceof Error)||error.message!=='DELIVERY_UNCERTAIN')throw error;await client.call('edit.submit',input,admissionOptions);}admitted=true;
    for(;;){const outcome=await client.call<ObservationOutcome|null>('edit.status',{sessionId:requestId,requestId:entryId},{wake:false});if(!outcome)throw new Error('MEMORY_UNAVAILABLE');if(options.signal?.aborted||['processed','dead','paused','quarantined'].includes(outcome.state))return {requestId,complete:outcome.state==='processed'&&['modified','already_satisfied'].includes(outcome.editResult??''),outcome,cancelled:Boolean(options.signal?.aborted)};await delay(250,undefined,{...(options.signal?{signal:options.signal}:{})});}
  }catch(error){if(options.signal?.aborted&&admitted){const outcome=await client.call<ObservationOutcome|null>('edit.status',{sessionId:requestId,requestId:entryId},{wake:false}).catch(()=>null);if(outcome)return {requestId,complete:false,outcome,cancelled:true};}if(admitted)throw new Error(`请求 ${requestId} 已提交，但未能确认处理结果。请在 Memory Control → Adjust Memory → Processing Status 检查；不要重复提交。`,{cause:error});if(error instanceof Error&&error.message==='DELIVERY_UNCERTAIN')throw new Error(`请求 ${requestId} 的投递状态不确定；请保留此 ID 查询，不要更换 ID。`,{cause:error});throw error;}
}
