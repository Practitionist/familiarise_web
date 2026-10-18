# E2E Booking Algorithm Test — Agent 017: `?orgScope=` Variants and Sponsor Allocate-After-Approve

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`
**App URL:** `http://localhost:3000`
**Read first:** [`wave0-shared-setup.md`](./wave0-shared-setup.md), then the org roster in
[`../enterprise-tests/_shared/shared-setup.md`](../enterprise-tests/_shared/shared-setup.md)

> **Coverage marker:** a sponsor organisation may set the times of a booking it
> **funded**, but only after the expert has **approved** it, only inside the
> expert's published hours, and never by approving on the expert's behalf. The
> `?orgScope=` lists must show an org only the rows it actually paid for. Fixture
> suffix `-017` for the rows you create; the organisations are seeded.

You are a senior QA engineer. Prove each refusal returns its typed code and
changes nothing, and that the scoped lists never leak another tenant's rows.

## Critical Rules

1. Assert status, `code` and the rows. A refusal that changed `Consultation.status`
   or created an occurrence is a failure.
2. The sponsor route is `POST /api/organizations/<ORG_ID>/appointments/<APPOINTMENT_ID>/allocate`
   (it also accepts the consultation id). The host-side route is
   `PATCH /api/bookings/consultations/<ID>/allocate`. They are different doors.
3. Never alter a seeded organisation's status or billing account except where a
   step says so, and restore it in the same step.

---

## Phase 0 — Data seeding

Use the seeded organisations: **Wipro Limited** (`slug wipro`, pure sponsor,
`canSponsor`), **LearnPro Academy** (`learnpro-academy`, pure host) and **IIT
Madras** (`iit-madras`, hybrid). Sign in as Wipro's OWNER
`tour-owner@familiarise.dev` (seed password). Confirm with SQL that Wipro has an
active `BillingAccount` with `fundingSource` in `WALLET`, `INVOICE` or `LICENSE`
and enough balance or limit for two bookings; if not, top up per
`enterprise-tests/3-billing-wallet-invoices/3.1-api-wallet-top-up-and-invoices.md`.

Pick or create: an ACTIVE Wipro member who is a plain learner (`<MEMBER>`), a solo
published expert with a 0.5 h plan whose Monday window is open (`<EXPERT>`, seed
local columns if you create one), and a Wipro MANAGER who lacks
`appointments.allocate.calendarRead` (`<MANAGER>`). Pin `D` to the coming
**Monday**.

As `<MEMBER>`, request two bookings for `<EXPERT>` at `D+7` and `D+8` 05:00Z through
`POST /api/scheduling/request-for-approval` with `organizationId: <WIPRO_ID>`;
record `<ORG_REQ_1>` and `<ORG_REQ_2>`. Make a third with `POST /api/checkout`
(mock payment) on the **PERSONAL** rail for the same org, `D+9` 05:00Z, so it is
org-tagged but paid by the member's own card: `<PERSONAL_APPT>`.

## Phase 1 — The sponsor cannot approve for the expert

As Wipro OWNER, allocate `<ORG_REQ_1>` while it is still `PENDING`:

```javascript
async () => {
  const r = await fetch("/api/organizations/<WIPRO_ID>/appointments/<ORG_REQ_1>/allocate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isAuto: false, slots: ["<D+7T05:00Z>"], overrideReason: "Agent 017 sponsor schedules" }),
  });
  return { status: r.status, body: await r.json() };
};
```

**Expected:** `409`, `code: "EXPERT_APPROVAL_REQUIRED"`. Request still `PENDING`,
no new occurrence.

Repeat as `<MANAGER>`. **Expected:** `403` (the permission is missing). A body
without `overrideReason` (or shorter than 5 characters) answers `400`.

## Phase 2 — The member cannot allocate their own booking

As `<MEMBER>`, `PATCH /api/bookings/consultations/<ORG_REQ_1>/allocate` with a manual
slot. **Expected:** `403`, `errorCode: "ALLOCATE_FORBIDDEN"`; still `PENDING`.

## Phase 3 — Allocate after approve

1. As `<EXPERT>`, approve without times:
   `PATCH /api/bookings/consultations/<ORG_REQ_1>` with `{ "status": "APPROVED" }`.
   **Expected:** `200`; status `APPROVED` (or `APPROVED_PENDING_PAYMENT` if the
   org rail does not apply: stop and report, this case needs an org-funded request).
