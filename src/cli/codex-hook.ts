import { randomUUID } from 'node:crypto';
import { MEMORY_READ_GUIDANCE } from '../v2/read-guidance.js';
import { isAbsolute } from 'node:path';
import { hostProcessInstance } from './host-process.js';
import type { CodexEvent, HostClient } from './host-session.js';
import { ServiceClient } from '../service/client.js';

export const MAX_HOOK_INPUT_BYTES=1024*1024;
export const MAX_CONTEXT_BYTES=64*1024;
type HookEvent=CodexEvent;
export type HookOutput={hookSpecificOutput:{hookEventName:HookEvent['hook_event_name'];additionalContext:string};systemMessage?:string}|Record<string,never>;

export function parseHookEvent(input:string):HookEvent{
  const invalid=()=>new TypeError('INVALID_CODEX_HOOK_INPUT');if(Buffer.byteLength(input)>MAX_HOOK_INPUT_BYTES)throw invalid();let value:unknown;try{value=JSON.parse(input);}catch{throw invalid();}if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();const event=value as Record<string,unknown>;
  if(typeof event.cwd!=='string'||!isAbsolute(event.cwd)||event.cwd.includes('\0'))throw invalid();if(!['UserPromptSubmit','SessionStart','Stop','SessionEnd','Interrupt','PostToolUse'].includes(String(event.hook_event_name)))throw invalid();if(typeof event.session_id!=='string'||!event.session_id||typeof event.transcript_path!=='string'||!isAbsolute(event.transcript_path)||event.transcript_path.includes('\0'))throw invalid();if(event.hook_event_name==='UserPromptSubmit'&&typeof event.prompt!=='string')throw invalid();if(['UserPromptSubmit','Stop','Interrupt'].includes(String(event.hook_event_name))&&(typeof event.turn_id!=='string'||!event.turn_id))throw invalid();return event as unknown as HookEvent;
}
/** Host channel only: complete event admission and snapshot state are service transactions. */
export async function codexHook(input:string,home:string,instance=hostProcessInstance(),client:HostClient='codex'):Promise<HookOutput>{
  const event=parseHookEvent(input),port=new ServiceClient({kind:'hook',client,instance},home),options={requestId:`hook-event-${randomUUID()}`};
  try{return await port.call<HookOutput>('hook.event',{event},options);}catch(error){if(!(error instanceof Error)||error.message!=='DELIVERY_UNCERTAIN')throw error;return port.call<HookOutput>('hook.event',{event},options);}
}
export async function refreshSession(home:string,client:HostClient,instance=hostProcessInstance(),thread=process.env.CODEX_THREAD_ID):Promise<void>{
  if(!thread)throw new Error('SESSION_REFRESH_IDENTITY_REQUIRED');const port=new ServiceClient({kind:'hook',client,instance},home),options={requestId:`hook-refresh-${randomUUID()}`};try{await port.call('hook.refresh',{thread},options);}catch(error){if(!(error instanceof Error)||error.message!=='DELIVERY_UNCERTAIN')throw error;await port.call('hook.refresh',{thread},options);}
}
export async function runSessionRefresh(args:string[]):Promise<void>{
  const client=args[2]==='--client'?args[3]:'codex';if(![2,4].includes(args.length)||(args.length===4&&args[2]!=='--client')||args[0]!=='--home'||!isAbsolute(args[1]!)||!['codex','chatgpt-work'].includes(client??''))throw new Error('session-refresh requires --home <absolute-path> [--client codex|chatgpt-work]');await refreshSession(args[1]!,client as HostClient);process.stdout.write('Common Memory snapshot refreshed; pending hook injection.\n');
}
export async function runCodexHook(args:string[],client:HostClient='codex'):Promise<void>{
  if(args.length!==2||args[0]!=='--home'||!isAbsolute(args[1]!)||args[1]!.includes('\0'))throw new TypeError('codex-hook requires --home <absolute-path>');const chunks:Buffer[]=[];let bytes=0;for await(const chunk of process.stdin){const buffer=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);bytes+=buffer.length;if(bytes>MAX_HOOK_INPUT_BYTES)throw new TypeError('INVALID_CODEX_HOOK_INPUT');chunks.push(buffer);}let input:string;try{input=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{throw new TypeError('INVALID_CODEX_HOOK_INPUT');}const output=await codexHook(input,args[1]!,undefined,client);process.stdout.write(JSON.stringify(output)+'\n');
}
// Kept in the channel guidance text and service snapshot envelope.
export { MEMORY_READ_GUIDANCE };
