# Expected incident-audit answers

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
