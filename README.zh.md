# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

指挥棒。多模型协作的 director：一个入口对话，按 capability 分派原生 spawn，主上下文洁癖。

既能独立，又能 1+1>2 — 单独可用；有 OpenSpec 时严格更好。

```
npm i -g baton   # 源码 checkout：npm run baton -- <command>
baton init
```

## 为什么需要 OpenBaton

能够 spawn 不同模型，只是有了执行原语。真实工作还需要决定每个 task 应该交给哪条准确 route、worker 被允许做什么、超过 host 并发上限时如何排队，以及怎样只把主 agent 真正需要的证据带回前台。

OpenBaton 把每个 execution unit 变成可路由、可审计的 ticket。主 agent director 按 task 从显式 card 和当前可执行的 OpenCodex routes 中选择。不同 worker 可以并行承担分析、实施或 review，但始终保持 depth 1，不形成递归 agent 树，也不成为第二个前台对话。

目标不只是“开更多 agent”，而是在一个对结果负责的 workflow 中，安全、可解释、无静默 fallback 地使用多个模型。

## 它是什么

不是又一个 coding CLI。而是一套 skill pack + `init`，坐在支持的 host 前面（Claude Code、Cursor、Codex、…）。

- **Dynamic Cards。** 所有 OpenCodex live provider/route 都保持可见；精确 AA mapping 生成结构化 capability 和定位推断，未映射 route 保持 `unranked`。
- **Config 只保存策略。** `~/.baton/config.toml` 只放 alias、可选 policy hint 和 exclusion，不复制 benchmark 分数；没有默认 subagent、父模型继承或静默 fallback。
- **所有 route 保持可见。** OpenCodex discovery 是可执行 catalog；card 决定哪些 route 进入调度。当前 session/Goal 的 exclusions 只影响本次调度，不会变成全局 route-family 禁令。
- **host 原生 worker。** 进程内 spawn，不 shell 出去跑 coding CLI print mode。Codex init 装到 `~/.codex`，不写进项目；card 在 `~/.baton`。Baton 不支持 Grok host。
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

不做模糊模型匹配。没有精确 canonical mapping 的 route 保持 `unranked`：不阻塞使用，也不编造分数。详见 [Artificial Analysis 能力缓存](docs/data-sources/artificial-analysis.md)。

Dynamic Card matching 使用 AA intelligence/coding/agentic、cost、throughput 和 latency 证据。缺失指标保持 unknown；provider health、quota、授权和 session policy 仍是独立 gate。

## 状态目录

所有 Baton 自有状态都放在用户目录 `~/.baton`；Baton 不再生成项目内 `.baton`。

- `config.toml`、`SKILL.md`：用户全局策略和 skill。
- `cache/`：全局共享的 OpenCodex Route Snapshot 与 capability 数据。
- `workspaces/<canonical-root-sha256>/`：按 workspace 隔离的 ticket、Receipt、run、lock 和 host capacity。

## 命令

```
baton init [--force] [--tools claude,cursor,codex,agents]
baton capabilities status
baton capabilities show MODEL [--profile PROFILE]
baton routes refresh
baton routes status
baton routes candidates
baton conversation promote --from-file PATH
baton cards --ranked
baton cards --unranked --provider cursor
baton cards add --id reviewer --route xai/grok-4.6 --reasoning-effort high --strengths "review policy hint"
baton cards add --id cursor/claude-opus-5 --route cursor/claude-opus-5 --enabled false
baton match "fix the flaky auth tests"
baton spawn "explore why CI is red"
baton spawn "edit one file" --model kimi/k3[1m] --write-path src/file.ts --write-ops write
baton apply
baton dispatch next --host codex --capacity N --json
baton dispatch bind TICKET --agent-id ID --host codex --json
baton dispatch defer TICKET --code AGENT_LIMIT_REACHED --observed-capacity N --json
baton dispatch progress TICKET --phase working --text "已定位状态机" --next "检查恢复路径" --json
baton dispatch complete TICKET --text "short outcome" --json
baton dispatch release TICKET --agent-id ID --json
baton status
```

English: [README.md](README.md).

## License

MIT
