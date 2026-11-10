# 04-d · Subscriptions: scheduling the first plan week, partial weeks and warnings

**Needs:** SU-23 (B2 holds H1's 4-week plan, `PENDING`, paid). F-AV1, F-BUSY. Preview OK for allocation itself (the purchase needed local).
**Personas:** H1 (IST) allocating; B2 (Europe/London) viewing; B1 (IST) and ST for the authz probe.
**Docs under test:** `docs/booking/16-recurring-events-journey.md` §4, `docs/booking/23-allocator-objective-earliest-fit.md`, `docs/calendar/allocate-heatmap-ux.md`, `lib/booking/allocation/refusal-copy.ts`, `lib/booking/entitlement.ts` (`subscriptionEntitlement`, `subscriptionCycleHeading`), `utils/scheduling-engine/sessionCaps.ts`.

The allocate page is `/dashboard/consultant/[H1 cid]/requests/[rid]/allocate`, reached from Requests → **Schedule cycle 1**. Grid mechanics (hover preview, whole-session blocks, keyboard) are 02's (`HM-`). Here we test the **plan rules**: one plan week at a time, at most `sessionsPerWeek` in it, at most **1 a day** (in H1's zone), lead time 15 minutes for a paid plan, nothing after `planEndsAt`.

**How refusals come back:** the allocate route answers `{ error, errorCode, … }` (the key is `errorCode`, not `code` as on most other routes; note it once in the copy log). The plan-week checks are validator tags turned into plain copy: the HTTP answer is **400 with `errorCode: "VALIDATION_ERROR"`** and `error` set to the copy below. The tag (`PLAN_WEEK_FULL`, `OUTSIDE_PLAN_WEEK`, `PLAN_TOTAL_REACHED`, `DAILY_LIMIT`, `WEEKLY_LIMIT`, `TOO_SOON`, `CONFLICT`, `OUTSIDE_AVAILABILITY`) appears only in server logs and Sentry. A time taken between check and write is **409 `errorCode: "SLOT_TAKEN"`** ("One of these times was just booked. Pick another time and try again."). In the cases below, "400 `VALIDATION_ERROR`" means `errorCode`.

| Tag | Copy (verbatim) |
| --- | --- |
| `OUTSIDE_PLAN_WEEK` | A subscription is scheduled one plan week at a time. Pick times inside the open week shown on the calendar. |
| `PLAN_WEEK_FULL` | That's more sessions than this plan week has room for. Remove a time, or place it next week. |
| `PLAN_TOTAL_REACHED` | Every session this plan includes already has a time. Remove a time to place a new one. |
| `DAILY_LIMIT` | These times put too many sessions on one day. Spread them across more days. |
| `TOO_SOON` | One of these times has passed or starts too soon to confirm. Pick a later time. |
| `CONFLICT` | One of these times is already booked. Pick another time. |
| `OUTSIDE_AVAILABILITY` | One of these times is outside the expert's available hours or this plan's scheduling period. Pick another time. |

**Fixture P-B1 (for SU-38 to SU-42):** B1 buys SU-01's plan starting tomorrow [local] and nobody allocates it until SU-42 ends. Refusal cases replay bodies against P-B1, so it stays empty; if a replay ever succeeds, that is a FAIL, and you need a fresh P-B1.

To force a server refusal the UI prevents, copy the last allocate `PATCH` body from the network panel (`{ isAuto: false, slots: [ISO atom starts…] }`, two 30-minute atoms per 60-minute session) and replay it with `evaluate_script`, adding a fresh `Idempotency-Key`. After every successful allocation run R-03, R-05 (zero rows) and R-06.

## SU-35 — Auto-schedule week 1 spreads sessions

**Why it matters:** the auto search should leave a free day between sessions when it can, and only then pack.

**Steps:**

1. As H1, open Requests. Read B2's row (badge, action, deadline). Click **Schedule cycle 1**.
2. Read the heading, the context chips (Plan `3 a week · 1 hr each` or similar, week, plan end, zone) and the tray (`0 of 3 times picked`).
3. Click **Auto-schedule this week**.
4. Read the toast, the heading and the grid.

**Expect:**

