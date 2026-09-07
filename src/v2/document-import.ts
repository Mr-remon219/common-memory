import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { externalPreflight } from '../core/safety/external-preflight.js';
import { DOCUMENT_IMPORT_SOURCE } from './import.js';
import type { RuntimeStore } from './runtime.js';

/**
 * Input preprocessing for a user-chosen local Markdown file. It reads, validates, and splits the
 * material into structural chunks that the unchanged Writer receives as `document_import`
 * observations. It never decides what is worth remembering, never summarizes, never strips
 * headings, quotes, qualifiers or code, and never executes or follows anything in the file.
 */
export const DOCUMENT_AUTHORS = ['user', 'agent', 'third_party', 'mixed', 'unknown'] as const;
export type DocumentAuthor = typeof DOCUMENT_AUTHORS[number];
/** One chunk must fit the same per-item budget as an Init understanding; the Writer request cap still applies. */
export const MAX_DOCUMENT_CHUNK_BYTES = 32768;
/** Whole-file cap for the first version: larger files are rejected up front, never truncated. */
export const MAX_DOCUMENT_BYTES = 262144;
export const DOCUMENT_EXTENSIONS = ['.md', '.markdown'] as const;
/** A display label: any printable text up to 64 characters, no control characters, not blank. */
const LABEL = /^(?=.*\S)[^\p{C}]{1,64}$/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
/** Queue-key format of the chunk envelope; a change in chunking rules starts a new import rather than a stuck resume. */
export const DOCUMENT_IMPORT_FORMAT = 'v1';

export interface MarkdownChunk { headingPath: string[]; text: string }
export interface DocumentImportChunk {
  importId: string; sourceLabel: string; declaredAuthor: DocumentAuthor; fileName: string; contentDigest: string;
  part: { index: number; count: number }; headingPath: string[]; text: string;
}
export interface PreparedDocumentImport {
  importId: string; fileName: string; bytes: number; contentDigest: string; sourceLabel: string; declaredAuthor: DocumentAuthor;
  chunks: { entryId: string; text: string; headingPath: string[]; bytes: number }[];
}

/** Read one regular Markdown file: no symlinks, no directories, strict UTF-8, bounded size. */
export function readMarkdownFile(path: string): { path: string; fileName: string; text: string; bytes: number } {
  const absolute = resolve(path);
  if (!DOCUMENT_EXTENSIONS.includes(extname(absolute).toLowerCase() as typeof DOCUMENT_EXTENSIONS[number])) throw new Error('UNSUPPORTED_FILE_TYPE');
  let stat; try { stat = lstatSync(absolute); } catch { throw new Error('FILE_NOT_FOUND'); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('UNSUPPORTED_FILE_TYPE');
  if (stat.size > MAX_DOCUMENT_BYTES) throw new Error('DOCUMENT_TOO_LARGE');
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: Buffer;
  try { if (!fstatSync(fd).isFile()) throw new Error('UNSUPPORTED_FILE_TYPE'); raw = readFileSync(fd); } finally { closeSync(fd); }
  if (raw.byteLength > MAX_DOCUMENT_BYTES) throw new Error('DOCUMENT_TOO_LARGE');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw); } catch { throw new Error('INVALID_ENCODING'); }
  if (text.includes('\0')) throw new Error('INVALID_ENCODING');
  text = text.replaceAll('\r\n', '\n');
  if (!text.trim()) throw new Error('EMPTY_DOCUMENT');
  return { path: absolute, fileName: basename(absolute), text, bytes: Buffer.byteLength(text) };
}

/**
 * Split at Markdown structure only. A chunk is a run of whole paragraphs; headings start new units,
 * fenced code is never split, blank lines inside fences are not boundaries. Sections stay whole when
 * they fit. `headingPath` is the ancestor heading stack at the chunk start, so a chunk that begins
 * under "## Examples" still says so. One unit larger than the budget rejects the whole import.
 */
