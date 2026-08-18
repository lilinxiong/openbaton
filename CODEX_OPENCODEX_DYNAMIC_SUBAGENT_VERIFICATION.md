# Codex + OpenCodex 动态 Subagent 验证记录

更新时间：2026-08-18

工作目录：`/Users/lilinxiong/develop/workspace/baton-codex-verify/openbaton`

## 1. 目标与边界

验证 Codex 能否在同一个父 session 中，通过 host-native `spawn_agent` 在运行时选择 OpenCodex 注入的不同模型，并确认：

1. 不修改 agent 配置、不重启父 session，能否连续派生 Kimi、Cursor、xAI 和原生 GPT worker。
2. `spawn_agent` 的实际 schema 是否支持运行时 `model`、`reasoning_effort` 和最小上下文派生。
3. 当前 V1 multi-agent surface 的并发 thread 上限。
4. Codex model picker 的真实 catalog 来源。
5. 父 agent 与 subagent 的上下文、输入和输出占用边界。

验证期间明确不使用 Baton / OpenBaton，不创建 agent 配置，不修改项目文件、Codex 配置或外部状态。OpenBaton 的策略、排名、额度和路由选择不属于本验证。

## 2. 最终结论

截至 2026-08-18，结论如下：

- 当前父 session 使用 V1 multi-agent surface。
- host-native `spawn_agent` 支持在每次调用时动态传入 namespaced `model` 和 `reasoning_effort`。
- 不需要 `~/.codex/agents/*.toml`，也不需要 Baton。
- 已实际执行成功：
  - `gpt-5.6-luna`
  - `cursor/grok-4.6-fast`
  - `kimi/k3`
  - `kimi/k3-256k`
  - `kimi/k3[1m]`
  - `kimi/kimi-k2.7-code-highspeed`
  - `xai/grok-4.6`
- 同一个父 session 可跨多轮对话继续派生不同模型，父 session 不会因 worker 完成而结束。
- 当前干净 V1 registry 中同时创建/保留的 subagent thread 上限为 **6**；第 7 个返回 `agent thread limit reached`。
- 当前 `max_threads` 未显式配置；6 是 Codex 0.147.0 的 V1 运行时默认值。配置和管理接口只能读到 `null/default`，不能直接读出 6。
- subagent 有独立上下文，但父到子的任务输入和子到父的最终输出会同时占用父、子两侧上下文；隔离的是 worker 的中间推理、文件读取和工具输出。
- Codex picker 的权威有效列表是 `~/.codex/opencodex-catalog.json`，不是 `grok models` 的本地 catalog。

## 3. 环境与当前协议状态

实测版本：

```text
codex-cli 0.147.0
opencodex 2.18.0
OpenCodex proxy: http://127.0.0.1:10100
```

最新 `ocx v2 status`：

```text
multi_agent_v2: OFF — v1 multi-agent surface (default install)
multi_agent_mode: v1 — ALL models forced to v1 surface (upstream pins overridden)
keep_native_chatgpt_on_v1: OFF
max_threads: (unset — codex default)
agents.enabled: (unset — upstream default true)
agents.max_depth: (unset — upstream default 1)
subagent_developer_instructions: (unset — children inherit)
multi_agent_mode_hint_text: (unset — effort-derived policy: ultra=proactive, else explicit)
```

对应本地配置：

```toml
[features.multi_agent_v2]
enabled = false
```

OpenCodex 配置中：

```json
{
  "multiAgentMode": "v1"
}
```

协议/catalog/threads 配置变更只对新 session 生效。正在运行的父 session 使用启动时解析的 multi-agent surface 和 thread limit。

## 4. 当前 host-native 工具面

当前 session 实际可见的 multi-agent 工具：

- `multi_agent_v1__spawn_agent`
- `multi_agent_v1__wait_agent`
- `multi_agent_v1__send_input`
- `multi_agent_v1__close_agent`
- `multi_agent_v1__resume_agent`

当前 `spawn_agent` 关键 schema：

```text
message?: string
items?: [...]
model?: string
reasoning_effort?: string
service_tier?: string
fork_context?: boolean
```

关键结论：

