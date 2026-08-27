# baton

Baton 是 CLI 中立、由 manifest 驱动的调度与策略层。它让 director 对话
保持清晰，从所选 adapter 的实时目录中自动选择模型，并通过原生子执行
接口运行已授权的工作。

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
    "max_concurrent": 4,
    "max_depth": 1,
    "backpressure": "defer"
  }
}
```

manifest 声明 adapter 标识、显示信息、软件包和 SDK 版本、目录命令与
协议、调用环境信号、不透明的原生 handle 类型、运行时 skill 路径，以及
adapter 报告的并发、深度和背压事实。路径必须是软件包内相对路径且不能
越界；字段无效或 id 重复时停止发现。

目录命令返回一个包含相同 `adapter_id`、可选版本和 `models` 数组的 JSON
对象。每个模型的 `id`、显示名、描述、可见性、推理强度、模态、速度层、
服务层和默认值都按原样保留；缺失的可选字段保持未知。Baton 不补造目录
条目或执行选项。

## 配置与自动路由

`baton init` 发现 manifest，`baton config --cli <id>` 查询该 adapter 的
实时目录。只有明确选择的 profile 会写入 `~/.baton/config.toml`：

```toml
[director]
max_concurrent = 4
max_depth = 1

[cli.sample-adapter]
enabled = true
runner = "<model-id>"
longctx = "<model-id>"
coding_models = ["<model-id>", "<another-model-id>"]
```

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

每次调度或补充容量时，Baton 计算 maximal safe ready frontier：所有依赖已就
绪、scope 完整且两两不冲突、并且适合当前 adapter 物理容量的 unit。所有可用
槽位都应填满；section 顺序只用于相同条件下的稳定排序。

## Ticket 身份与生命周期

所有会产生 ticket 的命令都要求 `BATON_SESSION_ID`。Baton 将其哈希为
`session_uid`，并在该 session 内分配连续的 `session_ordinal`。ticket id
包含不透明前缀、session uid 和 ordinal；id 是数据，不是路由信号。身份交接
必须同时保留 `session_id`、`ticket_id` 和 adapter 返回的原生 execution handle。

每张 ticket 都遵循以下流程：

1. 用 `baton spawn` 或带 scope 的 `baton apply` 创建 ticket 与不可变 Receipt。
2. reserve，取得精确 prompt、description、模型、选项、scope 和 reservation。
3. 以新上下文调用 adapter 的原生子执行接口，并传入精确选择结果。
4. 立即把不透明的原生 execution handle 与 session、ticket 身份绑定。
5. 根据原生 activity 等待，按需记录简短进度，并记录一次 terminal result。
6. release 后再补充容量。

handle 类型由 adapter 定义。Baton 不从文本推断身份，也不把原生 handle 换成自行
生成的标识。容量不足时保留同一 reservation、模型
和 attempt，等槽位释放后继续。

## 配额耗尽与 successor

adapter 明确报告配额耗尽后，Baton 先保存可用性事实，并确认写入 ticket 的修改
前 baseline 未变化。满足条件时，可从下一项 Coding 优先级创建不可变 successor。
successor 获取该 session 的新 ordinal 和新 Receipt，记录
`successor_from_ticket_id`、`successor_reason`，并保留原 session、adapter、
scope、授权和配额 lineage；随后重新执行目录、选项、容量和 scope 校验。

原 ticket 不会被改写成另一模型，配额也不会重置。若已经发生修改或 baseline
无法核对，则停止并报告需要人工处理的 reconciliation，不创建 successor。

## 仓库安全

只读是默认模式。写入 ticket 携带路径/操作 allowlist 与由 parent 负责的仓库
观察结果；worker 不执行 Git 操作。只有显式授权、独占、针对 parent 已暂存树的
commit ticket 可以创建一次 commit，其余仓库操作都不属于 worker。

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
baton dispatch next --host <adapter-id> --capacity <n> --json
baton dispatch complete <ticket> --host <adapter-id> --text "<conclusion>" --release --json
```

发布检查应分别报告 SDK conformance、manifest 发现、构建与打包、实时目录、
原生 execution handle、ticket 与 quota lineage、清理结果，以及精确 changed-path
审计。
