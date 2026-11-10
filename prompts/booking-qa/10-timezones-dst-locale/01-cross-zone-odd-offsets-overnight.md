# 10-a · Time zones: parties in different zones, odd offsets, overnight and day boundaries

**Needs:** F-AV1, F-AV3, F-AV4 (custom, per S-05), F-PL1 (S-08, S-09, S-11), F-BUSY. TZ-01 creates the H3 and H4 plans this folder uses. `[local]` for paid bookings.
**Personas:** H1 (IST), H3 (America/New_York), H4 (Asia/Kathmandu); B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles), DR (Australia/Sydney), B4 (IST, temporarily Kathmandu in TZ-14), OS (IST), ST.
**Docs under test:** `docs/booking/19-dst-and-timezone-posture.md`; `lib/time/viewer-zone.ts` (`resolveViewerZone`, `formatForViewer`, `zoneLabel`); `lib/time/grid-zone.ts`; `lib/novu/humanize.ts` (`formatNotificationDateTime`); `lib/email/senders/shared.ts` (`whenText`); `lib/scheduling/allocationMessages.ts` (`limitBucketNote`).

**How time renders today (verified in code; report any surface that differs):**

- Dashboards and grids render in the viewer's **profile** zone (`User.timezone`), falling back to the device zone. Grids carry a zone line "Times shown in IST (UTC+05:30) · Use my device's time zone". Appointment pages show **no** zone suffix in the viewer's own zone and a short label otherwise.
- Grid and dashboard labels use the fixed `en-IN` locale: "7:30 pm", "Thu 24 Sep". There is no 12/24-hour setting.
- Bell notifications are staged **per recipient zone** (one `NotificationOutbox` row per zone group) in the house format `Sat, 6 Sep 2026 · 7:53 AM IST`.
- Emails use `EEE, d MMM yyyy 'at' h:mm a` plus a zone label, in each recipient's zone: `Sat, 6 Sep 2026 at 7:53 AM IST`.
- Zone labels: IST is pinned; every other zone uses the `en-US` short name, so London reads "GMT" (winter) and "GMT+1" (summer), Sydney "GMT+11"/"GMT+10", Kathmandu "GMT+5:45", New York "EST"/"EDT", Los Angeles "PST"/"PDT".

**Notification and email rows for this folder (SELECT, no approval):**

```sql
-- N-1: bell rows for one booking, with the rendered times
SELECT "workflowId", kind, recipients, payload->>'dateTime' AS "dateTime",
       payload->>'oldDateTime' AS "old", payload->>'newDateTime' AS "new",
       payload->>'outcome' AS outcome, status, "notBefore", "createdAt"
FROM "NotificationOutbox" WHERE "entityRef" LIKE '%' || :entityId || '%' ORDER BY "createdAt";
-- N-2: emails for one booking (subject is what the inbox shows)
SELECT "emailType", recipient, subject, status, "createdAt"
FROM "FailedEmail" WHERE "entityRef" LIKE '%' || :appointmentId || '%' ORDER BY "createdAt";
```

**Conversions used below (winter, before any 2027 change):** IST = UTC+05:30, London = UTC+00:00, Los Angeles = UTC−08:00, New York = UTC−05:00, Sydney = UTC+11:00, Kathmandu = UTC+05:45. D is the Monday from 01's README.

## TZ-01 — Zone fixtures: zones, H3 and H4 plans

**Why it matters:** every later case compares one instant across five zones; the personas must be in the zones the table says.

**Steps:**

1. Run R-01. Record each persona's `timezone`. Any persona not matching `_shared/personas-and-fixtures.md` §1: change it in **Settings → Account** (the zone select), not SQL. Record each change for restore at the end of the folder.
2. As H3, create through the editor: consultation 60 min, ₹500, published (`qa-TZ-01a`); subscription weeks plan 8 weeks × 2/week × 60 min, priced, published (`qa-TZ-01b`).
3. As H4, create a consultation 30 min, free, published (`qa-TZ-01c`).
4. R-02 for H3 and H4.

**Expect:**

