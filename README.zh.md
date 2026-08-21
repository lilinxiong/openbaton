# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

指挥棒。多模型协作的 director：一个入口对话，按 capability 分派原生 spawn，主上下文洁癖。

既能独立，又能 1+1>2 — 单独可用；有 OpenSpec 时严格更好。

```
bun add -g baton
baton init
```

源码 checkout：`bun install && bun run baton -- <command>`。需要 Node.js 22.5+ 或 Bun 1.3.14+。

English: [README.md](README.md)

## 它是什么

不是又一个 coding CLI。Baton 是一套只支持 Codex 的 skill pack。`baton init` 把 director 装进 Codex，让一个前台对话可以把工作分给精确的 OpenCodex route。

能够 spawn 不同模型，只是有了执行原语。真实工作还需要决定每个 unit 交给哪条准确 route、worker 被允许写什么、超过 host 并发上限时如何排队，以及怎样只把主 agent 真正需要的证据带回前台。

Baton 把每个 unit 变成可路由、可审计的 ticket。不同 worker 可以并行承担分析、实施或 review，但始终保持 depth 1：不形成递归 agent 树，也不成为第二个前台对话。

## 一次会话怎么走

用户照常和 Codex 说话。director 自己跑 Baton，用户不必手打这些命令。

1. **拆工作。** 普通请求先收成有 objective / deliverable / done condition 的具体 unit。很小的 rename、typo 可以由 director 自己做；实施、探索一类工作必须离开。
2. **Baton 按需同步一次。** OpenCodex 负责自身 runtime / provider 同步。Baton 只在本地 snapshot 缺失、过期或用户明确要求时，从 OpenCodex 刷新一次 route / profile / quota snapshot；不再做 per-session host sync。
3. **一次出 proposal，不出 ticket。** 一次普通请求只生成一个 request-level proposal，里面汇总所有有边界的工作单元。`baton spawn --unit ...` 或 `baton apply` 此时只写 proposal。
4. **一次披露、一次确认。** Provider 是整次请求的一个全局多选；下面统一展示全部候选和全部任务分配。同一前台请求涉及多个 workspace 时，把各自 proposal 合成一个 bundle，只保留一个 Submit。Submit 之前，ticket 数和 subagent 数都是 0。
5. **才铸 ticket。** `baton selection approve ... --confirm` 创建 queued ticket 和不可变 Delegation Receipt。bundle Submit 会把同一个 confirmation id 和全局 Provider 选择写入全部 proposal。OpenCodex catalog snapshot 或源任务变化会使旧 proposal 失效。
6. **进程内 dispatch。** Codex 用 `baton dispatch next` 预留，调用 host-native `spawn_agent`，bind 返回的 agent id，然后只写一次终态。`close_agent` 再加 `dispatch release` 才释放物理槽位，FIFO 补位。
7. **按活动性等待，不按耗时判死。** 有界 `wait_agent` 窗口只用于轮询。用 `baton dispatch probe` 持久化 exact agent 的 host 状态；只要仍是 `pending_init` / `running`，或者有 output / heartbeat，就无限续等同一 ticket。业务 progress 单独保存。只有最新匹配 probe 为 `not_found` 并提供其 sequence，才允许 timeout。
8. **前台保持干净。** concrete worker 只回短结论；deliberative worker 可以 checkpoint phase、current result、next step、blocker。工具倾倒和隐藏推理留在子上下文。

机械任务在用户全局 `~/.baton/config.toml` 已配置且 route 存在于已同步 OpenCodex snapshot 时，可以跳过选择器。空配置表示该类由 director 自己跑。

## 始终成立的约束

