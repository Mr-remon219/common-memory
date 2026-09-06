import { mkdirSync, lstatSync } from 'node:fs';
import { resolve, join, parse, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
export function safeDirectory(path: string): void {
  const full = resolve(path); let current = parse(full).root;
  for (const part of relative(current, full).split('/').filter(Boolean)) {
    current = join(current, part);
    try { const stat = lstatSync(current); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('UNSAFE_PATH'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; mkdirSync(current, { mode: 0o700 }); }
  }
}
export function withRepositoryLock<T>(dataRoot: string, action: () => T): T {
  const dir = join(resolve(dataRoot), 'runtime'); safeDirectory(dir);
  const path = join(dir, 'repository-lock.sqlite');
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { const stat = lstatSync(path + suffix); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('UNSAFE_LOCK'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const db = new DatabaseSync(path, { timeout: 2000 });
  try { db.exec('PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS lock (id INTEGER PRIMARY KEY); BEGIN IMMEDIATE;'); const value = action(); db.exec('COMMIT'); return value; }
  finally { db.close(); }
}
