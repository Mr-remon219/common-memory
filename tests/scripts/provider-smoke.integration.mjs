// Built-artifact regression, like test:consumer. Uses real local HTTP and the real Writer, never live APIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig } from '../../dist/config/config.js';
const runner=fileURLToPath(new URL('../../scripts/smoke-provider.mjs',import.meta.url));

for (const [api,ignoreMarkdown] of [['responses',false],['chat_completions',false],['chat_completions',true]]) {
  test(`${api}: ${ignoreMarkdown ? 'ignore must fail retention' : 'fixture pipeline passes without becoming live evidence'}`,{timeout:30000},async()=>{
    const home=mkdtempSync(join(tmpdir(),'cm-provider-contract-'));
    const reports=[]; const calls=[];
    const server=createServer(async(req,res)=>{
      let body='';for await(const chunk of req)body+=chunk;
      const wire=JSON.parse(body);calls.push({url:req.url,wire});
      const projection=JSON.parse(api === 'responses' ? wire.input[1].content[0].text : wire.messages[1].content);
      const imported=projection.observations[0],markdown=imported.source_kind === 'document_import';
      const decisions=markdown && ignoreMarkdown ? [{kind:'ignore',applicability:'uncertain',confidence:1,evidence:[imported.ref],reason:'fixture ignore'}] : [{kind:'retain',admission:'remember',lifetime:'until_changed',applicability:'global',confidence:0.6,evidence:[imported.ref],reason:'fixture retained',operations:[{op:'put_section',target:markdown?'preferences':'profile',section:null,title:markdown?'Imported workstation':'Imported background',body:markdown?'Unverified imported document: Fedora Silverblue and fish shell.':'Unverified agent import: a tortoise named Quillon.'}]}];
      const output=JSON.stringify({version:'memory_maintenance_v2',request_id:projection.request_id,decisions});
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify(api==='responses' ? {status:'completed',output:[{type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:output}]}]} : {choices:[{finish_reason:'stop',message:{role:'assistant',content:output}}]}));
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    let child;
    try {
      const config=defaultConfig({COMMON_MEMORY_HOME:home});
      config.remote={provider:'openai-compatible',baseUrl:`http://127.0.0.1:${server.address().port}`,model:'fixture-only',apiKeyEnv:'CM_SMOKE_FIXTURE_KEY',api,proxy:{mode:'direct'},...(api==='responses'?{reasoningEffort:'none'}:{enableThinking:false})};
      mkdirSync(join(config.dataRoot,'memory'),{recursive:true});writeFileSync(join(config.dataRoot,'memory','sentinel.md'),'Keep this source storage unchanged.');
      const path=join(home,'config.json');writeFileSync(path,JSON.stringify(config));
      child=spawn(process.execPath,[runner,'--config',path,'--fixture'],{env:{...process.env,COMMON_MEMORY_HOME:home,CM_SMOKE_FIXTURE_KEY:'private-fixture-key'},stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
      const [code]=await once(child,'close');
      assert.equal(code,ignoreMarkdown ? 1 : 0,stderr+stdout);
      const report=JSON.parse(stdout);reports.push(report);
      assert.match(report.contract.schemaSha256,/^[a-f0-9]{64}$/);assert.match(report.contract.promptSha256,/^[a-f0-9]{64}$/);
      assert.equal(report.evidence,'fixture');assert.equal(report.retentionVerified,false);
      assert.equal(report.passed,!ignoreMarkdown);assert.equal(report.checks.initRetained,true);
      assert.equal(report.checks.markdownRetained,!ignoreMarkdown);
      assert.equal(report.markdownQueue.markdown.complete,true); // A processed ignore still fails retention.
      assert.equal(report.formalMemoryUnchanged,true);assert.equal(report.before.length,1);
      assert.notEqual(report.dataRoot,config.dataRoot);assert.equal(existsSync(join(config.dataRoot,'runtime.sqlite')),false);
      assert.equal(readFileSync(join(config.dataRoot,'memory','sentinel.md'),'utf8'),'Keep this source storage unchanged.');
      assert.equal(stdout.includes('private-fixture-key'),false);
      assert.deepEqual(JSON.parse(readFileSync(report.reportPath,'utf8')),report);
      assert.equal(calls.length,2);
      for(const {url,wire} of calls) {
        assert.equal(url,api==='responses'?'/responses':'/chat/completions');
        assert.equal(wire.model,'fixture-only');
        if(api==='responses'){assert.equal(wire.reasoning.effort,'none');assert.equal(wire.text.format.strict,true);}
        else {assert.equal(wire.response_format.type,'json_object');assert.equal(wire.enable_thinking,false);assert.equal('reasoning' in wire,false);}
      }
    } finally {
      if(child && child.exitCode===null) {child.kill('SIGTERM');await once(child,'close');}
      server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
      for(const report of reports) rmSync(join(report.home,'..'),{recursive:true,force:true});
      rmSync(home,{recursive:true,force:true});
    }
  });
}
