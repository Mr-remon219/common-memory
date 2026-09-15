import type { CommonMemoryConfig } from '../../src/config/config.js';
import type { PiCapturePort } from '../../src/pi-extension/extraction-runtime.js';
import type { PiServicePort } from '../../src/pi-extension/memory-service.js';
import { dispatchOperation } from '../../src/service/operations.js';
import type { ChannelIdentity, ServiceRequest } from '../../src/service/protocol.js';
import type { RuntimeStore } from '../../src/v2/runtime.js';

/** Test adapter over the real daemon business dispatcher; it is not a second implementation. */
export class DispatchPort implements PiCapturePort,PiServicePort {
  #sequence=0;
  constructor(readonly store:RuntimeStore,readonly config:()=>CommonMemoryConfig,readonly channel:ChannelIdentity={kind:'pi',processInstance:'test-process'},readonly home=''){}
  async call<T=unknown>(operation:string,payload:unknown={},options:{requestId?:string;signal?:AbortSignal;timeoutMs?:number;wake?:boolean}={}):Promise<T>{
    options.signal?.throwIfAborted();const request:ServiceRequest={protocol:1,id:`unit-${++this.#sequence}`,grantId:'unit',channel:this.channel,authentication:'unit',operation,payload};
    return this.store.transaction(()=>dispatchOperation(this.store,request,this.channel,this.config(),this.home).result as T);
  }
}
