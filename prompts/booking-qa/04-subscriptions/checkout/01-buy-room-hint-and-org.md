# 04-c · Subscriptions: buying a plan, the room hint and org-funded plans

**Needs:** F-AV1, F-PL1, F-BUSY; `qa-SU-14` (H2, 3/week × 2.5 h) and one H2 Mon/Wed/Fri evening booking from SU-20; `qa-SU-17` (H4, 1/week × 1 h). **[local]** for every paid purchase (mock payment).
**Personas:** B1 (IST), B2 (Europe/London, GMT in November), B3 (America/Los_Angeles, PST), DR (Australia/Sydney, AEDT) for one zone probe; H1, H2, H4 hosts.
**Docs under test:** `docs/booking/16-recurring-events-journey.md` §3, decision 6 and 7 in the scheduling ADR, `lib/payments/checkout/handlers/subscription.ts`, `lib/booking/entitlement.ts` (`firstCycleWindow`, `weeksPlanEndOf`), `lib/payments/checkout/renewal.ts` (`resolvePlanStart`).

The buyer starts on the expert page (`/explore/experts/[cid]`): pick a plan, click **Start mentorship**, answer the dialog **When do you want to start?** ("Your consultant schedules one cycle at a time; the first cycle starts on the date you pick."), then **Continue** to `/checkout/plans/subscription/[planId]?…`.

Zone reference for November 2026: 09:00 IST = 03:30Z = 03:30 London = 19:30 LA (the day before) = 14:30 Sydney. 18:00 IST = 12:30Z = 12:30 London = 04:30 LA = 23:30 Sydney.

## SU-23 — Buy H1's 4-week plan: frozen terms and the "schedule cycle 1" wait [local]

**Why it matters:** checkout freezes the entitlement; every later number reads it.

**Setup:** SU-01's plan (or F-PL1 weeks plan) published, price P (read it with R-02).

**Steps:**

1. As B2 (London), open H1's expert page. Pick the 4-week plan. Click **Start mentorship**.
2. In the dialog pick tomorrow. Read the **First cycle:** box.
3. Continue. On checkout read every row of "Subscription Details" (First cycle, Sessions per Week, Session Duration, Total Sessions, Total Hours) and the price.
4. Check the network panel for the feasibility GET. Pay with mock payment.
5. Read the success message. Open B2's Home and Appointments.
6. As H1, open Home and Requests.

**Expect:**

- UI (dialog): `First cycle:` tomorrow → tomorrow + 6 days, `3 sessions per cycle · 12 in the plan`.
- UI (checkout): Sessions per Week 3, Session Duration 1 hour (record the format), Total Sessions 12, Total Hours 12, price P for the whole plan. No amber or red banner (H1's weeks fit 3; the GET returns `verdict: "ok"`, `notice: null`).
- API: `GET /api/plans/subscriptions/[id]/feasibility?startsAt=…` → 200. `POST /api/checkout` → 2xx.
- DB:
  - `Subscription`: `status = PENDING`, `bookingSource = DIRECT_CHECKOUT`, `sessionsPerWeek = 3`, `sessionMinutes = 60`, `sessionsTotal = 12`, `sessionsReturned = 0`, `sessionsRefunded = 0`, `schedulingTimezone = Asia/Kolkata` (H1's zone, not B2's).
  - `schedulingPeriodStartsAt` = B2's local midnight of tomorrow (00:00 London = 00:00Z = 05:30 IST) or later; `schedulingPeriodEndsAt` = the IST midnight after seven IST days; `planEndsAt` = 00:00 IST on (start's IST day + 28).
  - One placeholder `Appointment` (`appointmentType = SUBSCRIPTION`, no occurrences, `cancellationPolicyId` set). One `AppointmentParticipant` for B2. `BookingStatusHistory` row `fromStatus = CREATED`.
  - R-04: one `Payment` `SUCCEEDED`, `isMockPayment = true`, `amount` = P plus tax as shown; `ConsultantEarnings` `PENDING` with `holdUntil` ≈ capture + 168 h (subscription hold).
