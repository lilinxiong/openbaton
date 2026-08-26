# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

面向 Codex、Grok、Cursor 与 Claude Code 的 CLI 中立 director：一个前台对话，自动选择模型与推理强度，使用原生 subagent，配置机械 ops，并保持主上下文干净。

Baton 可以独立工作；存在 OpenSpec 时也可以消费它的任务。

    npm install -g @zhouliuya/openbaton
    baton init
    baton config

需要 Node.js 22.5+。

English: [README.md](README.md)

## 从源码 checkout 安装

Clone 本仓库后，把 checkout 链接到本机，并用仓库最新内容刷新全局 Baton 文件：

```bash
python3 scripts/update_local_baton.py
```

脚本会安装依赖、跑测试、构建、执行 `bun link`，再运行 `baton update`，让全局 `baton` 指向本 checkout 的 `dist/bin/baton.js`。

首次安装时，脚本成功后还需要初始化一次：

```bash
baton init
baton config
```

本地已有 Baton 时，同样运行该脚本即可按仓库最新代码重建并更新 skills、配置默认值和 hooks。

若接受跳过测试、加快开发迭代：

```bash
python3 scripts/update_local_baton.py --skip-tests
```

在 Cursor 中也可以 clone 后直接运行 `install-local-baton` skill，流程相同。

未 link 时，在 checkout 内日常命令：`bun install && bun run baton -- COMMAND`。

## 这次改造

Baton 不再绑定 OpenCodex。模型发现归 CLI adapter；当前实现的是 Codex、Grok、Cursor 与 Claude Code adapter：

1. baton config 先让用户选择要配置的 CLI。
2. 选择 Codex 后，Baton 启动 codex app-server，调用排除隐藏模型的 model/list。选择 Grok 后，Baton 运行 `grok models`，只保留列出的 id（若 CLI 打出 JSON 就解析 JSON，否则解析 Available models 列表，忽略登录/散文行）。选择 Cursor 后，Baton 运行 `cursor-agent models`，只保留列出的 id（若 CLI 打出 JSON 就解析 JSON，否则解析 Available models 列表，忽略登录/散文行）。选择 Claude Code 后，Baton 通过 SDK 控制协议发出 `list_models` 请求，只保留每一行的 `resolvedModel` wire id；延迟解析的 `default` 别名行与 host 标记为不可选的行都会被排除。`claude models` 输出的是散文，不是目录。
3. 所选 CLI picker 返回什么，配置界面就完整显示什么。
4. 用户设置可选的 runner、longctx 标签，选择允许 subagent 调用的模型，并决定是否启用这个 CLI 配置。
5. 之后 Baton 只在这个候选集合内自动匹配，不再出现运行时模型选择器，也不需要用户确认模型。

Baton 从不通过 `grok -p`、`cursor-agent -p` 或 `claude -p` 执行任务。dispatch host id 为 `codex`、`grok`、`cursor` 或 `claude`。

Claude Code 的原生 `Agent` 工具只接受模型别名，因此 Baton 把每张 ticket 的精确模型写进 agent 定义的 `model:` frontmatter，再用 `subagent_type` 选中它。该 host 的并发上限为 20 个子 agent（可用 `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` 覆盖）。

Baton 不查询 OpenCodex，不把硬编码目录拼进来，也不会因为某个 host tool 的说明里少了一个模型，就把它判为不支持。

## 配置结构

用户全局的 ~/.baton/config.toml 始终保留 director 兜底值，并且只保存 init/config
时实际选择过的 CLI profile：

    [director]
    max_concurrent = 4
    max_depth = 1

`max_concurrent` 与 `max_depth` 分别兜底。CLI discovery 响应明确返回哪个值，
Baton 才把哪个字段写入所选的 `[cli.<id>]`，该 host 使用这个真实返回值；未返回的
字段不写入，继续使用 `[director]`。适配器默认值或环境变量不会伪装成 CLI 返回值落盘。

    [cli.codex]
    enabled = true
    runner = "gpt-5.4-mini"
    longctx = "gpt-5.5"
    coding_models = [
      "gpt-5.6-luna",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]

runner、longctx 只是标签，不声明模型一定快、一定有长上下文，或一定具备某种 capability。两者看到的是同一份所选 CLI 返回的模型列表。

