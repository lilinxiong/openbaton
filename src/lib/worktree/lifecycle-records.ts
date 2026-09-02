/**
 * Persisted worktree record readers. Split from worktree-lifecycle.ts.
 */
import fs from "node:fs";
import path from "node:path";
import {
  parseChangeBundleManifest,
  parseIntegrationRecord,
  parseWorktreeRecord,
  readPersistedChangeBundleManifest,
  readPersistedIntegrationRecord,
  readPersistedWorktreeRecord,
  type ChangeBundleManifest,
  type IntegrationRecord,
  type WorktreeRecord
} from "../worktree-execution.js";
import type { WorktreeLifecycleDiagnostic } from "../worktree-lifecycle.js";
import { missing } from "./lifecycle-common.js";
import {
  rollingRunWorktreesDir,
  worktreeExecutionRootPath,
  worktreeRecordPath
} from "../paths.js";

export function readBundle(cwd: string, record: WorktreeRecord, env?: NodeJS.ProcessEnv): ChangeBundleManifest | null {
  if (!record.bundle_id) return null;
  try { return readPersistedChangeBundleManifest(cwd, record.run_id, record.bundle_id, env); }
  catch (error) { if (missing(error)) return null; throw error; }
}

export function readIntegration(cwd: string, record: WorktreeRecord, env?: NodeJS.ProcessEnv): IntegrationRecord | null {
  if (!record.integration_id) return null;
  try { return readPersistedIntegrationRecord(cwd, record.run_id, record.repository_id, record.integration_id, env); }
  catch (error) { if (missing(error)) return null; throw error; }
}

export function listPersistedWorktreeRecords(cwd: string, runId: string, env?: NodeJS.ProcessEnv): { records: WorktreeRecord[]; diagnostics: WorktreeLifecycleDiagnostic[] } {
  const directory = rollingRunWorktreesDir(cwd, runId, env);
  const records: WorktreeRecord[] = [];
  const diagnostics: WorktreeLifecycleDiagnostic[] = [];
  if (!fs.existsSync(directory)) return { records, diagnostics };
  for (const unitEntry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!unitEntry.isDirectory()) continue;
    const unitDir = path.join(directory, unitEntry.name);
    for (const attemptEntry of fs.readdirSync(unitDir, { withFileTypes: true })) {
      if (!attemptEntry.isDirectory()) continue;
      const recordFile = worktreeRecordPath(cwd, runId, unitEntry.name, attemptEntry.name, env);
      if (!fs.existsSync(recordFile)) {
        const executionRoot = worktreeExecutionRootPath(cwd, runId, unitEntry.name, attemptEntry.name, env);
        if (fs.existsSync(executionRoot)) diagnostics.push({ code: "ORPHAN_EXECUTION_ROOT", message: "execution root has no durable WorktreeRecord", path: executionRoot });
        continue;
      }
      try { records.push(readPersistedWorktreeRecord(cwd, runId, unitEntry.name, attemptEntry.name, env)); }
      catch (error) { diagnostics.push({ code: "WORKTREE_RECORD_UNREADABLE", message: error instanceof Error ? error.message : String(error), path: recordFile }); }
    }
  }
  return { records: records.sort((left, right) => left.unit_key.localeCompare(right.unit_key) || left.attempt_id.localeCompare(right.attempt_id)), diagnostics };
}
