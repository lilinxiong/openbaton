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
      const key = table[1].trim();
      if (!root[key] || typeof root[key] !== "object" || Array.isArray(root[key])) {
        root[key] = {};
      }
      current = root[key] as Record<string, unknown>;
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

function parseValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
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
    if (lines.length) lines.push("");
    lines.push(`[${key}]`);
    for (const [k, v] of Object.entries(table)) {
      lines.push(`${k} = ${formatValue(v)}`);
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
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  throw new Error(`cannot serialize ${typeof value}`);
}
