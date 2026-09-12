import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig, saveConfig } from '../../src/config/config.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cm-terminal-startup-'));
  vi.stubEnv('COMMON_MEMORY_HOME', home);
});

it('drains warnings after database opens, lock failures and read-only checks before every prompt kind', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/database-prompts.mjs', import.meta.url))], {
    env: { ...process.env, NODE_OPTIONS: '', NODE_NO_WARNINGS: '', FORCE_COLOR: '1', NO_COLOR: '', TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const kinds = ['initial', 'select', 'multiselect', 'text', 'password', 'confirm'];
  const keys = ['\r', '\r', ' \r', 'synthetic\r', 'synthetic\r', '\r'];
  let output = '', stderr = '', frame = '', step = 0;
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
      child.stderr.on('data', data => { stderr += String(data); });
      child.stdout.on('data', data => {
        output += String(data); frame += String(data);
        if (output.includes('DATABASE_PROMPTS_DONE')) child.stdin.end();
        if (step < kinds.length && stripVTControlCharacters(frame).includes(`PROMPT:${kinds[step]}`) && frame.includes('\x1b[?25l')) {
          const key = keys[step++]!; frame = ''; child.stdin.write(key);
        }
      });
    });
    expect(code, output + stderr).toBe(0);
    expect(step, output).toBe(kinds.length);
    for (const kind of kinds.slice(1)) {
      const warning = output.indexOf(`DATABASE_WARNING:${kind}`), prompt = output.indexOf(`PROMPT:${kind}`);
      expect(warning, output).toBeGreaterThanOrEqual(0);
      expect(output.lastIndexOf('\x1b[?25l', prompt), output).toBeGreaterThan(warning);
    }
    expect(output).toContain('DATABASE_PROMPTS_DONE');
    expect(stderr).toBe('');
  } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill(); }
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it('prints queued startup warnings before rendering the menu, then redraws and exits with arrow/Esc input', async () => {
  const config = defaultConfig(); config.remote.model = 'synthetic'; saveConfig(config);
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: '', NODE_OPTIONS: '', FORCE_COLOR: '1', TERM: 'xterm-256color' };
  delete env.NO_COLOR;
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/terminal-startup.mjs', import.meta.url))], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', stderr = '', step = 0;
  const navigation = [
    { rendered: 'Enter: confirm', key: '\x1b[B' },
    { rendered: '查找、查看与自然语言调整', key: '\x1b[B' },
    { rendered: '查看配置与更换模型', key: '\x1b[A' },
    { rendered: '查找、查看与自然语言调整', key: '\x1b[A' },
    { rendered: '选择需要接入的 Agent', key: '\x1b' },
  ];
  let frame = '';
  const timeout = setTimeout(() => child.kill(), 10_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
      child.stderr.on('data', data => { stderr += String(data); });
      child.stdout.on('data', data => {
        output += String(data); frame += String(data);
        const next = navigation[step];
        // Wait until the warning has actually been delivered, even on the broken
        // ordering, before pressing Down to reproduce the displaced redraw.
        if (next && stripVTControlCharacters(frame).includes(next.rendered) && output.includes('SYNTHETIC_STARTUP_WARNING')) {
          frame = ''; step++; child.stdin.write(next.key);
        }
      });
    });
    expect(code, output + stderr).toBe(0);
    expect(step, output).toBe(navigation.length);
    const warning = output.indexOf('SYNTHETIC_STARTUP_WARNING'), firstPrompt = output.indexOf('\x1b[?25l');
    expect(warning, output).toBeGreaterThanOrEqual(0);
    expect(firstPrompt, output).toBeGreaterThan(warning);
    expect(output.match(/SYNTHETIC_STARTUP_WARNING/gu)).toHaveLength(1);
    expect(output).toContain('Done');
    expect(stderr).toBe('');
    expect(existsSync(config.dataRoot)).toBe(false);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill();
  }
});
