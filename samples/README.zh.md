# 样例

[English](README.md) | **中文**

新读者请先看 [入门样例](getting-started/README.zh.md)。
那份 walkthrough 使用下面的目录 fixture，在隔离 HOME 中跑完
init、config、match、spawn 和 dispatch。

# Adapter manifest 样例

`manifest-example/` 是一个很小的外部 adapter 软件包。它展示公开 SDK
边界，但不内嵌真实 CLI、账号或模型目录。Baton 通过 `adapter.json`
发现该软件包；软件包自己提供目录命令和运行时 skill。

## 查看软件包

```bash
sed -n '1,240p' samples/manifest-example/adapter.json
sed -n '1,240p' samples/manifest-example/runtime/SKILL.md
```

manifest 覆盖 SDK schema、稳定 adapter id、软件包元数据、目录
命令/协议、调用信号、不透明的原生 execution-handle 类型、运行时
skill 路径，以及 quota/backpressure 事实。目录命令返回规范化 JSON，
其中只有一个 adapter id 和精确的模型元数据。

## 隔离发现

先构建 checkout，再把发现路径指向样例软件包：

```bash
npm run build
BATON_ADAPTER_PATHS="$PWD/samples/manifest-example" \
  baton init
BATON_ADAPTER_PATHS="$PWD/samples/manifest-example" \
  baton config --cli sample-adapter --enable
BATON_ADAPTER_PATHS="$PWD/samples/manifest-example" \
  baton models refresh --host sample-adapter
```

用临时 home 可以得到可重复的运行：

```bash
sample_home="$(mktemp -d)"
HOME="$sample_home" BATON_ADAPTER_PATHS="$PWD/samples/manifest-example" \
  baton config --cli sample-adapter --enable
```

结果应只包含所选的 `cli.sample-adapter` profile，以及该软件包自己
命令返回的目录。新增另一个 adapter 不需要改 core 源码。

## 验收形态

adapter 发布就绪的条件是：通过 SDK conformance、隔离软件包检查、
manifest 发现、实时目录检查、精确的原生子执行、无效模型拒绝、
ticket 生命周期和清理审计。原生身份交接必须包含 `session_id`、
`ticket_id`、`session_uid`、`session_ordinal`，以及 adapter 的不透明
execution handle。

在明确报告配额耗尽时，干净的写入 baseline 才允许创建不可变
successor，并分配新的 per-session ordinal 和新 Receipt。它记录
`successor_from_ticket_id` 和 `successor_reason`，保留
host/scope/session 与配额 lineage，并重新执行全部路由检查。
原 ticket 保持不变。

简明验收清单见 [EXPECTED.md](EXPECTED.md)。
