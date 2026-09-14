import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { tempRoots } from '../helpers/temp-roots.js';
import { externalPreflight, inputLimits, preflightSource, serializedSourceBytes } from '../../src/core/safety/external-preflight.js';
import { createConfiguredWriter } from '../../src/config/runtime.js';
import { defaultConfig, saveApiKeyToEnvFile } from '../../src/config/config.js';
import { validateMemoryEdit } from '../../src/v2/edit-ingress.js';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { Writer } from '../../src/v2/writer.js';
import { SessionIngress } from '../../src/v2/session.js';
import { queueAgentImport } from '../../src/v2/agent-ingress.js';
import { prepareDocumentImport } from '../../src/v2/document-import.js';
import { PiMemoryService } from '../../src/pi-extension/memory-service.js';
import { McpIngress } from '../../src/mcp/ingress.js';
import { readTask } from '../helpers/decision-runtime.js';

const roots=tempRoots('cm-input-limits-');const close:(()=>void)[]=[];
afterEach(()=>{for(const fn of close.splice(0).reverse())fn();roots.cleanup();});
it.each(['maxExcerptBytes','maxCandidateBytes','maxTotalBytes'] as const)('%s is checked on complete serialized projections regardless of key names',key=>{
  for(const field of ['text','understanding','arbitrary','excerpts','candidates']) {
    const value={[field]:['中'.repeat(20),'Condition remains attached.']};
    expect(()=>externalPreflight(value,{[key]:40})).toThrow('disclosure limits');
  }
  const text='中🙂\n';const exact=serializedSourceBytes(text);
  expect(()=>preflightSource(text,{[key]:exact})).not.toThrow();expect(()=>preflightSource(text,{[key]:exact-1})).toThrow();
});
it('deprecated explicit candidate limits remain effective, visible, and never widen excerpt or total caps',()=>{
  expect(inputLimits({maxCandidateBytes:40,maxExcerptBytes:80,maxTotalBytes:100})).toMatchObject({maxSourceBytes:40,maxInputBytes:100,deprecatedLimits:[expect.stringContaining('deprecated')]});
  expect(inputLimits({maxCandidateBytes:80,maxExcerptBytes:30,maxTotalBytes:20}).maxSourceBytes).toBe(20);
  expect(inputLimits({})).toEqual({maxSourceBytes:null,maxInputBytes:null,deprecatedLimits:[]});
});
it.each(['maxExcerptBytes','maxCandidateBytes','maxTotalBytes'] as const)('all explicit user/import adapters enforce %s before enqueue without truncating',key=>{
  const root=roots.root(),config=defaultConfig({COMMON_MEMORY_HOME:root});config.disclosure[key]=80;config.disclosure.allowedProvenance=['user_explicit','agent_observation','document_import'];
  const store=new RuntimeStore(config.dataRoot);close.push(()=>store.close());
  const relay=new McpIngress(store,config,{clientId:'fixture',workspaces:[],global:true,accept:true,capabilities:['relay','init']});
  const native=new PiMemoryService({config:()=>config,activeStore:()=>({dataRoot:config.dataRoot,store}),wake:()=>{}});
  const text='中'.repeat(80)+' Unless condition applies.';
  const imported={importId:'original',contextId:'global',sourceLabel:'synthetic',basis:'unknown' as const,understanding:'A short statement.',gaps:text};
  expect(()=>relay.submit({submissionId:'turn',contextId:'global',text})).toThrow();
  expect(()=>relay.init(imported)).toThrow();
  expect(()=>native.adjust({sessionId:'native',cwd:root},'global',text)).toThrow();
  expect(()=>native.import({sessionId:'native',cwd:root},imported)).toThrow();
  expect(()=>queueAgentImport(store,'public',imported,{contexts:['global'],enabled:true,limits:config.disclosure})).toThrow();
  const file=join(root,'synthetic.md');writeFileSync(file,text);
  expect(()=>prepareDocumentImport(file,{limits:config.disclosure})).toThrow();
  expect(store.pending()).toEqual([]);expect(native.info({sessionId:'native',cwd:root})).toMatchObject({maxSourceBytes:80});
});
it('Core rejects an oversized complete direct source before calling any Runtime, preserving exact input',async()=>{
  const decide=vi.fn();const writer=new Writer({dataRoot:roots.root(),allowedScopes:['global'],agent:{decide},maxSourceBytes:40});close.push(()=>writer.close());
  const text='中'.repeat(20)+' Unless otherwise confirmed.';
  writer.store.enqueue({sessionId:'s',entryId:'e',scope:'global',source:'interactive',text,observedAt:new Date().toISOString()});
  expect(await writer.run({force:true})).toEqual({outcome:'quarantined'});expect(decide).not.toHaveBeenCalled();
  expect(writer.store.db.prepare('SELECT text,state,issue FROM observations').get()).toEqual({text,state:'quarantined',issue:'OVERSIZED_COMPLETE_SOURCE'});
});
it('Core source cap checks the whole authorized assistant source rather than its paginated blocks',async()=>{
  const decide=vi.fn();const writer=new Writer({dataRoot:roots.root(),allowedScopes:['global'],allowedProvenance:['user_explicit','conversation_context'],agent:{decide},maxSourceBytes:80});close.push(()=>writer.close());
  const ingress=new SessionIngress(writer.store),session=ingress.open({client:'pi',processInstance:'test',sessionId:'conversation'});
  const message={id:'u',turnId:'t',role:'user' as const,source:'interactive',scope:'global',text:'Review this.',observedAt:new Date().toISOString()};
  ingress.capture(session,message);ingress.capture(session,{...message,id:'a',role:'assistant',source:'conversation_context',text:'paragraph\n\n'.repeat(20)});ingress.settle(session,'t');ingress.end(session);
  expect(await writer.run()).toEqual({outcome:'quarantined'});expect(decide).not.toHaveBeenCalled();
  expect(writer.store.db.prepare("SELECT text FROM session_messages WHERE role='assistant'").get()!.text).toBe('paragraph\n\n'.repeat(20));
});
it('Unlimited source input leaves independent session resource bounds intact',()=>{
  const store=new RuntimeStore(roots.root());close.push(()=>store.close());
  const ingress=new SessionIngress(store,{maxSessionBytes:64,maxTotalBytes:64}),session=ingress.open({client:'pi',processInstance:'resource',sessionId:'s'});
  const text='x'.repeat(65);expect(()=>preflightSource(text,{})).not.toThrow();
  expect(()=>ingress.capture(session,{id:'u',turnId:'t',role:'user',source:'interactive',scope:'global',text,observedAt:new Date().toISOString()})).toThrow('SESSION_CAPACITY_EXCEEDED');
  expect(store.pending()).toEqual([]);
});