- **只支持 Codex。** skill 装到 `~/.codex`，Baton 状态在 `~/.baton`。不接入其他 coding CLI host，不 shell 到 print mode，也没有 Baton login。
- **route 可用性归 OpenCodex。** Baton 只选择已同步 OpenCodex snapshot 里的精确、非 disabled route/profile，不再拿 session model list 做二次过滤。若 host-native spawn 在实际执行时仍拒绝该 route，director 原样报告执行错误，绝不换 route。
- **没有静默替换。** 不 inherit 父模型，不在 route/provider 间 fallback，不接受本地 alias 或 override。显式选择必须是精确的 OpenCodex route/profile id。
- **Catalog 可见性与 subagent 资格分离。** OpenCodex discovery 仍完整可审计。内置 policy 禁止 `gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra` 的所有 provider route、variant 和 reasoning profile 进入候选、确认、ticket 和 dispatch。proposal 会单独披露这些排除。其它 session / Goal exclusion 只影响本次调度。
- **不编造 unranked。** profile 缺失或 `-fast` / `-highspeed` 等 serving variant 回退到基础分时标记 `reference_only`，不参与自动优选。用户可以选已披露且可调用的 `unranked` route，但不能覆盖禁用系列。
- **逻辑工作不封顶。** host/session 并发上限是运行时能力，不写死为 6。超限把同一张 ticket 放回 FIFO，不消耗 attempt。终态 agent 在 close + release 成功前仍占槽位。深度为 1。
- **不按计时判定 worker 死亡。** 重复 wait-call timeout 或没有 progress 文本，都不能把仍在 running 的 agent 判死。Baton 单独记录 host liveness，只有当前 exact agent 被探测为 `not_found` 后才允许 ticket timeout。
- **Worker 永不拥有 Git。** 不 stage、commit、branch、rebase、push。写 ticket 必须有显式 allowlist，并在每条终态路径（含 error / timeout / close）走父 agent 的 Git safety gate。

## OpenSpec

有 OpenSpec 时，它负责拆解和状态。Baton 负责谁跑每条 ready task，并按稳定 task number 写回结论。

没有 OpenSpec 时，`baton spawn` 照样能用。

不重做 OpenSpec。

## OpenCodex

OpenCodex 通过 Baton 的 package dependency / runtime resolver 消费。provider 账号、认证、模型发现、主额度报告和 route 执行归 OpenCodex；Baton 只调度。

Baton 没有 login、账号、token 或 credential 命令。不要往这个项目里粘贴 base URL 或 API key。

## 模型选择

`spawn` / `apply` 会为每个委派 unit 披露：

- 评分有唯一正分胜者时的优选 exact route/profile，否则明确进入手工选择
- 所有符合内置 policy、在 OpenCodex snapshot 中可执行的候选，含优势、任务分、AA 原始分/现有数据、参考分来源、剩余额度或明确 unknown 原因、以及 snapshot callability
- 内置的 `gpt-5.5` / `gpt-5.6-sol` / `gpt-5.6-terra` 系列禁令

候选按 quota pool 分组，不摊成一张平铺列表。普通 provider 一组；Cursor 拆成 `cursor-auto`（仅 Grok / Composer 系列，月度/Auto 额度）和 `cursor-api`（其他 Cursor route，API usage）。有额度的组按剩余额度排序，unknown 其次，额度为 0 的组置灰、折叠并排在最后。ASR / TTS / voice-clone / voice-design 对文本推理任务记为 `TASK_CAPABILITY_MISMATCH`。

Quota 优先级是 `OpenCodex reported > 本机 CodexBar fallback > unknown`。CodexBar 只是带来源标记的本地提示，可能对应其本机所选账号，不会覆盖 OpenCodex 已报告窗口，也不改变 provider / auth / route 所有权。Baton 只保存脱敏后的百分比/reset 窗口和 `codexbar:...` 来源。未报告额度绝不当作 0 或“够用”。详见 [CodexBar quota fallback](docs/data-sources/codexbar.md)。

选择器只出现在当前 Codex 对话里，并且是中文优先。一次请求只给一张汇总选择器：先统一选 Provider，再看全部 exact route/profile，然后集中分配各路径任务，最后一个 Submit。多个 workspace proposal 使用 `baton selection render-bundle`。英文源 task 必须通过 `--task-label` 提供忠实的中文展示名；这些 label 只影响展示，不改原始 request、task 或 fingerprint。Codex 必须在同一条回复里发出唯一的 `inline_content_reference`。禁止打开浏览器、跳转 `file://`、暴露文件链接，或另开 selector 页面/窗口/任务。内联渲染不可用时，完整的汇总中文披露仍留在本对话文本里。

## 全局 ops 配置

`~/.baton/config.toml` 通过 `[ops.runner]` 和 `[ops.longctx]` 保存两类机械任务的可选 exact route，同一份选择作用于所有 workspace。没有内置默认。

