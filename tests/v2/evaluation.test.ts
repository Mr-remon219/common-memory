import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {expect,it} from 'vitest';
it('ships thirty independent synthetic trajectories with update/forget/ignore/scope and policy comparison',()=>{
 const cases=JSON.parse(readFileSync(new URL('../../fixtures/v2-trajectories.json',import.meta.url),'utf8')) as {id:string;category:string;turns:{atMs:number}[]}[];
 expect(cases).toHaveLength(30);expect(new Set(cases.map(c=>c.id)).size).toBe(30);
 for(const c of cases){expect(c.turns).toHaveLength(7);expect(c.turns.map(t=>t.atMs)).toEqual(c.turns.map(t=>t.atMs).sort((a,b)=>a-b));}
 const report=JSON.parse(execFileSync(process.execPath,['scripts/evaluate-v2.mjs','--schedule-only'],{encoding:'utf8'}));
 expect(report.policies).toEqual(['every-turn','fixed-six','hybrid']);expect(report.semanticQualityVerified).toBe(false);
});
