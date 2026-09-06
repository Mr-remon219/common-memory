import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const fixtures=JSON.parse(readFileSync(new URL('../fixtures/v2-trajectories.json',import.meta.url),'utf8'));
const policies=['every-turn','fixed-six','hybrid'];
const real=process.argv.includes('--real');
const scheduleOnly=process.argv.includes('--schedule-only');
const limitArg=process.argv.find(x=>x.startsWith('--limit='));const limit=limitArg?Number(limitArg.split('=')[1]):fixtures.length;
if(!Number.isSafeInteger(limit)||limit<1||limit>30)throw new Error('--limit must be 1..30');
if(real && process.env.COMMON_MEMORY_EVAL_CONFIRM!=='paid-remote-disclosure')throw new Error('Real evaluation requires COMMON_MEMORY_EVAL_CONFIRM=paid-remote-disclosure and configured credentials; synthetic text will be disclosed.');
if(scheduleOnly){console.log(JSON.stringify({fixtures:fixtures.length,policies,categories:[...new Set(fixtures.map(f=>f.category))],semanticQualityVerified:false}));process.exit(0);}
const {Writer,ProjectRegistry,loadConfig,createConfiguredMemoryModel}=await import('../dist/index.js');
let realModel;
if(real){const config=loadConfig();if(!config)throw new Error('Missing configuration');realModel=createConfiguredMemoryModel(config);}
const report={mode:real?'real-opt-in':'scripted-executor',semanticQualityVerified:real,trajectories:limit,results:[]};
let totalCalls=0;
for(const policy of policies){
 const metrics={policy,cases:0,correctFinalState:0,scopeErrors:0,calls:0,inputBytes:0,inputTokens:0,outputTokens:0,tokensMeasured:real,retries:0,failureCodes:{},maxLatencyMs:0,meanLatencyMs:0,outcomes:{}};let latencyTotal=0,consumed=0;
 for(const fixture of fixtures.slice(0,limit)){
  const root=mkdtempSync(join(tmpdir(),'memory-v2-eval-'));let now=0;
  const registry=new ProjectRegistry(root);const project=fixture.target==='project'?registry.register(root,'Evaluation'):null;
  const scope=project?`project:${project.id}`:'global';const target=project?scope:'preferences';
  const model={async analyze(request,options){
   if(++totalCalls>630)throw new Error('Evaluation hard call budget exceeded');
   metrics.calls++;metrics.inputBytes+=Buffer.byteLength(JSON.stringify(request));
   const observations=request.projection.observations;for(const observation of observations){const at=Date.parse(observation.observed_at);const delay=now-at;latencyTotal+=delay;consumed++;metrics.maxLatencyMs=Math.max(metrics.maxLatencyMs,delay);}
   let result;
   if(real)result=await realModel.analyze(request,options);
   else{
    const changes=observations.map(o=>({o,t:fixture.turns.find(t=>t.text===o.text)})).filter(x=>x.t.action!=='ignore');
    const last=changes.at(-1);const doc=request.projection.documents.find(d=>d.target===target);const section=doc.sections.find(s=>s.title==='Current');
    let decision={kind:'ignore',confidence:1,evidence:observations.map(o=>o.ref),reason:'Scripted oracle: no state change'};
    if(last?.t.action==='put')decision={...decision,kind:'retain',admission:'update',lifetime:'until_changed',operations:[{op:'put_section',target,section:section?.ref??null,title:'Current',body:last.t.value+'\n'}]};
    else if(last?.t.action==='forget' && section)decision={...decision,kind:'forget',operations:[{op:'remove_section',target,section:section.ref}]};
    result={kind:'output',body:{version:'memory_maintenance_v2',request_id:options.requestId,decisions:[decision]},usage:{inputTokens:0,outputTokens:0,totalTokens:0}};
   }
   metrics.inputTokens+=result.usage?.inputTokens??0;metrics.outputTokens+=result.usage?.outputTokens??0;return result;
  }};
  const writer=new Writer({dataRoot:root,model,allowedScopes:['global',scope],scheduler:{now:()=>now,turnThreshold:policy==='every-turn'?1:6,byteThreshold:policy==='hybrid'?16384:2147483647,idleMs:policy==='hybrid'?120000:2147483647,maxWaitMs:policy==='hybrid'?600000:2147483647}});
  const run=async force=>{const result=await writer.run({force});metrics.outcomes[result.outcome]=(metrics.outcomes[result.outcome]??0)+1;if(result.outcome==='failed'){metrics.retries++;metrics.failureCodes[result.reason??'unknown']=(metrics.failureCodes[result.reason??'unknown']??0)+1;}return result;};
  try{
   for(let index=0;index<fixture.turns.length;index++){
    const turn=fixture.turns[index];if(policy==='hybrid' && turn.atMs-now>=120000){now+=120000;await run(false);}
    now=turn.atMs;writer.store.enqueue({sessionId:fixture.id,entryId:String(index),text:turn.text,scope,observedAt:new Date(now).toISOString(),source:'interactive'});await run(false);
   }
   now+=policy==='hybrid'?120000:1000;
   for(let i=0;i<10;i++){const outcome=await run(true);if(!['committed','ignored','quarantined'].includes(outcome.outcome))break;}
   const docs=writer.canonical.snapshot(project?[project.id]:[]);const doc=docs.find(d=>d.target===target);const body=doc.sections.map(s=>s.body.trim()).join('\n');
   metrics.cases++;if(body===(fixture.expected??''))metrics.correctFinalState++;
   if(project && docs.filter(d=>d.target!==target).some(d=>d.sections.length))metrics.scopeErrors++;
  }finally{writer.close();rmSync(root,{recursive:true,force:true});}
 }
 metrics.meanLatencyMs=consumed?Math.round(latencyTotal/consumed):0;report.results.push(metrics);
}
console.log(JSON.stringify(report,null,2));