- H3 weekly rows: `timezone = America/New_York`, Mon–Fri `localStartMinutes = 540`, `localEndMinutes = 1020`. H4: no weekly rows (custom only, per S-05).
- `qa-TZ-01b`: `durationInWeeks = 8`, `sessionsPerWeek = 2`, `totalSessions = 16`, `status = PUBLISHED`; publish passes the feasibility gate (10 windows of 8 h a week).
- `qa-TZ-01c` publishes. H4's public page lists it.

**Probe further:** the zone select lists raw IANA names from `Intl.supportedValuesOf` (for example "Asia/Kolkata", "America/Argentina/Buenos_Aires"). Is it searchable? Does it show offsets? Would a learner know "Asia/Calcutta" and "Asia/Kolkata" are one zone? Report **COPY** or **DESIGN** as you find it.

## TZ-02 — IST host, London buyer: one instant, two clocks, every surface `[local]`

**Steps:**

1. As B2 (London), open H1's expert page. Read the zone line on the booking dialog. Pick Wed D+2 17:00 IST, shown to B2 as 11:30 am. Pay with mock pay.
2. As B2, open Home, Appointments (list and calendar view), the appointment detail and Payments.
3. As H1, open Home, Appointments, the detail and the allocate grid for any pending request (the new block must show as Busy).
4. Run R-03, N-1, N-2 and R-05 for H1.

**Expect:**

- DB: one occurrence `startsAt = (D+2) 11:30:00Z`, `endsAt = 12:30:00Z`.
- B2 everywhere: "11:30 am" on Wed D+2, no zone suffix (own zone). H1 everywhere: "5:00 pm" Wed D+2.
- Bell: two `APPOINTMENT_BOOKED` rows (or one MULTI row per zone group): B2's `dateTime` "Wed, … · 11:30 AM GMT", H1's "Wed, … · 5:00 PM IST".
- Emails: B2 subject "Your consultation with <H1 name> is confirmed", body time "… at 11:30 AM GMT"; H1 subject "New booking: <B2 name> for <plan title>", body "… at 5:00 PM IST".
- R-05: zero rows.

**Cross-check:** staff `/dashboard/staff/appointments` shows the same instant; record the zone it uses and whether it says so.

**Probe further:**

- The checkout page's Date and Time rows. Code builds them with `toLocaleDateString(undefined, …)` and `toLocaleTimeString()` plus `Intl…resolvedOptions().timeZone`: browser zone and browser locale, raw IANA name, seconds shown ("11:30:00 AM"). Compare with the dialog's "11:30 am". Report **INCONSISTENCY** (P2).
- The checkout "Duration" row prints `{durationInHours} hours`: expect "1 hours". Report **COPY** (P3).
- Does any surface show B2 the expert's local time, or H1 the buyer's? Neither does today. Report **MISSED-OPPORTUNITY** once for the folder.

## TZ-03 — IST host, Los Angeles buyer: the session is on the buyer's previous day `[local]`

**Steps:**

1. As B3 (LA), open H1's expert page for the week of D+7. Find Mon D+7 09:00 IST.
2. Book it with mock pay.
3. As B3, read Home, Appointments list and calendar view, detail. As H1, the same.
4. N-1, N-2.

**Expect:**

- DB `startsAt = (D+7) 03:30:00Z`, which is Sun D+6 19:30 PST and Mon D+7 09:00 IST.
- B3's grid shows the slot in the **Sunday** column at "7:30 pm". Every B3 surface says Sunday. H1's surfaces say Monday 9:00 am.
- B3's email: "Sun, … at 7:30 PM PST". H1's: "Mon, … at 9:00 AM IST".

**Probe further:**

- The Appointments **calendar** view (`components/appointments/AppointmentCalendar.tsx`) buckets days with date-fns `format(event.start, "yyyy-MM-dd")`, which reads the **browser** zone. With B3's browser in IST (emulate), the event jumps to Monday while the list says Sunday. Report **INCONSISTENCY** (P1: wrong day).
- Does B3 get any hint that Sunday evening for them is Monday morning for the expert?

## TZ-04 — IST host, Sydney buyer: the session is on the buyer's next day

**Steps:**

1. As DR (Sydney), book H1's free 30-min consultation for Fri D+4 20:00 IST. The dialog shows it on **Saturday** at 1:30 am.
2. Read DR's consultee surfaces. DR is dual-role (verify by R-01): switch to the consultant dashboard and check whether the booking appears there as "Booked as a client" and in the correct zone.
3. N-1, N-2.

