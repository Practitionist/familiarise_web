# E2E Booking Algorithm Test — Agent 007: Reschedule-Proposal Response Loop

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Dev server:** already running (`npm run dev`)

> **Coverage marker:** this case covers the reschedule-proposal **response loop**
> (propose → counterparty accepts/declines → state assertions), whose response
> endpoints land with **train PR 3 of #1169 (issue #1162)**. Run it only on a
> branch where that PR is merged; on plain `dev` the propose/withdraw halves
> exist but the respond phase will 404. The proposal model, transitions and
> expiry policy asserted here are already live (`lib/booking/transitions.ts`,
> `lib/booking/reschedule-proposals.ts`, `prisma/schema.prisma model
> RescheduleRequest`).

You are a senior QA engineer. Your job is to run end-to-end tests of the
reschedule-proposal lifecycle — the asymmetric auto-confirm rule, the response
loop, the single-counter round limit, and the one-open-proposal lock — using
two MCP tools:

- **Supabase MCP** — direct SQL against PostgreSQL (project: `pzmbxqdgibfkhjwzeprf`)
- **Chrome DevTools MCP** — UI interaction + `fetch()` calls via `evaluate_script`

All test data uses the `-007` suffix to avoid collisions with existing seed data.

---

## Critical Rules

1. **FIX BUGS IMMEDIATELY.** Stop, fix source code, retest the full phase. No backlogs.
2. Verify DB state after every action via `execute_sql`.
3. Test both happy path AND error paths.
4. Take snapshots before every UI interaction.
5. All times in SQL are UTC. Book slots **at least 5 days out** so the 24-hour
   reschedule policy gate and the proposal-expiry math never interfere with the
   scenario under test.
6. All status writes under test are CAS transitions — a failed guard must
   surface as a 4xx, never as a silently ignored write.

---

## Background: The Proposal Model

`RescheduleRequest` (`prisma/schema.prisma`, `model RescheduleRequest`) carries
the loop. The invariants this case pins are stated in the code:

- **Asymmetric auto-confirm** (`lib/booking/reschedule-proposals.ts:mayAutoConfirm`):
  only a CONSULTEE-initiated proposal may confirm without the other party,
  because published availability is standing consent to be booked inside it. A
  consultant-initiated proposal ALWAYS waits for the consultee.
- **States** (`lib/booking/transitions.ts:RESCHEDULE_ALLOWED_FROM`):
  `PENDING_REVIEW ⇄ COUNTERED` are the open states; `AUTO_ACCEPTED`,
  `ACCEPTED`, `DECLINED`, `WITHDRAWN`, `EXPIRED` are terminal. Reaching a
  terminal state also nulls `openForAppointmentId` and stamps `resolvedAt`.
- **One live proposal per appointment**: `openForAppointmentId String? @unique`
  — the second open proposal dies on P2002 → HTTP 409.
- **Round limit**: `round` is 1 for the opening proposal, 2 for the single
  permitted counter. There is no round 3.
- **Expiry**: `expiresAt = min(now + 72h, earliest released slot start − 24h)`
  (`computeProposalExpiry`).
- **Released slots** are held as `releasedSlotIds` and flipped to
  `completionStatus = 'RESCHEDULED'` on the appointment; acceptance re-confirms
  them in place at the proposed times.

---

## Phase 0 — Data Seeding

Reuse the Agent-005 seeding recipe with the `-007` suffix: domain
`test-domain-007`, consultant `testconsultant007@familiarise.com` /
`TestPassword007!` with profile `test-consultant-profile-007` (scheduleType
`WEEKLY`, generous availability Mon–Fri 09:00–17:00 UTC), consultee
`testconsultee007@familiarise.com` / `TestPassword007!`, and consultation plan
`test-consultation-plan-007` (0.5h, ₹1,000). Create accounts through the
signup UI, then attach profiles via SQL exactly as in Agent 005 Phase 0.

Then, as CONSULTEE, book one mock-payment consultation **6 days out at 10:00
UTC** via `POST /api/checkout` (`isMockPayment: true`). Verify and record ids:

```sql
SELECT a.id AS appointment_id, a.status, s.id AS slot_id, s."startsAt",
       s."isTentative", s."completionStatus"
FROM "Appointment" a
JOIN "SlotOfAppointment" s ON s."appointmentId" = a.id
JOIN "Consultation" c ON c.id = a."consultationId"
WHERE c."consultationPlanId" = 'test-consultation-plan-007';
-- Expected: 1 confirmed slot (isTentative=false, completionStatus='SCHEDULED'),
-- appointment status SCHEDULED. Save APPOINTMENT_ID and ORIGINAL_SLOT_ID.
```

