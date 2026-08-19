# OpenBaton Dynamic Director 可行性验证记录

验证日期：2026-08-18
验证环境：Codex Desktop / host-native `spawn_agent`
最终判定：**`REVISE / 技术可行，需按实测修订后实施`**

## 1. 结论

本轮已经证明以下闭环在当前 Codex host 上可以成立：

```text
当前对话
→ Conversation-to-Goal 显式提升
→ 本地 Route/Capability Snapshot
→ Delegation Receipt fail-closed
→ host-native namespaced model dispatch
→ 父 agent 回收短结论并验收
→ 无 OpenSpec 时由主 agent 持有业务状态
→ 有 OpenSpec 时按稳定 task number 回写 tasks.md
→ 写入 worker 结束后由父 agent 执行 diff allowlist gate
```

方案不存在无法绕过的 host 阻塞，因此不是 `BLOCKED`。但实测推翻了若干原设计假设，且生产代码尚未集成验证性原型，所以也不能判为 `PASS`：

1. Worker 与父 agent 共享工作树、Git index 和 HEAD，不是隔离 worktree/patch。
2. Prompt/Receipt 不能在 host 层强制文件范围；强授权必须由父 agent 的 diff/import gate 兑现。
3. Worker 执行 `git add/commit` 会直接改变父仓；Git stage/commit 必须由父 agent 串行持有。
4. 当前 Codex host 的真实参数是 `model`、`reasoning_effort`、`fork_context`；仓库旧的 `agent_type/fork_turns` 假设需要替换。
5. OpenSpec 写回不能依赖历史行号；必须按稳定 task number 重新定位，并把结论写成 task 的缩进子项。
6. 仓库声明 OpenCodex `^2.22.0`，当前全局运行时为 `2.18.0`，版本基线尚未闭合。
7. 第三方 route 能稳定完成小型、只读或单文件任务，但较大的结构化编码任务出现长时间无产出；路由必须纳入 task shape、超时和 route health。
8. Artificial Analysis 可作为默认能力源，但自动化 API 需要 key；不能精确映射的 route 必须是 `unranked`。

## 2. 验证约束与环境

- 未使用 Baton 外部 CLI 调度 subagent。
- 所有 worker 均由 host-native `spawn_agent` 派生。
- 未使用任何 `cursor/claude-*` 模型。
- 验证性代码和 Git fixture 位于 `/private/tmp/openbaton-feasibility.Pt4YVR`。
- 产品源码未参与实验性写入；最终只将验证结论写入文档。
- 仓库基线：`310f3b02084777d9c8098b016732cb0d7d9401e7`。
- Codex：`0.147.0`；OpenSpec：`1.9.0`；OpenCodex：`2.18.0`；Node：`v26.6.0`。
- 仓库测试：`npm test`，70 passed、0 failed。

## 3. Gate 结果

| Gate | 判定 | 核心证据 |
| --- | --- | --- |
| Gate A：机制与安全 | `REVISE` | shared worktree/index/HEAD 已实测；父 diff gate 可接受 allowlist 内改动并拒绝越界文件；OpenCodex 版本基线未闭合 |
| Gate B：控制面原型 | `PASS (prototype)` | Route Snapshot、Capability Cache、Conversation-to-Goal、Receipt、queue、OpenSpec number writeback 共 24/24 单测通过 |
| Gate C：端到端 | `PASS (prototype)` | 简单任务、复杂无 OpenSpec、复杂 OpenSpec、写入 worker + parent diff gate 均完成 |
| 生产集成 | `NOT YET` | 当前 `baton spawn/apply` 尚未接入真实 native spawn，ticket lifecycle 和持久化仍需实现 |
| 总体 | `REVISE` | 技术闭环可实现，但必须先按实测修订 host adapter、安全模型和版本基线 |

## 4. Gate A：机制与安全边界

### 4.1 Shared worktree

Kimi worker 修改 `allowed-a.txt` 后，父 agent 无需 import 即可立即看到 diff。两个并发 worker 修改不重叠文件时，两份修改同时出现在父工作树。

