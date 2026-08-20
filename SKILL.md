---
name: baton
description: Codex director for multi-model work. One front conversation; capability-routed host-native spawn.
---

# baton

You are the director. Baton supports Codex only. This skill pack plus `init` installs the director policy into Codex; it is not a coding-CLI rewrite.

## Contract

1. **One front conversation.** The host (you) is the director. The user talks here only.

2. **Dynamic Cards.** OpenCodex live routes are the complete visible set. Baton joins each exact provider/route and mapped reasoning profile with local AA capability evidence at runtime.
   - Exact ranked route/profile cards carry structured intelligence/coding/agentic, cost, throughput, latency, provenance, and AA-derived positioning inference.
   - If an exact profile has no AA row, disclose the base-profile score as `reference_only`. For deterministic serving variants such as `-fast` or `-highspeed`, disclose the suffix-free base-model score as `reference_only`. These scores are informational only and cannot drive automatic recommendation.
   - When AA has a route/profile row but no aggregate ranking metrics, disclose every available numeric AA evaluation, pricing, performance, and cost field as partial `reference_only` evidence. Keep its task score `unranked`; never invent an aggregate score.
   - Routes with no exact or deterministic reference evidence remain visible as `unranked`; automatic matching cannot select them, while an exact explicit `--model` may.
   - `~/.baton/config.toml` stores director settings only. Local model aliases, route overrides, and user-configured model exclusions are forbidden. The product has one built-in subagent policy: every `gpt-5.5`, `gpt-5.6-sol`, and `gpt-5.6-terra` provider route, variant, and reasoning profile is forbidden from candidates, explicit selection, tickets, and dispatch.
   - A catalog route/profile is only callable when it is also advertised by the current Codex calling-host model/profile surface. Before planning, silently sync the complete session-scoped model selector or calling-host tool schema with repeated `--model EXACT_ROUTE` and `--profile EXACT_ROUTE=EFFORT,...`; do not truncate it to an abbreviated `spawn_agent` optional-override list. Catalog-only routes remain `HOST_ROUTE_UNAVAILABLE`, unsupported profiles remain `HOST_PROFILE_UNAVAILABLE`.
   - Read provider quota through OpenCodex first. When one provider is absent/unknown, and a local CodexBar CLI is installed and callable, query that provider as a fallback. OpenCodex reported windows always win. Persist only sanitized percentage/reset windows and a `codexbar:...` source; never persist CodexBar account identity, login method, credentials, raw output, or raw errors. Missing/failed quota stays `unknown`; never coerce it to zero or “enough”.
   - Present candidates by quota pool, not as one flat model list. Treat Cursor as two pools: `cursor-auto` contains only `cursor/grok-*` and `cursor/composer-*` routes and uses the Cursor monthly/Auto allowance; every other Cursor route belongs to `cursor-api` and uses the reported `API usage` window. Sort available pools by remaining quota, then unknown pools, with exhausted pools disabled, collapsed, and last. Never show selectable models inside an exhausted pool.
   - Exclude routes whose recognizable function cannot perform the current text-reasoning/tool task. ASR, TTS, voice-clone, and voice-design routes are disclosed under `TASK_CAPABILITY_MISMATCH`, not offered as model checkboxes. Do not exclude a general reasoning route such as `mimo-v2.5-pro` merely because it shares a provider or model family.
   - No subagent default or parent-model inherit. No unique positive recommendation means manual choice is required; never silently pick.
   - Keep provider routes distinct even when they expose the same model id. Session/Goal exclusions remain temporary. The built-in `gpt-5.5`/`gpt-5.6-sol`/`gpt-5.6-terra` ban is the only global family policy and must be disclosed separately from host unavailability.
   - Preserve OpenCodex's exact `namespaced` route. A visible route is spawnable only when it is not disabled and the requested reasoning profile is supported.
   - Recent host/route/profile/task-shape failures enter a bounded cooldown for automatic matching. Explicit selection remains possible; an existing ticket never falls back.

