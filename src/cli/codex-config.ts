import { realpathSync } from 'node:fs';
import { configDirectory } from '../config/config.js';

// POSIX shell quoting is separate from TOML string encoding.
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
export function renderCodexConfig(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== 'linux') throw new Error('codex-config requires Codex and Common Memory in the same Linux environment (including WSL)');
  const command = [realpathSync(process.execPath), realpathSync(process.argv[1]!), 'codex-hook', '--home', configDirectory(env)]
    .map(shellQuote).join(' ');
  // Official command-hook protocol, verified against Codex CLI 0.153.4:
  // https://learn.chatgpt.com/docs/hooks
  return [
    '# Save as <CODEX_HOME>/common-memory.config.toml; merge an existing profile instead of overwriting it.',
    '# Launch: codex --profile common-memory; review and trust these commands using /hooks.',
    '# Regenerate after moving the installation or changing Node/configuration directory.',
    '[features]', 'hooks = true', '',
    ...['SessionStart','UserPromptSubmit','Stop','Interrupt','SessionEnd'].flatMap(event => [
      `[[hooks.${event}]]`,
      `[[hooks.${event}.hooks]]`, 'type = "command"',
      `command = ${JSON.stringify(command)}`,
      'async = false', 'timeout = 3', 'additionalContextLimit = 0', '',
    ]),
  ].join('\n');
}