---

## Phase 1 — Consultant-Initiated Proposal Never Auto-Confirms

Login as CONSULTANT. Propose moving the session to **6 days out, 14:00 UTC**
(inside the consultant's own published availability — the point is that even a
"valid" time must NOT auto-confirm when the consultant initiates):

```javascript
async () => {
  const response = await fetch(
    "/api/appointments/<APPOINTMENT_ID>/reschedule",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        releasedSlotIds: ["<ORIGINAL_SLOT_ID>"],
        proposedSlots: [
          { startsAt: "<D+6T14:00Z>", endsAt: "<D+6T14:30Z>" },
        ],
        reason: "Agent 007 consultant-initiated proposal",
      }),
    },
  );
  return { status: response.status, body: await response.json() };
};
```

**Expected:** 200/201, and the proposal is **waiting**, not confirmed.

DB verify:

```sql
SELECT id, "initiatorRole", status, round, "openForAppointmentId",
       "expiresAt", "releasedSlotIds", "resolvedAt"
FROM "RescheduleRequest"
WHERE "appointmentId" = '<APPOINTMENT_ID>'
ORDER BY "createdAt" DESC LIMIT 1;
-- Expected: initiatorRole=CONSULTANT, status='PENDING_REVIEW', round=1,
-- openForAppointmentId='<APPOINTMENT_ID>', resolvedAt IS NULL.
-- expiresAt = now()+72h (the released slot is 6 days out, so the lifetime cap
-- binds, not the session-margin bound). Save PROPOSAL_ID.

SELECT "completionStatus" FROM "SlotOfAppointment" WHERE id = '<ORIGINAL_SLOT_ID>';
-- Expected: 'RESCHEDULED' — the original slot is released, not deleted.
```

### Test 1.2 — One live proposal per appointment

Repeat the POST with a different proposed time. **Expected:** 409 (the
nullable-unique `openForAppointmentId` claim — a bare P2002 mapped by the
route). DB verify the count of open rows for the appointment is exactly 1.

---

## Phase 2 — Counterparty ACCEPTS (train PR 3 response loop)

Login as CONSULTEE and accept `PROPOSAL_ID` via the respond endpoint shipped by
train PR 3 (#1162) — consult `docs/booking/07-rescheduling-flow.md` on that
branch for the exact path/body; it accepts an `ACCEPTED`/`DECLINED` response
from the non-initiating party.

**Expected:** 200. Then assert the full post-acceptance state:

```sql
SELECT status, "resolvedAt", "openForAppointmentId"
FROM "RescheduleRequest" WHERE id = '<PROPOSAL_ID>';
-- Expected: status='ACCEPTED', resolvedAt NOT NULL, openForAppointmentId IS NULL.

SELECT id, "startsAt", "endsAt", "isTentative", "completionStatus"
FROM "SlotOfAppointment"
WHERE "appointmentId" = '<APPOINTMENT_ID>' AND "deletedAt" IS NULL
ORDER BY "startsAt";
-- Expected: exactly ONE live confirmed slot at the PROPOSED time
-- (14:00–14:30, isTentative=false, completionStatus='SCHEDULED').
-- The appointment keeps its identity — same APPOINTMENT_ID, status SCHEDULED.

SELECT COUNT(*) FROM "Payment" p
JOIN "Appointment" a ON a.id = p."appointmentId"
WHERE a.id = '<APPOINTMENT_ID>';
-- Expected: 1 — rescheduling NEVER touches the payment row.
```

### Test 2.2 — Responding twice is a dead CAS edge

Repeat the accept call. **Expected:** 4xx (the `updateMany WHERE status IN
(PENDING_REVIEW, COUNTERED)` guard matches zero rows → `IllegalTransitionError`
mapped to a 409/400, never a second acceptance).

### Test 2.3 — Only the counterparty may respond

As CONSULTANT (the initiator), attempt to accept your own proposal.
**Expected:** 403/404 — the initiator cannot answer their own proposal.

---

## Phase 3 — Counterparty DECLINES

As CONSULTANT, open a second proposal (the lock is free again) moving the
session to **6 days out, 15:00 UTC**, releasing the current confirmed slot.
Verify `PENDING_REVIEW` + the new lock claim as in Phase 1.

As CONSULTEE, respond `DECLINED`.

**Expected:** 200, and the booking **stands unchanged**:

```sql
SELECT status, "resolvedAt", "openForAppointmentId"
FROM "RescheduleRequest" WHERE id = '<PROPOSAL_2_ID>';
-- Expected: status='DECLINED', resolvedAt NOT NULL, openForAppointmentId IS NULL.

SELECT "startsAt", "isTentative", "completionStatus"
FROM "SlotOfAppointment"
WHERE "appointmentId" = '<APPOINTMENT_ID>' AND "deletedAt" IS NULL
  AND "completionStatus" = 'SCHEDULED';
-- Expected: ONE confirmed slot at the PRE-PROPOSAL time (14:00) — the released
-- slot was re-confirmed in place; nothing was deleted, nothing moved.
```

---

## Phase 4 — Consultee Proposal Auto-Confirms (asymmetry regression)

As CONSULTEE, propose moving the session to another time inside the
consultant's published availability with both calendars free (e.g. 6 days out,
11:00 UTC).

