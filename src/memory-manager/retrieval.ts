import { createHash } from "node:crypto";
import { CoreError } from "../core/contracts/errors.js";
import type { CoreService } from "../core/service/core-service.js";
import type { Fact } from "../core/contracts/types.js";
import { normalizeObservationReference, type ObservationReference, type ObservationSourcePort, type ResolvedObservation } from "./contracts/observation.js";
import type { RemoteDisclosurePolicy } from "./contracts/disclosure.js";
export async function resolveObservations(source: ObservationSourcePort, references: readonly ObservationReference[], policy: RemoteDisclosurePolicy, signal?: AbortSignal): Promise<ResolvedObservation[]> {
  const resolved: ResolvedObservation[] = [];
  for (const rawReference of references) {
    const reference = normalizeObservationReference(rawReference);
    if (!policy.allowedScopes.includes(reference.scope) || !policy.allowedProvenance.includes(reference.provenance)) throw new CoreError("PERMISSION_DENIED", "Observation disclosure is not authorized", { rule_id: "disclosure.allowlist" });
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const value = await source.resolve(reference, signal ? { signal } : {});
    if (value.observationId !== reference.observationId || value.scope !== reference.scope || value.provenance !== reference.provenance || digestText(value.text) !== reference.digest) throw new CoreError("CONFLICT_DETECTED", "Observation reference failed digest verification", { rule_id: "observation.digest" });
    resolved.push(value);
  }
  return resolved;
}
export function retrieveCandidates(core: CoreService, scopes: readonly string[], limit = 20): { facts: Fact[]; knowledgeRevision: `sha256:${string}`; storeRevision: `sha256:${string}` } {
  const response = core.get({ scopes: [...scopes], include_history: false }); if (!response.ok) throw new CoreError(response.error.code as never, response.error.message, response.error.details);
  return { facts: response.data.facts.slice(0, limit), knowledgeRevision: response.knowledge_revision!, storeRevision: response.store_revision! };
}
export function digestText(text: string): string { return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`; }
