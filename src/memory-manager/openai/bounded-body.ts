import { MemoryModelError } from "../contracts/errors.js";
import { abortable, cancelBody } from './abort.js';
export async function readBoundedBody(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const overflow = () => new MemoryModelError('INVALID_RESPONSE', 'Provider response exceeded the configured limit', false, {stage:'response_body',reason:'body_too_large',retryable:false});
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) { cancelBody(response.body); throw overflow(); }
  if (!response.body) return "";
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) { const { done, value } = await abortable(reader.read(), signal); if (done) break; if (!value) continue; total += value.byteLength; if (total > maxBytes) throw overflow(); chunks.push(value); }
  } catch (error) { try { void reader.cancel().catch(() => {}); } catch { /* Preserve the read/limit failure. */ } throw error; }
  finally { try { reader.releaseLock(); } catch { /* A non-cooperative reader can still be pending. */ } }
  const combined = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}