- UI (B2): Home or the booking shows "Paid · Hannah has until <capture + 48 h, in London time> to schedule cycle 1." (wording from `lib/dashboard/money-state.ts`).
- UI (H1): Requests shows the plan with the action **Schedule cycle 1** and the same deadline in IST.

**Cross-check:** consultant Home and Requests; consultee Home, Appointments and Payments (the payment row with P); bell for H1 (new purchase) and B2 (receipt); R-07 outbox rows for the receipt and the expert's notice. Convert the 48 h deadline: B2's London time + 5:30 = H1's IST time.

**Probe further (report anything odd):**

- The success toast says "Mock payment processed. Your subscription is now active. Check your dashboard for details." The plan is `PENDING` until H1 schedules. Is "active" true? Report **FALSE-INFO** (P2) if the dashboard then says "waiting for your expert".
- The dialog and Home say "cycle"; the allocate page says "Week 1 of 4". One concept, two words: **INCONSISTENCY** (P2).
- What does B2 see if H1 never schedules? (48 h later the paid-unallocated sweep refunds in full: SU-79.) Is that promise shown to B2 anywhere?
- Reload checkout after paying: does it offer to pay again?

## SU-24 — Weeks plan end has no stub week

**Why it matters:** a plan bought mid-day used to end mid-day 28 days later, leaving a "Week 5 of 5" stub that still asked for 3 sessions.

**Setup:** SU-23's subscription (bought for tomorrow) and a second purchase by B1 of the 26-week variant if one exists (or create `qa-SU-24` 26 weeks × 1/week, ₹100, and buy it as B1 with start **today**). [local]

**Steps:**

1. R-06 on both subscriptions. Compute `planEndsAt` in IST.
2. As H1, open each plan's allocate page. Read the heading and the context chips.

**Expect:**

- DB: `planEndsAt` is exactly 00:00 IST (18:30Z the day before) on start's IST day + 7 × weeks. For a start today at 15:47 IST, the 26-week plan ends 00:00 IST on today + 182 days, not at 15:47.
- UI: headings read "Week 1 of 4 · pick 3 for <range> · 0 of 12 booked" and "Week 1 of 26 · pick 1 for <range> · 0 of 26 booked". Never "of 5" or "of 27".

**Probe further:**