it.each(['maxExcerptBytes','maxCandidateBytes','maxTotalBytes'] as const)('native and relay text share the exact %s source boundary',key=>{
  const root=roots.root(),config=defaultConfig({COMMON_MEMORY_HOME:root}),text='中🙂 Complete qualifier.';
  const store=new RuntimeStore(config.dataRoot);close.push(()=>store.close());
  const relay=new McpIngress(store,config,{clientId:'boundary',workspaces:[],global:true,accept:true,capabilities:['relay']});
  const native=new PiMemoryService({config:()=>config,activeStore:()=>({dataRoot:config.dataRoot,store}),wake:()=>{}});
  const edit={sessionId:'tui-test',requestId:'original',scope:'global',text};
  const access={allowedScopes:['global'],writableScopes:['global'],allowedProvenance:['user_explicit'],limits:config.disclosure};
  config.disclosure[key]=serializedSourceBytes(text)-1;
  expect(()=>validateMemoryEdit(edit,access)).toThrow();expect(()=>native.adjust({cwd:root,sessionId:'native'},'global',text)).toThrow();expect(()=>relay.submit({contextId:'global',submissionId:'original',text})).toThrow();
  config.disclosure[key]=serializedSourceBytes(text);
  expect(()=>validateMemoryEdit(edit,access)).not.toThrow();expect(native.adjust({cwd:root,sessionId:'native'},'global',text).accepted).toBe(true);expect(relay.submit({contextId:'global',submissionId:'original',text}).accepted).toBe(true);
});
it('oversized later context quarantines its own complete turn after the healthy immediate batch',async()=>{
  const writer=new Writer({dataRoot:roots.root(),allowedScopes:['global'],allowedProvenance:['user_explicit','conversation_context'],agent:{decide:async(task,reads)=>{readTask(task,reads);return {body:{version:'memory_maintenance_v2',request_id:task.request_id,decisions:[{kind:'ignore',applicability:'uncertain',confidence:1,evidence:[],reason:'synthetic'}]},usage:{},promptDigest:'9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'};}},maxSourceBytes:80});close.push(()=>writer.close());
  const ingress=new SessionIngress(writer.store),session=ingress.open({client:'pi',processInstance:'test',sessionId:'two-turns'});
  for(const turnId of ['healthy','oversized']) {
    const message={id:turnId,turnId,role:'user' as const,source:'interactive',scope:'global',text:'Review this.',observedAt:new Date().toISOString()};
    ingress.capture(session,message);ingress.capture(session,{...message,id:turnId+'-a',role:'assistant',source:'conversation_context',text:turnId==='healthy'?'Short context.':'long paragraph\n\n'.repeat(20)});ingress.settle(session,turnId);
  }
  ingress.end(session);expect(await writer.run()).toEqual({outcome:'ignored'});expect(await writer.run()).toEqual({outcome:'quarantined'});
  expect(writer.store.db.prepare('SELECT entryId,state FROM observations ORDER BY id').all()).toEqual([{entryId:'healthy',state:'processed'},{entryId:'oversized',state:'quarantined'}]);
});

it.each(['maxExcerptBytes','maxCandidateBytes'] as const)('configured Writer forwards legacy %s even with Unlimited total input',async key=>{
  const root=roots.root();vi.stubEnv('COMMON_MEMORY_HOME',root);
  const config=defaultConfig({COMMON_MEMORY_HOME:root});config.remote.model='synthetic';config.remote.baseUrl='https://provider.test/v1';config.disclosure[key]=40;
  saveApiKeyToEnvFile(config.remote.apiKeyEnv,'synthetic-key',join(root,'.env'));
  const fetch=vi.fn(()=>{throw new Error('No network permitted');});vi.stubGlobal('fetch',fetch);
  const writer=createConfiguredWriter(config);
  try {
    writer.store.enqueue({sessionId:'configured',entryId:'one',scope:'global',source:'interactive',text:'Complete original source '.repeat(10),observedAt:new Date().toISOString()});
    expect(await writer.run({force:true})).toEqual({outcome:'quarantined'});expect(fetch).not.toHaveBeenCalled();
    expect(writer.store.observationOutcome('configured','one')).toMatchObject({issue:'OVERSIZED_COMPLETE_SOURCE'});
  } finally {await writer.close();vi.unstubAllGlobals();vi.unstubAllEnvs();}
});
