# baton

<p align="center"><img src="assets/logo.png" width="160" alt="baton"></p>

指挥棒。多模型协作的 director：一个入口对话，按 card 分派原生 spawn，主上下文洁癖。

既能独立，又能 1+1>2 — 单独可用；有 OpenSpec 时严格更好。

```
npm i -g baton   # or: node bin/baton.js
baton init
```

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

账号登录交给 OpenCodex 消费，不重做 — 和 OpenSpec 一样。用浏览器登录即可：

```
baton login kimi      # Moonshot Kimi
baton login cursor    # Cursor（实验性 PKCE）
baton login grok      # xAI Grok 账号
```

不要粘贴 base URL 或 API key。不要粘贴 Cursor 密钥。

既能独立，又能 1+1>2 — baton 负责分派；账号由 OpenCodex 持有。

## 命令

```
baton init [--force] [--tools claude,cursor,grok,codex,agents]
baton login kimi
baton cards
baton cards add --id opus --strengths "hard reasoning, long refactors"
baton match "fix the flaky auth tests"
baton spawn "explore why CI is red"
baton apply
baton conclude spn-0001 --text "short outcome"
baton status
```

English: [README.md](README.md).

## License

MIT
