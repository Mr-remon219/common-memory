import { createHmac, timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { McpOptions } from '../mcp/ingress.js';
import { SERVICE_PROTOCOL } from './control.js';

/** Framing bound, not a semantic source limit. Reject oversize; never truncate. */
export const MAX_SERVICE_FRAME = 64 * 1024 * 1024;
export type ChannelIdentity = {kind:'cli'} | {kind:'pi';processInstance:string} | {kind:'hook';client:'codex'|'chatgpt-work';instance:string} | {kind:'mcp';options:McpOptions};
export interface ServiceRequest {protocol:1;id:string;grantId:string;channel:ChannelIdentity;authentication:string;operation:string;payload:unknown}
export type GrantIdentity = Exclude<ChannelIdentity,{kind:'pi'}> | {kind:'pi'};
export function grantIdentity(channel:ChannelIdentity|GrantIdentity):GrantIdentity {
  const id=(value:unknown)=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
  if(channel.kind==='cli')return {kind:'cli'};
  if(channel.kind==='pi')return {kind:'pi'};
  if(channel.kind==='hook'&&['codex','chatgpt-work'].includes(channel.client)&&typeof channel.instance==='string'&&channel.instance.length>0&&channel.instance.length<=512&&!/[\u0000-\u001f\u007f]/u.test(channel.instance))return {kind:'hook',client:channel.client,instance:channel.instance};
  if(channel.kind==='mcp'){
    const o=channel.options;
    if(!o||!id(o.clientId)||typeof o.global!=='boolean'||typeof o.accept!=='boolean'||!Array.isArray(o.capabilities)||!o.capabilities.length||o.capabilities.some(c=>!['relay','init','read'].includes(c))||!Array.isArray(o.workspaces)||o.workspaces.some(w=>typeof w!=='string'||!isAbsolute(w)||w.includes('\0'))||o.workspaceProjectIds!==undefined&&(!Array.isArray(o.workspaceProjectIds)||o.workspaceProjectIds.length!==o.workspaces.length||o.workspaceProjectIds.some(p=>!id(p))))throw new Error('INVALID_CHANNEL_GRANT');
    return {kind:'mcp',options:{clientId:o.clientId,global:o.global,accept:o.accept,capabilities:[...new Set(o.capabilities)].sort(),workspaces:[...o.workspaces],...(o.workspaceProjectIds?{workspaceProjectIds:[...o.workspaceProjectIds]}:{})}};
  }
  throw new Error('INVALID_CHANNEL_GRANT');
}
export type ServiceResponse = {protocol:1;id:string;ok:true;result:unknown} | {protocol:1;id:string;ok:false;code:string};
export function authentication(secret:string,request:Omit<ServiceRequest,'authentication'>):string {
  return createHmac('sha256',secret).update(JSON.stringify([request.protocol,request.id,request.grantId,request.channel,request.operation,request.payload])).digest('hex');
}
export function authenticated(request:ServiceRequest,secret:string):boolean {
  if(typeof request.authentication!=='string'||!/^[a-f0-9]{64}$/.test(request.authentication))return false;
  return timingSafeEqual(Buffer.from(request.authentication,'hex'),Buffer.from(authentication(secret,request),'hex'));
}
export function frame(value:unknown):Buffer {
  const body=Buffer.from(JSON.stringify(value));
  if(body.length>MAX_SERVICE_FRAME)throw new Error('SERVICE_FRAME_TOO_LARGE');
  const header=Buffer.alloc(4);header.writeUInt32BE(body.length);return Buffer.concat([header,body]);
}
export class FrameReader {
  #buffer=Buffer.alloc(0);
  push(chunk:Buffer):unknown[] {
    if(this.#buffer.length+chunk.length>MAX_SERVICE_FRAME+4)throw new Error('SERVICE_FRAME_TOO_LARGE');
    this.#buffer=Buffer.concat([this.#buffer,chunk]);const values:unknown[]=[];
    while(this.#buffer.length>=4){const size=this.#buffer.readUInt32BE();if(size>MAX_SERVICE_FRAME)throw new Error('SERVICE_FRAME_TOO_LARGE');if(this.#buffer.length<size+4)break;const body=this.#buffer.subarray(4,size+4);values.push(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)));this.#buffer=this.#buffer.subarray(size+4);}
    return values;
  }
}
export function validRequest(value:unknown):value is ServiceRequest {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const r=value as ServiceRequest;
  return r.protocol===SERVICE_PROTOCOL&&typeof r.grantId==='string'&&/^[a-f0-9]{64}$/.test(r.grantId)&&typeof r.id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(r.id)&&typeof r.operation==='string'&&Boolean(r.channel&&typeof r.channel==='object'&&['cli','pi','hook','mcp'].includes(r.channel.kind));
}