**Expected:** the proposal resolves immediately as `AUTO_ACCEPTED` — no
consultant action — via `tryAutoConfirmProposal`, which re-runs the ordinary
`requested` allocation under the correct locks:

```sql
SELECT status, "initiatorRole", "resolvedAt" FROM "RescheduleRequest"
WHERE "appointmentId" = '<APPOINTMENT_ID>' ORDER BY "createdAt" DESC LIMIT 1;
-- Expected: initiatorRole='CONSULTEE', status='AUTO_ACCEPTED', resolvedAt NOT NULL.
```

Also assert the failure half of the asymmetry: a consultee proposal onto a time
**outside** availability must NOT error — it stays `PENDING_REVIEW` for the
consultant to answer (auto-confirm failing is an ordinary outcome). Withdraw it
afterwards (`POST /api/appointments/<APPOINTMENT_ID>/reschedule/withdraw`) and
assert `WITHDRAWN` + lock released.

---

## Phase 5 — Expiry Math Spot-Check

For any proposal created above, assert the two-bound expiry rule directly:

```sql
SELECT "expiresAt" <= "createdAt" + INTERVAL '72 hours' AS within_lifetime_cap
FROM "RescheduleRequest" WHERE "appointmentId" = '<APPOINTMENT_ID>';
-- Expected: true for every row. (With a session ~6 days out the 72h cap binds;
-- the session-margin bound "first released slot − 24h" would bind instead for
-- a near-term session — do not test that here, the policy gate rejects
-- reschedules inside 24h before a proposal is ever created.)
```

---

## Verification Checklist (End-to-End)

| # | Check | Expected |
| --- | --- | --- |
| 1 | Consultant proposal → PENDING_REVIEW, never auto-confirms | PENDING_REVIEW |
| 2 | Open proposal claims `openForAppointmentId` | = appointment id |
| 3 | Second open proposal on same appointment | 409 |
| 4 | Released slot flips to RESCHEDULED, not deleted | RESCHEDULED |
| 5 | Consultee ACCEPT → terminal + slot confirmed at proposed time | ACCEPTED |
| 6 | Payment row untouched by the whole loop | 1 row, unchanged |
| 7 | Double-respond | 4xx (CAS dead edge) |
| 8 | Initiator cannot respond to own proposal | 403/404 |
| 9 | DECLINE → booking re-confirmed at original time | DECLINED, slot back |
| 10 | Consultee in-availability proposal | AUTO_ACCEPTED |
| 11 | Consultee out-of-availability proposal | stays PENDING_REVIEW |
| 12 | Withdraw releases the lock | WITHDRAWN, lock NULL |
| 13 | expiresAt within the 72h lifetime cap | true |
| 14 | Cleanup complete | all counts = 0 |

---

## Cleanup

Delete in dependency order, mirroring Agent 005 Phase 10 with the `-007`
suffix, plus the proposal rows first:

```sql
DELETE FROM "RescheduleRequest" WHERE "appointmentId" IN (
  SELECT a.id FROM "Appointment" a
  JOIN "Consultation" c ON c.id = a."consultationId"
  WHERE c."consultationPlanId" = 'test-consultation-plan-007'
);
```

Then slots → payments → appointments → consultations → plans → availability →
profiles → users → subdomain/domain, exactly as in Agent 005. Verify all
`-007` counts are zero.
