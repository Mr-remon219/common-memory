import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { join, relative, isAbsolute, resolve, sep } from 'node:path';
import { atomicWrite, readRegular, safeDirectory } from './canonical.js';

export interface ProjectRegistration { id: string; name: string; root: string }
export class ProjectRegistry {
  readonly #path: string;
  constructor(dataRoot: string) { safeDirectory(join(dataRoot, 'runtime')); this.#path = join(resolve(dataRoot), 'runtime/projects.json'); }
  list(): ProjectRegistration[] {
    const source = readRegular(this.#path); if (source === null) return [];
    const values: unknown = JSON.parse(source); if (!Array.isArray(values)) throw new Error('Invalid project registry');
    const ids = new Set<string>(); const roots = new Set<string>();
    for (const value of values) {
      if (!value || typeof value !== 'object' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.id) || typeof value.name !== 'string' || !value.name.trim() || typeof value.root !== 'string' || !isAbsolute(value.root) || ids.has(value.id) || roots.has(value.root)) throw new Error('Invalid project registry');
      ids.add(value.id); roots.add(value.root);
    }
    return values as ProjectRegistration[];
  }
  register(root: string, name: string): ProjectRegistration {
    if (!name.trim() || name.length > 256 || /[\r\n\0]/.test(name)) throw new Error('Invalid project name');
    const canonical = realpathSync(root); if (!statSync(canonical).isDirectory()) throw new Error('Project root must be a directory');
    const projects = this.list(); if (projects.some(project => project.root === canonical)) throw new Error('Project root already registered');
    const project = { id: randomUUID(), name: name.trim(), root: canonical }; projects.push(project); atomicWrite(this.#path, JSON.stringify(projects) + '\n'); return project;
  }
  remove(id: string): boolean { const projects = this.list(); const remaining = projects.filter(project => project.id !== id); if (remaining.length === projects.length) return false; atomicWrite(this.#path, JSON.stringify(remaining) + '\n'); return true; }
  resolve(cwd: string): ProjectRegistration | undefined {
    const canonical = realpathSync(cwd);
    return this.list().filter(project => { const child = relative(project.root, canonical); return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)); }).sort((a, b) => b.root.length - a.root.length)[0];
  }
}
