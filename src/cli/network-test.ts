import { probeMemoryAgent } from '../v2/connection-probe.js';
import { createConfiguredMemoryAgent, describeConfiguredNetwork } from '../config/runtime.js';
import type { CommonMemoryConfig } from '../config/config.js';
import { MemoryModelError } from '../core/contracts/errors.js';
/** Explicit small synthetic API probe. It opens neither the durable queue nor canonical storage. */
export async function runNetworkTest(config: CommonMemoryConfig, log: (line: string) => void = console.log): Promise<number> {
  let model: ReturnType<typeof createConfiguredMemoryAgent> | undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
  try {
    log(JSON.stringify({network:describeConfiguredNetwork(config),test:'synthetic API request; no memory writes'}));
    model = createConfiguredMemoryAgent(config,process.env,{maxRetries:0});
    const passed = await probeMemoryAgent(model, controller.signal);
    log(JSON.stringify({passed:Boolean(passed),providerResponded:true,validOutput:Boolean(passed),writerCommitTested:false}));
    return passed ? 0 : 1;
  } catch (error) {
    log(JSON.stringify({passed:false,providerResponded:error instanceof MemoryModelError && error.diagnostic?.httpStatus !== undefined,...(error instanceof MemoryModelError ? {code:error.code,diagnostic:error.diagnostic} : {code:'CONFIGURATION'})}));
    return 1;
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); await model?.close(); }
}
