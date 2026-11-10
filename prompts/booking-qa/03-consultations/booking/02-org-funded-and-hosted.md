# 03-b · Consultations: org-funded (Wipro) and org-hosted (LearnPro)

**Needs:** 01 (S-08, S-16 + F-AV5 for OX, S-01 memberships). `[local]` for the org-hosted card purchase.
**Personas:** B4 (Wipro LEARNER, IST), DR (Wipro LEARNER, Sydney), OS (Wipro OWNER), OH (LearnPro OWNER), OX (LearnPro EXPERT), H1, B1, ST.
**Docs under test:** `docs/booking/17-org-funded-checkout.md`, `.claude/skills/booking/SKILL.md` doctrine §3–4, `docs/finance/50-b2b/01-funding-rails-and-permutations.md`.

Read Wipro's funding setup before CO-12 and paste it in the report:

```sql
SELECT o.id, o.name, o.status, o."canSponsor", o."canHost", b."fundingSource", b."walletBalance", b."creditLimit"
FROM "Organization" o LEFT JOIN "BillingAccount" b ON b."organizationId" = o.id
WHERE o.name ILIKE '%wipro%' OR o.name ILIKE '%learnpro%';

SELECT pa.id, pa.status, pa."userId", p.name, p.status AS program_status, p."coveredPlanTypes"
FROM "ProgramAssignment" pa JOIN "Program" p ON p.id = pa."programId"
WHERE pa."userId" IN (:b4UserId, :drUserId);
```

If Wipro's `fundingSource` is `PERSONAL` or B4 has no active `ProgramAssignment` covering consultations, CO-12 can't take the org rail: mark it BLOCKED (fixture) and ask the owner whether to seed one. Never invent a program row yourself.

## CO-12 — B4 books a consultation paid by Wipro (sponsored rail)

**Why it matters:** sponsored bookings skip the gateway; they must confirm in one transaction, debit the org, and report to the org dashboard.

**Setup:** preview OK (no gateway on this rail). Record Wipro's wallet balance (if WALLET).

**Steps:**

1. As B4 open H1's expert page → S-08 → Book Now → Wed D+2 12:00 IST (06:30Z).
2. On checkout read "Who is paying?". Options include Wipro (with "Wallet: ₹X remaining", "Added to the org's monthly invoice" or "Free — covered by the org's enterprise license") and "Pay with your card" / "Personal payment". Pick Wipro.
3. Read any consent notice (`Settings › Account › Data consent`), overage warning and the referral-credit note ("Referral credits cannot be used for org-funded bookings.").
4. Confirm.

**Expect:**

- DB: confirmed occurrence (non-tentative) in the same transaction; `Payment` `SUCCEEDED`, `paymentIntent` starts `org_wallet_` / `org_invoice_` / `org_license_`, `paymentMethod` WALLET/INVOICE/LICENSE, `organizationId` = Wipro, no `expiresAt`; `Appointment.organizationId` = Wipro; `Appointment.cancellationPolicyId` = Wipro's policy or the platform row (record).
- Money: WALLET balance down by the amount (re-read `walletBalance`); a `BookingUtilization` row (1 engagement); `ConsultantEarnings` created inline.
- No webhook, no gateway order.

**Cross-check:**

- B4 detail and payments: "Paid by Wipro" (or "Paid by your organisation"), no card amount.
- OS: `/dashboard/organization/[Wipro]/appointments` shows the booking (metadata only: who, when, which expert; no content); org billing/spend shows the debit.
- H1: an ordinary booking; earnings row present.
- Staff: payment detail shows the org rail.

**Probe further:** the dashboard copy about consent and "Who is paying?": clear to a learner? What does OS see in home/analytics after this (engagement count)? Cancel outcome is CO-78.

## CO-13 — Sponsored checkout refuses rather than billing the learner

**Why it matters:** doctrine: a missing program assignment or consent on a sponsored org refuses; it never silently charges the card.

