import { PROVENANCE_TYPES, type ProvenanceType } from "../../core/contracts/types.js";
export interface ObservationReference { observationId: string; digest: string; scope: string; provenance: ProvenanceType }
export interface ResolvedObservation extends ObservationReference { text: string; observedAt: string; sessionId: string | null; reference: string | null }
export interface ObservationSourcePort { resolve(reference: ObservationReference, options?: { signal?: AbortSignal }): Promise<ResolvedObservation> }
export function normalizeObservationReference(value: unknown): ObservationReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Observation reference must be an object"); const raw = value as Record<string, unknown>; const ownKeys = Reflect.ownKeys(raw); if (ownKeys.some((key) => typeof key !== "string")) throw new TypeError("Observation reference contains unsupported fields"); const keys = (ownKeys as string[]).sort(); if (keys.join(",") !== "digest,observationId,provenance,scope") throw new TypeError("Observation reference contains unsupported fields");
  if (typeof raw.observationId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.observationId) || typeof raw.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(raw.digest) || typeof raw.scope !== "string" || raw.scope.length < 1 || raw.scope.length > 512 || /[\0\r\n]/u.test(raw.scope) || typeof raw.provenance !== "string" || !(PROVENANCE_TYPES as readonly string[]).includes(raw.provenance)) throw new TypeError("Observation reference is invalid");
  return Object.freeze({ observationId: raw.observationId, digest: raw.digest, scope: raw.scope, provenance: raw.provenance as ProvenanceType });
}
