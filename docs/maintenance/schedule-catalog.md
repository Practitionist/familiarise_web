# Shared operational schedule catalog

`lib/cron/schedule.ts` is the runtime source of truth for jobs driven by the five-minute ticker. It owns target names, cadence and offsets in UTC, calendar windows, batch limits and request timeouts. The Netlify adapter imports its dispatch helpers; callers import schedule data directly from the catalog.

`JOB_SCHEDULES` exposes effective values for monitoring and documentation. Each entry contains `name`, `everyMinutes`, `offsetMinutes`, `window`, `limit`, `timeoutMs` and `backgroundFunction`. A `null` window means the cadence applies all day; a `null` limit means the request deliberately omits that parameter. `scheduleFor(name)` returns the matching entry or `undefined`. These values describe dispatch timing, not the time required to complete a durable obligation.

`scheduledTargets(now)` applies cadence and calendar gates, and `capToTick(targets)` applies the twelve-target bound to the targets the ticker will dispatch (after idle probes skip jobs with no work; see the job machinery catalog). `dueTargets(now)` is the two combined, for the cadence test. `windowStartFor(name, now)` returns the UTC start of an active calendar window, including windows that cross midnight. `targetRequest(baseUrl, name, now)` derives the authenticated adapter's destination and bounds; it does not dispatch requests or read secrets. A dispatcher supplies authentication and the platform fleet gate separately.

Changing a cadence, batch size or timeout requires editing the catalog and verifying the 400-day cadence/collision test. A target can still exceed its execution envelope if its core ignores a limit or performs a long provider operation; catalog membership is not evidence that a job is safely bounded. Recording transfers, for example, need a long-running execution adapter rather than a shorter HTTP timeout.

Recording transfer now uses `backgroundFunction: "recording-transfer-background"` every 15 minutes, with no row-limit query; its HTTP timeout bounds admission only. The ticker accepts only 202 from that destination and records it in `accepted`, not `ok`. Its old Actions step is removed. The five Stream daily targets use `stream-maintenance-background?job=<slug>` in staggered daily windows; see the [Stream cadence table](../stream/09-background-sync.md#cadence-and-capacity). `reconcile-sessions` runs via HTTP at :10/:40. Their former Actions ownership is removed; the Netlify background destinations require Netlify as active cron host. Weekly and 400-day calendar tests retain the ten-target cap and membership/drift coverage. Other operational families retain their existing owners. No catalog entry verifies deployed effects. Migrate each family only after its core has bounded work and restart-safe progress, and remove its old automatic schedule in the same reviewed rollout. Dispatch acceptance and worker completion must remain separate health signals.

The catalog is dependency-free, allowing another active host to use the same definitions while the Netlify standby remains intact. Any future host still needs to supply its own authenticated dispatch and long-worker adapters.

Retry-email relay phases are :05/:20/:35/:50 and document purge is hourly
at :25. These phase shifts reserve one target at :00/:15/:30/:45 for the
maintenance-remediation train without changing either cadence. Weekly tests
pin the reservation, and calendar tests retain the twelve-target cap (the busiest tick holds 11).

## Deprecated & Superseded Approaches

The Netlify function previously held schedule maps and pure calendar helpers inline. Those definitions now live in the catalog, so tests and other hosts can consume them directly without loading a platform adapter. Existing cadences and request bounds are unchanged.
