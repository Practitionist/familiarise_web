# 04-e · Subscriptions: plan-week pacing and the weekly cap at every door

**Needs:** SU-35 (B2's plan with week 1 placed), SU-37 (B3's plan), F-PL1 months plan. Some cases shift clocks with owner-approved SQL (see `_shared/personas-and-fixtures.md` §4). Preview OK.
**Personas:** H1 (IST), B2 (London), B3 (LA), B1 (IST).
**Docs under test:** `lib/booking/entitlement.ts` (`subscriptionEntitlement`: "a consultant may schedule a week ahead, never further"), decision 7 ("Quotas are per day, per plan week and per plan total"), `lib/booking/session-return-rules.ts`.

**The pacing rule:** the open plan week is the current one, or the next one once the current week is full. Nothing further ahead. `nextBatch` = min(room left in that week, sessions left in the plan). Weeks never roll over: a week that ends with room left loses it (refunded at plan end).

**The question these cases answer:** is there any door that lets a plan week hold more than `sessionsPerWeek`, or a plan more than `sessionsTotal`, or any monthly cap? After every case run R-06 for the plan touched: no plan week above `sessionsPerWeek`, `live_sessions + sessionsReturned + sessionsRefunded ≤ sessionsTotal`, nothing at or after `planEndsAt`.

## SU-51 — Week 2 opens only when week 1 is full; week 3 never

**Why it matters:** experts must not front-load a plan.

**Steps:**

1. As H1, open B2's allocate page (week 1 full from SU-35). Read the heading. Navigate to week 2, then week 3.
2. Pick 3 sessions in week 2. Save.
3. Read the heading. Navigate to week 3 and click a free cell.
4. Replay a manual body with 1 session in week 3.

**Expect:**

- Step 1: heading "Week 2 of 4 · pick 3 for <week 2 range> · 3 of 12 booked". Week 2 cells are pickable; week 3 cells paint "Outside period" or "Limit reached".
- Step 2: 200; R-06 shows week 1 = 3, week 2 = 3.
- Step 3: heading "Week 2 of 4 is set · next opens <first day of week 3> · 6 of 12 booked". Week 3 click → toast refusing it.
- Step 4: 400 `VALIDATION_ERROR`, "A subscription is scheduled one plan week at a time. Pick times inside the open week shown on the calendar."

**Cross-check:** B2 sees 6 sessions across two weeks. The Requests row for B2 no longer asks for action (record its state).

**Probe further:**

- With both weeks full, click **Auto-schedule this week**. What happens? Expect a refusal or a "nothing to place" answer (`noChange`); a 500 is a **BUG**.
- Does the heading's "next opens" date match the first day of week 3 in IST? For B2 in London the same instant is 18:30 the day before; does B2's side show any "next sessions get scheduled on…" hint?

## SU-52 — The next week opens on its own date, with a nudge

**Why it matters:** when a week is delivered, the next week must open and the expert must be told.

**Setup:** B3's plan (SU-37, week 1 placed). Ask the owner to approve shifting B3's three week-1 sessions into the past and marking them done, and moving the plan start back eight days. SU-37's plan starts tomorrow, so a 7-day shift would leave today on the last day of week 1; 8 days makes today the first day of plan week 2:

```sql
BEGIN;
UPDATE "Subscription" SET "schedulingPeriodStartsAt" = "schedulingPeriodStartsAt" - interval '8 days',
  "planEndsAt" = "planEndsAt" - interval '8 days' WHERE id = :sid RETURNING id;
UPDATE "AppointmentOccurrence" SET "startsAt" = "startsAt" - interval '8 days', "endsAt" = "endsAt" - interval '8 days',
  "completionStatus" = 'COMPLETED' WHERE "appointmentId" = :aid AND "deletedAt" IS NULL RETURNING id;
COMMIT;
```

**Steps:**

1. As H1, open Home and Requests. Read B3's row.
2. Open B3's allocate page.
3. As B3, open Home.

**Expect:**

- UI (H1): Requests badge "Next cycle open"; action **Schedule the next 3**; state line "Week done · the next 3 to be scheduled."
- UI (allocate): heading "Week 2 of 4 · pick 3 for <range> · 3 of 12 booked".
- UI (B3): the booking shows 3 completed sessions and that the next week is waiting on the expert (record copy).