- The last plan week (week 4) still asks for 3: check later in SU-54.
- If DST mattered (it doesn't for IST), 10 (`TZ-`) covers it. Note only that `planEndsAt` is a midnight in H1's zone.

## SU-25 — Buyer in another zone: plan weeks follow the expert's days

**Why it matters:** a buyer far from the expert picks a calendar date in their own zone; the plan weeks are cut on the expert's midnights.

**Setup:** H1's months plan (2 months × 2/week × 90 min). [local]

**Steps:**

1. As DR (Sydney, AEDT, UTC+11), open H1's page, choose the months plan, pick the date 3 days from today. Read the First cycle box. Continue and pay (mock) via a personal card (not Wipro).
2. R-06. Convert `schedulingPeriodStartsAt` to Sydney and IST.
3. As DR, open the booking. As H1, open the allocate page.

**Expect:**

- DB: `schedulingPeriodStartsAt` = 00:00 Sydney on the picked date = 13:00Z the day before = 18:30 IST the day before. The first plan week runs on IST days, starting the **day before** the date DR picked (in IST). `planEndsAt` = `planEndOf(start, 2 months)` on H1's wall clock (calendar months, clamped to month end), `sessionsTotal = 16`.
- UI: DR's dialog said "First cycle: <picked date> → <picked + 6>" in Sydney days. H1's allocate heading range starts on the IST day before.

**Probe further:**

- Is DR ever told that weeks follow the expert's calendar? A session on DR's "day 7" morning may fall in plan week 2. **MISSED-OPPORTUNITY** if nothing explains it.
- The dialog formats dates with `MMM dd, yyyy` in the browser's zone, not DR's profile zone. If you can emulate a different browser zone, check which one wins (10 owns depth).

## SU-26 — Start-date bounds and a stale checkout tab

**Why it matters:** a plan must not start in the past or months away.

**Steps:**

1. As B1, open the start dialog for H1's weeks plan. Try to type yesterday's date. Read the message.
2. Pick a date 100 days ahead (type it; the picker has no max). Continue and submit checkout.
3. Via `evaluate_script`, replay the checkout `POST` with `schedulingPeriodStartsAt` = now − 2 days.
4. Open a checkout URL whose start date is yesterday (edit the query string). Read the page.

**Expect:**

- Step 1: the date input's `min` is today; typed yesterday shows "Start date cannot be in the past".
- Step 2: 400 `INVALID_PLAN_START`, "Pick a start date between today and 90 days from now." No `Subscription` row.
- Step 3: same 400.
- Step 4: "The start date has passed. Please go back and pick a new one."

**Probe further:**

- The dialog lets you pick day 100 and fails only at payment. **MISSED-OPPORTUNITY**: the dialog could cap at 90 days.
- A start of "today" is stored as now (not midnight). Check that the first cycle box still shows today → today + 6.

## SU-27 — Room hint at checkout when a coming week is short [local]

**Why it matters:** the buyer must know before paying that the expert can't hold the full cadence every week.

**Setup:** `qa-SU-14` (H2, 3/week × 2.5 h, Mon/Wed/Fri evenings only) and the SU-20 booking that blocks one evening in the next 4 weeks.

**Steps:**

1. As B2, open H2's page, choose `qa-SU-14`, start today, continue to checkout.
2. Read the banner in "Subscription Details". Check the feasibility GET.
3. Pay (mock).

**Expect:**

- UI: an amber notice, verbatim: "This expert currently has room for about 2 of 3 sessions a week. Sessions that can't be scheduled before the plan ends are refunded."
- API: GET → `verdict: "tight"`, `firstWeekPlaceable` ≥ 1, `notice` = the same text. Checkout → 2xx (a thin plan is sold).
- DB: `Subscription` `PENDING`, `sessionsPerWeek = 3`, `sessionMinutes = 150`, `sessionsTotal = 12`.

**Cross-check:** H2's Requests shows the new plan. Keep it: SU-44 allocates it partially.

**Probe further:**

- Is the notice shown on the expert page before the buyer commits to the dialog, or only on checkout? Earlier is better.
- "Sessions that can't be scheduled before the plan ends are refunded." Does the buyer learn **how** (automatic at plan end, pro rata)? Compare with SU-77's real outcome.

## SU-28 — Nothing free in week 1 → checkout refuses with NOT_PLACEABLE

**Why it matters:** selling a plan whose first week holds nothing guarantees an empty first week.

**Setup:** `qa-SU-17` (H4, 1/week × 1 h, published). As H4, switch Availability to **Custom Schedule** and add one date 10 days from today, 10:15–11:45 Kathmandu. Note F-AV4 to restore.

**Steps:**

1. As B3 (LA), open H4's page, choose `qa-SU-17`, start today, continue.
2. Read the banner. Try to pay.
3. Go back, pick a start date 8 days from today, continue, read the banner, pay (mock). [local]
4. Restore H4's weekly hours (R-02).

**Expect:**

- Step 2 UI: a red alert (`role="alert"`): "This expert has no free time in the first week of this plan right now. Pick a later start date, or ask them to open more hours." Paying → toast titled "No Free Time In The First Week".
- Step 2 API: GET → `firstWeekPlaceable: 0`. `POST /api/checkout` → 409 `NOT_PLACEABLE` with the same message. No `Subscription`, `Appointment` or `Payment` row (R-08 by `requestNotes` if you typed `qa-SU-28` in the notes).
- Step 3: no red alert; checkout succeeds.

**Probe further:**

- Is the pay button disabled while the red alert shows, or does the buyer have to fail first?
- Does the toast body repeat the alert, or is it title-only (`description: null`)? A title-only toast with no next step is **ERROR-HANDLING** (P3).
- After step 3, H4's allocate page for B3: one session fits in week 1 (the custom date). Do the tray warnings say the other weeks can't fit (SU-47)?

## SU-29 — Buying the same plan twice while sessions remain

**Why it matters:** a double purchase takes money for a plan the buyer already holds.

**Setup:** B2 holds SU-23's plan with sessions left.

**Steps:**

1. As B2, buy the same plan again (any start date). [local]

**Expect:**

- API: 409 `SUBSCRIPTION_ALREADY_ACTIVE`, "You already have this plan with 12 sessions left — schedule those first." (the count follows `remaining`). Toast title "You Already Have This Plan".
- DB: no second `Subscription` or `Payment`.

**Probe further:**

- "schedule those first" speaks to the buyer, but only the expert schedules. **COPY** (P2): suggest "your expert is scheduling them" or a link to the plan.
- Is the guard shown before payment (on the expert page) or only at submit?
- Renewal is the legitimate second purchase: SU-81.

## SU-30 — Consultant and staff can't buy; free plan purchase

**Why it matters:** role gates and the no-gateway path.

**Steps:**

1. As H2 (consultant), open H1's expert page, subscriptions tab.
2. As ST, the same.
3. As H1, create `qa-SU-30` weeks plan, 1 week × 1/week × 1 h, price ₹0 (if the editor accepts ₹0; record otherwise). As B4, buy it.

**Expect:**

- Steps 1–2: "Consultee Access Required" / "To subscribe to services, please sign in with a consultee account." No Start mentorship button.
- Step 3: no gateway step; `Subscription` `PENDING`; payment row amount 0 or none (record which). H1's Requests shows it.

**Probe further:**

- A dual-role user (DR, if it has a consultant profile per R-01) — which message?
- Cancelling the free plan later moves no money (SU-72 variant): try it and record.

---

## Part 2 — Org-funded plans

**Needs:** F-AV1, F-PL1; Wipro (SPONSOR org, OS owner) with a `BillingAccount` on WALLET, INVOICE or LICENSE, an ACTIVE Program covering `SUBSCRIPTION` (or covering everything), an active `ProgramAssignment` for the learner, a live `SESSION_BOOKING` consent, and H1 on the Program's panel if the Program is curated. Preview OK: the sponsored rails skip the gateway. Money depth (wallet legs, invoices, reversal ledger) is 08 (`MO-`).
**Personas:** B4 (Wipro learner, IST) or DR (Wipro learner, Sydney), OS (Wipro owner, IST), H1 (IST), ST.
**Docs under test:** `docs/booking/17-org-funded-checkout.md`, `lib/payments/checkout/org-funding.ts`, `app/api/organizations/[orgId]/appointments/[appointmentId]/allocate/route.ts`.

Before the first case, read the org setup with SQL (no writes): `BillingAccount.fundingSource` for Wipro, the learner's `Membership` and `ProgramAssignment`, and the Program's `coveredPlanTypes`. If any piece is missing, mark the cases BLOCKED (fixture) and list what's missing; don't seed money tables.

## SU-31 — A Wipro learner buys H1's plan on the org's rail

**Why it matters:** an org-funded plan is confirmed with no gateway and must land on the org's ledger, not the learner's card.

**Steps:**

1. As B4, open H1's expert page, choose the 4-week plan, start tomorrow.
2. On checkout, pick the Wipro funding option (record its label and what it says about who pays). Submit.
3. Read the success message and B4's booking.
4. As OS, open `/dashboard/organization/[Wipro id]/home` and the org's bookings or "Unscheduled" queue.
5. As H1, open Requests.

**Expect:**

- API: `POST /api/checkout` → 2xx with no gateway redirect.
- DB:
  - `Subscription` `PENDING`, frozen terms as SU-23.
  - `Appointment.organizationId` = Wipro.
  - R-04: `Payment` `SUCCEEDED`, `organizationId` = Wipro, payment intent id starting `org_` (synthetic), `isMockPayment = false`. Earnings rows written in the same transaction.
  - The wallet balance dropped by the plan price (WALLET), or an unbilled accrual exists (INVOICE), or the amount billed is 0 (LICENSE). Record which rail and the numbers.
- UI (B4): the booking says it is paid by Wipro (record the exact words), and the same "has until … to schedule cycle 1" wait as SU-23.
- UI (OS): the booking appears with metadata only (no notes, no session content), in the org's view.
- UI (H1): Requests shows the plan like any other, with **Schedule cycle 1**.

**Cross-check:** consultee Payments shows no card charge; org money view shows the spend; staff (ST) booking view shows the org rail. Bell for OS if the org gets one (record).

**Probe further:**

- Did checkout offer personal referral credits alongside Wipro funding? It must not (org money and personal credits never stack).
- Does H1 see that the plan is org-funded? Should they?
- Does B4's success toast say "active" (see SU-23)?

## SU-32 — The sponsor can't schedule a plan the expert hasn't approved

**Why it matters:** decision ADR: "A sponsor org allocates only a booking the expert already approved."

**Setup:** SU-31's plan, still `PENDING` (H1 hasn't scheduled).

