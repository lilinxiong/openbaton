import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { receiptsDir } from "./paths.js";
import type { ModelCard } from "../types.js";

export interface DelegationReceipt {
  schema_version: 1;
  receipt_id: string;
  ticket_id: string;
  issued_at: string;
  route: {
    card_id: string;
    route_id: string | null;
    reasoning_effort: string | null;
    auth_provider: string | null;
  };
  execution: {
    mode: "read-only";
    fork_context: false;
    max_depth: 1;
  };
  scope: {
    write_allowlist: [];
    allowed_operations: ["read"];
    side_effects: [];
  };
  retry: {
    max_attempts: number;
    fallback: "none";
  };
  git_policy: {
    worker_may_stage: false;
    worker_may_commit: false;
    worker_may_branch: false;
    worker_may_rebase: false;
    staging_owner: "parent";
  };
}

export class ReceiptError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ReceiptError";
    this.code = code;
  }
}

export function buildReadOnlyReceipt({
  ticketId,
  card,
  issuedAt = new Date(),
  maxAttempts = 1,
}: {
  ticketId: string;
  card: ModelCard;
  issuedAt?: Date | string | number;
  maxAttempts?: number;
}): DelegationReceipt {
  const timestamp = (issuedAt instanceof Date ? issuedAt : new Date(issuedAt)).toISOString();
  const attempts = Math.max(1, Math.floor(maxAttempts));
  return {
    schema_version: 1,
    receipt_id: `rcpt-${ticketId}-a1`,
    ticket_id: ticketId,
    issued_at: timestamp,
    route: {
      card_id: card.id,
      route_id: card.route_id || null,
      reasoning_effort: card.reasoning_effort || null,
      auth_provider: card.auth_provider || null,
    },
    execution: { mode: "read-only", fork_context: false, max_depth: 1 },
    scope: { write_allowlist: [], allowed_operations: ["read"], side_effects: [] },
    retry: { max_attempts: attempts, fallback: "none" },
    git_policy: {
      worker_may_stage: false,
      worker_may_commit: false,
      worker_may_branch: false,
      worker_may_rebase: false,
      staging_owner: "parent",
    },
  };
}

function receiptPath(cwd: string, receiptId: string): string {
  return path.join(receiptsDir(cwd), `${receiptId}.json`);
}

export function writeReceipt(cwd: string, receipt: DelegationReceipt): DelegationReceipt {
  const dir = receiptsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = receiptPath(cwd, receipt.receipt_id);
  const content = `${JSON.stringify(receipt, null, 2)}\n`;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, "utf8") === content) return receipt;
    throw new ReceiptError(`receipt is immutable: ${receipt.receipt_id}`, "RECEIPT_IMMUTABLE");
  }
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  return receipt;
}

export function readReceipt(cwd: string, receiptId: string): DelegationReceipt {
  const file = receiptPath(cwd, receiptId);
  if (!fs.existsSync(file)) throw new ReceiptError(`receipt not found: ${receiptId}`, "RECEIPT_NOT_FOUND");
  return JSON.parse(fs.readFileSync(file, "utf8")) as DelegationReceipt;
}