**Cross-check:** the week-nudge email to H1 is a sweep (`expire-stale-requests` runs `nudgeUnplacedPlanWeeks`): mark that part NEEDS-OWNER-RUN and give the R-07 query for H1's outbox. It is due from 09:00 in H1's zone on the week's first day for every plan, however week 1 was placed (Auto or by hand), and no job places week 2 on its own: after the run B3's plan still holds 3 sessions until H1 clicks. 12 (`SW-`) owns the sweep.

**Probe further:** "cycle" (badge) vs "week" (heading) again. Does B3 (LA) see "this week" boundaries in IST without explanation?

## SU-53 — The last plan week asks for a full week, and nothing lands after the plan end

**Why it matters:** the old stub week asked for 3 sessions in a few hours.

**Setup:** B3's plan after SU-52. Shift once more so today is the first day of plan week 4 (owner-approved; same SQL with `14 days`, completing week 2 and 3 sessions you place first, or simply shift start and end by 14 more days with weeks 2–3 left empty).

**Steps:**

1. As H1, open B3's allocate page. Read the heading and the selectable window.
2. Pick 3 sessions on the last three open days of week 4. Save.
3. Replay a body with one session starting exactly at `planEndsAt` (00:00 IST) and one starting 30 minutes before it but 60 minutes long.

**Expect:**

- Step 1: "Week 4 of 4 · pick 3 for <range> · <held> of 12 booked". The window ends at `planEndsAt` (exclusive). No "Week 5".
- Step 2: 200 if the days fit (a session may end exactly at `planEndsAt`).
- Step 3: 400 `VALIDATION_ERROR` (outside the plan week or the scheduling period). R-06: nothing at or after `planEndsAt`.

**Probe further:** weeks 2–3 left empty in this setup lost their sessions. Does the allocate page or H1's Home say "6 sessions will not be held" before the plan ends? Does B3's?

## SU-54 — A plan's total is a hard ceiling

**Why it matters:** `PLAN_TOTAL_REACHED` must hold even when a week has room.

**Setup:** as H1 publish `qa-SU-54`: **1 week**, 3/week, 1 h, ₹300. B1 buys it starting tomorrow [local]; H1 places all 3.

**Steps:**

1. Read the heading.
2. Replay a manual body with one more session in the same week.
3. As ST, if staff can allocate with `topUp: true`, replay with that flag.

**Expect:**

- Step 1: "All 3 sessions booked".
- Step 2: 400 `VALIDATION_ERROR` with "That's more sessions than this plan week has room for. Remove a time, or place it next week." or "Every session this plan includes already has a time. Remove a time to place a new one." (both rules fail; the first finding decides). Record which.
- Step 3: same refusal; no 4th session.

**Probe further:** "place it next week" is wrong advice when there is no next week. **COPY** (P2) if that copy wins here.

## SU-55 — Months plan: weeks only, no month boundary rule

**Why it matters:** no monthly pacing (decision 7).

**Setup:** H1's months plan (2 months × 2/week × 90 min) bought by B1 [local] starting so that week 2 crosses a calendar-month boundary (e.g. start 25 Nov; week 2 = 2–8 Dec).

**Steps:**

1. As H1, open the allocate page. Read the heading.
2. Auto-schedule week 1, then place week 2 by hand with both sessions in December.

**Expect:**

- Heading "Week 1 of 9 · pick 2 for … · 0 of 16 booked" (two calendar months span 9 plan weeks; 16 sessions = 8 full weeks).
- Both weeks save. No refusal mentions a month. R-06: weeks 1–2 = 2 each; 90-minute sessions.

**Probe further:**

- 9 plan weeks hold room for 18 sessions but 16 were sold. The buyer can't use week 9 fully. Is "Week 1 of 9" explained? Does H1's last week say "pick 2" when only `remaining` is left?
- Search the page for "Month" (SU-10).

## SU-56 — Weekly cap at the consultee's reschedule door

**Why it matters:** a buyer must not be able to move a session into a full week.

**Setup:** B2's plan, weeks 1 and 2 full (SU-51), all sessions at least 24 h away (shift with SQL if not).

