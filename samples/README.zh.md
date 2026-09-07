# 样例

请先看[入门样例](getting-started/README.zh.md)。walkthrough 使用仓库内 fake adapter 和隔离临时 HOME，依次运行 `init`、`config`、`models`、`match`、`spawn`、`record`、`status`；不会启动真实 worker，也不会调用付费模型。

`manifest-example/` 展示公开 adapter manifest、目录命令、原生 handle 类型和 runtime skill。它是确定性的 fixture，不是真实 CLI 集成。`spawn` 只输出 `spawned: false` 的 native handoff，由宿主负责执行。

详见 [EXPECTED.md](EXPECTED.md)。