| 类别 | 何时使用 | 空表示 |
| --- | --- | --- |
| `runner` | 会结束的 test / build / lint / typecheck | 由 director 自己跑 |
| `longctx` | 检索 / 消化 / git-summarize，以及给已 staged 文件写 commit message；大约需要 1M 上下文 | 由 director 自己跑 |

`baton config` 直接通过 OpenCodex 刷新 route / quota snapshot，列出符合 policy 的可执行 route，并交互写入全局选择；它不依赖 Codex session snapshot。Dispatch 只校验配置 route 仍存在于已同步 OpenCodex snapshot，不存在时返回 `OPS_ROUTE_UNAVAILABLE`。它不会 inherit 父模型。要等 worker 结论，包括命令失败。Worker 从不 `git commit`。

## 能力缓存

Artificial Analysis 是可选、可替换的能力数据源。普通调度只读用户全局的 `~/.baton/cache/capabilities/artificial-analysis.sqlite3`。

```
baton capabilities refresh --provider aa --key-file /private/tmp/openbaton-aa-api-key
baton capabilities status
baton capabilities show gpt-5.6-luna --profile high
```

不做模糊模型匹配。缺失指标保持 unknown。能力证据不替代 route health、quota、授权或 session policy。详见 [Artificial Analysis 能力缓存](docs/data-sources/artificial-analysis.md)。

## 状态目录

Baton 不生成项目内 `.baton/` 运行时目录，也不再读取或生成项目 `.baton.toml`。机械任务策略与 director 设置共用用户全局 `~/.baton/config.toml`。

`~/.baton` 下：

- `config.toml`、`SKILL.md`：用户全局 director/ops 设置和 skill
- `cache/`：共享的 OpenCodex Route Snapshot 与 capability 数据
- `workspaces/<canonical-root-sha256>/`：ticket、Receipt、run、lock 和记住的 host capacity
- `workspaces/<canonical-root-sha256>/selections/`：待确认 / 已确认的模型披露

## 命令

```
baton init [--force]
baton update
baton config [--runner ROUTE|-] [--longctx ROUTE|-]

baton routes refresh|status|candidates
baton cards [--ranked|--unranked] [--provider ID] [--json]
baton match "fix the flaky auth tests"
baton capabilities refresh --provider aa --key-file PATH
baton capabilities status
baton capabilities show ROUTE [--profile PROFILE]

baton spawn "explore why CI is red" --unit audit="audit the failures" --unit report="report the findings"
baton spawn "edit one file" --model kimi/k3[1m] --write-path src/file.ts --write-ops write
baton apply [change] [--route TASK=EXACT_ROUTE]
baton selection show PROPOSAL
baton selection render PROPOSAL --output PATH --task-label TASK=中文说明 [--json]
baton selection render-bundle --proposal 'SCOPE=WORKSPACE#PROPOSAL' ... --output PATH --task-label SCOPE/TASK=中文说明 [--json]
baton selection approve PROPOSAL --confirm [--route TASK=ID] [--provider ID] [--global-provider ID] [--confirmation-id ID] [--confirmation-scope proposal|bundle]

baton dispatch next --host codex --capacity N --json
baton dispatch bind TICKET --agent-id ID --host codex --json
baton dispatch defer TICKET --code AGENT_LIMIT_REACHED [--observed-capacity N] --json
baton dispatch probe TICKET --agent-id ID --state pending_init|running|interrupted|shutdown|not_found [--activity status|output|heartbeat] --json
baton dispatch progress TICKET --phase PHASE --text "short status" --json
baton dispatch complete TICKET --text "short conclusion" --json
baton dispatch fail TICKET --json
baton dispatch timeout TICKET --probe-sequence N --json
baton dispatch close TICKET --json
baton dispatch release TICKET --agent-id ID --json
baton dispatch recover|status --json

baton conversation promote --from-file PATH
baton status
```

`baton update` 会刷新已安装的 Codex skill，并合并全局 director/ops 默认值，不覆盖已经选择的 ops route。`~/.baton/config.toml` 保存并发、深度和可选机械任务 route；其中的 route 仍必须是 OpenCodex exact route。

## Samples

[`samples/`](samples/README.md) 内置了两条使用同一事故审计数据的可重复路径：

- 无 OpenSpec 的 standalone
- strict-valid OpenSpec tasks 与稳定 conclusion writeback

两条用户请求都是无感触发文本，不出现 Baton 或 subagent。

## License

MIT
