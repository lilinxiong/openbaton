/**
 * Shared micro-validators for JSON-shaped unknown values. Several protocol
 * modules used to carry identical private copies of these helpers.
 */

/** Plain record check (rejects null and arrays). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/** Own-property check that is safe on unknown-shaped records. */
export function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Non-empty string predicate (no trimming). */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Non-blank string predicate (whitespace-only strings rejected). */
export function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
