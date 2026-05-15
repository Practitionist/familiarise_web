# 6-org-scope-and-activity — Appointment / Waitlist / Recording org FK

> **Required reading:** [`_shared/shared-setup.md`](../_shared/shared-setup.md),
> [`_shared/mcp-recipes.md`](../_shared/mcp-recipes.md),
> [`_shared/case-template.md`](../_shared/case-template.md).
> Apply the **fix-and-retest gate** when any case fails.

**Surface(s) under test:**
- `lib/payments/operations/checkout.ts:resolveEventHostOrgId` — webinar/class lookup
- `lib/payments/operations/checkout.ts` lines 2619/2644/2701/2723 — waitlist creates (4 sites: webinar tx-rollback, class tx-rollback, webinar outer-catch, class outer-catch)
- `lib/stream/recording-handlers.ts` lines 279/420 — recording success + failure handlers
- `prisma/schema.prisma model Appointment` — `organizationId` FK (already shipped in earlier Round)
- `prisma/schema.prisma model Waitlist` — `organizationId` FK
- `prisma/schema.prisma model Recording` — `organizationId` FK

**Round-3 invariant — see shared-setup §4:** "Waitlist/Recording orgId — Both `Waitlist.organizationId` and `Recording.organizationId` populated at write time from event-host org / parent appointment. Null FK only for personal (non-org) plans."

**Case roster:**
1. **O.1** — WEBINAR overbook (capacity-full) → `Waitlist.organizationId` matches plan host
2. **O.2** — CLASS overbook → `Waitlist.organizationId` matches plan host
3. **O.3** — Personal-plan waitlist → `organizationId IS NULL` (no crash)
4. **O.4** — Recording success webhook → `Recording.organizationId` matches parent appointment
5. **O.5** — Recording failure webhook → `Recording.organizationId` still stamped (FAILED row)
6. **O.6** — Org-scoped dashboard query returns the new rows

---

## Common preconditions

Use the seed cohort. Pick `learnpro-academy` (HOST, has webinar + class
plans seeded). Login as `founder@learnpro.test`.

Capture:
```sql
SELECT id FROM "organizations" WHERE slug = 'learnpro-academy';
-- <learnpro-id>

SELECT w.id, w."webinarPlanId", wp."organizationId"
FROM "Webinar" w
JOIN "WebinarPlan" wp ON wp.id = w."webinarPlanId"
WHERE wp."organizationId" = '<learnpro-id>'
LIMIT 1;
-- <webinarId>, <webinarPlanId>

SELECT c.id, c."classPlanId", cp."organizationId"
FROM "Class" c
JOIN "ClassPlan" cp ON cp.id = c."classPlanId"
WHERE cp."organizationId" = '<learnpro-id>'
LIMIT 1;
-- <classId>, <classPlanId>
```

For cases O.1 and O.2, fill the webinar/class to capacity first. The
easiest path is direct DB INSERT of `SlotOfAppointment` rows up to
`maxSeats`. Use the existing seed-data pattern.

---

## Case O.1: WEBINAR overbook → Waitlist.organizationId stamped

### Preconditions
Webinar from preconditions, filled to capacity (`maxSeats` reached).

Capture a consultee user that is NOT already in the webinar:
```sql
SELECT id FROM users WHERE email = 'consultee-test@familiarise.test' LIMIT 1;
-- if not exists, spawn one via Chrome signup or direct INSERT
```

### Steps
Login as that consultee. Navigate to the webinar's checkout page.
Trigger the booking flow (Razorpay or credit-based, doesn't matter —
the path that hits `prisma.waitlist.create` is the tx-rollback path or
the outer-catch path; both fire on `"Webinar is full"`).

Easier path: call `handleWebinarCheckout` via the API directly:
```js
() => fetch("/api/checkout", {
  method: "POST", credentials: "include",
  headers: {"Content-Type": "application/json"},
  body: JSON.stringify({
    appointmentType: "WEBINAR",
    eventId: "<webinarId>",
    planId: "<webinarPlanId>",
    paymentGateway: "RAZORPAY"
  })
}).then(async r => ({ status: r.status, body: await r.json() }))
```

Expected: 400/409 with body message including `"Added to waitlist"`.

### Assertions
```sql
SELECT id, "userId", "webinarId", "organizationId", "createdAt"
FROM "Waitlist"
WHERE "webinarId" = '<webinarId>'
ORDER BY "createdAt" DESC LIMIT 1;
```
Expected:
- `userId` matches the consultee logged in
- `webinarId === <webinarId>`
- `organizationId === <learnpro-id>` (from `webinarPlan.organizationId`)

**Regression signal:** if `organizationId IS NULL` for an org-owned
webinar, `resolveEventHostOrgId` is returning null. TRIVIAL fix
(probably a join issue in the helper). ASK before changing because the
file is in the checkout hot path.

### Cleanup
```sql
DELETE FROM "Waitlist"
WHERE "webinarId" = '<webinarId>' AND "userId" = '<consultee-id>';
```

---

## Case O.2: CLASS overbook → Waitlist.organizationId stamped

Same shape as O.1 with `classId` substituted. Use a different consultee
to avoid the duplicate-waitlist-entry guard.

### Assertions
```sql
SELECT "organizationId" FROM "Waitlist"
WHERE "classId" = '<classId>' ORDER BY "createdAt" DESC LIMIT 1;
-- Expected: <learnpro-id>
```

---

## Case O.3: Personal-plan waitlist → null orgId

