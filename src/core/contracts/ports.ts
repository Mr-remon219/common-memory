import { randomUUID } from "node:crypto";

export interface Clock { now(): Date }
export interface IdGenerator { next(prefix: "fact" | "proposal" | "review" | "repository" | "transaction"): string }
export interface TrustedContributor { readonly client: "local_user" | "memory_manager"; readonly sessionId: string | null }
export interface GovernanceAuthority { readonly reviewerType: "local_user" }
export interface AutomatedGovernanceAuthority { readonly reviewerType: "memory_manager_policy" }
export type FaultPoint = "journal-write" | "journal-fsync" | "commit-marker" | "target-write" | "target-fsync" | "target-rename" | "directory-fsync" | "post-check" | "cleanup" | "cleanup-publish" | "index-rebuild" | "index-publish" | "lock-release";
export interface FaultInjector { checkpoint(point: FaultPoint, target?: string): void }

export const systemClock: Clock = { now: () => new Date() };
export const randomIdGenerator: IdGenerator = { next: (prefix) => `${prefix}.${randomUUID()}` };
export const noFaults: FaultInjector = { checkpoint: () => undefined };

// Capabilities are nominal: matching object fields never grant authority.
const trustedContributors = new WeakSet<object>();
const governanceAuthorities = new WeakSet<object>();
const automatedAuthorities = new WeakSet<object>();
function capability<T extends object>(set: WeakSet<object>, value: T): T { set.add(value); return Object.freeze(value); }
// These constructors belong to trusted local modules and are intentionally not re-exported by the package root.
export function trustedContributor(client: TrustedContributor["client"], sessionId: string | null = null): TrustedContributor { return capability(trustedContributors, { client, sessionId }); }
export function governanceAuthority(): GovernanceAuthority { return capability(governanceAuthorities, { reviewerType: "local_user" as const }); }
export function automatedGovernanceAuthority(): AutomatedGovernanceAuthority { return capability(automatedAuthorities, { reviewerType: "memory_manager_policy" as const }); }
export function isTrustedContributor(value: unknown): value is TrustedContributor { return typeof value === "object" && value !== null && trustedContributors.has(value); }
export function isGovernanceAuthority(value: unknown): value is GovernanceAuthority { return typeof value === "object" && value !== null && governanceAuthorities.has(value); }
export function isAutomatedGovernanceAuthority(value: unknown): value is AutomatedGovernanceAuthority { return typeof value === "object" && value !== null && automatedAuthorities.has(value); }