**Expect:** `startsAt = (D+4) 14:30:00Z` = Fri 20:00 IST = Sat 01:30 AEDT. DR sees Saturday 1:30 am everywhere; email "Sat, … at 1:30 AM GMT+11". H1 sees Friday 8:00 pm.

**Probe further:** "GMT+11" for Sydney instead of "AEDT": report **COPY** (P3) if it reads oddly to an Australian user. Does DR's consultant Home count this session under "today" on Friday or Saturday?

## TZ-05 — New York host, IST buyer: the last hour of the host's Friday is the buyer's Saturday night `[local]`

**Steps:**

1. As B1 (IST), open H3's page, plan `qa-TZ-01a`. Find Fri D+4 16:00 EST (the last start that fits a 60-min session).
2. Book it. Then try Fri D+4 16:30 EST via the dialog and via `POST /api/checkout` with mock pay.
3. Read B1 and H3 surfaces, N-1, N-2.

**Expect:**

- 16:00 EST = 21:00Z = Sat 02:30 IST. B1 sees **Saturday 2:30 am**; H3 sees Friday 4:00 pm.
- 16:30 EST is not offered (it would end 17:30, outside the window). The API answers a typed 4xx (availability family, `WINDOW_DURATION_MISMATCH` or an outside-hours refusal); record the code and copy. No `Payment` row.

**Probe further:** the 2-hour "too soon" lead and the 15-minute settle lead are absolute. Nothing in this case depends on the date, but check that B1's dialog doesn't grey Saturday early-morning slots as "Past" when IST is already Saturday and New York is still Friday.

## TZ-06 — Kathmandu host, Los Angeles buyer: a :15 start becomes a :30 start

**Steps:**

1. As B3 (LA), open H4's page, plan `qa-TZ-01c` (free, 30 min). Read the slots for D+1.
2. Book D+1 10:15 NPT.
3. As H4, open Appointments and the detail. N-1, N-2.

**Expect:**

- H4's custom window 10:15–12:15 NPT = 04:30–06:30Z = D 20:30–22:30 PST (B3's previous day). B3 sees starts at 8:30 pm, 9:00 pm … on **D**, not D+1.
- DB `startsAt = (D+1) 04:30:00Z`. H4 sees "10:15 am"; email to H4 "… at 10:15 AM GMT+5:45".

**Probe further:** H4's own grid labels are :15/:45 (HM-29). Does any H4 surface explain why their hours start at :15? The availability editor snapped 10:00 to 10:15 silently (HM-10, writer report bug 4).

## TZ-07 — A reschedule proposal read in two zones

**Needs:** TZ-02's booking (B2 ↔ H1), at least 72 h away.

**Steps:**

1. As B2, open **Reschedule** on the booking. Propose Fri D+4 18:00 IST (shown to B2 as 12:30 pm), outside nothing: it is inside H1's hours, so it may confirm at once (CO-46). If it confirms, undo by moving back and use a time H1 hasn't published (Sat D+5 15:00 IST = 09:30 GMT, CO-47) so the request waits.
2. As H1, open Requests and the detail. Read the proposed time, the respond-by deadline and the bell.
3. N-1, N-2 (look for `outcome = PROPOSED`).

**Expect:**

- H1 sees "3:00 pm" Sat D+5 (IST); B2 sees "9:30 am".
- Bell `APPOINTMENT_RESCHEDULED`, `outcome PROPOSED`: B2's row old/new in GMT, H1's in IST. Email subject "New time proposed for your consultation"; the respond-by line in each recipient's zone.
- `RescheduleRequest.expiresAt` = min(created + 72 h, original start − 24 h) (CO-68 owns the math).

**Probe further:** the PROPOSED bell body ends "Please review it." and is staged for **both** parties. B2, who proposed, is told to review their own proposal. Report **COPY** (P2) if B2's bell says so. Then H1 declines: the DECLINED body "The proposed new time … was declined; it stays on …" reaches both; check each zone.

## TZ-08 — The cancel dialog's deadlines in the buyer's zone

**Needs:** TZ-03's booking (B3 ↔ H1, Sunday evening for B3).

