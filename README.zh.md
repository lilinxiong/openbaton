# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

[English](README.md) | **中文**

Baton 是 CLI 中立、由 manifest 驱动的调度与策略层。它让 director 对话
保持清晰，从所选 adapter 的实时目录中自动选择模型，并通过原生子执行
接口运行已授权的工作。

子 agent 容量属于一个 root-agent tree，由哈希后的 `BATON_SESSION_ID` 标识。
root agent 本身不计入容量；直接子 agent、孙级及更深层 descendants 共享同一个
tree-local 槽位池。

软件包可以独立运行，也可以在有结构化变更计划时消费它。需要 Node.js 22.5
或更高版本。

```bash
npm install -g @zhouliuya/openbaton
baton init
baton config
```

`baton config` 是带引导的 TTY 流程：方向键选择，空格切换 CLI 和
Coding 模型优先级。它会问要启用哪个 adapter，再问 `runner`、`longctx`
和 `coding_models`。只有跳过引导时才需要加 flag。

![选择 CLI](assets/config/01-select-cli.png)

![选择 Coding 模型](assets/config/03-select-coding-models.png)

![是否启用](assets/config/04-enable.png)

截图用的是仓库里的 `sample-adapter`。换 Codex 时引导一样，模型列表来自
该 adapter 的实时目录。

## 源码 checkout

在源码目录执行以下脚本，可以安装依赖、运行检查、构建、链接 `baton`，
并刷新共享运行时文件：

```bash
python3 scripts/update_local_baton.py
```

只有明确接受省略检查时才使用 `--skip-tests`。源码目录中的日常命令为：

```bash
bun install
bun run baton -- <command> ...
```

Baton core 不内置目录。adapter 软件包通过 `~/.baton/adapters/<adapter-id>/` 下的
`adapter.json` 发现，或由 `BATON_ADAPTER_PATHS` 指定。执行阶段没有交互式
模型选择。

## 入门样例

隔离 walkthrough 在 [`samples/getting-started/`](samples/getting-started/)。
它使用仓库内的 `sample-adapter`，不需要付费 host。

在仓库根目录执行：

```bash
bun samples/getting-started/walkthrough.mjs
```

也可以按 [samples/getting-started/README.zh.md](samples/getting-started/README.zh.md)
逐步操作。

## 一次实测

已完成的 OpenSpec 变更 `scope-subagent-capacity-per-agent-tree` 通过 Baton
分派给原生子 agent 执行。这次把 dispatch 容量从 workspace/host 共享池改成
不可变的 `(host, session_uid)` root-agent tree，覆盖 session 身份、tree-local
槽位、status provenance、跨 tree 安全隔离、adapter quota 语义和
installed-runtime 验收。

### 任务规模

| 维度 | 规模 |
|---|---|
| OpenSpec 工作 | 7 个章节，30 个任务 |
| Spec 合同 | 10 条 requirement，26 个 scenario |
| 实现提交 `2aca248` | 46 个文件，+3,293 / −246 |
| 源码验证 | 223 passed，1 skipped |

### 执行

对比口径排除了另一任务的兼容性门禁等待 33分36秒。金额按公开 API 单价换算，
不是订阅账单。主 Agent 单独执行一行是反事实估算：同样的生产性 Token 规模
按 `gpt-5.6-sol` 计价并串行完成，不是第二次实跑。

| | 主 Agent 单独串行估算 | Baton（1 个主 Agent + 36 个 subagent） |
|---|---|---|
| 模型 | 全程 `gpt-5.6-sol` | 主 Agent `gpt-5.6-sol`（`high`，3 次自动压缩）；subagent 全部 `gpt-5.6-luna`（无自动压缩） |
| 有效端到端 | 2小时34分33秒 | 1小时58分05秒（节省 36分28秒，1.31×） |
| 生产性 Token | 约 137.16M | 约 137.16M |
| API 等价成本 | $79.70 | $30.56（节省 $49.14，降 61.7%） |

subagent 承担了过半 Token，但按 `gpt-5.6-luna` 单价合计约 $2.66。

## 在 Codex 里使用 Baton

### 准备

```bash
npm install -g @zhouliuya/openbaton
# 或在 checkout 中：bun run baton -- <command> ...
baton init --cli codex
```

`baton init --cli codex` 会安装捆绑的 adapter 和 host skills。Codex
adapter 的 manifest（`adapters/codex/adapter.json`）把 `runtime/SKILL.md`
复制到 `.codex/skills/baton/SKILL.md`。Codex 就是这样看到 Baton 的。

