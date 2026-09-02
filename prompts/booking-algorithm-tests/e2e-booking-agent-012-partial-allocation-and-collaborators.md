# E2E Booking Algorithm Test — Agent 012: Partial Allocation & the Collaborator Guard

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Dev server:** already running (`npm run dev`)

> **Coverage marker:** both subjects are wave-5 work landing with **#1329**.
> `allowPartial`, the `SLOT_SHORTAGE` refusal carrying `placeableSessions`, and
> the co-host guard running in every allocation mode do not exist on plain
> `dev`; the schema field is stripped there and the guard is reachable from one
> route only. Run this case on a branch where #1329 is merged.

You are a senior QA engineer. Your job is to prove that a consultant who cannot
fit every session the plan sold is offered an honest choice rather than a dead
end, that the choice is theirs alone to make, and that no allocation mode can
book a time an accepted co-host is already busy for. Tools:

- **Supabase MCP** — direct SQL against PostgreSQL (project: `pzmbxqdgibfkhjwzeprf`)
- **Chrome DevTools MCP** — UI interaction and `fetch()` calls via `evaluate_script`

All test data uses the `-012` suffix.

---

## Critical Rules

1. **FIX BUGS IMMEDIATELY.** Stop, fix source code, retest the full phase.
2. Verify DB state after every action via `execute_sql`.
3. A partial allocation that silently places fewer sessions **without** the
   consultant asking for it is a failure, even if every placed session is valid.
   Default behaviour is refusal.
4. All times in SQL are UTC.

---

## Background

Every allocate route is `PATCH
/api/bookings/{consultations|subscriptions|webinars|classes}/[<type>Id]/allocate`
and derives its mode from the body, not the URL: `useRequestedSlots` wins, else
`isAuto`, else manual. `AllocationMode` is the union `"auto" | "manual" |
"requested"` (`utils/slotAllocation/types.ts`).

`allowPartial` is `z.boolean().optional().default(false)` in
`schemas/slotAllocation/validationSchemas.ts`. Each route honours it only as
`body.allowPartial === true && canOverride`, where `canOverride` is
`isEventConsultant` — the event's own consultant, or an ADMIN/STAFF caller. It
reaches only the `auto` path, and inside the service it applies only to
recurring event types and never on a reschedule: a consultation or webinar is
one session, so it either fits or it does not.

The co-host guard is `SlotAllocationService.assertCollaboratorsFree`, which
calls `assertCollaboratorsAvailableForWindows`
(`lib/collaborators/availability.ts`). It short-circuits for anything that is
not a webinar or class, considers only collaborators whose status is
`ACCEPTED`, and overlaps on a half-open interval against live, non-tentative,
non-tombstoned slots.

---

## Phase 0 — Data Seeding

Create with the `-012` suffix:

- Consultant A: `testconsultant012a@familiarise.com` / `TestPassword012!`,
  profile `test-consultant-profile-012a`, `scheduleType` `WEEKLY`, with
  **deliberately scarce** availability — Monday only, 09:00–11:00 UTC. Four
  atoms; that scarcity is the whole point.
- Consultant B (the co-host): `testconsultant012b@familiarise.com`, profile
  `test-consultant-profile-012b`, generous availability Mon–Fri 09:00–17:00 UTC.
- Consultee: `testconsultee012@familiarise.com` / `TestPassword012!`.
- Subscription plan `test-subscription-plan-012` owned by A, selling **6**
  sessions of 0.5 h over a 4-week scheduling period.
- Class plan `test-class-plan-012` owned by A, with Consultant B attached as a
  collaborator in status `ACCEPTED`.

Then, as the consultee, buy the subscription with `isMockPayment: true` so it
lands `APPROVED` awaiting allocation. Record `SUBSCRIPTION_ID`.

---

## Phase 1 — The default is refusal, and the refusal is actionable

As CONSULTANT A, auto-allocate without `allowPartial`:

