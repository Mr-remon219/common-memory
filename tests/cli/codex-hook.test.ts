import { ProjectRegistry } from '../../src/v2/registry.js';
import { spawnSync } from 'node:child_process';
import { appendFileSync,mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach,expect,it } from 'vitest';
import { defaultConfig } from '../../src/config/config.js';
import { codexHook,MAX_HOOK_INPUT_BYTES } from '../../src/cli/codex-hook.js';
import { consumeCodexInbox } from '../../src/cli/codex-session.js';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { SessionIngress,sessionKey } from '../../src/v2/session.js';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(p=>rmSync(p,{recursive:true,force:true})));
function fixture(){
 const home=mkdtempSync(join(tmpdir(),"cm-hook ' $ ` "));roots.push(home);const config=defaultConfig({COMMON_MEMORY_HOME:home});config.remote.model='fake';writeFileSync(join(home,'config.json'),JSON.stringify(config));
 const path=join(home,'transcript.jsonl');writeFileSync(path,JSON.stringify({type:'session_meta',payload:{cli_version:'0.153.4',id:'s'}})+'\n');
 const input=(event='SessionStart',source='startup',session='s',prompt='PRIVATE_CANDIDATE')=>JSON.stringify({hook_event_name:event,cwd:home,prompt,source,transcript_path:path,session_id:session,turn_id:'t'});
 const read=(event='SessionStart',source='startup',session='s',instance='test-process',prompt='PRIVATE_CANDIDATE')=>codexHook(input(event,source,session,prompt),home,instance);
 const append=(payload:object,type='event_msg')=>appendFileSync(path,JSON.stringify({timestamp:'2026-09-09T00:00:00.000Z',type,payload})+'\n');
 return {home,config,path,input,read,append};
}
const context=(r:ReturnType<typeof codexHook>)=>r.hookSpecificOutput?.additionalContext;
it('reads once for each process/session startup, never on compact, reload or subsequent prompt',async()=>{
 const f=fixture();expect(context(f.read())).toContain('no stored content');expect(f.read('UserPromptSubmit')).toEqual({});
 mkdirSync(join(f.config.dataRoot,'memory'),{recursive:true});writeFileSync(join(f.config.dataRoot,'memory/profile.md'),'# Profile\n\n## Note\nNew background\n');
 expect(f.read('SessionStart','compact')).toEqual({});expect(f.read()).toEqual({});expect(f.read('SessionStart','resume')).toEqual({});
 expect(context(f.read('SessionStart','resume','s','second-process'))).toContain('New background');
 expect(f.read('SessionStart','compact','new-identity')).toEqual({});expect(f.read('SessionStart','startup','new-identity')).toEqual({});
 await consumeCodexInbox(f.config);
});
it('Stop reconciles a completion appended later without a new prompt, deduplicates delivery and ignores hook/environment/compact text',async()=>{
 const f=fixture();f.read();f.read('UserPromptSubmit','startup','s','test-process','Actual user expression');f.append({type:'task_started',turn_id:'t'});f.append({type:'message',role:'user',content:[{type:'input_text',text:'ENVIRONMENT / HookPrompt'}]},'response_item');
 f.append({type:'user_message',message:'Actual user expression',images:[],local_images:[]});f.append({type:'message',role:'assistant',content:[{type:'output_text',text:'Suggestion'}]},'response_item');
 expect(f.read('Stop')).toEqual({});expect(f.read('Stop')).toEqual({});const consuming=consumeCodexInbox(f.config);
 const timer=setTimeout(()=>f.append({type:'task_complete',turn_id:'t'}),50);await consuming;clearTimeout(timer);
 const store=new RuntimeStore(f.config.dataRoot);try {expect(store.db.prepare('SELECT text,state FROM observations').all()).toEqual([{text:'Actual user expression',state:'buffered'}]);expect(store.db.prepare('SELECT state FROM session_turns').get()!.state).toBe('settled');}finally{store.close();}
});
it('SessionEnd persists the tail body before the transcript disappears and closes with incomplete state',async()=>{
 const f=fixture();f.read();f.read('UserPromptSubmit','startup','s','test-process','Delivered tail');f.append({type:'task_started',turn_id:'t'});f.append({type:'user_message',message:'Delivered tail'});f.read('SessionEnd');rmSync(f.path);await consumeCodexInbox(f.config);
 const store=new RuntimeStore(f.config.dataRoot);try {const key=sessionKey({client:'codex',processInstance:'test-process',sessionId:'s'});expect(store.pending()[0]!.text).toBe('Delivered tail');expect(new SessionIngress(store).status(key)).toMatchObject({closing:true,complete:false,batches:1});}finally{store.close();}
});
it('unknown transcript preserves inbox body and recovery position; unsupported version and partial end fail explicitly',async()=>{
 const f=fixture();f.read();f.append({type:'x'},'unknown');f.read('SessionEnd');await expect(consumeCodexInbox(f.config)).rejects.toThrow('CODEX_UNKNOWN_TRANSCRIPT');
 const store=new RuntimeStore(f.config.dataRoot);try{expect(store.db.prepare('SELECT body FROM codex_inbox ORDER BY id DESC LIMIT 1').get()!.body).toContain('unknown');}finally{store.close();}
 const g=fixture();writeFileSync(g.path,JSON.stringify({type:'session_meta',payload:{cli_version:'unknown'}})+'\n');expect(()=>g.read()).toThrow('CODEX_UNSUPPORTED_VERSION');
 const h=fixture();h.read();appendFileSync(h.path,'{"unfinished":');expect(()=>h.read('SessionEnd')).toThrow('CODEX_PARTIAL_TRANSCRIPT');
});
it('bounds hook input and context, does not disclose candidate prompt, and rejects malformed fields',()=>{
 const f=fixture();for(const input of ['', 'null','[]','{}',' '.repeat(MAX_HOOK_INPUT_BYTES+1)])expect(()=>codexHook(input,f.home,'test')).toThrow('INVALID_CODEX_HOOK_INPUT');
 mkdirSync(join(f.config.dataRoot,'memory'),{recursive:true});writeFileSync(join(f.config.dataRoot,'memory/profile.md'),'# Profile\n\n## Large\n'+'汉'.repeat(23000));const r=f.read();expect(r.systemMessage).toContain('64 KiB');expect(JSON.stringify(r)).not.toContain('PRIVATE_CANDIDATE');expect(context(r)).not.toContain('汉');
});
it.skipIf(process.platform==='win32')('generated hooks cover lifecycle with three-second synchronous commands and safe POSIX quoting',()=>{
 const f=fixture(),loader=pathToFileURL(resolve('tests/mcp/fixtures/source-loader.mjs')).href;
 const result=spawnSync(process.execPath,['--import',loader,resolve('src/cli/main.ts'),'codex-config'],{env:{...process.env,COMMON_MEMORY_HOME:f.home},encoding:'utf8'});
 expect(result.status,result.stderr).toBe(0);for(const event of ['SessionStart','UserPromptSubmit','Stop','Interrupt','SessionEnd'])expect(result.stdout).toContain(`[[hooks.${event}]]`);
 expect(result.stdout).toContain('timeout = 3');expect(result.stdout).not.toContain('matcher = "^compact$"');expect(result.stdout).not.toContain('bypass_hook_trust');
 const commands=[...result.stdout.matchAll(/^command = (.+)$/gm)].map(m=>JSON.parse(m[1]!));expect(commands).toHaveLength(5);expect(commands[0]).toContain("'\"'\"'");
});
it('requires an independently captured input candidate and never advances over unconfirmed delivery',async()=>{
 const f=fixture();f.read();f.append({type:'task_started',turn_id:'t'});f.append({type:'user_message',message:'No candidate'});f.read('SessionEnd');await expect(consumeCodexInbox(f.config)).rejects.toThrow('CODEX_UNCONFIRMED_DELIVERY');
 const store=new RuntimeStore(f.config.dataRoot);try{expect(store.pending()).toHaveLength(0);expect(store.db.prepare('SELECT body FROM codex_inbox ORDER BY id DESC LIMIT 1').get()!.body).toContain('No candidate');}finally{store.close();}
});

it('freezes source scope at input, not the cwd of a later Stop or SessionEnd',async()=>{
 const f=fixture(),projectRoot=join(f.home,'project');mkdirSync(projectRoot);const project=new ProjectRegistry(f.config.dataRoot).register(projectRoot,'Synthetic project');f.read();
 codexHook(JSON.stringify({...JSON.parse(f.input('UserPromptSubmit')),cwd:projectRoot,prompt:'Project expression'}),f.home,'test-process');
 f.append({type:'task_started',turn_id:'t'});f.append({type:'user_message',message:'Project expression'});f.append({type:'task_complete',turn_id:'t'});f.read('SessionEnd');await consumeCodexInbox(f.config);
 const store=new RuntimeStore(f.config.dataRoot);try{expect(store.pending()[0]!.scope).toBe(`project:${project.id}`);}finally{store.close();}
});
