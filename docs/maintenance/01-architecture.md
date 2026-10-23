# Maintenance mode architecture

Postgres `MaintenanceWindow` is the authoritative platform state; `organizationId: null` distinguishes platform windows from tenant windows. Upstash `maintenance:phase` and `maintenance:config` are the edge projection. Active keys do not expire: an ETA is a message to users, never authorization to reopen the application. Server reads query the authoritative window, so database read failures propagate rather than masquerading as OFF.

## Control path

The ADMIN maintenance page calls `/api/admin/maintenance`. POST requires an explicit DEGRADED/OFFLINE phase and a reason of 5–1,000 characters. PATCH requires a reason and can change phase or ETA. DELETE requires a recovery reason and runs recovery before publishing OFF. Empty mutation bodies are rejected. Controls share a fail-closed `maintenance-control` Postgres lease; overlapping changes return 409. Platform-row changes and their `OpsActionLog` audit commit together under a transaction advisory lock.

Starting OFFLINE drains active Stream calls, freezes group channels and pauses discount codes. It **does not cancel bookings**. Repeated activation preserves the first discount snapshot and the existing bypass secret. Completed offline setup is recorded on the window; partially completed setup can be retried. Better Stack create/resolve requests have a three-second timeout. An absent key or vendor failure does not become an indefinite control request.

State publishing writes config before phase. A Redis publishing failure is an unsuccessful control request; the database row remains available for operator inspection and retry. Edge readers cache confirmed state, but mark stale fallback state unreadable after a failed refresh. Unreadable state denies non-exempt mutation requests; cron entry guards also refuse unreadable state. Authentication, webhooks and maintenance control retain their explicit exemptions. A missing phase is not proof that maintenance is OFF.

## Explicit booking remediation

The separate ADMIN booking-remediation panel requires a start, end and reason. The server previews at most 20 distinct overlapping bookings in an interval no longer than 24 hours. A signed five-minute token binds the selected IDs, window, interval and actor. Confirmation requires the server-generated `CANCEL N BOOKINGS` text and a fresh ADMIN session. The server stores the request, its per-booking items and the audit row in one transaction; repeated confirmation of the same cohort returns the same durable request.

`maintenance-booking-remediation` runs one booking per fifteen-minute slice under its own fail-closed cron lease. It is a financial job, held in DEGRADED/OFFLINE; requests can be queued during maintenance and execute after recovery. Failed items retain their error and attempt count and rotate behind unattempted items. One booking every fifteen minutes gives four scheduled attempts per hour; a twenty-booking request can require five hours without additional authorized manual slices, before any refund relay/gateway delay. Inspect item age and pending count; a successful slice does not establish that the request finished.

The worker retains the existing whole-booking cancellation/refund policy. An overlapping recurring booking may affect sessions outside the selected interval; the panel states this before confirmation. Cancellation uses the domain CAS transitions. Refund-owed markers, trial tombstones, notification outboxes and subscription extension commit with the booking transaction. The canonical refund retry and notification relays deliver these obligations after commit. A crash before an item completion mark replays the domain CAS safely and does not extend a subscription twice.

## Recovery and deployment

OFFLINE setup caps each request at 200 active meetings and 200 channel operations, with a twelve-second work budget and three-second vendor transport deadlines. Remaining calls or channel work prevent `offlineActivatedAt` from being set. Retry Offline Setup continues the bounded work. Each meeting is linked to the exact `maintenanceWindowId` before ending its vendor call, so later Stream webhooks cannot erase the maintenance obligation. `maintenanceChannelFrozenAt` records acknowledged freezes. Recovery selects every linked group meeting lacking `maintenanceChannelRecoveredAt`, including a freeze whose acknowledgement write was lost, then clears the freeze stamp and records recovery only after Stream acknowledges unfreeze. Partial batches remain observable and retryable.

A transport timeout leaves the remote outcome uncertain. OFFLINE cannot downgrade or end until Retry Offline Setup has acknowledged all pending setup work. Retry recovery after a vendor failure and inspect Stream before reopening; a local lease cannot cancel work already accepted by a vendor.

DELETE checks database and Redis health, restores valid snapshotted discounts and unfreezes channels. Any reported failure leaves maintenance active for another attempt. It does not launch a parallel unbounded reconciliation fleet. Run bounded jobs through System Jobs or their authenticated cleanup routes and inspect their execution history.

The reviewed [schema rollout SQL](./maintenance-remediation-schema.sql) adds maintenance setup/vendor fields, the meeting window identity and channel acknowledgement stamps and durable remediation tables to Prisma. Deploy the reviewed schema change through the approved database procedure before deploying code that reads these fields. `prisma generate` only updates the local client; it does not apply the schema. Never run schema push or sidecar apply as a test against the shared database.

## Bounded booking remediation capacity

The automatic whole-booking cancellation path currently supports at most eight live participants, twelve non-tentative undeleted occurrences, ten payment rows and ten notification recipients per booking. These conservative execution guards are not offering-plan limits or measured throughput guarantees. Preview, confirmation and worker execution recheck capacity; the worker reads its bounded payment/participant/occurrence graph inside the same Serializable transaction that stages cancellation obligations, so a stale preflight graph is never reused; cap-plus-one reads reject growth instead of truncating refund or notification obligations.

Larger bookings remain unsupported by this maintenance action and require a separately reviewed cancellation procedure. No ready large-roster procedure is implied. An oversized queued booking remains pending with a visible error while other items can rotate; it must not be marked completed, partially cancelled or silently dropped. Verify supported-size execution against the deployed runtime before using this action operationally.

## Deprecated & Superseded Approaches

OFFLINE previously cancelled overlapping bookings implicitly and guessed a four-hour horizon when no ETA was supplied. Explicit preview and durable confirmation replace that coupling. ETA-based Redis expiry previously reopened an unattended maintenance window; active state now requires explicit recovery. Recovery previously launched six reconciliation jobs in parallel inside the request; scheduled bounded jobs own those obligations instead.
