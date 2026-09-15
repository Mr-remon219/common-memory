import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { defaultConfig } from '../../src/config/config.js';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { ProjectRegistry } from '../../src/v2/registry.js';
import { McpIngress, type McpCapability } from '../../src/mcp/ingress.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { tempRoots } from '../helpers/temp-roots.js';

const roots = tempRoots('cm-discovery-');
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); roots.cleanup(); });
async function setup(capabilities: McpCapability[] = ['relay','init','read'], modern = false) {
  const root = roots.root(), config = {...defaultConfig(),dataRoot:root};
  config.disclosure.allowedProvenance = ['user_explicit','agent_observation'];
  const registry = new ProjectRegistry(root), workspace = join(root,'workspace'); mkdirSync(workspace);
  const project = registry.register(workspace,'Synthetic project'), contextId = `project:${project.id}`;
  config.disclosure.allowedScopes = ['global',contextId];
  const store = capabilities.every(c => c === 'read') ? null : new RuntimeStore(root);
  if (store) cleanup.push(() => store.close());
  const ingress = new McpIngress(store,config,{clientId:'discovery',workspaces:[workspace],global:true,accept:true,capabilities});
  const client = new Client({name:'synthetic-client',version:'1'},modern ? {versionNegotiation:{mode:{pin:'2026-07-28'}}} : {});
  const [a,b] = InMemoryTransport.createLinkedPair();
  // The production entry owns era negotiation; bare McpServer.connect is legacy only.
  const handle = serveStdio(() => createMcpServer(ingress),{transport:b});
  cleanup.push(() => handle.close()); cleanup.push(() => client.close());
  await client.connect(a);
  return {root,config,registry,project,contextId,ingress,store,client};
}
function nextCall(result: {structuredContent?: unknown}) {
  return (result.structuredContent as {next:{tool:string;arguments:Record<string,unknown>}}).next;
}
const userTurn = {submissionId:'turn-1',conversationId:'conversation-1',contextId:'global',text:'Please remember this synthetic preference.'};
const imported = {importId:'import-1',contextId:'global',sourceLabel:'Visible notes',basis:'unknown',understanding:'Synthetic attributed material.',gaps:'Older sources unavailable.'};

it.each([false,true])('discovers typed contracts and follows returned IDs through queue and final review (modern=%s)',async modern => {
  const {client,store} = await setup(undefined,modern);
  expect(client.getServerVersion()?.version).toBe(JSON.parse(readFileSync('package.json','utf8')).version);
  const tools = (await client.listTools()).tools;
  expect(tools.map(t=>t.name)).toEqual(['memory_submit_user_turn','memory_init','memory_read','memory_status']);
  for (const tool of tools) {
    expect(tool.title).toBeTruthy(); expect(tool.outputSchema?.type).toBe('object');
    for (const field of Object.values(tool.inputSchema.properties ?? {})) expect(field).toHaveProperty('description');
  }
  expect(tools.find(t=>t.name==='memory_init')?.annotations).toMatchObject({destructiveHint:true,openWorldHint:true,idempotentHint:true});
  const discovery = await client.callTool({name:'memory_status',arguments:{}});
  expect(discovery.structuredContent).toMatchObject({readEnabled:true,submissionEnabled:true,initEnabled:true,limits:{maxInputBytes:null,maxMessageBytes:1048576}});
  const accepted = await client.callTool({name:'memory_submit_user_turn',arguments:userTurn});
  expect(accepted.isError).not.toBe(true);
  const next = nextCall(accepted);
  expect(next).toMatchObject({tool:'memory_status',arguments:{submissionId:userTurn.submissionId,conversationId:userTurn.conversationId}});
  expect(next.arguments).not.toHaveProperty('text');
  const pending = await client.callTool({name:next.tool,arguments:next.arguments});
  expect(pending.structuredContent).toMatchObject({submission:{state:'pending'},next:{action:'poll',retryAfterMs:2000}});
  const job = store!.claim()!; expect(job).toBeTruthy(); // One explicit MCP call requests prompt processing, below the six-turn threshold.
  store!.finish(job);
  const processed = await client.callTool({name:next.tool,arguments:next.arguments});
  expect(processed.structuredContent).toMatchObject({submission:{state:'processed',retainedIn:[]},next:{action:'read',tool:'memory_read'}});
  const readNext = nextCall(processed);
  expect((await client.callTool({name:readNext.tool,arguments:readNext.arguments})).structuredContent).toMatchObject({empty:true});
});

