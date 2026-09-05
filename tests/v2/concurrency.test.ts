import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import ts from 'typescript';
import { RuntimeStore } from '../../src/v2/runtime.js';
const roots:string[]=[];
afterEach(()=>{for(const path of roots.splice(0))rmSync(path,{recursive:true,force:true});});
function moduleUrl(file:string):string {
 const text=readFileSync(file,'utf8').replace(/from ['"](\.\/[^'"]+)['"]/g,(_all,relative:string)=>`from ${JSON.stringify(moduleUrl(resolve(file,'..',relative.replace(/\.js$/,'.ts'))))}`);
 return 'data:text/javascript;base64,'+Buffer.from(ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText).toString('base64');
}
it('two real processes cannot claim the same dataRoot maintenance lease',async()=>{
 const path=mkdtempSync(join(tmpdir(),'cm-process-'));roots.push(path);const store=new RuntimeStore(path);store.enqueue({sessionId:'s',entryId:'e',text:'user',source:'interactive',scope:'global',observedAt:new Date().toISOString()});store.close();
 const url=moduleUrl(resolve('src/v2/runtime.ts'));
 const run=()=>new Promise<string>((ok,fail)=>{const child=spawn(process.execPath,['--input-type=module','-e',`import {RuntimeStore} from ${JSON.stringify(url)};const s=new RuntimeStore(${JSON.stringify(path)});const j=s.claim({force:true});console.log(j?'claimed':'idle');s.close();`]);let output='',error='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>error+=b);child.on('error',fail);child.on('exit',code=>code===0?ok(output.trim()):fail(new Error(error)));});
 expect((await Promise.all([run(),run()])).sort()).toEqual(['claimed','idle']);
});
