# 04-a · Subscriptions: plan editor, cadence and length

**Needs:** F-AV1, F-AV2, F-PL1 (weeks and months plans). Preview OK (no money moves).
**Personas:** H1 (IST), H2 (IST), B1 (IST) for the public view, B2 (Europe/London) for one buyer-side check.
**Docs under test:** `docs/decisions/2026-11-09-scheduling-surfaces-and-feasibility.md` (decision 7), `docs/booking/16-recurring-events-journey.md` §2a, `schemas/plans.ts` (`PlanCadenceSchema`), `lib/booking/entitlement.ts` (`subscriptionPlanTotals`, `planLengthLabel`, `purchaseTermsOf`).

The editor lives at `/dashboard/consultant/[cid]/offerings/subscription/new` and `…/offerings/subscription/[planId]/edit`. The "Pricing & cadence" section holds **Sessions per week**, **Session duration (hours)** and **Plan length**. Every new plan is a **weeks** plan (presets 4, 8, 12, 26, 52 weeks, or a custom 1–52). A plan already sold in months shows **Duration (months)** instead.

Every case: run `list_console_messages` after each save, and R-02 for H1 (or H2) after each successful save.

## SU-01 — Create a weeks plan from the editor

**Why it matters:** the plan row is what checkout freezes onto every buyer; a wrong total is sold to everyone.

**Setup:** none beyond F-AV1.

**Steps:**

1. As H1, open `/dashboard/consultant/[H1 cid]/offerings/subscription/new`.
2. Title `qa-SU-01 weeks plan`, any description, price ₹1,200, Sessions per week `3`, Session duration `1`.
3. In **Plan length**, click each preset in turn (4, 8, 12, 26, 52 weeks) and read the hint under the buttons after each click.
4. Leave **4 weeks** pressed. Save as published.

**Expect:**