`coding_models` 是明确的有序多选，数组顺序就是 Coding 优先级。runner 和
longctx 是独立标签，不会自动插入或重排 Coding 数组。CLI 配置关闭时不提供候选。
未选择的 CLI 不会在文件中生成占位 table。

Guard 模式按 host 明确配置：单个 CLI 使用 `--guard-mode enforce|off`。
Codex 的 `off` 会移除 Baton hooks 并仅保留审计；Cursor 固定为 off；Claude/Grok
保留各自 host 的生命周期 hooks，并显示为 enforce。

也可以非交互配置：

    baton config \
      --cli codex|grok|cursor|claude \
      --runner gpt-5.4-mini \
      --longctx gpt-5.5 \
      --coding-model gpt-5.3-codex-spark \
      --coding-model gpt-5.6-luna \
      --coding-model gpt-5.4-mini \
      --guard-mode enforce \
      --enable

所选 CLI 的 picker 列表变化后，运行 baton models refresh。

## Mini 与 Spark

只要 Codex 的 model/list 返回 gpt-5.4-mini 或 gpt-5.3-codex-spark，Baton
就会把它们展示出来，并允许写入 `coding_models`。

迁移说明：旧安装可能含有 `subagent_models`。它只会在 schema 迁移边界被
读取，并按原顺序写入 `coding_models`，之后不再写回旧字段。已移除的
`--subagent-model` 会明确返回 `LEGACY_FLAG_REMOVED`，请改用重复的
`--coding-model`。

这里区分四层证据：

- picker 可见：这个模型可以配置；
- 进入 allowlist：Baton 可以自动选它；
- dispatch：再次校验模型及 reasoning effort 仍存在于保存的 CLI catalog；
- host-native 真正拒绝：这才是该次执行失败的证据。

Baton 没有硬编码模型系列禁令。不能只因为某个 tool schema 或帮助文本没列 Mini/Spark，就提前标成 unsupported。

## 自动匹配

baton spawn 和 baton apply 不再让用户选模型。完成 host、effort、上下文、
可用性和 activation 等硬门槛后，简单 implementation 选择第一个 eligible 的
`coding_models`；复杂任务也严格沿配置顺序继续尝试。不会按 score 重排，选择
原因和跳过路由诊断都会记录。Baton 自动决定：

- 根据 work unit 和 CLI 模型描述选择已配置模型；
- 根据任务复杂度，从 CLI 返回的 reasoning effort 中选择一个；
- 任务强调快速时，结合 CLI 描述以及 speed/service-tier 元数据匹配 fast 模型或精确 service tier；
- 使用可选的本地 capability 数据和近期 route health 做进一步排序。

Artificial Analysis 数据只是可选证据。没有 benchmark 时保持 unranked，但不会因此排除一个 Codex 已返回且用户已配置的模型。

显式 --model、--route、baton config model-selection、selector render 和用户模型确认都已移除。自动决策仍会写入 proposal、ticket 和 Delegation Receipt，便于审计。

Baton 不继承 parent 模型，不越过启用的 allowlist，不编造 CLI 没返回的 effort 或 fast 参数，也不会原地改 ticket 或跨 host 静默换模型。只有明确 quota 证据且 mutation 尚未开始、baseline 仍干净时，才按后续 Coding 优先级创建可审计的 immutable successor，并重新执行全部硬门槛。

## Director/worker 路由

讨论和只读分析留在 director。所选 CLI profile 启用后，所有普通实现请求（包括很小的改动）都必须交给该 host 的原生 subagent，不能使用 tiny-edit 例外。profile 缺失/关闭或分类未决时必须 fail closed。已分类的机械工作在 route 为空或不可用时也不能退回 director 执行。OpenSpec 只减轻编排负担，不改变谁来写可执行任务；所有 host 使用同一规则。

## 自动工作流契约

只有在所选 CLI profile 已启用、且用户明确授权执行时，工作流才允许产生原生实现任务。director 必须先给每个可执行请求分类，并把结构化分类交给 Baton；Baton 只持久化由此产生的 ticket 和 Receipt，不另造或接管 DAG。讨论与只读分析留在 director；获得授权的实现节点交给当前 host 的原生 subagent。`mechanical` 分类走 `runner`（`long-context` 走 `longctx`），operation label 只作审计元数据，不得退化成固定 action 名匹配；commit/publish 仍由确定性的 Receipt/Git capability 门禁决定。缺少授权、profile 被关闭或分类未决时必须 fail closed。

