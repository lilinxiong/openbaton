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
Coding 模型优先级。它会问要配置哪个 adapter，再问 `runner`、`longctx`
和 `coding_models`。只有跳过引导时才需要加 flag。

![选择 CLI](assets/config/01-select-cli.png)

![选择 Coding 模型](assets/config/03-select-coding-models.png)

截图用的是仓库里的 `sample-adapter`。换 Codex 时引导一样，模型列表来自
该 adapter 的实时目录。

## 源码 checkout

在源码目录执行以下脚本，可以安装依赖、运行检查、构建，并根据 footprint
完成首次安装或干净重装的完整流程：

```bash
python3 scripts/update_local_baton.py
```

只有明确接受省略检查时才使用 `--skip-tests`。源码目录中的日常命令为：

```bash
bun install
bun run baton -- <command> ...
```

安装脚本根据 PATH 上可见的 `baton` 命令、`~/.baton` home，以及已注册且存在的
host-skill footprint 判断首次安装还是已有安装。干净重装计划会先构建并验证，再由构建出的 CLI
执行 clean-uninstall 预检与应用，移除已识别的软件包注册，link 当前 checkout，
用非交互 stdin 运行不带参数的 `baton init`，最后验证结果。首次安装计划只省略
清理阶段。

package-manager 注册不会独立构成安装 footprint。只有存在可见的 `baton` 命令时，
安装脚本才会校验其受支持的 Bun/npm 软件包注册及 provenance；没有可见命令时，
不会独立扫描 package 注册或 manifest 来判定安装模式。

`--dry-run` 会完整打印当前 fresh 或 clean-reinstall 计划（包括清理和注册移除），
但不执行任何步骤；不得调用 package-manager unlink，因为 Bun 1.4.0 的 package-
manager dry-run 不安全。

若存在活动 ticket、文件或软件包归属冲突、非法/不完整状态，或无法唯一确定已识别
注册的移除命令，计划会阻断。解决报告的阻断后再重跑；不要用 `rm -rf ~/.baton`。

安装完成后显式配置 host（init 不会隐式选择模型）：

```bash
baton config --cli <adapter-id> --runner <model-id> --longctx <model-id> --coding-model <model-id>
```

该命令只写入 `[cli.<adapter-id>]`。用 `-` 清空 `runner` 或 `longctx`；只有明确
需要完整目录顺序时才使用 `--coding-model all`。不要使用过时的 `--enable`。
`~/.baton/config.toml` 中的 profile 由用户拥有；init 后允许为空，但在显式配置前
会阻断带 classification 的路由。

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
复制到 `.codex/skills/baton/SKILL.md`，并把配套 policy 复制到
`.codex/skills/baton/agents/openai.yaml`。Codex 通过它们发现 Baton，并
禁用隐式调用。

然后运行 `baton config --cli codex`。在 TTY 里这是引导流程：方向键选择，
空格切换。它会依次问 `runner`、`longctx` 和 Coding 模型优先级。模型 id
来自实时 Codex CLI 目录（找不到 Codex 时可设 `BATON_CODEX_PATH`）。

非交互写入时才用 flag，并且只写 `[cli.codex]`：

```bash
baton config --cli codex --runner <model-id> --longctx <model-id> --coding-model <model-id>
```

会产生 ticket 的命令需要 `BATON_SESSION_ID`（不透明；会被哈希成
`session_uid`）。Codex director 会在第一次控制平面调用之前创建它。

### 如何触发 Baton（仅 `$baton`）

已安装的 host skill **不会**自动加载。只有你显式提及 `$baton` 时，Codex
才会应用其中的规则。普通对话、实现请求或隐含意图都不得加载该 skill，
也不得跟随其中的路由规则。

安装的 `agents/openai.yaml` 把 `policy.allow_implicit_invocation` 设置为
`false`；通过 Codex skill picker 显式调用 `$baton` 仍然可用。

使用 `$baton`，并且 Codex profile 已配置之后：

- 讨论和只读分析留在 Codex director 会话里。这些**不会**创建 Baton
  ticket。
