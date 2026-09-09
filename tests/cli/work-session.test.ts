import { appendFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach,expect,it } from 'vitest';
import { defaultConfig } from '../../src/config/config.js';
import { codexHook,refreshSession } from '../../src/cli/codex-hook.js';
import { consumeCodexInbox } from '../../src/cli/codex-session.js';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { renderHostConfig,renderWindowsBridge } from '../../src/cli/work-config.js';
const roots:string[]=[];
afterEach(()=>roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
function fixture(){
 const home=mkdtempSync(join(tmpdir(),'work-session-'));roots.push(home);
 const config=defaultConfig({COMMON_MEMORY_HOME:home});config.remote.model='fake';writeFileSync(join(home,'config.json'),JSON.stringify(config));
 const transcript=join(home,'rollout.jsonl');writeFileSync(transcript,JSON.stringify({type:'session_meta',payload:{cli_version:'0.153.4'}})+'\n');
 const memory=(value:string)=>{mkdirSync(join(config.dataRoot,'memory'),{recursive:true});writeFileSync(join(config.dataRoot,'memory/profile.md'),'# Profile\n\n## Synthetic\n'+value);};
 const hook=(event='SessionStart',source='startup',thread='s',prompt='',turn='t',client:'codex'|'chatgpt-work'='chatgpt-work',instance='host')=>codexHook(JSON.stringify({hook_event_name:event,source,session_id:thread,prompt,turn_id:turn,cwd:home,transcript_path:transcript}),home,instance,client);
 const append=(payload:object,type='event_msg')=>appendFileSync(transcript,JSON.stringify({type,payload,timestamp:'2026-09-09T00:00:00Z'})+'\n');
 const inspect=<T>(fn:(store:RuntimeStore)=>T)=>{const store=new RuntimeStore(config.dataRoot);try{return fn(store);}finally{store.close();}};
 return {home,config,memory,hook,append,inspect};
}
const body=(r:ReturnType<typeof codexHook>)=>r.hookSpecificOutput?.additionalContext;
it('refresh replaces the sole slot A→B, C remains invisible; empty skill prompt and fallback delivery preserve counts',async()=>{
 const f=fixture();f.memory('SNAPSHOT_A');expect(body(f.hook())).toContain('SNAPSHOT_A');
 f.hook('UserPromptSubmit');f.append({type:'task_started',turn_id:'t'});f.append({type:'item_completed',turn_id:'t',item:{type:'UserMessage',id:'empty-skill',content:[]}});f.append({type:'task_complete',turn_id:'t'});f.memory('SNAPSHOT_B');refreshSession(f.home,'chatgpt-work','host','s');f.memory('SNAPSHOT_C');
 expect(body(f.hook('PostToolUse'))).toContain('SNAPSHOT_B');expect(f.hook('PostToolUse')).toEqual({});expect(f.hook('UserPromptSubmit')).toEqual({});
 for(const source of ['compact','clear','reload'])expect(body(f.hook('SessionStart',source))).toContain('SNAPSHOT_B');
 expect(f.hook('SessionStart','resume')).toEqual({});
 f.memory('SNAPSHOT_D');refreshSession(f.home,'chatgpt-work','host','s');refreshSession(f.home,'chatgpt-work','host','s');
 expect(body(f.hook('UserPromptSubmit'))).toContain('SNAPSHOT_D');
 await consumeCodexInbox(f.config);
 f.inspect(s=>{expect(s.db.prepare('SELECT COUNT(*) AS n FROM host_snapshots').get()!.n).toBe(1);expect(s.db.prepare('SELECT COUNT(*) AS n FROM session_turns').get()!.n).toBe(0);});
});
it('isolates client, thread, process and ended activation while retaining queued tails',async()=>{
 const f=fixture();f.memory('A');f.hook();f.hook('SessionStart','startup','b');f.hook('SessionStart','startup','s','','t','codex');
 f.memory('B');refreshSession(f.home,'chatgpt-work','host','s');expect(f.hook('PostToolUse','startup','b')).toEqual({});expect(f.hook('PostToolUse','startup','s','','t','codex')).toEqual({});
 expect(()=>refreshSession(f.home,'chatgpt-work','wrong','s')).toThrow('ACTIVATION_REQUIRED');expect(()=>refreshSession(f.home,'chatgpt-work','host','')).toThrow('IDENTITY_REQUIRED');
 f.hook('SessionEnd');expect(()=>refreshSession(f.home,'chatgpt-work','host','s')).toThrow('ACTIVATION_REQUIRED');
 f.memory('C');expect(body(f.hook())).toContain('C');expect(body(f.hook('SessionStart','resume','s','','t','chatgpt-work','new-host'))).toContain('C');
 await consumeCodexInbox(f.config);
 f.inspect(s=>{expect(s.db.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n).toBe(5);expect(s.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE closing=1').get()!.n).toBe(1);});
});
it('failed reads and capacity rejection roll back replacement including pending delivery',()=>{
 const f=fixture();f.memory('A');f.hook();f.memory('B');refreshSession(f.home,'chatgpt-work','host','s');
 f.memory('x'.repeat(70000));expect(()=>refreshSession(f.home,'chatgpt-work','host','s')).toThrow('64 KiB');expect(body(f.hook('PostToolUse'))).toContain('B');
 const snapshot=f.inspect(s=>String(s.db.prepare('SELECT body FROM host_snapshots').get()!.body));
 f.config.sessionCache={maxSessionBytes:Buffer.byteLength(snapshot)+10};writeFileSync(join(f.home,'config.json'),JSON.stringify(f.config));
 f.memory('x'.repeat(1000));expect(()=>refreshSession(f.home,'chatgpt-work','host','s')).toThrow('SESSION_CAPACITY_EXCEEDED');
 expect(f.inspect(s=>s.db.prepare('SELECT body FROM host_snapshots').get()!.body)).toBe(snapshot);
});
it('actual item delivery settles the tenth turn, deduplicates legacy delivery and excludes environment records',async()=>{
 const f=fixture();f.hook();
 for(let i=0;i<10;i++){
  const turn='t'+i,text='Synthetic expression '+i;f.hook('UserPromptSubmit','startup','s',text,turn);
  f.append({type:'task_started',turn_id:turn});f.append({full:true,state:{}},'world_state');f.append({thread_id:'s',turn_id:turn},'token_usage_record');
  f.append({type:'item_completed',turn_id:turn,item:{type:'UserMessage',id:'u'+i,content:[{type:'text',text}]}});
  f.append({type:'user_message',message:text});f.append({type:'message',role:'user',content:[{type:'input_text',text:'Skill/environment instructions'}]},'response_item');f.append({type:'task_complete',turn_id:turn});
  f.hook('PostToolUse');await consumeCodexInbox(f.config);
  f.inspect(s=>expect(s.pending()).toHaveLength(i===9?10:0));
 }
 f.inspect(s=>expect(s.db.prepare('SELECT COUNT(*) AS n FROM observations').get()!.n).toBe(10));
});
it('unconfirmed item retains the inbox and cannot promote skill text',async()=>{
 const f=fixture();f.hook();f.hook('UserPromptSubmit');f.append({type:'task_started',turn_id:'t'});f.append({type:'item_completed',turn_id:'t',item:{type:'UserMessage',id:'skill',content:[{type:'text',text:'Skill injected instruction'}]}});f.hook('SessionEnd');
 await expect(consumeCodexInbox(f.config)).rejects.toThrow('CODEX_UNCONFIRMED_DELIVERY');f.inspect(s=>expect(s.db.prepare('SELECT body FROM codex_inbox ORDER BY id DESC LIMIT 1').get()!.body).toContain('Skill injected instruction'));
});
it.skipIf(process.platform==='win32')('generates explicit skill, isolated MCP identities, and fixed native bridge paths without trust bypass',()=>{
 const env={...process.env,COMMON_MEMORY_HOME:'/tmp/memory home'};
 const work=renderHostConfig('chatgpt-work',{wsl:false},env);expect(work.config).toContain('chatgpt-desktop');expect(work.config).toContain('chatgpt-work');expect(work.policy).toContain('allow_implicit_invocation: false');expect(work.skill).toContain("'session-refresh' '--home' '/tmp/memory home' '--client' 'chatgpt-work'");
 const codex=renderHostConfig('codex',{wsl:false},env);expect(codex.config).toContain('[mcp_servers.common_memory_init]\nenabled = false');expect(codex.config).toContain('codex-cli');
 if(process.platform==='linux'){
  const bridge=renderWindowsBridge({wsl:true,distro:'Synthetic Distro',user:'tester'},env);expect(bridge).toContain('CreationDate');expect(bridge).toContain('COMMON_MEMORY_HOST_INSTANCE');expect(bridge).toContain('/usr/bin/wslpath');expect(bridge).toContain('UTF8Encoding');expect(bridge).toContain('exit $LASTEXITCODE');expect(bridge).toContain('C:\\Windows\\System32\\wsl.exe');
  expect(()=>renderHostConfig('chatgpt-work',{wsl:true,distro:'x'},env)).toThrow('--bridge-path');
  const native=renderHostConfig('chatgpt-work',{wsl:true,distro:'x'},env,"C:\\Memory $data\\bridge.ps1");
  const encoded=JSON.parse(/^command = (.+)$/m.exec(native.config)![1]!).split(' -EncodedCommand ')[1]!;
  expect(Buffer.from(encoded,'base64').toString('utf16le')).toContain("& 'C:\\Memory $data\\bridge.ps1'");
 }
 expect(work.config).not.toContain('bypass');
});
