# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

指挥棒。多模型协作的 director：一个入口对话，按 capability 分派原生 spawn，主上下文洁癖。

既能独立，又能 1+1>2 — 单独可用；有 OpenSpec 时严格更好。

```
bun add -g baton   # 源码 checkout：bun run baton -- <command>
baton init
```

## 为什么需要 OpenBaton

能够 spawn 不同模型，只是有了执行原语。真实工作还需要决定每个 task 应该交给哪条准确 route、worker 被允许做什么、超过 host 并发上限时如何排队，以及怎样只把主 agent 真正需要的证据带回前台。

OpenBaton 把每个 execution unit 变成可路由、可审计的 ticket。主 agent director 按 task 从显式 card 和当前可执行的 OpenCodex routes 中选择。不同 worker 可以并行承担分析、实施或 review，但始终保持 depth 1，不形成递归 agent 树，也不成为第二个前台对话。

目标不只是“开更多 agent”，而是在一个对结果负责的 workflow 中，安全、可解释、无静默 fallback 地使用多个模型。

## 它是什么

不是又一个 coding CLI，而是一套只支持 Codex 的 skill pack + `init`，为 Codex 增加多模型 director。

- **Dynamic Cards。** 所有 OpenCodex live provider/route 都保持可见；精确 AA 证据生成结构化 capability 和定位推断。profile 缺失或 serving variant 回退到基础分时会明确标记“仅供参考”，不参与自动优选；AA 没有聚合排名指标时仍披露现有数据。
- **Config 只保存 director 设置。** `~/.baton/config.toml` 只放并发/深度参数，不支持本地模型 alias 或 route override。
- **Catalog 可见性与 subagent 资格分离。** OpenCodex discovery 仍完整可审计。内置 policy 禁止 `gpt-5.5`、`gpt-5.6-sol`、`gpt-5.6-terra` 的所有 provider route、variant 和 reasoning profile 进入 subagent 候选，proposal 会单独披露；其它 session/Goal exclusion 仍只影响本次调度。
- **当前 host 取交集。** route 必须同时满足 OpenCodex 可执行、当前 Codex session 的 `spawn_agent` 已声明；只在 catalog 中存在的 route 仍可见，但标为 `HOST_ROUTE_UNAVAILABLE`。
- **模型必须确认。** `spawn/apply` 先用对比表披露优选与候选 exact route、模型优势、任务分、AA 原始分/现有数据、参考 route/profile 来源、provider 剩余额度/重置时间（或明确 unknown 原因）及可调用性。用户确认或改选前不创建 ticket。
- **额度来源与本地 fallback。** OpenCodex 已报告的 quota 永远优先；只有某个 provider 缺失或 unknown 时，Baton 才读取本机 CodexBar GUI 快照（其次 history，最后 CLI），并以 `codexbar:...` 来源保存脱敏后的百分比/reset 窗口；仍取不到就明确保持 unknown。
- **项目 ops 配置。** 仓库根的 `.baton.toml` 保存可选的 `runner` / `longctx` exact route。没有内置默认；空则该类由主 agent 执行。`baton config` 只列出当前 host 可调用且按类过滤后的选项。已配置但当前不可调用则失败，不 inherit 父模型。
- **Codex 原生 worker。** 只使用进程内 Codex subagent；Baton 不接入其他 coding CLI host，也不 shell 到 print mode。skill 安装到 `~/.codex`，Baton 状态保存在 `~/.baton`。
- **逻辑上无限 spawn。** host/session 的并发上限是运行时能力，不写死为 6；超限作为 backpressure 回到 FIFO，不消耗 attempt。真实 `close_agent` 后才释放 slot。深度 1。
- **具体任务优先。** Ticket 区分 `concrete` 与 `deliberative`。优先把工作拆成有 objective/deliverable/done condition 的具体单元；必须委派思考任务时使用 checkpoint 状态同步。
- **洁癖。** 普通 worker 只回短结论；checkpoint 也只包含 phase、current result、next step、blocker。工具倾倒和隐藏推理不进主会话。

## OpenSpec

有 OpenSpec 时，它负责拆解和状态。baton 负责谁跑每个任务，并把结论写回去。

没有 OpenSpec 时，`baton spawn` 照样能用。

不重做 OpenSpec。

## OpenCodex

OpenCodex 通过 Baton 的 package dependency/runtime resolver 消费。provider 账号、认证、模型发现和 route 执行归 OpenCodex；Baton 只调度（card、match、director），没有 login 或 credential 命令。

既能独立，又能 1+1>2 — baton 负责分派；账号由 OpenCodex 持有。

## 能力缓存

Artificial Analysis 是可选、可替换的能力数据源。只在显式刷新时通过安全的临时 key 文件访问远端；普通调度只读用户全局的 `~/.baton/cache/capabilities/artificial-analysis.sqlite3`。

```
baton capabilities refresh --provider aa --key-file /private/tmp/openbaton-aa-api-key
baton capabilities status
baton capabilities show gpt-5.6-luna --profile high
```

不做模糊模型匹配。profile 没有 AA 数据时可展示 base profile 分；`-fast`/`-highspeed` 等 serving variant 可展示去后缀基础模型分，两者都明确标注“仅供参考”且不参与自动优选。既无精确证据也无确定性参考证据的 route 保持 `unranked`：不阻塞使用，也不编造分数。详见 [Artificial Analysis 能力缓存](docs/data-sources/artificial-analysis.md)。

