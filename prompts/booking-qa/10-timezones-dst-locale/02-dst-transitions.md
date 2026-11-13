# 10-b · Time zones: daylight-saving transitions

**Needs:** TZ-01 (H3 plans `qa-TZ-01a`, `qa-TZ-01b`), F-AV3, F-AV1, F-PL2 (H2 webinars). `[local]` for paid bookings and seats.
**Personas:** H3 (America/New_York, the DST host), H2 (IST), H1 (IST); B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles), DR (Australia/Sydney).
**Docs under test:** `docs/booking/19-dst-and-timezone-posture.md` ("Spring forward … is skipped for that date. It is never shifted"; "Fall back … resolves to its first occurrence"); `utils/schedule/weekly-projection.ts` (`weeklyRowIntervalsInRange`); `lib/time/grid-zone.ts` (`dayRows`: 46/48/50 rows, "1:00 am (2nd)"); `lib/booking/class-pattern.ts` (series on the host's wall clock); `lib/booking/entitlement.ts` (`weeksPlanEndOf`, plan weeks as whole host-zone days).

**Transitions (all after today, 2026-11-10; the US fall-back on 2026-11-01 has passed):**

| Zone | Date | Change | UTC instant |
| --- | --- | --- | --- |
| America/New_York, America/Los_Angeles | Sun 2027-03-14 | 02:00 → 03:00 (EST → EDT, PST → PDT) | NY 07:00Z, LA 10:00Z |
| Europe/London | Sun 2027-03-28 | 01:00 → 02:00 (GMT → BST) | 01:00Z |
| Australia/Sydney | Sun 2027-04-04 | 03:00 → 02:00 (AEDT → AEST) | 16:00Z on 04-03 |

Between 14 and 28 March New York is 4 h behind London, not 5. IST never changes.

**Horizons that limit these cases (verified in code):** the grid endpoint answers at most 32 days per call (`WINDOW_TOO_WIDE`), so pages page week by week; a subscription start date must be within 90 days (`INVALID_PLAN_START`); trials look two weeks ahead (TR-15). If a page won't navigate as far as March 2027, record the furthest week it reaches (a horizon is itself a finding to describe) and use the API path the case gives.

Salvaged from old `e2e-booking-agent-015` (New York expert across DST): its Phases 1, 3, 4, 5 and 6 are TZ-20, TZ-23, TZ-24, TZ-21 and TZ-32, moved to the 2027 spring change.

## TZ-20 — A New York weekly window moves in UTC and stays put on the wall clock

**Steps:**

1. As B1 (IST), with H3's page open on the week of Mon 2027-03-08, read Monday's first and last start. Repeat for the week of Mon 2027-03-15.
2. From the page, call `GET /api/scheduling/availability-with-allocation/[H3 cid]?startDateInUtc=2027-03-08T00:00:00Z&endDateInUtc=2027-03-09T12:00:00Z&timezone=America/New_York` and the same for 2027-03-15/16. Then the 15 March read with `timezone=Asia/Kolkata`.
3. As H3, read their own grid (Manage timings of any H3 booking, or the allocate page of a pending H3 request) for both weeks.

**Expect:**

| Monday | Offset | First atom | Last atom start | H3 sees | B1 sees |
| --- | --- | --- | --- | --- | --- |
| 2027-03-08 | −05:00 | 14:00Z | 21:30Z | 9:00 am–5:00 pm | 7:30 pm–3:30 am (Tue) |
| 2027-03-15 | −04:00 | 13:00Z | 20:30Z | 9:00 am–5:00 pm | 6:30 pm–2:30 am (Tue) |

The `timezone` query parameter changes labels only, never instants.

**Probe further:** B1 sees the expert's hours "move" an hour earlier with no explanation. Does any surface tell a buyer that the expert's clocks changed? (None does today; note **MISSED-OPPORTUNITY** once.) Read the zone line on both weeks for B1: IST both times, correct.

## TZ-21 — The spring-forward Sunday: 46 rows, and a row inside the gap is skipped

**Setup:** as H3, add a weekly row **Sunday 02:00–04:00** (temporary). Restore F-AV3 at the end.

**Steps:**

1. As H3 (New York), open their own grid for the week of Sun 2027-03-14 with **Full day** on. Count Sunday's rows and read the labels between 1:00 am and 4:00 am.
2. Read the grid endpoint for Sun 2027-03-07, 2027-03-14 and 2027-03-21 (`timezone=America/New_York`).
3. Remove the Sunday row.

**Expect:**

- Sunday 14 March has 46 rows; "1:30 am" is followed by "3:00 am"; no "2:00 am" or "2:30 am".
- Sunday row: 7 March 07:00Z–09:00Z (4 atoms); **14 March: no atoms** (date skipped, never shifted to 03:00–05:00); 21 March 06:00Z–08:00Z.

**Probe further:** the availability editor accepted 02:00 on a Sunday. Does it warn that one Sunday a year this window vanishes? A buyer looking at that Sunday sees nothing; does anything explain why? **MISSED-OPPORTUNITY** if not.

## TZ-22 — Fall-back days for viewers in London and Sydney

**Steps:**

1. As B2 (London), open any grid page that can reach the week of Sun 2027-03-28 (H1's expert page or B2's reschedule page for a far booking). Full day on. Count Sunday's rows.
2. As DR (Sydney), open a grid for the week containing Sun 2027-04-04. Count Sunday's rows; read the labels from 1:30 am to 3:30 am.

**Expect:**

- London, 28 March: 46 rows; "12:30 am" then "2:00 am".
- Sydney, 4 April: 50 rows; "2:00 am", "2:30 am", "2:00 am (2nd)", "2:30 am (2nd)", "3:00 am". Every row is a 30-minute UTC atom (15:00Z, 15:30Z, 16:00Z, 16:30Z, 17:00Z on 3 April).

**Probe further:** the "(2nd)" label is the only cue. Does the hover tooltip or screen-reader name also say "(2nd)" (or AEDT/AEST)? Pick the second 2:00 am row on a page that allows picking: does the tray or confirmation still say "(2nd)", or just "2:00 am"? An unmarked "2:00 am" there is **FALSE-INFO** by ambiguity (P2).

## TZ-23 — Book across the change: the true window opens, the frozen-offset hour stays shut `[local]`

**Steps:**

1. As B1, book `qa-TZ-01a` (H3, 60 min) on Mon 2027-03-08 at 9:00 am EST (shown 7:30 pm IST) with mock pay.
2. Book Mon 2027-03-15 at 9:00 am EDT (shown 6:30 pm IST).
3. Try Mon 2027-03-15 16:30 → 17:30 EDT, and 17:00 → 18:00 EDT (21:00Z–22:00Z, shown Tue 2:30 am IST), via the dialog and via `POST /api/checkout` with mock pay.
4. If the expert page can't reach March, run steps 1–3 through `POST /api/checkout` with the same instants and say so.
5. R-03, R-04, R-05 for H3.

**Expect:**

- Step 1: `startsAt = 2027-03-08T14:00:00Z`. Step 2: `startsAt = 2027-03-15T13:00:00Z`.
- Step 3: both refused (the window ends 17:00 EDT = 21:00Z). A product that still used the 1970 offset would sell 21:00Z–22:00Z; it must not. No `Payment` row for refusals.
- H3 sees both sessions at 9:00 am. B1 sees 7:30 pm and 6:30 pm. Emails: H3 "… at 9:00 AM EST" and "… at 9:00 AM EDT"; B1 "… at 7:30 PM IST" and "… at 6:30 PM IST".

**Probe further:** B1's two bookings are a week apart at different IST times. Does B1's Appointments list make that obvious, or could B1 assume 7:30 pm for both? Reminder emails (NEEDS-OWNER-RUN off production) would carry the right zone label; note the job name `send-appointment-reminders` if you can't run it.

## TZ-24 — The allocator agrees with the grid across the change

**Setup (owner approval, with reason "seed a subscription whose open week contains the 2027 US change; checkout allows start dates only 90 days out"):**

1. As B1, buy `qa-TZ-01b` `[local]` with the earliest start date.
2. `UPDATE "Subscription" SET "schedulingPeriodStartsAt" = '2027-03-08T05:00:00Z', "planEndsAt" = '2027-05-03T04:00:00Z' WHERE id = :sid RETURNING id;` (00:00 EST on 8 March; 00:00 EDT on 3 May = day0 + 56).
3. Allocate within 48 h of payment: a paid plan with no session for 48 h is refunded in full by the 48-h sweep where sweeps run (SU-81).

**Steps:**

1. As H3, open the allocate page. Read the context chip and the week shown.
2. `PATCH /api/bookings/subscriptions/[sid]/allocate` with `{ "isAuto": false, "slots": ["2027-03-15T13:00:00Z", "2027-03-15T13:30:00Z"] }` and an `Idempotency-Key`. Expect a plan-week refusal (15 March is week 2) — record it.
3. Repeat with `["2027-03-12T14:00:00Z", "2027-03-12T14:30:00Z"]` (Fri 9:00 EST, week 1): 200.
4. Repeat with `["2027-03-12T22:00:00Z", "2027-03-12T22:30:00Z"]` (Fri 17:00 EST): 400.
5. R-06, the plan-week SQL from TZ-10, R-05.

**Expect:**

- Step 3: one occurrence at 14:00Z. Step 4: 400 `errorCode: "VALIDATION_ERROR"`, copy "One of these times is outside the expert's available hours or this plan's scheduling period. Pick another time."
- The grid painted step 4's cells as closed and step 2's as outside the open week.

**Probe further:** step 2's copy should name the plan week ("A subscription is scheduled one plan week at a time…"); record which sentence came back. Note the `errorCode` key here vs `code` on other routes (UX-folder covers the key mismatch).

## TZ-25 — A plan week that contains the change is 167 hours long

**Needs:** TZ-24's subscription.

**Steps:**

1. Compute plan week starts from the DB: `SELECT "schedulingPeriodStartsAt", "planEndsAt", "schedulingTimezone" FROM "Subscription" WHERE id = :sid;` and convert.
2. As H3 and as B1, read the week ranges on the allocate page, the subscription detail and any "Week N of 8" chip.
3. Auto-schedule week 1 (the tray's Auto). R-06.

**Expect:**

- Week 1: 2027-03-08 05:00Z → 2027-03-15 04:00Z (167 h, seven New York days). Week 2 starts 04:00Z on 15 March, not 05:00Z. `planEndsAt` stays at a New York midnight.
- Auto places 2 sessions inside week 1, spaced, inside 9:00–17:00 EST, one a day.
- Context chip "Week 1 of 8" (never "of 9").

**Probe further:** R-06's second query (604 800-s buckets from `schedulingPeriodStartsAt`) puts a session at 2027-03-15 04:30Z in week 1, but the product counts it in week 2. Report **DOC-DRIFT** on `_shared/sql-recipes.md` if any row differs. B1 (IST) reads week 2 as starting at 9:30 am IST on 15 March: does any surface show B1 that boundary?

## TZ-26 — A class that crosses both the US and the UK changes `[local]`

**Why it matters:** a series keeps the host's wall clock, so a buyer abroad sees the time move twice. CL-04 checks the host side; this case checks the buyers.

**Steps:**

1. As H3, create class `qa-TZ-26`: 2/week, 2 months, 60 min, capacity 5, ₹500, start date Mon 2027-03-01 18:00 (H3's browser in New York, or the API with `2027-03-01T23:00:00Z`). Publish.
2. R-03 on the class appointment: 16 occurrences.
3. As B2 (London), B1 (IST) and DR (Sydney), enrol with mock pay. Each reads the session list on the appointment detail.

**Expect:**

| Sessions | UTC | H3 | B2 (London) | B1 (IST) | DR (Sydney) |
| --- | --- | --- | --- | --- | --- |
| Mar 1, 4, 8, 11 | 23:00Z | Mon/Thu 6:00 pm | 11:00 pm | next day 4:30 am | next day 10:00 am |
| Mar 15, 18, 22, 25 | 22:00Z | 6:00 pm | 10:00 pm | next day 3:30 am | next day 9:00 am |
| Mar 29 – Apr 1 | 22:00Z | 6:00 pm | 11:00 pm (BST) | next day 3:30 am | next day 9:00 am |
| Apr 5 – Apr 22 | 22:00Z | 6:00 pm | 11:00 pm | next day 3:30 am | next day 8:00 am (AEST) |

Never 5:00 pm or 7:00 pm for H3.

**Cross-check:** bell `APPOINTMENT_BOOKED` per zone; the enrolment email names the first session in each recipient's zone.

**Probe further:** DR sees three different times for one weekly class. Does the detail page show each session's own time (correct) or one "Every Tue and Fri at 10:00 am" summary (false after 15 March)? Any summary line that names one time for the series is **FALSE-INFO** (P1) for B2, B1 and DR.

## TZ-27 — A webinar on the spring-forward night

**Steps:**

1. As H3, open the webinar editor's time picker (`SingleTimePicker`, host audience) and page the month to March 2027; pick Sun 14. Switch on **Show times outside my hours** and read the starts between 12:00 am and 4:00 am.
2. Pick 1:30 am, 90 minutes. Publish (or `POST` through the editor's API with `scheduledAt: "2027-03-14T06:30:00Z"` if the month can't reach March).
3. Read the end time everywhere: editor, H3's Appointments, B2's public page.

**Expect:**

- The list jumps from "1:30 am" to "3:00 am".
- `startsAt = 06:30Z`, `endsAt = 08:00Z` (90 real minutes). H3 reads "1:30 am–4:00 am" (wall 2.5 h; correct). B2 reads "6:30 am–8:00 am".

**Probe further:** does any surface compute the end as start wall clock + 90 min ("3:00 am", false) instead of the instant? Does any label say "1 h 30 min" next to "1:30–4:00"? A reader might think it's an error; is there a cue?

## TZ-28 — A nonexistent local time in the class editor and the pattern scheduler

**Why it matters:** a time inside the spring-forward gap has no instant. The class editor's **First session** is the host's time picker (CL-02), which lists instants, so it should never offer one.

**Steps:**

1. As H3, with the browser emulated in America/New_York, new class `qa-TZ-28`: 1/week, 1 month, 60 min. In **First session**, open Sun 2027-03-14 with **Show times outside my hours** on and read the starts around 2:00 am; pick 3:00 am. Save as draft or publish.
2. Read what the form shows after save and what the DB holds.
3. Open the pattern scheduler (Manage timings → weekly pattern) for an unscheduled H3 class; add a row Sunday 02:30, first day 2027-03-07, 4 sessions. Read the preview.

**Expect:** a defined rule, applied the same way in both doors and said to the host. Step 1: the picker lists 1:30 am then 3:00 am, with no 2:00 or 2:30 am; the saved first session is `2027-03-14T07:00:00Z`. The ADR rule for weekly rows is "skip, never shift"; record what the pattern scheduler does with 2:30 am.

**Probe further:** pattern preview for 14 March: skipped (and the series extended to keep N), shifted to 3:30 am, or listed as 2:30 am with a 07:30Z instant? Any session shown as "2:30 am" on 14 March is **FALSE-INFO** (that time doesn't exist). No warning at all is **MISSED-OPPORTUNITY**.

## TZ-29 — An ambiguous local time: "2:30 am" twice on one night

**Steps:**

1. As H2, create two free webinars through the editor or its API: `qa-TZ-29a` at `2027-04-03T15:30:00Z` and `qa-TZ-29b` at `2027-04-03T16:30:00Z`, 30 minutes each.
2. As DR (Sydney), open both public pages and register for both.
3. Read DR's Appointments list, both details, bell and emails (N-1, N-2).

**Expect:** both are "Sun 4 Apr, 2:30 am" for DR. They are an hour apart. Emails carry different zone labels ("GMT+11" for the first, "GMT+10" for the second). IST viewers see Sat 3 Apr 9:00 pm and 10:00 pm.

**Probe further:** the dashboard shows no zone suffix in DR's own zone, so the two look identical. Report **FALSE-INFO** (P2: ambiguous) unless some surface disambiguates. The "Free cancellation until …" lines: do they differ by exactly 1 h?

## TZ-30 — "24 hours before" across the UK change reads as 25 hours `[local]`

**Steps:**

1. As H2, create webinar `qa-TZ-30`: Sun 2027-03-28 18:00 IST (12:30Z), ₹500.
2. As B2 (London), buy a seat. Read "Free cancellation until …" on the public page and the cancel or leave dialog.
3. Compute `startsAt − window` from the DB (`Webinar` cancellation window or the default; WE-46/WE-48 own the window rule).

**Expect:** B2's session is Sun 28 Mar 1:30 pm (BST). With a 24-h window the deadline is Sat 27 Mar 12:30 pm (GMT): 24 real hours, 25 on the wall. The product shows the instant correctly.

**Probe further:** does any copy say "until 1:30 pm the day before" (wall-clock arithmetic, false here)? Is the deadline labelled with a zone? An unlabelled deadline on the day the zone changes is a **MISSED-OPPORTUNITY**.

## TZ-31 — The zone line names today's offset, not the offset of the week on screen

**Steps:**

1. As H3 (New York), open their own grid now (November, EST) and page forward to the week of Mon 2027-03-15.
2. Read the zone line ("Times shown in …") on both weeks.
3. As B2 (London), open a grid for the week of Mon 2027-03-29 and read the line.

**Expect:** the line for a week in EDT says "EDT (UTC−04:00)"; for B2's week after 28 March, "GMT+1 (UTC+01:00)".

**Probe further:** `ZoneSwitch` formats the label at `now` (`zoneDisplayLabel(now ?? new Date(), zone)`), and every grid passes the current time. Expect "EST (UTC−05:00)" on a week whose times are EDT. Report **FALSE-INFO** (P2) with both screenshots. The times in the cells are still right (rows come from the zone's rules per day).

## TZ-32 — A weekly row without local columns is refused, not guessed (optional)

**Setup (owner approval; reason "prove readers refuse a row with NULL local columns"):** insert one `AvailabilityWindowWeekly` row for H3 with only the UTC columns (Tuesday 14:00–17:00 UTC, `timezone` and every `local*` column NULL). Delete it at the end of the case.

**Steps:**

1. Read H3's grid endpoint for next Tuesday and open H3's public page.
2. Try `POST /api/checkout` for that Tuesday 14:00Z on `qa-TZ-01a` (mock pay).
3. Delete the row.

**Expect:** the grid shows nothing extra for that Tuesday window (H3's real Tuesday 09:00–17:00 EST = 14:00Z–22:00Z still shows); the checkout of 14:00Z succeeds only because the real row covers it. Netlify log carries one incomplete-row report per call, throttled (doc: one Sentry event per hour per instance).

**Probe further:** choose a time the bad row would add and the real rows don't (none exists for H3 on a weekday; use a Saturday in the inserted row if you prefer): refused.

## TZ-33 — Restore after the DST cases

**Steps:** remove TZ-21's Sunday row; cancel TZ-23's bookings and TZ-24's subscription through the product; cancel or archive `qa-TZ-26`, `qa-TZ-27`, `qa-TZ-28`, `qa-TZ-29a/b`, `qa-TZ-30` (host cancel refunds seats in full); R-08 and R-09 for anything left; R-02 for H3.

**Expect:** F-AV3 exactly as built. Refund rows for every paid seat cancelled (R-04).

**Probe further:** the subscription you shifted into March: does its cancel quote treat every session as ≥ 24 h away (it should), and does the refund preview name dates in March correctly in B1's zone?
