import fs from "node:fs";
import { promoteConversation } from "../lib/conversation.js";
import type { WritableLike } from "../types.js";

export function runConversation(args: string[], { stdout }: { stdout: WritableLike }): number {
  const sub = args[0];
  if (sub !== "promote") throw new Error("usage: baton conversation promote --from-file PATH");
  const index = args.indexOf("--from-file");
  const file = index >= 0 ? args[index + 1] : undefined;
  if (!file) throw new Error("usage: baton conversation promote --from-file PATH");
  const result = promoteConversation(fs.readFileSync(file, "utf8"));
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.ready_for_approval ? 0 : 1;
}
