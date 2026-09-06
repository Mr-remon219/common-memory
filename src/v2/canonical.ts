import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface Section { ref: string; title: string; body: string }
export interface DocumentSnapshot { target: string; path: string; content: string; hash: string; sections: Section[] }
export interface SectionOperation { op: 'put_section' | 'remove_section'; target: string; section: string | null; title?: string; body?: string }
interface ParsedSection extends Section { start: number; end: number }
interface Journal { id: string; files: { path: string; before: string; after: string; stage: string }[] }
export function digest(content: string): string { return createHash('sha256').update(content).digest('hex'); }
export function syncDirectory(path: string): void { if (process.platform === 'win32') return; const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
/** Reject symlinks in every existing ancestor, including the configured root. */
export function safeDirectory(path: string): void {
  const absolute = resolve(path); const parent = dirname(absolute);
  if (parent !== absolute) safeDirectory(parent);
  if (!existsSync(absolute)) { try { mkdirSync(absolute, { mode: 0o700 }); syncDirectory(parent); } catch (error) { if (!existsSync(absolute)) throw error; } }
  const stat = lstatSync(absolute); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe directory');
}
export function readRegular(path: string): string | null {
  safeDirectory(dirname(path));
  try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('Unsafe file'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('Unsafe file'); return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
}
export function atomicWrite(path: string, content: string): void {
  readRegular(path); const temporary = join(dirname(path), `.write-${randomUUID()}`); const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path); syncDirectory(dirname(path));
}
function hashFile(path: string): string { const content = readRegular(path); return content === null ? 'missing' : digest(content); }
function parse(content: string, expectedTitle: string, hardLimitBytes: number): ParsedSection[] {
  if (Buffer.byteLength(content) > hardLimitBytes) throw new Error('Document hard limit exceeded');
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? []; let offset = 0; let fence: { char: string; size: number } | undefined; let h1 = false;
  const sections: ParsedSection[] = []; const titles = new Set<string>();
  for (const line of lines) {
    const text = line.replace(/\r?\n$/, ''); const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
    if (marker) { const token = marker[1]!; if (!fence) fence = { char: token[0]!, size: token.length }; else if (token[0] === fence.char && token.length >= fence.size && !marker[2]!.trim()) fence = undefined; offset += line.length; continue; }
    if (!fence) {
      if (/^ {0,3}#(?:\s|$)/.test(text)) { if (h1 || offset !== 0 || text !== `# ${expectedTitle}`) throw new Error('Invalid document H1'); h1 = true; }
      else if (/^ {0,3}##(?:\s|$)/.test(text)) {
        const match = /^## ([^\r\n]+)$/.exec(text); const title = match?.[1]; if (!h1 || !title || title.trim() !== title || titles.has(title)) throw new Error('Invalid or duplicate section');
        titles.add(title); if (sections.length) sections.at(-1)!.end = offset;
        sections.push({ ref: `s${sections.length + 1}`, title, body: '', start: offset, end: content.length });
      } else if (!sections.length && text.trim()) throw new Error('Content outside sections');
      else if (/^ {0,3}(?:=+|-+)\s*$/.test(text) && text.trim().length > 0 && sections.length) throw new Error('Setext headings are not supported');
    }
    offset += line.length;
  }
  if (!h1 || fence) throw new Error('Invalid Markdown structure');
  for (const section of sections) { const newline = content.indexOf('\n', section.start); section.body = newline < 0 ? '' : content.slice(newline + 1, section.end); }
  return sections;
}
function targetInfo(target: string): { relative: string; title: string } {
  if (target === 'profile') return { relative: 'memory/profile.md', title: 'Profile' };
  if (target === 'preferences') return { relative: 'memory/preferences.md', title: 'Preferences' };
  const match = /^project:([A-Za-z0-9_-]{1,128})$/.exec(target); if (!match) throw new Error('Invalid target');
  return { relative: `memory/projects/${match[1]}.md`, title: 'Project' };
}
export interface CanonicalStoreOptions { hardLimitBytes?: number; checkpoint?: (phase: string) => void }
export class CanonicalStore {
  readonly root: string;
  readonly hardLimitBytes: number;
  readonly #checkpoint: (phase: string) => void;
  constructor(dataRoot: string, options: CanonicalStoreOptions = {}) { this.hardLimitBytes = options.hardLimitBytes ?? 16384; if (!Number.isSafeInteger(this.hardLimitBytes) || this.hardLimitBytes < 64 || this.hardLimitBytes > 1048576) throw new Error('Invalid document limit'); this.#checkpoint = options.checkpoint ?? (() => {}); this.root = resolve(dataRoot); safeDirectory(this.root); for (const path of ['memory/projects', 'runtime/receipts', 'runtime/transactions']) safeDirectory(join(this.root, path)); }
  snapshot(projectIds: string[] = []): DocumentSnapshot[] {
    return [...new Set(['profile', 'preferences', ...projectIds.map(id => `project:${id}`)])].map(target => {
      const info = targetInfo(target); const path = join(this.root, info.relative); const raw = readRegular(path); const content = raw ?? `# ${info.title}\n\n`;
      return { target, path, content, hash: raw === null ? 'missing' : digest(raw), sections: parse(content, info.title, this.hardLimitBytes).map(({ ref, title, body }) => ({ ref, title, body })) };
    });
  }
  apply(snapshot: DocumentSnapshot[], operations: SectionOperation[]): Map<string, string> {
    const updates = new Map<string, string>(); const grouped = new Map<string, SectionOperation[]>();
    for (const operation of operations) { if (!snapshot.some(doc => doc.target === operation.target)) throw new Error('Unauthorized target'); const group = grouped.get(operation.target) ?? []; group.push(operation); grouped.set(operation.target, group); }
    for (const [target, group] of grouped) {
      const doc = snapshot.find(item => item.target === target)!; const info = targetInfo(target); const sections = parse(doc.content, info.title, this.hardLimitBytes); const edits: { start: number; end: number; text: string }[] = []; const touched = new Set<string>(); let appended = '';
      for (const operation of group) {
        const section = operation.section === null ? undefined : sections.find(item => item.ref === operation.section);
        if (operation.section !== null && (!section || touched.has(operation.section))) throw new Error('Invalid or duplicate section reference'); if (section) touched.add(section.ref);
        if (operation.op === 'remove_section') { if (!section) throw new Error('Removal requires section'); edits.push({ start: section.start, end: section.end, text: '' }); }
        else if (operation.op === 'put_section') {
          const { title, body } = operation; if (!title || title.trim() !== title || /[\r\n]/.test(title) || body === undefined) throw new Error('Invalid section payload');
          const text = `## ${title}\n${body}${body.endsWith('\n') ? '' : '\n'}`;
          const validation = parse(`# ${info.title}\n\n${text}`, info.title, this.hardLimitBytes); if (validation.length !== 1) throw new Error('Undeclared section in body');
          if (section) edits.push({ start: section.start, end: section.end, text }); else appended += text;
        } else throw new Error('Invalid operation');
      }
      let result = doc.content; for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
      if (appended) result += (result.endsWith('\n') ? '' : '\n') + appended;
      parse(result, info.title, this.hardLimitBytes); updates.set(target, result);
    }
    return updates;
  }
  commit(snapshot: DocumentSnapshot[], updates: Map<string, string>, receipt: { id: string; [key: string]: unknown }, beforePublish: () => void = () => {}): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(receipt.id)) throw new Error('Invalid receipt id');
    this.recover();
    for (const doc of snapshot) { const path = join(this.root, targetInfo(doc.target).relative); if (doc.path !== path || hashFile(path) !== doc.hash) throw new Error('STALE_REVISION'); }
    const receiptPath = `runtime/receipts/${receipt.id}.json`; if (readRegular(join(this.root, receiptPath)) !== null) throw new Error('Receipt already committed');
    const files: { path: string; content: string }[] = [];
    for (const [target, content] of updates) { if (!snapshot.some(doc => doc.target === target)) throw new Error('Unauthorized target'); const info = targetInfo(target); parse(content, info.title, this.hardLimitBytes); files.push({ path: info.relative, content }); }
    files.push({ path: receiptPath, content: JSON.stringify(receipt) + '\n' });
    const id = randomUUID(); const directory = join(this.root, 'runtime/transactions', id); safeDirectory(directory);
    const journal: Journal = { id, files: files.map((file, index) => { const stage = `stage-${index}`; atomicWrite(join(directory, stage), file.content); return { path: file.path, stage, before: snapshot.find(doc => targetInfo(doc.target).relative === file.path)?.hash ?? 'missing', after: digest(file.content) }; }) };
    atomicWrite(join(directory, 'journal.json'), JSON.stringify(journal)); this.#checkpoint('staged');
    for (const doc of snapshot) if (hashFile(doc.path) !== doc.hash) throw new Error('STALE_REVISION');
    beforePublish();
    atomicWrite(join(directory, 'COMMITTING'), 'v2\n'); this.#checkpoint('commit-marker'); this.recover();
  }
  recover(): void {
    const root = join(this.root, 'runtime/transactions'); safeDirectory(root);
    for (const id of readdirSync(root)) {
      if (/^done\.[a-f0-9-]{36}$/.test(id)) { const completed = join(root, id); safeDirectory(completed); rmSync(completed, { recursive: true }); syncDirectory(root); continue; }
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Unsafe transaction identity'); const directory = join(root, id); safeDirectory(directory);
      const marker = readRegular(join(directory, 'COMMITTING'));
      if (marker === null) { rmSync(directory, { recursive: true }); syncDirectory(root); continue; }
      if (marker !== 'v2\n') throw new Error('Invalid commit marker');
      const journal = JSON.parse(readRegular(join(directory, 'journal.json')) ?? 'null') as Journal;
      if (!journal || journal.id !== id || !Array.isArray(journal.files) || !journal.files.length) throw new Error('Invalid transaction');
      const paths = new Set<string>();
      for (const file of journal.files) {
        if (!file || typeof file.path !== 'string' || typeof file.stage !== 'string' || !/^(?:missing|[a-f0-9]{64})$/.test(file.before) || !/^[a-f0-9]{64}$/.test(file.after) || !/^(?:memory\/(?:profile|preferences)\.md|memory\/projects\/[A-Za-z0-9_-]{1,128}\.md|runtime\/receipts\/[A-Za-z0-9_-]{1,128}\.json)$/.test(file.path) || !/^stage-\d+$/.test(file.stage) || paths.has(file.path)) throw new Error('Unsafe transaction path'); paths.add(file.path);
        const staged = readRegular(join(directory, file.stage)); if (staged === null || digest(staged) !== file.after) throw new Error('Corrupt transaction');
        const current = hashFile(join(this.root, file.path)); if (current !== file.before && current !== file.after) throw new Error('Recovery conflict: external modification');
      }
      for (const file of journal.files) { const path = join(this.root, file.path); if (hashFile(path) !== file.after) { atomicWrite(path, readRegular(join(directory, file.stage))!); this.#checkpoint(`target:${file.path}`); } }
      this.#checkpoint('before-cleanup');
      const completed = join(root, `done.${id}`); renameSync(directory, completed); syncDirectory(root); rmSync(completed, { recursive: true }); syncDirectory(root);
    }
  }
  receipts(): { id: string; [key: string]: unknown }[] {
    const root = join(this.root, 'runtime/receipts'); safeDirectory(root);
    return readdirSync(root).map(name => { if (!/^[A-Za-z0-9_-]{1,128}\.json$/.test(name)) throw new Error('Unsafe receipt'); const value = JSON.parse(readRegular(join(root, name))!) as { id: string }; if (value.id !== name.slice(0, -5)) throw new Error('Invalid receipt'); return value; });
  }
}
