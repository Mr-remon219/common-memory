#!/usr/bin/env node
// Synthetic native Windows host → generated WSL hook → configured Writer/Core.
// Run after build on WSL with Windows PowerShell interop. No real model or personal data.
import { execFileSync,spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync,mkdirSync,copyFileSync,chmodSync } from 'node:fs';
import { tmpdir,userInfo } from 'node:os';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import assert from 'node:assert/strict';
const args=process.argv.slice(2);
if(args.length && !(args.length===2 && args[0]==='--package-root'))throw new Error('Usage: smoke-work-bridge.mjs [--package-root <installed-package>]');
const packageRoot=resolve(args[1]??'.');
const {defaultConfig}=await import(pathToFileURL(join(packageRoot,'dist/config/config.js')));
const {RuntimeStore}=await import(pathToFileURL(join(packageRoot,'dist/v2/runtime.js')));
const {installIntegrations,removeIntegrations}=await import(pathToFileURL(join(packageRoot,'dist/cli/integrations.js')));
const {SessionIngress}=await import(pathToFileURL(join(packageRoot,'dist/v2/session.js')));
const powershell='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
if(!process.env.WSL_DISTRO_NAME||!existsSync(powershell))throw new Error('Requires WSL and Windows PowerShell interop');
const win=p=>execFileSync('/usr/bin/wslpath',['-w',p],{encoding:'utf8'}).trim();
const quote=s=>"'"+s.replaceAll("'","''")+"'";
const home=mkdtempSync(join(tmpdir(),"cm work '中文 $data-"));
const windowsTemp=execFileSync(powershell,['-NoProfile','-Command','[Console]::Write($env:TEMP)'],{encoding:'utf8'}).trim();
const nativeRoot=mkdtempSync(join(execFileSync('/usr/bin/wslpath',['-u',windowsTemp],{encoding:'utf8'}).trim(),"cm work '中文 $data-"));
let release=false,calls=0;
const server=createServer(async(req,res)=>{
 let input='';for await(const chunk of req)input+=chunk;
 const p=JSON.parse(JSON.parse(input).input[1].content[0].text);calls++;
 while(!release&&!res.destroyed)await pause(20);
 if(res.destroyed)return;
 const decision={version:'memory_maintenance_v2',request_id:p.request_id,decisions:[{kind:'retain',applicability:'global',admission:'remember',lifetime:'until_changed',confidence:1,evidence:p.observations.map(o=>o.ref),reason:'synthetic bridge test',operations:[{op:'put_section',target:'preferences',section:null,title:'Synthetic bridge',body:'Prefer concise replies. 桥接验证'}]}]};
 res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'completed',error:null,incomplete_details:null,output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:JSON.stringify(decision),annotations:[]}]}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}));
});
server.listen(0,'127.0.0.1');await once(server,'listening');
try {
 const config=defaultConfig({COMMON_MEMORY_HOME:home});config.remote={provider:'openai-compatible',model:'synthetic',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKeyEnv:'CM_SYNTHETIC_KEY',proxy:{mode:'direct'}};
 writeFileSync(join(home,'config.json'),JSON.stringify(config));writeFileSync(join(home,'.env'),'CM_SYNTHETIC_KEY=synthetic\n',{mode:0o600});
 const transcript=join(home,'转录.jsonl');writeFileSync(transcript,JSON.stringify({type:'session_meta',payload:{cli_version:'0.154.0'}})+'\n');
 mkdirSync(join(config.dataRoot,'memory'),{recursive:true});const profile=join(config.dataRoot,'memory/profile.md');writeFileSync(profile,'# Profile\n\n## Synthetic\nSNAPSHOT_A');
 const output=join(nativeRoot,'bundle'),bridge=join(output,'common-memory-bridge.ps1');
 const targets=['codex','chatgpt'].map(id=>({id,name:id,root:output,mode:'windows-wsl',hooks:true}));
 installIntegrations(targets,config.dataRoot,{home});
 const hooksBefore=readFileSync(join(output,'hooks.json'),'utf8'),skillBefore=readFileSync(join(output,'skills/memory-refresh/SKILL.md'),'utf8'),bridgeBefore=readFileSync(bridge);
 const hooks=JSON.parse(hooksBefore).hooks;
 for(const entries of Object.values(hooks))assert.equal(entries.length,1,'Shared config must invoke one capture command');
 const hookCommand=hooks.SessionStart[0].hooks[0].command;
 const encodedHook=hookCommand.split(' -EncodedCommand ')[1];assert.ok(encodedHook);
 const nativeExe=join(nativeRoot,'codex-synthetic.exe');
 const csharp=String.raw`using System; using System.Diagnostics; public class Host { public static int Main(string[] args) { var p = Process.Start(new ProcessStartInfo("powershell.exe", "-NoProfile -File \"" + args[0] + "\"") { UseShellExecute = false }); p.WaitForExit(); return p.ExitCode; } }`;
 const compile=join(nativeRoot,'compile.ps1');writeFileSync(compile,'\ufeff'+`Add-Type -TypeDefinition ${quote(csharp)} -OutputAssembly ${quote(win(nativeExe))} -OutputType ConsoleApplication\n`);
 execFileSync(powershell,['-NoProfile','-File',win(compile)],{encoding:'utf8'});
 const event={hook_event_name:'SessionStart',source:'startup',session_id:'synthetic-thread',turn_id:'t',cwd:win(home),transcript_path:win(transcript)};
 const records=[{type:'task_started',turn_id:'t'},{type:'item_completed',turn_id:'t',item:{type:'UserMessage',id:'user-1',content:[{type:'text',text:'Please prefer concise replies. 用户表达'}]}},{type:'task_complete',turn_id:'t'}].map(payload=>JSON.stringify({type:'event_msg',timestamp:new Date().toISOString(),payload})).join('\n')+'\n';
 const runner=join(nativeRoot,'runner.ps1');writeFileSync(runner,'\ufeff'+`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$bridge=${quote(win(bridge))}
$event=${quote(JSON.stringify(event))} | ConvertFrom-Json
function Hook { $event | ConvertTo-Json -Compress | & powershell.exe -NoProfile -EncodedCommand ${quote(encodedHook)}; if($LASTEXITCODE -ne 0){throw "Hook failed: $LASTEXITCODE"} }
Hook
$event.hook_event_name='UserPromptSubmit'; $event | Add-Member prompt 'Please prefer concise replies. 用户表达'; Hook
[IO.File]::AppendAllText(${quote(win(transcript))},${quote(records)},[Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText(${quote(win(profile))},"# Profile\n\n## Synthetic\nSNAPSHOT_B",[Text.UTF8Encoding]::new($false))
$env:CODEX_THREAD_ID='synthetic-thread'
& powershell.exe -NoProfile -File $bridge -Action session-refresh -Client codex
if($LASTEXITCODE -ne 0){throw 'Refresh failed'}
[IO.File]::WriteAllText(${quote(win(profile))},"# Profile\n\n## Synthetic\nSNAPSHOT_C",[Text.UTF8Encoding]::new($false))
$event.hook_event_name='PostToolUse'; Hook
$env:CODEX_THREAD_ID='missing-thread'
& powershell.exe -NoProfile -File $bridge -Action session-refresh -Client codex
if($LASTEXITCODE -ne 1){throw 'Failure exit code was not preserved'}
$event.hook_event_name='SessionEnd'; Hook
exit 0
`);
 const child=spawn(nativeExe,[win(runner)],{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const deadlineTimer=setTimeout(()=>child.kill('SIGKILL'),45000);
 let code;try{[code]=await once(child,'close');}finally{clearTimeout(deadlineTimer);} assert.equal(code,0,stderr);assert.match(stdout,/SNAPSHOT_A/);assert.match(stdout,/SNAPSHOT_B/);assert.doesNotMatch(stdout,/SNAPSHOT_C/);assert.match(stderr,/SESSION_REFRESH_ACTIVATION_REQUIRED/);
 assert.equal(existsSync(join(config.dataRoot,'memory/preferences.md')),false);
 removeIntegrations(['codex'],home);
 assert.equal(readFileSync(join(output,'hooks.json'),'utf8'),hooksBefore);assert.equal(readFileSync(join(output,'skills/memory-refresh/SKILL.md'),'utf8'),skillBefore);assert.deepEqual(readFileSync(bridge),bridgeBefore);

 release=true;const deadline=Date.now()+25000;
 while(Date.now()<deadline){
  if(existsSync(join(config.dataRoot,'memory/preferences.md'))){const store=new RuntimeStore(config.dataRoot);try{const row=store.db.prepare('SELECT sessionId FROM host_activations').get();if(row&&new SessionIngress(store).status(row.sessionId).complete)break;}finally{store.close();}}
  await pause(50);
 }
 assert.ok(calls>0);assert.match(readFileSync(join(config.dataRoot,'memory/preferences.md'),'utf8'),/桥接验证/);
 // Independently exercise direct POSIX hooks under a real Linux ancestor, without the bridge identity.
 const posixExe=join(home,'codex-synthetic'),posixScript=join(home,'posix.mjs');
 copyFileSync(process.execPath,posixExe);chmodSync(posixExe,0o700);
 const posixEvent={...event,cwd:home,transcript_path:transcript,session_id:'posix-thread'};
 writeFileSync(posixScript,`import {execFileSync} from 'node:child_process';
 const event=${JSON.stringify(posixEvent)};
 for(const name of ['SessionStart','SessionEnd']) {
   event.hook_event_name=name;
   process.stdout.write(execFileSync(${JSON.stringify(process.execPath)},[${JSON.stringify(join(packageRoot,'dist/cli/main.js'))},'work-hook','--home',${JSON.stringify(home)}],{input:JSON.stringify(event),encoding:'utf8'}));
 }`);
 const direct=execFileSync(posixExe,[posixScript],{env:{...process.env,COMMON_MEMORY_HOME:home,COMMON_MEMORY_HOST_INSTANCE:''},encoding:'utf8'});
 assert.match(direct,/SNAPSHOT_C/);
 const directDeadline=Date.now()+10000;
 while(Date.now()<directDeadline){const state=new RuntimeStore(config.dataRoot);let done;try{const row=state.db.prepare("SELECT sessionId FROM host_activations WHERE thread='posix-thread'").get();done=row&&new SessionIngress(state).status(row.sessionId).complete;}finally{state.close();}if(done)break;await pause(50);}
 const identities=new RuntimeStore(config.dataRoot);try {
   const rows=identities.db.prepare('SELECT instance,sessionId,client FROM host_activations').all();
   assert.equal(identities.db.prepare('SELECT count(*) AS n FROM observations').get().n,1,'One delivered native turn must produce one observation');
   assert.equal(rows.find(r=>r.instance.startsWith('windows:')).client,'codex','Automatic capture records host protocol, not an inferred frontend');
   for(const row of rows)assert.equal(new SessionIngress(identities).status(row.sessionId).complete,true,'Host session drain must complete');
   assert.ok(rows.some(r=>r.instance.startsWith('windows:')));assert.ok(rows.some(r=>!r.instance.startsWith('windows:')));
 }finally{identities.close();}
 removeIntegrations(['chatgpt'],home);assert.equal(existsSync(bridge),false);assert.equal(existsSync(join(output,'hooks.json')),false);
 console.log('PASS: automatic shared Work/Codex installation and owner removal, native host identity, Unicode STDIO, path conversion, explicit refresh, exit code, canonical Writer/Core drain after native host exit, and independent direct WSL host identity.');
} finally {release=true;server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(home,{recursive:true,force:true});rmSync(nativeRoot,{recursive:true,force:true});}
