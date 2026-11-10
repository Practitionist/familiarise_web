# 01-b · Setup: plans, the org-hosted plan and the busy block

**Needs:** 01-a (S-01…S-07). S-17 needs local `next dev` for mock pay.
**Personas:** H1, H2 (IST), OX (IST), OH, B3 (America/Los_Angeles).
**Docs under test:** `docs/decisions/2026-11-09-scheduling-surfaces-and-feasibility.md`, `lib/booking/feasibility.ts`, `components/offerings/editor/manifests.ts`, `schemas/plans.ts`.

Editor facts for every case here (verified in code):

- New offerings open at `/dashboard/consultant/[cid]/offerings/{consultation|subscription|webinar|class}/new`. The footer has **Save draft** and **Publish** (Publish reads **Save changes** once published).
- Toasts: "Offering published" / "It's now visible to buyers."; "Draft saved" / "Only you can see this until you publish it."; failures "Couldn't publish" / "Couldn't save" with the server's sentence.
- Required on every type: Title, Description, Topics, Learning outcomes, level/language. Prefix every title with `qa-S-nn`.
- Consultation: "Price (₹)" ("Use ₹0 for a free offering.") and "Duration (hours)" (0.5 steps, up to 8).
- Subscription: "Sessions per week" (1–7), "Session duration (hours)" (30 min–4 h), "Plan length" (presets 4/8/12/26/52 weeks or "Custom number of weeks"), Trial section ("Offer a trial session", "Trial length (minutes)" 15–120 in 15-min steps, "Trial price (₹)" in whole rupees).
- The subscription publish path runs the feasibility gate (`planPublishFeasibility`, 4 weeks of published hours, 1 session a day, headroom 1.25×). A refusal is 422 `PLAN_NOT_FEASIBLE`; a success returns `feasibilityWarnings` in the JSON. **No editor component reads `feasibilityWarnings`**, so the expert never sees them: check the network panel on every subscription save and report the missing UI.

After all plan cases, run R-02 for H1 and H2 and paste the rows.

## S-08 — F-PL1a: H1 consultation, 60 min, ₹500

**Why it matters:** the default priced 1:1 offering for every consultation case.

**Steps:**

1. As H1 open `/dashboard/consultant/[H1 cid]/offerings/consultation/new`.
2. Title "qa-S-08 Strategy call 60", description, one topic, one learning outcome. Price 500. Duration 1.
3. Click **Publish**.
4. Open `/dashboard/consultant/[H1 cid]/sell/sessions` and find the card.
5. Open `/explore/experts/[H1 cid]` as B1.

**Expect:**

- UI: "Offering published" toast; redirect to the Sell page; the card shows ₹500 and 60 min (or "1 hour"). No raw enum (`SCHEDULED`, `PUBLISHED`) on the card.
- DB: `SELECT id, title, price, "durationInHours", status, "organizationId", "archivedAt" FROM "ConsultationPlan" WHERE title LIKE 'qa-S-08%'` → `price = 50000` (the column is paise; the editor edits rupees and the adapter divides by 100), `durationInHours = 1`, `organizationId` NULL.
- Explore: the plan is offered with ₹500; Book Now lists 60-min starts inside F-AV1 only.

**Probe further:** try Duration 0.75 before publishing: the field or the server must refuse (30-minute steps). Quote the message. Try price −1 and 0.5. Does the preview link ("Preview public page") work for a draft?

## S-09 — F-PL1b: H1 consultation, 30 min, free

**Why it matters:** free paths skip the gateway entirely; 03 and 08 build on it.

**Steps:**

1. As H1 create a consultation: "qa-S-09 Intro call 30", price 0, duration 0.5. Publish.
2. As B1 open the explore page and look at the price shown.

**Expect:**

- UI: published; the card and explore page say "Free" (or ₹0; record which). No "₹0.00" next to a "Pay" button.
- DB: price 0, `durationInHours = 0.5`.

**Probe further:** does the explore page's CTA change from "Pay" to "Book" for a free plan? Is there any copy that implies payment?

## S-10 — F-PL1c: the "request/approval" consultation

