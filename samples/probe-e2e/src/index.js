export { formatLabel } from "./utils/format.js";
export { isNonEmpty } from "./utils/validate.js";

import { formatLabel } from "./utils/format.js";
import { isNonEmpty } from "./utils/validate.js";

export function runSmoke() {
  const labelOk = formatLabel("  probe ") === "PROBE";
  const validateOk = isNonEmpty(" x ") && !isNonEmpty("   ");
  return { ok: labelOk && validateOk };
}
