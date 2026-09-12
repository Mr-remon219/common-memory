import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it,vi} from 'vitest';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
import {defaultConfig} from '../../src/config/config.js';
import {createCommonMemoryPiExtension} from '../../src/pi-extension/index.js';
import {RuntimeStore} from '../../src/v2/runtime.js';
vi.mock('../../src/cli/session-drain.js',()=>({launchSessionDrain:vi.fn()}));

it('Pi 0.84.4 SDK delivers, persists and settles ten authenticated turns despite unavailable maintenance transport',async()=>{
 const home=mkdtempSync(join(tmpdir(),'pi-sdk-capture-'));
 vi.stubEnv('COMMON_MEMORY_HOME',home);vi.stubEnv('OPENAI_API_KEY','synthetic');vi.stubEnv('HTTPS_PROXY','http://proxy.invalid');vi.stubEnv('https_proxy',undefined);vi.stubEnv('NO_PROXY','synthetic.invalid/8');vi.stubEnv('no_proxy',undefined);
 const config=defaultConfig({COMMON_MEMORY_HOME:home});config.remote.model='synthetic';config.remote.proxy={mode:'env'};
 const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false}});
 const runtime=await ModelRuntime.create({authPath:join(home,'auth.json'),modelsPath:null,modelsStorePath:join(home,'models-store.json'),allowModelNetwork:false,refreshOnCreate:false});
 // Resolve Pi's own dependency, not an undeclared top-level pi-ai installation.
 const require=createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
 const aiPath=require.resolve.paths('@earendil-works/pi-ai')!.map(path=>join(path,'@earendil-works/pi-ai/dist/index.js')).find(existsSync)!;
 const {AssistantMessageEventStream}=await import(pathToFileURL(aiPath).href);
 let calls=0;
 runtime.registerProvider('synthetic-local',{baseUrl:'http://127.0.0.1:1',apiKey:'synthetic',api:'openai-completions',models:[{id:'synthetic',name:'Synthetic',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:1024}],streamSimple:()=>{
  calls++;const stream=new AssistantMessageEventStream();const message={role:'assistant',content:[{type:'text',text:'Synthetic response'}],api:'openai-completions',provider:'synthetic-local',model:'synthetic',usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};
  stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});return stream;
 }});
 const loader=new DefaultResourceLoader({cwd:home,agentDir:home,settingsManager,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[createCommonMemoryPiExtension({configFactory:()=>config})]});
 await loader.reload();expect(loader.getExtensions().errors).toEqual([]);
 const {session}=await createAgentSession({cwd:home,agentDir:home,modelRuntime:runtime,model:runtime.getModel('synthetic-local','synthetic')!,resourceLoader:loader,settingsManager,sessionManager:SessionManager.inMemory(home),noTools:'all'});
 try {
  await session.bindExtensions({mode:'print'});
  for(let n=1;n<=10;n++)await session.prompt(`Synthetic ordinary preference ${n}`);
  expect(calls).toBe(10);
  const store=new RuntimeStore(config.dataRoot);
  try {
   expect(store.db.prepare('SELECT count(*) AS n FROM observations').get()!.n).toBe(10);
   expect(store.db.prepare('SELECT count(*) AS n FROM session_batches').get()!.n).toBe(1);
   expect(store.db.prepare("SELECT count(*) AS n FROM session_turns WHERE state='settled'").get()!.n).toBe(10);
  } finally {store.close();}
  await session.prompt('Synthetic quit tail');
 } finally {
  await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();
  const store=new RuntimeStore(config.dataRoot);try{expect(store.db.prepare('SELECT count(*) AS n FROM session_batches').get()!.n).toBe(2);}finally{store.close();}
  vi.unstubAllEnvs();rmSync(home,{recursive:true,force:true});
 }
});