结论：Codex 首版应采用 `shared worktree + disjoint write ownership + parent diff gate`，不能把 fork/patch 当作前提。

### 4.2 Prompt allowlist 不是强授权

负向 worker 被要求同时修改 allowlist 内外文件，host 接受并执行了两份修改。这证明 Receipt/prompt 只能表达授权，不能在当前 host 上实施文件系统隔离。

父 gate 的实际结果：

```json
{"changed":["allowed.txt"],"allowed":["allowed.txt"],"rejected":[],"valid":true}
```

人为加入 `denied.txt` 后：

```json
{"changed":["allowed.txt","denied.txt"],"allowed":["allowed.txt"],"rejected":["denied.txt"],"valid":false}
```

拒绝路径退出码为 3；恢复越界文件后，验收测试再次输出 `WRITE_GATE_TEST_OK`。

### 4.3 Git ownership

Luna worker 在 fixture 内执行 commit 后，父 fixture 的 HEAD 立即变成同一 commit；close/resume 后文件与 HEAD 仍保留。

结论：worker 禁止 `git add`、`git commit`、切分支和改写 index。父 agent 只有在 diff gate、测试和用户授权均通过后才能提交。

### 4.4 版本基线

```text
package.json: @bitkyc08/opencodex ^2.22.0
npm ls:       dependency empty
global ocx:   2.18.0
```

当前测试能通过不等于 OpenCodex 集成版本兼容。生产实现前必须选择并锁定一个受支持基线，再复跑 route discovery、account、spawn 和错误分类测试。

## 5. Gate B：控制面原型

验证性原型覆盖：

- Route Snapshot 使用稳定 SHA-256；对象键顺序变化不产生新 generation。
- Capability Cache 覆盖 hit、TTL、版本失效、stale last-known-good 和无数据 `unranked`。
- Conversation-to-Goal 只接受显式提升词；普通讨论保持 unresolved，并保留 excluded。
- Delegation Receipt 对 model、path、operation 和 retry budget 逐项 fail-closed。
- TicketQueue 接受 8 个逻辑 ticket，在 6 个物理槽位下形成 `6 running + 2 queued`；完成并 close 后自动补位。
- OpenSpec 通过 task number `2.1` 重新定位，不依赖旧 line index，不误匹配 `2.10`。
- 结论写成紧邻 task 的 `  - Conclusion: ...` 子项；重复写回替换旧结论，保持幂等。

首次由测试 worker 生成测试后为 12 passed、9 failed；修复实现后为 21/21，通过 OpenSpec 落盘兼容修复后为 24/24。这个过程也证明测试能捕获 stale LKG、授权漏检、queue 状态和写回格式错误。

### 5.1 Artificial Analysis 能力源

