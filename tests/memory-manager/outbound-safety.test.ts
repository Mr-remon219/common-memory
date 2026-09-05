import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it,vi} from 'vitest';
import {Writer} from '../../src/v2/writer.js';
it.each(['api_key: sk-abcdefghijklmnopqrstuvwxyz','sk-proj-abcdefghijklmnopqrstuvwxyz0123456789'])('blocks outbound secret %s before model call',async text=>{
  const root=mkdtempSync(join(tmpdir(),'v2-secret-'));const analyze=vi.fn();const writer=new Writer({dataRoot:root,model:{analyze},allowedScopes:['global']});
  try{writer.store.enqueue({sessionId:'s',entryId:'e',text,scope:'global',observedAt:new Date().toISOString(),source:'interactive'});await writer.run({force:true});expect(analyze).not.toHaveBeenCalled();expect(writer.canonical.snapshot().every(d=>!d.content.includes(text))).toBe(true);}
  finally{writer.close();rmSync(root,{recursive:true,force:true});}
});
