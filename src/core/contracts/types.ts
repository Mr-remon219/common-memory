export const FACT_KINDS = ["identity", "goal", "preference", "constraint", "environment", "relationship", "decision", "event"] as const;
export const FACT_STATUSES = ["confirmed", "superseded", "expired", "deleted"] as const;
export const PRIORITIES = ["core", "normal", "archive"] as const;
export const PROVENANCE_TYPES = ["user_statement", "user_correction", "agent_observation", "imported_event", "project_evidence"] as const;
export const OPERATIONS = ["add_fact", "supersede_fact", "expire_fact"] as const;

export type FactKind = typeof FACT_KINDS[number];
export type FactStatus = typeof FACT_STATUSES[number];
export type Priority = typeof PRIORITIES[number];
export type ProvenanceType = typeof PROVENANCE_TYPES[number];
export type Operation = typeof OPERATIONS[number];
export type Revision = `sha256:${string}`;

export type Scope =
  | { type: "global"; id: null }
  | { type: "project" | "agent" | "device"; id: string };

export interface SuggestedFact {
  statement: string;
  kind: FactKind;
  scope: Scope;
  priority: Priority;
  valid_from: string | null;
  expires_at: string | null;
  tags: string[];
}

export interface Evidence {
  provenance_type: ProvenanceType;
  session_id: string | null;
  reference: string | null;
  note?: string | null;
  observed_at: string;
}

export type SourceClient = "local_user" | "memory_manager";
export type ReviewerType = "local_user" | "memory_manager_policy";
export type GovernanceMode = "extract" | "consolidate" | "compensation";
export type GovernanceIntent = "add" | "modify" | "replace" | "merge" | "distill" | "expire" | "archive";
export interface ReviewExecution {
  mode: GovernanceMode;
  batch_id: string;
  operation_id: string;
  sequence: number;
  batch_size: number;
  intent: GovernanceIntent;
  policy_version: string;
  source_digest: Revision;
  base_knowledge_revision: Revision;
  base_store_revision: Revision;
  payload_digest: Revision;
  reverts_review_ids: string[];
}
export interface Provenance {
  type: ProvenanceType;
  source_client: SourceClient;
  session_id: string | null;
  reference: string | null;
  note?: string | null;
  observed_at: string;
  received_at: string;
}

export interface Fact {
  schema_version: 1;
  id: string;
  statement: string;
  kind: FactKind;
  scope: Scope;
  status: FactStatus;
  priority: Priority;
  provenance: Provenance;
  governance: { proposal_id: string; review_id: string; confirmed_at: string };
  validity: { valid_from: string; expires_at: string | null; supersedes: string[] };
  tags: string[];
}

interface ProposalBase {
  schema_version: 1;
  id: string;
  evidence: Evidence;
  reasoning: string;
  confidence: "low" | "medium" | "high";
  source: { client: SourceClient; received_at: string };
  created_at: string;
}
export interface AddFactProposal extends ProposalBase {
  operation: "add_fact";
  target_fact_ids: [];
  suggested_fact: SuggestedFact;
}
export interface SupersedeFactProposal extends ProposalBase {
  operation: "supersede_fact";
  target_fact_ids: string[];
  suggested_fact: SuggestedFact;
}
export interface ExpireFactProposal extends ProposalBase {
  operation: "expire_fact";
  target_fact_ids: string[];
  suggested_expiration: { expires_at: string; reason: string };
}
export type Proposal = AddFactProposal | SupersedeFactProposal | ExpireFactProposal;

export interface AddFinalOperation { operation: "add_fact"; suggested_fact: SuggestedFact; resulting_fact_ids: [string] }
export interface SupersedeFinalOperation { operation: "supersede_fact"; target_fact_ids: string[]; suggested_fact: SuggestedFact; resulting_fact_ids: [string] }
export interface ExpireFinalOperation { operation: "expire_fact"; target_fact_ids: string[]; expires_at: string; reason: string; resulting_fact_ids: [] }
export type FinalOperation = AddFinalOperation | SupersedeFinalOperation | ExpireFinalOperation;
interface ReviewBase { schema_version: 1; id: string; proposal_id: string; reviewed_at: string; reviewer: { type: ReviewerType }; note: string | null; based_on_store_revision: Revision; execution: ReviewExecution | null }
export interface ApprovedReview extends ReviewBase { decision: "approved"; final_operation: FinalOperation; resulting_store_revision: Revision }
export interface RejectedReview extends ReviewBase { decision: "rejected" }
export type Review = ApprovedReview | RejectedReview;

export interface RepositoryMetadata {
  schema_version: 1;
  repository_id: string;
  initialized_at: string;
  schema_bundle_digest: Revision;
}

export interface Revisions { knowledge_revision: Revision; store_revision: Revision; index_revision: Revision | null }
export interface RepositorySnapshot extends Revisions {
  repository: RepositoryMetadata;
  facts: ReadonlyMap<string, Fact>;
  proposals: ReadonlyMap<string, Proposal>;
  reviews: ReadonlyMap<string, Review>;
}

export interface TimeRange { from: string | null; to: string | null }
