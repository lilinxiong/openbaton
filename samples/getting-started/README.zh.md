# 入门

在仓库根目录运行：

~~~bash
bun samples/getting-started/walkthrough.mjs
~~~

脚本创建临时 HOME，发现 `manifest-example`，配置 `sample-model`，匹配 implementation 工作，输出 brief handoff，记录一个 fake completed native handle，并检查 status。不会创建 ticket、执行 managed dispatch、启动真实 worker 或调用付费模型。最后应输出：`getting-started native-only walkthrough ok`。