```javascript
async () => {
  const response = await fetch(
    "/api/bookings/subscriptions/<SUBSCRIPTION_ID>/allocate",
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "agent-012-alloc-A",
      },
      body: JSON.stringify({ isAuto: true }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** **400** with `errorCode: "SLOT_SHORTAGE"`. The response must also
carry `placeableSessions` and `requiredSessions`, so the client can offer "place
N now, the rest later" rather than a bare failure. `requiredSessions` is 6;
`placeableSessions` is however many whole sessions the scarce availability can
hold. A refusal with no `placeableSessions` is a regression — without that
number the client can only say "not enough free slots".

The side-effect to check is that **nothing was written**:

```sql
SELECT COUNT(*) FROM "SlotOfAppointment" s
JOIN "Appointment" a ON a.id = s."appointmentId"
WHERE a."subscriptionId" = '<SUBSCRIPTION_ID>' AND s."deletedAt" IS NULL;
-- Expected: 0
```

## Phase 2 — `allowPartial: true` places what fits and says so

Repeat with the flag and a fresh idempotency key:

```javascript
async () => {
  const response = await fetch(
    "/api/bookings/subscriptions/<SUBSCRIPTION_ID>/allocate",
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "agent-012-alloc-B",
      },
      body: JSON.stringify({ isAuto: true, allowPartial: true }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** **200**, with `partial: true`, `requiredSessions: 6`,
`placedSessions` equal to Phase 1's `placeableSessions`, and
`unplacedSessions = requiredSessions - placedSessions`. Assert the arithmetic
holds against the database, not just against the response:

```sql
SELECT COUNT(DISTINCT a.id) AS appointments
FROM "Appointment" a
WHERE a."subscriptionId" = '<SUBSCRIPTION_ID>' AND a."deletedAt" IS NULL;
-- Expected: equals placedSessions.
```

`partial` is derived at read time from confirmed sessions versus the plan's
total and is **not** persisted — do not look for a `partial` column.

## Phase 3 — Only the consultant may choose a partial schedule

Sign in as the CONSULTEE and send the identical Phase 2 request against a fresh
subscription in the same shortage condition.

**Expected:** the flag is **ignored**, because the route computes
`body.allowPartial === true && canOverride` and the consultee is not the event's
consultant. The response is therefore the Phase 1 refusal — **400
`SLOT_SHORTAGE`**, not a 200 partial. A partial schedule is never chosen on the
consultee's behalf; it is offered only after the shortfall has been shown to the
person who can fix it.

## Phase 4 — `allowPartial` does not reach the non-recurring or non-auto paths

Three negative probes, each on a fresh event in a shortage condition:

1. A **consultation** (one session) with `{ isAuto: true, allowPartial: true }`.
   **Expected:** no partial success — a single session either fits or it does
   not, so the refusal stands.
2. A **manual** allocation with `{ isAuto: false, slots: [...], allowPartial: true }`
   where the slots cannot all be placed. **Expected:** the flag has no effect;
   only the `auto` path receives it.
3. A **reschedule** re-allocation with `allowPartial: true`. **Expected:** no
   partial; reschedule keeps replace semantics.

## Phase 5 — The consultee is told about the shortfall

After the successful Phase 2 partial allocation, assert the notification fired
for the **consultee only**:

Check the Novu workflow id `appointment-partially-scheduled`
(`lib/novu/workflows.ts`, triggered through `notifyAppointmentPartiallyScheduled`
in `lib/novu/service.ts`). Verify the recipient set is the consultee user ids
and does **not** include the consultant, who already saw and confirmed the
shortfall in the dialog. In a local run, assert on the trigger call rather than
on a delivered message.

## Phase 6 — The co-host guard runs in all three modes

Schedule a session for Consultant B (the co-host) at D+7 10:00–11:00 UTC by any
means, so B is genuinely busy then. Now try to allocate the class
`test-class-012` onto that same window three times, once per mode:

| Mode        | Body                                                 |
| ----------- | ---------------------------------------------------- |
| `auto`      | `{ "isAuto": true }` with availability forcing 10:00 |
| `manual`    | `{ "isAuto": false, "slots": ["<D+7T10:00Z>"] }`     |
| `requested` | `{ "isAuto": false, "useRequestedSlots": true }`     |

**Expected in every case:** **409** with
`errorCode: "COLLABORATOR_UNAVAILABLE"` and a message naming the clashing
co-host. The side-effect to check is that no slot was written for the class in
that window.

This is the regression the guard exists for: it used to be reachable from the
webinar `crud-with-plan` PATCH only, so a class scheduled through the allocator
could commit onto a time an accepted co-host was already busy for (AE-2, #784).

Then set the collaborator's status to something other than `ACCEPTED` and retry
the manual allocation.

**Expected:** **200** — only `ACCEPTED` collaborators constrain the calendar.

## Phase 7 — Overlap on class creation is a conflict, not a 500

Create a class through `POST /api/bookings/classes/crud-with-plan` whose
sessions overlap a time Consultant A already holds a confirmed slot for.

**Expected:** **409** with
`{ "error": "That time conflicts with another confirmed session on your calendar." }`.
Note the body carries **no** `errorCode` field on this route — assert on the
status and the message. A 500 here means the `slot_no_confirmed_overlap`
exclusion violation (SQLSTATE `23P01`) is escaping `isExclusionViolation`
instead of being classified.

---

## Verification Checklist (End-to-End)

| #   | Assertion                                            | Expected                                        |
| --- | ---------------------------------------------------- | ----------------------------------------------- |
| 1   | Auto allocate under shortage, no flag                | 400 `SLOT_SHORTAGE`                             |
| 2   | Refusal payload                                      | carries `placeableSessions`, `requiredSessions` |
| 3   | Rows written by the refusal                          | none                                            |
| 4   | Auto allocate with `allowPartial: true`              | 200, `partial: true`                            |
| 5   | `placedSessions + unplacedSessions`                  | equals `requiredSessions`                       |
| 6   | Appointments created                                 | equals `placedSessions`                         |
| 7   | Consultee sends `allowPartial: true`                 | ignored; 400 `SLOT_SHORTAGE`                    |
| 8   | `allowPartial` on consultation / manual / reschedule | no effect                                       |
| 9   | Novu `appointment-partially-scheduled`               | consultee only                                  |
| 10  | Co-host busy, auto / manual / requested              | 409 `COLLABORATOR_UNAVAILABLE` in all three     |
| 11  | Collaborator not `ACCEPTED`                          | allocation succeeds                             |
| 12  | Class create overlapping a confirmed slot            | 409, not 500                                    |

---

## Cleanup

Delete only the `-012` rows, newest first: slots, appointments, the class and
subscription, the collaborator link, the plans, the profiles and the users.
Leave every seed row untouched.
