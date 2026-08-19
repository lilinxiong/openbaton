export interface WritableLike {
  write(chunk: string): unknown;
}

export interface ModelCard {
  id: string;
  strengths: string;
  auth_provider?: string;
  route_id?: string;
  reasoning_effort?: string;
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
