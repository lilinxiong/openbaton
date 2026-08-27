export interface WritableLike {
  write(chunk: string): unknown;
}

export interface ModelCard {
  id: string;
  strengths: string;
  display_name?: string;
  description?: string;
  route_id?: string;
  reasoning_effort?: string;
  source?: "dynamic";
  provider?: string | null;
  executable?: boolean;
  available_speed_tiers?: string[];
  service_tiers?: string[];
  default_service_tier?: string | null;
  is_default?: boolean;
  positioning?: string[];
}

export interface ModelSelectionApproval {
  /** Host profile that captured and approved this model route. */
  host?: string;
  proposal_id: string;
  approval_id: string;
  confirmation_id?: string;
  confirmation_scope?: "proposal" | "bundle";
  unit_key?: string;
  approved_at: string;
  confirmed_by: "user" | "ops-config" | "baton-recommendation";
  catalog_fingerprint: string;
  recommended_model_id: string | null;
  selected_model_id: string;
  /** Exact optional speed/service tier chosen from the active CLI catalog. */
  service_tier?: string | null;
  changed_by_user: boolean;
  selected_provider_ids?: string[];
  global_provider_ids?: string[];
  ops_profile?: "runner" | "longctx";
  /** Opaque operation label retained for audit; never used for routing. */
  ops_operation?: string;
}

export type UnknownRecord = Record<string, unknown>;

export interface CodedError extends Error {
  code?: string;
  status?: number;
}
