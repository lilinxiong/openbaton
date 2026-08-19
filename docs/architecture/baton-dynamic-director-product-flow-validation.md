# OpenBaton Dynamic Director 产品流程验证报告

验证日期：2026-08-19

验证基线：`683d866 feat: add local AA capability cache`

验证结论：**架构可行性仍为 `REVISE / 技术可行`；当前产品端到端流程为 `FAIL / 尚未闭环`。**

## 1. 本轮验证目标

本轮不再验证“Codex + OpenCodex 能否派生不同模型”这一底座，而是从当前 OpenBaton 产品入口出发，依次检查：

```text
本地 capability 查询
→ card match
→ ticket 创建
→ host-native spawn
→ agent ID / lifecycle / queue
→ Delegation Receipt
→ shared-worktree parent safety gate
→ Conversation-to-Goal
→ OpenCodex Route Snapshot
→ OpenSpec task conclusion writeback
```

验证严格区分：

- `PRODUCT PASS`：当前 `baton` 产品代码自行完成。
- `HOST PRIMITIVE PASS`：父 Codex session 手工调用 host-native 工具可以完成，但产品没有接入。
- `FAIL`：当前产品行为不满足设计契约或会产生错误状态。

## 2. 环境与隔离

| 项目 | 值 |
| --- | --- |
| OpenBaton commit | `683d866` |
| Codex | `0.147.0` |
| OpenSpec | `1.9.0` |
| Node | `v26.6.0` |
| AA snapshot | Free tier, Index 4.1, 608 unique models, 32 mappings |
| 隔离根目录 | `/private/tmp/openbaton-flow-validation.FQImKv` |
| 隔离 HOME | `/private/tmp/openbaton-flow-validation.FQImKv/home` |
| Standalone fixture | `/private/tmp/openbaton-flow-validation.FQImKv/project` |
| Safety fixture | `/private/tmp/openbaton-flow-validation.FQImKv/worktree` |
| OpenSpec fixture | `/private/tmp/openbaton-flow-validation.FQImKv/openspec-project` |

所有产品 ticket、OpenSpec change 和 worker 写入均位于 `/private/tmp`。未使用任何 `cursor/claude-*` route。所有实际派生的 worker 均已关闭。

## 3. 总览

| ID | 流程段 | 结果 | 关键结论 |
| --- | --- | --- | --- |
| V-01 | AA 本地 capability 查询 | `PRODUCT PASS` | SQLite/manifest 可读，`k3` 精确映射到 Kimi K3 max |
| V-02 | Card match | `PARTIAL` | `baton match` 可选出 card，但只使用静态 `strengths`，不读取 capability DB |
| V-03 | Ticket 创建 | `FAIL` | 未调用 worker 即标记 `running`；无 `agent_id`、Receipt、attempt 或终态字段 |
| V-04 | Host-native dispatch | `HOST PRIMITIVE PASS / PRODUCT FAIL` | 手工 spawn K3 成功；产品不会派生、等待、关闭或自动回写终态 |
| V-05 | Queue / slot lifecycle | `FAIL` | 释放槽位后不提升最早 queued ticket；新 ticket 插队启动 |
| V-06 | Receipt / parent safety | `FAIL` | 越界文件真实写入；产品无结构化授权、diff gate、拒绝或回滚 |
| V-07 | Conversation-to-Goal | `FAIL` | 无产品入口或实现；`baton goal` 返回 unknown command |
| V-08 | Route Snapshot | `FAIL` | 无 OpenCodex catalog fingerprint/snapshot；`baton routes` 返回 unknown command |
| V-09 | OpenSpec stable task identity | `FAIL` | ticket 保存历史 line index；插行后结论写入错误 task |
| V-10 | Regression / packaging | `PASS` | 92/92 tests，SQLite integrity OK，npm package 不含本地 AA 数据 |

### 3.1 第一里程碑修复复验（2026-08-19）

原始 V-03～V-05 的失败已在 TypeScript 重构后重新验证：

