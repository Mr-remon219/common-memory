import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { admitDocumentImport, chunkMarkdown, decodeDocumentChunk, documentImportOutcome, MAX_DOCUMENT_BYTES, prepareDocumentImport, readMarkdownFile } from '../../src/v2/document-import.js';
import { isImportSource, provenanceOf } from '../../src/v2/import.js';
import { RuntimeStore } from '../../src/v2/runtime.js';

const roots: string[] = [];
function root() { const p = mkdtempSync(join(tmpdir(), 'cm-doc-')); roots.push(p); return p; }
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const file = (dir: string, name: string, content: string | Buffer) => { const p = join(dir, name); writeFileSync(p, content); return p; };

describe('provenance mapping', () => {
  it('maps every admitted source to one provenance class and nothing else', () => {
    expect(['interactive', 'rpc', 'mcp_user_submission'].map(provenanceOf)).toEqual(['user_explicit', 'user_explicit', 'user_explicit']);
    expect(provenanceOf('agent_import')).toBe('agent_observation');
    expect(provenanceOf('document_import')).toBe('document_import');
    for (const s of ['ambiguous', 'unsupported_content', 'extension', 'user_turn', '']) expect(provenanceOf(s)).toBeNull();
    expect(['agent_import', 'document_import'].every(isImportSource)).toBe(true);
    expect(['interactive', 'rpc', 'mcp_user_submission', 'ambiguous'].some(isImportSource)).toBe(false);
  });
});

describe('structural chunking', () => {
  const doc = [
    '# Notes', '', 'Intro paragraph.', '',
    '## Preferences', '', '> Quoted: "only when reviewing PRs, prefer terse comments"', '',
    '### Examples', '', 'For example, a user might say "always reply in French".', '',
    '```md', '# not a heading', '', '## also not a heading', '```', '',
    '## Constraints', '', 'Only on weekends: Rust practice.', '',
  ].join('\n') + '\n';
  it('keeps a document that fits as one verbatim chunk', () => {
    expect(chunkMarkdown(doc)).toEqual([{ headingPath: [], text: doc }]);
  });
  it('splits at headings only, keeps fences and quotes intact and records the heading path', () => {
    const chunks = chunkMarkdown(doc, 160);
    expect(chunks.map(c => c.text).join('')).toBe(doc); // nothing dropped, nothing reordered
    for (const c of chunks) expect(Buffer.byteLength(c.text)).toBeLessThanOrEqual(160);
    const examples = chunks.find(c => c.text.startsWith('### Examples'))!;
    expect(examples.headingPath).toEqual(['Notes', 'Preferences']);
    expect(examples.text).toContain('```md\n# not a heading\n\n## also not a heading\n```'); // fenced pseudo-headings never split
    expect(chunks.find(c => c.text.startsWith('## Constraints'))!.headingPath).toEqual(['Notes']);
    expect(chunks.some(c => c.text.includes('> Quoted:'))).toBe(true);
  });
  it('splits an oversized section at paragraph boundaries with the section heading as context', () => {
    const big = '# T\n\n## Long\n\n' + Array.from({ length: 6 }, (_, i) => `Paragraph ${i} ${'x'.repeat(60)}\n\n`).join('');
    const chunks = chunkMarkdown(big, 200);
    expect(chunks.map(c => c.text).join('')).toBe(big);
    const tail = chunks.filter(c => !c.text.startsWith('#'));
    expect(tail.length).toBeGreaterThan(0);
    for (const c of tail) expect(c.headingPath).toEqual(['T', 'Long']);
  });
  it('keeps leading and consecutive blank lines, treats inline-backtick lines as text and keeps "# C#" titles', () => {
    const doc = '\n\n# C#\n\n```js``` is inline, not a fence\n\n\n\npara ' + 'x'.repeat(120) + '\n\n\n## Tail\n\ntext\n';
    const chunks = chunkMarkdown(doc, 150);
    expect(chunks.map(c => c.text).join('')).toBe(doc);
    expect(chunks.length).toBeGreaterThan(1); // the inline-backtick line did not swallow the rest as one fence
    expect(chunks.find(c => c.text.startsWith('## Tail'))!.headingPath).toEqual(['C#']);
  });
  it('rejects a single paragraph or fenced block larger than the budget instead of truncating', () => {
    expect(() => chunkMarkdown('# T\n\n' + 'y'.repeat(500) + '\n', 100)).toThrow('IMPORT_CHUNK_TOO_LARGE');
    expect(() => chunkMarkdown('# T\n\n```\n' + 'line\n'.repeat(100) + '```\n', 100)).toThrow('IMPORT_CHUNK_TOO_LARGE');
  });
});