export function chunkMarkdown(text: string, budget = MAX_DOCUMENT_CHUNK_BYTES): MarkdownChunk[] {
  if (Buffer.byteLength(text) <= budget) return [{ headingPath: [], text }];
  interface Unit { headingPath: string[]; text: string; heading: boolean }
  const units: Unit[] = [];
  const stack: { level: number; title: string }[] = [];
  let fence: { char: string; size: number } | undefined;
  let current: Unit | undefined;
  const close = () => { if (current && current.text) units.push(current); current = undefined; };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const plain = line.replace(/\n$/, '');
    // A backtick fence cannot open with a backtick in its info string (CommonMark): "```js``` inline" is text.
    const marker = FENCE.exec(plain);
    if (marker && !(fence === undefined && marker[1]![0] === '`' && marker[2]!.includes('`'))) {
      const token = marker[1]!;
      if (!fence) { fence = { char: token[0]!, size: token.length }; current ??= { headingPath: stack.map(h => h.title), text: '', heading: false }; current.text += line; continue; }
      current ??= { headingPath: stack.map(h => h.title), text: '', heading: false }; current.text += line;
      if (token[0] === fence.char && token.length >= fence.size && !marker[2]!.trim()) fence = undefined;
      continue;
    }
    if (fence) { current ??= { headingPath: stack.map(h => h.title), text: '', heading: false }; current.text += line; continue; }
    const heading = HEADING.exec(plain);
    if (heading) {
      close();
      const level = heading[1]!.length;
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      current = { headingPath: stack.map(h => h.title), text: line, heading: true };
      // An optional closing sequence is only a closing sequence when preceded by whitespace ("# C#" keeps "C#").
      stack.push({ level, title: (heading[2] ?? '').replace(/[ \t]+#+$/, '').trim() });
      continue;
    }
    // Blank lines end a paragraph but are kept verbatim, including leading and consecutive ones.
    if (!plain.trim()) { current ??= { headingPath: stack.map(h => h.title), text: '', heading: false }; current.text += line; close(); continue; }
    current ??= { headingPath: stack.map(h => h.title), text: '', heading: false };
    current.text += line;
  }
  close();
  for (const unit of units) if (Buffer.byteLength(unit.text) > budget) throw new Error('IMPORT_CHUNK_TOO_LARGE');
  // Group units into sections (a heading plus everything up to the next heading), then pack:
  // whole sections when they fit, paragraph units otherwise.
  const sections: Unit[][] = [];
  for (const unit of units) { if (unit.heading || !sections.length) sections.push([unit]); else sections.at(-1)!.push(unit); }
  const chunks: MarkdownChunk[] = [];
  let open: MarkdownChunk | undefined; let openBytes = 0;
  const flush = () => { if (open) chunks.push(open); open = undefined; openBytes = 0; };
  const add = (unit: Unit) => {
    const bytes = Buffer.byteLength(unit.text);
    if (open && openBytes + bytes > budget) flush();
    if (!open) open = { headingPath: unit.headingPath, text: '' };
    open.text += unit.text; openBytes += bytes;
  };
  for (const section of sections) {
    const bytes = section.reduce((n, unit) => n + Buffer.byteLength(unit.text), 0);
    if (bytes <= budget) { if (open && openBytes + bytes > budget) flush(); for (const unit of section) add(unit); }
    else { flush(); for (const unit of section) add(unit); flush(); }
  }
  flush();
  return chunks;
}

/** Deterministic envelope: identical content, label and author digest identically so retries deduplicate. */
export function encodeDocumentChunk(chunk: DocumentImportChunk): string {
  return JSON.stringify({ kind: DOCUMENT_IMPORT_SOURCE, importId: chunk.importId, sourceLabel: chunk.sourceLabel, declaredAuthor: chunk.declaredAuthor, fileName: chunk.fileName, contentDigest: chunk.contentDigest, part: { index: chunk.part.index, count: chunk.part.count }, headingPath: chunk.headingPath, text: chunk.text });
}
export function decodeDocumentChunk(text: string): DocumentImportChunk | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const part = v.part as Record<string, unknown> | undefined;
    if (!v || v.kind !== DOCUMENT_IMPORT_SOURCE || typeof v.importId !== 'string' || typeof v.sourceLabel !== 'string' || !DOCUMENT_AUTHORS.includes(v.declaredAuthor as DocumentAuthor) || typeof v.fileName !== 'string' || typeof v.contentDigest !== 'string' || typeof v.text !== 'string' || !part || !Number.isSafeInteger(part.index) || !Number.isSafeInteger(part.count) || !Array.isArray(v.headingPath) || v.headingPath.some(h => typeof h !== 'string')) return null;
    return { importId: v.importId, sourceLabel: v.sourceLabel, declaredAuthor: v.declaredAuthor as DocumentAuthor, fileName: v.fileName, contentDigest: v.contentDigest, part: { index: part.index as number, count: part.count as number }, headingPath: v.headingPath as string[], text: v.text };
  } catch { return null; }
}

/**
 * Validate, chunk and safety-scan a file without touching any store. The import identity is the
 * content digest: the same bytes under another name are the same import, changed bytes are a new one.
 * The scan is the Writer's own outbound preflight run early, so a rejected file is reported before
 * anything is queued (the Writer repeats it before any network call).
 */
