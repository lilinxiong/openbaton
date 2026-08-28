# Baton 架构

[English](baton-dynamic-director.md) | **中文**

## 边界

Baton 是 CLI 中立的调度与策略层。外部 adapter 软件包才是集成边界：每个软件包
负责可执行文件发现、实时目录、原生子执行，以及 adapter 自身的生命周期。
Baton 通过 manifest 发现这些软件包，并只操作规范化后的公开 SDK；core 代码
不包含目录，也不包含 adapter 专用协议分支。

## Manifest 发现

运行时优先扫描 `BATON_ADAPTER_PATHS`；未设置时扫描 `~/.baton/adapters/`。
每个目录包含一份 schema 为 `1` 的 `adapter.json`。manifest 声明：

```text
adapter       稳定 id、显示信息、软件包/版本、SDK 版本
catalog       可执行路径、参数、协议、超时
invocation    运行时信号和可选环境说明
native        不透明的 execution_handle_kind
runtime_skill 软件包内源路径与安装目标
quota         max_concurrent_subagents、max_depth、backpressure
```

`quota.max_concurrent_subagents` 是按 root-agent tree 计算的 subagent 上限。
它只统计活跃 descendants，不包含 root agent；它从来不是 workspace 全局、
host 全局、进程、模型目录或总 agent 数。schema-1 的旧拼写会在 adapter 边界
归一化，但不改变这一含义。

运行时 skill 路径必须相对软件包且不能越界；目录命令可以是软件包内路径或
绝对可执行文件。发现阶段会校验精确字段、SDK 主版本、协议、软件包目录和
重复 id。

目录命令返回包含匹配 `adapter_id`、可选版本和 `models` 数组的 JSON。
adapter 保留每个模型的 id、显示信息、可见性、推理选项、模态、速度/服务层、
默认值以及其他已声明字段。缺失的可选值保持未知；Baton 从不补造目录条目
或执行选项。

## 配置流程

```text
baton init
  -> discover manifests
  -> select one adapter
  -> query that adapter's catalog
  -> persist one cli.<id> profile and catalog snapshot

baton spawn/apply
  -> resolve the selected adapter
  -> classify and scope units in the director
  -> choose from the enabled coding_models order
  -> validate model/options against the catalog
  -> create a Receipt and ticket
  -> reserve and hand off to native execution
```

只有明确选择的 profile 会被写入。`runner`、`longctx` 和有序的
`coding_models` 列表是策略标签；adapter 目录仍是模型 id 与支持选项的权威。
adapter、profile、模型、选项、授权或分类不可用时，执行停止。

## Director 与调度

director 负责讨论、只读分析、分类、依赖排序、授权和仓库 scope。
原生子执行才是 worker 边界。`mechanical` 类别选择 `runner`；
`long-context` 类别选择 `longctx`；operation label 只作为审计信息保留。

创建任何写入 ticket 之前，director 先做只读影响面/依赖分析，并记录精确
路径以及允许的操作：`write`、`create`、`delete`、`rename`、`chmod`。
所有 unit 会相对彼此和已占用 scope 做一次原子校验。rename 两端与路径
前缀重叠视为冲突。未知路径、依赖或操作会阻止创建 ticket。

每次调度或 refill 决策时，针对当前 `(host, session_uid)` root-agent tree
计算 maximal safe ready frontier：所有依赖已就绪、scope 完整、路径两两
不冲突、并且仍有有效 subagent 容量的 unit。直接子 agent、孙级及更深层
descendants 共享同一槽位池；root 不占槽。填满该 tree 的全部可用槽位，
另一个 root tree 的 queued 或 active ticket 既不计数也不被改写。
section 顺序只是同等选择之间的稳定平局规则。

有效容量一次性取已知 `host_limit`、`configured_policy` 和可选当前操作
`operation_limit` 的最小值。reservation 与 dispatch status 通过
`capacity_sources` 暴露同一个值及其 provenance（`kind`、`value`、
`applied`）。`--capacity` 覆盖只作用于当前 tree 且不持久化；旧的
`dispatch-<host>.json` 状态只是惰性回滚残留。`max_depth` 仍是独立的
descendants 深度策略。

## 身份与生命周期

创建 ticket 以及对容量敏感的 dispatch 操作都必须提供 `BATON_SESSION_ID`。
Baton 将其哈希为不可变的 root-agent-tree 键 `session_uid`，并在该 session
内分配连续的 `session_ordinal`。root 与 descendants 的 ticket 保留同一
键；child、reconnect 或配额 successor 不能通过创建新 session 来逃避
tree 上限。ticket id 包含不透明前缀、session uid 和 ordinal。它们是
标识符，不是路由输入。

共用生命周期为：

```text
ticket + Receipt
  -> reservation
  -> adapter native spawn
  -> identity handoff { session_id, ticket_id, native_handle, adapter_id }
  -> activity-based wait
  -> one terminal result
  -> release
```

`native_handle` 不透明，其类型来自 manifest。Baton 不要求统一字段名，
不从 ticket 文本推断身份，也不自行生成 handle。native 返回
`AGENT_LIMIT_REACHED` 时，同一 reservation 回到原 tree 队列，不消耗
attempt，也不改变其模型、session 身份或另一个 tree 的状态。槽位从
`dispatching` 起一直保持到 bound running；terminal 结果也要等 native
release 确认后才归还。

## 配额 successor 策略

明确的 host/profile 模型配额耗尽结果，会作为可用性事实记录给所有使用
该 route 的 root tree。对于写入 ticket，Baton 先确认修改前 baseline
未变化，然后可以从下一项已配置 coding route 创建不可变 successor。
successor 获得新的 session ordinal 和新 Receipt，保留原 session、
adapter、host、scope、授权和配额 lineage，并记录
`successor_from_ticket_id` 与 `successor_reason`。

原 ticket 保持不可变。successor 会重新执行目录、选项、容量和 scope
校验；配额不会重置。若已经开始修改或 baseline 无法核对，则不创建
successor，必须先做 reconciliation。

## 仓库安全

只读是默认模式。写入 ticket 携带路径/操作 allowlist 与由 parent 负责的
仓库观察结果。worker 不执行 Git 操作。只有显式授权、独占、针对 parent
已暂存树的 commit ticket 可以创建一次 commit，其余仓库操作都不属于
worker。tree-local 容量不会收窄 workspace-wide 的路径所有权、Git safety
审计、activation/dispatch 锁或跨 tree 写入冲突检查；host/profile 的
route 可用性与配额仍比单个 root tree 更宽。

普通 `baton status` 可以列出 workspace 内所有 ticket，但容量只按
`(host, session_uid)` 分组报告为独立的 `capacity_trees`。它从不暴露
一个聚合 workspace `available`。当前 tree 的
`baton dispatch status --host` 报告 `host`、`session_uid`、`capacity`、
`capacity_sources`、`active`、`available` 以及该 tree 的 queue/lifecycle
列表。占着槽位却没有有效 tree 身份的记录是 compatibility blocker，
不会被悄悄归属或改写。

Receipt、ticket 状态、目录快照和安装记录位于用户级 `~/.baton`；
工作区文件仍由调用方负责。这一架构把 adapter 专用行为留在软件包
边界，同时让 director 保持确定且可审计。