**Steps:**

1. As OS, open the org's Unscheduled queue and try to schedule SU-31's plan from there (if the UI offers it). Otherwise `POST /api/organizations/[Wipro id]/appointments/[appointmentId]/allocate` with `{ "isAuto": true, "overrideReason": "qa-SU-32" }` via `evaluate_script`.
2. As H1, schedule week 1 (Auto-schedule this week). Then, as OS, repeat step 1 for week 2.

**Expect:**

- Step 1: 409 `EXPERT_APPROVAL_REQUIRED`, "The expert has to approve this booking before the organisation can set its times." No occurrences.
- Step 2: the subscription is now `APPROVED`. The org route calls the allocator with `initialAllocation: true`, so expect 409 `ALREADY_ALLOCATED` (record the actual code and copy). No week-2 sessions.

**Probe further:**

- If step 2 also refuses, the sponsor door can **never** schedule a direct-checkout subscription: it is `PENDING` until the expert's first allocation, then "already allocated". Report this as an **UNEXPECTED** finding for the owner, with both responses.
- Does the org UI explain the refusal, or show a raw code?
- Check the `OrgAuditLog` for a row on refusal (there should be none for a refused write).

## SU-33 — No program assignment: refused, never billed to the learner's card

**Why it matters:** a missing assignment used to fall through to the learner's card.

