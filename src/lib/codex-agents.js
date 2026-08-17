/**
 * Codex host adapter: one user-home agent per card.
 * Official spawn has no model param; the agent definition pins it.
 * Never write ChatGPT/OpenAI native models into ~/.codex agents or config.
 */
import fs from "node:fs";
import path from "node:path";
import { hostHome, displayHomePath } from "./paths.js";
import { HOST_SKILL_REL } from "./hosts.js";

export const CODEX_AGENTS_DIR = ".codex/agents";
export const BATON_CARD_MARK = "# baton-card";

const SAFE_CARD_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** ChatGPT / OpenAI native models must never be cards/agents under ~/.codex. */
export function isChatGptNativeModel(id) {
  const s = String(id || "").trim().toLowerCase();
  if (!s) return false;
  if (s.startsWith("gpt-") || s === "gpt" || /^gpt\d/.test(s)) return true;
  if (s.startsWith("o1") || s.startsWith("o3") || s.startsWith("o4")) return true;
  if (s.includes("chatgpt")) return true;
  if (s === "codex-mini" || s.startsWith("codex-mini")) return true;
  return false;
}

export function codexSkillInstalled(_cwd, { env } = {}) {
  return fs.existsSync(path.join(hostHome(env), HOST_SKILL_REL.codex));
}

export function codexAgentPath(_cwd, id, { env } = {}) {
  return path.join(hostHome(env), ".codex", "agents", `${id}.toml`);
}

export function isSafeCardId(id) {
  return SAFE_CARD_ID.test(String(id || ""));
}

export function renderCodexCardAgent(card) {
  const id = String(card.id || "").trim();
  const desc = "Baton card worker pinned to model " + id + ". Spawn with agent_type " + id + ".";
  const body = BATON_CARD_MARK + "\nComplete the assigned task. Return a short conclusion only. Do not spawn child agents.\n";
  return [
    "name = " + JSON.stringify(id),
    "description = " + JSON.stringify(desc),
    "model = " + JSON.stringify(id),
    "developer_instructions = " + JSON.stringify(body),
    "",
  ].join("\n");
}

export function writeCodexCardAgent(cwd, card, { env } = {}) {
  const id = String(card.id || "").trim();
  if (!isSafeCardId(id) || isChatGptNativeModel(id)) return null;
  const dest = codexAgentPath(cwd, id, { env });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, renderCodexCardAgent({ ...card, id }), "utf8");
  return displayHomePath(dest, { cwd, env });
}

export function syncCodexCardAgents(cwd, cards, { env } = {}) {
  const created = [];
  const keep = new Set();
  for (const card of cards || []) {
    const written = writeCodexCardAgent(cwd, card, { env });
    if (!written) continue;
    created.push(written);
    keep.add(String(card.id || "").trim());
  }
  const pruned = pruneStaleCodexCardAgents(cwd, keep, { env });
  return { created, pruned };
}

function pruneStaleCodexCardAgents(cwd, keepIds, { env } = {}) {
  const dir = path.join(hostHome(env), ".codex", "agents");
  if (!fs.existsSync(dir)) return [];
  const pruned = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".toml")) continue;
    const id = name.slice(0, -5);
    if (keepIds.has(id)) continue;
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes(BATON_CARD_MARK)) continue;
    fs.unlinkSync(file);
    pruned.push(displayHomePath(file, { cwd, env }));
  }
  return pruned;
}
