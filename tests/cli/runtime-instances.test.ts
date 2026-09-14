import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { listRuntimeInstances, registerRuntimeInstance } from '../../src/cli/runtime-instances.js';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
function fixture(): { home: string; proc: string } {
  root = mkdtempSync(join(tmpdir(), 'cm-runtime-instances-'));
  const home = join(root, 'home'), proc = join(root, 'proc');
  mkdirSync(home, { recursive: true }); mkdirSync(join(proc,'sys/kernel/random'),{recursive:true});
  writeFileSync(join(proc,'sys/kernel/random/boot_id'),'00000000-0000-0000-0000-000000000001');
  return { home, proc };
}
function procProcess(proc: string, pid: number, command: string[], startTime = '1234'): void {
  const directory = join(proc, String(pid)); mkdirSync(directory);
  writeFileSync(join(directory, 'cmdline'), Buffer.from(command.join('\0') + '\0'));
  writeFileSync(join(directory, 'stat'), `${pid} (node) S ${Array.from({ length: 18 }, () => '1').join(' ')} ${startTime} 1 1\n`);
}

it('registers an exact loaded version/path and distinguishes an unregistered live old process', () => {
  const { home, proc } = fixture();
  procProcess(proc, 200, ['/usr/bin/node', '/opt/common-memory-core/dist/cli/main.js', 'mcp']);
  registerRuntimeInstance({ home, role: 'mcp', version: '0.4.1', pid: 200, procRoot:proc, platform:'linux', executable: '/usr/bin/node', cli: '/opt/common-memory-core/dist/cli/main.js' });
  procProcess(proc, 201, ['/usr/bin/node', '/old/common-memory-core/dist/cli/main.js', 'mcp'], '999');
  const rows = listRuntimeInstances({ home, procRoot: proc, platform: 'linux' });
  expect(rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ pid: 200, role: 'mcp', version: '0.4.1', cli: '/opt/common-memory-core/dist/cli/main.js', status: 'loaded' }),
    expect.objectContaining({ pid: 201, role: 'unknown', version: 'unknown', cli: '/old/common-memory-core/dist/cli/main.js', status: 'unregistered' }),
  ]));
  expect(readFileSync(join(home, '.installation/instances',readdirSync(join(home,'.installation/instances'))[0]!), 'utf8')).toContain('0.4.1');
});

it('never claims an unknown-platform registration proves a running process',()=>{
 const {home}=fixture();registerRuntimeInstance({home,role:'pi',version:'0.4.1',pid:300,platform:'darwin',executable:'/usr/bin/node',cli:'/synthetic/pi.js'});
 expect(listRuntimeInstances({home,platform:'darwin'})[0]!.status).toBe('unknown');
});
it('marks a stale registration stale instead of claiming it is loaded', () => {
  const { home, proc } = fixture();
  registerRuntimeInstance({ home, role: 'pi', version: '0.4.1', pid: 300, started: '77', executable: '/usr/bin/pi', cli: '/opt/common-memory-core/dist/pi-extension/index.js' });
  expect(listRuntimeInstances({ home, procRoot: proc, platform: 'linux' })).toEqual([
    expect.objectContaining({ pid: 300, role: 'pi', version: '0.4.1', status: 'stale' }),
  ]);
});