| 原失败 | 当前状态 | 证据 |
| --- | --- | --- |
| V-03 Ticket 初始状态错误 | `RESOLVED` | schema v2 ticket 初始为 `queued/read-only`；`dispatch next` 后为 `dispatching`，真实 bind 后才为 `running` |
| V-04 无真实 lifecycle | `RESOLVED` | 8 个 ticket 均保存真实 Codex `agent_id`、route、started/finished history、completed 终态和短结论 |
| V-05 Queue 插队/不补位 | `RESOLVED` | 8 ticket / capacity 6 得到 6 active + 2 queued；前 6 终态后严格补位 `spn-0007`、`spn-0008` |

复验使用编译产物 `dist/bin/baton.js`，不是源码测试替代：

```text
initial:  reserved 0001..0006, queued 0007..0008
bind:     6 个真实 agent ID
finish:   0001..0006 completed，并 close_agent
refill:   只 reserve 0007、0008
final:    completed=8, active=0, available=6
fallback: none
```

对应提交：

```text
f44dad7  persistent read-only dispatch lifecycle
89ad0a3  TypeScript source/test/bin cutover
d942ec4  Codex host-native dispatch protocol
a52a76b  typed dispatch and host control plane
61492ec  runtime TypeScript semantic checks
38c4a79  packaged dist asset resolution
```

验证 fixture：`/private/tmp/openbaton-m1.zzL7Bb`。V-06～V-09 尚未修复，整体产品状态仍为 `FAIL / 尚未闭环`。

## 4. 详细步骤与证据

### V-01：本地 capability 查询

命令：

```bash
baton capabilities status --json
baton capabilities show k3 --json
```

关键结果：

```json
{
  "modelCount": 608,
  "mappingCount": 32,
  "duplicateRecords": 2,
  "indexVersion": "4.1"
}
```

`k3` 查询结果：

```json
{
  "aaSlug": "kimi-k3",
  "ranked": true,
  "model": {
    "name": "Kimi K3 (max)",
    "intelligence_index": 59.7,
    "coding_index": 76.2,
    "agentic_index": 54.3
  }
}
```

判定：`PRODUCT PASS`。

### V-02：Card match 与 capability 是否合流

命令：

```bash
baton match "large repository multi-file refactor architecture video"
```

结果：

```text
k3  (score 29)
```

Card match 能正常 fail-closed 地选出一个 card。但当前 `src/lib/cards.js` 只对 card `strengths` 文本做 token/phrase 评分，没有读取：

- AA SQLite；
- OpenCodex 当前可用 model catalog；
- route/profile mapping；
- health、quota、latency 或近期运行证据。

判定：`PARTIAL`。Card 基础成立，动态能力驱动选择尚未产品化。

### V-03：Ticket 创建与初始状态

命令：

```bash
baton spawn \
  "implement a large repository multi-file architecture refactor" \
  --model k3
```

产品在没有调用任何 host-native spawn 前写出：

```json
{
  "id": "spn-0001",
  "model_id": "k3",
  "queue": "start",
  "status": "running",
  "conclusion": null
}
```

缺失字段：

- `agent_id`
- `host`
- `route_id`
- `reasoning_effort`
- `fork_context`
- `started_at`
- `attempt`
- `error_code`
- `terminal_status`
- `receipt`

判定：`FAIL`。应先保持 `queued/dispatching`，只有 host 返回真实 agent ID 后才能进入 `running`。

### V-04：真实 host-native lifecycle

父 Codex session 手工桥接：

```text
card k3
→ model kimi/k3
→ reasoning_effort=max
→ fork_context=false
```

创建结果：

```text
agent_id=01a017d6-5d11-7261-b02e-c1ca1e7470b6
```

Worker 最终返回：

```text
LIFECYCLE_OK token=HOST_NATIVE_LIFECYCLE_OK model_id=k3
```

实际 host worker 创建、运行、完成和关闭均成功，证明底座可用。但 worker 完成后：

- `spn-0001` 仍为 `running`；
- ticket 没有 `agent_id`；
- ticket 没有自动终态；
- 必须手工执行 `baton conclude` 才变为 `done`；
- `conclude` 只写用户提供的文本，不验证该文本来自哪个 agent 或哪个 attempt。

判定：`HOST PRIMITIVE PASS / PRODUCT FAIL`。

### V-05：Queue 与 FIFO 补位

隔离 config 的 `max_concurrent=4`。连续创建 8 个 ticket 后：

```text
spn-0002 ... spn-0005 = running
spn-0006 ... spn-0009 = queued
```

手工 conclude `spn-0002` 后：

