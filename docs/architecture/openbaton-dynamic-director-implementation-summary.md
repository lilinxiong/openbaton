# OpenBaton Dynamic Director 实现总结

完成日期：2026-08-19

## 结论

OpenBaton Codex 首版已经形成安全、可解释的动态多 subagent 闭环，并在最终 RC 验收中判定为 PASS。原验证报告中的 V-03～V-09 已逐批修复；默认只读，写 worker 必须持有不可变 Receipt，且 completed/errored/timed_out/closed 每条终态路径都执行 parent Git safety gate。

## 已实现能力

### TypeScript 基线

- `src/`、`test/`、`bin/` 无 JavaScript 源文件。
- NodeNext TypeScript build，生产源码执行 `tsc --noEmit`。
- 测试使用 TypeScript + `tsx`。
- 当前完整回归覆盖 concrete/deliberative work unit、checkpoint progress、host backpressure 与 slot release；以当次 `npm test` 输出为准。
- npm 发布只包含编译后的 `dist` 和必要 templates/data。

### Host-native 多 subagent

- `queued → dispatching → running → completed/errored/timed_out/closed`。
- ticket 保存真实 `agent_id`、route/profile、attempt、timestamps、history 和短结论。
- 持久化 FIFO，逻辑 ticket 不限；capacity 6 的验收场景严格 `6 running + 2 queued`，但 6 不是产品常量。
- 完成后只补位最早 queued ticket；新 ticket 不插队。
- `AgentLimitReached` 作为 backpressure 将原 ticket 放回 FIFO，不消耗 attempt、不污染 route health，并可收紧观测 capacity。
- terminal ticket 与物理 slot release 分离；只有 `close_agent` 成功并执行 `dispatch release` 后才补位。
- restart recovery 保留 running agent ID，返回 terminal-but-unreleased 的 `needs_close`，stale unbound dispatch 标记 `DISPATCH_LEASE_EXPIRED`。
- 缺 route/Receipt、context 不符合、attempt 超限均 fail-closed；无静默 fallback。

### Concrete-first 与进度同步

- Ticket schema v4 固化 `work_unit.kind=concrete|deliberative`、objective、deliverable、done condition、coordination policy，以及用户确认过的 exact model selection evidence。
- 具体执行任务默认 `terminal-only`；开放式或无法确定的任务按 `deliberative/checkpointed` 处理。
- checkpoint 只保存 phase、current result、next step、blocker/decision needed；拒绝 tool dump，并限制长度。
- director 优先把思考型工作留在主 agent 或拆成具体 unit；必须并行委派时使用 bounded fan-in wait，并把有意义的 phase change 写入 `dispatch progress`。

### Delegation Receipt 与写入安全

- 每个 ticket 引用独立、`0600`、不可变 Receipt。
- Receipt 固化 card、exact route、reasoning effort、mode、allowlist、operations、retry、fallback=none、Git policy 和 baseline。
- 默认 read-only；write mode 必须显式 `--write-path`/`--write-ops`。
- Parent safety gate 审计 tracked、untracked、create、delete、rename、chmod、symlink、dirty baseline、Git index 和 HEAD。
- 越界写入转为 `errored/WRITE_SCOPE_VIOLATION`，拒绝 worker conclusion 并释放槽位。
- Worker 永不拥有 stage/commit/branch/rebase/push。

### 全局状态目录

- Baton 不生成项目内 `.baton`。
- config/skill 和共享 route/capability cache 位于 `~/.baton`。
- ticket、Receipt、run、lock 和 capacity 位于 `~/.baton/workspaces/<canonical-root-sha256>`，同一 repo 子目录共享 namespace，不同 repo 隔离。

### Route Snapshot 与能力数据

- `baton routes refresh` 消费 OpenCodex `models live --json`。
- 稳定 SHA-256 fingerprint；catalog 不变不增加 generation。
- 所有 executable routes 自动生成 Dynamic Cards；精确 AA mapping 生成 profile capability，未映射 route 保持 `unranked`。
- 无 executable route 为 blocked；无 AA mapping 为 `unranked`，不猜分。
- Baton 不接受本地 alias/override；route/profile 完整集合只来自 OpenCodex snapshot。

### Codex host 交集与强制模型确认

