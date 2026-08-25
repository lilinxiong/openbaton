import type { OpenSpecTask } from "./openspec.js";

const PATH_EXT = /\.(?:ts|tsx|js|mjs|cjs|json|toml|md|yaml|yml|txt)$/i;
const ROOTED_PATH = /(?:\.{0,2}\/)?(?:src|test|tests|templates|docs|scripts|openspec|\.agents|bin)\/[A-Za-z0-9_./-]+/g;

export interface ApplyWaveTask {
  id: string;
  section: string;
  description: string;
  paths: string[];
}

export interface ApplyWave {
  index: number;
  section: string;
  parallel: boolean;
  task_ids: string[];
  tasks: ApplyWaveTask[];
}

export interface ApplyOrderReady {
  section: string;
  task_ids: string[];
  waves: ApplyWave[];
}

export interface ApplyWavePlan {
  waves: ApplyWave[];
  ready: ApplyWave | null;
  /** First pending section's remaining waves; null when nothing is pending. */
  order_ready: ApplyOrderReady | null;
}

export function applyTaskId(task: Pick<OpenSpecTask, "number" | "line_index">): string {
  return task.number || `line-${task.line_index}`;
}

export function extractMentionedPaths(text: string): string[] {
  const found = new Set<string>();
  const source = String(text || "");
  for (const match of source.matchAll(/`([^`]+)`/g)) addPath(found, match[1]);
  for (const match of source.matchAll(ROOTED_PATH)) addPath(found, match[0]);
  for (const match of source.matchAll(/\b[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]{1,10})+\b/g)) {
    if (PATH_EXT.test(match[0])) addPath(found, match[0]);
  }
  return [...found];
}

function addPath(found: Set<string>, raw: string): void {
  const value = String(raw || "").trim().replace(/^[`'"]+|['"`]+$/g, "").replaceAll("\\", "/").toLowerCase();
  if (!value) return;
  if (!value.includes("/") && !PATH_EXT.test(value)) return;
  if (!value.includes("/")) {
    for (const existing of found) {
      if (existing === value || existing.endsWith(`/${value}`)) return;
    }
  } else {
    found.delete(value.slice(value.lastIndexOf("/") + 1));
  }
  found.add(value);
}

function toWaveTask(task: OpenSpecTask): ApplyWaveTask {
  const paths = extractMentionedPaths(task.description);
  return {
    id: applyTaskId(task),
    section: task.section,
    description: task.description,
    paths,
  };
}

function makeWave(index: number, section: string, group: OpenSpecTask[]): ApplyWave {
  const tasks = group.map(toWaveTask);
  return {
    index,
    section,
    parallel: tasks.length > 1,
    task_ids: tasks.map((task) => task.id),
    tasks,
  };
}

function splitPathClusters(sectionTasks: OpenSpecTask[]): OpenSpecTask[][] {
  const segments: OpenSpecTask[][] = [];
  let current: OpenSpecTask[] = [];
  const flush = (): void => {
    if (!current.length) return;
    segments.push(current);
    current = [];
  };
  for (const task of sectionTasks) {
    const mapped = toWaveTask(task);
    if (mapped.paths.length === 0) {
      flush();
      segments.push([task]);
      continue;
    }
    current.push(task);
  }
  flush();

  const clusters: OpenSpecTask[][] = [];
  for (const segment of segments) {
    if (segment.length <= 1) {
      clusters.push(segment);
      continue;
    }
    const remaining = [...segment];
    while (remaining.length) {
      const group: OpenSpecTask[] = [];
      const used = new Set<string>();
      for (let index = 0; index < remaining.length; ) {
        const paths = extractMentionedPaths(remaining[index].description);
        if (paths.some((path) => used.has(path))) {
          index += 1;
          continue;
        }
        for (const path of paths) used.add(path);
        group.push(remaining.splice(index, 1)[0]);
      }
      clusters.push(group);
    }
  }
  return clusters;
}

/** Overlay waves over original pending OpenSpec tasks. Does not rewrite tasks.md. */
export function planApplyWaves(tasks: OpenSpecTask[]): ApplyWavePlan {
  const pending = tasks.filter((task) => task.status === "pending");
  const sectionOrder: string[] = [];
  const bySection = new Map<string, OpenSpecTask[]>();
  for (const task of pending) {
    const section = task.section || "";
    if (!bySection.has(section)) {
      bySection.set(section, []);
      sectionOrder.push(section);
    }
    bySection.get(section)!.push(task);
  }

  const waves: ApplyWave[] = [];
  for (const section of sectionOrder) {
    for (const group of splitPathClusters(bySection.get(section) || [])) {
      waves.push(makeWave(waves.length, section, group));
    }
  }

  const ready = waves[0] || null;
  let order_ready: ApplyOrderReady | null = null;
  if (ready) {
    const sectionWaves = waves.filter((wave) => wave.section === ready.section);
    const seen = new Set<string>();
    const task_ids: string[] = [];
    for (const wave of sectionWaves) {
      for (const id of wave.task_ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        task_ids.push(id);
      }
    }
    order_ready = { section: ready.section, task_ids, waves: sectionWaves };
  }

  return { waves, ready, order_ready };
}