describe('file preprocessing', () => {
  it('reads only regular UTF-8 Markdown files within the size cap', () => {
    const dir = root();
    expect(() => readMarkdownFile(join(dir, 'missing.md'))).toThrow('FILE_NOT_FOUND');
    expect(() => readMarkdownFile(file(dir, 'notes.txt', '# x\n'))).toThrow('UNSUPPORTED_FILE_TYPE');
    expect(() => readMarkdownFile(file(dir, 'empty.md', '\n\n  \n'))).toThrow('EMPTY_DOCUMENT');
    expect(() => readMarkdownFile(file(dir, 'binary.md', Buffer.from([0xff, 0xfe, 0x00, 0x41])))).toThrow('INVALID_ENCODING');
    expect(() => readMarkdownFile(file(dir, 'nul.md', 'a\0b'))).toThrow('INVALID_ENCODING');
    expect(() => readMarkdownFile(file(dir, 'huge.md', 'a'.repeat(MAX_DOCUMENT_BYTES + 1)))).toThrow('DOCUMENT_TOO_LARGE');
    file(dir, 'target.md', '# ok\n'); symlinkSync(join(dir, 'target.md'), join(dir, 'link.md'));
    expect(() => readMarkdownFile(join(dir, 'link.md'))).toThrow('UNSUPPORTED_FILE_TYPE');
    expect(readMarkdownFile(file(dir, 'crlf.md', '\uFEFF# Title\r\n\r\nBody\r\n'))).toMatchObject({ fileName: 'crlf.md', text: '# Title\n\nBody\n' });
  });
  it('identifies an import by content, not by name, and rejects policy-violating content before queuing', () => {
    const dir = root();
    const a = prepareDocumentImport(file(dir, 'a.md', '# Notes\n\nKeeps a tortoise named Basalt.\n'));
    const b = prepareDocumentImport(file(dir, 'b.md', '# Notes\n\nKeeps a tortoise named Basalt.\n'));
    const c = prepareDocumentImport(file(dir, 'a2.md', '# Notes\n\nKeeps a tortoise named Granite.\n'));
    expect(a.importId).toBe(b.importId); expect(a.importId).not.toBe(c.importId);
    expect(a).toMatchObject({ fileName: 'a.md', sourceLabel: 'a.md', declaredAuthor: 'unknown' });
    expect(decodeDocumentChunk(a.chunks[0]!.text)).toMatchObject({ importId: a.importId, fileName: 'a.md', part: { index: 1, count: 1 }, headingPath: [], text: '# Notes\n\nKeeps a tortoise named Basalt.\n' });
    expect(() => prepareDocumentImport(file(dir, 'secret.md', '# Env\n\napi_key = sk-proj-abcdefghijklmnopqrstuvwxyz\n'))).toThrow(/SENSITIVE_CONTENT_REJECTED part 1\/1: .*secret/);
    expect(() => prepareDocumentImport(join(dir, 'a.md'), { label: 'bad\nlabel' })).toThrow('INVALID_IMPORT_LABEL');
    expect(prepareDocumentImport(join(dir, 'a.md'), { label: 'my old AGENTS.md', author: 'agent' })).toMatchObject({ sourceLabel: 'my old AGENTS.md', declaredAuthor: 'agent' });
  });
});

