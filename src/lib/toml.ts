/**
 * Minimal TOML subset: comments, [tables], [[arrays]], string/number/bool.
 * Enough for baton config. Not a general TOML implementation.
 */
export function parseToml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let current: Record<string, unknown> = root;
  let arrayKey = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;

    const array = line.match(/^\[\[([^\]\n]+)\]\]$/);
    if (array) {
      const key = array[1].trim();
      if (!Array.isArray(root[key])) root[key] = [];
      const items = root[key] as unknown[];
      current = {};
      items.push(current);
      arrayKey = key;
      continue;
    }

    const table = line.match(/^\[([^\]\n]+)\]$/);
    if (table) {
      current = ensureTable(root, table[1].trim());
      arrayKey = null;
      continue;
    }

    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!kv) {
      throw new Error(`unsupported TOML line: ${raw}`);
    }
    current[kv[1]] = parseValue(kv[2].trim());
  }

  void arrayKey;
  return root;
}

function ensureTable(root: Record<string, unknown>, dotted: string): Record<string, unknown> {
  const parts = dotted.split(".").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error("empty TOML table name");
  let current: Record<string, unknown> = root;
  for (const part of parts) {
    const existing = current[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  return current;
}

function parseValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return splitTomlList(inner).map((item) => parseValue(item));
  }
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

function splitTomlList(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of inner) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      if (current.trim()) items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

export function stringifyToml(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  const tables: Array<[string, Record<string, unknown>]> = [];
  const arrays: Array<[string, unknown[]]> = [];

  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      arrays.push([key, value]);
    } else if (value && typeof value === "object") {
      tables.push([key, value as Record<string, unknown>]);
    } else {
      lines.push(`${key} = ${formatValue(value)}`);
    }
  }

  for (const [key, table] of tables) {
    const nested: Array<[string, Record<string, unknown>]> = [];
    const scalars: Array<[string, unknown]> = [];
    for (const [k, v] of Object.entries(table)) {
      if (v && typeof v === "object" && !Array.isArray(v)) nested.push([k, v as Record<string, unknown>]);
      else scalars.push([k, v]);
    }
    if (scalars.length) {
      if (lines.length) lines.push("");
      lines.push(`[${key}]`);
      for (const [k, v] of scalars) lines.push(`${k} = ${formatValue(v)}`);
    }
    for (const [sub, inner] of nested) {
      if (lines.length) lines.push("");
      lines.push(`[${key}.${sub}]`);
      for (const [k, v] of Object.entries(inner)) lines.push(`${k} = ${formatValue(v)}`);
    }
  }

  for (const [key, items] of arrays) {
    for (const item of items) {
      lines.push("");
      lines.push(`[[${key}]]`);
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        lines.push(`${k} = ${formatValue(v)}`);
      }
    }
  }

  return lines.join("\n") + "\n";
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => formatValue(item)).join(", ")}]`;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  throw new Error(`cannot serialize ${typeof value}`);
}
