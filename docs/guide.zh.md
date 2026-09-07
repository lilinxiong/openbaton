# Baton 2.0 指南

用户显式调用 Baton 即表示要求派工。主 agent 明确公共契约、组织子任务、审查结果，并执行已授权的提交。Baton 负责准备模型参数和简短任务说明；工作只交给当前宿主的原生 subagents。

## 工作方式与模型

| 工作方式 | 子任务还需决定什么 |
|---|---|
| execution | 按已定步骤执行、窄范围核对 |
| implementation | 在明确契约内补齐局部实现 |
| investigation | 查明原因或解决设计问题 |

主 agent 根据当前任务独立选择 effort，工作方式不预设 effort 偏好。通过 `--effort LEVEL` 指定受支持的强度；省略时 Baton 不输出 `reasoning_effort`，保持宿主默认行为，也不代填目录中的默认值。步骤明确的多文件迁移也可以使用 execution。小任务交给一个 worker，共享上下文的工作合并，独立范围的工作并行。主 agent 完成必要的边界检查后交接，避免先完整执行 worker 的任务；宿主无法派工或缺少必要信息时报告阻塞。

先通过 `baton models --host codex` 查看真实模型 id，再配置：

```text
baton init --cli codex
baton config --cli codex --execution-model MODEL --enable
baton match --host codex --work-mode execution --model MODEL --effort low --json
```

`MODEL` 替换为目录中的真实 id，模型参数可以重复。`--implementation-model`、`--investigation-model` 设置其他工作方式独立且有序的候选池。选模只在当前组内进行，显式指定的模型也必须属于该组；整组不可用时返回原因，由主 agent 决定下一步，不跨组回退。在终端运行不带 `--cli` 的 `baton config` 可交互选择。

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

命令返回真实模型 id、显式指定且受支持的 effort（省略时不输出）、格式化 prompt、scope、`fork_context:false` 和 `spawned:false`。主 agent 将参数传给宿主原生子 agent API，使用新的上下文。此时 Baton 还没有启动 worker；原生句柄和完成状态始终由宿主管理。

## 批量准备与上下文预算

多个任务使用相同宿主和选模参数时，把 1–128 份 brief 保存为 JSON 数组：

```text
baton spawn --host codex --briefs briefs.json --work-mode implementation --json
```

返回 `{ "handoffs": [...] }`。先校验全部 brief，再用一次目录发现和一次选模服务整批任务；每份 handoff 保留各自目标、范围和验收标准。`--brief` 与 `--briefs` 互斥。批量准备不会启动 worker 或决定并发，主 agent 按宿主实际容量调用原生 API。

`--brief-budget-chars N` 设置建议的 prompt 总量预算，默认 12000 个 Unicode 码点。只有超预算时才返回 `brief_diagnostics`，指出总体积和最大的内容字段。不会截断内容，也不会把字符数转换成 token。它与调用者通过 `--context-tokens` 指定的模型容量要求互相独立。

上下文优先传已确认决策、精确文件或符号入口和验收标准；接续任务只传已有修改、已做检查和剩余问题。生成的 brief 要求简短汇报状态、结论、修改位置、验证证据和阻塞，完整日志留在引用文件中。变更、失败或集成需要时再重做检查，避免重复验证未变化的工作。

按整次任务的主 agent、worker、重试和集成总成本评估效率。用实际验收结果校准各模型池顺序；信息不足时补充上下文，能力不足时再由主 agent 升级并传增量 handoff。参见[效果测量](efficiency-measurement.md)。

## 记录结果

```text
baton record --host codex --handle HANDLE --model MODEL --status completed --text "已审查的结果"
baton status --host codex --json
```

结果记录可选，追加到 `~/.baton/results.jsonl`。status 仅返回当前宿主和工作目录最近二十条记录，不表示实时运行状态。必要时使用 `blocked`、`failed`；升级模型时把已有修改、检查和缺口写进下一份 handoff。

## 安装与不兼容变更

源码安装运行 `python3 scripts/update_local_baton.py`，它会测试、构建、链接并刷新 skill。`baton update` 刷新已安装文件。`baton uninstall --clean --dry-run` 预览清理；移除 `--dry-run` 后删除 Baton 配置、结果和拥有的集成文件。被修改的集成文件会保留并报告冲突。包管理器的命令链接需要单独卸载。

配置 schema 4 删除 `coding_models` 和 `--coding-model`，改为直接配置需要的各组模型。已有的模式列表会保留；旧总池不会复制到任何模式。保存配置时写入 schema 4 并移除旧字段，原先只配置总池的用户需要显式配置各组模型。

V2 删除 managed dispatch、apply、activation、ticket、Receipt、session、队列和 Git 审计；配置不再包含 runner、longctx 和 director 容量字段，不保留第二套兼容运行时。旧 managed 版本的测量不能作为 v2 性能证据。

adapter 提供当前宿主的模型目录和 runtime skill，不承担跨 CLI 执行。参见 [manifest 示例](../samples/manifest-example/) 和 [隔离 walkthrough](../samples/getting-started/)。