it('enforces schema constraints and offers safe actionable errors without accepting conflicting material',async()=>{
  const {client,ingress,store} = await setup();
  const malformed = await client.callTool({name:'memory_init',arguments:{...imported,sourceLabel:'中文标签'}});
  expect(malformed.isError).toBe(true); expect(store!.pending()).toHaveLength(0);
  expect((await client.callTool({name:'memory_init',arguments:imported})).isError).not.toBe(true);
  const conflict = await client.callTool({name:'memory_init',arguments:{...imported,understanding:'PRIVATE_CONFLICT_BODY'}});
  expect(conflict).toMatchObject({isError:true,structuredContent:{code:'SUBMISSION_CONFLICT',message:expect.any(String)}});
  expect(JSON.stringify(conflict)).not.toContain('PRIVATE_CONFLICT_BODY'); expect(store!.pending()).toHaveLength(1);
  const badStatus = await client.callTool({name:'memory_status',arguments:{importId:'import-1',submissionId:'turn-1'}});
  expect(badStatus).toMatchObject({isError:true,structuredContent:{code:'INVALID_SUBMISSION_ID'}});
  const unknown = await client.callTool({name:'memory_read',arguments:{contextId:'project:unregistered'}});
  expect(unknown).toMatchObject({isError:true,structuredContent:{code:'CONTEXT_UNAVAILABLE',message:expect.stringContaining('memory_status')}});
  const spy = vi.spyOn(ingress,'read').mockImplementation(()=>{throw new Error('PRIVATE_STORAGE_PATH_AND_SECRET');});
  const unavailable = await client.callTool({name:'memory_read',arguments:{}});
  expect(unavailable).toMatchObject({isError:true,structuredContent:{code:'MEMORY_UNAVAILABLE'}});
  expect(JSON.stringify(unavailable)).not.toContain('PRIVATE_STORAGE_PATH_AND_SECRET'); spy.mockRestore();
});

it('bounds retry guidance and stops polling on dead/quarantined work without claiming retention',async()=>{
  const {client,store} = await setup(['init']);
  const accepted = await client.callTool({name:'memory_init',arguments:imported});
  const next = nextCall(accepted);
  const job = store!.claim()!;
  store!.fail(job,new Error('TIMEOUT'));
  const retry = await client.callTool({name:next.tool,arguments:next.arguments});
  expect(retry.structuredContent).toMatchObject({import:{jobState:'retry'},next:{action:'poll',retryAfterMs:expect.any(Number)}});
  store!.db.prepare("UPDATE jobs SET state='dead' WHERE id=?").run(job.id);
  expect((await client.callTool({name:next.tool,arguments:next.arguments})).structuredContent).toMatchObject({next:{action:'correct'}});
  store!.db.prepare("UPDATE observations SET state='quarantined'").run();
  expect((await client.callTool({name:next.tool,arguments:next.arguments})).structuredContent).toMatchObject({next:{action:'correct',message:expect.stringContaining('quarantined')}});
  store!.db.prepare("UPDATE observations SET state='processed'").run();
  expect((await client.callTool({name:next.tool,arguments:next.arguments})).structuredContent).toMatchObject({next:{action:'review',message:expect.stringContaining('read-enabled')}});
});