**Steps:**

1. As B2, open the plan's detail, choose a week-1 session, **Reschedule**. Read the picker's selectable window.
2. Propose a time inside week 1 on a free day. Submit.
3. As H1, accept.
4. As B2, reschedule another week-1 session and try to pick a time in week 2 (the picker should not offer it). Then replay the reschedule POST with a week-2 proposal via `evaluate_script`, and have H1 accept.

**Expect:**

- Step 1: the picker clamps to week 1 (`rescheduleWindow`), starting 24 h from now.
- Steps 2–3: proposal created (`RescheduleRequest` open, the released occurrence tentative `RESCHEDULED`); accept moves it; R-06 week 1 still 3.
- Step 4: either the POST is refused, or the accept is refused with the plan-week copy (400 `VALIDATION_ERROR`) and the booking is restored. Never week 2 = 4. Record where it was stopped.

**Cross-check:** H1's side shows the proposal in IST, B2's in London time.

**Probe further:** if the refusal happens only at accept, H1 is the one who sees an error for B2's mistake. **ERROR-HANDLING** (P2).

## SU-57 — Weekly cap at the expert's reschedule door

**Steps:**

1. As H1, open B2's appointment, **Reschedule** a week-1 session (≥ 24 h away). Propose a new time in week 2 (full) and submit.
2. As B2, accept.

**Expect:** the picker should not offer week 2. If forced, the accept is refused with the plan-week copy, the session is restored (`restoredAt` set, costs no reschedule), and R-06 is unchanged.

**Probe further:** does a refused accept still count against H1's 2-per-booking cap (SU-66)? It shouldn't (`restoredAt`).

## SU-58 — A returned session reopens room in its week and extends the plan

**Why it matters:** the return door changes both the week's count and the plan length.

**Setup:** B2's plan with a week-2 session at least 24 h away.

**Steps:**

1. As B2, **Return to plan** on one week-2 session (full journey in SU-68).
2. As H1, open the allocate page. Read the heading. Try to place 2 sessions in week 2.

**Expect:**

- After return: `sessionsReturned = 1`, `planEndsAt` + 7 days (R-06).
- Heading counts one more plan week ("of 5" for the 4-week plan) and week 2 shows room for 1.
- Placing 2 → 400 `VALIDATION_ERROR` ("That's more sessions than this plan week has room for…"). Placing 1 → 200.

**Probe further:** the plan now has 5 weeks for 12 sessions. Does B2's detail page show the new end date? Is "Your plan is extended by 7 days" true on every surface?

## SU-59 — No make-up or free rebook door for an ordinary subscription session

**Why it matters:** every door that places time must respect the cap; doors that shouldn't exist must not.

**Steps:**

1. As H1, look at a subscription session's menu for "Make-up", "Cancel this session" or "Rebook". Record what exists.
2. As H1, `POST /api/appointments/[B2 aid]/occurrences/[occ]/make-up` with a valid body shape copied from a class (06), and `…/occurrences/[occ]/cancel`.
3. As B2, open `/dashboard/consultee/[B2 uid]/appointments/[aid]/rebook`.

**Expect:**

- UI: no make-up or per-session cancel for subscriptions.
- API: both POSTs refused with a typed 4xx (these doors are class-only); record status, code and copy. No rows written.
- Rebook page: "There is nothing to rebook here" (the free rebook exists only for an outage-voided session with an open remedy).

**Probe further:** the rebook page's text "This session was already rebooked or refunded, or its refund is now on its way." is shown for a booking that was never voided. **FALSE-INFO** (P3).

## SU-60 — Quota invariants across every SU plan

**Why it matters:** one last check that no door broke the caps.

**Steps:**

1. R-08 for `qa-SU` subscriptions plus the plans bought in this folder.
2. Run R-06 (both queries) for each.
3. Run R-05 for H1, H2 and H4.

**Expect:** zero overlap rows; no plan week above `sessionsPerWeek`; no IST day with 2 sessions of one plan; `live_sessions + sessionsReturned + sessionsRefunded ≤ sessionsTotal`; nothing at or after `planEndsAt`.

**Probe further:** list any plan whose week count in the heading disagrees with `planEndsAt`.
