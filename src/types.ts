export interface WritableLike {
  write(chunk: string): unknown;
}

export type UnknownRecord = Record<string, unknown>;

export interface CodedError extends Error {
  code?: string;
  status?: number;
}
