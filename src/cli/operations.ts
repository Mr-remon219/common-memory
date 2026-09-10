import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CommonMemoryConfig } from '../config/config.js';
import { ProjectRegistry } from '../v2/registry.js';
import { withRepositoryLock } from '../v2/lock.js';
import { RuntimeStore } from '../v2/runtime.js';
import { SessionIngress } from '../v2/session.js';
import { readAuthorizedMemory, renderMemoryView } from '../v2/reader.js';

/** CLI and TUI use identical scope selection. Reading never opens the queue. */
export function memoryView(config: CommonMemoryConfig, workspace?: string) {
  const contexts = ['global'];
  if (workspace !== undefined) {
    const project = new ProjectRegistry(config.dataRoot).resolve(workspace);
    if (!project) throw new Error('Workspace is not registered');
    contexts.push(`project:${project.id}`);
  }
  return readAuthorizedMemory({ dataRoot: config.dataRoot, contexts: contexts.filter(scope => config.disclosure.allowedScopes.includes(scope)) });
}

export function showMemory(config: CommonMemoryConfig, workspace?: string, log: (line: string) => void = console.log): void {
  log(`Memory files: ${join(config.dataRoot, 'memory')}`);
  log(renderMemoryView(memoryView(config, workspace)));
}

/** Like the existing status command, opens existing RuntimeStore only; never initializes absent storage. */
export function runtimeStatus(config: CommonMemoryConfig) {
  if (!existsSync(join(config.dataRoot, 'runtime.sqlite'))) return null;
  const store = new RuntimeStore(config.dataRoot);
  try {
    const ingress = new SessionIngress(store, config.sessionCache);
    const sessions = store.db.prepare('SELECT id FROM sessions ORDER BY rowid DESC').all()
      .map(row => ({ id: String(row.id), ...ingress.status(String(row.id)) }));
    return { ...store.status(), sessions };
  } finally { store.close(); }
}

export function retryJob(config: CommonMemoryConfig, id: string): void {
  const store = new RuntimeStore(config.dataRoot);
  try { store.retry(id); store.requestFlush(); } finally { store.close(); }
}

export function listProjects(config: CommonMemoryConfig) { return new ProjectRegistry(config.dataRoot).list(); }
export function registerProject(config: CommonMemoryConfig, root: string, name: string) {
  return withRepositoryLock(config.dataRoot, () => new ProjectRegistry(config.dataRoot).register(root, name));
}
export function removeProject(config: CommonMemoryConfig, id: string): boolean {
  return withRepositoryLock(config.dataRoot, () => new ProjectRegistry(config.dataRoot).remove(id));
}