- UI before: heading "Week 1 of 4 · pick 3 for <day0> – <day0 + 6> · 0 of 12 booked" (date format per locale).
- API: `PATCH /api/bookings/subscriptions/[sid]/allocate` with `isAuto: true` and an `Idempotency-Key` → 200.
- DB:
  - 3 occurrences, `isTentative = false`, `completionStatus = SCHEDULED`, `endsAt − startsAt = 60 min`, all inside `[schedulingPeriodStartsAt, day0 + 7 IST days)`, no two on the same IST day, at least 15 minutes after the request time.
  - Spacing: no two on adjacent IST days if H1's hours allow it. Example: day0 Wednesday → Wed, Fri, Mon (Thu and Sat are next to a pick; Sun is closed). Each at the earliest free time that day (09:00 IST unless today's lead pushes it later).
  - `Subscription.status` `PENDING → APPROVED`; a `BookingStatusHistory` row for it.
- UI after: heading "Week 2 of 4 · pick 3 for <day0 + 7> – <day0 + 13> · 3 of 12 booked" (week 1 full, so week 2 is open).

**Cross-check:** B2's Appointments lists 3 sessions in London time (09:00 IST shows as 03:30, the same date); B2's bell and an outbox row "sessions scheduled". H1's Home no longer shows "Schedule cycle 1". Requests row gone or changed (record). R-07 outbox for B2.

**Probe further (report anything odd):**

- Does the toast say how many were placed and in which week?
- Were the picks at the earliest times (doc 23 says earliest-fit)? If not, report what rule they seem to follow.
- B2 sees sessions at 03:30 London. Nothing in the flow considers the buyer's waking hours. Is that stated anywhere (e.g. "times are set in the expert's hours")? **MISSED-OPPORTUNITY** if the buyer gets no say and no warning.

## SU-36 — Auto packs adjacent days only when spacing can't hold the cadence

**Why it matters:** decision 7: spaced first, then one a day.

**Setup:** as H1, publish `qa-SU-36`: **4/week**, 1 h, 4 weeks, ₹400 (H1 fits 6 a week, so it publishes with `LOW_HEADROOM`). As B1, buy it starting next Monday. [local]

**Steps:**

1. As H1, open B1's allocate page. Click **Auto-schedule this week**.

**Expect:**

- DB: 4 sessions in plan week 1, at most 1 per IST day. With Mon–Sat open and Sun closed, 4 can't all be spaced (Mon, Wed, Fri are the only spaced trio before Sunday), so expect Mon, Wed, Fri plus one adjacent day (Tue, Thu or Sat, the earliest legal one). Never two on one day.
- R-05 zero rows. F-BUSY (Tue 18:00) is never overlapped.

**Probe further:** if the 4th lands on Tuesday, is it at 09:00 (earliest) rather than 18:00 (busy)? Report any session at a busy time as **DATA-INTEGRITY** (P0).

## SU-37 — Manual: pick three sessions and save

**Why it matters:** the hand path must follow the same rules.

**Setup:** a fresh purchase for this case: B3 buys SU-01's plan starting tomorrow. [local]

**Steps:**

1. As H1, open B3's allocate page. Click three free cells on three different days in week 1 (for example 10:00 IST on day 0, day 2, day 4).
2. Read the tray after each click (`Session 1 · <day> · <time range>`; `1 of 3 times picked`).
3. Hover **Save picked times** before the third pick and read its tooltip. Save after the third.

**Expect:**

- UI: tooltip before the third pick: "Pick 1 session more." After three: "Save the picked times." Saving shows "Saving…" then a success toast.
- DB: 3 occurrences at exactly the picked starts (10:00 IST = 04:30Z), 60 minutes each. `Subscription.status = APPROVED`.

**Cross-check:** B3 (LA) sees each session at 20:30 the **previous** calendar day (04:30Z − 8 h). Report whether B3's list makes the date shift obvious (weekday shown?).

**Probe further:**

- Double-click Save quickly: one allocation, the second click replays (depth in 09 `CC-`).
- Pick, then click the second half of a picked session: the whole session goes (02 owns this).

## SU-38 — Too many picks for the week

**Why it matters:** the weekly cap must hold at the save button and at the server.

**Setup:** P-B1.

**Steps:**

1. As H1, pick **4** sessions in week 1 on four days. Read the Save tooltip.
2. Replay the 3-session PATCH body from SU-37 with a 4th session's two atoms appended, on a plan with nothing placed.