## 写入范围就绪条件

创建或 dispatch 任何写 ticket 之前，director 必须先对该单元做一次只读的影响/依赖梳理。梳理结果必须解析受影响的依赖，并记录完整、精确的单元级写入路径集合及允许的操作。路径必须逐项明确；允许的操作只能来自 `write`、`create`、`delete`、`rename`、`chmod`。影响、依赖、路径或操作只要未知，分类就保持未决，不创建也不 dispatch implementation ticket。

只有所有参与单元的范围都完整且写集合两两不相交时，才允许并行 dispatch；rename 的源/目标路径以及路径前缀重叠也算相交。否则单元必须串行，或继续留在 director。worker 如果发现未声明的路径或操作，必须在 mutation 前停止并返回 scope decision 给 director；不能先编辑，再依赖终态 retry 或 audit 追认。机械路由仍由结构化分类决定，operation label 只是 opaque 审计元数据，不能选择 route。

## 执行生命周期

Baton CLI 负责 ticket 与生命周期状态；只有所选 host（Codex、Grok、Cursor 或 Claude Code）调用原生 subagent 工具。

1. baton spawn 或 baton apply 创建已自动路由的 ticket 和不可变 Receipt。
2. host 用 baton dispatch next 预留任务。
3. host 调用原生 subagent 工具（Codex `spawn_agent`、Grok `spawn_subagent`、Cursor `Task` 或 Claude Code `Agent`），原样传回 dispatch 返回的 `prompt`，工具支持时也原样传 `description`，并传精确模型；仅在 host 工具能表达时才传 reasoning effort 和 service tier。首行 JSON envelope 是 dispatch 审计数据，ticket id 不按前缀分类。Codex 的 `task_name` 是 attach/liveness/release 使用的 native execution handle，`agent_id` 仅是可选诊断字段。Grok 必须传 `spawn_subagent.model`，省略会继承 parent 模型。若 host 无法表达某个已选项，必须报告该执行选项不可用，不能静默声称已启用。
4. host 绑定 agent id，记录活动和进度，并只写一个终态。
5. host 关闭原生 agent，执行 dispatch release 后再从 FIFO 补位。

逻辑任务不封顶；物理并发遵守当前 host 上限。AgentLimitReached 只把同一 ticket 延后，不消耗 attempt，也不换模型。轮询 timeout 不是 worker 失败；只有对应的原生 execution handle 被 probe 为 not_found 后，ticket 才能 timeout。

默认只读。写任务必须带不可变路径和操作 allowlist，并通过 parent Git safety gate。已有的未提交改动会记入 baseline，worker 可以在 allowlist 上增量，不能改无关脏文件。唯一的 Git 例外是独占 commit-only ticket：它只消费 parent 已精确 staged 的 tree，允许创建一个受审计 commit，不能 stage、amend、切分支、rebase、tag 或 push。

standalone 写入必须明确给出路径和操作：

    baton spawn "实现迁移" --host HOST --classification implementation \
      --write-path src/migration.ts --write-ops write,create

OpenSpec dispatch 前必须给每个单元划定范围；只有完整且互不相交的范围才能进入同一 wave：

    baton apply CHANGE --host HOST --dispatch \
      --unit ID --write-path src/migration.ts --unit ID --write-path src/config.ts

## 机械 ops

director 提供结构化执行分类，Baton 据此选择 `runner` 或 `longctx`；operation label 只保留作审计，不能选择 profile。分类机械工作遇到空/不可用 route 时必须 fail closed。机械 worker 只执行 director 指定的 operation，不从 prose 推断命令，也不探索。commit-only 还必须有显式 commit capability 和 Receipt/Git 门禁；单独的 `operation = "git-commit"` 不具备权限。

Benchmark：同一条本地命令，走 Baton ticket（spawn、bind、跑命令、complete/release）vs 不用 Baton（直接跑）。不拉起 host 模型。默认在本仓库跑，跳过 `git commit`；`--fixture` 用临时仓库并包含 commit。

    bun scripts/compare-mechanical-ops.ts
    bun scripts/compare-mechanical-ops.ts --fixture
    bun scripts/compare-mechanical-ops.ts --json

