import { createHash } from "node:crypto";
import type { ProposeInput } from "../contracts/dto.js";
import type { GovernanceIntent, GovernanceMode, ProvenanceType, Revision } from "../contracts/types.js";
import { normalizeSemantic } from "../serialization/normalize.js";

export interface SourceDigestEntry { observation_id: string; observation_digest: string; scope: string; provenance: ProvenanceType }
export function sourceDigest(entries: readonly SourceDigestEntry[]): Revision { return digest("common-memory/source/v1", [...entries].sort((a, b) => Buffer.compare(Buffer.from(stable(a), "utf8"), Buffer.from(stable(b), "utf8")))); }
export function payloadDigest(input: ProposeInput): Revision { return digest("common-memory/proposal-payload/v1", normalizeSemantic(input)); }
export function operationId(contractVersion: "memory_analysis_v1", mode: GovernanceMode, policyVersion: string, intent: GovernanceIntent, payload: Revision, baseKnowledge: Revision, baseStore: Revision): string {
  return `operation.${bare(digest("common-memory/operation/v1", { contractVersion, mode, policyVersion, intent, payload, baseKnowledge, baseStore }))}`;
}
export function batchId(repositoryId: string, mode: GovernanceMode, policyVersion: string, source: Revision, baseKnowledge: Revision, baseStore: Revision): string {
  return `batch.${bare(digest("common-memory/batch/v1", { repositoryId, mode, policyVersion, source, baseKnowledge, baseStore }))}`;
}
export function compensationBatchId(repositoryId: string, reviewIds: readonly string[], baseKnowledge: Revision, baseStore: Revision): string {
  return `batch.${bare(digest("common-memory/compensation/v1", { repositoryId, reviewIds: [...reviewIds].sort(), baseKnowledge, baseStore }))}`;
}
export function planDigest(value: unknown): Revision { return digest("common-memory/undo-plan/v1", value); }
function digest(domain: string, value: unknown): Revision { return `sha256:${createHash("sha256").update(`${domain}\0${stable(value)}`, "utf8").digest("hex")}`; }
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b, "en")).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`; return JSON.stringify(value); }
function bare(value: Revision): string { return value.slice("sha256:".length); }