- `model` 和 `reasoning_effort` 在 JSON schema 层是无枚举约束的字符串，能够表达 namespaced model。
- 服务端仍会按当前 Codex/OpenCodex catalog 校验模型；不在 catalog 中的 ID 会返回 `Unknown model`。
- 当前 schema 没有 `fork_turns`。
- `fork_context=false` 或省略表示 worker 只收到初始 prompt，不复制完整父线程；这是当前工具面能表达的最小非全量上下文方式。
- `fork_context=true` 才复制父线程历史。
- V1 没有独立的 start 事件查询接口；创建后最终进入 `completed` 可以证明 worker 已实际开始并执行。

## 5. Codex model catalog 的真实来源

### 5.1 数据链

```text
~/.opencodex/config.json
        │ providers / liveModels / disabledModels / subagentModels
        ▼
OpenCodex gatherRoutedModels + filterCatalogVisibleModels
        ▼
~/.codex/opencodex-catalog.json
        │ model_catalog_json
        ▼
~/.codex/config.toml
        ▼
Codex model picker
```

OpenCodex 同时把有效 catalog 同步到 `~/.codex/models_cache.json`。2026-08-18 检查时：

- `opencodex-catalog.json`：17 个模型。
- `models_cache.json`：17 个模型。
- 两者修改时间相同。
- 14 个模型为 `visibility = "list"`，3 个模型隐藏。

Codex 配置中的注入指针：

```toml
model_catalog_json = "/Users/lilinxiong/.codex/opencodex-catalog.json"
# Auto-injected by opencodex
openai_base_url = "http://127.0.0.1:10100/v1"
```

### 5.2 复现 picker 顺序

```bash
jq -r '
  .models
  | to_entries
  | map(select(.value.visibility == "list"))
  | sort_by(.value.priority, .key)[]
  | .value.slug
' ~/.codex/opencodex-catalog.json
```

输出与 Codex 窗口的 picker 一致：

```text
gpt-5.5
gpt-5.6-sol
gpt-5.6-terra
gpt-5.6-luna
cursor/claude-fable-5
cursor/claude-opus-5
cursor/claude-sonnet-5
cursor/grok-4.6-fast
kimi/k3
kimi/k3-256k
kimi/k3[1m]
kimi/kimi-k2.7-code-highspeed
xai/grok-4.6
gpt-daybreak-blue-latest
```

排序依据：

| 模型组 | Priority |
| --- | ---: |
| `gpt-5.5` | 0 |
| Sol / Terra / Luna | 1 / 2 / 3 |
| Cursor / Kimi / xAI | 5 |
| Daybreak Blue | 105 |

### 5.3 不应使用的来源

`grok models` 汇总的是 Grok CLI 自己的 `~/.grok/config.toml`、`~/.grok/models_cache.json` 和 `~/.grok/agents/*.md`，不是 Codex picker 或 `spawn_agent` 的权威 catalog。

此前从该列表推导出的以下候选不在当前 Codex catalog 中：

```text
kimi/kimi-for-coding
kimi/kimi-for-coding-highspeed
xai/grok-4.5
```

它们返回的 `Unknown model` 只能说明未注册到当前 `spawn_agent` catalog，不能归因于 provider 执行失败。

## 6. 动态模型路由实测

### 6.1 第一轮：两个 Kimi 并发

同一父 session、同一轮并发请求：

```text
kimi/k3[1m], reasoning_effort=max
kimi/k3-256k, 不显式传 reasoning_effort
```

统一只读 prompt：

```text
这是只读路由验证。不要修改文件、配置或外部状态。
仅回复 TEST_OK；如果能看到实际模型 ID，再附 model_id=<id>，
否则写 model_id=unknown。
```

结果：

| Worker | Agent ID | 请求 | 最终状态 | 返回 |
| --- | --- | --- | --- | --- |
| Leibniz | `01a013cd-fbff-7801-9ae8-26c6b8bed148` | `kimi/k3[1m]`, `max` | `completed` | `TEST_OK model_id=k3` |
| James | `01a013cd-fc6a-7772-8ded-8caced3e847f` | `kimi/k3-256k`, effort 省略 | `completed` | `TEST_OK model_id=k3-256k` |

### 6.2 下一轮：同一父 session 切换 xAI

下一条用户消息到达后，在同一个父 session 中执行：

