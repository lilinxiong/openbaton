# Baton 2.0 指南

主 agent 决定是否派工、明确公共契约、审查结果，并执行已授权的提交。Baton 负责准备模型参数和简短任务说明；工作只交给当前宿主的原生 subagents。

## 工作方式与模型

| 工作方式 | 子任务还需决定什么 | 默认 effort 偏好 |
|---|---|---|
| execution | 按已定步骤执行、窄范围核对 | low |
| implementation | 在明确契约内补齐局部实现 | medium |
| investigation | 查明原因或解决设计问题 | high |

模型与 effort 分别选择。步骤明确的多文件迁移也可以使用 execution。主 agent 可以自己实现，不需要为了填满并发槽位而派工。

先通过 `baton models --host codex` 查看真实模型 id，再配置：

```text
baton init --cli codex
baton config --cli codex --coding-model MODEL --execution-model MODEL --enable
baton match --host codex --work-mode execution --model MODEL --effort low --json
```

`MODEL` 替换为目录中的真实 id，模型参数可以重复。`--implementation-model`、`--investigation-model` 设置其他工作方式的模型偏好。在终端运行不带 `--cli` 的 `baton config` 可交互选择。

显式指定的 effort、service tier 必须被模型支持；自动选模会跳过不满足显式条件的候选。宿主已知某模型不可用时，可传 `--unavailable-model ID`，Baton 不猜测额度。`--context-tokens N` 只检查目录中已知的容量，未知则明确披露；不会从“迁移、跨模块”等词猜测上下文需求。

## 准备子任务

保存一份 JSON brief，例如：

```json
{
  "goal": "迁移已明确的新 API 调用方",
  "decisions": ["遵守已有的所有权契约"],
  "scope": ["src/example"],
  "acceptance": ["列出修改文件和剩余旧调用"],
  "constraints": ["不修改公共 API"],
  "mode": "write",
  "handoff": {
    "existingChanges": "新 API 已实现",
    "checks": "静态接口核对已通过",
    "unresolvedIssues": "示例调用方尚未迁移"
  }
}
```

```text
baton spawn --host codex --brief brief.json --work-mode execution --json
```

`goal` 和非空 `acceptance` 必填；`mode` 默认 `read-only`，写入模式必须有 scope。其他字段可选。scope 可以是相对模块、目录或文件，属于任务约束，**不是文件系统沙箱**。主 agent 负责避免并发写入冲突并核对最终 diff。

命令返回真实模型 id、受支持的 effort、格式化 prompt、scope、`fork_context:false` 和 `spawned:false`。主 agent 将参数传给宿主原生子 agent API，使用新的上下文。此时 Baton 还没有启动 worker；原生句柄和完成状态始终由宿主管理。

## 记录结果

```text
baton record --host codex --handle HANDLE --model MODEL --status completed --text "已审查的结果"
baton status --host codex --json
```

结果记录可选，追加到 `~/.baton/results.jsonl`。status 仅返回当前宿主和工作目录最近二十条记录，不表示实时运行状态。必要时使用 `blocked`、`failed`；升级模型时把已有修改、检查和缺口写进下一份 handoff。

## 安装与不兼容变更

源码安装运行 `python3 scripts/update_local_baton.py`，它会测试、构建、链接并刷新 skill。`baton update` 刷新已安装文件。`baton uninstall --clean --dry-run` 预览清理；移除 `--dry-run` 后删除 Baton 配置、结果和拥有的集成文件。被修改的集成文件会保留并报告冲突。包管理器的命令链接需要单独卸载。

V2 删除 managed dispatch、apply、activation、ticket、Receipt、session、队列和 Git 审计；配置不再包含 runner、longctx 和 director 容量字段，不保留第二套兼容运行时。旧 managed 版本的测量不能作为 v2 性能证据。

adapter 提供当前宿主的模型目录和 runtime skill，不承担跨 CLI 执行。参见 [manifest 示例](../samples/manifest-example/) 和 [隔离 walkthrough](../samples/getting-started/)。
