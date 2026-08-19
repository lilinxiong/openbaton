# Artificial Analysis data source

OpenBaton can build a local, untracked capability cache from the Artificial Analysis Data API.

- Source: [Artificial Analysis](https://artificialanalysis.ai/)
- API documentation: [Artificial Analysis Data API](https://artificialanalysis.ai/data-api/docs)
- Default endpoint: `https://artificialanalysis.ai/api/v2/language/models/free`

Artificial Analysis data is not committed to this repository. The generated SQLite database and manifest live under `.baton/cache/capabilities/`, which is ignored by Git. Users must supply their own API key and comply with the Artificial Analysis terms, attribution requirements, tier limits, and redistribution rules.

The committed `route-mappings.json` contains only explicit OpenBaton route-to-canonical-model mapping decisions. Missing or uncertain mappings remain `unranked`; OpenBaton does not fuzzy-match model names or invent benchmark scores.