export function prepareDocumentImport(path: string, options: { label?: string | undefined; author?: DocumentAuthor | undefined; maxTotalBytes?: number | undefined } = {}): PreparedDocumentImport {
  const file = readMarkdownFile(path);
  const declaredAuthor = options.author ?? 'unknown';
  if (!DOCUMENT_AUTHORS.includes(declaredAuthor)) throw new Error('INVALID_IMPORT_AUTHOR');
  // The default label is the file name (a label, not content: control characters dropped, long names shortened); an explicit label must fit.
  const sourceLabel = options.label ?? [...file.fileName.replace(/\p{C}/gu, '')].slice(0, 64).join('');
  if (!LABEL.test(sourceLabel)) throw new Error('INVALID_IMPORT_LABEL');
  const contentDigest = createHash('sha256').update(file.text).digest('hex');
  const importId = `md-${contentDigest}`;
  const parts = chunkMarkdown(file.text);
  const cap = options.maxTotalBytes ?? 131072;
  const chunks = parts.map((part, i) => {
    const text = encodeDocumentChunk({ importId, sourceLabel, declaredAuthor, fileName: file.fileName, contentDigest, part: { index: i + 1, count: parts.length }, headingPath: part.headingPath, text: part.text });
    if (Buffer.byteLength(text) > cap) throw new Error('IMPORT_CHUNK_TOO_LARGE');
    try { externalPreflight({ text: part.text, heading_path: part.headingPath, source_label: sourceLabel }, { maxExcerptBytes: cap, maxCandidateBytes: cap, maxTotalBytes: Number.MAX_SAFE_INTEGER }); }
    catch (error) {
      const violations = (error as { details?: { violations?: { rule_id: string }[] } }).details?.violations ?? [];
      throw new Error(`SENSITIVE_CONTENT_REJECTED part ${i + 1}/${parts.length}: ${[...new Set(violations.map(v => v.rule_id))].join(', ') || 'disclosure policy'}`);
    }
    return { entryId: `part-${i + 1}`, text, headingPath: part.headingPath, bytes: Buffer.byteLength(part.text) };
  });
  return { importId, fileName: file.fileName, bytes: file.bytes, contentDigest, sourceLabel, declaredAuthor, chunks };
}

/** The queue namespace for local Markdown imports; the same content into two scopes is two items. */
export function documentImportSession(importId: string, contextId: string): string { return `import:${JSON.stringify(['markdown', DOCUMENT_IMPORT_FORMAT, importId, contextId])}`; }

/**
 * Admit every chunk of one import in a single transaction and request a prompt flush, exactly like Init.
 * Identity is the content digest within the scope: re-importing identical bytes (under any file name,
 * label or declared author) is a duplicate of the existing material and queues nothing new; the
 * original metadata stays. Different bytes are a different import.
 */
export function admitDocumentImport(store: RuntimeStore, prepared: PreparedDocumentImport, contextId: string): { importId: string; duplicate: boolean; parts: number } {
  const sessionId = documentImportSession(prepared.importId, contextId);
  return store.transaction(() => {
    const duplicate = store.observationStatus(sessionId, prepared.chunks[0]!.entryId) !== null;
    if (!duplicate) {
      const observedAt = new Date().toISOString();
      for (const chunk of prepared.chunks) {
        try { store.enqueue({ sessionId, entryId: chunk.entryId, scope: contextId, text: chunk.text, source: DOCUMENT_IMPORT_SOURCE, observedAt }); }
        catch (error) { if (error instanceof Error && error.message === 'Conflicting observation identity') throw new Error('SUBMISSION_CONFLICT'); throw error; }
      }
    }
    // Also on duplicates: a re-import is how an interrupted import is resumed promptly.
    store.requestFlush();
    return { importId: prepared.importId, duplicate, parts: prepared.chunks.length };
  });
}

export interface DocumentImportOutcome { importId: string; contextId: string; complete: boolean; parts: { part: number; state: string; issue: string | null; retainedIn: string[] }[]; retainedIn: string[] }
/** Per-part state without bodies; `complete` only when every part was processed. */
export function documentImportOutcome(store: RuntimeStore, importId: string, contextId: string, count: number): DocumentImportOutcome {
  const sessionId = documentImportSession(importId, contextId);
  const parts = Array.from({ length: count }, (_, i) => {
    const outcome = store.observationOutcome(sessionId, `part-${i + 1}`);
    return { part: i + 1, state: outcome?.state ?? 'unknown', issue: outcome?.issue ?? null, retainedIn: outcome?.retainedIn ?? [] };
  });
  return { importId, contextId, complete: parts.every(p => p.state === 'processed'), parts, retainedIn: [...new Set(parts.flatMap(p => p.retainedIn))].sort() };
}
