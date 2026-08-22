# Artificial Analysis capability cache

OpenBaton uses Artificial Analysis as a replaceable `CapabilityProvider`. The ordinary dispatch path never calls the remote API: it reads a user-global SQLite snapshot from `~/.baton/cache/capabilities/artificial-analysis.sqlite3`.

The capability commands use `node:sqlite` on Node.js 22.5 or newer and `bun:sqlite` on Bun 1.3.14 or newer.

## Data and attribution

- Source: [Artificial Analysis](https://artificialanalysis.ai/)
- API: [Artificial Analysis Data API](https://artificialanalysis.ai/data-api/docs)
- Free endpoint: `https://artificialanalysis.ai/api/v2/language/models/free`

The downloaded data and generated manifest are local-only under the user's home. They must not be committed or redistributed from this public repository. The repository commits only the schema, importer, attribution, and explicit route mapping decisions.

## Refresh

Create a temporary key file outside the repository:

```bash
umask 077
read -s AA_API_KEY
printf '%s' "$AA_API_KEY" > /private/tmp/openbaton-aa-api-key
unset AA_API_KEY
```

Refresh the local snapshot:

```bash
baton capabilities refresh \
  --provider aa \
  --key-file /private/tmp/openbaton-aa-api-key
```

The key is read once. It is not copied into the database, manifest, logs, route mappings, or Git-tracked files. Remove the temporary key file after the refresh.

## Query

```bash
baton capabilities status
baton capabilities show gpt-5.6-luna --profile high
baton capabilities show kimi/k3 --profile max --json
```

Capability identity is provider-neutral: the selected CLI keeps the exact
execution model id, while AA lookup uses the catalog-declared underlying
`model` id. This does not change dispatch, health, or callability identity.

Lookup first applies an explicit profile-aware exception mapping, then a
deterministic exact AA-slug normalization such as
`mimo-v2.5-pro -> mimo-v2-5-pro`. It never performs fuzzy or similarity matching.

When exact evidence is absent, Baton may disclose two deterministic fallbacks:

- a missing profile may use the same route's base-profile AA row;
- a serving variant ending in `-fast` or `-highspeed` may use the suffix-free base model's same-profile row, then its base-profile row.

Fallback evidence is marked `reference_only` with its source route/profile and
reason. It refines automatic ordering but never expands the selected CLI's
model or reasoning-effort surface.

If an exact AA row exists without aggregate ranking metrics, Baton exposes the
available numeric evaluation, pricing, performance, and cost fields as partial
`reference_only` data. Its task score remains `unranked`; Baton never derives or
invents a missing aggregate score.

A route/profile has no ranked or reference score when:

- neither an explicit mapping nor an exact normalized AA slug exists;
- the mapped AA slug and deterministic fallback rows are absent from the local snapshot.

OpenBaton does not fuzzy-match route names and never turns missing metrics into
zero. A picker-visible model remains eligible when it is in the active CLI's
configured subagent allowlist; CLI descriptions and route health can still
drive automatic matching.

## Dynamic Cards

Baton joins the selected CLI catalog snapshot with these mappings at runtime.
Exact ranked model/effort pairs expose structured intelligence, coding,
agentic, cost, throughput, and latency evidence plus percentile-derived
positioning tags. The positioning text is explicitly an inference; it is not
copied back into `~/.baton/config.toml`. Reference-only and unranked evidence
remain usable for configured models; AA never decides catalog visibility.

## Snapshot behavior

- All API pages are fetched before replacing the current database.
- The database is written to a temporary file and atomically renamed.
- An existing last-known-good snapshot survives fetch, parse, schema, or write failure.
- Repeated rows with the same canonical identity keep the first page's values and increment `duplicateRecords`.
- Conflicting identity for the same slug fails closed.
- The manifest records tier, AA Index version, fetch time, endpoint, model count, duplicate count, mapping count, and SHA-256 checksum.
