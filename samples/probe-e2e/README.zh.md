# Baton probe E2E

[English](README.md) | **中文**

这份一次性 fixture 在同一次会话里同时走完 Baton 独立多 unit dispatch
和 OpenSpec apply 路径。

创建任何 ticket 之前，先展示目标 CLI 当前 picker 可见的 route，
并让用户只选择其中一条。把该 route 一次写入 profile 的三个字段：

```text
baton config --cli <target> --runner <model> --longctx <model> --coding-model <model> --json
```

从 OpenBaton 源码 checkout 创建工作区，并生成可粘贴的 prompt 文档：

```text
bun samples/bootstrap-probe.mjs --host <target> --model <model> --output <prompt-file>
```

把 Prompt 1 和 Prompt 2 依次粘贴进同一个目标 CLI 主对话。
两者都完成后，使用 prompt 文档里打印的工作区路径：

```text
bun samples/verify-probe.mjs --host <target> --model <model> <workspace>
```

Prompt 1 通过 Baton 创建两个互不依赖的文件：

- `standalone/alpha.js`
- `standalone/beta.js`

独立请求保存在 `STANDALONE_REQUEST.txt`。

Prompt 2 调用 `$baton $openspec-apply-change probe-e2e`，并行分派
OpenSpec 任务 `1.1` 和 `1.2`，再执行集成任务 `2.1`。
OpenSpec 请求保存在 `OPENSPEC_REQUEST.txt`。bootstrap 会把同一套
绝对工作区路径、host、模型和 session 身份注入两份请求。
fixture 启动时没有已生成的源码文件；这些文件由 worker 创建。
