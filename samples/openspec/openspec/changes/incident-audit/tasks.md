## 1. Concrete evidence

These four lanes share the frozen JSON inputs and MUST run in parallel. None waits for another task's conclusion.

- [ ] 1.1 Verify and report incident counts by severity and current status from incidents.json, including exact totals and supporting incident IDs
- [ ] 1.2 Verify and report acknowledgement and resolution SLA breaches at cutoff_at using policy.json, including incident IDs and minute calculations
- [ ] 1.3 Verify and report duplicate service/owner combinations and their incident IDs
- [ ] 1.4 Verify and report required fields, enum values, nullable fields, and timestamp ordering, including every anomaly or explicitly none

## 2. Deliberative analysis

This lane reads the same frozen JSON and MUST start with the four evidence lanes. It does not wait for their conclusions. The parent conversation synthesizes at the end.

- [ ] 2.1 Analyze unresolved incidents and recommend a response priority with evidence and trade-offs; send compact checkpoint state when the phase changes
