type ProvenanceType = "user_explicit" | "agent_observation" | "document_import" | "conversation_context";
export interface RemoteDisclosurePolicy {
  enabled: true;
  allowedScopes: readonly string[];
  allowedProvenance: readonly ProvenanceType[];
  maxExcerptBytes?: number | null;
  maxCandidateBytes?: number | null;
  maxTotalBytes?: number | null;
}
export function validateDisclosurePolicy(value: RemoteDisclosurePolicy): void {
  if (value?.enabled !== true || !Array.isArray(value.allowedScopes) || !Array.isArray(value.allowedProvenance)) throw new TypeError("Remote disclosure must be explicitly enabled");
  for (const cap of [value.maxExcerptBytes, value.maxCandidateBytes, value.maxTotalBytes]) if (cap != null && (!Number.isSafeInteger(cap) || cap <= 0)) throw new TypeError("Remote disclosure byte caps must be positive integers");
}
