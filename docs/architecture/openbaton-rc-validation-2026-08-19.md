# OpenBaton Codex RC 验收报告

> 历史快照说明：本报告记录 2026-08-19 RC。当时“不得设全局 model-family 禁令”的结论已被 2026-08-20 产品策略取代；当前实现永久禁止 `gpt-5.5`、`gpt-5.6-sol` 与 `gpt-5.6-terra` 全系列作为 subagent 候选或 dispatch route。

验收日期：2026-08-19

## 结论

**`PASS / Codex 首版闭环通过`**。

本结论覆盖 Codex host adapter、OpenCodex 2.25.0、OpenSpec 1.9.0、Node 26.6.0。其它 host adapter 仍需分别验收；它们不阻塞 Codex 首版 PASS。

## 验收矩阵

| Gate | 结果 | 当前证据 |
| --- | --- | --- |
| Git / TypeScript | PASS | 144/144 tests；`tsc --noEmit`、`git diff --check` 通过 |
| Build / package | PASS | `npm pack` 成功，144 entries；隔离安装后 `baton init/spawn/status` 与 OpenCodex 2.25.0 可运行 |
| 全局状态目录 | PASS | cache 位于 `~/.baton/cache`；workspace runtime 位于 `~/.baton/workspaces/<canonical-root-sha256>`；项目目录无 `.baton` |
| Route Snapshot | PASS | 66 routes；generation 1；catalog 不变时 fingerprint 稳定 |
| Dynamic Cards | PASS | OpenCodex live routes 生成 exact route/profile cards；不接受本地 alias/override，缺失指标保持 null |
| 8-ticket FIFO | PASS | 6 active + 2 queued；只依次补位 7、8；最终 8 completed、active 0、available 6 |
| Capacity lifecycle | PASS | 仅在第一次 `dispatch next` 传 6；后续 bind/complete/status/recover 均从持久状态读取 6 |
| Provider / no fallback | PASS | OpenCodex usage ledger 的 8/8 请求均为 `kimi/k3-256k`、HTTP 200、单 attempt、无 recovery、`explicit-provider-namespace` |
| Dynamic selection execution | PASS | 无 `--model` 的复杂仓库任务选择 `xai/grok-4.6@high`；真实 host 完成，日志为 xAI/Grok 4.6、high、HTTP 200、单 attempt、无 recovery |
| Real write positive | PASS | 真实 Kimi worker 只修改 Receipt 允许的 `allowed.txt`；parent safety verdict accepted |
| Completion-path negative | PASS | 当前编译 CLI 在 allowed + denied diff 下转为 `errored/WRITE_SCOPE_VIOLATION`，拒绝 conclusion，释放 slot |
| Error-path negative | PASS | `UPSTREAM_429` 终态也执行 safety audit；外层错误为 `WRITE_SCOPE_VIOLATION`，并保留结构化 `host_error` |
| OpenSpec stable identity | PASS | ticket 保存 `2.1`；插入新的 `1.3` 后只完成 `2.1`，`1.3` 保持 pending；strict validate 通过 |

## 写入安全说明

本轮两个真实 worker 都拒绝修改 Receipt 范围外的 `denied.txt`，因此真实 host 证明了正向 scope 行为。Parent gate 的负向验收使用当前编译产物、真实 Git baseline 和真实文件 diff 注入，不依赖模型是否愿意作恶：

```text
allowed.txt modified
denied.txt modified
→ safety_verdict.accepted = false
→ ticket.status = errored
→ ticket.error.code = WRITE_SCOPE_VIOLATION
→ ticket.conclusion = null
→ active = 0
```

当 host 同时返回 `UPSTREAM_429` 时，`ticket.error.host_error` 保留原始 status/code/message，安全拒绝仍优先成为外层终态。

## Route 可见性边界

- OpenCodex catalog 中所有 executable routes 保持可见，包括 Claude routes。
- OpenCodex live routes 自动生成 Dynamic Cards；AA-mapped profile 可自动参与调度，unmapped route 保持可见但 `unranked`。
- Session/Goal exclusions 只约束当前调度，不得写成全局 provider/model-family 禁令。
- 当前 OpenCodex live routes 直接生成 exact route/profile cards；本地 config 不增加、重命名、覆盖或隐藏模型。
- AA capability vectors 是自动匹配的主要证据；未映射 route 不参与自动匹配，但可通过 exact `--model` 显式调度。

## 保留边界

- PASS 仅针对 Codex host adapter。
- npm 11 在隔离安装时提示 `bun@1.3.14` allowScripts warning；OpenCodex `--version` 和 Baton smoke 均成功，该 warning 本轮不构成功能阻塞。
- Worker 永不拥有 Git index、HEAD、branch、commit、rebase 或 push。
