import { appendFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,expect,it } from 'vitest';
import { defaultConfig } from '../../src/config/config.js';
import { parseHookEvent,type HookOutput } from '../../src/cli/codex-hook.js';
import { dispatchOperation } from '../../src/service/operations.js';
import { consumeCodexInbox } from '../../src/cli/codex-session.js';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { renderHostConfig } from '../../src/cli/work-config.js';
import { parse } from 'smol-toml';
const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'work-session-'));roots.push(home);
 const config=defaultConfig({COMMON_MEMORY_HOME:home});config.remote.model='fake';writeFileSync(join(home,'config.json'),JSON.stringify(config));
 const transcript=join(home,'rollout.jsonl');writeFileSync(transcript,JSON.stringify({type:'session_meta',payload:{cli_version:'0.153.4'}})+'\n');
 const memory=(value:string)=>{mkdirSync(join(config.dataRoot,'memory'),{recursive:true});writeFileSync(join(config.dataRoot,'memory/profile.md'),'# Profile\n\n## Synthetic\n'+value);};
 const dispatch=(operation:string,payload:unknown,client:'codex'|'chatgpt-work'='chatgpt-work',instance='host')=>{const store=new RuntimeStore(config.dataRoot);try{return store.transaction(()=>dispatchOperation(store,{protocol:1,id:'unit',grantId:'unit',channel:{kind:'hook',client,instance},authentication:'unit',operation,payload},{kind:'hook',client,instance},config,home).result as HookOutput);}finally{store.close();}};
 const hook=(event='SessionStart',source='startup',thread='s',prompt='',turn='t',client:'codex'|'chatgpt-work'='chatgpt-work',instance='host')=>dispatch('hook.event',{event:parseHookEvent(JSON.stringify({hook_event_name:event,source,session_id:thread,prompt,turn_id:turn,cwd:home,transcript_path:transcript}))},client,instance);
 const refresh=(client:'codex'|'chatgpt-work',instance:string,thread:string)=>dispatch('hook.refresh',{thread},client,instance);
 const append=(payload:object,type='event_msg')=>appendFileSync(transcript,JSON.stringify({type,payload,timestamp:'2026-09-09T00:00:00Z'})+'\n');
 const inspect=<T>(fn:(store:RuntimeStore)=>T)=>{const store=new RuntimeStore(config.dataRoot);try{return fn(store);}finally{store.close();}};
 return {home,config,memory,hook,refresh,append,inspect};
}
const body=(r:HookOutput)=>r.hookSpecificOutput?.additionalContext;
it('refresh replaces the sole slot A→B, C remains invisible; empty skill prompt and fallback delivery preserve counts',async()=>{
 const f=fixture();f.memory('SNAPSHOT_A');expect(body(f.hook())).toContain('SNAPSHOT_A');
 f.hook('UserPromptSubmit');f.append({type:'task_started',turn_id:'t'});f.append({type:'item_completed',turn_id:'t',item:{type:'UserMessage',id:'empty-skill',content:[]}});f.append({type:'task_complete',turn_id:'t'});f.memory('SNAPSHOT_B');f.refresh('chatgpt-work','host','s');f.memory('SNAPSHOT_C');
 expect(body(f.hook('PostToolUse'))).toContain('SNAPSHOT_B');expect(f.hook('PostToolUse')).toEqual({});expect(f.hook('UserPromptSubmit')).toEqual({});
 for(const source of ['compact','clear','reload'])expect(body(f.hook('SessionStart',source))).toContain('SNAPSHOT_B');
 expect(f.hook('SessionStart','resume')).toEqual({});
 f.memory('SNAPSHOT_D');f.refresh('chatgpt-work','host','s');f.refresh('chatgpt-work','host','s');
 expect(body(f.hook('UserPromptSubmit'))).toContain('SNAPSHOT_D');
 await consumeCodexInbox(f.config);
 f.inspect(s=>{expect(s.db.prepare('SELECT COUNT(*) AS n FROM host_snapshots').get()!.n).toBe(1);expect(s.db.prepare('SELECT COUNT(*) AS n FROM session_turns').get()!.n).toBe(0);});
});
it('isolates client, thread, process and ended activation while retaining queued tails',async()=>{
 const f=fixture();f.memory('A');f.hook();f.hook('SessionStart','startup','b');f.hook('SessionStart','startup','s','','t','codex');
 f.memory('B');f.refresh('chatgpt-work','host','s');expect(f.hook('PostToolUse','startup','b')).toEqual({});expect(f.hook('PostToolUse','startup','s','','t','codex')).toEqual({});
 expect(()=>f.refresh('chatgpt-work','wrong','s')).toThrow('SESSION_REFRESH_ACTIVATION_REQUIRED');expect(()=>f.refresh('chatgpt-work','host','')).toThrow('SESSION_REFRESH_IDENTITY_REQUIRED');
 f.hook('SessionEnd');expect(()=>f.refresh('chatgpt-work','host','s')).toThrow('SESSION_REFRESH_ACTIVATION_REQUIRED');
 f.memory('C');expect(body(f.hook())).toContain('C');expect(body(f.hook('SessionStart','resume','s','','t','chatgpt-work','new-host'))).toContain('C');
 await consumeCodexInbox(f.config);
 f.inspect(s=>{expect(s.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n).toBe(5);expect(s.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE closing=1').get()!.n).toBe(1);});
});
it('failed reads and capacity rejection roll back replacement including pending delivery',()=>{
 const f=fixture();f.memory('A');f.hook();f.memory('B');f.refresh('chatgpt-work','host','s');
 f.memory('x'.repeat(70000));expect(()=>f.refresh('chatgpt-work','host','s')).toThrow('CONTEXT_LIMIT');expect(body(f.hook('PostToolUse'))).toContain('B');
 const snapshot=f.inspect(s=>String(s.db.prepare('SELECT body FROM host_snapshots').get()!.body));
 f.config.sessionCache={maxSessionBytes:Buffer.byteLength(snapshot)+10};writeFileSync(join(f.home,'config.json'),JSON.stringify(f.config));
 f.memory('x'.repeat(1000));expect(()=>f.refresh('chatgpt-work','host','s')).toThrow('SESSION_CAPACITY_EXCEEDED');
 expect(f.inspect(s=>s.db.prepare('SELECT body FROM host_snapshots').get()!.body)).toBe(snapshot);
});
it('revoked snapshot authorization replaces frozen content before reinjection',()=>{const f=fixture();f.memory('AUTHORIZED_THEN_REVOKED');expect(body(f.hook())).toContain('AUTHORIZED_THEN_REVOKED');f.refresh('chatgpt-work','host','s');f.config.disclosure.allowedScopes=[];expect(body(f.hook('PostToolUse'))).not.toContain('AUTHORIZED_THEN_REVOKED');});

it('actual item delivery seals each settled turn, deduplicates legacy delivery and excludes environment records',async()=>{
 const f=fixture();f.hook();
 for(let i=0;i<10;i++){
  const turn='t'+i,text='Synthetic expression '+i;f.hook('UserPromptSubmit','startup','s',text,turn);
  f.append({type:'task_started',turn_id:turn});f.append({full:true,state:{}},'world_state');f.append({thread_id:'s',turn_id:turn},'token_usage_record');
  f.append({type:'item_completed',turn_id:turn,item:{type:'UserMessage',id:'u'+i,content:[{type:'text',text}]}});
  f.append({type:'user_message',message:text});f.append({type:'message',role:'user',content:[{type:'input_text',text:'Skill/environment instructions'}]},'response_item');f.append({type:'task_complete',turn_id:turn});
  f.hook('PostToolUse');await consumeCodexInbox(f.config);
  f.inspect(s=>expect(s.pending()).toHaveLength(i+1));
 }
 f.inspect(s=>expect(s.db.prepare('SELECT COUNT(*) AS n FROM observations').get()!.n).toBe(10));
});
it('unconfirmed item retains the inbox and cannot promote skill text',async()=>{
 const f=fixture();f.hook();f.hook('UserPromptSubmit');f.append({type:'task_started',turn_id:'t'});f.append({type:'item_completed',turn_id:'t',item:{type:'UserMessage',id:'skill',content:[{type:'text',text:'Skill injected instruction'}]}});f.hook('SessionEnd');
 expect(await consumeCodexInbox(f.config)).toMatchObject({complete:false,isolated:1,recoveries:[{issue:'CODEX_UNCONFIRMED_DELIVERY'}]});f.inspect(s=>expect(s.db.prepare('SELECT body FROM codex_inbox ORDER BY id DESC LIMIT 1').get()!.body).toContain('Skill injected instruction'));
});
it.each(['codex','chatgpt-work'] as const)('terminal %s hooks never emit or consume a pending refresh',client=>{
 const f=fixture();f.memory('A');f.hook('SessionStart','startup','s','','t',client);
 f.memory('B');f.refresh(client,'host','s');
 expect(f.hook('Stop','startup','s','','t',client)).toEqual({});
 expect(f.hook('Interrupt','startup','s','','t',client)).toEqual({});
 expect(body(f.hook('PostToolUse','startup','s','','t',client))).toContain('B');
 f.memory('C');f.refresh(client,'host','s');
 expect(f.hook('SessionEnd','startup','s','','t',client)).toEqual({});
});
it.skipIf(process.platform==='win32')('generates POSIX skills and isolated MCP identities without trust bypass',()=>{
 const env={...process.env,COMMON_MEMORY_HOME:'/tmp/memory home'};
 const work=renderHostConfig('chatgpt-work',{wsl:false},env);expect(work.config).toContain('chatgpt-desktop');expect(work.config).toContain('chatgpt-work');expect(work.policy).toContain('allow_implicit_invocation: false');expect(work.skill).toContain("'session-refresh' '--home' '/tmp/memory home' '--client' 'chatgpt-work'");
 const codex=renderHostConfig('codex',{wsl:false},env);expect(codex.config).toContain('[mcp_servers.common_memory_init]\nenabled = false');expect(codex.config).toContain('codex-cli');
 expect(work.config).not.toContain('bypass');
 for(const bundle of [work,codex]) {
  const hooks=parse(bundle.config).hooks as Record<string,{hooks:Record<string,unknown>[]}[]>;
  expect(Object.keys(hooks)).toEqual(['SessionStart','UserPromptSubmit','PostToolUse','Stop','Interrupt','SessionEnd']);
  for(const [event,entries] of Object.entries(hooks)) {
   const handler=entries[0]!.hooks[0]!;
   expect(handler).toMatchObject({type:'command',async:false,timeout:3});
   if(['SessionStart','UserPromptSubmit','PostToolUse'].includes(event))expect(handler.additionalContextLimit).toBe(0);
   else expect(handler).not.toHaveProperty('additionalContextLimit');
  }
 }
});
