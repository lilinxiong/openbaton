# Artificial Analysis capability cache

OpenBaton uses Artificial Analysis as a replaceable `CapabilityProvider`. The ordinary dispatch path never calls the remote API: it reads a user-global SQLite snapshot from `~/.baton/cache/capabilities/artificial-analysis.sqlite3`.

The capability commands require a Node.js runtime that provides `node:sqlite` (Node 22.5 or newer). Other Baton commands retain the package's existing Node compatibility.

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

Mappings are exact and profile-aware. A route returns `unranked` when:

- there is no explicit canonical mapping;
- the mapped AA slug is absent from the local snapshot; or
- the mapped AA model has no numeric ranked metric.

OpenBaton does not fuzzy-match route names and never treats `unranked` as a weak score. The route remains available; the main agent can still consider provider health, quota, context, latency, price, and user policy.

## Dynamic Cards

Baton joins the OpenCodex live route snapshot with these exact mappings at runtime. Ranked route/profile pairs expose structured intelligence, coding, agentic, cost, throughput, and latency evidence plus percentile-derived positioning tags. The positioning text is explicitly an inference; it is not copied back into `~/.baton/config.toml`. Unmapped routes remain visible and explicitly selectable as `unranked`, but automatic task matching cannot select them.

## Snapshot behavior

- All API pages are fetched before replacing the current database.
- The database is written to a temporary file and atomically renamed.
- An existing last-known-good snapshot survives fetch, parse, schema, or write failure.
- Repeated rows with the same canonical identity keep the first page's values and increment `duplicateRecords`.
- Conflicting identity for the same slug fails closed.
- The manifest records tier, AA Index version, fetch time, endpoint, model count, duplicate count, mapping count, and SHA-256 checksum.
