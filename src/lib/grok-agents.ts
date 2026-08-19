/**
 * Grok host adapter: one user-home agent per card.
 * Official spawn_subagent has no model param; the agent definition pins it.
 * Never write Grok native models (grok-*) into ~/.grok agents or config.
 */
import fs from "node:fs";
import path from "node:path";
import type { ModelCard } from "../types.js";
import { hostHome, displayHomePath } from "./paths.js";
import { HOST_SKILL_REL } from "./hosts.js";

export const GROK_AGENTS_DIR = ".grok/agents";
export const BATON_CARD_MARK = "<!-- baton-card -->";

export type Card = Pick<ModelCard, "id"> & Partial<ModelCard>;

export interface HostAgentEnvOptions {
  env?: NodeJS.ProcessEnv;
}

export interface HostAgentSyncResult {
  created: string[];
  pruned: string[];
}

const SAFE_CARD_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** Grok's own models must never be cards/agents under ~/.grok. */
export function isGrokNativeModel(id: unknown): boolean {
  const s = String(id || "").trim().toLowerCase();
  if (!s) return false;
  if (s === "grok" || s === "grok-build") return true;
  return s.startsWith("grok-") || s.startsWith("grok.");
}

export function grokSkillInstalled(_cwd: string, options: HostAgentEnvOptions = {}): boolean {
  return fs.existsSync(path.join(hostHome(options.env), HOST_SKILL_REL.grok));
}

export function grokAgentPath(_cwd: string, id: string, options: HostAgentEnvOptions = {}): string {
  return path.join(hostHome(options.env), ".grok", "agents", `${id}.md`);
}

export function isSafeCardId(id: unknown): boolean {
  return SAFE_CARD_ID.test(String(id || ""));
}

/**
 * Frontmatter matches bundled Grok agents (name, description, model, …).
 * `model` is the documented session pin — never `inherit`.
 */
export function renderGrokCardAgent(card: Card): string {
  const id = String(card.id || "").trim();
  return `---
name: ${id}
description: Baton card worker pinned to model ${id}. Spawn with subagent_type ${id}.
model: ${id}
prompt_mode: full
permission_mode: default
agents_md: true
---

${BATON_CARD_MARK}

Complete the assigned task. Return a short conclusion only. Do not spawn child agents.
`;
}

export function writeGrokCardAgent(cwd: string, card: Card, options: HostAgentEnvOptions = {}): string | null {
  const id = String(card.id || "").trim();
  if (!isSafeCardId(id) || isGrokNativeModel(id)) return null;
  const dest = grokAgentPath(cwd, id, options);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, renderGrokCardAgent({ ...card, id }), "utf8");
  return displayHomePath(dest, { cwd, env: options.env });
}

export function syncGrokCardAgents(
  cwd: string,
  cards: readonly Card[] | null | undefined,
  options: HostAgentEnvOptions = {},
): HostAgentSyncResult {
  const created: string[] = [];
  const keep = new Set<string>();
  for (const card of cards || []) {
    if (card.enabled === false) continue;
    const written = writeGrokCardAgent(cwd, card, options);
    if (!written) continue;
    created.push(written);
    keep.add(String(card.id || "").trim());
  }
  const pruned = pruneStaleGrokCardAgents(cwd, keep, options);
  return { created, pruned };
}

function pruneStaleGrokCardAgents(
  cwd: string,
  keepIds: Set<string>,
  options: HostAgentEnvOptions = {},
): string[] {
  const dir = path.join(hostHome(options.env), ".grok", "agents");
  if (!fs.existsSync(dir)) return [];
  const pruned: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const id = name.slice(0, -3);
    if (keepIds.has(id)) continue;
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes(BATON_CARD_MARK)) continue;
    fs.unlinkSync(file);
    pruned.push(displayHomePath(file, { cwd, env: options.env }));
  }
  return pruned;
}
