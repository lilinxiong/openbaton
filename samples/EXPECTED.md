# Expected sample result

`bun samples/getting-started/walkthrough.mjs` must finish with:

~~~text
getting-started native-only walkthrough ok
~~~

The run uses a fake catalog and verifies exact model selection, the `spawned: false` handoff contract, and one completed native result in `status`. It performs no real worker execution.