- UI: the hint reads `4 weeks · 12 sessions. The price is for the whole plan.` for 4 weeks, and `8 weeks · 24 sessions.`, `12 weeks · 36 sessions.`, `26 weeks · 78 sessions.`, `52 weeks · 156 sessions.` for the others. The pressed preset has `aria-pressed="true"`; the others `false`.
- API: `POST /api/plans/subscriptions` → 201; body has `feasibilityWarnings: []` (H1's hours fit 6 a week, which is at least 1.25 × 3).
- DB (R-02): `durationInWeeks = 4`, `durationInMonths = 1` (derived: round(28 ÷ 30.44)), `totalSessions = 12`, `sessionsPerWeek = 3`, `sessionDurationInHours = 1`, `status = PUBLISHED`. `totalHours = 12` if you select it.

**Cross-check:** as B1, open `/explore/experts/[H1 cid]`: the plan card reads "4 weeks · 12 sessions" (or equivalent) and ₹1,200 for the whole plan, not per month or per week. As B2 (London) the same card shows the same numbers.

**Probe further (report anything odd):**

- Does any public surface call it "1 month" because `durationInMonths = 1`? That would be **FALSE-INFO** (it is 28 days).
- Change Sessions per week to 5 without saving: does the hint update live (`4 weeks · 20 sessions`)?
- Is the price label clear that it is the whole-plan price, on the card and on checkout?
- Archive this plan at the end of the folder (don't delete; other cases may reference it).

## SU-02 — Plan length bounds (custom weeks)

**Why it matters:** a 0-week or 60-week plan would be sold with nonsense totals.

**Setup:** start a new subscription plan as H1, Sessions per week `2`.

**Steps:**

1. Type `1` in **Custom number of weeks**. Read the hint.
2. Type `52`, then `53`, then `0`, then clear the box. Try to save after each value.
3. Type `2.5`.

**Expect:**

- UI: `1` → hint `1 week · 2 sessions.` (singular "week"). `52` → `52 weeks · 104 sessions.` `53` → save blocked with "A plan runs at most 52 weeks". `0` → "A plan runs at least 1 week". Empty → hint `Pick a length from 1 to 52 weeks. The price is for the whole plan.` and save blocked with a required-field message. `2.5` → the box parses to 2 (it uses `parseInt`); report whether the UI shows 2 or silently drops the .5.
- API: no request for blocked saves (check `list_network_requests`).
- DB: no new plan row for refused values.

**Cross-check:** none.

**Probe further:**

- Does the custom box keep focus and the typed value after an error, or reset to a preset?
- Is the error placed under the field and linked with `aria-describedby`?
- Does a preset button clear the custom box?

## SU-03 — Sessions per week must be a whole number from 1 to 7

**Why it matters:** decision 7 says every plan door parses one cadence schema; a fractional cadence breaks plan-week maths.

**Steps:**

1. In a new H1 subscription plan, type Sessions per week `0`, save. Then `8`. Then `2.5`. Then `-1`.
2. Read the field description.

**Expect:**

- UI: description `From 1 to 7 sessions a week.` `0` → "At least one session per week is required". `8` → "Cannot exceed 7 sessions per week". `2.5` → "Sessions per week must be a whole number" (or the browser's step validation; record which wins). `-1` → the min message.
- API: none sent for refused values.

**Probe further:**

- Arrow-key the number input from 7 upward: does it stop at 7?
- Does the Plan length hint show `NaN sessions` or similar while the field is invalid? (**COPY**)

## SU-04 — Session length on the 30-minute grid

**Why it matters:** a 45-minute session was once sold as 45 and booked as 60.

**Steps:**

1. New H1 plan. Session duration `0.75`, save. Then `0.25`, `4.5`, `1.5`, `4`.
2. Read the field description.

**Expect:**

- UI: description `Hours per session, from 30 minutes to 4 hours.` `0.75` → "Session duration must be in 30-minute increments". `0.25` → "Session duration must be at least 30 minutes". `4.5` → "Session duration cannot exceed 4 hours". `1.5` and `4` are accepted.
- DB: a saved `1.5` plan has `sessionDurationInHours = 1.5`.

**Probe further:**

- The description never says "30-minute steps" for subscriptions while the class editor's does (`Hours per session, in 30-minute steps, up to 4.`). Report the inconsistency as **COPY** (P3) and note the stale comment above `sessionDurationField` in `components/offerings/editor/manifests.ts` claiming subscriptions have no 30-minute refine.
- Type `1.25`: what message appears, and does it match `0.75`'s?

## SU-05 — The API door enforces the same cadence (POST and PUT)

**Why it matters:** a guard that lives only in the form is no guard.

**Setup:** signed in as H1. Note H1's `consultantProfileId` from R-01 and the id of SU-01's plan.

**Steps (all with `evaluate_script` fetches, each a separate call):**

1. `POST /api/plans/subscriptions` with the SU-01 body but `sessionsPerWeek: 2.5`.
2. Same with `sessionsPerWeek: 0`, then `8`.
3. Same with `sessionDurationInHours: 0.75`.
4. `PUT /api/plans/subscriptions/[SU-01 id]` with `{ "sessionsPerWeek": 2.5 }`, then `{ "sessionDurationInHours": 0.75 }`.
5. `POST` with `durationInWeeks: 53`, then `durationInWeeks: 0`.

**Expect:**

- API: every call → 400 `{ error: "Validation failed", details: [...] }`, and the `details` messages match the editor messages in SU-02 to SU-04. Never a 500.
- DB (R-02): no new rows; SU-01's plan unchanged (`sessionsPerWeek = 3`, `sessionDurationInHours = 1`).

**Probe further:**

- Does the 400 carry a `code`? (It returns `error` + `details` only.) Note it for 13-copy.
- `POST` with `sessionsPerWeek` missing entirely: 400, or a plan with a default? Report the outcome.
- As B1 (no consultant profile), POST with H1's `consultantProfileId` → expect 403 "You do not have permission to create plans for this consultant profile".

## SU-06 — Months plan (sold in months) shows months and keeps months × 4 maths

**Why it matters:** existing months plans must not change length when weeks plans arrive.

**Setup:** F-PL1 months plan (2 months × 2/week × 90 min). New plans are weeks plans; if 01 had to create the months plan through the API (`durationInWeeks` omitted), say so.

**Steps:**

1. As H1, open the months plan's edit page.
2. Read the length field and its description.

**Expect:**

- UI: label **Duration (months)** (no week presets), value `2`, description `2 months · 16 sessions. This plan is sold in months; clients who already bought it keep their current terms.`
- DB (R-02): `durationInWeeks` null, `durationInMonths = 2`, `totalSessions = 16` (2 × 4 × 2), `sessionDurationInHours = 1.5`.

**Cross-check:** B1's view of the plan card says "2 months · 16 sessions".

**Probe further:**

- A 2-calendar-month plan holds about 8.7 weeks but sells 16 sessions (8 weeks × 2). The allocate heading later says "Week 1 of 9" (SU-56). Is that explained anywhere to the buyer?
- Is there any way in the UI to create a **new** months plan? If not, say so; the README fixture F-PL1 assumes one.

## SU-07 — A sold plan cannot switch between weeks and months

**Why it matters:** switching the unit under existing buyers would change what they were sold.

**Setup:** the months plan from F-PL1 has at least one `Subscription` row (from 07's trial conversion or an earlier buy). If not, use SU-01's weeks plan after SU-23 buys it.

**Steps:**

1. As H1, `PUT /api/plans/subscriptions/[sold plan id]` with `{ "durationInWeeks": 8 }` (months → weeks), via `evaluate_script`.
2. For the weeks plan: `PUT` with `{ "durationInWeeks": null, "durationInMonths": 2 }`.
3. Repeat step 1 on an unsold months plan you create via API (`durationInWeeks` omitted).

**Expect:**

- API: steps 1–2 → 409 `PLAN_LENGTH_UNIT_LOCKED`, error "Clients have bought this plan, so its length stays in the unit it was sold in. Publish a new plan to sell it in weeks." Step 3 → 200.
- DB: sold plans unchanged; the unsold one now has `durationInWeeks = 8`, `totalSessions = 8 × sessionsPerWeek`.

**Probe further:**

- Step 2's copy says "Publish a new plan to sell it in weeks" even when switching to months. **COPY** (P3) if so.
- Can the editor UI even express the switch? If not, the API is the only door; note it.

## SU-08 — Editing terms of a plan that has buyers: buyers keep their terms

**Why it matters:** a buyer who paid for 3 sessions a week must keep 3, even if the expert drops to 2.

**Setup:** SU-01's plan bought by B1 (SU-23) with week 1 allocated (SU-37).

**Steps:**

1. As H1, open SU-01's edit page. Read the **Pricing & cadence** section description.
2. Change Sessions per week from 3 to 2. Save.
3. Read the response body in the network panel.
4. Open B1's allocate page (`…/requests/[rid]/allocate`) as H1, and B1's appointment detail as B1.

**Expect:**

- UI: the section description reads `1 active client keeps their current terms. Changes apply to new buyers only.` before saving.
- API: `PUT` → 200 with `activeClients: 1`, `notice` = the same sentence, `feasibilityWarnings` array.
- DB: plan `sessionsPerWeek = 2`, `totalSessions = 8`; B1's `Subscription` still `sessionsPerWeek = 3`, `sessionsTotal = 12`, `sessionMinutes = 60` (R-06). If those columns were null before, the edit froze them to the old terms.
- Allocate heading for B1 still counts 3 a week and 12 total (e.g. `… · 3 of 12 booked`).

**Cross-check:** B1's detail page still shows 12 sessions. A new buyer (B2) checking out sees 2 a week and 8 sessions.

**Probe further:**

- Does the public plan page explain that terms changed? It shouldn't mention other buyers.
- Revert to 3 a week at the end (so other cases keep their numbers) and say you did.
- Edit only the price: is `activeClients` still reported, and does B1's refund base stay their paid amount (R-04)?

## SU-09 — Draft plans are invisible to buyers and refused at checkout

**Why it matters:** an unpublished plan must never be sold.

**Steps:**

1. As H1, create `qa-SU-09 draft` (2/week, 1 h, 4 weeks) and save it as a **draft** (find the draft control; record its label).
2. As B1, open `/explore/experts/[H1 cid]`. Look for the plan.
3. As B1, open `/checkout/plans/subscription/[draft id]` directly, pick a start date and try to pay.

**Expect:**

- DB: `status = DRAFT`.
- UI: the draft is absent from the expert page. Direct checkout either shows a not-available page or refuses on submit.
- API: `POST /api/checkout` → 409 `PLAN_NOT_PUBLISHED`, error "Subscription plan isn't available to book right now." (the label part may differ; record it). No `Subscription` or `Payment` row.

**Probe further:**

- Does the checkout page render the draft's price and title before refusing? That leaks unpublished details; report as **SECURITY** (P2) if so.
- `GET /api/plans/subscriptions/[draft id]` as B1: 404, or the plan? Record it.

## SU-10 — No monthly pacing anywhere

**Why it matters:** decision 7 deleted the monthly arm; a "Month N of M" counter would contradict the weekly one.

**Setup:** after SU-23 and SU-37 have run, so a live plan exists.

**Steps:**

1. As H1, visit: the editor for both F-PL1 plans, Requests, the allocate page of B1's plan (week and month views), Appointments list and B1's appointment detail, Home.
2. As B1, visit: expert page, checkout for both plans, Home, Appointments, the plan's detail.
3. On each, `take_snapshot` and search the text for: `Month 1`, `Month `, `per month`, `this month`, `monthly`, `cycle`.

**Expect:**

- UI: no "Month N of M" counter and no monthly session cap anywhere. Plan length "2 months" on the months plan is fine; it is a length, not a quota.
- The quotas shown are per day (1), per plan week (`sessionsPerWeek`) and per plan (`sessionsTotal`).

**Probe further:**

- Report every place that says "cycle" next to places that say "week" for the same thing (for example Home's `Schedule cycle 1` vs the allocate heading's `Week 1 of 4`). That is an **INCONSISTENCY** (P2): one concept, two words.
- Does the month view of the allocate grid count "N fit" per day for the plan's length (90 min for the months plan)? Grid detail belongs to 02; just note it.
