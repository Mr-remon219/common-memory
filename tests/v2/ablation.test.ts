import { expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { RuntimeStore } from '../../src/v2/runtime.js';

interface Row { scenario:string; variant:string; processed:number; pending:number; maintenanceBatches:number; meanWaitToHorizonMs:number; batches:{atMs:number;entries:string[]}[] }
const experiment = await import(pathToFileURL(resolve('scripts/ablate-v2.mjs')).href);
it('isolates each trigger with paired horizons, durable lifecycle and no final forced flush',async()=>{
 const scenarios=experiment.loadScenarios().filter((s:{stratum:string})=>s.stratum!=='original-30');
 const report=await experiment.runAblation(RuntimeStore,{scenarios,repeats:2});
 const row=(scenario:string,variant:string):Row=>report.records.find((r:Row)=>r.scenario===scenario&&r.variant===variant);
 expect(report.modelCalls).toBe(0);expect(report.semanticQualityVerified).toBe(false);expect(report.terminalForcedFlush).toBe(false);
 for(const [scenario,variant] of [['count-burst','no-count'],['byte-single-turn','no-bytes'],['idle-open-tail','no-idle'],['lifecycle-short-tail','no-lifecycle'],['shutdown-restart-tail','no-lifecycle'],['max-wait-high-count','no-max-wait'],['busy-aged-backlog','no-max-wait']]){
  expect(row(scenario!,'baseline').processed).toBeGreaterThan(row(scenario!,variant!).processed);
 }
 expect(row('shutdown-restart-tail','baseline').batches[0]!.atMs).toBe(40000);
 expect(row('continuous-defaults','no-max-wait')).toEqual({...row('continuous-defaults','baseline'),variant:'no-max-wait'});
 expect(row('busy-boundary','baseline').batches[0]!.atMs).toBe(200000);
 expect(row('busy-aged-backlog','baseline').batches[0]!.atMs).toBe(660000);
 expect(row('busy-aged-backlog','no-max-wait').pending).toBe(2);
 for(const r of report.records as Row[])expect(r.batches.every(batch=>batch.entries.length<=6)).toBe(true);
});
it('disabling count keeps 6-turn batch capacity; enqueue wins over simultaneous idle deadline',async()=>{
 const report=await experiment.runAblation(RuntimeStore,{repeats:1,scenarios:[
  {id:'capacity',stratum:'test',turns:Array.from({length:20},()=>({atMs:0})),horizonMs:125000},
  {id:'deadline-tie',stratum:'test',turns:[{atMs:0},{atMs:120000}],horizonMs:120000},
 ]});
 const rows=report.records as Row[];const removed=rows.find(r=>r.scenario==='capacity'&&r.variant==='no-count')!;
 expect(removed.processed).toBe(20);expect(removed.batches.map(b=>b.entries.length)).toEqual([6,6,6,2]);
 expect(rows.find(r=>r.scenario==='deadline-tie'&&r.variant==='baseline')!.pending).toBe(2);
});
it('keeps sensitivity cases separate and rejects invalid repeat counts',async()=>{
 const scenarios=experiment.loadScenarios();expect(scenarios).toHaveLength(40);
 expect(scenarios.filter((s:{stratum:string})=>s.stratum==='original-30')).toHaveLength(30);
 await expect(experiment.runAblation(RuntimeStore,{scenarios:[],repeats:0})).rejects.toThrow();
});
