import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { externalPreflight, preflightSource, type ExternalSizeCaps } from '../core/safety/external-preflight.js';
import { DOCUMENT_IMPORT_SOURCE } from './import.js';
import type { RuntimeStore } from './runtime.js';

/**
 * Input preprocessing for a user-chosen local Markdown file. It reads and validates one
 * complete source that Core admits as one structured `document_import` observation. It never decides what is worth remembering, never summarizes, never strips
 * headings, quotes, qualifiers or code, and never executes or follows anything in the file.
 */
export const DOCUMENT_AUTHORS = ['user', 'agent', 'third_party', 'mixed', 'unknown'] as const;
export type DocumentAuthor = typeof DOCUMENT_AUTHORS[number];
export { chunkMarkdown, MAX_DOCUMENT_CHUNK_BYTES, MAX_DOCUMENT_BYTES, type MarkdownChunk } from './compat/markdown-chunks.js';
export const DOCUMENT_EXTENSIONS = ['.md', '.markdown'] as const;
/** A display label: any printable text up to 64 characters, no control characters, not blank. */
const LABEL = /^(?=.*\S)[^\p{C}]{1,64}$/u;
/** Queue-key format of the chunk envelope; a change in chunking rules starts a new import rather than a stuck resume. */
export const DOCUMENT_IMPORT_FORMAT = 'v2';

export interface DocumentImportChunk {
  importId: string; sourceLabel: string; declaredAuthor: DocumentAuthor; fileName: string; contentDigest: string;
  part: { index: number; count: number }; headingPath: string[]; text: string;
}
export interface PreparedDocumentImport {
  importId: string; fileName: string; bytes: number; contentDigest: string; sourceLabel: string; declaredAuthor: DocumentAuthor;
  chunks: { entryId: string; text: string; headingPath: string[]; bytes: number }[];
}

/** Read one regular Markdown file: no symlinks, no directories, strict UTF-8, no implicit size cap. */
export function readMarkdownFile(path: string): { path: string; fileName: string; text: string; bytes: number } {
  const absolute = resolve(path);
  if (!DOCUMENT_EXTENSIONS.includes(extname(absolute).toLowerCase() as typeof DOCUMENT_EXTENSIONS[number])) throw new Error('UNSUPPORTED_FILE_TYPE');
  let stat; try { stat = lstatSync(absolute); } catch { throw new Error('FILE_NOT_FOUND'); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('UNSUPPORTED_FILE_TYPE');
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: Buffer;
  try { if (!fstatSync(fd).isFile()) throw new Error('UNSUPPORTED_FILE_TYPE'); raw = readFileSync(fd); } finally { closeSync(fd); }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw); } catch { throw new Error('INVALID_ENCODING'); }
  if (text.includes('\0')) throw new Error('INVALID_ENCODING');
  text = text.replaceAll('\r\n', '\n');
  if (!text.trim()) throw new Error('EMPTY_DOCUMENT');
  return { path: absolute, fileName: basename(absolute), text, bytes: Buffer.byteLength(text) };
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
 * Validate and safety-scan a file without touching any store. The import identity is the
 * content digest: the same bytes under another name are the same import, changed bytes are a new one.
 * The scan is the Writer's own outbound preflight run early, so a rejected file is reported before
 * anything is queued (the Writer repeats it before any network call).
 */
