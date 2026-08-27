# baton

Baton 是 CLI 中立、由 manifest 驱动的调度与策略层。它让 director 对话
保持清晰，从所选 adapter 的实时目录中自动选择模型，并通过原生子执行
接口运行已授权的工作。

子 agent 容量属于一个 root-agent tree，由哈希后的 `BATON_SESSION_ID` 标识。
root agent 本身不计入容量；直接子 agent、孙级及更深层 descendants 共享同一个
tree-local 槽位池。

软件包需要 Node.js 22.5 或更高版本：

```bash
npm install -g @zhouliuya/openbaton
baton init
baton config --cli <adapter-id> --enable
```

## 源码 checkout

在源码目录执行以下脚本，可以安装依赖、运行检查、构建、链接 `baton`，
并刷新共享运行时文件：

```bash
python3 scripts/update_local_baton.py
```

只有明确接受省略检查时才使用 `--skip-tests`。源码目录中的日常命令为：

```bash
bun install
bun run baton -- <command> ...
```

## Public Adapter SDK

Baton core 不内置目录。外部 adapter 软件包放在
`~/.baton/adapters/<adapter-id>/`，或通过 `BATON_ADAPTER_PATHS` 指定目录，
由其中的 `adapter.json` 被发现。adapter 负责可执行文件解析、实时模型
目录、原生子执行和自身生命周期；Baton 只消费 SDK 的规范化结果。

软件包从以下入口导出 SDK：

```text
@zhouliuya/openbaton/adapters
@zhouliuya/openbaton/adapters/sdk
```

### Manifest

manifest schema 为 `1`，字段固定且可审计：

```json
{
  "schema": 1,
  "adapter": {
    "id": "sample-adapter",
    "display_name": "Sample Adapter",
    "package_name": "sample-adapter-package",
    "package_version": "1.0.0",
    "sdk_version": "1.0"
  },
  "catalog": {
    "command": "catalog.js",
    "args": [],
    "protocol": "json",
    "timeout_ms": 15000
  },
  "invocation": { "signal": "SAMPLE_ADAPTER_SESSION" },
  "native": { "execution_handle_kind": "sample-native-task" },
  "runtime_skill": {
    "source": "runtime/SKILL.md",
    "destination": ".baton/skills/sample-adapter/SKILL.md"
  },
  "quota": {
    "max_concurrent_subagents": 3,
    "max_depth": 1,
    "backpressure": "defer"
  }
}
```

manifest 声明 adapter 标识、显示信息、软件包和 SDK 版本、目录命令与
协议、调用环境信号、不透明的原生 handle 类型、运行时 skill 路径，以及
adapter 报告的容量、深度和背压事实。`quota.max_concurrent_subagents` 表示
一个 root-agent tree 中活跃 descendants 的最大数量，不包含 root；它不是
workspace、host 全局、进程、模型目录或总 agent 数。路径必须是软件包内相对
路径且不能越界；字段无效或 id 重复时停止发现。

目录命令返回一个包含相同 `adapter_id`、可选版本和 `models` 数组的 JSON
对象。每个模型的 `id`、显示名、描述、可见性、推理强度、模态、速度层、
服务层和默认值都按原样保留；缺失的可选字段保持未知。Baton 不补造目录
条目或执行选项。

## 配置与自动路由

`baton init` 发现 manifest，`baton config --cli <id>` 查询该 adapter 的
实时目录。只有明确选择的 profile 会写入 `~/.baton/config.toml`：

```toml
[director]
max_concurrent = 3
max_depth = 1

[cli.sample-adapter]
enabled = true
runner = "<model-id>"
longctx = "<model-id>"
coding_models = ["<model-id>", "<another-model-id>"]
```

`director.max_concurrent` 是当前 root-agent tree 的 active subagent policy
上限（不包含 root），不是 workspace 共享池；已知的 host 上限始终会约束它。
`max_depth` 是独立的 descendants 深度策略，不等同于并发容量。

`runner` 与 `longctx` 是路由标签；`coding_models` 是有序 allowlist，数组
顺序就是 Coding 优先级。自动选择只使用该 allowlist、当前目录、任务形状、
adapter 支持的推理选项、服务层信息、路由健康和容量事实。选择结果会写入
proposal、ticket 与 Receipt，并在 dispatch 时再次按目录校验。

执行阶段没有交互式模型选择。adapter、模型、推理选项、服务层、授权或
分类无效时，在原生执行前停止；Baton 不越过启用的 profile，也不凭空添加
模型选项。

## Director、scope 与调度

讨论和只读分析留在 director。已授权的实现单元与分类后的机械单元使用所
选 adapter 的原生子执行接口。director 提供结构化执行类别；operation label
只作为审计信息。

创建写入 ticket 前，director 先做只读影响面与依赖分析，为每个 unit 记录
精确路径和允许操作：`write`、`create`、`delete`、`rename`、`chmod`。Baton
会在一次原子决策中校验全部 unit，包括 rename 两端、路径前缀重叠和已被活跃
ticket 占用的 scope。未知 scope 或操作会在修改前停止。

