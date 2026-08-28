# 用 Baton 入门

[English](README.md) | **中文**

这份 walkthrough 使用仓库内的 `sample-adapter` 目录 fixture，让你可以
在没有付费 host 的情况下跑 `baton init`、`baton config`、`baton match`、
`baton spawn` 和 `dispatch`。它不会调用真实的原生子 CLI。

adapter 软件包位于 [`../manifest-example`](../manifest-example)。
如果使用付费 host，先把它安装到 `~/.baton/adapters/<adapter-id>/`，
再把 `--host sample-adapter` 换成该 adapter id。

## 你会完成什么

1. 安装 Baton，或使用源码 checkout。
2. 把发现路径指向样例 adapter。
3. `init`，并用目录里的模型 id 启用 profile。
4. 刷新目录，并对一个简单请求执行 `match`。
5. 设置 `BATON_SESSION_ID`，`spawn` 一张写入 ticket，再 `dispatch`。
6. 绑定一个教学用 execution handle，然后 `complete --release`。

全程使用一次性 home，因此不会改写你真实的 `~/.baton`。

## 安装

需要 Node.js 22.5 或更高版本。

可以全局安装已发布的软件包，或在本 checkout 中用 bun install，
再执行 bun run baton -- help。下面的命令默认已有 baton 可执行文件。
如果在 checkout 里运行，请把每条命令改成 bun run baton --。

## 隔离发现

使用临时 HOME 和 BATON_ADAPTER_PATHS，让发现只读取样例软件包。
在仓库根目录执行：

```bash
REPO="$PWD"
ADAPTER="$REPO/samples/manifest-example"
sample_home="$(mktemp -d)"
work="$(mktemp -d)"
export HOME="$sample_home"
export BATON_ADAPTER_PATHS="$ADAPTER"
export BATON_SESSION_ID="getting-started-session"
```

init 会发现 manifest，并把捆绑的 adapter 软件包装进
~/.baton/adapters/。config --cli sample-adapter 会查询该 adapter
目录，并且只写入所选 profile。

```bash
baton init --cli sample-adapter
baton config --cli sample-adapter --runner sample-model --longctx sample-model --coding-model sample-model --enable
```

当前目录 fixture 只报告一个模型 id：sample-model。runner 和
longctx 是路由标签。coding_models 是自动选择使用的有序 allowlist。

```bash
baton models refresh --host sample-adapter
baton models status --host sample-adapter
```

## match

match 会披露首选模型，但不会创建工作。样例目录只报告 reasoning
effort low。带标准复杂度措辞的请求可能失败，并返回
CODING_MODELS_EXHAUSTED / REASONING_EFFORT_UNSUPPORTED。请使用
Baton 会分类为 simple/low 的简单请求，例如：

```bash
baton match "tiny typo in one file" --host sample-adapter
```

期望形态：首选 sample-model@low (CODING_PRIORITY)。

## spawn 与 apply

会产生 ticket 的命令都要求 BATON_SESSION_ID。spawn 需要 director
分类。mechanical 使用 runner 标签。analysis 和 discussion 留在
director。写入 ticket 还需要 git worktree 和 --write-path。

```bash
cd "$work"
git init -q
printf 'demo\n' > README.md
git add README.md
git -c user.email=gs@example.invalid -c user.name=GS commit -qm init
baton spawn "tiny typo in one file" --host sample-adapter --classification mechanical --write-path README.md --json
```

JSON ticket 包含 session_uid、session_ordinal、ticket id、所选
模型、Receipt id 和 write_allowlist。请保留该 ticket id，供
dispatch 使用。

没有 OpenSpec 时，apply 会退出并指向 spawn：

```
OpenSpec is not in this project. baton still works standalone:
  baton spawn "explore the auth module"
```

如果已有 OpenSpec change，先规划，再只 dispatch 带 scope 的 unit：

```text
baton apply <change> --host sample-adapter
baton apply <change> --host sample-adapter --dispatch --unit <id> --write-path <path> --json
```

--dispatch 缺少 --unit 会被拒绝 (TASK_SCOPE_REQUIRED)。

## dispatch

对容量敏感的 dispatch 命令同样要求 BATON_SESSION_ID。容量按
(host, session_uid) root-agent tree 计算。

```bash
baton dispatch next --host sample-adapter --json
baton dispatch status --host sample-adapter --json
```

dispatch next 会 reserve ticket，并返回精确 prompt、模型、scope
和 reservation envelope。status 报告 host、session_uid、capacity、
capacity_sources、active 和 available。

sample-adapter 没有原生子进程。manifest 声明
native.execution_handle_kind = sample-native-task。绑定一个该类型
的教学 handle，控制平面才能 complete。真实 adapter 会从原生子
API 返回这种 handle；不要发明另一种类型。

```bash
baton dispatch bind <ticket> --execution-handle sample-native-task=demo-1 --host sample-adapter --json
baton dispatch complete <ticket> --host sample-adapter --text "fixed the typo" --release --json
baton dispatch status --host sample-adapter --json
```

release 之后，active 应回到 0，该 ticket 会出现在 terminal 下，
状态为 completed。

## 运行隔离脚本

在仓库根目录执行：

```bash
bun samples/getting-started/walkthrough.mjs
```

脚本会创建临时 HOME 和 git worktree，然后跑完上面的序列。
它会打印每条命令，以及首选模型和 ticket id。

## 说明

- 如果你已经有在意的 Baton 状态，不要把这个 fixture 对着真实 HOME
  跑。脚本会隔离 HOME。
- baton init 也可能把捆绑 adapter（例如 adapters/codex）复制进隔离的
  ~/.baton/adapters/。这份 walkthrough 仍然只使用
  --host sample-adapter。
- 执行阶段没有交互式模型选择器。
- probe-e2e 是另一份付费 host fixture；见 ../probe-e2e/README.zh.md。
