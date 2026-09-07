# Baton

[English](README.md) | **中文**

[![npm version](https://img.shields.io/npm/v/%40zhouliuya%2Fopenbaton)](https://www.npmjs.com/package/@zhouliuya/openbaton)
[![CI](https://github.com/lilinxiong/openbaton/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/lilinxiong/openbaton/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Baton 帮助你的编程 agent 选择模型、准备聚焦的任务，并通过当前宿主的原生子 agent 委派工作。

## 为什么使用 Baton？

- **精简上下文**：给 worker 提供包含范围、已定结论和验收条件的简短任务说明，减少整段对话的重复传递。
- **批量准备**：多个独立任务共享一次模型目录查询，同时保留各自的模型选择和约束。
- **增量接续**：同一任务的后续反馈复用已有原生 worker，只发送变化内容。
- **用量可见**：通过 `observe` 汇总宿主报告的观察记录，查看 token 用量和完成情况。实际节省取决于任务、所选模型和宿主提供的上下文。

## 安装

需要 Node.js **22.5+**，以及支持原生子 agent 执行的宿主。目前捆绑支持 **Codex** 和 **Grok**。

```bash
npm install -g @zhouliuya/openbaton@latest
baton --version
```

### 升级

```bash
npm install -g @zhouliuya/openbaton@latest
baton update
baton --version
```

`baton update` 刷新 Baton 管理的 skill 和捆绑适配器文件，保留已配置的模型池。它本身不会升级 npm 包。

正式版本通过 GitHub Actions 自动发布到 npm，并附带构建来源证明。参见 [npm 包](https://www.npmjs.com/package/@zhouliuya/openbaton)和[发布工作流](https://github.com/lilinxiong/openbaton/actions/workflows/publish.yml)。

## 快速开始

以 Codex 为例，先初始化 Baton 并查看可用模型：

```bash
baton init --cli codex
baton models --host codex
```

从目录中选择真实模型 ID，配置实现任务的模型池：

```bash
baton config --cli codex --implementation-model MODEL_ID --enable
```

将 `MODEL_ID` 替换为选中的 ID。按需使用 `--execution-model` 配置执行既定步骤的模型，用 `--investigation-model` 配置调查未决问题的模型。每种工作方式有独立且有序的模型池，选择不会跨组回退。在终端运行不带 `--cli` 的 `baton config` 可交互选择。

然后在 Codex 对话中显式调用，例如：

```text
$baton 按已确定的方案实现 src/parser.ts 的输入校验。
保持公共 API 不变，并验证异常输入的处理。
```

将任务和文件路径换成你自己项目中的内容。宿主会准备限定范围的任务说明、启动原生 worker 并检查结果。使用 Grok 时，配置中的参数换成 `--cli grok` 和 `--host grok`，在对话中用 `/baton` 调用。

## 工作方式

Baton 选择精确的模型路由并输出结构化 handoff，由当前宿主通过原生子 agent API 执行。`baton spawn` 只准备 handoff，返回 `spawned: false`，自身不会启动 worker。

安装的 skill 仅在显式调用时启用。小任务交给一个 worker，独立任务可通过 `spawn --briefs FILE` 一起准备。宿主决定并发度并协调重叠写入；任务范围是提示词约定，不是文件系统沙箱。

主 agent 通过 `--effort` 为任务选择推理强度，省略时保留宿主默认值。`status` 展示已记录的结果，不代表 worker 的实时状态；`observe --file FILE --json` 汇总宿主报告的用量。

## 文档

- [使用指南](docs/guide.zh.md)：工作方式、任务说明、批量选模和观察记录。
- [入门 walkthrough](samples/getting-started/README.zh.md)：隔离运行的模拟适配器示例。
- [适配器约定](samples/manifest-example/)：接入其他宿主。

## 本地开发

在源码目录中，安装 Bun 后运行：

```bash
bun install --frozen-lockfile
bun run test
bun run baton -- --help
bun samples/getting-started/walkthrough.mjs
```

walkthrough 在临时 HOME 中运行 `init`、`config`、`models`、`match`、`spawn`、`record` 和 `status`，不会执行付费模型调用。

## 许可证

[MIT](LICENSE)
