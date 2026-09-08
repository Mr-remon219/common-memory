#!/usr/bin/env node
// One existing Init/Markdown retention scenario, parameterized by the existing remote config.
// Explicit live/fixture evidence; no provider detection or API/model fallback.
import { mkdtempSync, readFileSync, readdirSync, realpathSync, lstatSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const cli = fileURLToPath(new URL('../dist/cli/main.js', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
function snapshot(config, evidence) {
  const sources = [{dataRoot:config.dataRoot}];
  // Fake-provider tests need no personal data. Live runs also protect both normal configuration homes.
  if(evidence === 'live') for (const home of new Set([join(homedir(),'.common-memory'),process.env.COMMON_MEMORY_HOME].filter(Boolean))) {
    try { sources.push({home,dataRoot:JSON.parse(readFileSync(join(home,'config.json'),'utf8')).dataRoot}); }
    catch (error) { if(error.code !== 'ENOENT') throw error; }
  }
  return sources.map(source=>{
    const memory=join(source.dataRoot,'memory'),files=[];
    function walk(directory, relative='') {
      for(const name of readdirSync(directory).sort()) {
        const path=join(directory,name),rel=join(relative,name),stat=lstatSync(path);
        if(stat.isSymbolicLink()) files.push([rel,'symlink',digest(readlinkSync(path))]);
        else if(stat.isDirectory()) { files.push([rel,'directory']);walk(path,rel); }
        else if(stat.isFile()) files.push([rel,digest(readFileSync(path))]);
      }
    }
    let actualMemory;
    try { actualMemory=realpathSync(memory);walk(memory); }
    catch(error) { if(error.code !== 'ENOENT') throw error;actualMemory=null; }
    return {...source,memory,actualMemory,sha256:digest(JSON.stringify(files))};
  });
}
function isolated(run, label, remote, env, defaultConfig) {
  const home = mkdtempSync(join(run, `${label}-home-`)), dataRoot = mkdtempSync(join(run, `${label}-data-`));
  const config = defaultConfig({COMMON_MEMORY_HOME:home});
  config.dataRoot = dataRoot;
  config.remote = structuredClone(remote);
  config.disclosure.allowedProvenance = ['agent_observation','document_import'];
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2), {mode:0o600,flag:'wx'});
  return {home,dataRoot,apiKeyEnv:remote.apiKeyEnv,env:{...env,COMMON_MEMORY_HOME:home}};
}
async function connect(fixture, capability) {
  const client = new Client({name:'isolated-provider-smoke',version:'1'});
  const env = {...fixture.env};
  if (capability === 'read') for (const name of Object.keys(env)) {
    if(name.toUpperCase() === fixture.apiKeyEnv.toUpperCase()) delete env[name];
  }
  const transport = new StdioClientTransport({command:process.execPath,args:[cli,'mcp','--client-id','provider-smoke','--capability',capability,'--global'],env,stderr:'pipe'});
  // Server errors are already generic. Drain without logging arbitrary process output.
  transport.stderr?.resume();
  try { await client.connect(transport); return client; } catch (error) { await transport.close(); throw error; }
}
async function command(fixture, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath,[cli,...args],{env:fixture.env,stdio:['ignore','pipe','pipe']});
    let output=''; child.stdout.on('data',b=>{output+=b;});child.stderr.resume();child.on('error',reject);
    child.on('close',code=>resolve({exitCode:code,output}));
  });
}
function queueSnapshot(fixture, RuntimeStore, markdownOutcome) {
  const store = new RuntimeStore(fixture.dataRoot);
  try {
    const directory = join(fixture.dataRoot,'runtime/receipts');
    const fileReceiptIds = readdirSync(directory).map(name=>{
      const receipt = JSON.parse(readFileSync(join(directory,name),'utf8'));
      if (name !== `${receipt.id}.json` || receipt.id !== receipt.jobId) throw new Error('INVALID_RECEIPT');
      return receipt.id;
    }).sort();
    return {...store.status(),receipts:store.db.prepare('SELECT id FROM receipts ORDER BY id').all().map(r=>String(r.id)),fileReceipts:fileReceiptIds.length,fileReceiptIds,...(markdownOutcome ? {markdown:markdownOutcome(store)} : {})};
  }
  finally { store.close(); }
}
/** No second remote-option schema: validation remains owned by Common Memory config. */
export async function runProviderSmoke({config, evidence, clearNoProxy = false}) {
  if (!['live','fixture'].includes(evidence)) throw new Error('Select live or fixture evidence');
  const {defaultConfig,validateConfig} = await import('../dist/config/config.js');
  const {RuntimeStore} = await import('../dist/v2/runtime.js');
  const {prepareDocumentImport,documentImportOutcome} = await import('../dist/v2/document-import.js');
  const {describeConfiguredNetwork} = await import('../dist/config/runtime.js');
  const {sanitizeDiagnostic} = await import('../dist/memory-manager/contracts/diagnostic.js');
  const {maintenanceSchema} = await import('../dist/v2/contract.js');
  const contract = {schemaName:'memory_maintenance_v2',schemaSha256:digest(JSON.stringify(maintenanceSchema)),promptSha256:digest(readFileSync(new URL('../dist/v2/memory-maintainer.md',import.meta.url)))};
  const remote = validateConfig(config).remote;
  if (!remote.proxy) throw new Error('Smoke requires an explicit remote.proxy mode');
  if (!process.env[remote.apiKeyEnv]?.trim()) throw new Error('Configured API key must be present in process environment');
  const env = {...process.env,...(clearNoProxy ? {no_proxy:'',NO_PROXY:''} : {})};
  const before = snapshot(config,evidence), run = mkdtempSync(join(tmpdir(),'cm-provider-smoke-'));
  const fixture = isolated(run,'init',remote,env,defaultConfig);
  const api = remote.api ?? 'responses';
  const report = {reportVersion:1,contract,scenario:'init-markdown-retention-v1',evidence,startedAt:new Date().toISOString(),node:process.versions.node,platform:process.platform,
    endpoint:`${remote.baseUrl}/${api === 'responses' ? 'responses' : 'chat/completions'}`,model:remote.model,api,apiKeyEnv:remote.apiKeyEnv,
    maxOutputTokens:remote.maxOutputTokens ?? 4096,reasoningEffort:remote.reasoningEffort ?? 'omitted',thinking:remote.thinking ?? 'omitted',enableThinking:remote.enableThinking ?? 'omitted',
    network:{mode:remote.proxy.mode,noProxyOverride:clearNoProxy ? 'empty' : 'inherited'},home:fixture.home,dataRoot:fixture.dataRoot,before,passed:false,retentionVerified:false};
  let step = 'init';
  try {
    report.network.route = describeConfiguredNetwork({...config,remote},fixture.env);
    const init = await connect(fixture,'init');
    try {
      report.initTools = (await init.listTools()).tools.map(t=>t.name);
      report.accepted = (await init.callTool({name:'memory_init',arguments:{importId:'live-init',contextId:'global',sourceLabel:'smoke-fixture',basis:'saved_memories',understanding:'The user is an ecology student who keeps a rescued three-legged tortoise named Quillon. They learn Rust on weekends and prefer Chinese replies with English technical terms in parentheses.',gaps:'Synthetic fixture only; no personal data or real agent memory was accessed.'}})).structuredContent;
      const deadline = Date.now()+335000;
      report.initAttempts = [];
      let previousState = '';
      do {
        report.init = (await init.callTool({name:'memory_status',arguments:{importId:'live-init'}})).structuredContent.import;
        const changed = JSON.stringify(report.init);
        if (changed !== previousState) { report.initAttempts.push(report.init); previousState = changed; }
        if (!['pending','claimed'].includes(report.init.state)) break;
        await new Promise(resolve=>setTimeout(resolve,200));
      } while(Date.now()<deadline);
    } finally { await init.close(); }
    report.initQueue = queueSnapshot(fixture,RuntimeStore);
    step = 'markdown';
    // If Init failed, leave its durable retry untouched and test Markdown in a second fresh store.
    const markdownFixture = report.init.state === 'processed' ? fixture : isolated(run,'markdown',remote,env,defaultConfig);
    report.markdownHome = markdownFixture.home; report.markdownDataRoot = markdownFixture.dataRoot;
    const file = join(run,'fixture.md');
    writeFileSync(file,'# Synthetic imported notes\n\nI use Fedora Silverblue on my main workstation and fish as my everyday shell. When helping me with terminal commands, provide fish-compatible syntax and account for the immutable base system.\n',{mode:0o600,flag:'wx'});
    const prepared = prepareDocumentImport(file,{author:'unknown',label:'smoke-markdown-fixture',maxTotalBytes:131072});
    const outcome = store=>documentImportOutcome(store,prepared.importId,'global',prepared.chunks.length);
    report.markdownAttempts = [];
    const markdownDeadline = Date.now()+335000;
    do {
      const imported = await command(markdownFixture,['import',file,'--author','unknown','--label','smoke-markdown-fixture']);
      report.markdownExitCode = imported.exitCode; report.markdownQueue = queueSnapshot(markdownFixture,RuntimeStore,outcome);
      report.markdownAttempts.push({exitCode:imported.exitCode,queue:report.markdownQueue,output:imported.output});
      const job = report.markdownQueue.markdown.parts[0];
      if (imported.exitCode === 0 || !job || job.jobState !== 'retry' || Date.now() >= markdownDeadline) break;
      // Honor the existing Runtime backoff and attempt cap; never reset or retire a job.
      await new Promise(resolve=>setTimeout(resolve,Math.max(0,job.retryAt-Date.now())+20));
    } while (true);
    step = 'restart-read';
    for (const [name, target] of [['initRead',fixture],['markdownRead',markdownFixture]]) {
      const read = await connect(target,'read');
      try {
        const view = (await read.callTool({name:'memory_read',arguments:{contextId:'global'}})).structuredContent;
        const content = JSON.stringify(view);
        report[name] = {tools:(await read.listTools()).tools.map(t=>t.name),empty:view.empty,hasQuillon:/\bQuillon\b/u.test(content),hasFedora:/\bFedora\b/u.test(content),hasFish:/\bfish\b/iu.test(content),sha256:digest(content)};
      } finally { await read.close(); }
    }
  } catch (error) { report.failedStep = step; report.failure = {code:'SMOKE_STEP_FAILED',diagnostic:sanitizeDiagnostic(error?.diagnostic)}; }
  finally {
    report.after = snapshot(config,evidence); report.formalMemoryUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
    report.checks = retentionChecks(report);
    report.passed = Object.values(report.checks).every(Boolean);
    report.retentionVerified = report.passed && evidence === 'live';
    report.finishedAt = new Date().toISOString();
    const path = join(run,'report.json'); report.reportPath = path;
    writeFileSync(path,JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});
  }

  return report;
}