**Setup:** a Wipro member without an active assignment covering subscriptions. If B4 and DR both have one, mark BLOCKED unless the owner approves end-dating DR's assignment (`UPDATE "ProgramAssignment" SET "periodEnd" = now() - interval '1 day' WHERE id = …`, restore afterwards).

**Steps:**

1. As that learner, try SU-31's purchase with the Wipro option.

**Expect:**

- API: 409 `PROGRAM_ASSIGNMENT_INACTIVE`, "No active program assignment covers this booking. Ask your organization admin to assign you to a Program that covers SUBSCRIPTION."
- DB: no `Subscription`, no `Payment`.

**Probe further:**

- "covers SUBSCRIPTION" shows a raw enum. **COPY** (P2): it should read "subscriptions".
- Does the checkout page warn before submit that the org can't fund this plan, or hide the option?

## SU-34 — Org-funded plan: H1 schedules, both sides and the org agree on times

**Why it matters:** three dashboards in three roles must show the same sessions.

**Setup:** SU-31's plan with week 1 scheduled by H1 (step 2 of SU-32). Use DR instead of B4 if available, so the learner is in Sydney.

**Steps:**

1. R-03 and R-05 for the appointment. Convert each `startsAt` to IST and to the learner's zone.
2. Open: H1's Appointments, the learner's Appointments, OS's org view of the booking, ST's booking view.

**Expect:**

- DB: 3 live occurrences, `isTentative = false`, `consultantProfileId` = H1, `Subscription.status = APPROVED`. R-05 → zero rows. R-06 → plan week 1 = 3.
- UI: every surface lists the same 3 sessions. H1 sees IST, the learner sees their zone (for DR, IST + 5:30, so 09:00 IST shows as 14:30 Sydney), OS sees IST (OS's profile zone).
- The org view shows times and status only, no notes or documents.

**Cross-check:** bell and outbox for the learner ("sessions scheduled"), none for OS unless the org opts in (record).

**Probe further:**

- Does OS's view say who scheduled (expert vs org)?
- If the learner cancels later, the refund goes back to the org's wallet in-ledger (SU-76).