describe('admission and outcome', () => {
  it('rolls back an interrupted multi-part admission and accepts the complete retry after reopening', () => {
    const dir = root();
    const prepared = prepareDocumentImport(file(dir, 'parts.md', '# Notes\n\n' + Array.from({ length: 3 }, (_, i) => `## Part ${i}\n\n${'x'.repeat(20000)}\n\n`).join('')));
    expect(prepared.chunks.length).toBeGreaterThan(1);
    const store = new RuntimeStore(dir);
    const enqueue = store.enqueue.bind(store);
    let calls = 0;
    const failure = vi.spyOn(store, 'enqueue').mockImplementation(input => {
      const result = enqueue(input);
      if (++calls === 2) throw new Error('Synthetic storage failure after second insert');
      return result;
    });
    try {
      expect(() => admitDocumentImport(store, prepared, 'global')).toThrow('Synthetic storage failure');
      expect(calls).toBe(2);
      expect(store.db.prepare('SELECT COUNT(*) AS n FROM observations').get()!.n).toBe(0);
      expect(store.claim({ force: true })).toBeNull();
    } finally { failure.mockRestore(); store.close(); }
    const reopened = new RuntimeStore(dir);
    try {
      expect(admitDocumentImport(reopened, prepared, 'global')).toEqual({ importId: prepared.importId, duplicate: false, parts: prepared.chunks.length });
      const job = reopened.claim()!;
      expect(job.observations.map(o => o.entryId)).toEqual(prepared.chunks.map(c => c.entryId));
      expect(job.observations.map(o => o.text)).toEqual(prepared.chunks.map(c => c.text));
      reopened.finish(job);
      expect(documentImportOutcome(reopened, prepared.importId, 'global', prepared.chunks.length).complete).toBe(true);
      expect(admitDocumentImport(reopened, prepared, 'global').duplicate).toBe(true);
      expect(reopened.claim({ force: true })).toBeNull();
    } finally { reopened.close(); }
  });
  it('queues all parts atomically, deduplicates identical content regardless of name or label, separates scopes', () => {
    const dir = root(); const store = new RuntimeStore(dir, { turnThreshold: 6 });
    try {
      const long = '# Doc\n\n' + Array.from({ length: 4 }, (_, i) => `## S${i}\n\n${'z'.repeat(20000)}\n\n`).join('');
      const prepared = prepareDocumentImport(file(dir, 'doc.md', long));
      expect(prepared.chunks.length).toBeGreaterThan(1);
      expect(admitDocumentImport(store, prepared, 'global')).toEqual({ importId: prepared.importId, duplicate: false, parts: prepared.chunks.length });
      expect(store.pending().map(o => [o.source, o.scope, o.state])).toEqual(prepared.chunks.map(() => ['document_import', 'global', 'pending']));
      expect(admitDocumentImport(store, prepared, 'global')).toMatchObject({ duplicate: true });
      expect(store.pending()).toHaveLength(prepared.chunks.length);
      // Same bytes, other name and declared author: the same material, so nothing new is queued and the original metadata stays.
      const relabelled = prepareDocumentImport(file(dir, 'renamed.md', long), { author: 'user' });
      expect(relabelled.importId).toBe(prepared.importId);
      expect(admitDocumentImport(store, relabelled, 'global')).toMatchObject({ duplicate: true });
      expect(store.pending()).toHaveLength(prepared.chunks.length);
      expect(decodeDocumentChunk(store.pending()[0]!.text!)).toMatchObject({ fileName: 'doc.md', declaredAuthor: 'unknown' });
      expect(admitDocumentImport(store, prepared, 'project:p')).toMatchObject({ duplicate: false });
      // Flush was requested: below the turn threshold the head is claimable; a batch never mixes scopes.
      const job = store.claim()!; expect(new Set(job.observations.map(o => o.scope)).size).toBe(1);
      const outcome = documentImportOutcome(store, prepared.importId, 'global', prepared.chunks.length);
      expect(outcome.complete).toBe(false);
      expect(outcome.parts.map(p => p.state)).toContain('claimed');
      store.finish(job);
      const later = documentImportOutcome(store, prepared.importId, 'global', prepared.chunks.length);
      // Only the claimed global parts were finished; parts of the same import that were not in that batch stay pending.
      expect(later.parts.filter(p => p.state === 'processed')).toHaveLength(job.observations.length);
      expect(later.complete).toBe(job.observations.length === prepared.chunks.length);
      for (;;) { const next = store.claim({ force: true }); if (!next) break; store.finish(next); }
      expect(documentImportOutcome(store, prepared.importId, 'global', prepared.chunks.length).complete).toBe(true);
    } finally { store.close(); }
  });
  it('a batch never mixes imported documents with agent summaries or user turns', () => {
    const dir = root(); const store = new RuntimeStore(dir, { turnThreshold: 6 });
    try {
      const at = new Date().toISOString();
      store.enqueue({ sessionId: 'a', entryId: '1', text: 'user', scope: 'global', source: 'interactive', observedAt: at });
      store.enqueue({ sessionId: 'b', entryId: '1', text: '{}', scope: 'global', source: 'agent_import', observedAt: at });
      store.enqueue({ sessionId: 'c', entryId: '1', text: '{}', scope: 'global', source: 'document_import', observedAt: at });
      store.enqueue({ sessionId: 'd', entryId: '1', text: '{}', scope: 'global', source: 'document_import', observedAt: at });
      store.enqueue({ sessionId: 'e', entryId: '1', text: 'user2', scope: 'global', source: 'rpc', observedAt: at });
      const sizes: string[][] = [];
      for (;;) { const job = store.claim({ force: true }); if (!job) break; sizes.push(job.observations.map(o => o.source)); store.finish(job); }
      expect(sizes).toEqual([['interactive'], ['agent_import'], ['document_import', 'document_import'], ['rpc']]);
    } finally { store.close(); }
  });
});