export function prepareDocumentImport(path: string, options: { label?: string | undefined; author?: DocumentAuthor | undefined; maxTotalBytes?: number | null | undefined; limits?: ExternalSizeCaps } = {}): PreparedDocumentImport {
  const file = readMarkdownFile(path);
  const declaredAuthor = options.author ?? 'unknown';
  if (!DOCUMENT_AUTHORS.includes(declaredAuthor)) throw new Error('INVALID_IMPORT_AUTHOR');
  // The default label is the file name (a label, not content: control characters dropped, long names shortened); an explicit label must fit.
  const sourceLabel = options.label ?? [...file.fileName.replace(/\p{C}/gu, '')].slice(0, 64).join('');
  if (!LABEL.test(sourceLabel)) throw new Error('INVALID_IMPORT_LABEL');
  const contentDigest = createHash('sha256').update(file.text).digest('hex');
  const importId = `md-${contentDigest}`;
  const parts = [{ headingPath: [] as string[], text: file.text }];
  const cap = options.maxTotalBytes ?? Number.MAX_SAFE_INTEGER;
  const chunks = parts.map((part, i) => {
    const text = encodeDocumentChunk({ importId, sourceLabel, declaredAuthor, fileName: file.fileName, contentDigest, part: { index: i + 1, count: parts.length }, headingPath: part.headingPath, text: part.text });
    if (Buffer.byteLength(text) > cap) throw new Error('IMPORT_CHUNK_TOO_LARGE');
    try {
      preflightSource(text, options.limits ?? {maxTotalBytes:options.maxTotalBytes ?? null});
      externalPreflight({ text: part.text, heading_path: part.headingPath, source_label: sourceLabel }, { maxExcerptBytes: cap, maxCandidateBytes: cap, maxTotalBytes: Number.MAX_SAFE_INTEGER }); }
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

/** Exact legacy namespaces preserve dedup and statuses without reading or reconstructing old bodies. */
function existingDocumentImport(store: RuntimeStore, importId: string, contextId: string) {
  const current = documentImportSession(importId, contextId);
  const legacy = `import:${JSON.stringify(['markdown', 'v1', importId, contextId])}`;
  const find = (sessionId: string) => store.db.prepare('SELECT entryId,source,scope FROM observations WHERE sessionId=? ORDER BY id').all(sessionId);
  const rows = find(current), old = find(legacy);
  if (rows.length && old.length) throw new Error('IMPORT_IDENTITY_CONFLICT');
  const existing = rows.length ? rows : old;
  if (existing.some(row => row.source !== DOCUMENT_IMPORT_SOURCE || row.scope !== contextId)) throw new Error('IMPORT_IDENTITY_CONFLICT');
  if (existing.some((row, index) => row.entryId !== `part-${index + 1}`)) throw new Error('IMPORT_IDENTITY_CONFLICT');
  return { sessionId: old.length ? legacy : current, entries: existing.map(row => String(row.entryId)), legacy: old.length > 0 };
}

/**
 * Admit every chunk of one import in a single transaction and request a prompt flush, exactly like Init.
 * Identity is the content digest within the scope: re-importing identical bytes (under any file name,
 * label or declared author) is a duplicate of the existing material and queues nothing new; the
 * original metadata stays. Different bytes are a different import.
 */
export function admitDocumentImport(store: RuntimeStore, prepared: PreparedDocumentImport, contextId: string): { importId: string; duplicate: boolean; parts: number } {
  return store.transaction(() => {
    const existing = existingDocumentImport(store, prepared.importId, contextId);
    const sessionId = existing.sessionId;
    const duplicate = existing.entries.length > 0;
    if (!duplicate) {
      const observedAt = new Date().toISOString();
      for (const chunk of prepared.chunks) {
        try { store.enqueue({ sessionId, entryId: chunk.entryId, scope: contextId, text: chunk.text, source: DOCUMENT_IMPORT_SOURCE, observedAt }); }
        catch (error) { if (error instanceof Error && error.message === 'Conflicting observation identity') throw new Error('SUBMISSION_CONFLICT'); throw error; }
      }
    }
    // Also on duplicates: a re-import is how an interrupted import is resumed promptly.
    store.requestFlush();
    return { importId: prepared.importId, duplicate, parts: duplicate ? existing.entries.length : prepared.chunks.length };
  });
}

export interface DocumentImportOutcome { importId: string; contextId: string; complete: boolean; parts: (import("./runtime.js").ObservationOutcome & {part: number})[]; retainedIn: string[] }
/** Per-part state without bodies; `complete` only when every part was processed. */
export function documentImportOutcome(store: RuntimeStore, importId: string, contextId: string, count: number): DocumentImportOutcome {
  const existing = existingDocumentImport(store, importId, contextId);
  const sessionId = existing.sessionId;
  const parts = Array.from({ length: existing.entries.length || count }, (_, i) => {
    const outcome = store.observationOutcome(sessionId, `part-${i + 1}`);
    return { part:i + 1, ...(outcome ?? {state:'unknown',issue:null,retainedIn:[],jobId:null,jobState:null,attempts:0,retryAt:null,diagnostic:null}) };
  });
  return { importId, contextId, complete: parts.every(p => p.state === 'processed'), parts, retainedIn: [...new Set(parts.flatMap(p => p.retainedIn))].sort() };
}
