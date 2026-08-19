import fs from "node:fs";
import path from "node:path";
import { fetchArtificialAnalysisModels } from "../lib/capabilities/aa.js";
import {
  loadRouteMappings,
  queryRouteCapability,
  readCapabilityStatus,
  writeCapabilitySnapshot,
} from "../lib/capabilities/store.js";
import { artificialAnalysisDbPath, artificialAnalysisManifestPath } from "../lib/paths.js";

const USAGE = `usage:
  baton capabilities refresh --provider aa --key-file PATH [--json]
  baton capabilities status [--json]
  baton capabilities show ROUTE [--profile PROFILE] [--json]
`;

function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const current = args[i];
    if (!current.startsWith("--")) continue;
    const key = current.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else out[key] = true;
  }
  return out;
}

function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      if (args[i + 1] && !args[i + 1].startsWith("--")) i += 1;
    } else out.push(args[i]);
  }
  return out;
}

function readKey(file, env) {
  if (!file) {
    const key = String(env.AA_API_KEY || "").trim();
    if (!key) throw new Error("Artificial Analysis key is required; use --key-file PATH or AA_API_KEY");
    return key;
  }
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("Artificial Analysis key path is not a regular file");
  if ((stat.mode & 0o077) !== 0) throw new Error("Artificial Analysis key file must not be readable by group or others (use mode 0600)");
  const key = fs.readFileSync(file, "utf8").trim();
  if (!key) throw new Error("Artificial Analysis key file is empty");
  return key;
}

function printJson(stdout, value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function runCapabilities(args, { cwd, stdout, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const sub = args[0] || "status";
  const rest = args.slice(1);
  const opts = flags(rest);
  const dbPath = opts.db ? path.resolve(cwd, String(opts.db)) : artificialAnalysisDbPath(cwd);
  const manifestPath = opts.manifest ? path.resolve(cwd, String(opts.manifest)) : artificialAnalysisManifestPath(cwd);

  if (sub === "refresh") {
    const provider = String(opts.provider || "aa").toLowerCase();
    if (provider !== "aa" && provider !== "artificial-analysis") throw new Error("only the artificial-analysis capability provider is supported");
    const apiKey = readKey(opts["key-file"], env);
    const result = await fetchArtificialAnalysisModels({ apiKey, fetchImpl });
    const mappings = loadRouteMappings(opts.mappings ? path.resolve(cwd, String(opts.mappings)) : undefined);
    const manifest = await writeCapabilitySnapshot({ dbPath, manifestPath, models: result.models, metadata: result.metadata, mappings });
    if (opts.json) printJson(stdout, { ...manifest, dbPath, manifestPath });
    else {
      stdout.write("refreshed Artificial Analysis capability cache\n");
      stdout.write(`  tier: ${manifest.tier}\n`);
      stdout.write(`  index: ${manifest.indexVersion}\n`);
      stdout.write(`  models: ${manifest.modelCount}\n`);
      stdout.write(`  mappings: ${manifest.mappingCount}\n`);
      stdout.write(`  database: ${path.relative(cwd, dbPath) || dbPath}\n`);
    }
    return 0;
  }

  if (sub === "status") {
    const status = await readCapabilityStatus({ dbPath });
    if (opts.json) printJson(stdout, status);
    else if (!status.exists) stdout.write("Artificial Analysis capability cache: missing\n");
    else {
      stdout.write("Artificial Analysis capability cache\n");
      stdout.write(`  tier: ${status.tier}\n`);
      stdout.write(`  index: ${status.indexVersion}\n`);
      stdout.write(`  fetched: ${status.fetchedAt}\n`);
      stdout.write(`  models: ${status.modelCount}\n`);
      stdout.write(`  mappings: ${status.mappingCount}\n`);
    }
    return status.exists ? 0 : 1;
  }

  if (sub === "show") {
    const routeId = positionals(rest)[0];
    if (!routeId) throw new Error(USAGE.trim());
    const capability = await queryRouteCapability({ dbPath, routeId, profile: opts.profile || "" });
    if (opts.json) printJson(stdout, capability);
    else if (capability.unranked) stdout.write(`${routeId}: unranked (${capability.reason})\n`);
    else {
      stdout.write(`${routeId}: ${capability.model.name} [${capability.aaSlug}]\n`);
      stdout.write(`  intelligence: ${capability.model.evaluations.artificial_analysis_intelligence_index ?? "n/a"}\n`);
      stdout.write(`  coding: ${capability.model.evaluations.artificial_analysis_coding_index ?? "n/a"}\n`);
      stdout.write(`  agentic: ${capability.model.evaluations.artificial_analysis_agentic_index ?? "n/a"}\n`);
    }
    return 0;
  }

  throw new Error(USAGE.trim());
}
