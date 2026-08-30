import type { GovernanceBatchDto } from "../../core/contracts/dto.js";
import type { ModelUsage } from "./model-port.js";
export type MemoryRunOutcome = "committed" | "idempotent" | "no_op" | "refused" | "blocked" | "deferred" | "failed" | "cancelled";
export interface MemoryRunResult { outcome: MemoryRunOutcome; batch?: GovernanceBatchDto; usage?: ModelUsage; refusal?: { category: "provider_refusal"; fingerprint: string }; reason_code?: string }
