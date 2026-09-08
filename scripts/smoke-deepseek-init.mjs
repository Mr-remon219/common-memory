#!/usr/bin/env node
// Backward-compatible entry for the already verified DeepSeek configuration and network override.
import { defaultConfig } from '../dist/config/config.js';
import { runProviderSmoke } from './smoke-provider.mjs';
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--no-thinking')) {
  console.error('Only --no-thinking is accepted; the endpoint/model are fixed'); process.exitCode = 2;
} else {
  const config = defaultConfig();
  config.remote = {provider:'openai-compatible',api:'responses',baseUrl:'https://api.deepseek.com',model:'deepseek-v4-flash-vision-exp',apiKeyEnv:'DEEPSEEK_API_KEY',proxy:{mode:'env'},...(args.length ? {reasoningEffort:'none'} : {})};
  try {
    const report = await runProviderSmoke({config,evidence:'live',clearNoProxy:true});
    console.log(JSON.stringify(report,null,2)); process.exitCode = report.passed ? 0 : 1;
  } catch { console.error('DeepSeek smoke setup failed; check DEEPSEEK_API_KEY and built artifacts.'); process.exitCode = 2; }
}