```text
model=xai/grok-4.6
reasoning_effort=high
fork_context=false
```

| Worker | Agent ID | 最终状态 | 返回 |
| --- | --- | --- | --- |
| Helmholtz | `01a013ce-ed12-7360-a575-f02709aa7f44` | `completed` | `TEST_OK model_id=grok-4.6` |

当前 schema 无 `fork_turns`，所以本次使用 `fork_context=false` 作为最小非全量上下文方式。

### 6.3 当前窗口再次派生 xAI

| Worker | Agent ID | 最终状态 | 返回 |
| --- | --- | --- | --- |
| Feynman | `01a013d0-7c75-7103-8771-ec183a6e7899` | `completed` | `TEST_OK model_id=grok-4.6` |

这证明父 session 可以跨用户消息继续运行并动态选择新的 worker model。

### 6.4 最终可执行模型矩阵

| 请求模型 | 是否成功执行 | Worker 回报 |
| --- | --- | --- |
| `gpt-5.6-luna` | 是 | `model_id=unknown` |
| `cursor/grok-4.6-fast` | 是 | `model_id=grok-4.6-fast` |
| `kimi/k3` | 是 | `model_id=k3` |
| `kimi/k3-256k` | 是 | `model_id=k3-256k` |
| `kimi/k3[1m]` | 是 | `model_id=k3[1m]` |
| `kimi/kimi-k2.7-code-highspeed` | 是 | `model_id=kimi-k2.7-code-highspeed` |
| `xai/grok-4.6` | 是 | `model_id=grok-4.6` |

worker 自报 model ID 是辅助证据。若验收需要证明没有 fallback，应再使用 OpenCodex request/route 日志核对实际 provider、model 和 HTTP 状态；本轮 clean-limit 测试未重新读取完整 route 日志。

## 7. 同时创建数量上限

### 7.1 早期非干净观测：9 个 open thread

早期 registry 中已经保留 4 个已完成 worker，随后又成功创建 5 个；总数达到 9 后，继续派生开始返回：

```text
collab spawn failed: agent thread limit reached
```

之后发生父模型/runtime 切换，尝试关闭这 9 个 ID 时全部返回 `not found`。因此这次观测混入旧 registry 生命周期，不应作为当前 V1 的“同时运行”最终上限。

### 7.2 干净并发压力测试：6 个

清理/重建后的 registry 中，旧 worker 均为 `not found`，起点为空。随后在同一轮通过并发调用提交 14 个请求，允许模型循环两次：

```text
gpt-5.6-luna
cursor/grok-4.6-fast
kimi/k3
kimi/k3-256k
kimi/k3[1m]
kimi/kimi-k2.7-code-highspeed
xai/grok-4.6
```

结果：

- 第 1 至第 6 个创建成功。
- 第 7 至第 14 个全部返回 `agent thread limit reached`。
- 成功 worker 被要求保持任务约 20 秒后再返回。
- 关闭一个已完成 Luna worker 后，原本排在第 7 位的 `xai/grok-4.6` 立即创建并执行成功。
- 说明第 7 个失败是全局 thread limit，不是 xAI 模型不可用。

成功 worker：

| Slot | Worker | Agent ID | Model | 返回 |
| ---: | --- | --- | --- | --- |
| 1 | Popper | `01a013e8-35a3-72c3-b413-4c6c2af1c029` | `gpt-5.6-luna` | `SLOT_OK model_id=unknown` |
| 2 | Cicero | `01a013e8-3679-7dc1-b564-4ff07e7dc401` | `cursor/grok-4.6-fast` | `SLOT_OK model_id=grok-4.6-fast` |
| 3 | Euclid | `01a013e8-34fe-7e92-add4-4e01965b74fa` | `kimi/k3` | `SLOT_OK model_id=k3` |
| 4 | Curie | `01a013e8-354e-7e92-abd5-4ef47f94baf0` | `kimi/k3-256k` | `SLOT_OK model_id=k3-256k` |
| 5 | Avicenna | `01a013e8-362a-77e0-a2e9-95de5fce15e0` | `kimi/k3[1m]` | `SLOT_OK model_id=k3[1m]` |
| 6 | Kierkegaard | `01a013e8-380f-7cb1-9432-21dd116df1ab` | `kimi/kimi-k2.7-code-highspeed` | `SLOT_OK model_id=kimi-k2.7-code-highspeed` |
| 补位 | Erdos | `01a013e9-5f9b-7e61-b66b-07e1638f407b` | `xai/grok-4.6` | `SLOT_OK model_id=grok-4.6` |

