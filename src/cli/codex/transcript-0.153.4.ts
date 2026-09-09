import type { SessionMessage, SessionTurnState } from '../../v2/session.js';
export interface TranscriptState { turnId:string|null; offset:number }
export type TranscriptAction = {kind:'message';message:SessionMessage}|{kind:'settle';turnId:string;state:SessionTurnState};
/** Pinned rollout adapter. Only user_message delivery events carry user evidence;
 * response_item user messages (environment, hooks and compact replay) never do. */
export function parseTranscript(text:string, state:TranscriptState, scope:string):{actions:TranscriptAction[];state:TranscriptState} {
  const actions:TranscriptAction[]=[];
  let turnId=state.turnId,offset=state.offset;
  if(text && !text.endsWith('\n'))throw new Error('CODEX_PARTIAL_TRANSCRIPT');
  for(const line of text.split('\n').slice(0,-1)) {
    const id=`rollout-${offset}`;offset+=Buffer.byteLength(line)+1;
    let row:Record<string,unknown>;
    try {row=JSON.parse(line);}catch{throw new Error('CODEX_UNKNOWN_TRANSCRIPT');}
    if(!row||typeof row!=='object'||typeof row.type!=='string'||!row.payload||typeof row.payload!=='object')throw new Error('CODEX_UNKNOWN_TRANSCRIPT');
    const p=row.payload as Record<string,unknown>;
    if(row.type==='session_meta') {if(p.cli_version!=='0.153.4')throw new Error('CODEX_UNSUPPORTED_VERSION');continue;}
    if(!['event_msg','response_item','turn_context','compacted','world_state','token_usage_record'].includes(row.type))throw new Error('CODEX_UNKNOWN_TRANSCRIPT');
    if(['event_msg','response_item'].includes(row.type)&&typeof p.type!=='string')throw new Error('CODEX_UNKNOWN_TRANSCRIPT');
    if(row.type==='event_msg') {
      if(p.type==='task_started') {if(typeof p.turn_id!=='string')throw new Error('CODEX_UNKNOWN_TRANSCRIPT');if(turnId&&turnId!==p.turn_id)throw new Error('CODEX_UNSETTLED_TURN');turnId=p.turn_id;}
      if(p.type==='item_completed' && (p.item as Record<string,unknown>)?.type==='UserMessage') {
        const item=p.item as Record<string,unknown>;
        if(!turnId||p.turn_id!==turnId||typeof item.id!=='string'||!Array.isArray(item.content)||typeof row.timestamp!=='string')throw new Error('CODEX_UNCONFIRMED_DELIVERY');
        const parts=item.content as Record<string,unknown>[];
        const supported=parts.every(c=>c&&c.type==='text'&&typeof c.text==='string');
        const body=parts.filter(c=>c&&c.type==='text'&&typeof c.text==='string').map(c=>c.text).join('\n');
        if(supported&&!body)continue; // Structured skill invocation can submit no user expression.
        actions.push({kind:'message',message:{id:'item-'+item.id,turnId,role:'user',text:body||'[unsupported non-text user content]',scope,source:supported?'codex_user_delivery':'unsupported_content',observedAt:row.timestamp}});
      }
      if(p.type==='user_message') {
        if(!turnId||typeof p.message!=='string'||typeof row.timestamp!=='string')throw new Error('CODEX_UNCONFIRMED_DELIVERY');
        const unsupported=['images','local_images','audio','local_audio'].some(k=>Array.isArray(p[k])&&(p[k] as unknown[]).length>0);
        if(!unsupported&&!p.message)continue;
        actions.push({kind:'message',message:{id,turnId,role:'user',text:p.message||'[unsupported non-text user content]',scope,source:unsupported?'unsupported_content':'codex_user_delivery',observedAt:row.timestamp}});
      }
      if(p.type==='task_complete'||p.type==='turn_aborted') {
        if(typeof p.turn_id!=='string'||(turnId!==null&&turnId!==p.turn_id))throw new Error('CODEX_UNKNOWN_COMPLETION');
        actions.push({kind:'settle',turnId:p.turn_id,state:p.type==='turn_aborted'||p.error?'interrupted':'settled'});turnId=null;
      }
    }
    if(row.type==='response_item'&&turnId&&typeof row.timestamp==='string') {
      let body:string|undefined,role:'assistant'|'tool'='assistant';
      if(p.type==='message'&&p.role==='assistant'&&Array.isArray(p.content))body=p.content.flatMap(c=>c&&typeof c==='object'&&'text' in c&&typeof c.text==='string'?[c.text]:[]).join('\n');
      if(p.type==='function_call_output'||p.type==='custom_tool_call_output') {role='tool';body=typeof p.output==='string'?p.output:JSON.stringify(p.output);}
      if(body)actions.push({kind:'message',message:{id,turnId,role,text:body,scope,source:'conversation_context',observedAt:row.timestamp}});
    }
  }
  return {actions,state:{turnId,offset}};
}
