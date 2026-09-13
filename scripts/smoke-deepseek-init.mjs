#!/usr/bin/env node
// Backward-compatible entry for the already verified DeepSeek configuration and network override.
import { loadConfig } from '../dist/config/config.js';
import { runProviderSmoke } from './smoke-provider.mjs';
const args = process.argv.slice(2);
if (args.length && (args.length !== 1 || args[0] !== '--no-thinking')) {
  console.error('Only --no-thinking is accepted; the endpoint/model are fixed'); process.exitCode = 2;
} else {
  try {
    const config = loadConfig();
    if (!config || new URL(config.remote.baseUrl).hostname !== 'api.deepseek.com') throw new Error('Configure DeepSeek in the TUI first');
    config.remote = {provider:'openai-compatible',api:'responses',baseUrl:'https://api.deepseek.com',model:'deepseek-v4-flash-vision-exp',apiKeyEnv:config.remote.apiKeyEnv,apiKeySource:'private-env',proxy:{mode:'env'},...(args.length ? {reasoningEffort:'none'} : {})};
    const report = await runProviderSmoke({config,evidence:'live',clearNoProxy:true});
    console.log(JSON.stringify(report,null,2)); process.exitCode = report.passed ? 0 : 1;
  } catch { console.error('DeepSeek smoke setup failed; configure DeepSeek and its private .env key in the TUI, and check built artifacts.'); process.exitCode = 2; }
}
