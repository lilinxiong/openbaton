# OpenBaton Dynamic Director 实现总结

完成日期：2026-08-19

## 结论

OpenBaton Codex 首版已经形成安全、可解释的动态多 subagent 闭环，并在最终 RC 验收中判定为 PASS。原验证报告中的 V-03～V-09 已逐批修复；默认只读，写 worker 必须持有不可变 Receipt，且 completed/errored/timed_out/closed 每条终态路径都执行 parent Git safety gate。

## 已实现能力

### TypeScript 基线

- `src/`、`test/`、`bin/` 无 JavaScript 源文件。
- NodeNext TypeScript build，生产源码执行 `tsc --noEmit`。
- 测试使用 TypeScript + `tsx`。
- 当前完整回归为 144 passed、0 failed。
- npm 发布只包含编译后的 `dist` 和必要 templates/data。

### Host-native 多 subagent

- `queued → dispatching → running → completed/errored/timed_out/closed`。
- ticket 保存真实 `agent_id`、route/profile、attempt、timestamps、history 和短结论。
- 持久化 FIFO，逻辑 ticket 不限；Codex capacity 6 时严格 `6 running + 2 queued`。
- 完成后只补位最早 queued ticket；新 ticket 不插队。
- restart recovery 保留 running agent ID，stale unbound dispatch 标记 `DISPATCH_LEASE_EXPIRED`。
- 缺 route/Receipt、context 不符合、attempt 超限均 fail-closed；无静默 fallback。

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
- `baton update` 将旧 benchmark cards 迁移为 alias/policy hints，不覆盖用户自定义 override/exclusion。

### Dynamic Cards

- 当前 66 条 OpenCodex live routes 生成 89 张 route/profile/override cards：33 ranked、56 unranked、4 user overrides。
- AA intelligence/coding/agentic、cost、throughput 和 latency 形成结构化 capability vector；定位标签是 percentile-derived inference。
- 自动匹配只选择 ranked executable cards；unranked routes 保持可见，并允许 exact `--model` 显式选择。
- 真实无 `--model` 任务选择并执行 `xai/grok-4.6@high`；OpenCodex 日志确认单 attempt、无 fallback。

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
- OpenCodex catalog 的所有 executable routes 保持可见；session/Goal exclusions 仅在当前调度生效，不是全局 Claude 或 provider 禁令。
- 当前 Dynamic Cards 覆盖完整 OpenCodex live catalog；用户 config 只保存 alias、hint 和 exclusion。