然后运行 `baton config --cli codex`。在 TTY 里这是引导流程：方向键选择，
空格切换。它会依次问 `runner`、`longctx`、Coding 模型优先级，以及是否
启用这个 profile。模型 id 来自实时 Codex CLI 目录（找不到 Codex 时可设
`BATON_CODEX_PATH`）。

非交互写入时才用 flag，并且只写 `[cli.codex]`：

```bash
baton config --cli codex --runner <model-id> --longctx <model-id> --coding-model <model-id> --enable
```

用下面的命令打开或关闭 activation：

```bash
baton enable|disable all|curproject --host codex
```

activation 实际关闭时，`spawn` 和 `apply` 不会创建 ticket（bypass）。
会产生 ticket 的命令需要 `BATON_SESSION_ID`（不透明；会被哈希成
`session_uid`）。Codex director 会在第一次控制平面调用之前创建它。

### 何时自动触发（仅当前版本）

这是**当前版本**的行为。后续版本不打算再自动触发。

init 安装 `.codex/skills/baton/SKILL.md`，并且 Codex profile 已启用、
activation 打开之后，Codex director 对话会遵循该 skill：

- 讨论和只读分析留在 Codex director 会话里。这些**不会**创建 Baton
  ticket。
- 已授权的 implementation、mechanical、long-context 和 OpenSpec unit
  应当走 Baton（`spawn`/`apply` 加上 Codex 原生子），而不是在 director
  里直接实现。

这种 skill 跟随就是当前的自动触发。自动路径仍然要求 director 给出
**结构化 classification**。Baton 不会从自由文本里推断路由。已启用 host
上缺少 classification 时，会阻止创建 ticket。

### 手动触发

你或 director 也可以自己跑 CLI：

```bash
export BATON_SESSION_ID="<opaque-session>"
baton models refresh --host codex
baton match "<work description>" --host codex
baton spawn "<request>" --host codex --classification <class> [--write-path ...]
baton dispatch next --host codex --json
# 绑定 Codex 原生 handle：
baton dispatch bind TICKET --host codex --execution-handle task_name=CODEX_TASK_NAME --json
baton dispatch complete TICKET --host codex --text "..." --release --json
```

`baton apply` 用于规划 OpenSpec 变更。`--dispatch` 必须为每个 unit 提供
`--write-path` 或 `--read-only`。没有 OpenSpec 时使用 `spawn`。
`baton match` 会披露首选模型，但不会创建工作。

### 分类如何落到路由

已启用 host 上必须提供 `--classification`：
`mechanical|long-context|implementation|analysis|discussion|general`。

- `discussion` / `analysis` → 只留在 director。没有 worker ticket。
- `mechanical` → 配置的 `runner` 标签。runner 为空会阻断；已分类的
  mechanical 工作不能在 director 上执行。commit-only 能力只属于
  mechanical。
- `long-context` → 配置的 `longctx` 标签。longctx 为空会阻断。
- `implementation` 和 `general` → 在有序的 `coding_models` allowlist
  上自动选择（Coding priority）。对 runner/longctx 来说，`general`
  是 `not-ops`。`runner` 和 `longctx` 是标签，不是 Coding-priority
  条目。

`--operation` 只是审计元数据，从不选择路由。

完整生命周期见 [docs/guide.zh.md](docs/guide.zh.md)。

## 在 Grok 里使用 Baton

### 准备

```bash
npm install -g @zhouliuya/openbaton
# 或在 checkout 中：bun run baton -- <command> ...
baton init --cli grok
```

`baton init --cli grok` 会安装捆绑的 adapter 和 host skills。Grok
adapter 的 manifest（`adapters/grok/adapter.json`）把 `runtime/SKILL.md`
复制到 `.grok/skills/baton/SKILL.md`。Grok 就是这样看到 Baton 的。

然后运行 `baton config --cli grok`。在 TTY 里这是引导流程：方向键选择，
空格切换。它会依次问 `runner`、`longctx`、Coding 模型优先级，以及是否
启用这个 profile。模型 id 来自实时 Grok ACP 目录（找不到 Grok 时可设
`BATON_GROK_PATH`）。

非交互写入时才用 flag，并且只写 `[cli.grok]`：

```bash
baton config --cli grok --runner <model-id> --longctx <model-id> --coding-model <model-id> --enable
```

