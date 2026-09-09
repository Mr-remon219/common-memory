import { renderHostConfig } from './work-config.js';
export function renderCodexConfig(env:NodeJS.ProcessEnv=process.env):string {
  return renderHostConfig('codex',{wsl:false},env).config;
}