最终结论：

```text
当前 V1 registry 最大同时创建/保留 subagent threads = 6
第 7 个开始返回 AgentLimitReached
```

本轮所有 worker 在记录结果后均已关闭，父 session 保持可用。

## 8. Thread limit 的配置和可观测性

### 8.1 V1

显式覆盖位置：

```toml
[agents]
max_threads = 6
```

V1 中该值表示 child/subagent 数量，不计算父 agent。

当前没有显式 `[agents].max_threads`，因此：

```text
ocx v2 status -> max_threads: (unset — codex default)
getAgentsMaxThreads() -> null
getLogicalMaxThreads() -> null
GET /api/v2 -> maxConcurrentThreadsPerSession: null
```

当前 session/rollout 也没有结构化携带解析后的默认值。有效默认 6 只能通过 Codex 版本/实现知识或实际 spawn 到 `AgentLimitReached` 来确认。

### 8.2 V2

V2 配置位置：

```toml
[features.multi_agent_v2]
enabled = true
max_concurrent_threads_per_session = 7
```

V2 将父 agent 算入总数：

```text
7 total threads = 1 parent + 6 subagents
```

OpenCodex 提供：

```bash
ocx v2 status
ocx v2 threads <n>
```

`ocx v2 threads <n>` 会根据当前 V1/V2 surface 写入对应存储，且只影响新 session。本验证未修改 thread 配置。

### 8.3 强制限制的位置

错误由 Codex 原生运行时的 `AgentRegistry` / `AgentControl` 强制执行，错误类型为 `AgentLimitReached`，消息为：

```text
agent thread limit reached
```

当前二进制：

```text
/opt/homebrew/Caskroom/codex/0.147.0/bin/codex
```

OpenCodex 只负责读取、迁移或显式覆盖该配置，不是默认 6 的执行者。

## 9. 父子上下文与 token 边界

subagent 有独立上下文窗口，但跨父子边界的输入和输出会同时存在于两侧。

| 内容 | 父 agent 上下文 | subagent 上下文 |
| --- | ---: | ---: |
| `spawn_agent` 初始 prompt | 占用，作为工具调用参数 | 占用，作为 worker 输入 |
| worker 内部推理 | 不占用 | 占用 |
| worker 文件读取与工具输出 | 不占用 | 占用 |
| worker 最终返回 | 占用，作为工具结果 | 占用，作为 worker 输出 |
| `wait_agent` 状态/错误 | 占用 | 不占用 |
| `fork_context=true` 复制的父历史 | 父侧本来已有 | 复制后占用子上下文 |

因此 subagent 隔离的是工作上下文，不是交接上下文。

推荐模式：

```text
fork_context=false
+ 自包含、短任务 prompt
+ worker 自行读取文件
+ 只返回结论、必要证据和路径
+ 限制输出长度
+ 完成后 close_agent
```

这可以避免将搜索过程、文件全文、工具日志、失败重试和中间推理灌回父上下文。输入 prompt 和最终结果仍会占父上下文；多个 `wait_agent` 或重复通知还可能增加额外记录。

## 10. 对话期间动态派生

当前 V1 已支持在处理某一条用户消息时动态派生 worker，不需要热切换 V1/V2。

支持两种授权：

1. 逐轮授权：用户明确要求该轮派生哪些 worker。
2. 当前对话持续授权：用户允许父 agent 在适合并行的独立子任务中自行决定是否派生、派生数量和允许模型。

建议持续授权模板：

```text
从现在起，在当前父 session 中，遇到适合并行的独立子任务时，
允许你自行动态调用 host-native spawn_agent。
最多同时 6 个，只使用当前 OpenCodex catalog 中我允许的模型。
默认 fork_context=false，不使用 Baton。
只读任务不得修改文件、配置或外部状态。
worker 完成后汇总结果并关闭。
```

