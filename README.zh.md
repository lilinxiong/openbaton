# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

[English](README.md) | **中文**

Baton 是 CLI 中立、由 manifest 驱动的调度与策略层。它让 director 对话
保持清晰，从所选 adapter 的实时目录中自动选择模型，并通过原生子执行
接口运行已授权的工作。

子 agent 容量属于一个 root-agent tree，由哈希后的 `BATON_SESSION_ID` 标识。
root agent 本身不计入容量；直接子 agent、孙级及更深层 descendants 共享同一个
tree-local 槽位池。

软件包可以独立运行，也可以在有结构化变更计划时消费它。需要 Node.js 22.5
或更高版本。

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

Baton core 不内置目录。adapter 软件包通过 `~/.baton/adapters/<adapter-id>/` 下的
`adapter.json` 发现，或由 `BATON_ADAPTER_PATHS` 指定。执行阶段没有交互式
模型选择。

## 第一次会话

所有会产生 ticket 或对容量敏感的 dispatch 命令都要求 `BATON_SESSION_ID`。
Baton 将其哈希为 `session_uid`，root 与 descendants 必须保留同一身份。

```bash
export BATON_SESSION_ID="<opaque-session>"
baton models refresh --host <adapter-id>
baton match "<work description>" --host <adapter-id>
baton spawn "<request>" --host <adapter-id> --classification <class>
baton dispatch next --host <adapter-id> --json
baton dispatch status --host <adapter-id> --json
baton dispatch complete <ticket> --host <adapter-id> --text "<conclusion>" --release --json
```

`baton apply` 用于规划 OpenSpec 变更。`--dispatch` 必须为每个 unit 提供
`--write-path` 或 `--read-only`。没有 OpenSpec 时使用 `baton spawn`。

自动路由只使用已启用 profile 的 `coding_models` allowlist、实时目录、任务
形状、adapter 支持的推理选项、服务层信息、路由健康和容量事实。

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

`dispatch status` 只查看当前 root tree。普通 `baton status` 仍保留 workspace
ticket inventory，但在 `capacity_trees` 下按 tree 分组。

## 文档

- [入门样例](samples/getting-started/README.zh.md) — 隔离环境下从 init 走到 dispatch
- [样例说明](samples/README.zh.md) — adapter manifest 样例与验收形态
- [产品指南](docs/guide.zh.md) — adapter SDK、配置、调度、ticket 生命周期、
  仓库安全，以及一次实测 OpenSpec apply
- [架构说明](docs/architecture/baton-dynamic-director.zh.md)
- [架构图](docs/architecture/openbaton-architecture.html)
- [分层运行图](docs/architecture/openbaton-layered-architecture.html)
- [运行时 skill](SKILL.md)