- `baton host sync` 记录当前 Codex task 实际公开的 exact model 与 reasoning profile，并与 OpenCodex Route Snapshot 求交集；catalog-only 与 host-profile-unavailable 候选保持可见但不可派发。
- 普通请求触发 `spawn`/`apply` 时只生成 selection proposal，不生成 ticket；proposal 披露优选、完整候选、模型擅长项、任务分、原始 AA 指标、剩余额度或 unknown reason，以及当前可调用性。
- 用户必须在同一任务中显式确认，可改选任一已披露且可调用的 exact route/profile。确认写入不可变 ticket/Receipt evidence；host snapshot 或任务源变化会使 proposal 失效。
- 未确认、route/profile 不在当前 host 交集、Receipt 不一致时均 fail-closed；禁止静默 fallback。
- 内置 subagent policy 永久排除 `gpt-5.5`、`gpt-5.6-sol` 与 `gpt-5.6-terra` 全系列（所有 provider route、variant、reasoning profile）。Catalog/card 仍可审计，但 proposal candidate、自动优选、显式改选、旧 proposal/ticket 和 dispatch 均不能绕过；proposal 单独记录 `SUBAGENT_MODEL_FAMILY_FORBIDDEN`。
- Quota 按 provider 使用固定优先级：OpenCodex 有有效窗口时直接采用；仅缺失/unknown 时读取本机 CodexBar GUI 快照（其次 history，最后 CLI），以便与 CodexBar 界面一致；仍失败则保持 unknown。CodexBar fallback 只保存百分比、reset 和 `codexbar:...` provenance，不保存账号、认证、cookie/token、原始输出或原始错误，也不改变 OpenCodex 的 provider/auth/route 所有权。

### Dynamic Cards

- OpenCodex live routes 直接生成 exact route/profile cards；本地 config 不增加、重命名或隐藏模型。
- AA intelligence/coding/agentic、cost、throughput 和 latency 形成结构化 capability vector；定位标签是 percentile-derived inference。
- 自动匹配只选择 ranked executable 且符合内置 subagent policy 的 cards；unranked routes 保持可见，除 `gpt-5.5`/`gpt-5.6-sol`/`gpt-5.6-terra` 禁用系列外允许 exact `--model` 显式选择。
- 历史 RC 曾真实执行 `xai/grok-4.6@high` 并由 OpenCodex 日志确认单 attempt、无 fallback；这只是当次 host/catalog 快照证据，不代表当前 Codex task 仍公开该 route。

### Conversation-to-Goal

- Host skill 在普通对话中识别显式提升语句，不要求用户手动调用 skill。
- promotion draft 保留 `explicit/inferred/unresolved/excluded` 和 source hash。
- unresolved 阻止激活；任何副作用前需要一次用户批准。
- 有 OpenSpec 时业务 breakdown/plan 归 OpenSpec；无 OpenSpec 时归主 agent；Baton 不建立平行 ledger。

### OpenSpec

- Ticket 保存稳定 task number。
- completion 时重新解析当前 `tasks.md`，按 number 精确定位。
- task 缺失或重复时 fail-closed。
- 插行后不会再把 task `2.1` 的结论写到 `1.2`。

## 真实验收证据

### 8-ticket 只读闭环

```text
initial: 6 active + 2 queued
bind:    6 个真实 Codex agent_id
finish:  前 6 completed 并 close
refill:  只补位 ticket 7、8
final:   completed=8, active=0, available=6
```

### V-06 写入验收

本轮真实 Kimi workers 均只修改 Receipt 允许的 `allowed.txt`，证明正向 scope 生效。负向 gate 使用当前编译 CLI、真实 Git baseline 和实际 allowed + denied diff：

```text
ticket.status       = errored
ticket.error.code   = WRITE_SCOPE_VIOLATION
ticket.conclusion   = null
violation           = E_OUT_OF_SCOPE_PATH:denied.txt
slot                = released
```

同一负向场景通过 `dispatch fail --code UPSTREAM_429` 重跑后仍触发 safety gate，并在 `ticket.error.host_error` 中保留原始 host error。

### OpenCodex catalog

真实 `routes refresh`：66 条 executable route，generation 1，fingerprint 已持久化。

## 提交拆分

实现没有压成单个大提交；主要提交包括 capability cache、dispatch lifecycle、TS cutover、host protocol、类型收紧、Receipt、safety audit、write completion、Route Snapshot、Conversation promotion、OpenSpec stable writeback 和最终审计修复。

## 边界

- 当前最终 PASS 针对 Codex host adapter；其它 host 必须独立验证。
- AA Free 数据库只保存在用户全局 `~/.baton/cache`，不进入项目 Git 工作树。
- Benchmark 是主 agent 的证据，不是自动决策器。
- Parent 始终拥有业务裁决、验收、测试与 Git。
- OpenCodex catalog 的所有 executable routes 保持可见；`gpt-5.5`/`gpt-5.6-sol`/`gpt-5.6-terra` 是内置 subagent 资格禁令，其它 session/Goal exclusions 仅在当前调度生效，不是全局 Claude 或 provider 禁令。
- Dynamic Cards 覆盖完整 OpenCodex live catalog；真正可派发集合还必须与当前 Codex task 的 model/profile surface 求交集。用户 config 只保存 director 设置。