- 已授权的 implementation、mechanical、long-context 和 OpenSpec unit
  走 Baton（`spawn`/`apply` 加上 Codex 原生子），而不是在 director
  里直接实现。

`$baton` 仍然要求 director 给出**结构化 classification**。Baton 不会从
自由文本里推断路由。缺少 classification 时，会阻止创建 ticket。

### CLI 命令

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

必须提供 `--classification`：
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
空格切换。它会依次问 `runner`、`longctx` 和 Coding 模型优先级。模型 id
来自实时 Grok ACP 目录（找不到 Grok 时可设 `BATON_GROK_PATH`）。

非交互写入时才用 flag，并且只写 `[cli.grok]`：

```bash
baton config --cli grok --runner <model-id> --longctx <model-id> --coding-model <model-id>
```

会产生 ticket 的命令需要 `BATON_SESSION_ID`（不透明；会被哈希成
`session_uid`）。Grok director 会在第一次控制平面调用之前创建它。

### 如何触发 Baton（仅 `/baton`）

已安装的 host skill **不会**自动加载。只有你显式输入 `/baton` 时，Grok
才会应用其中的规则。普通对话、实现请求或隐含意图都不得加载该 skill，
也不得跟随其中的路由规则。

skill 的 frontmatter 设置了 `disable-model-invocation: true`，因此 host
不能自动调用它；同时设置 `user-invocable: true`，因此 `/baton` 仍是
斜杠命令。

使用 `/baton`，并且 Grok profile 已配置之后：

- 讨论和只读分析留在 Grok director 会话里。这些**不会**创建 Baton
  ticket。
- 已授权的 implementation、mechanical、long-context 和 OpenSpec unit
  走 Baton（`spawn`/`apply` 加上 Grok 原生子），而不是在 director
  里直接实现。

`/baton` 仍然要求 director 给出**结构化 classification**。Baton 不会从
自由文本里推断路由。缺少 classification 时，会阻止创建 ticket。

### CLI 命令

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

## 编译后的 OpenSpec apply（双 skill）

OpenSpec apply 是显式的双 skill 路径：在同一个 director 会话中同时调用
`/baton` 与 `$openspec-apply-change`（Codex 对应 `$baton
$openspec-apply-change`）。Baton 没有 hook；普通 OpenSpec 请求或 prompt
监听器都不会自行创建 ticket。OpenSpec 的 task ledger 仍是唯一事实源。
主 agent 先读取 apply instructions、返回的每个 `contextFiles`、仓库指导和
受影响代码，然后才编译带版本的计划。

计划记录 source snapshot/revision、精确 task refs 与 dependencies、read
context、write paths 与 allowed operations、命令式 patch recipe、done criteria、
permitted validation、parent gates 和 task mappings。每个 unit 只能是
`patch-only` 或 `verification-only`：前者必须有写入 scope，后者禁止写入
scope 与 patch 字段。一个宽任务可以映射为多个互不冲突 unit；耦合任务可以
合并成一个 patch；后续与前序重叠的 integration unit 必须显式排序。Baton
先校验并持久化计划，再计算 maximal safe ready frontier。

每个 unit 都根据复杂度、上下文大小、代码 scope、所需 reasoning 和执行能力
推导 minimum capability，然后只按用户配置的 `coding_models` 原顺序路由。
Spark 只是第一个候选：当前 session 中能力不足或已耗尽时，只要后面的已配置
route 合格，就静默前进。绝不选择 profile 外的 route。只有没有任何同时满足
“当前 session 可用”和“能力足够”的已配置 route 时才通知用户；
`NO_QUALIFIED_CANDIDATE` 必须列出每个候选及每个排除原因。quota 和
uncallability 只属于当前 Baton session cache，新 session 必须重新检查。

每次 reservation 都要把原 prompt 不变地交给带精确模型的新 native worker，
立即绑定 opaque handle，依据真实 liveness 等待，记录一次 terminal result，
并在 refill 前 release；terminal scope 在 release 确认前仍保持占用。worker
不得重设计、扩大 scope、spawn 子 agent、触碰 Git/OpenSpec 或选择模型。只有
parent 在所有 mapped unit 与 gate 通过后接受 gate、reconcile task checkbox；
checkbox 不能提前完成。