**Setup:** DR (Wipro LEARNER). From the SQL above, find what DR lacks (assignment, consent). If DR has everything, BLOCKED for this half.

**Steps:** as DR attempt CO-12's flow choosing Wipro.

**Expect:** refused before any money with a typed error: `CONSENT_REQUIRED` (403-shaped) when consent is missing, or "No active program assignment covers this booking…" when the assignment is missing. No `Payment`, no appointment. The UI says what to do (link to consent settings, or "ask your organisation").

**Probe further:** does the UI pre-flight the consent (`/api/organizations/[orgId]/checkout/consent-preview`) and warn before the click? A learner discovering it only on submit is a MISSED-OPPORTUNITY.

## CO-14 — B4 pays personally while being a Wipro member

**Why it matters:** a personal card purchase tagged to an org must not appear with its amount in the org's lists (doctrine §4, #1166 ORG-8).

**Setup:** `[local]`.

**Steps:** as B4 book S-08 at Thu D+3 12:00 IST choosing "Pay with your card" ("You pay — the org is tagged for reporting only"), Mock Pay.

**Expect:**

- DB: card/mock `Payment` (no `org_` prefix); `Appointment.organizationId` may be Wipro (tag); `Payment.organizationId` record.
- OS's org appointments list and "Everyone" feeds do **not** show this booking (or show it without an amount; record exactly). Showing the amount is SECURITY (P1).

**Probe further:** `GET /api/appointments?orgScope=[Wipro]` as OS: the personal row must be absent (salvaged from old 017 Phase 5). As B4: `?orgScope=[Wipro]` downgrades to B4's own rows; `?orgScope=all` → 403 `ALL_REQUIRES_PRIVILEGED_ROLE`.

## CO-15 — Sponsor allocation waits for the expert's approval

**Why it matters:** salvaged from old 017 Phases 1–4. A sponsor must never approve for the expert, never re-plan a scheduled booking and never place outside the expert's hours.

**Setup:** you need an org-funded consultation that has no time yet and is `PENDING`, then `APPROVED`. The cleanest path: CO-12's booking, released by B4 with "Any time works" (03-c CO-51's flow) so its session needs a new time. Record the parent status after the release. If you can't reach an org-funded booking with no times, BLOCKED.

**Steps (as OS, `evaluate_script`):**

1. While the booking is `PENDING` (if it is): `POST /api/organizations/[Wipro]/appointments/[aid]/allocate` with `{ isAuto: false, slots: ["<Fri D+4>T05:30:00Z"], overrideReason: "qa-CO-15 sponsor schedules" }`.
2. Same body with `overrideReason: "abc"`.
3. Once `APPROVED`: the same call with a time inside H1's hours.
4. A time outside H1's hours (14:00 IST).
5. Repeat step 3.
6. On CO-14's personal booking.
7. As OH (another org) on the same appointment with LearnPro's org id.

**Expect:**

