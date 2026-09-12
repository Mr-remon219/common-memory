import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { nodeProcess } from '../helpers/node-process.js';

const processes: ReturnType<typeof nodeProcess>[] = [], roots: string[] = [];
afterEach(async () => {
  for (const managed of processes.splice(0)) await managed.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function start(args: string[], timeoutMs?: number) {
  const managed = nodeProcess(args, timeoutMs === undefined ? {} : { timeoutMs });
  processes.push(managed); return managed;
}

it('waits for all child output and retains the deliberate crash exit code', async () => {
  const managed = start(['-e', "process.stdout.write('x'.repeat(131072));process.stderr.write('last diagnostic');process.exitCode=73;"]);
  const result = await managed.result;
  expect(result).toEqual({ code: 73, signal: null, stdout: 'x'.repeat(131072), stderr: 'last diagnostic' });
});

it('reaps a cancelled database-owning child before fixture files can be removed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cm-child-reap-')); roots.push(root);
  const path = join(root, 'runtime.sqlite');
  const managed = start(['--input-type=module', '-e', `
    import { DatabaseSync } from 'node:sqlite';
    const db=new DatabaseSync(${JSON.stringify(path)});
    db.exec('CREATE TABLE marker(id INTEGER); BEGIN IMMEDIATE; INSERT INTO marker VALUES(1)');
    process.stdout.write('ready');setInterval(()=>{},1000);
  `]);
  await once(managed.child.stdout, 'data');
  await managed.stop(); await managed.stop();
  await expect(managed.result).rejects.toThrow('Test cleanup cancelled the Node child');
  const reopened = new DatabaseSync(path, { timeout: 100 });
  try { expect(reopened.prepare('SELECT count(*) AS n FROM marker').get()!.n).toBe(0); }
  finally { reopened.close(); }
  // In particular, Windows must see no live child handle on runtime.sqlite now.
  rmSync(root, { recursive: true });
});

it('reports a child timeout explicitly after termination instead of only a null exit code', async () => {
  const managed = start(['-e', 'setInterval(()=>{},1000)'], 100);
  await expect(managed.result).rejects.toThrow('Node child timed out after 100ms');
  expect(managed.child.exitCode !== null || managed.child.signalCode !== null).toBe(true);
});
