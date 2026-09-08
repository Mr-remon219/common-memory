import { createConfiguredMemoryModel, describeConfiguredNetwork } from '../config/runtime.js';
import type { CommonMemoryConfig } from '../config/config.js';
import { MemoryModelError } from '../memory-manager/contracts/errors.js';
/** Explicit small synthetic API probe. It opens neither the durable queue nor canonical storage. */
export async function runNetworkTest(config: CommonMemoryConfig): Promise<number> {
  let model: ReturnType<typeof createConfiguredMemoryModel> | undefined;
  try {
    console.log(JSON.stringify({network:describeConfiguredNetwork(config),test:'synthetic API request; no memory writes'}));
    model = createConfiguredMemoryModel(config,process.env,{retry:{maxRetries:0}});
    const result = await model.analyze({prompt:'Return exactly the JSON object {"ok":true}.',projection:{probe:'Common Memory connection test; synthetic data only'},schema:{type:'object',properties:{ok:{type:'boolean',enum:[true]}},required:['ok'],additionalProperties:false}}, {requestId:'network-test',deadlineMs:60000});
    const passed = result.kind === 'output' && result.body && typeof result.body === 'object' && 'ok' in result.body && result.body.ok === true;
    console.log(JSON.stringify({passed:Boolean(passed),providerResponded:true,validOutput:Boolean(passed),writerCommitTested:false}));
    return passed ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({passed:false,providerResponded:error instanceof MemoryModelError && error.diagnostic?.httpStatus !== undefined,...(error instanceof MemoryModelError ? {code:error.code,diagnostic:error.diagnostic} : {code:'CONFIGURATION'})}));
    return 1;
  } finally { await model?.close(); }
}
