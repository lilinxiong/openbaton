# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

指挥棒。多模型协作的 director：一个入口对话，按 card 分派原生 spawn，主上下文洁癖。

既能独立，又能 1+1>2 — 单独可用；有 OpenSpec 时严格更好。

```
npm i -g baton   # or: node bin/baton.js
baton init
```

## 为什么需要 OpenBaton

能够 spawn 不同模型，只是有了执行原语。真实工作还需要决定每个 task 应该交给哪条准确 route、worker 被允许做什么、超过 host 并发上限时如何排队，以及怎样只把主 agent 真正需要的证据带回前台。

OpenBaton 把每个 execution unit 变成可路由、可审计的 ticket。主 agent director 按 task 从显式 card 和当前可执行的 OpenCodex routes 中选择。不同 worker 可以并行承担分析、实施或 review，但始终保持 depth 1，不形成递归 agent 树，也不成为第二个前台对话。

目标不只是“开更多 agent”，而是在一个对结果负责的 workflow 中，安全、可解释、无静默 fallback 地使用多个模型。

## 它是什么

不是又一个 coding CLI。而是一套 skill pack + `init`，坐在你已经在用的 host 前面（Claude Code、Cursor、Grok、Codex、…）。

- **只认 card。** 每个模型是 `id` + strengths。CLI 按任务选人。没有 subagent 默认值。不继承父模型当默认。匹配不上就拦住。
- **host 原生 worker。** 进程内 spawn。不要 shell 出去跑 `claude -p` / `cursor-agent -p` / `grok -p`。Grok / Codex 的 init 装到 `~/.grok` 和 `~/.codex`，不写进项目；card 在 `~/.baton`。
- **逻辑上无限 spawn。** host 有硬上限就排队。永不拒绝。深度 1。
- **洁癖。** Worker 只回一句短结论。工具倾倒不进主会话。

## OpenSpec

有 OpenSpec 时，它负责拆解和状态。baton 负责谁跑每个任务，并把结论写回去。

没有 OpenSpec 时，`baton spawn` 照样能用。

不重做 OpenSpec。

## OpenCodex

OpenCodex 以 git submodule 放在 `opencodex/`。Claude / Codex / Grok 的模型接入归它。baton 只调度（card、match、director），不重做宿主接入。

```
git clone --recurse-submodules https://github.com/lilinxiong/openbaton.git
```

账号登录交给 OpenCodex 消费，不重做 — 和 OpenSpec 一样。用浏览器登录即可：

```
baton login kimi      # Moonshot Kimi
baton login cursor    # Cursor（实验性 PKCE）
baton login grok      # xAI Grok 账号
```

不要粘贴 base URL 或 API key。不要粘贴 Cursor 密钥。

既能独立，又能 1+1>2 — baton 负责分派；账号由 OpenCodex 持有。

## 能力缓存

Artificial Analysis 是可选、可替换的能力数据源。只在显式刷新时通过安全的临时 key 文件访问远端；普通调度只读项目内、被 Git 忽略的 SQLite snapshot。

```
baton capabilities refresh --provider aa --key-file /private/tmp/openbaton-aa-api-key
baton capabilities status
baton capabilities show gpt-5.6-luna --profile high
```

不做模糊模型匹配。没有精确 canonical mapping 的 route 保持 `unranked`：不阻塞使用，也不编造分数。详见 [Artificial Analysis 能力缓存](docs/data-sources/artificial-analysis.md)。

## 命令

```
baton init [--force] [--tools claude,cursor,grok,codex,agents]
baton login kimi
baton capabilities status
baton capabilities show MODEL [--profile PROFILE]
baton routes refresh
baton routes status
baton routes candidates
baton conversation promote --from-file PATH
baton cards
baton cards add --id opus --strengths "hard reasoning, long refactors" --route MODEL
baton match "fix the flaky auth tests"
baton spawn "explore why CI is red"
baton spawn "edit one file" --model k3 --write-path src/file.ts --write-ops write
baton apply
baton dispatch next --host codex --capacity 6 --json
baton dispatch bind TICKET --agent-id ID --host codex --json
baton dispatch complete TICKET --text "short outcome" --json
baton status
```

English: [README.md](README.md).

## License

MIT
