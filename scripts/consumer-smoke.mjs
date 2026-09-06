import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));const temp=mkdtempSync(join(tmpdir(),'memory-v2-package-'));
try {
  const packed=JSON.parse(execFileSync('npm',['pack','--json','--pack-destination',temp],{cwd:root,encoding:'utf8'}));
  execFileSync('tar',['-xzf',join(temp,packed[0].filename),'-C',temp]);
  const pkg=join(temp,'package'); if(existsSync(join(pkg,'dist/recall')) || existsSync(join(pkg,'dist/core/contracts/types.js')))throw new Error('Legacy Fact/Recall artifacts in package'); symlinkSync(join(root,'node_modules'),join(pkg,'node_modules'),'dir');
  if(!existsSync(join(pkg,'dist/v2/memory-maintainer.md')))throw new Error('Maintainer omitted from real package');
  if(!readFileSync(join(pkg,'dist/v2/memory-maintainer.md'),'utf8').trim())throw new Error('Empty maintainer');
  mkdirSync(join(temp,'node_modules'));symlinkSync(pkg,join(temp,'node_modules/common-memory-core'),'dir');
  writeFileSync(join(temp,'package.json'),JSON.stringify({type:'module'}));
  writeFileSync(join(temp,'consumer.ts'),'import {Writer,RuntimeStore,ProjectRegistry,CanonicalStore,defaultConfig,type MemoryModelPort} from "common-memory-core"; void Writer; void RuntimeStore; void ProjectRegistry; void CanonicalStore; void defaultConfig; const model: MemoryModelPort | null = null; void model;');
  execFileSync(join(root,'node_modules/.bin/tsc'),['--strict','--skipLibCheck','--target','ES2024','--module','NodeNext','--moduleResolution','NodeNext','--noEmit',join(temp,'consumer.ts')],{stdio:'inherit'});
  writeFileSync(join(temp,'load.mjs'),`import {Writer,RuntimeStore} from 'common-memory-core'; const store=new RuntimeStore(${JSON.stringify(join(temp,'data'))}); store.close(); const writer=new Writer({dataRoot:${JSON.stringify(join(temp,'data'))},allowedScopes:['global'],model:{analyze(){throw new Error('Empty queue must not call model')}}}); const result=await writer.run(); writer.close(); console.log(result); await import(${JSON.stringify(join(pkg,'dist/pi-extension/index.js'))});`);
  execFileSync(process.execPath,[join(temp,'load.mjs')],{stdio:'inherit'});
  execFileSync(process.execPath,[join(pkg,'dist/cli/main.js'),'--help'],{stdio:'inherit'});
  console.log('Actual packed package: typed consumer, prompt asset, Writer, Pi load and CLI startup passed');
}finally{rmSync(temp,{recursive:true,force:true});}
