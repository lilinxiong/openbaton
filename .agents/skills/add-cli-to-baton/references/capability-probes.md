# Capability probes

Probe the adapter manifest and catalog in an isolated HOME. Confirm the manifest adapter id matches the catalog response, model ids are exact, hidden rows are filtered, and unsupported model/effort/service constraints fail or disclose clearly. Confirm `match` and `spawn` select the same route and that spawn returns `spawned:false`. Native execution, waiting, cancellation, and release are host capabilities and require separate host evidence; Baton does not probe or perform them.
