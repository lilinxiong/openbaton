/**
 * Codex host adapter: director-only on this ChatGPT account.
 * Official spawn has no model param; the agent definition would pin it.
 * Never write ChatGPT/OpenAI native models into ~/.codex agents or config.
 * Never write Kimi/MiMo/non-Codex-native cards — this host cannot run them.
 */
import fs from "node:fs";
import path from "node:path";
import type { ModelCard } from "../types.js";
import { hostHome, displayHomePath } from "./paths.js";
import { HOST_SKILL_REL } from "./hosts.js";

export const CODEX_AGENTS_DIR = ".codex/agents";
export const BATON_CARD_MARK = "# baton-card";

export type Card = Pick<ModelCard, "id"> & Partial<ModelCard>;

export interface HostAgentEnvOptions {
  env?: NodeJS.ProcessEnv;
}

export interface HostAgentSyncResult {
  created: string[];
  pruned: string[];
}

const SAFE_CARD_ID = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** Current default cards — none are Codex-native. */
const DEFAULT_NON_CODEX_CARDS = new Set([
  "k3",
  "k3-256k",
  "kimi-for-coding",
  "kimi-for-coding-highspeed",
  "mimo-v2.5",
  "mimo-v2.5-pro",
]);

/** ChatGPT / OpenAI native models must never be cards/agents under ~/.codex. */
export function isChatGptNativeModel(id: unknown): boolean {
  const s = String(id || "").trim().toLowerCase();
  if (!s) return false;
  if (s.startsWith("gpt-") || s === "gpt" || /^gpt\d/.test(s)) return true;
  if (s.startsWith("o1") || s.startsWith("o3") || s.startsWith("o4")) return true;
  if (s.includes("chatgpt")) return true;
  if (s === "codex-mini" || s.startsWith("codex-mini")) return true;
  return false;
}

/**
 * True only if this ChatGPT account can run the card as a worker.
 * ChatGPT-native models are never cards. Current defaults (k3, kimi-*,
 * mimo-*) and any other non-Codex-native id are not spawnable. No
 * ChatGPT stand-in.
 */
export function isCodexSpawnableCard(id: unknown): boolean {
  const s = String(id || "").trim();
  if (!s) return false;
  if (isChatGptNativeModel(s)) return false;
  const lower = s.toLowerCase();
  if (DEFAULT_NON_CODEX_CARDS.has(lower)) return false;
  // Codex ChatGPT cannot run Kimi/MiMo or any other third-party card.
  return false;
}

export function codexSkillInstalled(_cwd: string, options: HostAgentEnvOptions = {}): boolean {
  return fs.existsSync(path.join(hostHome(options.env), HOST_SKILL_REL.codex));
}

export function codexAgentPath(_cwd: string, id: string, options: HostAgentEnvOptions = {}): string {
  return path.join(hostHome(options.env), ".codex", "agents", `${id}.toml`);
}

export function isSafeCardId(id: unknown): boolean {
  return SAFE_CARD_ID.test(String(id || ""));
}

export function renderCodexCardAgent(card: Card): string {
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

export function writeCodexCardAgent(cwd: string, card: Card, options: HostAgentEnvOptions = {}): string | null {
  const id = String(card.id || "").trim();
  if (!isSafeCardId(id) || isChatGptNativeModel(id) || !isCodexSpawnableCard(id)) return null;
  const dest = codexAgentPath(cwd, id, options);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, renderCodexCardAgent({ ...card, id }), "utf8");
  return displayHomePath(dest, { cwd, env: options.env });
}

export function syncCodexCardAgents(
  cwd: string,
  cards: readonly Card[] | null | undefined,
  options: HostAgentEnvOptions = {},
): HostAgentSyncResult {
  const created: string[] = [];
  const keep = new Set<string>();
  for (const card of cards || []) {
    const written = writeCodexCardAgent(cwd, card, options);
    if (!written) continue;
    created.push(written);
    keep.add(String(card.id || "").trim());
  }
  const pruned = pruneStaleCodexCardAgents(cwd, keep, options);
  return { created, pruned };
}

function pruneStaleCodexCardAgents(
  cwd: string,
  keepIds: Set<string>,
  options: HostAgentEnvOptions = {},
): string[] {
  const dir = path.join(hostHome(options.env), ".codex", "agents");
  if (!fs.existsSync(dir)) return [];
  const pruned: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".toml")) continue;
    const id = name.slice(0, -5);
    if (keepIds.has(id)) continue;
    const file = path.join(dir, name);
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes(BATON_CARD_MARK)) continue;
    fs.unlinkSync(file);
    pruned.push(displayHomePath(file, { cwd, env: options.env }));
  }
  return pruned;
}
