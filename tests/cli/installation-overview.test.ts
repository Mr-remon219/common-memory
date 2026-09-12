import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultConfig } from '../../src/config/config.js';
import { discoverClients, formatBytes, installationOverview, storageBytes } from '../../src/cli/installation-overview.js';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cm-overview-')); vi.stubEnv('COMMON_MEMORY_HOME', home); vi.stubEnv('PATH', ''); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

it('reads missing storage as empty without opening SQLite or creating directories', async () => {
  const config = defaultConfig(); config.remote.model = 'synthetic';
  const body = await installationOverview(config);
  expect(body).toContain(join(config.dataRoot, 'memory')); expect(body).toContain('0 B');
  expect(body).toContain('按需运行'); expect(body).not.toContain('Running');
  expect(existsSync(config.dataRoot)).toBe(false);
});
it('counts canonical and runtime files recursively as logical bytes', async () => {
  mkdirSync(join(home, 'data/memory'), { recursive: true });
  writeFileSync(join(home, 'data/memory/profile.md'), '汉字');
  writeFileSync(join(home, 'data/runtime.sqlite'), Buffer.alloc(1024));
  expect(await storageBytes(join(home, 'data'))).toBe(1030);
  expect(formatBytes(1030)).toBe('1.0 KB'); expect(formatBytes(2.4 * 1024 ** 2)).toBe('2.4 MB');
});
it.skipIf(process.platform === 'win32')('does not follow symlinks when measuring storage', async () => {
  mkdirSync(join(home, 'data')); mkdirSync(join(home, 'elsewhere'));
  writeFileSync(join(home, 'elsewhere/secret'), 'Do not traverse');
  symlinkSync(join(home, 'elsewhere'), join(home, 'data/link'));
  await expect(storageBytes(join(home, 'data'))).rejects.toThrow('符号链接');
  const config = defaultConfig(); config.remote.model = 'synthetic';
  expect(await installationOverview(config)).toContain('无法完整统计');
});
it.skipIf(process.platform === 'win32')('detects executable presence without running a client or claiming a connection', async () => {
  const bin = join(home, 'bin'); mkdirSync(bin);
  const marker = join(home, 'executed');
  writeFileSync(join(bin, 'codex'), `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(join(bin, 'codex'), 0o700);
  writeFileSync(join(bin, 'pi'), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, 'pi'), 0o600);
  const clients = await discoverClients({ env: { PATH: bin }, platform: 'linux' });
  expect(clients.find(c => c.name === 'Codex CLI')).toEqual({ name: 'Codex CLI', detected: true, connection: 'unverified' });
  expect(clients.find(c => c.name === 'Pi')!.detected).toBe(false);
  expect(clients.every(c => c.connection === 'unverified')).toBe(true); expect(existsSync(marker)).toBe(false);
});
it('uses the same Desktop presence probe without inferring installation from WSL alone', async () => {
  mkdirSync(join(home, 'ChatGPT.app'));
  expect((await discoverClients({ env: { PATH: '' }, platform: 'darwin', applications: [home] })).find(c => c.name === 'ChatGPT Desktop')!.detected).toBe(true);
  const wsl = { env: { PATH: '', WSL_DISTRO_NAME: 'Synthetic' }, platform: 'linux' as const, applications: [home] };
  expect((await discoverClients({ ...wsl, windowsHome: () => undefined })).find(c => c.name === 'ChatGPT Desktop')!.detected).toBe(false);
  expect((await discoverClients({ ...wsl, windowsHome: () => home })).find(c => c.name === 'ChatGPT Desktop')).toEqual({ name: 'ChatGPT Desktop', detected: true, connection: 'unverified' });
});
