# SystemEvent — engineering-facing operational events

Familiarise keeps **two** event streams, not one. This separation
prevents engineering noise (Prisma stack traces, internal IDs, raw
worker errors) from leaking into the org-visible audit log.

| Table | Audience | Content |
|---|---|---|
| `OrgAuditLog` | Org members (MAINTAINER+ readable) | Clean human prose: "PO WZ-2026-0042 created (INR 500,000)" |
| `SystemEvent` | Platform admins only | Raw engineering payload: stack frames, Prisma error syntax, HTTP responses |

Both can record the **same incident** — a failed data-export job
writes a clean prose row to `OrgAuditLog` ("Data export bundle failed
— engineering notified") and a raw stack-trace row to `SystemEvent`,
linked via `correlationId = exportJob.id`.

## Why a separate table

The platform shipped pre-MVP with a single audit log. An org owner
opening their dashboard saw audit rows like:

> "Data export bundle failed: Invalid \`prisma.organization.findUnique()\` invocation: { where: { id: '…', ? AND?: ProgramWhereInput | ProgramWhereInput\[\], ? type?: EnumProgramTypeFilter | ProgramType, … }"

This is **information disclosure**. Any org owner — including a
future hostile tenant — could enumerate our internal schema by
provoking errors. Three layers of defense:

1. **Write-side discipline** — failure paths write a clean prose
   description to `OrgAuditLog` and the raw error to `SystemEvent`.
2. **Read-side scrub** — `lib/enterprise/audit-sanitize.ts` strips
   known engineering-noise patterns from `OrgAuditLog.description`
   before the row reaches a client. Catches legacy rows and any
   regression at a new call site.
3. **Channel separation** — `SystemEvent` is admin-only by design.
   No org-scoped API route reads from it.

See [`audit-sanitize.ts`](../../lib/enterprise/audit-sanitize.ts) for
the redaction patterns. See
[`system-events.ts`](../../lib/enterprise/system-events.ts) for the
write helpers.

## Schema

```prisma
model SystemEvent {
  id             String              @id @default(uuid())
  organizationId String?             // nullable — platform-wide events
  category       String              // DATA_EXPORT | HRIS_SYNC | …
  severity       SystemEventSeverity @default(INFO)
  message        String              @db.Text
  context        Json?
  correlationId  String?
  createdAt      DateTime            @default(now())

  @@index([organizationId, createdAt])
  @@index([category, createdAt])
  @@index([severity, createdAt])
  @@index([correlationId])
}

enum SystemEventSeverity { INFO  WARN  ERROR }
```

### Field semantics

- **`organizationId`** — most events are tenant-scoped (job failed
  for org X); some are platform-wide (cron tick, deploy marker) and
  leave this `null`. FK on delete is `SetNull` because we want the
  event history to outlive a deleted org for incident post-mortems.

- **`category`** — free-form string matching the worker family.
  Conventional values: `DATA_EXPORT`, `HRIS_SYNC`, `WEBHOOK`,
  `PAYOUT`, `CRON`, `RECONCILE`. New workers add new values without
  a migration.

- **`severity`** — three-level enum. `INFO` = routine breadcrumb,
  `WARN` = recoverable issue worth flagging, `ERROR` = job failed,
  engineering should investigate.

- **`message`** — raw engineering string. Safe to interpolate
  `err.message`, Prisma error text, HTTP status codes, internal IDs.
  Never shown to org users.

- **`context`** — free-form JSON payload. By convention `recordSystemError`
  fills it with `{ errorMessage, stack, ...callerContext }`.

- **`correlationId`** — groups events for one invocation. Typically
  the parent job ID (e.g. `OrgDataExportJob.id`). Query
  `SystemEvent WHERE correlationId = 'abc' ORDER BY createdAt` to
  reconstruct one job's lifecycle.

## Writing events

Two helpers in `lib/enterprise/system-events.ts`:

```ts
import { recordSystemEvent, recordSystemError } from "@/lib/enterprise/system-events";

// Routine: a normal lifecycle breadcrumb
await recordSystemEvent({
  organizationId: orgId,
  category: "CRON",
  severity: "INFO",
  message: "Weekly payout batch started",
  correlationId: batchId,
});

// Error: an exception was caught
await recordSystemError({
  organizationId: orgId,
  category: "DATA_EXPORT",
  summary: "Data export bundle failed",  // ← prose summary
  err,                                    // ← raw exception
  context: { exportId: job.id },
  correlationId: job.id,
});
```

Both are **best-effort**: a failing `SystemEvent.create()` swallows
the error and logs to console. An outage of this table must not
cascade into the calling worker.

The companion org-visible audit row is written separately, in a
transaction adjacent to the system event:

```ts
await prisma.$transaction(async (tx) => {
  await tx.orgDataExportJob.update({ where: { id: job.id }, data: { status: "FAILED" } });
  await tx.orgAuditLog.create({
    data: {
      organizationId: job.organizationId,
      category: "SYSTEM",
      action: AUDIT_ACTIONS.SYSTEM.DATA_EXPORT_FAILED,
      // CLEAN prose only. Never interpolate err.message here.
      description: "Data export bundle could not be generated. Engineering notified.",
      details: { exportId: job.id },
    },
  });
});

// System event written outside the tx — non-blocking, captures the stack.
await recordSystemError({
  organizationId: job.organizationId,
  category: "DATA_EXPORT",
  summary: "Data export bundle failed",
  err,
  correlationId: job.id,
});
```

This pattern is the convention for every catch-and-record site.

## Reading events

### Platform admin API

```
GET /api/admin/system-events
```

Admin-only (`requireAdminAuth`). Query params:

- `severity` — `INFO` | `WARN` | `ERROR`
- `category` — exact match
- `organizationId` — scope to one tenant
- `correlationId` — pull all events for one job invocation
- `since` — ISO timestamp lower bound
- `limit` — page size (default 100, max 500)

Cursor pagination on `(createdAt DESC, id DESC)` using the covering
indexes.

### Future admin UI

Not yet shipped. The API surface is enough for engineering's current
needs (curl + Slack incident channel). A dashboard page would live at
`/dashboard/admin/system-events` and is tracked separately.

## Read-side scrub (defense in depth)

`lib/enterprise/audit-sanitize.ts` catches any case where engineering
noise still reaches `OrgAuditLog`. The sanitizer runs on:

- `GET /api/organizations/[orgId]/audit` (list endpoint)
- `GET /api/organizations/[orgId]/audit/export` (CSV exporter)

Five patterns flag a description as "engineering goop" and trigger a
redaction:

1. `Invalid \`prisma.*.findUnique()\` invocation` (Prisma error shape)
2. `ProgramWhereInput`, `LicensedSeatConfigNullableScalarRelationFilter`,
   etc. (Prisma schema enum names)
3. `at someFn (file.ts:42:13)` (Node stack frames)
4. `node:internal/...` paths
5. Long JSON blobs inline

When matched, the description is replaced with:

> `<safe prefix>: [redacted — engineering details available to platform admins only]`

The "safe prefix" preserves the user-meaningful header (e.g. "Data
export bundle failed:") when the prefix itself is clean prose, so the
OWNER still knows *what kind* of event happened.

`sanitizeAuditDetails()` likewise strips known sensitive keys
(`error`, `stack`, `prismaError`, `errorStack`, `rawError`) from the
`details` JSON payload at projection time.

The raw row stays in the DB — only the org-visible **projection** is
sanitized. Engineering can pull the original via direct SQL or the
admin API.

## Tests

`__tests__/enterprise/audit-sanitize.test.ts` (16 tests, 100% coverage)
covers every redaction pattern + idempotency + the prefix-preservation
behavior. Includes a regression test for the exact
`LicensedSeatConfigNullableScalarRelationFilter` string that
triggered the original bug report.

## Related

- [`04-organization-lifecycle.md`](./04-organization-lifecycle.md) — org status state machine
- [`32-data-export.md`](./32-data-export.md) — DPDP §11 worker that exercises both event streams
- `lib/enterprise/audit-actions.ts` — typed action catalogue for `OrgAuditLog`
- `lib/enterprise/audit-sanitize.ts` — read-side scrub
- `lib/enterprise/system-events.ts` — write helpers
