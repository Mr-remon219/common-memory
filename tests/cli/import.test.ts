import { createServer } from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { defaultConfig } from '../../src/config/config.js';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { nodeProcess } from '../helpers/node-process.js';

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const entry = ['--import', pathToFileURL(resolve('tests/mcp/fixtures/source-loader.mjs')).href, resolve('src/cli/main.ts')];

function cli(args: string[], env: Record<string, string>, cwd?: string) {
  const managed = nodeProcess([...entry, ...args], { env, ...(cwd ? { cwd } : {}) });
  // Registered after fixture creation, so reverse teardown reaps the child first.
  cleanup.push(managed.stop);
  return managed.result;
}
function fixture(baseUrl: string, provenance: string[] = ['user_explicit', 'document_import'], turnThreshold = 6) {
  const home = mkdtempSync(join(tmpdir(), 'cm-import-'));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const config = defaultConfig({ COMMON_MEMORY_HOME: home });
  config.remote = { provider: 'openai-compatible', model: 'fake', baseUrl, apiKeyEnv: 'CM_TEST_KEY' };
  config.scheduler.turnThreshold = turnThreshold;
  config.disclosure.allowedProvenance = provenance as typeof config.disclosure.allowedProvenance;
  writeFileSync(join(home, 'config.json'), JSON.stringify(config));
  writeFileSync(join(home, '.env'), 'CM_TEST_KEY="synthetic-key"\n', {mode:0o600});
  const env = { ...process.env, COMMON_MEMORY_HOME: home } as Record<string, string>;
  return { home, config, env };
}
/** Scripted maintainer: retains each document part as an attributed Section; optionally fails a chosen part once. */
async function provider(options: { failPart?: number; chat?: boolean; permanent?: boolean } = {}) {
  const seen: { source_kind: string; part: number | undefined }[][] = []; let failed = false;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const wire = JSON.parse(body);
    const projection = JSON.parse(options.chat ? wire.messages[1].content : wire.input[1].content[0].text);
    const observations = projection.observations as { ref: string; text: string; source_kind: string; import?: { file_name: string; declared_author: string; part: { index: number; count: number }; heading_path: string[] } }[];
    seen.push(observations.map(o => ({ source_kind: o.source_kind, part: o.import?.part.index })));
    if (options.failPart !== undefined && !failed && observations.some(o => o.import?.part.index === options.failPart)) {
      failed = true;
      if (options.permanent) { res.writeHead(401); res.end('{}'); }
      else {
        // Real mid-body disconnection: the adapter reports a transient failure,
        // then the durable queue retries without losing the already imported parts.
        res.writeHead(200); res.write('{"incomplete":'); setTimeout(()=>res.destroy(),20);
      }
      return;
    }
    const decisions = observations.filter(o => o.source_kind === 'document_import').map(o => ({ kind: 'retain', admission: 'remember', lifetime: 'until_changed', applicability: 'global', confidence: 0.6, evidence: [o.ref], reason: 'scripted',
      // Section bodies may not contain un-fenced H1/H2, so the scripted body quotes the part in a fence.
      operations: [{ op: 'put_section', target: 'profile', section: null, title: `Imported ${o.import!.file_name} part ${o.import!.part.index} (${o.text.length} chars)`, body: `Imported from ${o.import!.file_name} (${o.import!.declared_author}) on ${projection.now.slice(0, 10)}, under ${JSON.stringify(o.import!.heading_path)}:\n\n\`\`\`text\n${o.text.trim().slice(0, 80)}\n\`\`\`\n` }] }));
    const decision = { version: 'memory_maintenance_v2', request_id: projection.request_id, decisions: decisions.length ? decisions : [{ kind: 'ignore', applicability: 'uncertain', confidence: 1, evidence: [], reason: 'scripted' }] };
    res.setHeader('content-type', 'application/json');
    if(options.chat){res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify(decision)}}]}));return;}
    res.end(JSON.stringify({ status: 'completed', incomplete_details: null, error: null, output: [{ type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(decision), annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>(r => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, seen };
}
const markdown = '# Notes\n\n## Pets\n\nKeeps a rescued tortoise named Basalt.\n\n> Only on weekends: Rust practice.\n\n```sh\n# not a heading\necho hi\n```\n';

it('imports a Markdown file through the unchanged Writer, reports retention, deduplicates by content and detects changes', async () => {
  const { url, seen } = await provider();
  const { env, config, home } = fixture(url);
  const file = join(home, 'notes.md'); writeFileSync(file, markdown);
  const first = await cli(['import', file, '--author', 'user'], env);
  expect(first.code, first.stderr).toBe(0);
  expect(first.stdout).toMatch(/accepted: queued as md-[a-f0-9]{64} \(1 part\)/);
  expect(first.stdout).toContain('"complete": true'); expect(first.stdout).toContain('complete: retained in profile');
  expect(first.stdout).not.toContain('Basalt'); // the CLI reports states, never bodies
  const profile = readFileSync(join(config.dataRoot, 'memory/profile.md'), 'utf8');
  expect(profile).toContain('Imported from notes.md (user)'); expect(profile).toContain('under []'); // one part: no ancestor headings
  expect(seen).toEqual([[{ source_kind: 'document_import', part: 1 }]]);
  // Same content under another name: duplicate, no second model call, still reported complete.
  const copy = join(home, 'renamed.md'); writeFileSync(copy, markdown);
  const again = await cli(['import', copy, '--author', 'user'], env);
  expect(again.code).toBe(0); expect(again.stdout).toContain('duplicate: this exact content was already imported'); expect(again.stdout).toContain('"complete": true');
  expect(seen).toHaveLength(1);
  // Changed content is a new import with a new id.
  writeFileSync(file, markdown + '\n## Update\n\nNow keeps two tortoises.\n');
  const changed = await cli(['import', file, '--author', 'user'], env);
  expect(changed.code, changed.stdout + changed.stderr).toBe(0); expect(changed.stdout).toContain('accepted: queued as md-'); expect(seen).toHaveLength(2);
  expect(readFileSync(join(config.dataRoot, 'memory/profile.md'), 'utf8')).toMatch(/Imported notes.md part 1[\s\S]*Imported notes.md part 1/);
  // Name/author/label deduplication variants are covered at admitDocumentImport,
  // while the subprocess replay above proves identity survives CLI restarts.
}, 30000);

it('maps parser, preprocessing and authorization refusals to CLI failure without storage or network effects', async () => {
  const { url, seen } = await provider();
  const { env, config, home } = fixture(url);
  // One representative per command failure path. The file-type/encoding/size
  // matrix belongs to tests/v2/document-import.test.ts, not eight CLI boots.
  const cases: [string, string, string[], string][] = [
    ['secret.md', '# Env\n\npassword: hunter2hunter2\n', [], 'SENSITIVE_CONTENT_REJECTED part 1/1'],
    ['ok.md', '# ok\n\nfine\n', ['--author', 'nobody'], '--author must be one of'],
    ['ok.md', '# ok\n\nfine\n', ['--workspace', '/definitely/not/registered'], 'UNREGISTERED_WORKSPACE'],
  ];
  for (const [name, content, extra, message] of cases) {
    const file = join(home, name); writeFileSync(file, content);
    const result = await cli(['import', file, ...extra], env);
    expect(result.code, name).toBe(1); expect(result.stderr, name).toContain(message);
  }
  expect(existsSync(join(config.dataRoot, 'runtime.sqlite'))).toBe(false);
  // Provenance not authorized: the Writer is never even created.
  const disabled = fixture(url, ['user_explicit']);
  writeFileSync(join(disabled.home, 'n.md'), markdown);
  const off = await cli(['import', join(disabled.home, 'n.md')], disabled.env);
  expect(off.code).toBe(1); expect(off.stderr).toContain('IMPORT_DISABLED'); expect(existsSync(join(disabled.config.dataRoot, 'runtime.sqlite'))).toBe(false);
  expect(seen).toEqual([]);
}, 30000);

it('a multi-part import reports partial failure honestly and resumes on re-import; import-only configs need no user_explicit', async () => {
  const { url, seen } = await provider({ failPart: 2 });
  // One part per batch so that partial progress is observable; without user_explicit the Writer still runs.
  const { env, config, home } = fixture(url, ['document_import'], 1);
  const parts = Array.from({ length: 3 }, (_, i) => `## Section ${i + 1}\n\n${`Paragraph ${i + 1}. `.repeat(2000)}\n\n`).join('');
  const file = join(home, 'long.md'); writeFileSync(file, `# Long\n\n${parts}`);
  const first = await cli(['import', file], env);
  expect(first.code).toBe(1);
  expect(first.stdout).toContain('(3 parts)'); expect(first.stdout).toContain('"complete": false'); expect(first.stdout).toContain('incomplete: some parts were not processed');
  expect(first.stdout).toMatch(/"state": "processed"/); expect(first.stdout).toMatch(/"state": "(claimed|pending)"/);
  const before = readFileSync(join(config.dataRoot, 'memory/profile.md'), 'utf8');
  expect(before).toContain('part 1'); expect(before).not.toContain('part 2');
  // Retry backoff for the first failure is one second; re-importing the same file resumes the queue.
  await new Promise(r => setTimeout(r, 1200));
  const second = await cli(['import', file], env);
  expect(second.code, second.stderr).toBe(0);
  expect(second.stdout).toContain('duplicate:'); expect(second.stdout).toContain('"complete": true');
  const after = readFileSync(join(config.dataRoot, 'memory/profile.md'), 'utf8');
  for (const n of [1, 2, 3]) expect(after).toContain(`Imported long.md part ${n}`);
  // Every model call carried only document parts with their position in the whole material.
  for (const batch of seen) for (const o of batch) expect(o.source_kind).toBe('document_import');
  expect(seen.flat().map(o => o.part).sort()).toEqual([1, 2, 2, 3]);
  // --no-wait only queues.
  writeFileSync(join(home, 'later.md'), '# Later\n\nqueued only\n');
  const queued = await cli(['import', join(home, 'later.md'), '--no-wait'], env);
  expect(queued.code).toBe(0); expect(queued.stdout).toContain('queued: run common-memory flush');
  const store = new RuntimeStore(config.dataRoot); try { expect(store.pending()).toHaveLength(1); } finally { store.close(); }
}, 40000);

it('401 stops an import without losing it; duplicate import waits for explicit retry', async () => {
  const {url,seen}=await provider({failPart:1,permanent:true});const {env,home,config}=fixture(url);
  const file=join(home,'auth.md');writeFileSync(file,'# Synthetic\n\nPrefer concise replies.\n');
  const first=await cli(['import',file],env);expect(first.code).toBe(1);expect(first.stdout).toContain('"state": "dead"');
  const store=new RuntimeStore(config.dataRoot);let jobId:string;
  try {const job=store.status().jobs[0]!;expect(job).toMatchObject({state:'dead',attempts:1,issue:'AUTHENTICATION'});jobId=job.id;}
  finally {store.close();}
  expect((await cli(['import',file],env)).code).toBe(1);expect(seen).toHaveLength(1);
  expect((await cli(['retry',jobId!],env)).code).toBe(0);
  expect((await cli(['import',file],env)).code).toBe(0);expect(seen).toHaveLength(2);
},30000);

it('mcp-config pins node, CLI entry, configuration directory and dataRoot; --wsl bridges through wsl.exe into a fixed distribution and user', async () => {
  const { env, config, home } = fixture('http://127.0.0.1:1/v1');
  const native = await cli(['mcp-config'], env);
  expect(native.code, native.stderr).toBe(0);
  expect(native.stdout).toContain(`env = { COMMON_MEMORY_HOME = ${JSON.stringify(home)} }`);
  expect(native.stdout).toContain(`dataRoot (canonical Markdown under <dataRoot>/memory): ${config.dataRoot}`);
  expect(native.stdout).toContain('[mcp_servers.common_memory_init]'); expect(native.stdout).toContain('"--capability", "init", "--global"');
  expect(native.stdout).toContain('[mcp_servers.common_memory]'); expect(native.stdout).toContain('"--capability", "read", "--global"'); expect(native.stdout).toContain('enabled_tools = ["memory_read", "memory_status"]');
  expect(native.stdout).not.toContain('wsl.exe');
  const wsl = await cli(['mcp-config', '--wsl', '--user', 'tester'], { ...env, WSL_DISTRO_NAME: 'UbuntuTest' });
  if (process.platform === 'linux') {
    expect(wsl.code, wsl.stderr).toBe(0);
    expect(wsl.stdout).toContain('command = '+JSON.stringify('C:\\Windows\\System32\\wsl.exe'));
    expect(wsl.stdout).toContain(`args = ["-d", "UbuntuTest", "-u", "tester", "-e", "/usr/bin/env", ${JSON.stringify(`COMMON_MEMORY_HOME=${home}`)}, `);
    expect(wsl.stdout).toContain(resolve('src/cli/main.ts')); expect(wsl.stdout).toContain('WSL distribution: UbuntuTest; Linux user: tester');
    expect(wsl.stdout).toContain('Windows-native Pi is not covered');
    const noDistro = await cli(['mcp-config', '--wsl'], { ...env, WSL_DISTRO_NAME: '' });
    expect(noDistro.code).toBe(1); expect(noDistro.stderr).toContain('--wsl needs a distribution');
  } else {
    // The bridge embeds Linux paths; generating it from a non-Linux host is refused rather than producing a broken config.
    expect(wsl.code).toBe(1); expect(wsl.stderr).toContain('--wsl must run inside the WSL distribution');
  }
  // A registered project adds --workspace and warns when it is not an allowed disclosure scope.
  mkdirSync(join(home, 'proj'));
  const registered = await cli(['project', 'register', join(home, 'proj'), 'Proj'], env); expect(registered.code, registered.stderr).toBe(0);
  const withProject = await cli(['mcp-config', '--workspace', join(home, 'proj')], env);
  expect(withProject.stdout).toContain(`"--workspace", ${JSON.stringify(join(home, 'proj'))}`); expect(withProject.stdout).toContain('not in disclosure.allowedScopes');
  expect((await cli(['mcp-config', '--workspace', join(home, 'nope')], env)).stderr).toContain('UNREGISTERED_WORKSPACE');
}, 30000);

it('flush exits 1 for failure, backoff, claimed or dead work and 0 only after completion', async()=>{
 const {url}=await provider({failPart:1});const {env,home,config}=fixture(url);
 const file=join(home,'flush.md');writeFileSync(file,'# Example\n\nSynthetic fixture.\n');
 expect((await cli(['import',file,'--no-wait'],env)).code).toBe(0);
 const failed=await cli(['flush'],env);expect(failed.code,failed.stderr).toBe(1);expect(failed.stdout).toContain('"outcome":"failed"');
 let store=new RuntimeStore(config.dataRoot);
 try{expect(store.status().jobs[0]).toMatchObject({diagnostic:{stage:'response_body',httpStatus:200,reason:'network_error'}});store.db.prepare("UPDATE jobs SET available=? WHERE state='retry'").run(Date.now()+600000);}finally{store.close();}
 const backoff=await cli(['flush'],env);expect(backoff.code).toBe(1);expect(backoff.stdout).toContain('"outcome":"idle"');
 store=new RuntimeStore(config.dataRoot);let jobId='';
 try{store.db.prepare("UPDATE jobs SET available=0 WHERE state='retry'").run();const job=store.claim({force:true})!;jobId=job.id;}finally{store.close();}
 const claimed=await cli(['flush'],env);expect(claimed.code).toBe(1);expect(claimed.stdout).toContain('"outcome":"idle"');
 store=new RuntimeStore(config.dataRoot);
 try{store.db.prepare("UPDATE jobs SET expires=0,attempts=5 WHERE id=?").run(jobId);}finally{store.close();}
 expect((await cli(['flush'],env)).code).toBe(1);
 store=new RuntimeStore(config.dataRoot);try{expect(store.status().jobs[0]!.state).toBe('dead');store.retry(jobId);}finally{store.close();}
 const success=await cli(['flush'],env);expect(success.code,success.stderr).toBe(0);
 expect((await cli(['flush'],env)).code).toBe(0);
},30000);

it('flush reports new quarantine as failure; historical quarantine and retired jobs do not block an empty queue',async()=>{
 const {url}=await provider();const {env,config}=fixture(url);
 const s=new RuntimeStore(config.dataRoot);s.enqueue({sessionId:'s',entryId:'secret',text:'password: hunter2hunter2',scope:'global',source:'interactive',observedAt:new Date().toISOString()});s.close();
 const first=await cli(['flush'],env);expect(first.code).toBe(1);expect(first.stdout).toContain('"outcome":"quarantined"');
 const empty=await cli(['flush'],env);expect(empty.code,empty.stderr).toBe(0);
},15000);

it('status shows configured and real paths without creating missing storage',async()=>{
 const {env,home,config}=fixture('http://127.0.0.1:1/v1');
 expect(existsSync(config.dataRoot)).toBe(false);
 const status=await cli(['status'],env);expect(status.code,status.stderr).toBe(0);
 expect(status.stdout).toContain(`Config: ${join(home,'config.json')}`);expect(status.stdout).toContain(`Actual data: ${config.dataRoot} (unresolved or not created)`);
 expect(existsSync(config.dataRoot)).toBe(false);
 if(process.platform!=='win32'){
   const {symlinkSync,realpathSync}=await import('node:fs');const link=join(home,'alias');symlinkSync(home,link,'dir');
   const aliased=await cli(['status'],{...env,COMMON_MEMORY_HOME:link});expect(aliased.code,aliased.stderr).toBe(0);expect(aliased.stdout).toContain(`Actual config: ${realpathSync(join(home,'config.json'))}`);
 }
},15000);

it.each(['flush','import'])('%s SIGINT cancels inflight work with exit 1 and a durable CANCELLED diagnostic',async command=>{
 if(process.platform==='win32')return; // Windows task termination is covered by its own CI/client checks.
 let entered!:()=>void;const received=new Promise<void>(resolve=>{entered=resolve;});
 const server=createServer((_req,_res)=>{entered();});server.listen(0,'127.0.0.1');await once(server,'listening');
 cleanup.push(()=>{server.closeAllConnections();server.close();});
 const {env,config,home}=fixture(`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`);
 config.remote.proxy={mode:'direct'};writeFileSync(join(home,'config.json'),JSON.stringify(config));
 const file=join(home,'cancel.md');writeFileSync(file,'# Synthetic\n\nOrdinary imported fixture.\n');
 if(command==='flush'){const store=new RuntimeStore(config.dataRoot);store.enqueue({sessionId:'s',entryId:'e',text:'Ordinary fixture',scope:'global',source:'interactive',observedAt:new Date().toISOString()});store.close();}
 const managed=nodeProcess([...entry,...(command === 'flush' ? ['flush'] : ['import',file])],{env});
 cleanup.push(managed.stop);await received;managed.child.kill('SIGINT');
 const result=await managed.result;
 expect(result.code,result.stderr).toBe(1);expect(result.stdout).toContain('"reason":"CANCELLED"');
 const reopened=new RuntimeStore(config.dataRoot);try{expect(reopened.status().jobs[0]).toMatchObject({issue:'CANCELLED',diagnostic:{reason:'cancelled'}});}finally{reopened.close();}
},15000);

it('an explicit Chat configuration imports through the real HTTP adapter, Core and persistent receipts',async()=>{
 const {url}=await provider({chat:true});const {home,env,config}=fixture(url,['document_import']);
 config.remote={...config.remote,api:'chat_completions',thinking:{type:'disabled'}};writeFileSync(join(home,'config.json'),JSON.stringify(config));
 const file=join(home,'chat.md');writeFileSync(file,'# Notes\n\nAn attributed synthetic fixture.\n');
 const imported=await cli(['import',file],env);expect(imported.code,imported.stderr).toBe(0);expect(imported.stdout).toContain('"complete": true');
 const store=new RuntimeStore(config.dataRoot);try{expect(store.db.prepare('SELECT COUNT(*) AS n FROM receipts').get()!.n).toBe(1);}finally{store.close();}
 expect(readFileSync(join(config.dataRoot,'memory/profile.md'),'utf8')).toContain('Imported from chat.md');
 expect((await cli(['show'],env)).stdout).toContain('An attributed synthetic fixture.');
},75000); // Two source-loaded CLI boots, including durable writes, on Windows CI.

it('network-test is explicit, distinguishes API authentication and opens no memory storage',async()=>{
 let calls=0;
 const server=createServer(async(req,res)=>{
  calls++;let body='';for await(const chunk of req)body+=chunk;
  const wire=JSON.parse(body);expect(wire.input[1].content[0].text).toContain('synthetic data only');
  res.setHeader('content-type','application/json');
  if(calls===1)res.end(JSON.stringify({status:'completed',output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'{"ok":true}'}]}]}));
  else {res.writeHead(401);res.end('{"error":{"code":"invalid_api_key"}}');}
 });server.listen(0,'127.0.0.1');await once(server,'listening');cleanup.push(()=>{server.closeAllConnections();server.close();});
 const {env,config,home}=fixture(`http://127.0.0.1:${(server.address() as {port:number}).port}`);
 config.remote.proxy={mode:'direct'};writeFileSync(join(home,'config.json'),JSON.stringify(config));
 const status=await cli(['status'],env);expect(status.code).toBe(0);expect(calls).toBe(0);
 const first=await cli(['network-test'],env);expect(first.code,first.stderr).toBe(0);expect(first.stdout).toContain('"writerCommitTested":false');
 const second=await cli(['network-test'],env);expect(second.code).toBe(1);expect(second.stdout).toContain('"providerResponded":true');expect(second.stdout).toContain('"code":"AUTHENTICATION"');
 expect(existsSync(config.dataRoot)).toBe(false);
},15000);
