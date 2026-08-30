import type { ObservationReference } from "../contracts/observation.js";
export type SchedulerOrigin = "user_turn" | "timer" | "compaction" | "manual" | "memory_manager";
export interface SchedulerTrigger { repositoryId: string; scope: string; origin: SchedulerOrigin; observations: readonly ObservationReference[]; userTurnCount?: number; bucketSize?: number; bucketOldestAt?: string; checkpoint?: string }
export function shouldEnqueue(trigger: SchedulerTrigger, now: Date): { enqueue: boolean; delayMs: number } {
  if (trigger.origin === "memory_manager") return { enqueue: false, delayMs: 0 };
  if (trigger.origin === "manual" || trigger.origin === "compaction") return { enqueue: true, delayMs: 0 };
  if (trigger.origin === "timer") return { enqueue: true, delayMs: 0 };
  const turn = (trigger.userTurnCount ?? 0) > 0 && (trigger.userTurnCount ?? 0) % 10 === 0;
  const bucket = (trigger.bucketSize ?? 0) >= 3 && trigger.bucketOldestAt !== undefined && now.getTime() - Date.parse(trigger.bucketOldestAt) >= 86_400_000;
  return { enqueue: turn || bucket || trigger.observations.length > 0, delayMs: 60_000 };
}
