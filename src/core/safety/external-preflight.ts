import { CoreError } from "../contracts/errors.js";
import { scanFields, type SafetyField } from "./scanner.js";
export interface ExternalSizeCaps { maxExcerptBytes?: number | null; maxCandidateBytes?: number | null; maxTotalBytes?: number | null }
export function externalPreflight(projection: Readonly<Record<string, unknown>>, caps: ExternalSizeCaps, exactSerializedBytes?: number): void {
  const fields: SafetyField[] = []; collect(projection, "", fields); scanFields(fields, true);
  const bytes = exactSerializedBytes ?? Buffer.byteLength(JSON.stringify(projection), "utf8"); if (bytes > (caps.maxTotalBytes ?? Number.MAX_SAFE_INTEGER)) reject("external.total_bytes", "/");
  // Source limits apply to the complete projection, never a particular key spelling.
  if (bytes > (caps.maxExcerptBytes ?? Number.MAX_SAFE_INTEGER)) reject("external.excerpt_bytes", "/");
  if (bytes > (caps.maxCandidateBytes ?? Number.MAX_SAFE_INTEGER)) reject("external.candidate_bytes", "/");
}
function collect(value: unknown, path: string, out: SafetyField[]): void {
  if (typeof value === "string") { out.push({ path: path || "/", value }); return; }
  if (Array.isArray(value)) { value.forEach((child, index) => collect(child, `${path}/${index}`, out)); return; }
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { const childPath = `${path}/${escapePointer(key)}`; out.push({ path: `${childPath}/@key`, value: key }); collect(child, childPath, out); }
}
function reject(rule_id: string, field_path: string): never { throw new CoreError("SENSITIVE_CONTENT_REJECTED", "Outbound projection exceeds disclosure limits", { violations: [{ rule_id, field_path }] }); }
function escapePointer(value: string): string { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }

/** maxCandidateBytes no longer names a candidate list. Preserve its explicit restriction. */
export function inputLimits(caps: ExternalSizeCaps) {
  const source = Math.min(caps.maxExcerptBytes ?? Infinity, caps.maxCandidateBytes ?? Infinity, caps.maxTotalBytes ?? Infinity);
  return {maxSourceBytes:Number.isFinite(source) ? source : null,maxInputBytes:caps.maxTotalBytes ?? null,
    deprecatedLimits:caps.maxCandidateBytes == null ? [] : ['maxCandidateBytes is deprecated; its explicit value still restricts the complete source. Use maxExcerptBytes instead.']};
}
/** One complete source, including import metadata/gaps; no truncation or semantic projection. */
export function preflightSource(text: string, caps: ExternalSizeCaps): void { externalPreflight(sourceEnvelope(text), caps); }
/** Keep the original native-edit envelope overhead: old explicit limits never become looser. */
function sourceEnvelope(text: string | null) { return {excerpts:[{text}]}; }
export function serializedSourceBytes(text: string | null): number { return Buffer.byteLength(JSON.stringify(sourceEnvelope(text))); }
