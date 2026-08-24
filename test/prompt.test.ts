import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { createTerminalPrompt, isInteractiveIo } from "../src/lib/prompt.js";

function fakeTty(env: NodeJS.ProcessEnv = { NO_COLOR: "1" }) {
  const stdin = new PassThrough();
  const chunks: string[] = [];
  const stdout = new PassThrough();
  Object.assign(stdin, {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) { this.isRaw = value; },
  });
  Object.assign(stdout, { isTTY: true, columns: 80, rows: 24, write(chunk: unknown) {
    chunks.push(String(chunk));
    return true;
  } });
  const prompt = createTerminalPrompt({ stdin, stdout, env, pageSize: 4 });
  return {
    stdin,
    prompt,
    text: () => chunks.join(""),
  };
}

function visibleNow(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

describe("terminal select prompts", () => {
  it("selects with arrow keys and enter instead of typed input", async () => {
    const tty = fakeTty();
    const pending = tty.prompt.select({
      message: "Select CLI",
      choices: [
        { value: "codex", label: "codex" },
        { value: "grok", label: "grok" },
      ],
    });
    tty.stdin.write("\x1b[B");
    tty.stdin.write("\r");
    assert.equal(await pending, "grok");
    assert.match(visibleNow(tty.text()), /✔ Select CLI grok/);
  });

  it("multi-selects models with space and a", async () => {
    const tty = fakeTty();
    const pending = tty.prompt.multiSelect({
      message: "Select models callable by subagents",
      choices: [
        { value: "grok-4.5", label: "Grok 4.5 (grok-4.5)" },
        { value: "grok-4.6", label: "Grok 4.6 (grok-4.6)" },
        { value: "grok-3", label: "Grok 3 (grok-3)" },
      ],
    });
    tty.stdin.write(" ");
    tty.stdin.write("\x1b[B");
    tty.stdin.write(" ");
    tty.stdin.write("\r");
    assert.deepEqual(await pending, ["grok-4.5", "grok-4.6"]);

    const all = fakeTty();
    const allPending = all.prompt.multiSelect({
      message: "Select models callable by subagents",
      choices: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });
    all.stdin.write("a");
    all.stdin.write("\r");
    assert.deepEqual(await allPending, ["a", "b"]);
  });

  it("does not confirm a required multi-select with nothing chosen", async () => {
    const tty = fakeTty();
    const pending = tty.prompt.multiSelect({
      message: "Select CLI",
      choices: [
        { value: "codex", label: "codex" },
        { value: "grok", label: "grok" },
      ],
      required: true,
    });
    tty.stdin.write("\r");
    tty.stdin.write(" ");
    tty.stdin.write("\r");
    assert.deepEqual(await pending, ["codex"]);
  });

  it("cancels on ctrl+c", async () => {
    const tty = fakeTty();
    const pending = tty.prompt.select({
      message: "Select CLI",
      choices: [{ value: "codex", label: "codex" }],
    });
    tty.stdin.write("\x03");
    await assert.rejects(pending, /cancelled/);
  });

  it("requires a TTY for interactive prompts", () => {
    const stdin = new PassThrough();
    const stdout = { write() { return true; } };
    assert.equal(isInteractiveIo(stdin, stdout), false);
    const prompt = createTerminalPrompt({ stdin, stdout });
    return assert.rejects(
      prompt.select({ message: "Select CLI", choices: [{ value: "codex", label: "codex" }] }),
      /interactive prompts require a TTY/,
    );
  });
});
