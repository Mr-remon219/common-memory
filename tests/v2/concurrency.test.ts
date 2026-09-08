import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { RuntimeStore } from '../../src/v2/runtime.js';
const roots:string[]=[];
afterEach(()=>{for(const path of roots.splice(0))rmSync(path,{recursive:true,force:true});});
const runtimeUrl=new URL('../../src/v2/runtime.ts',import.meta.url).href;
const loader=new URL('../mcp/fixtures/source-loader.mjs',import.meta.url).href;
async function runPair(script:string):Promise<string[]> {
 const run=()=>new Promise<string>((ok,fail)=>{const child=spawn(process.execPath,['--import',loader,script]);let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);child.on('error',fail);child.on('close',(code,signal)=>code===0?ok(output.trim()):fail(new Error(`child exit ${code}, signal ${signal ?? 'none'}\n${error}`)));});
 // A failed child must not let teardown remove a database its sibling still has open.
 const settled=await Promise.allSettled([run(),run()]);
 return settled.map(result=>{if(result.status==='rejected')throw result.reason;return result.value;});
}
it('two real processes cannot claim the same dataRoot maintenance lease',async()=>{
 const path=mkdtempSync(join(tmpdir(),'cm-process-'));roots.push(path);const store=new RuntimeStore(path);store.enqueue({sessionId:'s',entryId:'e',text:'user',source:'interactive',scope:'global',observedAt:new Date().toISOString()});store.close();
 // Run a file through the shared source loader to keep Windows arguments and failure traces small.
 const scripts=mkdtempSync(join(tmpdir(),'cm-process-script-'));roots.push(scripts);const script=join(scripts,'claim.mjs');
 writeFileSync(script,`import {RuntimeStore} from ${JSON.stringify(runtimeUrl)};const s=new RuntimeStore(${JSON.stringify(path)});try{const j=s.claim({force:true});console.log(j?'claimed':'idle');}finally{s.close();}`);
 expect((await runPair(script)).sort()).toEqual(['claimed','idle']);
});

it.each(['delete','wal'])('two real processes migrate an old jobs table exactly once from %s mode',async journalMode=>{
 const {DatabaseSync}=await import('node:sqlite');
 const path=mkdtempSync(join(tmpdir(),'cm-migrate-'));roots.push(path);
 const db=new DatabaseSync(join(path,'runtime.sqlite'));
 db.exec(`PRAGMA journal_mode=${journalMode}`);
 db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,token TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL,available INTEGER NOT NULL,issue TEXT); INSERT INTO jobs VALUES('old','token',1,'done',0,1,0,'TIMEOUT')");db.close();
 const script=join(path,'open.mjs');writeFileSync(script,`import {RuntimeStore} from ${JSON.stringify(runtimeUrl)};const s=new RuntimeStore(${JSON.stringify(path)});try{console.log(JSON.stringify(s.status().jobs));}finally{s.close();}`);
 const results=await runPair(script);for(const result of results)expect(JSON.parse(result)).toMatchObject([{id:'old',issue:'TIMEOUT',diagnostic:null}]);
 const check=new RuntimeStore(path);try{expect(check.db.prepare('PRAGMA table_info(jobs)').all().filter(r=>r.name==='diagnostic')).toHaveLength(1);}finally{check.close();}
});
