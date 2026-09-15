import { createHash } from 'node:crypto';
import type { CommonMemoryConfig } from '../config/config.js';
import { ServiceClient } from '../service/client.js';
import { McpIngress, type InitSubmission, type McpOptions, type Submission, type SubmissionIdentity, type SubmissionOutcome } from './ingress.js';

const requestId=(kind:string,value:unknown)=>`mcp-${createHash('sha256').update(JSON.stringify([kind,value])).digest('hex')}`;
/** Stdio-facing adapter. It owns no Writer or RuntimeStore; Core reauthorizes every call in the service. */
export class McpChannelIngress {
  readonly #surface:McpIngress;
  readonly #client:ServiceClient;
  constructor(readonly config:CommonMemoryConfig,readonly options:McpOptions,home?:string){
    this.#surface=new McpIngress(null,config,options);
    this.#client=new ServiceClient({kind:'mcp',options},home);
  }
  get capabilities(){return this.#surface.capabilities;}
  has(capability:Parameters<McpIngress['has']>[0]){return this.#surface.has(capability);}
  contexts(){return this.#surface.contexts();}
  info(){return this.#surface.info();}
  read(contextId?:string){return this.#surface.read(contextId);}
  submit(input:Submission,signal?:AbortSignal){return this.#client.call<ReturnType<McpIngress['submit']>>('mcp.submit',input,{requestId:requestId('submit',[input.submissionId,input.conversationId]),...(signal?{signal}:{})});}
  init(input:InitSubmission,signal?:AbortSignal){return this.#client.call<ReturnType<McpIngress['init']>>('mcp.init',input,{requestId:requestId('init',input.importId),...(signal?{signal}:{})});}
  status(input:SubmissionIdentity){return this.#client.call<SubmissionOutcome|null>('mcp.status',input,{requestId:requestId('status',[input.submissionId,input.conversationId]),wake:false});}
  initStatus(importId:string){return this.#client.call<SubmissionOutcome|null>('mcp.status',{importId},{requestId:requestId('init-status',importId),wake:false});}
}
