# Baton

[English](README.md) | **中文**

Baton 2.0 面向宿主原生 CLI：发现模型、选择精确原生路由，并输出结构化 handoff。它不运行 managed ticket，也不调度另一个 CLI。`spawn` 返回 `spawned: false`，由宿主决定是否执行。

捆绑的宿主包括 Codex（`--cli codex`）和 Grok（`--cli grok`）。已安装的 host
skill 只能显式触发：Codex 用 `$baton`，Grok 用 `/baton`。

需要 Node.js 22.5+。命令示例：

~~~bash
baton init --cli <host>
baton config --cli <host> --implementation-model <model-id> --enable
baton models --host <host>
baton match --host <host> --work-mode implementation
baton spawn --brief brief.json --host <host> --work-mode implementation --json
~~~

每种工作方式使用独立且有序的模型候选池，不会跨组回退。主 agent 根据当前任务通过 `--effort` 指定推理强度；省略时保持宿主默认行为，不按工作方式预设强度。

详见 [docs/guide.zh.md](docs/guide.zh.md) 与 [入门 walkthrough](samples/getting-started/)。

~~~bash
bun samples/getting-started/walkthrough.mjs
~~~
