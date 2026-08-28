# Manifest 样例验收

[English](EXPECTED.md) | **中文**

- 发现只读取 `manifest-example/adapter.json`。
- manifest 通过 schema `1` 校验，并使用 SDK 版本 `1.0`。
- 目录响应包含匹配的 `adapter_id`、一个版本，以及精确的 `models` 数组。
- 配置只为所选软件包写入 `[cli.sample-adapter]`。
- 已配置的 `coding_models` 顺序会保留给自动选择使用。
- ticket 包含 `session_id`、`session_uid`、`session_ordinal`、
  `ticket_id`、所选模型/选项、不可变 Receipt 和 reservation。
- 原生执行返回不透明 handle，并立即绑定，随后用于 activity、
  terminal recording 和 release。
- 容量背压保留同一 reservation 和模型。
- 明确的配额耗尽只有在写入 baseline 干净时，才能创建新的不可变
  successor ticket。successor 拥有新的 session ordinal、
  `successor_from_ticket_id`、新 Receipt，以及相同的 session、host、
  scope 和配额 lineage。
- 样例中不出现真实服务凭证或内置目录条目。

