import type { MemoryTask, MemoryReadPort } from '../../src/core/contracts/memory-agent.js';
import type { ApprovedModelRequest } from './model-fixture-contracts.js';

/** Test fixture only: exercise paged Core capabilities before feeding historical decision oracles. */
export function readTask(task: MemoryTask, reads: MemoryReadPort): ApprovedModelRequest {
  const observations: Record<string, unknown>[] = [], context: Record<string, unknown>[] = [];
  const turns = new Map<string, {turn_id:string;state:unknown;context_only:boolean;messages:Record<string,unknown>[]} >();
  for (const bundle of task.bundles) {
    const items = new Map<string, Record<string, unknown>>();
    const turnMessages = new Map<string, Record<string, unknown>>();
    for (let offset: number | null = 0; offset !== null;) {
      const page = reads.manifest(bundle.ingest_id, offset); offset = page.next;
      for (const block of page.blocks) {
        if (block.kind === 'document_part') continue;
        let text = '';
        for (let start: number | null = 0; start !== null;) { const part = reads.read(bundle.ingest_id, block.block_id, start); text += part.content; start = part.next; }
        const metadata = block.metadata;
        const key = block.evidence_ref ?? String(metadata.message_id ?? block.block_id);
        let item = items.get(key);
        if (!item) {
          item = { ref: block.evidence_ref, text: '', source_kind: metadata.source_kind, source_scope: metadata.scope, observed_at: metadata.observed_at, context_only: block.context_only };
          if (['agent_import', 'document_import'].includes(String(metadata.source_kind))) {
            item.import = metadata.source_kind === 'agent_import' ? { source_label:metadata.source_label,basis:metadata.basis,gaps:null } : { source_label:metadata.source_label,declared_author:metadata.declared_author,file_name:metadata.file_name,part:metadata.part,heading_path:metadata.heading_path };
          }
          items.set(key, item);
          if (metadata.turn_id) {
            const id = String(metadata.turn_id);
            if (!turns.has(id)) turns.set(id, { turn_id:id,state:metadata.turn_state,context_only:metadata.previous_turn === true,messages:[] });
            const message = { ...metadata, ...(block.evidence_ref ? {ref:block.evidence_ref} : {text}), context_only:block.context_only };
            turnMessages.set(key,message); turns.get(id)!.messages.push(message);
          }
        }
        if (block.block_id.startsWith('gaps_')) (item.import as Record<string,unknown>).gaps = String((item.import as Record<string,unknown>).gaps ?? '') + text;
        else item.text = String(item.text) + text;
        if (!block.evidence_ref && turnMessages.has(key)) turnMessages.get(key)!.text = item.text;
      }
    }
    (bundle.source === 'conversation_context' ? context : observations).push(...items.values());
  }
  const documents = (reads.memory(task.snapshot.handle) as Record<string, unknown>[]).map(doc => {
    let content = '';
    for (let offset: number | null = 0; offset !== null;) { const page = reads.memory(task.snapshot.handle, String(doc.target), offset) as { content: string; next: number | null }; content += page.content; offset = page.next; }
    return { ...doc, content };
  });
  return { prompt: 'Test decision oracle', schema: task.decision_schema, projection: { version:'memory_maintenance_v2',request_id:task.request_id,now:task.now,observations,documents,context_only:context,conversation_turns:[...turns.values()] } };
}
