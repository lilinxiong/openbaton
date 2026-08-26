import readline from "node:readline";
import type { WritableLike } from "../types.js";

export interface PromptChoice<T> {
  value: T;
  label: string;
  hint?: string;
}

export interface SelectPromptOptions<T> {
  message: string;
  choices: PromptChoice<T>[];
  initial?: T;
}

export interface MultiSelectPromptOptions<T> {
  message: string;
  choices: PromptChoice<T>[];
  initial?: T[];
  required?: boolean;
}

export interface SelectPrompt {
  select<T>(options: SelectPromptOptions<T>): Promise<T>;
  multiSelect<T>(options: MultiSelectPromptOptions<T>): Promise<T[]>;
}

export interface TerminalPromptOptions {
  stdin: NodeJS.ReadableStream;
  stdout: WritableLike;
  env?: NodeJS.ProcessEnv;
  pageSize?: number;
}

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const CLEAR_LINE = "\x1b[2K";
const CLEAR_DOWN = "\x1b[J";

export function isInteractiveIo(stdin?: NodeJS.ReadableStream, stdout?: WritableLike): boolean {
  return Boolean(
    stdin && (stdin as NodeJS.ReadStream).isTTY
    && stdout && (stdout as NodeJS.WriteStream).isTTY,
  );
}

export function createTerminalPrompt({
  stdin,
  stdout,
  env = process.env,
  pageSize,
}: TerminalPromptOptions): SelectPrompt {
  return {
    select: <T>(options: SelectPromptOptions<T>) => runSelect(options, {
      stdin, stdout, env, pageSize, multiple: false,
    }) as Promise<T>,
    multiSelect: <T>(options: MultiSelectPromptOptions<T>) => runSelect(options, {
      stdin, stdout, env, pageSize, multiple: true,
    }) as Promise<T[]>,
  };
}

interface RunOptions extends TerminalPromptOptions {
  multiple: boolean;
}

