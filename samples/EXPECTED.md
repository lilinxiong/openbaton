# Expected incident-audit answers

## Baton routing acceptance

- Automatic model routing is triggered from the ordinary request without Baton-specific wording.
- Each ordinary business request creates one proposal containing all of its units and immediately approves its deterministic recommendations; no selector or user confirmation is involved.
- Every delegated unit selects only from the invoking CLI's enabled `subagent_models`, using catalog-reported reasoning effort or service tier when available.
- Every ticket records `confirmed_by=baton-recommendation`, uses its unit's recommended model, and records `changed_by_user=false`.
- Missing benchmark data, a zero score, or a score tie is resolved deterministically instead of opening a manual-choice flow.
- Configured models are not removed by hard-coded family bans whenever the invoking CLI returns them and the user enables them.

- Total incidents: `6`.
- Severity counts: `sev1=2`, `sev2=2`, `sev3=2`.
- Status counts: `resolved=3`, `open=3`.
- Acknowledgement SLA breaches: `INC-103`, `INC-105`, `INC-106`.
- Resolution SLA breaches: `INC-101`, `INC-103`.
- Recommended unresolved priority: `INC-103` first, `INC-105` second, `INC-106` third.
- Duplicate service/owner pairs:
  - `payments/team-alpha`: `INC-101`, `INC-103`
  - `auth/team-beta`: `INC-102`, `INC-105`
  - `search/team-gamma`: `INC-104`, `INC-106`
- Data-quality result: no malformed records; timestamps, required fields, severities, and statuses are valid.
