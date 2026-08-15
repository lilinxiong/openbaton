/**
 * Grok host adapter: one project agent per card.
 * Official spawn_subagent has no model param; the agent definition pins it.
 * Project .grok/config.toml does not load [subagents], so agents/*.md is the pin.
 */
import fs from "node:fs";
import path from "node:path";
import { HOST_SKILL_REL } from "./hosts.js";

export const GROK_AGENTS_DIR = ".grok/agents";
export const BATON_CARD_MARK = "<!-- baton-card -->";

const SAFE_CARD_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

export function grokSkillInstalled(cwd) {
  return fs.existsSync(path.join(cwd, HOST_SKILL_REL.grok));
}

export function grokAgentPath(cwd, id) {
  return path.join(cwd, GROK_AGENTS_DIR, `${id}.md`);
}

export function isSafeCardId(id) {
  return SAFE_CARD_ID.test(String(id || ""));
}

/**
 * Frontmatter matches bundled Grok agents (name, description, model, …).
 * `model` is the documented session pin — never `inherit`.
 */
export function renderGrokCardAgent(card) {
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

export function writeGrokCardAgent(cwd, card) {
  const id = String(card.id || "").trim();
  if (!isSafeCardId(id)) return null;
  const dest = grokAgentPath(cwd, id);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, renderGrokCardAgent({ ...card, id }), "utf8");
  return rel(cwd, dest);
}

export function syncGrokCardAgents(cwd, cards) {
  const created = [];
  const keep = new Set();
  for (const card of cards || []) {
    const written = writeGrokCardAgent(cwd, card);
    if (!written) continue;
    created.push(written);
    keep.add(String(card.id || "").trim());
  }
  const pruned = pruneStaleGrokCardAgents(cwd, keep);
  return { created, pruned };
}

function pruneStaleGrokCardAgents(cwd, keepIds) {
  const dir = path.join(cwd, GROK_AGENTS_DIR);
  if (!fs.existsSync(dir)) return [];
  const pruned = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".md")) continue;
    const id = name.slice(0, -3);
    if (keepIds.has(id)) continue;
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes(BATON_CARD_MARK)) continue;
    fs.unlinkSync(file);
    pruned.push(rel(cwd, file));
  }
  return pruned;
}

function rel(cwd, p) {
  return path.relative(cwd, p) || p;
}
