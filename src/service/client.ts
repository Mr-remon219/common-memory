import { createConnection } from 'node:net';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { configDirectory } from '../config/config.js';
import { loadServiceControl, serviceGrant, socketPath, SERVICE_PROTOCOL, type ChannelGrant } from './control.js';
import { authentication, frame, FrameReader, type ChannelIdentity, type ServiceRequest, type ServiceResponse } from './protocol.js';

export interface CallOptions {requestId?:string;signal?:AbortSignal;timeoutMs?:number;wake?:boolean}
/** A channel owns only this request's wait. Disconnect never cancels accepted work. */
export class ServiceClient {
  readonly channel:ChannelIdentity;
  constructor(channel:ChannelIdentity,readonly home=configDirectory()){
    this.channel=structuredClone(channel);
    if(this.channel.kind==='mcp'){Object.freeze(this.channel.options.capabilities);Object.freeze(this.channel.options.workspaces);if(this.channel.options.workspaceProjectIds)Object.freeze(this.channel.options.workspaceProjectIds);Object.freeze(this.channel.options);}
    Object.freeze(this.channel);
  }
  async call<T=unknown>(operation:string,payload:unknown={},options:CallOptions={}):Promise<T> {
    options.signal?.throwIfAborted();
    const control=loadServiceControl(this.home);
    if(!control)throw new Error('SERVICE_NOT_INSTALLED');
    if(!control.enabled&&!['service.status','service.stop'].includes(operation))throw new Error('SERVICE_DISABLED');
    let grant:ChannelGrant;
    try{grant=serviceGrant(this.channel,this.home);}catch(error){
      if(!(error instanceof Error)||!('code' in error)||error.code!=='ENOENT')throw error;
      // Provisioning runs in a separate Common Memory management process, using
      // constructor-captured launch options, never the operation/tool payload.
      const identity=Buffer.from(JSON.stringify(this.channel)).toString('base64url');
      await new Promise<void>((resolve,reject)=>execFile(control.node,[control.cli,'service','grant',identity,'--home',this.home],{timeout:options.timeoutMs??10000,env:{...process.env,COMMON_MEMORY_HOME:this.home},windowsHide:true},error=>error?reject(new Error('CHANNEL_NOT_REGISTERED')):resolve()));
      grant=serviceGrant(this.channel,this.home);
    }
    const unsigned={protocol:SERVICE_PROTOCOL as 1,id:options.requestId??randomUUID(),grantId:grant.id,channel:this.channel,operation,payload};
    const request:ServiceRequest={...unsigned,authentication:authentication(grant.secret,unsigned)};
    try {return await this.#send<T>(request,options);}
    catch(error){
      if(options.wake===false || !(error instanceof Error) || error.message!=='SERVICE_UNAVAILABLE' || !control.enabled)throw error;
      // Common Memory's management command wakes an already installed OS unit.
      // It never installs a worker in the channel or clears a disabled marker.
      await new Promise<void>((resolve,reject)=>execFile(control.node,[control.cli,'service','wake','--home',this.home],{timeout:options.timeoutMs??10000,env:{...process.env,COMMON_MEMORY_HOME:this.home},windowsHide:true},error=>error?reject(new Error('SERVICE_UNAVAILABLE')):resolve()));
      return this.#send<T>(request,options);
    }
  }
  #send<T>(request:ServiceRequest,options:CallOptions):Promise<T> {
    return new Promise((resolve,reject)=>{
      const socket=createConnection(socketPath(this.home)),reader=new FrameReader();let sent=false,finished=false;
      const finish=(error?:Error,result?:T)=>{if(finished)return;finished=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);socket.destroy();error?reject(error):resolve(result!);};
      const abort=()=>finish(new Error(sent?'DELIVERY_UNCERTAIN':'CANCELLED'));
      const timer=setTimeout(()=>finish(new Error(sent?'DELIVERY_UNCERTAIN':'SERVICE_UNAVAILABLE')),options.timeoutMs??10000);
      socket.once('connect',()=>{try{options.signal?.throwIfAborted();const bytes=frame(request);sent=true;socket.write(bytes);}catch(error){finish(error instanceof Error?error:new Error('SERVICE_UNAVAILABLE'));}});
      socket.on('data',chunk=>{try{for(const value of reader.push(chunk)){const response=value as ServiceResponse;if(response.protocol!==SERVICE_PROTOCOL||response.id!==request.id||typeof response.ok!=='boolean')throw new Error('SERVICE_PROTOCOL_MISMATCH');if(response.ok)finish(undefined,response.result as T);else finish(new Error(response.code));}}catch{finish(new Error('SERVICE_PROTOCOL_MISMATCH'));}});
      socket.once('error',()=>finish(new Error(sent?'DELIVERY_UNCERTAIN':'SERVICE_UNAVAILABLE')));
      socket.once('close',()=>finish(new Error(sent?'DELIVERY_UNCERTAIN':'SERVICE_UNAVAILABLE')));
      options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
    });
  }
}
