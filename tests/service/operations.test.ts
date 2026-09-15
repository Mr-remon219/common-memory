import { afterEach,describe,expect,it } from 'vitest';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig } from '../../src/config/config.js';
import { RuntimeStore } from '../../src/v2/runtime.js';
import { DispatchPort } from '../helpers/service-dispatch.js';
const roots:string[]=[];afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const home=mkdtempSync(join(tmpdir(),'cm-operations-'));roots.push(home);const config=defaultConfig({COMMON_MEMORY_HOME:home}),store=new RuntimeStore(config.dataRoot),port=new DispatchPort(store,()=>config,{kind:'cli'});return {store,port};}
describe('service operation truthfulness',()=>{
 it('reports cancellation only when it durably changes an eligible task',async()=>{const {store,port}=fixture();const observation=store.enqueue({sessionId:'s',entryId:'e',scope:'global',source:'interactive',text:'synthetic',observedAt:new Date().toISOString()});expect(await port.call('task.cancel',{id:`task_${observation.id}`})).toEqual({cancelled:true,id:`task_${observation.id}`});expect(await port.call('task.cancel',{id:`task_${observation.id}`})).toEqual({cancelled:false,id:`task_${observation.id}`});const done=store.enqueue({sessionId:'done',entryId:'e',scope:'global',source:'interactive',text:'done',observedAt:new Date().toISOString()}),job=store.claim({force:true})!;expect(job.observations.map(row=>row.id)).toContain(done.id);store.finish(job);expect(await port.call('task.cancel',{id:job.id})).toEqual({cancelled:false,id:job.id});store.close();});
});