### Preconditions
Pick a webinar whose plan has `organizationId IS NULL` (a personal
consultant-owned plan, not Rahul's solo-org one — Rahul's plan has
`organizationId` set to his solo org). The seed file
`prisma/seedFiles/15a-create-organizations.ts` and similar pure-marketplace
seeds (e.g. `13a-create-webinars.ts` if present) carry personal plans.

```sql
SELECT w.id, w."webinarPlanId", wp."organizationId"
FROM "Webinar" w
JOIN "WebinarPlan" wp ON wp.id = w."webinarPlanId"
WHERE wp."organizationId" IS NULL
LIMIT 1;
-- <personal-webinarId>
```

If no such row, spawn a fresh personal plan via Supabase MCP (consultant
seeds plan with `organizationId = NULL`).

Fill the personal webinar to capacity. Overbook.

### Assertions
```sql
SELECT "organizationId" FROM "Waitlist"
WHERE "webinarId" = '<personal-webinarId>' ORDER BY "createdAt" DESC LIMIT 1;
-- Expected: NULL
```

The dashboard org-scoped query (`SELECT * FROM "Waitlist" WHERE
"organizationId" = '<orgId>'`) must continue to return no row for this
breach. Verify no 500 surfaces on `/dashboard/organization/<learnpro-id>/waitlist`:
```js
() => fetch("/api/organizations/<learnpro-id>/waitlist", { credentials: "include" })
  .then(async r => ({ status: r.status, body: await r.json() }))
// status === 200, body does NOT contain this waitlist row.
```

---

## Case O.4: Recording success → Recording.organizationId stamped

### Preconditions
A meeting session exists for an org-context appointment. Easiest path:
walk the seed's webinar to completion + add a meeting session manually,
OR pick any existing `MeetingSession` whose `slotOfAppointment ->
appointment ->organizationId` is non-null.

```sql
SELECT ms.id, ms."streamCallId", soa."appointmentId", a."organizationId"
FROM "MeetingSession" ms
JOIN "SlotOfAppointment" soa ON soa.id = ms."slotOfAppointmentId"
JOIN "Appointment" a ON a.id = soa."appointmentId"
WHERE a."organizationId" IS NOT NULL
LIMIT 1;
-- <meetingSessionId>, <streamCallId>, <appointmentOrgId>
```

### Steps
Simulate the recording-ready webhook. The simplest is calling the
handler directly via a server-action route, OR forging the Stream
webhook payload via curl. Use the latter:

```bash
curl -X POST http://localhost:3000/api/webhooks/stream \
  -H "Content-Type: application/json" \
  -H "X-API-KEY: $STREAM_API_KEY" \
  -d '{
    "type": "call.recording_ready",
    "call_cid": "default:<streamCallId>",
    "call_recording": {
      "filename": "test-recording-O4",
      "url": "https://example.com/test.mp4",
      "start_time": "2026-05-15T10:00:00Z",
      "end_time": "2026-05-15T11:00:00Z"
    }
  }'
```

(Adjust webhook payload shape if `lib/stream/recording-handlers.ts`
parses it differently.)

### Assertions
```sql
SELECT id, "organizationId", "streamRecordingId", status
FROM "Recording"
WHERE "streamRecordingId" = 'test-recording-O4';
-- Expected: 1 row, organizationId === <appointmentOrgId>, status='READY'
```

---

## Case O.5: Recording failure → Recording.organizationId still stamped

Forge a `call.recording_failed` payload for the same meeting session.

### Assertions
```sql
SELECT "organizationId", status FROM "Recording"
WHERE "meetingSessionId" = '<meetingSessionId>'
ORDER BY "createdAt" DESC LIMIT 1;
-- Expected: organizationId === <appointmentOrgId>, status='FAILED'
```

**Regression signal:** if a FAILED row has `organizationId IS NULL`,
the failure handler isn't reading from the appointment join. TRIVIAL
fix to `recording-handlers.ts:420`. ASK before changing (recording
handler is webhook-facing).

---

## Case O.6: Org-scoped dashboard surfaces these rows

```js
() => fetch("/api/organizations/<learnpro-id>/waitlist", { credentials: "include" })
  .then(async r => ({ status: r.status, body: await r.json() }))
// Expected: 200, body.data contains the O.1 + O.2 waitlist rows
```

```js
() => fetch("/api/organizations/<learnpro-id>/recordings", { credentials: "include" })
  .then(async r => ({ status: r.status, body: await r.json() }))
// Expected: 200, body.data contains O.4 + O.5 recordings
```

These confirm the FK isn't just written — it's reachable via the
org-scoped query path.

---

## Cross-case cleanup

```sql
DELETE FROM "Waitlist" WHERE "createdAt" > NOW() - INTERVAL '15 minutes'
  AND ("webinarId" = '<webinarId>' OR "classId" = '<classId>' OR "webinarId" = '<personal-webinarId>');

DELETE FROM "Recording" WHERE "streamRecordingId" = 'test-recording-O4';

-- Restore webinar/class capacity if you filled them via direct INSERT
DELETE FROM "SlotOfAppointment" WHERE "createdAt" > NOW() - INTERVAL '15 minutes'
  AND "appointmentId" IN (
    SELECT a.id FROM "Appointment" a
    WHERE a."webinarId" IN ('<webinarId>', '<personal-webinarId>')
       OR a."classId" = '<classId>'
  );
```

Adjust the cleanup queries to match your spawn patterns. If in doubt,
prefer the spawn-fresh-org approach over mutating seed-cohort
webinars/classes — the seed is meant to be stable.
