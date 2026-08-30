import { CoreError } from "../contracts/errors.js";
import { scanFields, type SafetyField } from "./scanner.js";
export interface ExternalSizeCaps { maxExcerptBytes: number; maxCandidateBytes: number; maxTotalBytes: number }
export function externalPreflight(projection: Readonly<Record<string, unknown>>, caps: ExternalSizeCaps, exactSerializedBytes?: number): void {
  const fields: SafetyField[] = []; collect(projection, "", fields); scanFields(fields, true);
  const bytes = exactSerializedBytes ?? Buffer.byteLength(JSON.stringify(projection), "utf8"); if (bytes > caps.maxTotalBytes) reject("external.total_bytes", "/");
  checkNamedArrays(projection, "", caps);
}
function collect(value: unknown, path: string, out: SafetyField[]): void {
  if (typeof value === "string") { out.push({ path: path || "/", value }); return; }
  if (Array.isArray(value)) { value.forEach((child, index) => collect(child, `${path}/${index}`, out)); return; }
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { const childPath = `${path}/${escapePointer(key)}`; out.push({ path: `${childPath}/@key`, value: key }); collect(child, childPath, out); }
}
function checkNamedArrays(value: unknown, path: string, caps: ExternalSizeCaps): void {
  if (Array.isArray(value)) { value.forEach((child, index) => checkNamedArrays(child, `${path}/${index}`, caps)); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}/${escapePointer(key)}`;
    if ((key === "excerpts" || key === "candidates") && Array.isArray(child)) { const max = key === "excerpts" ? caps.maxExcerptBytes : caps.maxCandidateBytes; child.forEach((item, index) => { if (Buffer.byteLength(JSON.stringify(item), "utf8") > max) reject(key === "excerpts" ? "external.excerpt_bytes" : "external.candidate_bytes", `${childPath}/${index}`); }); }
    checkNamedArrays(child, childPath, caps);
  }
}
function reject(rule_id: string, field_path: string): never { throw new CoreError("SENSITIVE_CONTENT_REJECTED", "Outbound projection exceeds disclosure limits", { violations: [{ rule_id, field_path }] }); }
function escapePointer(value: string): string { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }
