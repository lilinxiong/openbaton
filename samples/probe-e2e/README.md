# Baton probe E2E

**English** | [中文](README.zh.md)

This disposable fixture exercises both Baton standalone multi-unit dispatch
and the OpenSpec apply path in one session.

Before creating any ticket, show the target CLI's live picker-visible routes
and let the user choose exactly one. Persist that route as all three profile
fields in one operation:

```text
baton config --cli <target> --runner <model> --longctx <model> --coding-model <model> --json
```

Create the workspace and paste-ready prompt document from the OpenBaton source
checkout:

```text
bun samples/bootstrap-probe.mjs --host <target> --model <model> --output <prompt-file>
```

Paste Prompt 1 and then Prompt 2 into the same target-CLI main conversation.
After both complete, use the workspace path printed in the prompt document:

```text
bun samples/verify-probe.mjs --host <target> --model <model> <workspace>
```

Prompt 1 creates two independent files through Baton:

- `standalone/alpha.js`
- `standalone/beta.js`

The standalone request is kept in `STANDALONE_REQUEST.txt`.

Prompt 2 invokes `$baton $openspec-apply-change probe-e2e` and dispatches
OpenSpec tasks `1.1` and `1.2` in parallel, followed by integration task `2.1`.
The OpenSpec request is kept in `OPENSPEC_REQUEST.txt`. Bootstrap injects the
same absolute workspace, host, model, and session identity into both requests.
The fixture starts without generated source files; workers create them.