用下面的命令打开或关闭 activation：

```bash
baton enable|disable all|curproject --host grok
```

activation 实际关闭时，`spawn` 和 `apply` 不会创建 ticket（bypass）。
会产生 ticket 的命令需要 `BATON_SESSION_ID`（不透明；会被哈希成
`session_uid`）。Grok director 会在第一次控制平面调用之前创建它。

### 何时自动触发（仅当前版本）

这是**当前版本**的行为。后续版本不打算再自动触发。

init 安装 `.grok/skills/baton/SKILL.md`，并且 Grok profile 已启用、
activation 打开之后，Grok director 对话会遵循该 skill：

- 讨论和只读分析留在 Grok director 会话里。这些**不会**创建 Baton
  ticket。
- 已授权的 implementation、mechanical、long-context 和 OpenSpec unit
  应当走 Baton（`spawn`/`apply` 加上 Grok 原生子），而不是在 director
  里直接实现。

这种 skill 跟随就是当前的自动触发。自动路径仍然要求 director 给出
**结构化 classification**。Baton 不会从自由文本里推断路由。已启用 host
上缺少 classification 时，会阻止创建 ticket。

### 手动触发

你或 director 也可以自己跑 CLI：

```bash
export BATON_SESSION_ID="<opaque-session>"
baton models refresh --host grok
baton match "<work description>" --host grok
baton spawn "<request>" --host grok --classification <class> [--write-path ...]
baton dispatch next --host grok --json
# 绑定 Grok 原生 handle：
baton dispatch bind TICKET --host grok --execution-handle subagent_id=GROK_SUBAGENT_ID --json
baton dispatch complete TICKET --host grok --text "..." --release --json
```

`baton apply` 用于规划 OpenSpec 变更。`--dispatch` 必须为每个 unit 提供
`--write-path` 或 `--read-only`。没有 OpenSpec 时使用 `spawn`。
`baton match` 会披露首选模型，但不会创建工作。

分类、路由标签和生命周期与上面的 Codex 章节以及
[docs/guide.zh.md](docs/guide.zh.md) 相同。

## 第一次会话

所有会产生 ticket 或对容量敏感的 dispatch 命令都要求 `BATON_SESSION_ID`。
Baton 将其哈希为 `session_uid`，root 与 descendants 必须保留同一身份。

```bash
export BATON_SESSION_ID="<opaque-session>"
baton models refresh --host <adapter-id>
baton match "<work description>" --host <adapter-id>
baton spawn "<request>" --host <adapter-id> --classification <class>
baton dispatch next --host <adapter-id> --json
baton dispatch status --host <adapter-id> --json
baton dispatch complete <ticket> --host <adapter-id> --text "<conclusion>" --release --json
```

`baton apply` 用于规划 OpenSpec 变更。`--dispatch` 必须为每个 unit 提供
`--write-path` 或 `--read-only`。没有 OpenSpec 时使用 `baton spawn`。

自动路由只使用已启用 profile 的 `coding_models` allowlist、实时目录、任务
形状、adapter 支持的推理选项、服务层信息、路由健康和容量事实。

## 常用命令

```text
baton init
baton config --cli <adapter-id> --enable
baton models refresh --host <adapter-id>
baton models status --host <adapter-id>
baton match "<work description>" --host <adapter-id>
baton spawn "<request>" --host <adapter-id> --classification <class>
baton apply <change> --host <adapter-id>
baton dispatch next --host <adapter-id> [--capacity <n>] --json
baton dispatch status --host <adapter-id> [--capacity <n>] --json
baton dispatch complete <ticket> --host <adapter-id> --text "<conclusion>" --release --json
```

`dispatch status` 只查看当前 root tree。普通 `baton status` 仍保留 workspace
ticket inventory，但在 `capacity_trees` 下按 tree 分组。

## 文档

- [入门样例](samples/getting-started/README.zh.md) — 隔离环境下从 init 走到 dispatch
- [样例说明](samples/README.zh.md) — adapter manifest 样例与验收形态
- [产品指南](docs/guide.zh.md) — adapter SDK、配置、调度、ticket 生命周期、
  仓库安全，以及一次实测 OpenSpec apply
- [架构说明](docs/architecture/baton-dynamic-director.zh.md)
- [架构图](docs/architecture/openbaton-architecture.html)
- [分层运行图](docs/architecture/openbaton-layered-architecture.html)
- [运行时 skill](SKILL.md)

