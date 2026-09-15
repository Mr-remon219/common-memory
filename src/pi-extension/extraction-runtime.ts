import { createHash, randomUUID } from 'node:crypto';
import { piDiagnosticReporter } from './diagnostics.js';
import { ServiceClient } from '../service/client.js';
const processState=globalThis as typeof globalThis&{__commonMemoryPiInstance?:string};
export const piProcessInstance=processState.__commonMemoryPiInstance??=randomUUID();

export interface SessionUserEntry {sequence?:number;id:string;text:string;timestamp:number}
export interface PiCapturePort {call<T=unknown>(operation:string,payload:unknown,options?:{requestId?:string;signal?:AbortSignal;wake?:boolean}):Promise<T>}
const requestId=(operation:string,payload:unknown)=>`pi-${createHash('sha256').update(JSON.stringify([operation,payload])).digest('hex')}`;
/** Host event adapter only. Core session state and Writer live in the independent service. */
export class PiCaptureRuntime {
  readonly #report=piDiagnosticReporter();
  readonly #port:PiCapturePort;
  #tail:Promise<void>=Promise.resolve();
  #closed=false;
  constructor(port:PiCapturePort=new ServiceClient({kind:'pi',processInstance:piProcessInstance})){this.#port=port;}
  #send(operation:string,payload:unknown,wake=true):Promise<void>{
    if(this.#closed)return Promise.reject(new Error('CANCELLED'));
    const id=requestId(operation,payload),options={requestId:id,wake};
    const run=this.#tail.catch(()=>{}).then(async()=>{try{await this.#port.call(operation,payload,options);}catch(error){if(!(error instanceof Error)||error.message!=='DELIVERY_UNCERTAIN')throw error;await this.#port.call(operation,payload,options);}});
    this.#tail=run;return run.catch(error=>{this.#report('capture',error);});
  }
  start(sessionId:string,entries:SessionUserEntry[],cwd=''):Promise<void>{return this.#send('pi.start',{sessionId,cwd,entries});}
  input(input:{sessionId:string;cwd:string;text:string;source:string;streamingBehavior?:'steer'|'followUp';parentEntryId?:string|null;hasUnsupportedContent?:boolean}):Promise<void>{return this.#send('pi.input',input,false);}
  delivered(sessionId:string,text:string,timestamp:number,hasUnsupportedContent=false,cwd=''):Promise<void>{return this.#send('pi.delivered',{sessionId,cwd,text,timestamp,hasUnsupportedContent},false);}
  bind(sessionId:string,entries:SessionUserEntry[],cwd=''):Promise<void>{return this.#send('pi.bind',{sessionId,cwd,entries});}
  cancelInputs(sessionId:string,cwd=''):Promise<void>{return this.#send('pi.cancel-inputs',{sessionId,cwd},false);}
  busy():void{/* Model lifecycle never controls Core scheduling. */}
  settled(sessionId:string,entries:SessionUserEntry[],state:'settled'|'interrupted'='settled',cwd=''):Promise<void>{return this.#send('pi.settled',{sessionId,cwd,entries,state});}
  context(sessionId:string,entries:readonly {sequence?:number;id:string;role:'assistant'|'tool';text:string;timestamp:number}[],cwd=''):Promise<void>{return this.#send('pi.context',{sessionId,cwd,entries:[...entries]},false);}
  end(sessionId:string,cwd=''):Promise<void>{return this.#send('pi.end',{sessionId,cwd});}
  flush(sessionId:string,cwd=''):Promise<void>{return this.#send('pi.flush',{sessionId,cwd});}
  async shutdown():Promise<void>{if(this.#closed)return;this.#closed=true;await this.#tail.catch(()=>{});}
}