**Steps:**

1. As B3, open **Cancel** on the booking. Read every time in the dialog (session time, any "free until" or tier boundary, refund line).
2. Call `GET /api/appointments/[aid]/cancel/preview` from the page. Compare its instants with the dialog text.
3. Cancel. N-1, N-2, R-04.

**Expect:**

- Any deadline the dialog prints is 24 h before `startsAt`, shown in PST: Sat D+5 7:30 pm. The refund is 100 % (≥ 24 h).
- Cancel email to B3 "Your session on Sun, … at 7:30 PM PST was cancelled"; to H1 "Your session on Mon, … at 9:00 AM IST was cancelled". Bell `APPOINTMENT_CANCELLED` "<B3 name> cancelled the consultation … on <dateTime>. Reason: …" in each zone.

**Probe further:** if the dialog prints no deadline at all, the buyer can't tell when the tier drops. Report **MISSED-OPPORTUNITY**. H1's subject says "Your session … was cancelled": true, but H1 didn't cancel; does the body say who did?

## TZ-09 — The one-a-day cap counts the host's day, not the buyer's `[local]`

**Why it matters:** a buyer sees two different days and is told they're the same day.

**Needs:** a subscription of B3 (LA) on H1's weeks plan with sessions scheduled (reuse a 04 fixture where B3 is the buyer, or buy one `[local]` and let H1 auto-schedule week 1).

**Steps:**

1. Make sure week 1 holds a session on Mon 09:00 IST (= Sun 19:30 PST for B3). Use Manage timings as H1 if needed.
2. As B3, open Reschedule on a different session of the same week. Propose Mon 20:00 IST (= Mon 06:30 PST): two different days on B3's calendar, one day on H1's.
3. Read the refusal. Repeat as H1 placing a second session on that Monday from the allocate grid.

**Expect:**

- Refused: per-day cap in the host's scheduling zone (`Subscription.schedulingTimezone = Asia/Kolkata`). Record the code and copy.
- For a viewer whose zone differs, `limitBucketNote` appends " Days are counted in Asia/Kolkata: this day is <Mon date>, <span> on your clock."

**Probe further:**

- `limitBucketNote` compares the bucket zone with the **browser** zone and formats "on your clock" in the browser zone, not the profile zone (`viewerTimezone()` reads `Intl…resolvedOptions()`). With B3's browser in IST the note disappears; with H1's browser in London it appears for H1. Report **BUG** (P2) per surface.
- The note names a raw IANA zone and a US date ("Jul 20, 2026") while the rest of the page is en-IN. **COPY** (P3).
- B3's grid: does the Monday-IST session paint the whole of B3's Monday as "Limit reached", or Sunday evening too? Describe what B3 sees.

## TZ-10 — Plan-week edges seen from another zone

**Needs:** TZ-09's subscription.

**Steps:**

1. As H1 and as B3, read the context chip "Week N of W" and any week range on the allocate page, reschedule page and the subscription detail.
2. Compute the plan weeks with this SQL (plan weeks are whole host-zone days from the purchase day, `lib/booking/entitlement.ts`):

```sql
SELECT o."startsAt",
       floor((o."startsAt" AT TIME ZONE s."schedulingTimezone")::date
             - (s."schedulingPeriodStartsAt" AT TIME ZONE s."schedulingTimezone")::date) / 7 + 1 AS plan_week
FROM "AppointmentOccurrence" o JOIN "Appointment" a ON a.id = o."appointmentId"
JOIN "Subscription" s ON s.id = a."subscriptionId"
WHERE s.id = :sid AND o."deletedAt" IS NULL ORDER BY 1;
```

3. Compare with R-06's second query (7 × 24 h buckets from the purchase instant).

**Expect:** week boundaries are IST midnights. For B3 a week starts at 10:30 am PST on a Sunday or Monday. The SQL above and the chips agree.

**Probe further:** R-06 buckets on the purchase **instant** + 604 800 s, not on host midnights. A session early on day 7 lands in week 1 by R-06 and week 2 by the product. Report **DOC-DRIFT** against `_shared/sql-recipes.md` R-06 if they disagree for any row. Does B3 see any week range at all? If B3 sees "Week 2" with no dates, can they tell when it starts?

