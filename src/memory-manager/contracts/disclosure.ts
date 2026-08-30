import type { ProvenanceType } from "../../core/contracts/types.js";
export interface RemoteDisclosurePolicy {
  enabled: true;
  allowedScopes: readonly string[];
  allowedProvenance: readonly ProvenanceType[];
  maxExcerptBytes: number;
  maxCandidateBytes: number;
  maxTotalBytes: number;
}
export function validateDisclosurePolicy(value: RemoteDisclosurePolicy): void {
  if (value?.enabled !== true || !Array.isArray(value.allowedScopes) || !Array.isArray(value.allowedProvenance)) throw new TypeError("Remote disclosure must be explicitly enabled");
  for (const cap of [value.maxExcerptBytes, value.maxCandidateBytes, value.maxTotalBytes]) if (!Number.isSafeInteger(cap) || cap <= 0) throw new TypeError("Remote disclosure byte caps must be positive integers");
}