[Artificial Analysis Data API](https://artificialanalysis.ai/data-api/docs) 提供结构化 model、benchmark、price 和 performance 数据，Free tier 每日 100 次，但所有端点仍要求 `x-api-key`。当前无 key 请求 `/api/v2/language/models/free` 的实测结果为 HTTP 401：

```json
{"error":"API key is required"}
```

[Kimi K3](https://artificialanalysis.ai/models/kimi-k3/) 和 [GPT-5.6 Luna high](https://artificialanalysis.ai/models/gpt-5-6-luna-high/) 有可识别的能力数据。OpenCodex route 与 AA model 只有在 canonical mapping 精确、可审计时才能关联；`xai/grok-4.6` 等当前未证明精确映射的 route 必须保留为 `unranked`。

普通 dispatch 只读取本地 snapshot/cache。只有 OpenCodex catalog fingerprint、AA 数据版本/TTL 或管理员刷新信号变化时才访问外部源。

### 5.2 Route 任务形状

Kimi、xAI 和 Cursor Grok 均成功完成小型只读/单文件任务；三次较大的“生成完整控制面模块”任务长时间无文件产出并被关闭，Luna 在相同 fixture 中完成了模块、测试和修复。

这不是 model 永久能力排名，而是当前 host/provider/任务形状的运行健康证据。Baton 应记录 `route + task_shape + timeout/error`，由主 agent 结合能力证据做决策，不能只按模型总分路由。

## 6. Gate C：端到端场景

### 6.1 简单任务，无 OpenSpec

Kimi 256K worker 只读 fixture 并返回：

```text
SIMPLE_E2E_OK found=yes model_id=k3-256k
```

本地 Route/Capability Snapshot 为热缓存，验证性 launch 记录 `discoveryCalls=0`、`capabilityCalls=0`。

### 6.2 复杂任务，无 OpenSpec

父 agent 并发派生三个只读 ticket 并汇总：

```text
kimi/k3       → COMPLEX_ROUTE_OK token=ROUTE_SNAPSHOT_STABLE
xai/grok-4.6  → COMPLEX_AUTH_OK token=RECEIPT_FAIL_CLOSED model_id=grok-4.6
gpt-5.6-luna  → COMPLEX_QUEUE_OK token=SIX_RUNNING_TWO_QUEUED
```

逻辑 queue 原型同时证明 8 个 ticket 在 6 个物理槽位下不会被产品层拒绝。

### 6.3 复杂 Goal，有 OpenSpec

临时 change `validate-openbaton-feasibility` 经 `openspec validate` 通过。父 agent 在 task 2.1 前插入无关文本使旧行号失效，Kimi worker 返回稳定 task 结论后，父 adapter 按 `2.1` 回写：

```markdown
- [x] 2.1 Validate stable task identity and conclusion writeback
  - Conclusion: stable task identity confirmed
```

随后 `openspec instructions apply --json` 报告 `total=4, complete=1, remaining=3`，证明 OpenSpec 能识别该回写格式。

### 6.4 写入 worker 闭环

`kimi/kimi-k2.7-code-highspeed` 只修改 `allowed.txt`，未 stage/commit。父 agent 依次执行：

```text
git diff ownership check
→ allowlist gate valid=true
→ node test.mjs
→ WRITE_GATE_TEST_OK
```

负向越界文件被 gate 拒绝。因此“共享工作树”并不阻塞写入型 worker，但安全边界必须由父 agent 在 worker 返回后、任何构建/提交前实施。

## 7. 必须进入正式实现的修订

1. Codex host adapter 改为运行时 `model/reasoning_effort/fork_context`，禁止静默继承或替换 route。
2. Ticket 只有拿到真实 agent ID 后才能从 queued 进入 running；终态必须记录 completed/errored/timeout/closed。
3. 并发上限使用 host capability；默认值不能继续假定为 4。逻辑 ticket 超额时排队，不拒绝。
4. 所有写 worker 在启动前保存 baseline 和 write ownership；结束后按 baseline 检查 tracked、untracked、rename、delete 和 mode change。
5. Worker 不拥有 Git index/HEAD；stage、commit、rebase 和 branch mutation 由父 agent 串行执行。
6. OpenSpec adapter 用 change + 稳定 task number 重新定位；结论子项必须兼容 OpenSpec parser，写回后必须再次调用 validate/status/instructions 验证。
7. CapabilityProvider 引入 API key、canonical mapping、TTL/version、last-known-good、`unranked` 和 attribution；普通 dispatch 不访问远端。
8. Route health 按任务形状记录；超时不得静默 fallback，只有 Receipt 允许的模型集合和重试预算可以重调度。
9. 锁定 OpenCodex 兼容版本并在该版本上复跑本记录全部场景。

## 8. 最终判定规则的落点

```text
技术闭环：可实现
Codex 首版：可进入正式实现
当前仓库直接生产化：不可
需要改变总体职责边界：不需要
需要按实测修订 host adapter / safety / writeback / version：需要
```

因此最终判定为 **`REVISE`**。完成第 7 节修订并在锁定版本上复跑后，才可以把状态提升为 `PASS / 可实施`。