本仓库，2026-08-22。`cli=grok` `ok=true`。6 张票一次打开：**221 毫秒**。

`test` 在本仓库是 `bun run test`：类型检查再加整包单测，所以**命令本身大约 12 秒**，跟用不用 Baton 无关。

用 Baton vs 不用。**Baton 外壳**是绑定 + 收尾（Baton 真正多出来的）。**命令两次之差**是同一条命令测了两遍，不是 Baton：

| 任务 | 走哪条路 | 不用 Baton（毫秒） | 走 Baton 时的命令（毫秒） | Baton 外壳（毫秒） | 命令两次之差（毫秒） |
| --- | --- | ---: | ---: | ---: | ---: |
| 测试 | runner/test | 12292.3 | 13318.2 | 50.8 | 1025.9 |
| 构建 | runner/build | 188.9 | 203.0 | 55.1 | 14.1 |
| 类型检查 | runner/typecheck | 96.7 | 111.0 | 61.5 | 14.3 |
| 搜索 | longctx/search | 5.7 | 5.8 | 53.9 | 0.1 |
| git 摘要 | longctx/git-summarize | 7.3 | 8.0 | 51.8 | 0.7 |
| 普通任务 | subagent | 29.8 | 31.8 | 52.0 | 2.0 |
| 提交 | 跳过 | — | — | — | — |

各阶段（毫秒）：

| 任务 | 绑定（毫秒） | 跑命令（毫秒） | 收尾（毫秒） |
| --- | ---: | ---: | ---: |
| 测试 | 18.7 | 13318.2 | 32.1 |
| 构建 | 18.2 | 203.0 | 36.9 |
| 类型检查 | 24.7 | 111.0 | 36.8 |
| 搜索 | 19.6 | 5.8 | 34.3 |
| git 摘要 | 19.7 | 8.0 | 32.1 |
| 普通任务 | 20.4 | 31.8 | 31.6 |

Baton 每条大约多 **50–62 毫秒**，外加开票一次 **221 毫秒**。要更新数字，重新跑脚本。

## Sample 事故审计

同一冻结事故请求，2026-08-22。五个 unit 彼此独立。Grok 默认留在 **grok-4.6** 上，**没有** spawn（若开了且省略 `model`，子会话继承 4.6）。Baton 是五个 **grok-4.5** 并行。

| sample | Grok 4.6 默认（秒） | Grok 4.6 串行、不开 spawn（秒） | Baton，五个 Grok 4.5 并行（秒） |
| --- | ---: | ---: | ---: |
| standalone | 490.6 | 57.9 | 18.3 |
| openspec | 608.2 | 100.0 | 26.0 |

Token 来自各 session 的 `end_turn.usage`（不是账单页）。Baton 一列只计五个 grok-4.5 worker。

| sample | Grok 4.6 默认（token） | Grok 4.6 串行（token） | Baton，五个 Grok 4.5（token） |
| --- | ---: | ---: | ---: |
| standalone | 1,497,407 | 37,439 | 144,056 |
| openspec | 1,791,283 | 224,853 | 198,195 |

峰值上下文：默认 grok-4.6 约 11–12 万 token；Baton 每个 grok-4.5 worker 约 1.1–1.3 万。

## OpenSpec 与状态

OpenSpec 可选。存在时它负责任务拆解与状态，Baton 负责路由 ready task，并按稳定 task number（未编号任务则按校验后的源行）写回结论。不存在时，baton spawn 仍完整可用。

Baton 不创建项目内运行时目录：

- ~/.baton/config.toml：director 与各 CLI 配置
- ~/.baton/cache/cli-models-<host>.json：按 host 隔离的 catalog snapshot
- ~/.baton/state/model-availability.json：持久化的 host/account 路由可用性
- ~/.baton/cache/capabilities/：可选本地 capability 证据
- ~/.baton/workspaces/CANONICAL-ROOT-SHA256/：ticket、Receipt、selection、lock 和生命周期状态

