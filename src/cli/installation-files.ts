import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { fsyncFile, persistDirectory } from '../core/transaction/fsync.js';
import { safeDirectory, withRepositoryLock } from '../v2/lock.js';

export interface FileChange { path: string; before: string | null; after: string | null }
export function assertSafePath(path: string): void {
  if (!isAbsolute(path)) throw new Error('安装路径必须为绝对路径。');
  const full = resolve(path); let part = parse(full).root;
  for (const name of relative(part, full).split(sep).filter(Boolean)) {
    part = join(part, name);
    try {
      const info = lstatSync(part);
      if (info.isSymbolicLink() || part !== full && !info.isDirectory() || info.isFile() && info.nlink !== 1) throw new Error(`不安全的安装路径：${part}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
export function readInstallationFile(path: string): string | null {
  assertSafePath(path);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 16_777_216) throw new Error(`安装文件类型或大小不受支持：${path}`);
    return new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
export function writeInstallationFile(path: string, content: string | null): void {
  assertSafePath(path);
  if (content === null) { rmSync(path, { force: true }); persistDirectory(dirname(path)); return; }
  safeDirectory(dirname(path));
  const temp = join(dirname(path), `.common-memory-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, content, { flag: 'wx', mode: 0o600 }); fsyncFile(temp);
    renameSync(temp, path); persistDirectory(dirname(path));
  } finally { rmSync(temp, { force: true }); }
}
const journalPath = (home: string) => join(home, '.installation', 'transaction.json');

/** All files are compare-before-write. An interrupted multi-file operation rolls back on the next visit. */
export function recoverInstallation(home: string): void {
  const body = readInstallationFile(journalPath(home));
  if (body === null) return;
  const changes: unknown = JSON.parse(body);
  if (!Array.isArray(changes) || changes.length > 100 || !changes.every(c => c && typeof c.path === 'string' && (c.before === null || typeof c.before === 'string') && (c.after === null || typeof c.after === 'string'))) throw new Error('安装恢复记录损坏，未修改文件。');
  for (const change of changes as FileChange[]) {
    const current = readInstallationFile(change.path);
    if (current !== change.before && current !== change.after) throw new Error(`安装恢复遇到外部修改，已保留文件：${change.path}`);
  }
  for (const change of [...changes as FileChange[]].reverse()) {
    if (readInstallationFile(change.path) !== change.before) writeInstallationFile(change.path, change.before);
  }
  writeInstallationFile(journalPath(home), null);
}

/** Read-only fast path: ordinary startup does not create an administrative database. */
export function recoverPendingInstallation(home: string): void {
  if (readInstallationFile(journalPath(home)) !== null) installationTransaction(home, () => {});
}

export function installationTransaction<T>(home: string, action: (commit: (changes: FileChange[]) => void) => T): T {
  // A separate administrative lock: never opens the Memory runtime database.
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return withRepositoryLock(join(home, '.installation'), () => {
    recoverInstallation(home);
    return action(changes => {
      const effective = changes.filter(c => c.before !== c.after);
      if (!effective.length) return;
      if (new Set(effective.map(c => c.path)).size !== effective.length) throw new Error('安装计划包含重复文件。');
      for (const change of effective) if (readInstallationFile(change.path) !== change.before) throw new Error('客户端配置已变化，请重新打开安装页面。');
      writeInstallationFile(journalPath(home), JSON.stringify(effective));
      try {
        for (const change of effective) {
          if (readInstallationFile(change.path) !== change.before) throw new Error('客户端配置已变化，安装已停止。');
          writeInstallationFile(change.path, change.after);
        }
        writeInstallationFile(journalPath(home), null);
      } catch (error) { recoverInstallation(home); throw error; }
    });
  });
}