**Why it matters:** `_shared` asks for a 45-min priced consultation in request mode. Both halves are impossible as written: 45 min is off the 30-minute grid, and the booking mode is per expert (S-07). This case records both and creates the legal stand-in.

**Steps:**

1. As H1 start a consultation: "qa-S-10 Deep dive 45", price 750, Duration 0.75. Click Publish. Read the error.
2. Change Duration to 1.5. Publish.

**Expect:**

- Step 1: refused before save (field message about 30-minute steps) or by the server with a 400. Record which layer and the text. Nothing in the DB.
- Step 2: published; DB `durationInHours = 1.5`, price 750.
- The editor has no booking-mode field. 03's request/approval cases use this 90-min plan with H1 switched to "Review requests first" (S-07).

**Probe further:** report **DOC-DRIFT** on F-PL1 (45 min and per-plan mode). Ask whether a per-plan mode is planned (it would be a product question, not a bug).

## S-11 — F-PL1d: H1 weeks plan, 4 weeks × 3/week × 60 min, free 30-min trial

**Why it matters:** the main subscription for 04 and the free-trial plan for 07.

**Setup:** read the platform trial floor: `SELECT "minTrialPriceInPaise" FROM "PlatformPricingConfig" WHERE id = 'singleton';`. If it's above 0, a free trial is refused with 400 "Trial price must be at least ₹X": record it, mark the free-trial half BLOCKED, and tell 07 (its free-trial cases depend on a 0 floor).

**Steps:**

1. As H1 open `/dashboard/consultant/[H1 cid]/offerings/subscription/new`.
2. "qa-S-11 Four-week sprint", price 6000, Sessions per week 3, Session duration 1, Plan length preset **4 weeks**. Read the plan-length summary line.
3. Trial: switch "Offer a trial session" on; length 30; price 0.
4. Open the network panel. Click **Publish**.

**Expect:**

- UI: the length summary reads "4 weeks · 12 sessions. The price is for the whole plan." (exact wording from `planLengthLabel`; quote it). "Offering published".
- API: `POST /api/plans/subscriptions` → 201; `feasibilityWarnings` is `[]` (F-AV1 holds 6 sessions a week at 1 a day, which clears 3 × 1.25 = 4).
- DB (R-02): `sessionsPerWeek = 3`, `sessionDurationInHours = 1`, `durationInWeeks = 4`, `totalSessions = 12`, `trialEnabled = true`, `trialDurationMinutes = 30`, `trialPriceInPaise = 0`, `status = 'PUBLISHED'`.

**Probe further:** does any copy in the editor still say "Month N" or "monthly"? Is "₹0 trial" friction present ("the plan form adds deliberate friction" per `schemas/plans.ts`)? Quote it.

## S-12 — F-PL1e: H1 months plan, 2 months × 2/week × 90 min, paid ₹100 trial

**Why it matters:** months plans must keep working, but the editor creates weeks plans only. This case proves that and creates the months plan through the API the editor uses.

**Steps:**

1. As H1 open the subscription editor. Look for a months option in "Plan length". There is none for a new plan (presets are weeks; the months field appears only on plans already sold in months).
2. Create the plan through the API from the signed-in page (`evaluate_script`):

   ```js
   await fetch("/api/plans/subscriptions", { method: "POST", headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ title: "qa-S-12 Two-month track", description: "qa-S-12 months fixture for QA",
       durationInMonths: 2, durationInWeeks: null, price: 900000, sessionsPerWeek: 2, sessionDurationInHours: 1.5,
       trialEnabled: true, trialDurationMinutes: 30, trialPriceInPaise: 10000,
       language: "English", level: "BEGINNER", topics: ["qa"], learningOutcomes: ["qa outcome"], status: "PUBLISHED" }) })
     .then(r => r.json().then(b => ({ status: r.status, b })));
   ```

   The API takes paise (`price: 900000` = ₹9,000). If Zod refuses a field (level vocabulary, outcome shape), fix the field from the error and retry; record what you changed.

3. Open the plan in the editor (`…/offerings/subscription/[id]/edit`).

**Expect:**