Dynamic Card matching 使用 AA intelligence/coding/agentic、cost、throughput 和 latency 证据。缺失指标保持 unknown；provider health、quota、授权和 session policy 仍是独立 gate。

## 模型选择握手

普通业务请求进入实施后，由 Codex director 无感执行；用户不需要知道 Baton 命令：

1. 把当前 Codex calling-host 模型选择器/host tool schema 暴露的完整 exact model 和允许的 reasoning effort 用 `baton host sync --model ... --profile ROUTE=...` 同步给 Baton；不得用更短的 `spawn_agent` optional-override 提示截断 host surface。Baton 优先读取 OpenCodex 的脱敏 quota report，只对 OpenCodex 未报告的 provider 读取本机 CodexBar GUI 快照（其次 history，最后 CLI）。
2. `baton spawn` 或 `baton apply` 只创建 selection proposal，不创建 ticket。
3. director 向用户展示优选及所有符合内置 policy 的当前可调用候选，包含优势、任务分、AA 分/现有数据、参考分来源、剩余额度、重置时间和可调用状态；`gpt-5.5`/`gpt-5.6-sol`/`gpt-5.6-terra` 全系列禁令单独披露。
4. 用户保留或修改选择后，`baton selection approve ... --confirm` 才创建 immutable Receipt 和 queued ticket。host snapshot 或源任务发生变化时，旧 proposal 失效。

候选按 quota pool 分组：普通 provider 一组；Cursor 拆成 `Cursor Auto`（仅 Grok/Composer 系列）和 `Cursor API`（其他 Cursor route）。有额度的组按剩余额度降序，`unknown` 其次，额度为 0 的组置灰、隐藏模型并排在最后。ASR/TTS/voice-clone/voice-design 等不适合文本推理任务的 route 进入 `TASK_CAPABILITY_MISMATCH` 排除清单。`baton selection render PROPOSAL --output PATH --task-label TASK=中文说明 --json` 返回中文的“仅限当前对话内联” content reference；英文源 task 必须提供忠实的中文展示名，但不会修改原始 request、task 或 fingerprint。Codex host 必须在当前回复中嵌入该 reference，禁止用浏览器打开、跳转 `file://`、暴露文件链接或创建独立 selector 页面/窗口。交互仍是“勾选模型 → 分配任务 → 确认提交”，确认前始终是 0 ticket、0 subagent。

Quota 优先级是 `OpenCodex reported > 本机 CodexBar fallback > unknown`。CodexBar 只提供带来源标记的本地提示，可能对应其本机所选账号，不改变 OpenCodex 对 provider/auth/route 的所有权。Baton 不保存 CodexBar 的账号邮箱/ID、login method、cookie、token 或原始错误。Provider 仍无法报告额度时显示 `unknown`，绝不当作 0 或“额度充足”。用户可以显式选择 proposal 中可调用的 `unranked` route，但不能覆盖内置禁用系列；Baton 不会自动推荐 unranked route，也不会在模型/provider 间 fallback。详见 [CodexBar quota fallback](docs/data-sources/codexbar.md)。

## 状态目录

所有 Baton 自有状态都放在用户目录 `~/.baton`；Baton 不再生成项目内 `.baton`。

- `config.toml`、`SKILL.md`：用户全局 director 设置和 skill。
- `cache/`：全局共享的 OpenCodex Route Snapshot 与 capability 数据。
- `workspaces/<canonical-root-sha256>/`：按 workspace 隔离的 ticket、Receipt、run、lock 和 host capacity。
- `workspaces/<canonical-root-sha256>/selections/`：待确认/已确认的模型披露与用户 approval。

## 命令

```
baton init [--force]
baton capabilities status
baton capabilities show MODEL [--profile PROFILE]
baton routes refresh
baton routes status
baton routes candidates
baton host sync --model gpt-5.6-luna --profile gpt-5.6-luna=low,medium,high,xhigh,max --model alibaba-token-plan/glm-5.2 --profile alibaba-token-plan/glm-5.2=low,medium,high,xhigh,max
baton host status
baton conversation promote --from-file PATH
baton cards --ranked
baton cards --unranked --provider kimi
baton match "fix the flaky auth tests"
baton spawn "explore why CI is red"
baton spawn "edit one file" --model kimi/k3[1m] --write-path src/file.ts --write-ops write
baton apply
baton selection show sel-0001
baton selection render sel-0001 --output /absolute/path/selection.html --task-label '1.1=中文任务说明' --json
baton selection approve sel-0001 --confirm
baton selection approve sel-0002 --confirm --model gpt-5.6-luna@low
baton selection approve sel-0003 --confirm --route 1.1=gpt-5.6-luna@high
baton dispatch next --host codex --capacity N --json
baton dispatch bind TICKET --agent-id ID --host codex --json
baton dispatch defer TICKET --code AGENT_LIMIT_REACHED --observed-capacity N --json
baton dispatch progress TICKET --phase working --text "已定位状态机" --next "检查恢复路径" --json
baton dispatch complete TICKET --text "short outcome" --json
baton dispatch release TICKET --agent-id ID --json
baton status
```

## Samples

[`samples/`](samples/README.md) 内置了两条使用同一事故审计数据的可重复验收路径：

- 无 OpenSpec 的 standalone；
- strict-valid OpenSpec tasks 与稳定 conclusion writeback。

两条用户请求均为无感触发文本，不出现 Baton 或 subagent。

English: [README.md](README.md).

## License

MIT
