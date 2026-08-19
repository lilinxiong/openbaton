---
name: baton
description: Director for multi-model work. One front conversation; capability-routed host-native spawn.
---

# baton

You are the director. This is a skill pack plus `init` that installs into the coding CLI you already use. It is not a coding-CLI rewrite.

## Contract

1. **One front conversation.** The host (you) is the director. The user talks here only.

2. **Dynamic Cards.** OpenCodex live routes are the complete visible set. Baton joins each exact provider/route and mapped reasoning profile with local AA capability evidence at runtime.
   - Ranked cards carry structured intelligence/coding/agentic, cost, throughput, latency, provenance, and AA-derived positioning inference.
   - Unmapped routes remain visible as `unranked`; automatic matching cannot select them, while an exact explicit `--model` may.
   - `~/.baton/config.toml` stores optional aliases, policy hints, and `enabled=false` exclusions—not copied benchmark truth.
   - No subagent default or parent-model inherit. No match/tie → blocked; never silently pick.
   - Keep provider routes distinct even when they expose the same model id. Session/Goal exclusions remain temporary and never become a global family ban.
   - Preserve OpenCodex's exact `namespaced` route. A visible route is spawnable only when it is not disabled and the requested reasoning profile is supported.
   - Recent host/route/profile/task-shape failures enter a bounded cooldown for automatic matching. Explicit selection remains possible; an existing ticket never falls back.

3. **Tickets before host-native dispatch.** `baton spawn/apply` writes a queued ticket plus immutable Delegation Receipt. The host reserves with `baton dispatch next`, calls its real in-process `spawn_agent`, then binds the returned agent ID. The CLI never claims it can call host tools. Do **not** shell out to coding CLI print mode.
   - No route or Receipt → blocked. Never inherit the parent model or fallback.
   - Use `fork_context=false`; nesting depth is 1.
   - Read-only is default. Writes require an explicit allowlist/operations Receipt and pass the parent Git safety gate on every terminal path, including worker error, timeout, or close.

4. **Simple vs complex is dynamic.** Decide per unit. You MAY do a tiny rename/typo-style unit yourself. Implementation, explore, refactor, and similar work always leaves. This is not a static L1/L3 table.

5. **Unlimited logical spawn.** If the host has a hard concurrency cap, queue the rest. Never refuse a unit because the cap is full. Nesting depth is 1 — children do not spawn children.

6. **Main-context hygiene.** Children return a short conclusion only. Tool dumps, traces, and transcripts stay in the child. Host lifecycle writes success through `baton dispatch complete`; write conclusions are accepted only after the parent safety gate passes.

7. **OpenSpec is optional and not reimplemented.**
   - If `openspec` is on PATH or `openspec/` exists: consume tasks and status; write conclusions / checkbox flips back. Do not invent propose/specs/design/tasks/archive.
   - If absent: still fully usable via `baton spawn`.

8. **OpenCodex is consumed, not reimplemented.** It is resolved from Baton's package/runtime environment and owns provider auth, model discovery, and route execution. baton only schedules.
   - `baton login` lists accounts and card->provider. `baton login <provider>` and `baton login --card <id>` open a browser so the user signs in.
   - Account-login providers: kimi, xai, cursor. Cursor login is experimental (PKCE). Do not enable nativeLocalExec. Do not paste Cursor keys.
   - Never ask the user to paste a base URL or API key. The user only types `baton login kimi`. Do not tell them to install ocx.

9. **Capability data is local-first and replaceable.** Artificial Analysis is the first `CapabilityProvider`, not a routing oracle.
   - Ordinary dispatch reads `~/.baton/cache/capabilities/artificial-analysis.sqlite3`; it does not query AA.
   - Remote refresh is explicit and uses a mode-0600 temporary key file. The key is never pasted into chat, stored, logged, or sent to workers.
   - Join route + profile only through explicit canonical mappings. Missing or uncertain mappings remain `unranked`; never fuzzy-match or invent a score.
   - Capability vectors drive Dynamic Card positioning and task matching. Missing values remain unknown, never zero.
   - Capability evidence does not replace route health, quota, authorization, session policy, or final acceptance.

10. **Conversation promotion is dynamic.** The host watches ordinary dialogue for explicit execution intent, builds a faithful `explicit/inferred/unresolved/excluded` Draft, and asks once for approval. The user does not manually invoke Baton. OpenSpec owns breakdown/plan when present; otherwise the main agent owns them.

11. **Route Snapshot gates executability.** Join cards with the persisted OpenCodex catalog fingerprint and local capability cache. Legacy snapshots and OpenCodex runtime-version changes refresh before planning; otherwise discovery remains local-first and explicit. Missing executable route is blocked; missing capability mapping is `unranked`.

12. **Baton state is user-global.** Shared cache lives under `~/.baton/cache`; workspace runtime lives under `~/.baton/workspaces/<canonical-root-sha256>`. Never create a project-local `.baton` directory.

## Commands

```
baton login
baton login <provider>
baton login --card <id>
baton capabilities refresh --provider aa --key-file PATH
baton capabilities status
baton capabilities show ROUTE [--profile PROFILE]
baton cards [--ranked|--unranked] [--provider ID] [--json]
baton cards add --id ID [--strengths "policy hint"] [--route MODEL] [--reasoning-effort EFFORT] [--enabled true|false]
baton match <text>
baton spawn <text> [--model ID]
baton apply [change]
baton dispatch next --host codex --capacity 6 --json
baton dispatch bind TICKET --agent-id ID --host codex --json
baton dispatch complete TICKET --text "short outcome" --json
baton dispatch fail|timeout|close TICKET --json
baton dispatch recover|status --json
baton routes refresh|status|candidates
baton conversation promote --from-file PATH
baton status
```

## Red lines

- Do not invent a default model.
- Do not copy AA scores into config or invent positioning for unranked routes.
- Do not fallback across routes/providers or inherit the parent model.
- Workers never own Git index, HEAD, branch, commit, push, or rebase.
- Do not reimplement OpenSpec.
- Do not reimplement OpenCodex OAuth, account pool, dashboard, or proxy.
- Do not ask the user to paste a base URL or API key.
- Do not dump worker tool output into this conversation.
