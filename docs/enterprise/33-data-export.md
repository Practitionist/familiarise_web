# Org-wide data export (DPDP §11)

Familiarise honours DPDP §11 right-to-access at the organization level
via an async export job. OWNER + BILLING_ADMIN can request a JSON
bundle of every entity scoped to their org; the worker builds the
bundle, uploads it to Supabase Storage, and emails the requester with
a 7-day signed-URL link.

## Lifecycle

```
            [Dashboard]                  [Worker]
                |                            |
   POST /data-exports                        |
                |--→ insert OrgDataExportJob |
                |    status = PENDING        |
                |    audit DATA_EXPORT_REQUESTED
                |                            |
                |       cron tick (every 10 min)
                |                       ←----
                |    findFirst PENDING       |
                |    flip → PROCESSING       |
                |    build bundle            |
                |    upload to Supabase      |
                |    sign 7d URL             |
                |    flip → READY            |
                |    audit DATA_EXPORT_GENERATED
                |    email requester via Resend
                |                            |
   GET /data-exports/[id]/download           |
                |--→ verify status + expiry  |
                |    audit DATA_EXPORT_DOWNLOADED
                |    return { url, expiresAt }
```

## Bundle shape

Flat JSON, schemaVersion `1`. Top-level keys:

```json
{
  "organizationId": "org_xxx",
  "generatedAt": "2026-05-15T10:00:00.000Z",
  "schemaVersion": 1,
  "organization": { ... },
  "members": [ { id, name, email } ],
  "memberships": [ ... ],
  "contracts": [ ... ],
  "programs": [ ... ],
  "invoices": [ ... ],
  "earnings": [ ... ],
  "payouts": [ ... ],
  "auditLog": [ ... ]
}
```

The audit log included reflects the platform-wide retention policy
(7y for INVOICE / PAYOUT / WALLET / CONTRACT / CONSENT; 2y for
everything else). Older rows have already been pruned by the
`prune-audit-logs` cron and are NOT recoverable through this export.

## Rate limit

`orgDataExportLimiter` — 1 export per organization per 24 hours.
The bundle build is O(N × 8 entities); we don't want a single tenant
running 24 exports a day even if their compliance pipeline allows it.

## Audit trail

Every state transition writes an `OrgAuditLog` row under SYSTEM:

- `DATA_EXPORT_REQUESTED` — at job creation, actor is the requester.
- `DATA_EXPORT_GENERATED` — worker success.
- `DATA_EXPORT_FAILED` — worker error path (carries the message).
- `DATA_EXPORT_DOWNLOADED` — each `GET /download` call.

## Local development

When `NEXT_PUBLIC_SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is not
set, the worker writes the bundle to `/tmp/familiarise-data-exports/`
and returns a `file://` URL. The download route refuses to serve
non-http URLs, so the end-to-end happy path requires the Supabase
env vars to be configured even locally.

## Verification

```bash
# As OWNER or BILLING_ADMIN
curl -X POST $BASE/api/organizations/$ORG/data-exports \
  -H "Cookie: $OWNER_COOKIE"
# {"export":{"id":"...","status":"PENDING"}}

# Trigger the worker manually (≤10 min cron otherwise)
curl -X POST $BASE/api/cleanup/process-data-exports \
  -H "Authorization: Bearer $CRON_SECRET"

# Poll until READY
curl $BASE/api/organizations/$ORG/data-exports -H "Cookie: $OWNER_COOKIE"

# Pull download link
curl $BASE/api/organizations/$ORG/data-exports/$EXPORT_ID/download \
  -H "Cookie: $OWNER_COOKIE"
# {"url":"https://...signed-url","expiresAt":"..."}
```