```text
running = spn-0003, spn-0004, spn-0005
queued  = spn-0006, spn-0007, spn-0008, spn-0009
```

产品没有把最早的 `spn-0006` 提升为 running。随后新建 ticket：

```text
spn-0010 = running
spn-0006 ... spn-0009 仍为 queued
```

这证明：

1. `conclude` 不释放并调度下一个 queued ticket；
2. 新 ticket 可以绕过旧队列；
3. queue 不是持久化 FIFO scheduler；
4. `running` 数字也不对应真实 host agent。

判定：`FAIL`。

### V-06：Delegation Receipt 与 shared-worktree safety

产品 ticket 描述：

```text
implement change in allowed.txt only; denied.txt is out of scope
```

Ticket 中没有结构化 Receipt，仅有自然语言 prompt。负向 worker：

```text
agent_id=01a017d7-d24b-77c2-a7b6-beb0794df688
model_id=kimi-k2.7-code-highspeed
```

Worker 在 shared worktree 中真实产生：

```text
M allowed.txt
M denied.txt
```

Diff：

```diff
 BASE_ALLOWED
+WORKER_ALLOWED

 BASE_DENIED
+WORKER_OUT_OF_SCOPE
```

产品行为：

- 没有保存 baseline；
- 没有 machine-readable write allowlist；
- 没有检查 `git diff --name-status HEAD`；
- 没有拒绝 `denied.txt`；
- 没有回滚或隔离越界结果；
- ticket 仍为 `running` 且不知道真实 worker 已完成。

判定：`FAIL`。当前写 worker 不能视为安全产品闭环。

### V-07：Conversation-to-Goal

命令：

```bash
baton goal "按这个执行：验证动态流程"
```

结果：

```text
exit=2
unknown command: goal
```

源码中也不存在：

- Conversation-to-Goal promotion；
- `explicit/inferred/unresolved/excluded` Draft；
- 一次授权确认；
- 当前 session context 到 Goal Draft 的 host adapter。

注意：Conversation-to-Goal 应主要由 host skill 使用当前对话完成，不要求 CLI 自己持有会话上下文；但当前安装到 Codex 的 host skill 也没有该契约。

判定：`FAIL`。

### V-08：OpenCodex Route Snapshot

命令：

```bash
baton routes status
```

结果：

```text
exit=2
unknown command: routes
```

当前 runtime artifact 只有：

```text
.baton/cache/capabilities/artificial-analysis.sqlite3
.baton/cache/capabilities/artificial-analysis.manifest.json
.baton/spawns/*.json
```

不存在：

- OpenCodex catalog snapshot；
- catalog fingerprint/generation；
- config change detection；
- executable route/profile snapshot；
- AA capability 与 route health/quota 的候选合流。

判定：`FAIL`。AA 数据已经本地化，但还没有与“当前真正可执行的 OpenCodex route”合并。

### V-09：OpenSpec task identity 与 conclusion round-trip

前置：真实 OpenSpec change 先通过：

```text
openspec validate validate-openbaton-feasibility
→ Change is valid
```

原始任务：

```markdown
- [ ] 1.1 Validate flagship architecture baseline
- [ ] 2.1 Validate flagship architecture target writeback
- [ ] 2.2 Validate flagship architecture later task
```

执行：

```bash
baton apply validate-openbaton-feasibility
```

目标 ticket：

```json
{
  "id": "os-0002",
  "number": "2.1",
  "line_index": 5,
  "status": "running"
}
```

在 ticket 创建后，于 task `2.1` 前插入：

```markdown
- [ ] 1.2 Inserted after ticket creation
```

然后执行：

```bash
baton conclude os-0002 --text "target task accepted"
```

实际写回：

```markdown
- [x] 1.2 Inserted after ticket creation
  - conclusion: target task accepted
- [ ] 2.1 Validate flagship architecture target writeback
```

OpenSpec `instructions apply --json` 报告：

```text
1.2 done=true
2.1 done=false
```

产品声称 `wrote conclusion back into OpenSpec tasks.md`，但写错了 task。

判定：`FAIL`，并且属于业务状态完整性错误。必须按 change + stable task number 重新解析当前位置，不能使用历史 line index。

### V-10：回归与发布面

能力缓存提交前验证：

