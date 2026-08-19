export interface WritableLike {
  write(chunk: string): unknown;
}

export interface ModelCard {
  id: string;
  strengths: string;
  auth_provider?: string;
  route_id?: string;
  reasoning_effort?: string;
  enabled?: boolean;
  source?: "dynamic" | "override";
  provider?: string | null;
  executable?: boolean;
  positioning?: string[];
  capability?: CardCapabilityEvidence;
}

export interface CardCapabilityEvidence {
  source: "artificial-analysis";
  ranked: boolean;
  unranked: boolean;
  reason: string | null;
  aa_slug?: string;
  mapping_route_id?: string;
  mapping_source?: string;
  intelligence_index: number | null;
  coding_index: number | null;
  agentic_index: number | null;
  cost_per_task: number | null;
  output_tokens_per_second: number | null;
  time_to_first_answer_seconds: number | null;
  relative?: {
    intelligence?: number;
    coding?: number;
    agentic?: number;
    cost_efficiency?: number;
    throughput?: number;
    latency?: number;
  };
}

export interface DirectorConfig {
  director: {
    max_concurrent: number;
    max_depth: number;
    runner?: string;
  };
  models: ModelCard[];
}

export type UnknownRecord = Record<string, unknown>;

export interface CodedError extends Error {
  code?: string;
  status?: number;
}
