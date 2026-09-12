import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultConfig, validateConfig, saveConfig, loadConfig, loadLocalEnv, saveNetworkSecret } from '../../src/config/config.js';
import { readPrivateEnv } from '../../src/config/private-env.js';
import { createConfiguredMemoryModel, createConfiguredWriter, describeConfiguredNetwork } from '../../src/config/runtime.js';
import { PRIVATE_PROXY_KEY, PRIVATE_CA_KEY, networkSecret } from '../../src/memory-manager/network/route.js';
const roots: string[]=[];
const root=()=>{const value=mkdtempSync(join(tmpdir(),'cm-network-config-'));roots.push(value);return value;};
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();for(const path of roots.splice(0))rmSync(path,{recursive:true,force:true});});
it('new installs use env while old schemaVersion 2 retains absence until explicit migration', () => {
  const home=root(),config=defaultConfig({COMMON_MEMORY_HOME:home});config.remote.model='fake';expect(config.remote.proxy).toEqual({mode:'env'});
  delete config.remote.proxy;const path=join(home,'config.json');saveConfig(config,path);
  const old=loadConfig(path)!;expect(old.remote).not.toHaveProperty('proxy');expect(describeConfiguredNetwork(old,{}).route).toBe('host');
  old.remote.model='updated';saveConfig(old,path);expect(loadConfig(path)!.remote).not.toHaveProperty('proxy');
  old.remote.proxy={mode:'direct'};saveConfig(old,path);expect(loadConfig(path)!.remote.proxy).toEqual({mode:'direct'});
  for(const remote of [{...old.remote,caFileEnv:'BAD-NAME'},{...old.remote,proxy:{mode:'env',urlEnv:'BAD'}},{...old.remote,proxy:{mode:'custom',urlEnv:'P',arbitrary:true}}]) expect(()=>validateConfig({...old,remote})).toThrow();
  delete old.remote.proxy;old.remote.caFileEnv=PRIVATE_CA_KEY;expect(()=>validateConfig(old)).toThrow('explicit network mode');
});
it('new private network values never enter process.env, including through a stale legacy loader', async () => {
  const home=root(),path=join(home,'.env');
  vi.stubEnv(PRIVATE_PROXY_KEY,undefined);vi.stubEnv(PRIVATE_CA_KEY,undefined);vi.stubEnv('common_memory_proxy_url',undefined);vi.stubEnv('common_memory_ca_file',undefined);vi.stubEnv('CM_LOCAL_KEY',undefined);vi.stubEnv('COMMON_MEMORY_HOME',home);
  saveNetworkSecret(PRIVATE_PROXY_KEY,'http://name:private-password@127.0.0.1:8888',path);
  saveNetworkSecret(PRIVATE_CA_KEY,'C:\\Users\\Example\\company.pem',path);
  writeFileSync(path,readFileSync(path,'utf8')+'CM_LOCAL_KEY="synthetic-local-key"\ncommon_memory_proxy_url=http://private-lower\ncommon_memory_ca_file=private-ca\n');
  const config=defaultConfig({COMMON_MEMORY_HOME:home});config.remote.model='fake';config.remote.apiKeyEnv='CM_LOCAL_KEY';config.remote.proxy={mode:'custom',urlEnv:PRIVATE_PROXY_KEY};
  const model=createConfiguredMemoryModel(config);await model.close();
  expect(process.env.CM_LOCAL_KEY).toBeUndefined();expect(process.env[PRIVATE_PROXY_KEY]).toBeUndefined();expect(process.env[PRIVATE_CA_KEY]).toBeUndefined();
  expect(readPrivateEnv(path)[PRIVATE_CA_KEY]).toBe('C:\\Users\\Example\\company.pem');
  loadLocalEnv(path);expect(process.env.CM_LOCAL_KEY).toBe('synthetic-local-key');expect(process.env[PRIVATE_PROXY_KEY]).toBeUndefined();expect(process.env[PRIVATE_CA_KEY]).toBeUndefined();
  expect(process.env.common_memory_proxy_url).toBeUndefined();expect(process.env.common_memory_ca_file).toBeUndefined();
  expect(networkSecret('OTHER_PROXY',{}, {OTHER_PROXY:'private'})).toBeUndefined();
  expect(networkSecret(PRIVATE_PROXY_KEY,{[PRIVATE_PROXY_KEY]:''},{[PRIVATE_PROXY_KEY]:'private'})).toBe('');
});
it('process API key overrides private key locally; an explicit empty key remains missing', async () => {
  const home=root();writeFileSync(join(home,'.env'),'CM_LOCAL_KEY=private-key');
  const config=defaultConfig({COMMON_MEMORY_HOME:home});config.remote.model='fake';config.remote.apiKeyEnv='CM_LOCAL_KEY';
  let authorization: unknown;
  const model=createConfiguredMemoryModel(config,{COMMON_MEMORY_HOME:home,CM_LOCAL_KEY:'process-key'},{fetch:async(_url,init)=>{authorization=(init?.headers as Record<string,string>).authorization;return new Response('{}',{status:401});}});
  try { await model.analyze({projection:{},schema:{},prompt:'test'},{requestId:'r',deadlineMs:1000}); } catch { /* expected API authentication failure */ } finally { await model.close(); }
  expect(authorization).toBe('Bearer process-key');
  expect(()=>createConfiguredMemoryModel(config,{COMMON_MEMORY_HOME:home,CM_LOCAL_KEY:''})).toThrow('is not set');
});
it('explicit setup credentials cannot be replaced by an inherited provider key', async () => {
  const home=root();writeFileSync(join(home,'.env'),'CM_LOCAL_KEY=entered-private-key');
  const config=defaultConfig({COMMON_MEMORY_HOME:home});config.remote.model='fake';config.remote.apiKeyEnv='CM_LOCAL_KEY';config.remote.apiKeySource='private-env';
  const validated=validateConfig(config);expect(validated.remote.apiKeySource).toBe('private-env');
  let authorization: unknown;
  const model=createConfiguredMemoryModel(validated,{COMMON_MEMORY_HOME:home,CM_LOCAL_KEY:'unrelated-inherited-key'},{fetch:async(_url,init)=>{authorization=(init?.headers as Record<string,string>).authorization;return new Response('{}',{status:401});}});
  try { await model.analyze({projection:{},schema:{},prompt:'test'},{requestId:'r',deadlineMs:1000}); } catch { /* fake authentication response */ } finally { await model.close(); }
  expect(authorization).toBe('Bearer entered-private-key');
  expect(()=>validateConfig({...config,remote:{...config.remote,apiKeySource:'unknown'}})).toThrow('API key source');
  expect(()=>validateConfig({...config,remote:{...config.remote,preset:'unknown'}})).toThrow('provider preset');
});
it('status is local, redacted and does not create absent homes or data roots', () => {
  const home=join(root(),'missing'),config=defaultConfig({COMMON_MEMORY_HOME:home});config.remote.model='fake';
  expect(describeConfiguredNetwork(config,{COMMON_MEMORY_HOME:home,ALL_PROXY:'http://name:password@proxy.invalid'})).toEqual({mode:'env',route:'proxy',reason:'all_proxy',protocol:'http'});
  expect(existsSync(home)).toBe(false);
});
it('legacy factory preserves host env-dispatcher routing after old private NO_PROXY loading', async () => {
  const origin=createServer((_q,r)=>r.end('direct')),proxy=createServer((_q,r)=>r.end('proxy'));
  await new Promise<void>(resolve=>origin.listen(0,'127.0.0.1',resolve));await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const home=root();writeFileSync(join(home,'.env'),'NO_PROXY=127.0.0.1\nCM_LEGACY_KEY=synthetic\nCOMMON_MEMORY_PROXY_URL=http://secret:password@p\n');
  const endpoint=`http://127.0.0.1:${(origin.address() as {port:number}).port}`;
  const source=new URL('../../src/config/runtime.ts',import.meta.url).href;
  // --import expects a module URL; a Windows drive path is parsed as an unsupported scheme.
  const loader=new URL('../mcp/fixtures/source-loader.mjs',import.meta.url).href;
  // Older supported Node 22 releases lack --use-env-proxy. Exercise an equivalent
  // host-owned dispatcher there; Common Memory must not install a global dispatcher.
  const nativeProxy = process.allowedNodeEnvironmentFlags.has('--use-env-proxy');
  const hostSetup = nativeProxy ? '' : "import {EnvHttpProxyAgent,setGlobalDispatcher} from 'undici'; const hostProxy=new EnvHttpProxyAgent(); setGlobalDispatcher(hostProxy);";
  const code=`${hostSetup} import {createConfiguredMemoryModel} from ${JSON.stringify(source)}; import {defaultConfig} from ${JSON.stringify(new URL('../../src/config/config.ts',import.meta.url).href)}; const config=defaultConfig(); config.remote.model='fake';config.remote.apiKeyEnv='CM_LEGACY_KEY';delete config.remote.proxy;config.remote.baseUrl=${JSON.stringify(endpoint)}; const model=createConfiguredMemoryModel(config); console.log(JSON.stringify({body:await (await fetch(config.remote.baseUrl)).text(),reserved:process.env.COMMON_MEMORY_PROXY_URL===undefined})); await model.close(); ${nativeProxy ? '' : 'await hostProxy.close();'}`;
  try {
    const result=await new Promise<string>((resolve,reject)=>{
      const child=spawn(process.execPath,[...(nativeProxy ? ['--use-env-proxy'] : []),'--import',loader,'--input-type=module','-e',code],{env:{COMMON_MEMORY_HOME:home,HTTP_PROXY:`http://127.0.0.1:${(proxy.address() as {port:number}).port}`},stdio:['ignore','pipe','pipe']});
      let output='',stderr='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>stderr+=b);child.on('error',reject);child.on('close',(status,signal)=>status===0?resolve(output):reject(new Error(`legacy child exit ${status}, signal ${signal ?? 'none'}\n${stderr}`)));
    });
    expect(JSON.parse(result)).toEqual({body:'direct',reserved:true});
  } finally { origin.closeAllConnections();proxy.closeAllConnections();await Promise.all([new Promise<void>(resolve=>origin.close(()=>resolve())),new Promise<void>(resolve=>proxy.close(()=>resolve()))]); }
});
it('configured Writer close aborts active work before closing SQLite and blocks later runs', async () => {
  const home=root();vi.stubEnv('COMMON_MEMORY_HOME',home);vi.stubEnv('CM_CLOSE_KEY','synthetic');
  const config=defaultConfig({COMMON_MEMORY_HOME:home});config.remote.model='fake';config.remote.apiKeyEnv='CM_CLOSE_KEY';delete config.remote.proxy;
  const started=Promise.withResolvers<void>();
  vi.stubGlobal('fetch',async(_url:unknown,init:RequestInit)=>{started.resolve();return new Promise((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));});
  const writer=createConfiguredWriter(config);writer.store.enqueue({sessionId:'s',entryId:'e',source:'interactive',scope:'global',text:'Synthetic preference',observedAt:new Date().toISOString()});
  const run=writer.run({force:true});await started.promise;
  const closing=writer.close();expect(writer.close()).toBe(closing);
  expect(await run).toMatchObject({outcome:'cancelled',reason:'CANCELLED'});await closing;
  expect(()=>writer.store.status()).toThrow();await expect(writer.run()).rejects.toThrow('CANCELLED');
});
