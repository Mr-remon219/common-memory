import type { RuntimeStore, Observation } from './runtime.js';
import { decodeText } from './sqlite.js';
import { decodeAgentImport, provenanceOf } from './import.js';
import { decodeDocumentChunk } from './document-import.js';

export interface BlockRange { id: string; parent: string | null; kind: string; start: number; end: number; field: string }
export interface IngestMaterial { text: string; gaps?: string; metadata: Record<string, unknown> }
/** Decode host-assigned envelopes, never infer authority from their text. */
export function material(source: string, text: string | null): IngestMaterial {
  if (source === 'agent_import') {
    const value = text === null ? null : decodeAgentImport(text);
    if (value) return { text: value.understanding, ...(value.gaps ? { gaps: value.gaps } : {}), metadata: { source_kind: source, source_label: value.sourceLabel, basis: value.basis } };
  }
  if (source === 'document_import') {
    const value = text === null ? null : decodeDocumentChunk(text);
    if (value) return { text: value.text, metadata: { source_kind: source, source_label: value.sourceLabel, declared_author: value.declaredAuthor, file_name: value.fileName, import_id: value.importId, part: value.part, heading_path: value.headingPath } };
  }
  return { text: text ?? '', metadata: { source_kind: source === 'agent_import' || source === 'document_import' ? source : 'user_turn' } };
}

/** Lossless structural ranges in JS string coordinates; no source prose is copied into SQLite. */
export function structuralBlocks(text: string, field = 'text'): BlockRange[] {
  const blocks: BlockRange[] = [];
  const ancestors: { level: number; id: string }[] = [];
  let fence: { char: string; size: number } | undefined;
  let start = 0, position = 0, kind = 'paragraph';
  const flush = () => {
    if (position === start) return;
    blocks.push({ id: `${field}_${blocks.length}`, parent: ancestors.at(-1)?.id ?? null, kind, start, end: position, field });
    start = position;
  };
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const plain = line.replace(/\r?\n$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(plain);
    if (fence) {
      position += line.length;
      if (marker && marker[1]![0] === fence.char && marker[1]!.length >= fence.size && !marker[2]!.trim()) { fence = undefined; flush(); kind = 'paragraph'; }
      continue;
    }
    if (marker && !(marker[1]![0] === '`' && marker[2]!.includes('`'))) { flush(); kind = 'code'; fence = { char: marker[1]![0]!, size: marker[1]!.length }; position += line.length; continue; }
    const heading = /^ {0,3}(#{1,6})(?:\s|$)/.exec(plain);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      while (ancestors.length && ancestors.at(-1)!.level >= level) ancestors.pop();
      kind = 'section'; position += line.length; flush();
      ancestors.push({ level, id: blocks.at(-1)!.id }); kind = 'paragraph'; continue;
    }
    const nextKind = /^\s*>/.test(plain) ? 'quote' : /^\s*(?:[-*+] |\d+[.)] )/.test(plain) ? 'list' : plain.includes('|') ? 'table' : 'paragraph';
    if (plain.trim() && kind !== nextKind) { flush(); kind = nextKind; }
    position += line.length;
    if (!plain.trim()) { flush(); kind = 'paragraph'; }
  }
  flush();
  return blocks;
}

export function initializeIngest(store: RuntimeStore): void {
  store.transaction(() => {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS ingest_bundles(id TEXT PRIMARY KEY, observationId INTEGER NOT NULL UNIQUE, format INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ingest_blocks(bundleId TEXT NOT NULL, id TEXT NOT NULL, parent TEXT, kind TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, field TEXT NOT NULL, ordinal INTEGER NOT NULL, PRIMARY KEY(bundleId,id));
      CREATE TRIGGER IF NOT EXISTS ingest_purge AFTER UPDATE OF text ON observations WHEN NEW.text IS NULL BEGIN
        DELETE FROM ingest_blocks WHERE bundleId IN (SELECT id FROM ingest_bundles WHERE observationId=NEW.id);
      END;
    `);
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS session_ingest_bundles(id TEXT PRIMARY KEY, messageId INTEGER NOT NULL UNIQUE, format INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS session_ingest_blocks(bundleId TEXT NOT NULL, id TEXT NOT NULL, parent TEXT, kind TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, field TEXT NOT NULL, ordinal INTEGER NOT NULL, PRIMARY KEY(bundleId,id));
      CREATE TRIGGER IF NOT EXISTS session_ingest_purge AFTER UPDATE OF text,unavailable ON session_messages WHEN NEW.text IS NULL OR NEW.unavailable IS NOT NULL BEGIN
        DELETE FROM session_ingest_blocks WHERE bundleId IN (SELECT id FROM session_ingest_bundles WHERE messageId=NEW.id);
      END;
    `);
    for (const row of store.db.prepare("SELECT m.id, CAST(m.text AS BLOB) AS text, m.unavailable FROM session_messages m LEFT JOIN session_ingest_bundles b ON b.messageId=m.id WHERE m.role!='user' AND b.id IS NULL").all()) {
      normalizeSessionIngest(store, decodeText(row) as unknown as SessionIngestOwner);
    }
    for (const row of store.db.prepare('SELECT o.*, CAST(o.text AS BLOB) AS text FROM observations o LEFT JOIN ingest_bundles b ON b.observationId=o.id WHERE b.id IS NULL').all()) {
      normalizeIngest(store, decodeText(row) as unknown as Observation);
    }
  });
}
export function normalizeIngest(store: RuntimeStore, observation: Observation): void {
  const id = `ingest_${observation.id}`;
  store.db.prepare('INSERT INTO ingest_bundles VALUES(?,?,1)').run(id, observation.id);
  const value = material(observation.source, observation.text);
  const ranges = [...structuralBlocks(value.text), ...structuralBlocks(value.gaps ?? '', 'gaps')];
  const insert = store.db.prepare('INSERT INTO ingest_blocks VALUES(?,?,?,?,?,?,?,?)');
  ranges.forEach((b, order) => insert.run(id, b.id, b.parent, b.kind, b.start, b.end, b.field, order));
}
export function ingestSummary(store: RuntimeStore, observation: Observation) {
  const value = material(observation.source, observation.text);
  return { ingest_id: `ingest_${observation.id}`, source: observation.source, provenance: provenanceOf(observation.source), scope: observation.scope,
    block_count: Number(store.db.prepare('SELECT COUNT(*) AS n FROM ingest_blocks WHERE bundleId=?').get(`ingest_${observation.id}`)!.n),
    bytes: Buffer.byteLength(value.text) + Buffer.byteLength(value.gaps ?? ''), state: String(store.db.prepare('SELECT state FROM observations WHERE id=?').get(observation.id)!.state) };
}

interface SessionIngestOwner { id: number; text: string | null; unavailable: string | null }
/** Context has its own owner: never observations/evidence and never another copy of its body. */
export function normalizeSessionIngest(store: RuntimeStore, message: SessionIngestOwner): void {
  const id = `session_ingest_${message.id}`;
  store.db.prepare('INSERT INTO session_ingest_bundles VALUES(?,?,1)').run(id, message.id);
  if (message.text === null || message.unavailable !== null) return;
  const root: BlockRange = {id:'conversation',parent:null,kind:'conversation',start:0,end:0,field:'text'};
  const ranges = [root, ...structuralBlocks(message.text).map(b => ({...b,parent:b.parent ?? root.id}))];
  const insert = store.db.prepare('INSERT INTO session_ingest_blocks VALUES(?,?,?,?,?,?,?,?)');
  ranges.forEach((b, order) => insert.run(id, b.id, b.parent, b.kind, b.start, b.end, b.field, order));
}