it.each([false,true])('lists/completes/reads only current authorized resource URIs and rechecks revocation (modern=%s)',async modern=>{
  const {client,root,contextId,registry,project,config} = await setup(['read'],modern);
  mkdirSync(join(root,'memory/projects'),{recursive:true});
  writeFileSync(join(root,'memory/profile.md'),'# Profile\n\n## Background\nSynthetic global information.\n');
  // Obtain the actual canonical project path through existing target mapping.
  const {targetInfo} = await import('../../src/v2/canonical.js');
  const path = join(root,targetInfo(contextId).relative);
  const {dirname} = await import('node:path'); mkdirSync(dirname(path),{recursive:true});
  writeFileSync(path,'# Project\n\n## Constraint\nSynthetic project information.\n');
  expect(client.getServerCapabilities()?.resources).toMatchObject({listChanged:false});
  const template = (await client.listResourceTemplates()).resourceTemplates[0]!;
  expect(template.uriTemplate).toBe('common-memory://memory/{contextId}');
  const resources = (await client.listResources()).resources;
  expect(resources.map(r=>r.uri)).toEqual(['common-memory://memory/global',`common-memory://memory/${encodeURIComponent(contextId)}`]);
  const completed = await client.complete({ref:{type:'ref/resource',uri:template.uriTemplate},argument:{name:'contextId',value:'project:'}});
  expect(completed.completion.values).toEqual([contextId]);
  for (const resource of resources) {
    const read = await client.readResource({uri:resource.uri});
    const tool = await client.callTool({name:'memory_read',arguments:{contextId:resource.name}});
    expect(read.contents[0]).toMatchObject({text:(tool.content as {text:string}[])[0]!.text});
  }
  writeFileSync(path,'# Project\n\n## Updated\nNew canonical value.\n');
  expect((await client.readResource({uri:resources[1]!.uri})).contents[0]).toMatchObject({text:expect.stringContaining('New canonical value')});
  for (const uri of ['common-memory://memory/project%3Aunknown','common-memory://memory/global?other=1','common-memory://memory/%2e%2e%2fruntime.sqlite']) {
    await expect(client.readResource({uri})).rejects.toThrow();
  }
  registry.remove(project.id);
  expect((await client.listResources()).resources.map(r=>r.name)).toEqual(['global']);
  await expect(client.readResource({uri:resources[1]!.uri})).rejects.toThrow();
  expect((await client.complete({ref:{type:'ref/resource',uri:template.uriTemplate},argument:{name:'contextId',value:'project:'}})).completion.values).toEqual([]);
  config.disclosure.allowedScopes = [];
  expect((await client.listResources()).resources).toEqual([]);
  await expect(client.readResource({uri:resources[0]!.uri})).rejects.toThrow();
});

it('does not direct a project-only reader to an unreadable globally promoted destination',async()=>{
  const {client,ingress,store,config,contextId} = await setup();
  ingress.submit({...userTurn,contextId});
  const job = store!.claim()!;
  store!.finish(job,{jobId:job.id,observationIds:job.observations.map(o=>o.id),associations:[{target:`profile:${'a'.repeat(64)}`,sourceIds:[job.observations[0]!.id]}]});
  config.disclosure.allowedScopes = [contextId];
  const status = await client.callTool({name:'memory_status',arguments:{submissionId:userTurn.submissionId,conversationId:userTurn.conversationId}});
  expect(status.structuredContent).toMatchObject({submission:{state:'processed',retainedIn:['profile']},next:{action:'review'}});
});

it('does not expose resource capability on write profiles or status across profiles/revoked scopes',async()=>{
  const {client,ingress,store,config,contextId,registry,project} = await setup(['relay']);
  expect(client.getServerCapabilities()?.resources).toBeUndefined();
  expect((await client.callTool({name:'memory_status',arguments:{importId:'unknown'}})).structuredContent).toMatchObject({code:'STATUS_UNAVAILABLE'});
  ingress.submit({...userTurn,contextId});
  expect(ingress.status(userTurn)?.state).toBe('pending');
  const init = new McpIngress(store,config,{clientId:'discovery',workspaces:[],global:true,accept:true,capabilities:['init']});
  expect(()=>init.status(userTurn)).toThrow('STATUS_UNAVAILABLE');
  registry.remove(project.id);
  expect(ingress.status(userTurn)).toBeNull();
});
