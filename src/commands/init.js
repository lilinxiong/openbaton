import fs from "node:fs";
import path from "node:path";
import { packageRoot, batonDir, configPath, skillPath } from "../lib/paths.js";

export function initProject(cwd, { force = false } = {}) {
  const dir = batonDir(cwd);
  const created = [];
  const skipped = [];
  fs.mkdirSync(dir, { recursive: true });

  const tmplRoot = packageRoot();
  const configTmpl = path.join(tmplRoot, "templates", "config.toml");
  const skillTmpl = path.join(tmplRoot, "SKILL.md");
  const destConfig = configPath(cwd);
  const destSkill = skillPath(cwd);

  if (!fs.existsSync(destConfig) || force) {
    fs.copyFileSync(configTmpl, destConfig);
    created.push(rel(cwd, destConfig));
  } else {
    skipped.push(rel(cwd, destConfig));
  }

  if (!fs.existsSync(destSkill) || force) {
    fs.copyFileSync(skillTmpl, destSkill);
    created.push(rel(cwd, destSkill));
  } else {
    skipped.push(rel(cwd, destSkill));
  }

  return { dir: rel(cwd, dir), created, skipped };
}

function rel(cwd, p) {
  return path.relative(cwd, p) || p;
}
