import fs from "node:fs";
import path from "node:path";
import { packageRoot } from "./paths.js";

export const HOST_IDS = ["claude", "cursor", "grok", "codex", "agents"];

export const HOST_SKILL_REL = {
  claude: ".claude/skills/baton/SKILL.md",
  cursor: ".cursor/skills/baton/SKILL.md",
  grok: ".grok/skills/baton/SKILL.md",
  codex: ".codex/skills/baton/SKILL.md",
  agents: ".agents/skills/baton/SKILL.md",
};

export const AGENTS_MD = "AGENTS.md";
export const AGENTS_POINTER_MARK = "<!-- baton -->";

export const AGENTS_POINTER = `${AGENTS_POINTER_MARK}
Director: use the baton skill (\`.baton/SKILL.md\`) for card-routed host-native spawn.`;

export function normalizeTools(tools) {
  if (tools == null) return [...HOST_IDS];
  const list = Array.isArray(tools) ? tools : String(tools).split(",");
  const out = [];
  const unknown = [];
  for (const raw of list) {
    const id = String(raw || "").trim().toLowerCase();
    if (!id) continue;
    if (!HOST_IDS.includes(id)) unknown.push(id);
    else if (!out.includes(id)) out.push(id);
  }
  if (unknown.length) {
    throw new Error(`unknown --tools: ${unknown.join(", ")}. Valid: ${HOST_IDS.join(", ")}`);
  }
  if (!out.length) {
    throw new Error(`--tools is empty. Valid: ${HOST_IDS.join(", ")}`);
  }
  return out;
}

export function skillTemplatePath(tool) {
  const root = packageRoot();
  const hostTmpl = path.join(root, "templates", "hosts", tool, "SKILL.md");
  if (fs.existsSync(hostTmpl)) return hostTmpl;
  return path.join(root, "SKILL.md");
}

export function agentsTemplatePath() {
  return path.join(packageRoot(), "templates", "hosts", "AGENTS.md");
}

export function hasBatonPointer(text) {
  return /<!--\s*baton\s*-->|\.baton\/SKILL\.md|skills\/baton/i.test(String(text || ""));
}

function rel(cwd, p) {
  return path.relative(cwd, p) || p;
}

function copySkill(src, dest, { force, cwd, created, skipped }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && !force) {
    skipped.push(rel(cwd, dest));
    return false;
  }
  fs.copyFileSync(src, dest);
  created.push(rel(cwd, dest));
  return true;
}

export function installHostSkills(cwd, { force = false, tools } = {}) {
  const hostTools = normalizeTools(tools);
  const created = [];
  const skipped = [];
  for (const tool of hostTools) {
    const dest = path.join(cwd, HOST_SKILL_REL[tool]);
    copySkill(skillTemplatePath(tool), dest, { force, cwd, created, skipped });
  }
  const agents = ensureAgentsPointer(cwd, {
    createIfMissing: hostTools.includes("agents"),
  });
  created.push(...agents.created);
  skipped.push(...agents.skipped);
  return { tools: hostTools, created, skipped };
}

export function refreshInstalledHostSkills(cwd) {
  const actions = [];
  for (const tool of HOST_IDS) {
    const dest = path.join(cwd, HOST_SKILL_REL[tool]);
    if (!fs.existsSync(dest)) continue;
    fs.copyFileSync(skillTemplatePath(tool), dest);
    actions.push(`updated ${rel(cwd, dest)}`);
  }
  const agents = ensureAgentsPointer(cwd, { createIfMissing: false });
  for (const f of agents.created) actions.push(`updated ${f}`);
  return { actions };
}

export function ensureAgentsPointer(cwd, { createIfMissing = false } = {}) {
  const dest = path.join(cwd, AGENTS_MD);
  const created = [];
  const skipped = [];
  if (fs.existsSync(dest)) {
    const current = fs.readFileSync(dest, "utf8");
    if (hasBatonPointer(current)) {
      skipped.push(rel(cwd, dest));
      return { created, skipped };
    }
    const prefix = current.endsWith("\n") || current.length === 0 ? current : `${current}\n`;
    fs.writeFileSync(dest, `${prefix}\n${AGENTS_POINTER}\n`, "utf8");
    created.push(rel(cwd, dest));
    return { created, skipped };
  }
  if (!createIfMissing) return { created, skipped };
  const tmpl = agentsTemplatePath();
  const body = fs.existsSync(tmpl) ? fs.readFileSync(tmpl, "utf8") : `# Agents\n\n${AGENTS_POINTER}\n`;
  fs.writeFileSync(dest, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  created.push(rel(cwd, dest));
  return { created, skipped };
}