编译 run 的命令如下：

```text
baton apply <change> --host <host> --plan-file <plan.json> [--dispatch] --json
baton apply <change> --host <host> --run <run-id> --status --json
baton apply <change> --host <host> --run <run-id> --accept-gate <gate-id> --text "..." --json
baton apply <change> --host <host> --run <run-id> --reconcile [--task <number>] --json
baton apply <change> --host <host> --run <run-id> --plan-file <successor.json> [--dispatch] --json
```

首个计划是 revision `1`。successor 必须使用当前 run 的 parent revision 和
fingerprint，保留 selected-task coverage，并重新通过 catalog、capability、
scope 与 baseline 校验。`--status` 只读报告 run 状态，`--accept-gate` 记录
parent gate 证据，只有 `--reconcile` 能写入 task conclusion/checkbox。source
staleness、changed contract、scope 变化、安全门阻断的部分修改和
`PLAN_INSUFFICIENT` 都应返回 director 重新决策。旧式手工 `baton apply` 的
显式 scope 与 `--read-only` 仍兼容；compiled 模式拒绝手工 scope flag。

## Rolling v2：大 change 快速、来源中立地启动

新的大 change 不需要等主 agent 把整份 change 全部分析完才启动第一个 worker。
director 先接受一个有界、依赖已就绪的 `PlanDelta`，派发其中的安全 frontier，
然后在前序 worker queued/running 时继续追加后续 delta。已经派发的 unit 仍然是
完整且不可变的；保持开放的只是未来工作发现。

OpenSpec 不是前提。`TaskSourceDescriptor` 可以选择 Baton 内置 director source，
也可以选择已安装的 source adapter。OpenSpec adapter 用 Markdown 中稳定的任务号
（例如 `1.1`）做 reconciliation identity；Apply JSON 的临时 ordinal 只保留作诊断，
因此 Apply 输出重排不会改变任务身份。

```text
baton run start --host <host> --source-file <source.json|-> [--plan-delta-file <delta.json|->] [--run-id <run>] [--dispatch] --json
baton run <run> --append-plan <delta.json|-> [--dispatch] --json
baton run <run> --status --json
baton run <run> --accept-gate <gate>@<version> --text "..." [--dispatch] --json
baton run <run> --seal-task <task-key> --seal-file <seal.json|-> --json
baton run <run> --reconcile [--task <task-key>] --json
```

status 以 task 为主视图，区分 unplanned、planned、active、
terminal-unreleased、blocked、accepted、sealed 和 reconciled。terminal success、
safety verdict、parent acceptance、release 是四类独立且幂等的事实。gate 分为
`safety-precondition`、`integration-acceptance`、`evidence`，只阻断显式依赖。
失败版本保留审计记录；只有 lineage 可替换时 director 才能追加不可变 successor。
task 只有在精确覆盖所有非 superseded 版本并由 source adapter reconciliation 后
才真正完成。

Rolling 状态位于当前 workspace runtime 的 `runs/rolling-runs-v2/`。clean
uninstall 会清点并保留这些 append-only facts 和 accepted documents。已有手工或
compiled-v1 `baton apply` run 继续使用原协议，绝不会被静默迁移。

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

自动路由只使用已配置 profile 的 `coding_models` allowlist、实时目录、任务
形状、adapter 支持的推理选项、服务层信息、路由健康和容量事实。

## 常用命令

```text
baton init
baton config --cli <adapter-id>
baton models refresh --host <adapter-id>
baton models status --host <adapter-id>
baton match "<work description>" --host <adapter-id>
baton spawn "<request>" --host <adapter-id> --classification <class>
baton apply <change> --host <adapter-id>
baton run start --host <adapter-id> --source-file <source.json> --plan-delta-file <delta.json> --dispatch --json
baton run <run-id> --status --json
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
