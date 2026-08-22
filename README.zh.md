# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

多模型协作 director：一个前台对话，自动选择模型与推理强度，使用原生 subagent，并保持主上下文干净。

Baton 可以独立工作；存在 OpenSpec 时也可以消费它的任务。

    bun add -g baton
    baton init
    baton config

源码 checkout：bun install && bun run baton -- COMMAND。需要 Node.js 22.5+ 或 Bun 1.3.14+。

English: [README.md](README.md)

## 这次改造

Baton 不再绑定 OpenCodex。模型发现归 CLI adapter；当前实现的是 Codex 与 Grok adapter：

1. baton config 先让用户选择要配置的 CLI。
2. 选择 Codex 后，Baton 启动 codex app-server，调用排除隐藏模型的 model/list。选择 Grok 后，Baton 运行 `grok models`（优先 `--json`），只保留 CLI 报告的 id。
3. 所选 CLI picker 返回什么，配置界面就完整显示什么。
4. 用户设置可选的 runner、longctx 标签，选择允许 subagent 调用的模型，并决定是否启用这个 CLI 配置。
5. 之后 Baton 只在这个候选集合内自动匹配，不再出现运行时模型选择器，也不需要用户确认模型。

Baton 从不通过 `grok -p` 执行任务。dispatch host id 为 `codex` 或 `grok`。

Baton 不查询 OpenCodex，不把硬编码目录拼进来，也不会因为某个 host tool 的说明里少了一个模型，就把它判为不支持。

## 配置结构

用户全局的 ~/.baton/config.toml 按 CLI 保存：

    [director]
    max_concurrent = 4
    max_depth = 1

    [cli]
    active = "codex"

    [cli.codex]
    enabled = true
    runner = "gpt-5.4-mini"
    longctx = "gpt-5.5"
    subagent_models = [
      "gpt-5.6-luna",
      "gpt-5.4-mini",
      "gpt-5.3-codex-spark",
    ]

    [cli.grok]
    enabled = false
    runner = ""
    longctx = ""
    subagent_models = []

    [ops.runner]
    actions = ["test", "build", "lint", "typecheck"]

    [ops.longctx]
    actions = ["search", "digest", "git-summarize", "git-commit"]

runner、longctx 只是标签，不声明模型一定快、一定有长上下文，或一定具备某种 capability。两者看到的是同一份所选 CLI 返回的模型列表。

被设置为 runner 或 longctx 的模型会自动加入 subagent_models。CLI 配置关闭时，不提供任何候选。

也可以非交互配置：

    baton config \
      --cli codex|grok \
      --runner gpt-5.4-mini \
      --longctx gpt-5.5 \
      --subagent-model gpt-5.6-luna \
      --subagent-model gpt-5.4-mini \
      --subagent-model gpt-5.3-codex-spark \
      --enable

所选 CLI 的 picker 列表变化后，运行 baton models refresh。

## Mini 与 Spark

只要 Codex 的 model/list 返回 gpt-5.4-mini 或 gpt-5.3-codex-spark，Baton 就会把它们展示出来，并允许写入 subagent_models。

这里区分四层证据：

- picker 可见：这个模型可以配置；
- 进入 allowlist：Baton 可以自动选它；
- dispatch：再次校验模型及 reasoning effort 仍存在于保存的 CLI catalog；
- host-native 真正拒绝：这才是该次执行失败的证据。

Baton 没有硬编码模型系列禁令。不能只因为某个 tool schema 或帮助文本没列 Mini/Spark，就提前标成 unsupported。

## 自动匹配

baton spawn 和 baton apply 不再让用户选模型。Baton自动决定：

- 根据 work unit 和 CLI 模型描述选择已配置模型；
- 根据任务复杂度，从 CLI 返回的 reasoning effort 中选择一个；
- 任务强调快速时，结合 CLI 描述以及 speed/service-tier 元数据匹配 fast 模型或精确 service tier；
- 使用可选的本地 capability 数据和近期 route health 做进一步排序。

Artificial Analysis 数据只是可选证据。没有 benchmark 时保持 unranked，但不会因此排除一个 Codex 已返回且用户已配置的模型。

显式 --model、--route、baton config model-selection、selector render 和用户模型确认都已移除。自动决策仍会写入 proposal、ticket 和 Delegation Receipt，便于审计。

Baton 不继承 parent 模型，不越过启用的 allowlist，不编造 CLI 没返回的 effort 或 fast 参数，也不会在 ticket 失败后静默换模型。

## 执行生命周期

Baton CLI 负责 ticket 与生命周期状态；只有所选 host（Codex 或 Grok）调用原生 subagent 工具。

1. baton spawn 或 baton apply 创建已自动路由的 ticket 和不可变 Receipt。
2. host 用 baton dispatch next 预留任务。
3. host 调用原生 spawn_agent，传精确模型、存在时传已支持的 reasoning effort，以及 host 暴露时传自动选择的 service tier，并使用 fork_context=false。若 host 无法表达这个 tier，必须报告该执行选项不可用，不能静默声称已启用 Fast。
4. host 绑定 agent id，记录活动和进度，并只写一个终态。
5. host 关闭原生 agent，执行 dispatch release 后再从 FIFO 补位。

逻辑任务不封顶；物理并发遵守当前 host 上限。AgentLimitReached 只把同一 ticket 延后，不消耗 attempt，也不换模型。轮询 timeout 不是 worker 失败；只有 exact agent 被 probe 为 not_found 后，ticket 才能 timeout。

默认只读。写任务必须带不可变路径和操作 allowlist，并通过 parent Git safety gate。唯一的 Git 例外是独占 commit-only ticket：它只消费 parent 已精确 staged 的 tree，允许创建一个受审计 commit，不能 stage、amend、切分支、rebase、tag 或 push。

## OpenSpec 与状态

OpenSpec 可选。存在时它负责任务拆解与状态，Baton 负责路由 ready task，并按稳定 task number 写回结论。不存在时，baton spawn 仍完整可用。

Baton 不创建项目内运行时目录：

- ~/.baton/config.toml：director 与各 CLI 配置
- ~/.baton/cache/cli-models.json：所选 CLI 的 catalog snapshot
- ~/.baton/cache/capabilities/：可选本地 capability 证据
- ~/.baton/workspaces/CANONICAL-ROOT-SHA256/：ticket、Receipt、selection、lock 和生命周期状态

## 命令

    baton init [--force]
    baton update
    baton config [--cli codex|grok] [--runner MODEL|-] [--longctx MODEL|-]
                 [--subagent-model MODEL|all] [--enable|--disable]
    baton models refresh|status|candidates
    baton cards [--ranked|--unranked] [--json]
    baton match "快速修复 flaky auth tests"
    baton spawn "实现迁移" [--unit KEY=TEXT ...]
    baton apply [change]
    baton dispatch next --host HOST --capacity N --json
    baton dispatch bind TICKET --agent-id ID --host HOST --json
    baton dispatch defer TICKET --code AGENT_LIMIT_REACHED [--observed-capacity N] --json
    baton dispatch probe TICKET --agent-id ID --state pending_init|running|interrupted|shutdown|not_found --json
    baton dispatch progress TICKET --phase PHASE --text "short status" --json
    baton dispatch complete TICKET --text "short conclusion" --json
    baton dispatch fail|timeout|close TICKET --json
    baton dispatch release TICKET --agent-id ID --json
    baton dispatch recover|status --json
    baton status

## License

MIT
