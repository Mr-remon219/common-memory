import { isAbsolute } from "node:path";
import type { CommonMemoryConfig } from "../config/config.js";
import { createConfiguredWriter } from "../config/runtime.js";
import { admitDocumentImport, DOCUMENT_AUTHORS, documentImportOutcome, prepareDocumentImport, type DocumentAuthor, type DocumentImportOutcome } from "../v2/document-import.js";
import { ProjectRegistry } from "../v2/registry.js";

export interface ImportOptions { file: string; workspace?: string | undefined; author?: DocumentAuthor | undefined; label?: string | undefined; wait: boolean }

export function parseImportArgs(args: string[]): ImportOptions {
  const options: ImportOptions = { file: "", wait: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--no-wait") options.wait = false;
    else if (arg === "--workspace" || arg === "--author" || arg === "--label") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--")) throw new TypeError(`${arg} requires a value`);
      if (arg === "--workspace") { if (!isAbsolute(value)) throw new TypeError("--workspace must be an absolute path"); options.workspace = value; }
      else if (arg === "--author") { if (!DOCUMENT_AUTHORS.includes(value as DocumentAuthor)) throw new TypeError(`--author must be one of ${DOCUMENT_AUTHORS.join("|")}`); options.author = value as DocumentAuthor; }
      else options.label = value;
    } else if (arg.startsWith("--")) throw new TypeError(`Unknown import option ${arg}`);
    else if (options.file) throw new TypeError("import accepts exactly one file");
    else options.file = arg;
  }
  if (!options.file) throw new TypeError("import requires a Markdown file path");
  return options;
}

/**
 * `common-memory import <file.md>`: preprocess one local Markdown file, queue it as document_import
 * observations, then (by default) run the same Writer loop as `flush` and report each part. Nothing
 * here writes canonical Markdown directly; the Writer decides and the executor validates.
 */
export async function runImport(config: CommonMemoryConfig, args: string[], log: (line: string) => void = console.log): Promise<{ exitCode: number; outcome: DocumentImportOutcome | null }> {
  const options = parseImportArgs(args);
  if (!config.disclosure.allowedProvenance.includes("document_import")) throw new Error("IMPORT_DISABLED: allow \"Imported Markdown documents\" in common-memory config (disclosure.allowedProvenance: document_import)");
  let contextId = "global";
  if (options.workspace) {
    let project; try { project = new ProjectRegistry(config.dataRoot).resolve(options.workspace); } catch { project = undefined; }
    if (!project) throw new Error("UNREGISTERED_WORKSPACE: register it with common-memory project register");
    contextId = `project:${project.id}`;
  }
  if (!config.disclosure.allowedScopes.includes(contextId)) throw new Error(`CONTEXT_UNAVAILABLE: ${contextId} is not in disclosure.allowedScopes`);
  const prepared = prepareDocumentImport(options.file, { label: options.label, author: options.author, maxTotalBytes: config.disclosure.maxTotalBytes });
  log(`file: ${prepared.fileName} (${prepared.bytes} bytes, ${prepared.chunks.length} part${prepared.chunks.length === 1 ? "" : "s"}); label: ${prepared.sourceLabel}; declared author: ${prepared.declaredAuthor}; context: ${contextId}`);
  if (!config.writableScopes.includes(contextId)) log(`note: ${contextId} is not in writableScopes; the Writer can only commit to writable targets`);
  const writer = createConfiguredWriter(config), controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try {
    const admitted = admitDocumentImport(writer.store, prepared, contextId);
    log(admitted.duplicate ? `duplicate: this exact content was already imported as ${admitted.importId}; no new material was queued` : `accepted: queued as ${admitted.importId} (${admitted.parts} part${admitted.parts === 1 ? "" : "s"}); accepted means durably queued, not remembered`);
    if (options.wait) {
      for (;;) {
        const result = await writer.run({ force: true, signal:controller.signal });
        log(`maintenance: ${JSON.stringify(result)}`);
        if (!["committed", "noop", "ignored", "quarantined"].includes(result.outcome)) break;
      }
    }
    const outcome = documentImportOutcome(writer.store, prepared.importId, contextId, prepared.chunks.length);
    log(JSON.stringify(outcome, null, 2));
    if (outcome.complete) log(outcome.retainedIn.length ? `complete: retained in ${outcome.retainedIn.join(", ")}; review with common-memory show` : "complete: the Writer kept nothing from this file (ignored or reorganized only)");
    else if (!options.wait) log("queued: run common-memory flush, or import the same file again, to process and report");
    else log("incomplete: some parts were not processed. dead jobs: common-memory retry <job-id>; pending/retry: import the same file again or common-memory flush; quarantined parts are final for this content (see their issue above) and need a changed file to be imported again");
    return { exitCode: options.wait && !outcome.complete ? 1 : 0, outcome };
  } finally { process.off('SIGINT',cancel);process.off('SIGTERM',cancel);await writer.close(); }
}