**Expect:**

- UI: Save disabled, tooltip "Remove 1 session — 3 sessions needed."
- API: 400 `VALIDATION_ERROR`. Record which copy wins: "This subscription takes 3 sessions. Pick no more than that." (count check) or "That's more sessions than this plan week has room for. Remove a time, or place it next week." (`PLAN_WEEK_FULL`). Either is correct; no rows written.

**Probe further:** two different sentences for one rule. Note both in the copy log.

## SU-39 — Two sessions on one day

**Steps:**

1. As H1, on P-B1, pick 09:00 and 17:00 IST on the same day.
2. Replay a body with those two sessions plus one more.

**Expect:**

- UI: the second pick is refused with a "Limit reached" toast (description from the quota footer, ending "Pick a day or week that still has room."), or the day paints Limit reached after the first pick.
- API: 400 `VALIDATION_ERROR`, "These times put too many sessions on one day. Spread them across more days."

**Probe further:** the cap is per **IST** day. As a viewer in LA, 23:30 IST and 00:30 IST next day look like the same LA afternoon. If you can pick 20:00 IST and next day 09:00 IST, both are allowed (different IST days). Does the tray explain the day boundary? (Deep zone matrix is 10's.)

## SU-40 — A time outside the open plan week

**Steps:**

1. As H1, on P-B1, navigate to week 2 (day0 + 7…). Read the cells.
2. Replay a body with all three sessions in week 2.

**Expect:**

- UI: week 2 cells paint "Outside period" or "Limit reached"; clicking one shows a toast that names the open week.
- API: 400 `VALIDATION_ERROR`, "A subscription is scheduled one plan week at a time. Pick times inside the open week shown on the calendar."

**Probe further:** does the context row say which week is open, with dates? If the toast says only "Limit reached", is that the right word for "not yet open"? **COPY**.

## SU-41 — Too soon and in the past

**Steps:**

1. As H1, on P-B1 (its week 1 starts tomorrow; use a fresh purchase starting today if you need today's cells), click a free cell starting less than 15 minutes from now, then a cell earlier today.
2. Replay a body with a session starting in 5 minutes (keep it on the UTC half hour).

**Expect:**

- UI: "Too soon" toast, "That time starts in less than 15 minutes — pick a later one." Past cells give the past-slot toast.
- API: 400 `VALIDATION_ERROR`, "One of these times has passed or starts too soon to confirm. Pick a later time."

**Probe further:** the grid paints "Too soon" from the same lead contract (`lib/booking/lead-time.ts`). Is the boundary exact at 15 minutes, or off by one atom?

## SU-42 — Busy time and closed hours

**Steps:**

1. As H1, on P-B1, in the week holding F-BUSY, click Tuesday 18:00 IST (if F-BUSY falls outside P-B1's week 1, use any confirmed H1 booking inside it).
2. Click a weekday 14:00 IST (inside the 13:00–17:00 gap).
3. Replay a body that includes Tuesday 18:00, then one that includes 14:00.

**Expect:**

- UI: 18:00 shows the busy block and a "slot unavailable" toast; 14:00 is closed (hatched) and refuses.
- API: busy → 400 `VALIDATION_ERROR` "One of these times is already booked. Pick another time." (or 409 `SLOT_TAKEN` if it slipped past the check). Closed → 400 "One of these times is outside the expert's available hours or this plan's scheduling period. Pick another time."
- R-05 zero rows.

**Probe further:** the expert can't place their own client outside published hours here, but can run a webinar outside them (05). Is the difference explained anywhere?

## SU-43 — Only the host allocates

**Why it matters:** allocation is host-side only (`resolveEventHostActor`).

**Steps:**

1. As B3 (the buyer), replay the allocate PATCH on their own plan.
2. As ST, the same.
3. As H2 (another consultant), the same.
4. As B3, with `allowPartial: true` and `override: true` in the body.

**Expect:**

- B3, H2: 403 `ALLOCATE_FORBIDDEN`. ST: record (staff may be allowed per the invariants table: "override, allowPartial and topUp are expert and staff only"). No rows written by refused calls.

**Probe further:** open the allocate page URL as B3. Does it render the grid, a 404, or a friendly "only your expert schedules" page?

## SU-44 — Phone: desktop notice and Auto-schedule this week

**Steps:**

1. `resize_page` 390×844. As H1, open P-B1's allocate page (after SU-42).
2. Read the notice. Tap **Auto-schedule this week**.

**Expect:**

- UI: the desktop-only notice ("Please access this on desktop for now", record the rest) plus an **Auto-schedule this week** button that works.
- DB: same outcome as SU-35.
- On failure the copy is "We couldn't place the times just now. Try again, or pick them on a computer."

**Probe further:** after success on the phone, can H1 see which times were picked without a computer? If not, **MISSED-OPPORTUNITY**.

---

## Part 2 — Partial weeks, top-up and short-week warnings

**Needs:** SU-27 (B2 bought `qa-SU-14`: H2, 3/week × 2.5 h, Mon/Wed/Fri 18:00–21:00 IST only) and the SU-20 booking that blocks one of those evenings. SU-23 for the "no warning" control. Preview OK for allocation.
**Personas:** H2 (IST) allocating, B2 (Europe/London) viewing, H1 for the control.
**Docs under test:** `lib/booking/allocation/search/find-available-slots.ts` (`allowPartial`), `components/scheduling/UnifiedCalendar.tsx` (partial dialog), `lib/booking/feasibility.ts` (`hostFeasibilityWarnings`), decision 6.

Make sure B2's plan week 1 (its `schedulingPeriodStartsAt` IST day to +6) contains the blocked evening. If it doesn't, ask the owner to approve one SQL shift of the blocking session into week 1 (keep it on the UTC half hour) and say which row you moved. With one of the three evenings blocked, the week can hold **2** sessions of 2.5 h (fewer if today's evening has already passed).

## SU-45 — Auto finds only 2 of 3: the partial dialog

**Why it matters:** a paid plan whose week can't hold every session used to be unschedulable; now the expert can place what fits.

**Steps:**

1. As H2, open B2's allocate page. Read the tray warnings (see SU-50).
2. Click **Auto-schedule this week**.
3. Read the dialog in full. Click **Not now**. Check the DB.
4. Click **Auto-schedule this week** again, then **Schedule 2 now**.

**Expect:**

- First PATCH (no `allowPartial`): 400 with `errorCode: "SLOT_SHORTAGE"`, `placeableSessions: 2`, `requiredSessions: 3`, `error` "Only 2 of 3 sessions fit in the free times. Open up more availability, or schedule the ones that fit now."
- Dialog title "Only 2 of 3 sessions fit". Body "Your published availability in this period can hold 2 sessions. Schedule those now and leave the remaining 1 pending? The client is told how many are booked, and you can schedule the rest later." Buttons **Not now** and **Schedule 2 now**.
- After **Not now**: no occurrences (R-03).
- After **Schedule 2 now**: PATCH with `allowPartial: true` → 200 `{ partial: true, placedSessions: 2, requiredSessions: 3, unplacedSessions: 1 }`. DB: 2 occurrences of 150 minutes on the two free evenings (18:00 IST = 12:30Z), `Subscription.status = APPROVED`. R-05 zero rows; neither overlaps the blocking booking.
- Heading: "Week 1 of 4 · pick 1 for <week 1 range> · 2 of 12 booked".

**Cross-check:** B2 sees 2 sessions at 12:30 London. B2's bell and an outbox row for `appointment-partially-scheduled` (R-07); H2 gets none (they saw the dialog). Consultee booking says how many of this week's 3 are booked (record the copy).

**Probe further (report anything odd):**

- "leave the remaining 1 pending": pending until when? The dialog doesn't say the week closes in N days and an unplaced session is refunded at plan end. **MISSED-OPPORTUNITY**.
- Does B2's view say why only 2 were booked, and what happens to the third?
- Is the dialog keyboard-trapped and labelled (`AlertDialog`)? 13 owns the sweep; note obvious failures.

## SU-46 — Partial needs the expert: buyer and host-org can't ask for it

**Why it matters:** a partial schedule is never chosen on the buyer's behalf.

**Steps:**

1. As B2, replay the step-4 body (`isAuto: true, allowPartial: true`) on a fresh copy of this situation (if none, on this plan before step 4, i.e. run this case first).
2. If an OH (LearnPro operator) can reach an OX plan in the same shortage, replay as OH.

**Expect:** B2 → 403 `ALLOCATE_FORBIDDEN`. OH → the flag is dropped (`canOverride` false for host-org), so 400 `SLOT_SHORTAGE` rather than a partial 200. Record OH as BLOCKED if no such plan exists.

**Probe further:** does any consultee page offer "schedule what fits"? It shouldn't.

## SU-47 — Manual partial through the API

**Why it matters:** the manual mode honours `allowPartial` too; the old suite said it didn't.

**Setup:** a fresh `qa-SU-14` purchase by B3 starting the same day as B2's (so the same evening is blocked), or reuse B2's plan before SU-45 step 4.

**Steps:**

1. As H2, pick the two free evenings on the grid. Hover Save: tooltip "Pick 1 session more." (Save disabled.)
2. Replay a manual body with those two sessions, no `allowPartial`.
3. Replay with `allowPartial: true`.

**Expect:**

- Step 2: 400 `errorCode: "SLOT_SHORTAGE"`, "This subscription takes 3 sessions; you picked 2 sessions." (count words per `sessionsLabel`), `placeableSessions: 2`.
- Step 3: 200 `partial: true, placedSessions: 2, unplacedSessions: 1`.

**Probe further:** the UI can't reach the manual partial dialog because Save is disabled below the full count. If the dialog's manual text ("You picked times for 2 sessions…") is unreachable, say so; either the dialog branch is dead code or Save should allow it.

## SU-48 — Top up the missing session later

**Why it matters:** a top-up must append, never replace.

**Setup:** after SU-45. Free the blocked evening: as H2, cancel or re-time the SU-20 webinar (05 owns the cancel journey; a free webinar moves no money), or wait for 05 to do it.

**Steps:**

1. R-03: note the ids of B2's 2 occurrences.
2. As H2, reload B2's allocate page. Read the heading and the tray.
3. Pick the now-free evening. Save.

**Expect:**

- Heading before: "Week 1 of 4 · pick 1 for <range> · 2 of 12 booked"; tray asks for 1.
- PATCH → 200 (additive arm). DB: 3 occurrences; the first two have the same ids, `startsAt` and `createdAt` as before. No deletes.
- Heading after: "Week 2 of 4 · pick 3 for <week 2 range> · 3 of 12 booked".

**Probe further:** if the week passes with 1 unplaced, can it ever be placed later? (No: plan weeks don't roll over. It is refunded at plan end, SU-77.) Is that stated to H2 anywhere?

## SU-49 — The buyer's view of a partial week

**Why it matters:** the buyer must know what was booked and what wasn't.

**Steps:**

1. Between SU-45 and SU-48, as B2, open Home, Appointments and the plan's detail page.
2. Note every count and status.

**Expect:**

- UI: two upcoming sessions in London time; somewhere a count like "2 of 12 booked" or "2 of 3 this week" (record exact copy). No claim that the week is complete.
- The money state stays paid; no refund yet.

**Probe further:** does B2 get a way to ask for the third time (message the expert)? Does the detail page say unplaced sessions are refunded at plan end, matching the checkout notice in SU-27?

## SU-50 — Short-week warnings on the allocate page

**Why it matters:** the expert should see coming shortfalls before they happen.

**Steps:**

1. As H2, open B2's allocate page. Read the tray's warnings block.
2. As H1, open B2's SU-23 allocate page (H1's weeks fit 3 easily). Read the same block.

**Expect:**

- H2: "1 of the next 8 weeks can't fit 3 sessions around your other bookings. Open more hours, or sessions that never get a time are refunded to the client when the plan ends." (the count is however many of the 8 weeks have a blocked evening).
- H1: no warning block (`hostFeasibilityWarnings` returns nothing when every week fits).

**Probe further:**

- The allocate page looks **8** weeks ahead, the checkout notice and the publish gate look **4**. A 4-week plan warned about weeks 5–8 is warned about weeks that don't exist. Report as **INCONSISTENCY** (P2) if H2's count includes weeks after `planEndsAt`.
- The check counts every held session as busy, including this plan's own. After SU-45 places 2 sessions of 150 minutes, week 1 has no room left for "3 more", so the count may rise by one. A warning about a week the plan has already filled is **FALSE-INFO** (P3); record the count before and after.
- Is the warning in the tray at 1280 px and under the grid below 1280 px?