2. Sponsor allocates inside the expert's hours (`<D+7T05:00Z>`): **Expected** `200`;
   one occurrence at that time; an `OrgAuditLog` row:

   ```sql
   SELECT action, details->>'overrideReason' AS reason
   FROM "OrgAuditLog"
   WHERE "organizationId" = '<WIPRO_ID>' AND action = 'APPOINTMENT_ALLOCATED_FOR_ORG'
   ORDER BY "createdAt" DESC LIMIT 1;
   -- Expected: one new row, reason = 'Agent 017 sponsor schedules'
   ```

3. Approve `<ORG_REQ_2>` the same way, then try a time **outside** the expert's
   published hours (for example `<D+8T12:00Z>`). **Expected:** `400`,
   `OUTSIDE_AVAILABILITY`; the sponsor cannot override the expert's hours (it never
   sends `override`), and the response carries no occurrence.
4. Allocate `<ORG_REQ_1>` again. **Expected:** `409 ALREADY_ALLOCATED` (a sponsor
   never re-plans a scheduled booking).

## Phase 4 — Funding and tenancy are checked, not the tag

1. Sponsor allocate on `<PERSONAL_APPT>`: **Expected** `403`, `code: "NOT_ORG_FUNDED"`
   (the org tag is there, the org's money is not).
2. As IIT Madras's OWNER, call the same route with `<IITM_ID>` and `<ORG_REQ_2>`:
   **Expected** `404`, `code: "APPOINTMENT_NOT_FOUND"` (the lookup is pinned to the
   caller's own `organizationId`).
3. A host-org operator (LearnPro or IIT Madras, if your expert is hosted by one) on
   the host-side `PATCH` route: **Expected** `200` only for a time inside the
   expert's published hours; sending `override: true` or `topUp: true` is ignored
   (the booking is placed without the override), and a time outside the hours is
   `400 OUTSIDE_AVAILABILITY`.

## Phase 5 — The scoped lists

| Caller and request                                            | Expected                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| Wipro OWNER, `GET /api/appointments?orgScope=<WIPRO_ID>`      | 200; contains `<ORG_REQ_1>`/`<ORG_REQ_2>`; **not** `<PERSONAL_APPT>`   |
| `<MEMBER>`, same URL                                          | 200, downgraded to the member's own rows in that org                  |
| `<MEMBER>`, `?orgScope=<IITM_ID>` (not a member)              | 403 `ORG_MEMBERSHIP_REQUIRED`                                         |
| `<MEMBER>`, `?orgScope=all`                                   | 403 `ALL_REQUIRES_PRIVILEGED_ROLE`                                    |
| ADMIN, `?orgScope=all`                                        | 200, unfiltered                                                       |
| Wipro OWNER, `GET /api/organizations/<WIPRO_ID>/appointments` | same rows as the `org` scope above                                    |
| `<MEMBER>`, `GET /api/collaborations?orgScope=<WIPRO_ID>&view=org` | 403 (needs `catalog.manage`)                                     |

The `<PERSONAL_APPT>` row is the proof: the org's list must not publish the amount
of a member's personal card purchase just because checkout tagged it with the org.

```sql
SELECT a.id, a."organizationId", p."paymentMethod"
FROM "Appointment" a JOIN "Payment" p ON p."appointmentId" = a.id
WHERE a."consultationId" = '<ORG_REQ_1>' OR a.id = '<PERSONAL_APPT>';
-- Expected: the org-funded row has WALLET/INVOICE/LICENSE; <PERSONAL_APPT> has CARD/
-- gateway method and is absent from the org list.
```

## Phase 6 — Cleanup

Cancel the three bookings through the cancel route as their owners (the org-funded
ones reverse in the ledger with no gateway refund row), delete the `-017` fixtures
you created in the order given in the shared setup, and leave `OrgAuditLog` rows
(immutable). Restore any billing field you changed.

## Pass/fail table

| #   | Check                                   | Expected                                    |
| --- | --------------------------------------- | ------------------------------------------- |
| 1   | Sponsor allocate on a PENDING request   | 409 `EXPERT_APPROVAL_REQUIRED`, unchanged   |
| 2   | Member allocates their own booking      | 403 `ALLOCATE_FORBIDDEN`                    |
| 3   | Allocate after approve, inside hours    | 200, audit row with reason                  |
| 4   | Outside the expert's hours              | 400 `OUTSIDE_AVAILABILITY`                  |
| 5   | Personal-rail org-tagged booking        | 403 `NOT_ORG_FUNDED`                        |
| 6   | Another org's owner                     | 404 `APPOINTMENT_NOT_FOUND`                 |
| 7   | Org list vs personal-rail row           | org rows only, personal-rail row absent     |
