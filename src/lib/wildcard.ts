/**
 * Shared glob-wildcard prefix helpers. Several apply/worktree modules used
 * to re-implement the same "literal prefix before the first wildcard" scan.
 */

/** Index of the first glob wildcard character (`*`, `?`, `[`), or -1. */
export function firstWildcardIndex(value: string): number {
  return value.search(/[*?[]/);
}

/** Literal path prefix before the first wildcard, trailing slashes stripped. */
export function wildcardStaticPrefix(value: string): string {
  const index = firstWildcardIndex(value);
  return (index >= 0 ? value.slice(0, index) : value).replace(/\/+$/, "");
}