- API: 201 with `feasibilityWarnings: []`.
- DB: `durationInWeeks` NULL, `durationInMonths = 2`, `sessionsPerWeek = 2`, `sessionDurationInHours = 1.5`, `totalSessions` = months × 4 × per week = 16 (record the real value and compare with docs), `trialPriceInPaise = 10000` (₹100).
- Editor: "Duration (months)" field with "This plan is sold in months; clients who already bought it keep their current terms."

**Probe further:** the trial price field is labelled "Trial price (₹)" but the column is `trialPriceInPaise`. Open the editor and read what it shows for 10000 paise: "100" is right, "10000" is a P1 money display bug. Report as **DOC-DRIFT** that F-PL1's months plan can't be made in the UI.

## S-13 — Feasibility signals while creating a subscription (H2)

**Why it matters:** the decision record promises "feasibility before money": an impossible plan can't be published, a draft saves with warnings. Depth (every reason, edits of published terms) lives in 04-subscriptions; this case proves the gate is wired and checks what the expert actually sees.

**Setup:** F-AV2 (H2: 3 × 180-min evenings, 2 × 120-min mornings).

**Steps (as H2, subscription editor, network panel open):**

1. "qa-S-13a", price 4000, 6 sessions/week, 1 h, 4 weeks. **Publish**.
2. Same values. **Save draft**.
3. "qa-S-13b", 3/week, 2.5 h, 4 weeks. **Publish**.
4. "qa-S-13c", 2/week, 3.5 h, 4 weeks. **Publish**.
5. Archive or delete the drafts you created (Offerings card), or leave them and list them.

**Expect:**

- Step 1: 422 `PLAN_NOT_FEASIBLE`; toast "Couldn't publish" with "This plan can't be delivered from your published availability. The plan needs 6 sessions a week (at most 1 a day), but the published hours fit at most 5 in any week. Add hours, shorten the sessions or lower the sessions a week, or save it as a draft." Nothing saved (SQL by title).
- Step 2: 201, `status = 'DRAFT'`, `feasibilityWarnings` contains `TOO_FEW_OPEN_HOURS`. The UI shows "Draft saved" and **no** warning: report MISSED-OPPORTUNITY (P2) unless a warning is visible.
- Step 3: 201 PUBLISHED with `feasibilityWarnings` containing `LOW_HEADROOM` ("The published hours fit only 3 sessions in the best week, so one busy day can leave a week short."). Again check whether the expert sees it.
- Step 4: 422 with `SESSION_LONGER_THAN_WINDOWS`: "Each session is 210 minutes, but the longest published window is 180 minutes."

**Cross-check:** none.