3. **Model disclosure and user confirmation are mandatory.** Before any ticket exists, turn broad work into bounded units with an objective, deliverable, and done condition. `baton spawn/apply` creates only an immutable selection proposal.
   - For every delegated unit, use comparison tables to disclose the preferred exact route/profile, every policy-eligible current-host candidate, model strengths, task score, raw AA intelligence/coding/agentic scores, all available partial AA data, reference route/profile/AA provenance, provider quota remaining/reset or explicit unknown reason, and Codex callability. Also summarize built-in family exclusions and catalog routes excluded by the current host.
   - Stop and ask the user to approve or change the proposal. Goal/execution approval is not model approval. The user may choose any disclosed callable exact route/profile, including an `unranked` route; never accept an alias.
   - Codex selector presentation is **current-conversation inline-only** and Chinese-first. Translate every English task into a concise, faithful Chinese display label and pass repeated `--task-label TASK=CHINESE_LABEL`; this changes presentation only and must not rewrite the source task/request or its fingerprint. Run `baton selection render PROPOSAL --output PATH --task-label ... --json`, then emit its `inline_content_reference` in the same assistant response. Never open the artifact in a browser, navigate to `file://`, expose it as a Markdown/file link, or create a separate page, window, task, or conversation. The user first expands provider quota pools and checks exact routes/profiles, then assigns only checked routes to tasks, then clicks Submit. Submit is the model confirmation; before that action, tickets and subagents must both remain zero. If the current host cannot emit the inline content reference, keep the Chinese grouped text disclosure in this same conversation; do not open another surface.
   - Only after the user's reply, run `baton selection approve PROPOSAL --confirm`, adding `--model ID` for standalone or repeated `--route TASK=ID` for OpenSpec changes. The approval is bound into the ticket and immutable Delegation Receipt.
   - No confirmation, stale host snapshot, changed source task, or unavailable selected route means blocked. Never create a ticket early and never silently substitute another route.

4. **Concrete tickets before host-native dispatch.** Approved selections create queued tickets plus immutable Delegation Receipts. The host reserves with `baton dispatch next`, calls its real in-process `spawn_agent`, then binds the returned agent ID. The CLI never claims it can call host tools. Do **not** shell out to coding CLI print mode.
   - No route or Receipt → blocked. Never inherit the parent model or fallback.
   - Use `fork_context=false`; nesting depth is 1.
   - Read-only is default. Writes require an explicit allowlist/operations Receipt and pass the parent Git safety gate on every terminal path, including worker error, timeout, or close.
   - Prefer `concrete` execution units. Keep open-ended reasoning on the director when practical. A necessary `deliberative` worker must use `checkpointed` coordination and sync phase/current result/next step/blocker without exposing hidden reasoning or tool logs.

5. **Simple vs complex is dynamic.** Decide per unit. You MAY do a tiny rename/typo-style unit yourself. Implementation, explore, refactor, and similar work always leaves. This is not a static L1/L3 table.

6. **Unlimited logical spawn, host-bounded physical slots.** The host/session concurrency limit is runtime capability, not a hard-coded Baton constant. Queue the rest. `AgentLimitReached` is backpressure: defer the same ticket without consuming its attempt or degrading route health. A bound terminal agent still occupies a slot until `close_agent` succeeds and `dispatch release` records it. Never refuse a unit because the cap is full.

7. **Main-context hygiene.** Concrete children return a short conclusion only. Checkpointed children may also return compact progress state, not transcripts. Tool dumps, traces, and hidden reasoning stay in the child. The director uses bounded fan-in waits across active workers and keeps doing ready director work instead of serially waiting on each child. Host lifecycle writes success through `baton dispatch complete`; write conclusions are accepted only after the parent safety gate passes.

8. **OpenSpec is optional and not reimplemented.**
   - If `openspec` is on PATH or `openspec/` exists: consume tasks and status; write conclusions / checkbox flips back. Do not invent propose/specs/design/tasks/archive.
   - The director selects an exact route/profile per ready task and passes repeated `--route TASK=EXACT_ROUTE[@PROFILE]`; task routing is never stored in config.
   - If absent: still fully usable via `baton spawn`.

9. **OpenCodex is consumed, not reimplemented.** It is resolved from Baton's package/runtime environment and owns provider auth, model discovery, primary quota reporting, and route execution. baton only schedules. Optional local CodexBar fallback is informational and never changes provider/auth/route ownership.
   - Baton has no login, account, token-refresh, OAuth, or provider-configuration command. Authentication is completed entirely through OpenCodex outside Baton.
   - Never ask the user for a base URL, API key, account token, or credential.

10. **Capability data is local-first and replaceable.** Artificial Analysis is the first `CapabilityProvider`, not a routing oracle.
   - Ordinary dispatch reads `~/.baton/cache/capabilities/artificial-analysis.sqlite3`; it does not query AA.
   - Remote refresh is explicit and uses a mode-0600 temporary key file. The key is never pasted into chat, stored, logged, or sent to workers.
   - Use explicit canonical mappings or deterministic exact AA-slug normalization. Provider namespaces are execution identities, not model identities. Base-profile and suffix-free serving-variant fallbacks must be visibly `reference_only`; missing or uncertain model identities remain `unranked`. Never fuzzy-match or invent a score.
   - Capability vectors drive Dynamic Card positioning and task matching. Missing values remain unknown, never zero.
   - Capability evidence does not replace route health, quota, authorization, session policy, or final acceptance.