/** Evidence is tied to each source's job, never receipt counts or job.state=done alone. */
export function retentionChecks(report) {
  const linked = (part,queue)=>Boolean(part?.state === 'processed' && part.retainedIn?.length > 0 && part.jobId && queue?.receipts?.includes(part.jobId) && queue?.fileReceiptIds?.includes(part.jobId));
  const markdown = report.markdownQueue?.markdown;
  return {
    initRetained:linked(report.init,report.initQueue),
    markdownRetained:Boolean(report.markdownExitCode === 0 && markdown?.complete && markdown.parts?.length > 0 && markdown.parts.every(part=>linked(part,report.markdownQueue))),
    sameStore:report.dataRoot !== undefined && report.dataRoot === report.markdownDataRoot,
    restartRead:Boolean(report.initRead?.hasQuillon && report.markdownRead?.hasQuillon && report.markdownRead?.hasFedora && report.markdownRead?.hasFish && report.markdownRead?.empty === false),
    formalMemoryUnchanged:report.formalMemoryUnchanged === true,
    completed:!report.failedStep,
  };
}

export function parseSmokeArgs(args) {
  let path, evidence, clearNoProxy = false;
  for(let i=0;i<args.length;i++) {
    const arg=args[i];
    if(arg === '--config' && path === undefined) { path=args[++i]; if(!path || path.startsWith('--')) throw new Error('Missing config path'); }
    else if((arg === '--live' || arg === '--fixture') && evidence === undefined) evidence=arg.slice(2);
    else if(arg === '--clear-no-proxy' && !clearNoProxy) clearNoProxy=true;
    else throw new Error('Unknown or duplicate smoke option');
  }
  if(!path || !evidence) throw new Error('Use --config <config.json> and exactly one of --live / --fixture');
  return {path,evidence,clearNoProxy};
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if(process.argv.length === 3 && process.argv[2] === '--help') {
    console.log('node scripts/smoke-provider.mjs --config <config.json> --live|--fixture [--clear-no-proxy]\nUses remote settings only; fresh synthetic home/dataRoot; secrets from process env; requires npm run build.');
  } else {
    try {
      const {path,...options}=parseSmokeArgs(process.argv.slice(2));
      const config=JSON.parse(readFileSync(path,'utf8'));
      const report=await runProviderSmoke({config,...options});console.log(JSON.stringify(report,null,2));process.exitCode=report.passed ? 0 : 1;
    } catch { console.error('Smoke setup failed; check the config schema, explicit network mode, environment key and built artifacts.');process.exitCode=2; }
  }
}