- 1: 409 `EXPERT_APPROVAL_REQUIRED`; nothing placed. In OS's Unscheduled queue the row reads "Awaiting expert approval" with no Allocate button.
- 2: 400 (reason under 5 characters).
- 3: 200; one occurrence; an `OrgAuditLog` row `APPOINTMENT_ALLOCATED_FOR_ORG` with the reason.
- 4: 400 `OUTSIDE_AVAILABILITY` (the sponsor can't override).
- 5: 409 `ALREADY_ALLOCATED`.
- 6: 403 `NOT_ORG_FUNDED`.
- 7: 404 `APPOINTMENT_NOT_FOUND`.

**Cross-check:** B4 and H1 see the new time; R-05 zero rows.

**Probe further:** does OS's UI expose this allocate at all, or only the API? Is the "reason" field explained? A MANAGER without the permission gets 403 (if such a persona exists).

## CO-16 — An org-tagged request in REQUEST mode is still paid by card

**Why it matters:** the doc says wallet/invoice/licence parity for the approval pay link is not built. A learner who expects Wipro to pay must not be surprised.

**Setup:** H1 in "Review requests first" (S-07). Restore at the end.

**Steps:** as B4 request S-10 (90 min) for Mon D+7 17:00 IST choosing Wipro if the request flow offers "Who is paying?". As H1 approve with "Use requested times" (CO-27 flow). As B4 open the pay link.

**Expect:** the request may carry the org tag, but the approval mints a **card** pay link (`Payment` PENDING, gateway intent). Record whether any screen told B4 that Wipro won't pay. If the request flow shows Wipro as payer and then charges B4's card, that's FALSE-INFO (P1).

**Probe further:** report as a known gap (`docs/booking/17-org-funded-checkout.md` "Who allocates an org-funded booking", last paragraph). Cancel the request afterwards (no money).

## CO-17 — B1 books OX's LearnPro-hosted consultation `[local]`

**Why it matters:** org-hosted earnings split between the expert and the host org; the host org sees every booking on its plans, metadata only.

**Setup:** S-16 plan and F-AV5 (OX Mon–Fri 10:00–13:00 IST).

**Steps:** as B1 book "qa-S-16 LearnPro call 60" at Tue D+1 11:00 IST with Mock Pay.

**Expect:**

- DB: ordinary consultation graph; `Payment` gateway/mock; earnings: `ConsultantEarnings` for OX and `OrganizationEarnings` for LearnPro per its rate card (record the split; payout SELF for OX).
- OH: `/dashboard/organization/[LearnPro]/appointments` lists it (plan hosted by LearnPro), metadata only; `…/compensation` or earnings shows LearnPro's share.
- OX: the booking appears under the LearnPro org scope, not on OX's personal tabs (delivery side splits on the plan's host org). Record where OX actually sees it.
- B1: an ordinary booking with OX's name; does it mention LearnPro?

**Cross-check:** standard list plus OH's views; R-05 for OX.

**Probe further:** any page that shows LearnPro the session's content (notes, documents, recordings) is SECURITY. OX's earnings page: is the org cut explained?

## CO-18 — Host-org operator allocates only inside the expert's hours

**Why it matters:** D16: a host operator may place their expert's bookings, but `override`, `allowPartial` and `topUp` belong to the expert and staff.

**Setup:** a LearnPro-hosted booking with no time yet (OX in REQUEST mode: as OX switch to "Review requests first", B1 requests S-16 for Wed D+2 11:00 IST, then OX back to Instant). If OH has no operator access to the host allocate route, BLOCKED.

**Steps (as OH, `evaluate_script`):** `PATCH /api/bookings/consultations/[cid]/allocate` with (a) a time inside F-AV5 plus `override: true`; then on a second request (b) a time outside F-AV5 (14:00 IST).

**Expect:** (a) 200, placed without the override (history shows no override); (b) 400 `OUTSIDE_AVAILABILITY`. Priced request: (a) lands `APPROVED_PENDING_PAYMENT` with a pay link to B1 (record).

**Probe further:** does OH have any UI for this, or API only? Cancel what you created.

## CO-19 — Org lists show exactly the org's rows

**Why it matters:** salvaged from old 017 Phase 5; the read side of org scoping, for consultations only (depth in 11).

**Steps:** run each call and compare with the fixtures created above:

| Caller | Request | Expect |
| --- | --- | --- |
| OS | `GET /api/appointments?orgScope=[Wipro]` | CO-12 present; CO-14 absent |
| OS | `GET /api/organizations/[Wipro]/appointments` | same set as above |
| B4 | `GET /api/appointments?orgScope=[Wipro]` | only B4's own rows in Wipro |
| B4 | `GET /api/appointments?orgScope=[LearnPro]` | 403 `ORG_MEMBERSHIP_REQUIRED` |
| OH | `GET /api/appointments?orgScope=[LearnPro]` | CO-17 present (host org sees its plans) |
| AD | `GET /api/appointments?orgScope=all` | 200, unfiltered |

**Probe further:** compare each API result with the matching dashboard page; a row in the API but not the page (or the reverse) is an INCONSISTENCY.
