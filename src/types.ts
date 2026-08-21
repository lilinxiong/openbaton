export interface WritableLike {
  write(chunk: string): unknown;
}

export interface ModelCard {
  id: string;
  strengths: string;
  route_id?: string;
  reasoning_effort?: string;
  source?: "dynamic";
  provider?: string | null;
  executable?: boolean;
  positioning?: string[];
  capability?: CardCapabilityEvidence;
}

export interface ModelSelectionApproval {
  proposal_id: string;
  approval_id: string;
  confirmation_id?: string;
  confirmation_scope?: "proposal" | "bundle";
  unit_key?: string;
  approved_at: string;
  confirmed_by: "user" | "ops-config";
  host_snapshot_id: string;
  recommended_model_id: string | null;
  selected_model_id: string;
  changed_by_user: boolean;
  selected_provider_ids?: string[];
  global_provider_ids?: string[];
  ops_profile?: "runner" | "longctx";
  ops_action?: string;
}

export interface CardCapabilityEvidence {
  source: "artificial-analysis";
  ranked: boolean;
  unranked: boolean;
  reason: string | null;
  reference_only?: boolean;
  reference_reasons?: string[];
  reference_route_id?: string;
  reference_profile?: string;
  aa_slug?: string;
  aa_name?: string;
  mapping_route_id?: string;
  mapping_source?: string;
  intelligence_index: number | null;
  coding_index: number | null;
  agentic_index: number | null;
  cost_per_task: number | null;
  output_tokens_per_second: number | null;
  time_to_first_answer_seconds: number | null;
  aa_data?: {
    evaluations: Record<string, number | null>;
    pricing: Record<string, number | null>;
    performance: Record<string, number | null>;
    cost: Record<string, number | null>;
  };
  relative?: {
    intelligence?: number;
    coding?: number;
    agentic?: number;
    cost_efficiency?: number;
    throughput?: number;
    latency?: number;
  };
}

export type UnknownRecord = Record<string, unknown>;

export interface CodedError extends Error {
  code?: string;
  status?: number;
}