每次调度或补充容量时，Baton 针对当前 `(host, session_uid)` root-agent tree
计算 maximal safe ready frontier：所有依赖已就绪、scope 完整且两两不冲突、并且
适合该 tree 有效 subagent 容量的 unit。直接和嵌套 descendants 共用槽位，root
不占槽；另一个 root tree 的 queued/active ticket 不会被计数，也不会被 refill。
所有当前可用槽位都应填满；section 顺序只用于相同条件下的稳定排序。

有效容量取已知来源的最小值：native/adapter `host_limit`、配置的
`configured_policy`，以及可选的当前操作 `operation_limit`。dispatch snapshot
会在 `capacity_sources` 中返回同一个值及其 provenance；每个来源包含 `kind`、
`value` 和 `applied`。显式 `--capacity` 只降低当前 tree 的容量且不会持久化；
旧的 `dispatch-<host>.json` 只保留作回滚残留，不再参与调度。

## Ticket 身份与生命周期

所有会产生 ticket 或对容量敏感的 dispatch 命令都要求 `BATON_SESSION_ID`。
Baton 将其哈希为不可变的 root-agent-tree 身份 `session_uid`，并在该 session
内分配连续的 `session_ordinal`。root 与 descendants 的 ticket 必须保留同一
身份；child、reconnect 或 successor 不能通过创建新 session 获取额外容量。
ticket id 包含不透明前缀、session uid 和 ordinal；id 是数据，不是路由信号。
身份交接必须同时保留 `session_id`、`ticket_id` 和 adapter 返回的原生 execution
handle。

每张 ticket 都遵循以下流程：

1. 用 `baton spawn` 或带 scope 的 `baton apply` 创建 ticket 与不可变 Receipt。
2. reserve，取得精确 prompt、description、模型、选项、scope 和 reservation。
3. 以新上下文调用 adapter 的原生子执行接口，并传入精确选择结果。
4. 立即把不透明的原生 execution handle 与 session、ticket 身份绑定。
5. 根据原生 activity 等待，按需记录简短进度，并记录一次 terminal result。
6. release 后再补充容量。

handle 类型由 adapter 定义。Baton 不从文本推断身份，也不把原生 handle 换成自行
生成的标识。native 返回 `AGENT_LIMIT_REACHED` 时，Baton 在原 tree 中保留同一
reservation、模型、session 身份和 attempt，等槽位释放后继续，不修改另一个 tree。
槽位从 `dispatching` 起一直保持到 bound running；terminal 结果也要等 native
release 确认后才归还。

## 配额耗尽与 successor

adapter 明确报告 host/profile 模型配额耗尽后，Baton 先保存对所有使用该 route
的 root tree 都有效的可用性事实，并确认写入 ticket 的修改前 baseline 未变化。
满足条件时，可从下一项 Coding 优先级创建不可变 successor。
successor 获取该 session 的新 ordinal 和新 Receipt，记录
`successor_from_ticket_id`、`successor_reason`，并保留原 session、adapter、
scope、授权和配额 lineage；随后重新执行目录、选项、容量和 scope 校验。

原 ticket 不会被改写成另一模型，配额也不会重置。若已经发生修改或 baseline
无法核对，则停止并报告需要人工处理的 reconciliation，不创建 successor。

## 仓库安全

只读是默认模式。写入 ticket 携带路径/操作 allowlist 与由 parent 负责的仓库
观察结果；worker 不执行 Git 操作。只有显式授权、独占、针对 parent 已暂存树的
commit ticket 可以创建一次 commit，其余仓库操作都不属于 worker。tree-local
容量不会削弱 workspace-wide 的路径所有权、Git safety 审计、activation/dispatch
锁或跨 tree 写入冲突检查。

Receipt、ticket 状态、目录快照和安装记录位于用户级 `~/.baton`；工作区文件
仍由调用方负责。

## 常用命令

```text
baton init
baton config --cli <adapter-id> --enable
baton models refresh --host <adapter-id>
baton models status --host <adapter-id>
baton match "<work description>" --host <adapter-id>
baton spawn "<request>" --host <adapter-id> --classification <class>
baton apply <change> --host <adapter-id>
baton dispatch next --host <adapter-id> [--capacity <n>] --json
baton dispatch status --host <adapter-id> [--capacity <n>] --json
baton dispatch complete <ticket> --host <adapter-id> --text "<conclusion>" --release --json
```

`dispatch status` 只查看当前 root tree，返回 `host`、`session_uid`、`capacity`、
`capacity_sources`、`active`、`available` 以及该 tree 的 queue/lifecycle ticket
列表。普通 `baton status` 仍保留 workspace ticket inventory，但在
`capacity_trees` 下按 tree 分组，绝不发布一个聚合 workspace `available`。缺失或
不匹配的 tree 身份，以及没有有效 `session_uid` 的活跃记录，都会 fail closed 并
报告 compatibility blocker，不改写 ticket 或 Receipt 历史。

发布检查应分别报告 SDK conformance、manifest 发现、构建与打包、实时目录、
原生 execution handle、ticket 与 quota lineage、清理结果，以及精确 changed-path
审计。
