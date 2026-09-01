# Rolling 隔离 worktree 样例

请在一个 clean Git repository 根目录执行，并先配置一个声明
`native.exact_execution_root=true` 的 adapter。

```bash
export BATON_SESSION_ID="rolling-sample"
baton models refresh --host codex
baton run start --host codex \
  --source-file samples/rolling-worktree/source.json \
  --plan-delta-file samples/rolling-worktree/delta.json \
  --run-id rolling-sample --dispatch --json
baton run rolling-sample --status --json
```

delta 故意省略 `worktree_mode`：Baton 会在写入 unit 上持久化
`isolated-worktree`，只准备选中的 frontier，并返回 exact-root ticket。native worker
bind、complete、release 后，使用 status 中的 identity 冻结并集成 audited result：

```text
baton run rolling-sample --freeze-unit sample-write --attempt attempt-1 --text "样例结果已审计" --validation "样例验证通过" --json
baton integration begin --run rolling-sample --repository-id <sha256> --bundle-id <bundle> --expected-before-tree <tree> --json
baton integration apply --run rolling-sample --repository-id <sha256> --bundle-id <bundle> --json
baton integration accept --run rolling-sample --repository-id <sha256> --bundle-id <bundle> --conclusion "接受样例结果" --json
baton run rolling-sample --cleanup-unit sample-write --attempt attempt-1 --json
```

如果 `apply` 返回 conflicts，parent 在授权 integration boundary 中创建 resolved Git
tree，通过 `integration resolve` 提交后再 `accept`；不要让 worker merge 或解冲突。