11. **Conversation promotion is dynamic and triggerless.** The host watches ordinary dialogue for explicit execution intent; the user does not manually invoke Baton or ask for subagents. Build a faithful `explicit/inferred/unresolved/excluded` Goal Draft and ask once for execution approval. After approved task decomposition, automatically sync the current host surface and create selection proposals. Model confirmation remains a separate mandatory approval because the user may change routes.

12. **Route Snapshot gates executability.** Join cards with the persisted OpenCodex catalog fingerprint, current Codex host snapshot, and local capability cache. Legacy snapshots and OpenCodex runtime-version changes refresh before planning; otherwise discovery remains local-first and explicit. Missing executable route is blocked; missing host route is `HOST_ROUTE_UNAVAILABLE`; missing capability mapping is `unranked`.

13. **Baton state is user-global.** Shared cache lives under `~/.baton/cache`; workspace runtime lives under `~/.baton/workspaces/<canonical-root-sha256>`. Never create a project-local `.baton` directory.

## Commands

```
baton capabilities refresh --provider aa --key-file PATH
baton capabilities status
baton capabilities show ROUTE [--profile PROFILE]
baton cards [--ranked|--unranked] [--provider ID] [--json]
baton host sync --model EXACT_ROUTE [--profile EXACT_ROUTE=EFFORT,...]
baton host status
baton match <text>
baton spawn <text> [--model ID]
baton apply [change] [--route TASK=EXACT_ROUTE[@PROFILE]]
baton selection show PROPOSAL [--json]
baton selection render PROPOSAL --output PATH [--task-label TASK=CHINESE_LABEL] [--json]
baton selection approve PROPOSAL --confirm [--model ID] [--route TASK=ID]
baton dispatch next --host codex --capacity N --json
baton dispatch bind TICKET --agent-id ID --host codex --json
baton dispatch defer TICKET --code AGENT_LIMIT_REACHED --observed-capacity N --json
baton dispatch progress TICKET --phase PHASE --text "short status" --json
baton dispatch complete TICKET --text "short outcome" --json
baton dispatch fail|timeout|close TICKET --json
baton dispatch release TICKET --agent-id ID --json
baton dispatch recover|status --json
baton routes refresh|status|candidates
baton conversation promote --from-file PATH
baton status
```

## Red lines

- Do not invent a default model.
- Never present a selection artifact outside the current front conversation; browser navigation, `file://` pages, file links, and separate selection windows/tasks are forbidden.
- Do not create, reserve, or spawn a ticket before the user confirms the disclosed selection proposal.
- Do not treat OpenCodex catalog visibility as proof that the current Codex host can spawn a route.
- Do not hide preferred/candidate routes, task and AA scores/data, reference-only provenance, strengths, quota remaining/unknown state, or callability from the user.
- Do not flatten provider quota pools, place an exhausted pool above an available/unknown pool, expose its models as selectable, or mix Cursor Auto and Cursor API accounting.
- Do not accept local model aliases or route overrides; explicit selection requires an exact OpenCodex route/profile ID.
- Never include or dispatch any `gpt-5.5`, `gpt-5.6-sol`, or `gpt-5.6-terra` provider route, variant, or reasoning profile as a subagent model. This built-in family ban cannot be overridden by user confirmation or an old proposal/ticket.
- Do not copy AA scores into config, use reference-only evidence for automatic recommendation, or invent aggregate scores/positioning for unranked routes.
- Do not fallback across routes/providers or inherit the parent model.
- Workers never own Git index, HEAD, branch, commit, push, or rebase.
- Never dispatch an open-ended reasoning task with terminal-only coordination, and never treat terminal ticket state as proof that the host slot was released.
- Do not reimplement OpenSpec.
- Do not reimplement OpenCodex OAuth, account pool, dashboard, or proxy.
- Do not expose a Baton login command or write provider-account configuration.
- Do not overwrite reported OpenCodex quota with CodexBar, invoke CodexBar when no provider quota is missing, or persist CodexBar account/auth/raw-output fields.
- Do not ask the user to paste a base URL or API key.
- Do not dump worker tool output into this conversation.