async function runSelect<T>(
  options: SelectPromptOptions<T> | MultiSelectPromptOptions<T>,
  { stdin, stdout, env = process.env, pageSize, multiple }: RunOptions,
): Promise<T | T[]> {
  const choices = options.choices;
  if (!choices.length) throw new Error("prompt requires at least one choice");
  if (!isInteractiveIo(stdin, stdout)) {
    throw new Error("interactive prompts require a TTY. Pass flags for non-interactive use");
  }

  const color = colorEnabled(stdout, env);
  const paint = palette(color);
  const rows = terminalRows(stdout);
  const cols = Math.max(20, terminalColumns(stdout));
  const viewSize = Math.max(1, Math.min(choices.length, pageSize || Math.min(12, Math.max(3, rows - 6))));
  const selected = new Set<number>();
  const selectedOrder: number[] = [];
  if (multiple) {
    const initial = ((options as MultiSelectPromptOptions<T>).initial || []) as T[];
    for (const value of initial) {
      const index = choices.findIndex((choice) => Object.is(value, choice.value));
      if (index >= 0 && !selected.has(index)) {
        selected.add(index);
        selectedOrder.push(index);
      }
    }
  }
  let active = multiple
    ? (selectedOrder.length ? selectedOrder[0] : 0)
    : initialIndex(choices, (options as SelectPromptOptions<T>).initial);
  let windowStart = Math.min(Math.max(0, active - Math.floor(viewSize / 2)), Math.max(0, choices.length - viewSize));
  const required = multiple && Boolean((options as MultiSelectPromptOptions<T>).required);
  const menu = new LiveMenu(stdout);

  const render = (): void => {
    if (active < windowStart) windowStart = active;
    if (active >= windowStart + viewSize) windowStart = active - viewSize + 1;
    const lines: string[] = [`${paint.cyan}?${paint.reset} ${paint.bold}${options.message}${paint.reset}`];
    if (multiple) {
      lines.push(`${paint.dim}  space toggle · a all · enter confirm${required ? " · at least one" : ""}${paint.reset}`);
    }
    if (windowStart > 0) lines.push(`${paint.dim}  ↑ more${paint.reset}`);
    const end = Math.min(choices.length, windowStart + viewSize);
    for (let index = windowStart; index < end; index += 1) {
      const choice = choices[index];
      const pointer = index === active ? `${paint.cyan}❯${paint.reset}` : " ";
      const mark = multiple ? (selected.has(index) ? `${paint.green}◉${paint.reset}` : "◯") : "";
      const hint = choice.hint ? `${paint.dim} — ${choice.hint}${paint.reset}` : "";
      const prefix = multiple ? `${pointer} ${mark} ` : `${pointer} `;
      lines.push(clip(`${prefix}${choice.label}${hint}`, cols));
    }
    if (end < choices.length) lines.push(`${paint.dim}  ↓ more${paint.reset}`);
    if (multiple) lines.push(`${paint.dim}  ${selected.size} selected${paint.reset}`);
    menu.render(lines);
  };

  menu.hideCursor();
  try {
    render();
    await readKeys(stdin, (key) => {
      if ((key.ctrl && key.name === "c") || key.name === "escape") throw new Error("cancelled");
      if (key.name === "up" || key.name === "k") {
        active = (active + choices.length - 1) % choices.length;
        render();
        return;
      }
      if (key.name === "down" || key.name === "j") {
        active = (active + 1) % choices.length;
        render();
        return;
      }
      if (multiple && key.name === "space") {
        if (selected.has(active)) {
          selected.delete(active);
          const index = selectedOrder.indexOf(active);
          if (index >= 0) selectedOrder.splice(index, 1);
        } else {
          selected.add(active);
          selectedOrder.push(active);
        }
        render();
        return;
      }
      if (multiple && key.name === "a") {
        if (selected.size === choices.length) {
          selected.clear();
          selectedOrder.splice(0, selectedOrder.length);
        } else {
          selected.clear();
          selectedOrder.splice(0, selectedOrder.length, ...choices.map((_, index) => index));
          for (const index of selectedOrder) selected.add(index);
        }
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        if (required && selected.size === 0) return;
        return true;
      }
    });
    const summaryValue = multiple
      ? selectedOrder.map((index) => choices[index].label).join(", ") || "(none)"
      : choices[active].label;
    menu.finish(`${paint.green}✔${paint.reset} ${options.message} ${paint.cyan}${summaryValue}${paint.reset}`);
    if (multiple) {
      return selectedOrder.map((index) => choices[index].value);
    }
    return choices[active].value;
  } catch (cause) {
    menu.fail(`${paint.dim}✖ ${options.message}${paint.reset}`);
    throw cause;
  } finally {
    menu.showCursor();
  }
}

function initialIndex<T>(choices: PromptChoice<T>[], initial: T | undefined): number {
  if (initial === undefined) return 0;
  const index = choices.findIndex((choice) => Object.is(choice.value, initial));
  return index >= 0 ? index : 0;
}

class LiveMenu {
  private rendered = 0;

  constructor(private readonly stdout: WritableLike) {}

  hideCursor(): void {
    this.stdout.write(HIDE_CURSOR);
  }

  showCursor(): void {
    this.stdout.write(SHOW_CURSOR);
  }

  render(lines: string[]): void {
    if (this.rendered > 0) this.stdout.write(`\x1b[${this.rendered}A`);
    for (const line of lines) this.stdout.write(`${CLEAR_LINE}\r${line}\n`);
    if (lines.length < this.rendered) {
      const extra = this.rendered - lines.length;
      for (let index = 0; index < extra; index += 1) this.stdout.write(`${CLEAR_LINE}\r\n`);
      this.stdout.write(`\x1b[${extra}A`);
    }
    this.rendered = lines.length;
  }

  finish(summary: string): void {
    this.clear();
    this.stdout.write(`${summary}\n`);
  }

