export type ApplyUnitMode = "write" | "read-only";

export interface ApplyUnitScope {
  mode: ApplyUnitMode;
  write_paths: string[];
}

export type ApplyUnitScopeMap = Map<string, ApplyUnitScope>;

function ensureScope(scopes: ApplyUnitScopeMap, id: string): ApplyUnitScope {
  let scope = scopes.get(id);
  if (!scope) {
    scope = { mode: "read-only", write_paths: [] };
    scopes.set(id, scope);
  }
  return scope;
}

/** Pair `--unit ID` with following `--write-path` / `--read-only`. Optional `--scope JSON`. */
export function parseApplyUnitScopes(args: string[]): ApplyUnitScopeMap {
  const scopes: ApplyUnitScopeMap = new Map();
  let current: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--scope") {
      const raw = args[index + 1];
      if (raw === undefined || raw.startsWith("--")) throw new Error("TASK_SCOPE_REQUIRED: --scope requires a JSON object");
      index += 1;
      mergeScopeJson(scopes, raw);
      continue;
    }
    if (arg === "--unit") {
      const id = args[index + 1];
      if (id === undefined || id.startsWith("--")) throw new Error("TASK_SCOPE_REQUIRED: --unit requires a task id");
      index += 1;
      current = id.trim();
      if (!current) throw new Error("TASK_SCOPE_REQUIRED: --unit requires a task id");
      ensureScope(scopes, current);
      continue;
    }
    if (arg === "--write-path") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("TASK_SCOPE_REQUIRED: --write-path requires a path");
      index += 1;
      if (!current) throw new Error("TASK_SCOPE_REQUIRED: --write-path must follow --unit ID");
      const scope = ensureScope(scopes, current);
      scope.mode = "write";
      for (const item of value.split(",").map((part) => part.trim()).filter(Boolean)) {
        if (!scope.write_paths.includes(item)) scope.write_paths.push(item);
      }
      continue;
    }
    if (arg === "--read-only") {
      if (!current) throw new Error("TASK_SCOPE_REQUIRED: --read-only must follow --unit ID");
      const scope = ensureScope(scopes, current);
      if (!scope.write_paths.length) scope.mode = "read-only";
    }
  }
  for (const [id, scope] of scopes) {
    if (scope.mode === "write" && !scope.write_paths.length) {
      throw new Error(`TASK_SCOPE_REQUIRED: --unit ${id} write scope needs --write-path`);
    }
  }
  return scopes;
}

function mergeScopeJson(scopes: ApplyUnitScopeMap, raw: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("TASK_SCOPE_REQUIRED: --scope must be JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("TASK_SCOPE_REQUIRED: --scope must be a JSON object of task id → { mode, write_paths }");
  }
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const key = id.trim();
    if (!key) continue;
    const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const mode = row.mode === "write" || row.mode === "read-only" ? row.mode : (Array.isArray(row.write_paths) && row.write_paths.length ? "write" : "read-only");
    const paths = Array.isArray(row.write_paths)
      ? row.write_paths.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const scope = ensureScope(scopes, key);
    if (mode === "write") {
      scope.mode = "write";
      for (const item of paths) {
        if (!scope.write_paths.includes(item)) scope.write_paths.push(item);
      }
    } else if (!scope.write_paths.length) {
      scope.mode = "read-only";
    }
  }
}

export function scopeRecord(scopes: ApplyUnitScopeMap): Record<string, ApplyUnitScope> {
  return Object.fromEntries([...scopes.entries()].map(([id, scope]) => [id, {
    mode: scope.mode,
    write_paths: [...scope.write_paths],
  }]));
}

export function scopesFromRecord(value: unknown): ApplyUnitScopeMap {
  const scopes: ApplyUnitScopeMap = new Map();
  if (!value || typeof value !== "object" || Array.isArray(value)) return scopes;
  for (const [id, row] of Object.entries(value as Record<string, unknown>)) {
    const key = id.trim();
    if (!key) continue;
    const body = row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : {};
    const paths = Array.isArray(body.write_paths)
      ? body.write_paths.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    const mode = body.mode === "write" || paths.length ? "write" : "read-only";
    scopes.set(key, { mode: mode === "write" ? "write" : "read-only", write_paths: paths });
  }
  return scopes;
}
