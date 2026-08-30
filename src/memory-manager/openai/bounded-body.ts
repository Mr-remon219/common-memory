import { MemoryModelError } from "../contracts/errors.js";
export async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) { try { await response.body?.cancel(); } catch { /* Preserve the bounded-read error. */ } throw new MemoryModelError("INVALID_RESPONSE", "Provider response exceeded the configured limit"); }
  if (!response.body) return "";
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (!value) continue; total += value.byteLength; if (total > maxBytes) throw new MemoryModelError("INVALID_RESPONSE", "Provider response exceeded the configured limit"); chunks.push(value); }
  } catch (error) { try { await reader.cancel(); } catch { /* Preserve the read/limit failure. */ } throw error; }
  finally { reader.releaseLock(); }
  const combined = new Uint8Array(total); let offset = 0; for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}