**Probe further:** does the class editor run any feasibility check (it shouldn't by this PR; 06 owns classes)? Does the toast wrap a long sentence readably at 390 px?

## S-14 — F-PL2a/b: H2 webinars (90 min × 5 seats priced; 60 min free)

**Why it matters:** fixture for 05-webinars. Webinar time picking is 05's subject; here only create and assert.

**Steps:**

1. As H2 open `/dashboard/consultant/[H2 cid]/offerings/webinar/new`. "qa-S-14a Webinar 90", price 300, Duration 1.5, Max participants 5.
2. In "Scheduled for" (the day-strip picker) pick D+2 (Wed) 18:00 IST ("Free"). Publish.
3. Create "qa-S-14b Webinar 60 free": price 0, Duration 1, 5 seats, D+4 (Fri) 18:00 IST. Publish.

**Expect:**

- UI: the Sessions description reads "Required before publishing. Pick a time on your own calendar; it must be on the half hour and at least an hour away." Publishing without a time is blocked with "Add a session time before publishing."
- DB: two webinars; each occurrence on :00/:30 UTC (18:00 IST = 12:30Z) and `endsAt − startsAt` = 90 and 60 min respectively. R-05 for H2: zero rows.

**Probe further:** none here; 05 owns the picker.

## S-15 — F-PL2c/d: H2 class (2/week, 60 min, 5 seats, start ≈ D+10) and a draft class

**Why it matters:** fixture for 06-classes.

**Steps:**

1. As H2 create a class: "qa-S-15a Class", price 2400, Duration (months) 1, Max participants 5, Sessions per week 2, Session duration 1, Start date ≈ D+10 (a Monday or Wednesday inside F-AV2's evening hours if the editor asks for a time). Publish.
2. Create "qa-S-15b Draft class" with no start date. Click **Save draft**.

**Expect:**

- Step 1: published; generated occurrences at the start's local time and weekday, spread (2/week, e.g. day 0 and day +3). R-02 class row `sessionsPerWeek = 2`, `sessionDurationInHours = 1`, `totalSessions` recorded. R-05 for H2: zero rows.
- Step 2: "Draft saved". Publishing it is blocked with "Add a start date before publishing." The Sell → Programs card shows "Schedule now" (06 tests where it leads).

**Probe further:** if any generated session lands outside F-AV2 hours, note it (allowed for host-set times, but 06 checks the labels).

## S-16 — F-PL3: OX's LearnPro-hosted consultation

**Why it matters:** org-hosted earnings and the OH dashboard need one consultation on a plan the HOST org owns. Org catalogs create only webinars and classes (`/dashboard/organization/[orgId]/catalog/[type]/new` accepts `webinar | class`), and the consultation plan API takes no org field, so an org-hosted consultation can't be created in the UI.

**Steps:**

1. SQL: `SELECT id, title, price, "durationInHours", status, "organizationId" FROM "ConsultationPlan" WHERE "consultantProfileId" = :oxCid AND "archivedAt" IS NULL;`
2. If a published 60-min priced plan with `organizationId` = LearnPro exists, use it and stop here.
3. Otherwise, as OX create "qa-S-16 LearnPro call 60", price 800, duration 1, Publish. Then ask the owner to approve: `UPDATE "ConsultationPlan" SET "organizationId" = :learnProOrgId WHERE id = :planId RETURNING id, "organizationId";` (reason: org-hosted plans can only be seeded).
4. As OX open the plan's edit page and try to archive it.

**Expect:**

- One org-hosted consultation plan for OX. Step 4: the archive or edit is refused with 403 (`PLAN_ORG_GOVERNED_RESPONSE`); record the copy.
- OX needs availability for 03 to book this plan. If OX has none, add Mon–Fri 10:00–13:00 IST through OX's availability page and record it as **F-AV5**.

**Cross-check:** OH `/dashboard/organization/[LearnPro]/catalog` lists the plan (or doesn't; record which).

**Probe further:** report the missing UI path to create an org-hosted 1:1 plan as a product question.

## S-17 — F-BUSY: B3 books H1's 60-min consultation at Tue D+1 18:00 IST `[local]`

**Why it matters:** every heat-map case needs one real booked block on H1's grid.

**Setup:** local `next dev` (mock pay). B3 zone `America/Los_Angeles`.

**Steps:**

1. As B3 open `/explore/experts/[H1 cid]`, choose "qa-S-08 Strategy call 60", Book Now.
2. Pick Tue D+1. Find the time that is 18:00 IST. B3 sees it as 04:30 PST (05:30 PDT before 1 Nov). Quote what the pill says.
3. Continue to `/checkout/plans/consultation/[planId]`. Read the summary (date, time, zone, price). Click **Mock Pay (Razorpay)**.
4. Read the success copy.

**Expect:**

- UI: "Mock payment processed. Your consultation has been confirmed. Check your dashboard for details."
- DB (R-03, R-04): one `Appointment` (CONSULTATION) with one occurrence `startsAt` = Tue D+1 12:30Z, `endsAt` 13:30Z, `isTentative = false`; consultation status confirmed (record the exact value: `SCHEDULED` or `APPROVED`); `Payment` `SUCCEEDED`, `isMockPayment = true`, amount ₹500 (50000 paise, or with tax; record `taxAmount`). R-05 for H1: zero rows.
- Earnings row for H1 with `holdUntil` set (record).

**Cross-check:**

- B3 appointments (`/dashboard/consultee/[B3 uid]/appointments`): Tue D+1 04:30 PST.
- H1 appointments and home: Tue D+1 18:00 IST, client B3.
- H1's grid (any allocate or reschedule grid, see 02) shows a "Booked" block over 18:00–19:00.
- Bell for H1 ("new booking") and outbox (R-07) for both parties.

**Probe further:** record the fixture ids (appointment, occurrence, payment) in the ledger as **F-BUSY**; later folders must not cancel it. Does B3's confirmation email subject show B3's zone?