授权 subagent 不会自动扩大文件修改、外部写入、提交、推送或其他副作用权限。

## 11. 历史 V2 失败基线

在切换到当前 V1 surface 前，V2 曾接受运行时 `model` 参数，但第三方 worker 在执行前失败：

```text
code: unreadable_encrypted_agent_task
message: Routed V2 worker task is encrypted for the native ChatGPT backend
and cannot be read by the selected provider. Use plaintext V2 agent-message
delivery or select a native ChatGPT model.
```

该结果说明当时的失败边界是“原生 ChatGPT 父模型 + V2 worker task 加密传输”，不是 Kimi/xAI discovery。它是历史基线，不代表当前 V1 状态；当前 V1 已完成上述全部 routed model 的实际执行。

V1/V2 这里指 Codex multi-agent 工具面，不是 HTTP `/v1/responses` 版本，也不是模型能力等级。

## 12. 证据分级与剩余边界

本轮已有证据：

- schema 证据：`spawn_agent` 能表达运行时 namespaced model 和 reasoning effort。
- 创建证据：服务端返回 agent ID 和 nickname。
- 执行证据：worker 进入 `completed` 并返回指定 marker。
- 模型辅助证据：worker 返回其可见的 `model_id`。
- 并发证据：同一轮并发创建 6 个，第 7 个统一返回 `AgentLimitReached`。
- 生命周期证据：父 session 跨多轮继续派生，完成后可关闭 worker 并继续对话。

仍需单独区分：

- worker 自报 `model_id` 不等于服务端实际路由日志。
- 若验收要求无 fallback，需要核对 OpenCodex 请求日志中的 provider/model/HTTP 状态。
- catalog visibility 不等于 route 一定可执行；本轮通过实际 worker 执行验证了列出的 7 个模型。
- build、设备、文件修改、外部系统写入都不属于本验证。

## 13. 常用只读命令

```bash
codex --version
ocx --version
ocx v2 status
ocx models live --json
ocx logs --json
```

读取当前 Codex picker：

```bash
jq -r '
  .models
  | to_entries
  | map(select(.value.visibility == "list"))
  | sort_by(.value.priority, .key)[]
  | .value.slug
' ~/.codex/opencodex-catalog.json
```

不要在文档或聊天中输出账号凭据、admin token、OAuth token 或完整敏感请求体。

## 14. 本机实现位置

- Codex 配置：`~/.codex/config.toml`
- OpenCodex 配置：`~/.opencodex/config.json`
- OpenCodex 有效 catalog：`~/.codex/opencodex-catalog.json`
- Codex cache：`~/.codex/models_cache.json`
- catalog 路径注入：`/opt/homebrew/lib/node_modules/@bitkyc08/opencodex/src/codex/inject.ts`
- provider model 汇总：`/opt/homebrew/lib/node_modules/@bitkyc08/opencodex/src/codex/catalog/provider-fetch.ts`
- catalog 合并与过滤：`/opt/homebrew/lib/node_modules/@bitkyc08/opencodex/src/codex/catalog/sync.ts`
- catalog/cache 原子提交：`/opt/homebrew/lib/node_modules/@bitkyc08/opencodex/src/codex/convergence.ts`
- V1/V2 thread 配置与单位转换：`/opt/homebrew/lib/node_modules/@bitkyc08/opencodex/src/codex/features.ts`
- OpenCodex V2/thread CLI：`/opt/homebrew/lib/node_modules/@bitkyc08/opencodex/src/cli/v2.ts`
- OpenCodex 管理 API：`/opt/homebrew/lib/node_modules/@bitkyc08/opencodex/src/server/management/agent-settings-routes.ts`
- Codex 0.147.0 二进制：`/opt/homebrew/Caskroom/codex/0.147.0/bin/codex`

## 15. 官方边界

官方 OpenAI 文档确认 multi-agent 可以由父模型协调多个 subagent 并行工作，当前仍为 beta：

<https://developers.openai.com/api/docs/guides/latest-model>

官方文档没有覆盖 OpenCodex 的 namespaced model 注入、V1/V2 兼容模式、当前本地 thread 默认值或 `fork_context` schema；这些结论来自上述本机配置、源码、工具 schema 和实际运行验证。