```text
npm test: 92 passed, 0 failed
SQLite PRAGMA integrity_check: ok
AA models: 608
route mappings: 32
cursor/claude mappings: 0
npm pack: schema/mappings/attribution included
npm pack: no .baton cache / sqlite / local manifest
```

判定：`PASS`。

## 5. 当前真实流程

```text
用户输入
→ baton match                 PRODUCT PASS, static cards only
→ baton spawn/apply           PRODUCT PASS, creates JSON ticket
→ ticket.status=running       FAIL, no worker exists yet
→ parent manually spawn       HOST PRIMITIVE PASS
→ parent manually wait/close  HOST PRIMITIVE PASS
→ baton conclude              MANUAL BRIDGE
→ queue promotion             FAIL
→ parent diff safety          NOT IMPLEMENTED
→ OpenSpec writeback          FAIL after task line drift
```

所以当前 `baton spawn` 实际语义是 `plan/write-ticket`，还不是产品意义上的 native spawn。

## 6. 阻塞最终 PASS 的实现批次

### Batch 1：Host dispatch 与 lifecycle

必须加入：

- `queued → dispatching → running → completed/errored/timeout/closed`；
- 真实 `agent_id`、host、route、profile、attempt；
- 只有 spawn 成功后才进入 running；
- wait/close 终态回写；
- terminal error code 和短结论；
- host skill 使用已验证的 `model/reasoning_effort/fork_context`，删除旧 `agent_type/fork_turns` 假设。

验收：worker 完成后无需人工 `baton conclude`，ticket 与真实 agent 终态一致。

### Batch 2：Persistent FIFO queue

必须加入：

- host concurrency capability；
- 持久化 FIFO；
- slot release 自动启动最早 queued ticket；
- 新 ticket 不得越过旧 ticket；
- close/timeout/retry 都释放或保留槽位一致性。

验收：4 running + 4 queued 中任意 running 结束，最早 queued 自动成为 dispatching/running。

### Batch 3：Receipt 与 parent safety gate

Receipt 至少包含：

```text
allowed_models
route/profile
write_allowlist
allowed_operations
retry_budget
baseline
validation_boundary
git_policy
```

Parent gate 检查 tracked/untracked/rename/delete/mode change，并拒绝任何越界路径。Worker 禁止操作 Git index、HEAD、branch、commit、rebase。

验收：与 V-06 相同的负向 worker 结束后，`denied.txt` 不得进入可接受结果，ticket 必须记录明确拒绝原因。

### Batch 4：Route Snapshot 与 capability join

必须加入：

- OpenCodex model catalog fingerprint/generation；
- 只在 catalog/config 变化时刷新；
- route + profile + AA capability + health + quota + recent execution evidence；
- card 作为主 agent 可读的策略/override，而不是唯一关键词评分输入；
- 无精确 mapping 保持 `unranked`，无 executable route 则 blocked。

验收：普通 match/dispatch 不访问 OpenCodex discovery 或 AA 网络，但能解释最终候选和选择证据。

### Batch 5：Conversation-to-Goal

由 host skill 使用当前 session 构造忠实 Draft：

```text
explicit
inferred
unresolved
excluded
OpenSpec mode
authorization request
```

用户一次批准后才激活；无 OpenSpec 时业务 Plan 仍由主 agent 持有。

### Batch 6：OpenSpec stable writeback

Ticket 保留 task number，但 conclude 时必须重新读取 tasks.md、按 number 精确定位，并拒绝重复/缺失 identity。写回后重新执行 OpenSpec validate/status/instructions。

验收：重复 V-09 时只允许 `2.1 done=true`，插入的 `1.2` 必须保持 pending。

## 7. 最终判断

本轮没有发现新的不可实现机制：host-native model route、共享文件系统、短结论回收、AA 本地数据和 OpenSpec CLI 都可用。

但当前产品尚不能宣称完整动态 director 可用，因为：

```text
ticket 不是真实 agent lifecycle
queue 不是 scheduler
Receipt/safety 未实现
capability 未进入 route decision
Conversation-to-Goal 未实现
OpenSpec 会写错 task
```

因此：

- 架构可行性：`REVISE / 技术可行`。
- 当前产品端到端：`FAIL / 未闭环`。
- 下一步：按 Batch 1～6 实现，每个 Batch 复用本报告中的负向场景作为验收测试。