  fail(summary: string): void {
    this.clear();
    this.stdout.write(`${summary}\n`);
  }

  private clear(): void {
    if (this.rendered > 0) this.stdout.write(`\x1b[${this.rendered}A\r${CLEAR_DOWN}`);
    this.rendered = 0;
  }
}

function readKeys(
  stdin: NodeJS.ReadableStream,
  onKey: (key: readline.Key) => boolean | void,
): Promise<void> {
  readline.emitKeypressEvents(stdin);
  const tty = stdin as NodeJS.ReadStream;
  const wasRaw = Boolean(tty.isRaw);
  if (typeof tty.setRawMode === "function") {
    try { tty.setRawMode(true); } catch { /* ignore non-TTY test streams */ }
  }
  if (typeof tty.resume === "function") tty.resume();

  return new Promise((resolve, reject) => {
    const stop = (action: () => void): void => {
      stdin.off("keypress", handle);
      stdin.off("error", fail);
      stdin.off("end", cancel);
      if (typeof tty.setRawMode === "function") {
        try { tty.setRawMode(wasRaw); } catch { /* ignore */ }
      }
      // emitKeypressEvents + resume() leaves stdin flowing. The CLI
      // entrypoint sets process.exitCode instead of process.exit(), so a
      // flowing TTY would keep `baton config` alive after it prints.
      if (typeof tty.pause === "function") tty.pause();
      action();
    };
    const fail = (cause: unknown): void => stop(() => reject(cause instanceof Error ? cause : new Error(String(cause))));
    const cancel = (): void => fail(new Error("cancelled"));
    const handle = (str: string, key: readline.Key | undefined): void => {
      const resolved: readline.Key = key && key.name ? key : {
        name: str === "\r" || str === "\n" ? "return"
          : str === " " ? "space"
          : str === "\x03" ? "c"
          : str === "\x1b[A" ? "up"
          : str === "\x1b[B" ? "down"
          : str === "a" || str === "A" ? "a"
          : str === "j" ? "j"
          : str === "k" ? "k"
          : str === "\x1b" ? "escape"
          : undefined,
        ctrl: str === "\x03" || Boolean(key?.ctrl),
        sequence: str,
      };
      if (!resolved.name) return;
      try {
        if (onKey(resolved) === true) stop(resolve);
      } catch (cause) {
        fail(cause);
      }
    };
    stdin.on("keypress", handle);
    stdin.once("error", fail);
    stdin.once("end", cancel);
  });
}

function colorEnabled(stdout: WritableLike, env: NodeJS.ProcessEnv): boolean {
  if (String(env.NO_COLOR || "").trim()) return false;
  if (String(env.FORCE_COLOR || "").trim()) return true;
  return Boolean((stdout as NodeJS.WriteStream).isTTY);
}

function palette(enabled: boolean): { reset: string; cyan: string; green: string; dim: string; bold: string } {
  if (!enabled) return { reset: "", cyan: "", green: "", dim: "", bold: "" };
  return {
    reset: "\x1b[0m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
  };
}

function terminalColumns(stdout: WritableLike): number {
  const columns = (stdout as NodeJS.WriteStream).columns;
  return Number.isInteger(columns) && columns > 0 ? columns : 80;
}

function terminalRows(stdout: WritableLike): number {
  const rows = (stdout as NodeJS.WriteStream).rows;
  return Number.isInteger(rows) && rows > 0 ? rows : 24;
}

function clip(text: string, width: number): string {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (plain.length <= width) return text;
  if (width <= 1) return "…";
  const budget = width - 1;
  let visible = 0;
  let index = 0;
  while (index < text.length && visible < budget) {
    if (text[index] === "\x1b") {
      const end = text.indexOf("m", index);
      if (end < 0) break;
      index = end + 1;
      continue;
    }
    visible += 1;
    index += 1;
  }
  return `${text.slice(0, index)}…`;
}
