import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

// Import the developer script without executing its CLI or requiring a pre-existing dist build.
const {parseSmokeArgs,retentionChecks} = await import(pathToFileURL(resolve('scripts/smoke-provider.mjs')).href);
function retained() {
  const init={state:'processed',retainedIn:['profile'],jobId:'init-job'};
  const part={state:'processed',retainedIn:['preferences'],jobId:'markdown-job'};
  return {init,initQueue:{receipts:['init-job'],fileReceiptIds:['init-job']},markdownExitCode:0,
    markdownQueue:{markdown:{complete:true,parts:[part]},receipts:['init-job','markdown-job'],fileReceiptIds:['init-job','markdown-job']},
    dataRoot:'isolated-store',markdownDataRoot:'isolated-store',initRead:{hasQuillon:true},
    markdownRead:{hasQuillon:true,hasFedora:true,hasFish:true,empty:false},formalMemoryUnchanged:true};
}
it('requires an explicit evidence source and keeps bypass inheritance by default',()=>{
  expect(parseSmokeArgs(['--config','provider.json','--live'])).toEqual({path:'provider.json',evidence:'live',clearNoProxy:false});
  expect(parseSmokeArgs(['--fixture','--config','provider.json','--clear-no-proxy'])).toEqual({path:'provider.json',evidence:'fixture',clearNoProxy:true});
});
it.each([[],['--config','x'],['--live'],['--config','--live'],['--config','x','--live','--fixture'],['--config','x','--live','--model','fallback'],['--config','x','--live','--extra-body','{}'],['--config','x','--live','--config','y'],['--config','x','--live','--clear-no-proxy','--clear-no-proxy']].map(args=>({args})))('rejects incomplete, duplicate or passthrough options %j',({args})=>{
  expect(()=>parseSmokeArgs(args)).toThrow();
});
it('requires the complete source-linked receipt and restarted-read chain',()=>{
  expect(Object.values(retentionChecks(retained()))).toEqual([true,true,true,true,true,true]);
  expect(Object.values(retentionChecks({}))).toContain(false);
});
it('ignore is processed but cannot be counted as retained, even with a DB receipt',()=>{
  const report=retained();report.markdownQueue.markdown.parts[0]!.retainedIn=[];
  expect(retentionChecks(report).markdownRetained).toBe(false);
  report.init.retainedIn=[];expect(retentionChecks(report).initRetained).toBe(false);
});
it('unrelated receipts or done states cannot satisfy the source job',()=>{
  const report=retained();report.markdownQueue.fileReceiptIds=['init-job','unrelated-job'];
  expect(retentionChecks(report).markdownRetained).toBe(false);
  report.markdownQueue.fileReceiptIds=['init-job','markdown-job'];report.markdownQueue.receipts=['init-job'];
  expect(retentionChecks(report).markdownRetained).toBe(false);
  report.init.state='done';expect(retentionChecks(report).initRetained).toBe(false);
});
it('partial imports, separate stores, missing markers or changed personal memory cannot pass',()=>{
  const report=retained();report.markdownQueue.markdown.complete=false;
  expect(retentionChecks(report).markdownRetained).toBe(false);
  report.markdownDataRoot='separate';expect(retentionChecks(report).sameStore).toBe(false);
  report.markdownRead.hasFish=false;expect(retentionChecks(report).restartRead).toBe(false);
  report.formalMemoryUnchanged=false;expect(retentionChecks(report).formalMemoryUnchanged).toBe(false);
  expect(retentionChecks({...retained(),failedStep:'restart-read'}).completed).toBe(false);
});