## 命令

    baton init [--force] [--cli codex|grok|cursor|claude]
    baton update
    baton config [--cli codex|grok|cursor|claude] [--runner MODEL|-] [--longctx MODEL|-]
                 [--coding-model MODEL|all] [--guard-mode enforce|off] [--enable|--disable]
    baton enable|disable all|curproject --host HOST [--json]
    baton models refresh|status|candidates
    baton models reset ROUTE --host HOST [--json]
    baton cards [--ranked|--unranked] [--json]
    baton match "快速修复 flaky auth tests" --host HOST
    baton spawn "实现迁移" [--unit KEY=TEXT ...]
                 [--classification CLASS] [--operation LABEL]
                 [--unit-classification KEY=CLASS ...] [--unit-operation KEY=LABEL ...]
                 [--write-path PATH] [--write-ops write,create,delete,rename,chmod]
    baton apply [change]
    baton apply [change] --host HOST --dispatch --unit ID --write-path PATH --unit ID --write-path PATH|--read-only
    baton dispatch next --host HOST --capacity N --json
    baton dispatch bind TICKET --task-name CODEX_TASK_NAME --host codex --json
    baton dispatch bind TICKET --agent-id ID --host HOST --json  # 其他 host
    baton dispatch defer TICKET --code AGENT_LIMIT_REACHED [--observed-capacity N] --json
    baton dispatch probe TICKET --task-name CODEX_TASK_NAME --host codex --state pending_init|running|interrupted|shutdown|not_found --json
    baton dispatch progress TICKET --phase PHASE --text "short status" --json
    baton dispatch complete TICKET --text "short conclusion" --json
    baton dispatch fail|timeout|close TICKET --json
    baton dispatch release TICKET --host HOST --task-name CODEX_TASK_NAME --json
    baton dispatch recover|status --json
    baton status [--host HOST] [--json]
    baton uninstall [--host HOST] [--dry-run]
    baton uninstall --clean --yes

`all` 只修改当前 CLI host 的全局开关；`curproject` 只修改当前 canonical
workspace 与该 host。明确 disabled 时绕过 Baton，恢复该 host 普通 native
行为。`guard_mode=enforce` 下，只有 activation 有效且当前 workspace 没有
`reserved`、`dispatching` 或 `running` ticket 时，disabled 才会产生中性的
`bypass`：hook 成功返回空输出，不做 permission decision，也不向 Codex 暴露
policy context。存在这些 active ticket 时为 `draining`，继续保留 claim、
write-scope、Git 以及 director/worker 边界，直到 terminal release；只有 queued
ticket 不阻止 bypass。activation 或 lifecycle 缺失、损坏、不可读时为 `invalid`
并 fail closed。`guard_mode=off` 是独立的零 Baton hook、audit-only 配置，不是
动态 bypass。status 会显示 `guard_mode`、`effective_hook_posture`、
`effective_hook_reason`、`neutral_bypass`、`audit_only`、当前 scope 的
`draining_count`/`draining_tickets` 与 `hook_posture`，以及兼容字段和
`kind:value` execution handle。activation 不会重写或重新信任已安装 hook。只有
受信任 director 能执行精确 standalone `baton enable|disable all|curproject
--host HOST`；worker、wrapper、替换或 shell composition 一律拒绝。

可恢复的 project activation smoke check（在目标 workspace 执行）：

```bash
baton disable curproject --host codex
baton status --host codex --json # idle 时 effective_hook_posture=bypass
baton enable curproject --host codex
baton status --host codex --json # 恢复 enforce，hook definition 未改变
```

显式 quota/remaining=0 会跨项目和窗口持久记忆；普通 429、网络错误和 timeout
只进入临时 route health。已知 reset 时间用于 probe，未知 reset 使用有界退避，
同一路由同时只有一个 probe lease。在 host 尚未暴露稳定账号身份时，状态使用文档化的
opaque `host-profile` scope。可用
`baton models reset ROUTE --host HOST` 精确 reset 单一路由。uninstall 默认
只清理指定 host 的集成文件并保留全部 Baton state，`--dry-run` 先展示边界；`--clean --yes` 会清理所有 host 的已识别集成和
Baton 状态，但有 active ticket draining 时拒绝，package executable 保留。

Standalone 统一使用一种 proposal：没有 `--unit` 时，请求会保存为
`standalone` 单元。分类字段和值是严格契约；operation 只作审计元数据，不能
从 operation 或请求 prose 推断路由。

## License

MIT