## TZ-11 — A webinar and a class read in four zones

**Needs:** a published H2 webinar with seats (`qa-WE-05`) and a sold H2 class (`qa-CL-01`), or fresh ones.

**Steps:**

1. As B1, B2, B3 and DR, open the public event page and, where seated, the appointment detail. Read date, start, end, "Free cancellation until …" and any countdown.
2. Record each value as `local (zone) = UTC` and compare with `startsAt`.

**Expect:** each viewer sees their own wall clock; DR or B3 sees a different calendar date where the conversion crosses midnight. "Free cancellation until <start − window>" (`components/events/FreeCancellationLine.tsx`) is in the viewer's profile zone, with a zone label only when it falls back to the browser zone (signed out).

**Probe further:** the free-cancellation line uses "EEE d MMM, h:mm a" ("Sat 27 Mar, 12:30 PM"); the page's other times use "12:30 pm". **INCONSISTENCY** (P3). Signed out with the browser in Sydney: the line shows a label; the event time beside it may not. Record.

## TZ-12 — Org dashboards print IST for everyone

**Steps:**

1. As OS, open `/dashboard/organization/[Wipro]/appointments`. Read a session date (CO-12's sponsored booking if present).
2. Change OS's profile zone to Europe/London (Settings → Account), reload, read again. Restore IST.
3. As OH, open LearnPro's appointments and compensation for CO-17's booking, with OH's browser emulated in London.

**Expect:** the org list formats session dates with `timeZone: "Asia/Kolkata"` regardless of viewer (code comment: "Fixed IST, matching the member view and the compensation page").

**Probe further:** OS in London sees IST times with no "IST" label. Report **FALSE-INFO** (P2) if no label says the column is IST. The same booking on OS's personal consultee view (if any) uses London. Note `PayerRequestsView` "Requested" dates use `toLocaleDateString()` (browser zone and browser locale): compare.

## TZ-13 — Staff and admin views carry no zone

**Steps:**

1. As ST, with the browser emulated in Europe/London, open `/dashboard/staff/appointments`, a payment detail `/dashboard/staff/payments/[paymentId]` for TZ-02's payment, `/dashboard/staff/money/refunds` and the support appointment context card.
2. Repeat with the browser in Asia/Kolkata.

**Expect:** operators have no profile zone ("—" in R-01), so surfaces resolve to the browser zone or UTC. Every operator surface should say which zone it shows.

**Probe further:** the operator appointments list resolves a viewer zone server-side (`getViewerZone`) and falls back to UTC; payment and refund pages use `toLocaleString()` (browser). One operator sees two zones on two pages for one payment. Report **INCONSISTENCY** (P2) with both values.

## TZ-14 — A Kathmandu buyer reads IST times at :15 and :45

**Setup:** change B4's profile zone to Asia/Kathmandu in Settings → Account. Restore IST at the end.

**Steps:**

1. As B4, open H1's expert page. Read the zone line and the starts on Tue D+1.
2. Book H1's free 30-min consultation at Tue D+1 17:00 IST (shown 5:15 pm).
3. Read B4's surfaces, N-1, N-2.

**Expect:** zone line "Times shown in GMT+5:45 (UTC+05:45)" (or similar); starts at 5:15 pm, 5:45 pm …; `startsAt = (D+1) 11:30:00Z`; bell and email "… 5:15 PM GMT+5:45".

**Probe further:** the device-zone switch appears only if the browser zone differs. Run once with the browser in Kathmandu and once in IST. Does every list (Home "today", Appointments) agree on 5:15 pm?

## TZ-15 — A Kathmandu host can't convert weekly hours

**Setup:** H3 (New York, weekly F-AV3). Restore at the end.

**Steps:**

1. As H3, change the profile zone to Asia/Kathmandu. Save. Read the prompt "Convert my weekly hours to Asia/Kathmandu?".
2. Click **Convert**. Read the toast.
3. Reload Availability. Read the zone notice.
4. Change the profile zone back to America/New_York; answer the prompt with **Keep in America/New_York** (rows never moved).

**Expect:**

- Step 2: `POST /api/scheduling/availability/weekly/zone` refused with the `ZONE` refusal: "Weekly hours can't be published in Asia/Kathmandu yet: its UTC+05:45 offset puts every local hour off the 30-minute booking grid. Use date-specific availability instead." Toast title "Couldn't convert your weekly hours". Rows unchanged (R-02).
- Step 3: "Times are in America/New_York and follow daylight saving automatically." plus the alert "Weekly hours kept in America/New_York".

**Probe further:** the refusal tells H3 to use date-specific availability, but switching schedule type is locked while appointments are active (HM-08). Is there a path forward? **MISSED-OPPORTUNITY** if not. Does H3's public page keep working in the meantime?

## TZ-16 — An overnight window: a session across the host's midnight `[local]`

**Setup:** as H3, add a weekly window Fri 22:00 → Sat 01:00 (overnight). Restore F-AV3 at the end and say so. Salvaged from old 005 (overnight checkout guard).

**Steps:**

1. R-02 for H3: the new row has `localStartDay = FRIDAY`, `localEndDay = SATURDAY`, `localStartMinutes = 1320`, `localEndMinutes = 60`.
2. As B1 (IST), open H3's page for Fri D+4. Book Fri 23:30 EST → Sat 00:30 EST (60 min).
3. Book (or try) Sat 00:00 → 01:00 EST: the carry-over part only.
4. Try Fri 21:30 → 22:30 EST via `POST /api/checkout`: half outside.
5. R-05 for H3.

**Expect:**

- Step 2: 200. `startsAt = (D+5) 04:30:00Z`. B1 sees Sat 10:00–11:00 am IST (one day for B1); H3 sees Fri 11:30 pm–Sat 12:30 am.
- Step 3: 200 (inside the carry-over).
- Step 4: refused, typed availability code, no `Payment`.
- H3's grid draws the step-2 session as one block across the midnight line; the tray splits chips per local day if the grid does that (record).

**Probe further:** which day does H3's Home "today" list it under on Friday night? Which day does the per-day cap count for a plan session that starts 23:30? (Expect the start day.) The `Duration` and end-time labels: "11:30 pm–12:30 am" is right; anything saying "Fri 11:30 pm–Fri 12:30 am" is **FALSE-INFO**.

## TZ-17 — Sunday for one party, Monday for the other: "today" and "tomorrow"

**Needs:** TZ-03 (B3 Sunday evening = H1 Monday morning) before it is cancelled in TZ-08, or rebook one.

**Steps:**

1. On Sun D+6 (or with the session shifted with owner approval to start about 10 h from now, keeping the UTC half hour), open B3's Home and H1's Home.
2. Read every relative word: "Today", "Tomorrow", "In 10 hours", reminder bell text.

**Expect:** B3's Home lists it under today (Sunday evening for B3); H1's under tomorrow (Monday morning IST) or "today" once IST passes midnight. Relative words follow each viewer's zone.

**Probe further:** any "today" computed from the browser clock rather than the profile zone shows up when the browser is emulated in another zone. Record each surface that flips.

## TZ-18 — Booking from a zone with a half-hour offset at UTC midnight

**Steps:**

1. As B2 (London), open H2's page (F-AV2: Tue/Thu 07:00–09:00 IST = 01:30–03:30Z).
2. Read the Tuesday column. Book or open checkout for Tue 07:00 IST (shown 1:30 am Tue for B2).
3. As B3 (LA), read the same slot: Mon 5:30 pm PST.

**Expect:** the slot sits on Tuesday for B2 and on Monday for B3; checkout carries `startsAt = …T01:30:00Z`.

**Probe further:** H2's own grid in IST starts the Tuesday column at 7:00 am; the UTC date is the same day. Look for any surface that uses the UTC date (`toISOString().slice(0, 10)` style) as the "day": it would show the wrong day for B3. Record any.

## TZ-19 — Restore the folder's zone changes

**Steps:** restore every profile zone changed in this file (B4, H3, OS and any from TZ-01), restore F-AV3 (remove TZ-16's overnight row), cancel or clean up the bookings in your ledger (R-09 order), and run R-01 and R-02 once more.

**Expect:** R-01 matches the personas table. H3's weekly rows match F-AV3 exactly.

**Probe further:** after restoring a zone, does every surface flip back at once, or does a stale session keep the old zone until sign-out? Record which.
