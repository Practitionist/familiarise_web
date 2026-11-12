# 10-c · Time zones: browser vs profile zone, zone changes, notifications, emails, calendar files and locale

**Needs:** bookings from 10-a (TZ-02, TZ-03) or any live booking per persona; H1 in "Review requests first" mode for TZ-48 (03-c sets it; CO-45 restores it); a seated webinar with buyers in three zones for TZ-46. `[local]` where marked.
**Personas:** H1, H2 (IST), H3 (America/New_York); B1 (IST), B2 (Europe/London), B3 (America/Los_Angeles), DR (Australia/Sydney).
**Docs under test:** `lib/time/viewer-zone.ts`, `lib/time/use-display-zone.ts` (`useZonedFormat`: without a provider it keeps the **runtime** zone), `lib/time/display.ts` (`DISPLAY_LOCALE = "en-IN"`), `lib/novu/service.ts` (per-zone bell payloads), `lib/email/senders/shared.ts` (`whenText`), `emails/payments/PaymentLinkEmail.tsx`, `lib/appointments/ics.ts`, `components/notifications/NotificationPreferencesPanel.tsx`.

**Browser zone emulation.** Use the DevTools MCP `emulate` tool with a time zone override if it supports one. If it doesn't, mark the browser-zone cases BLOCKED (no zone emulation) and still run the profile-zone halves. HM-52 owns the grids; this file covers every other surface.

Use N-1 and N-2 from `01-cross-zone-odd-offsets-overnight.md` for bell and email rows. `FailedEmail."htmlBody"` holds the rendered email: SELECT it to read a body.

## TZ-34 — Browser-vs-profile matrix: the set-up and the rule

**Steps:**

1. Pick two viewers: B2 (profile London) with the browser emulated in Asia/Kolkata; H1 (profile IST) with the browser in America/Los_Angeles.
2. For each, open Home, Appointments (list and calendar view), one appointment detail, Payments, the requests inbox (H1) and the expert page booking dialog. Note each time shown for one known booking against `startsAt`.

**Expect:** every surface renders in the **profile** zone. Grids and the dialog show the zone line with "Use my device's time zone"; switching it is the only way the device zone appears.

**Probe further:** list every surface that follows the browser instead, with the two values. TZ-35 to TZ-40 name the ones found in code; you may find more.

## TZ-35 — Consultation checkout prints the browser's zone and locale

**Steps:**

1. As B2 (profile London, browser IST), pick H1's 60-min consultation at Wed D+2 17:00 IST on the expert page (dialog: "11:30 am", London).
2. On `/checkout/plans/consultation/[planId]`, read the Date, Time and Duration rows.

**Expect (product rule):** the same wall clock as the dialog, in London, labelled the same way.

**Probe further:** code renders Date with `toLocaleDateString(undefined, { weekday: "long", … })`, Time with `toLocaleTimeString()` and appends `Intl.DateTimeFormat().resolvedOptions().timeZone`. Expect "Wednesday, … " and "5:00:00 pm - 6:00:00 pm (Asia/Kolkata)". B2 picked 11:30 am and is asked to pay for 5:00 pm. Report **FALSE-INFO** (P1). Duration reads "1 hours" (TZ-52).

## TZ-36 — Subscription start date and first cycle follow the browser `[local]`

**Steps:**

1. As B3 (profile LA, browser IST), between 18:30Z and 08:00Z (when the IST date is a day ahead of LA's), open H1's weeks plan on the expert page. Read the start-date field's earliest allowed date and the "first cycle" line.
2. Go to checkout. Read "Starts" and "First cycle".
3. Buy with mock pay. Compare `schedulingPeriodStartsAt`, `planEndsAt` with what was shown.

**Expect:** the start date and first cycle in a stated zone. The plan's days are H1's (IST) days (SU-25).

**Probe further:**

- The expert page's date input uses `min={format(new Date(), "yyyy-MM-dd")}` (browser date) and prints the cycle as "MMM dd, yyyy" ("Nov 18, 2026"). Checkout prints `toLocaleDateString()` with no options (browser locale: "18/11/2026" in en-GB, "11/18/2026" in en-US). Three formats for one date. **INCONSISTENCY** (P2).
- The code comment says the first cycle is "in the browser's zone (display only)". The cycle is really bounded by IST midnights. A buyer in LA sees a range that is up to a day off. **FALSE-INFO** (P2) if the shown range and the plan-week SQL (TZ-10) disagree.

## TZ-37 — Pay page and trial checkout use the device zone

**Steps:**

1. As B1 (profile IST, browser America/Los_Angeles), open a live approval pay link `/checkout/pay/[paymentId]` (CO-25 fixture) and a paid-trial checkout `/checkout/plans/trial/[trialId]` (TR-04 fixture).
2. Read "This payment link is open until …", the session time and "Your slot is held until …".

**Expect:** a deadline the buyer can't misread. `ViewerLocalTime` formats in the **device** zone with a short zone name ("Nov 20, 2026, 6:30 AM PST"), after mount; before mount a UTC placeholder ("2026-11-20 14:30 UTC").

**Probe further:** the dashboard shows the same deadline in IST, the pay page in PST. Both are labelled, so this is **INCONSISTENCY** (P2), not false. The device locale decides the format here, unlike the en-IN dashboards.

## TZ-38 — The Appointments calendar view and the lapsed-pay-link row

**Steps:**

1. As B3 (profile LA), open Appointments → calendar view with the browser in LA, then in IST. Find TZ-03's Sunday-evening session.
2. As B1, with a lapsed pay link (CO-34/CO-36 fixture), open Home. Read "Your payment link for … expired on …". Compare with `Payment."expiresAt"`.

**Expect:** the calendar places the session on the profile-zone day; the lapsed row's date is the profile-zone date.

**Probe further:**

- `AppointmentCalendar` uses date-fns `format` (runtime zone) to bucket days and print "7:30pm". With the browser in IST the event moves to Monday. **BUG** (P1: wrong day) if it moves.
- `LapsedPayLinkRow` formats `expiredAt` with date-fns on the server (Netlify runs in UTC). A link that expired at 02:00 IST shows the previous day. Shift `expiresAt` to 2026-mm-dd 20:30Z (02:00 IST next day) with owner approval to see it. **FALSE-INFO** (P3).
- The row says "Ask <expert> for a new link" next to a **Request again** button. Which is it?

## TZ-39 — Editor validation reads the browser clock

**Steps:**

1. As H2 (profile IST), with the browser emulated in Asia/Kathmandu, open the webinar editor for an unsold webinar. Pick a Free start (for example 7:00 pm IST) in the picker. Change only the title. Save.
2. As H3, with the browser in Asia/Kolkata, open the class editor and type Start date 2027-01-11 18:00.

**Expect:** the webinar saves (the server checks the UTC half hour); the class starts at 18:00 in H3's zone or the form says which zone it reads.

**Probe further:**

- Writer report (04–06): the webinar form once checked `getMinutes() % 30` on a browser `Date` and the lead in the browser. The schema now checks only the UTC lattice (`isOnEventLattice`) and the lead is the server's, so neither blocks this save. Any form refusal here is a **BUG**; record the copy shown.
- CL-02 owns the class editor's browser-zone start date; here record only the instant saved (expect 12:30Z if read as IST, 23:00Z if read as New York) and whether anything labels the field.

## TZ-40 — Quiet hours default to the device zone

**Steps:**

1. As B2 (profile London, browser IST), open Settings → Notifications. Turn on the quiet-hours toggle ("Hold planning reminders"). Read the zone select.
2. As H1 (consultant), do the same with the browser in LA. Save 22:00–07:00.
3. Read `NotificationPreference` (or the preferences API response) for `quietHoursTimezone`.

**Expect:** the zone defaults to the profile zone, or the page says it uses the device zone.

**Probe further:**

- Code: `quietHoursTimezone: browserTimezone` on enable; fallback "Asia/Kolkata". B2 gets IST quiet hours without being told. **BUG** (P2).
- The section heading is "Email quiet hours" but the toggle text says the reminder waits "by email and in the bell". **COPY** (P3).
- For H1, a week-nudge (`NEW_BOOKING_REQUEST` with `weekSummary`) staged during quiet hours should carry `notBefore` at the end of the quiet window in the chosen zone (N-1). NEEDS-OWNER-RUN for the nudge job if it can't run.

## TZ-41 — A buyer changes zone in the middle of a plan

**Needs:** a scheduled subscription or class for B2.

**Steps:**

1. As B2, change the profile zone London → America/Los_Angeles. Don't sign out.
2. Reload Home, Appointments, the detail, the reschedule grid and Payments. Then sign out and in, and read again.
3. Make one change that sends B2 a notification (H1 proposes a new time, or a reminder fires). N-1.
4. Restore London.

**Expect:** every surface flips to Los Angeles at once (8 h earlier). DB instants unchanged. New bell rows render in PST/PDT.

**Probe further:** the viewer zone comes from the session (`session.user.timezone`). Any surface that keeps London until sign-out is **BUG** (P2): list them. Old bell entries keep their London text (expected; payloads are rendered at staging).

## TZ-42 — A host changes zone in the middle of a plan: what re-anchors and what doesn't

**Needs:** H3 with a live subscription (TZ-24 or a fresh `qa-TZ-01b` purchase with week 1 scheduled) and F-AV3. HM-09 owns the Convert/Keep basics.

**Steps:**

1. As H3, change the profile zone America/New_York → Europe/London. Answer **Keep in America/New_York**.
2. Read: the availability page notice, H3's grid (now drawn in London), the subscription's week chips, and B1's view of H3's page.
3. Change again (still London) and this time **Convert** (repeat the zone change if the prompt only shows once). Read the toast.
4. SQL: R-02 for H3; `SELECT "schedulingTimezone" FROM "Subscription" WHERE id = :sid;`; R-03 on the subscription.
5. Restore: profile back to America/New_York, **Convert**. R-02 must equal F-AV3.

**Expect:**

- Keep: rows stay `America/New_York`; the alert "Weekly hours kept in America/New_York"; nothing a buyer sees moves.
- Convert: rows become `Europe/London` at the same clock (09:00–17:00 London = 5 h earlier in UTC). Toast "Weekly hours now in Europe/London" plus "N upcoming sessions now fall outside your published hours — they keep their time; reschedule or cancel from Appointments if needed."
- Existing occurrences keep their instants. `Subscription.schedulingTimezone` stays `America/New_York`: plan weeks and per-day caps still count New York days.

**Probe further:** after Convert, H3's grid shows plan-week boundaries at New York midnight (05:00 London) while the hours are London. Does anything tell H3 the plan still counts New York days? **MISSED-OPPORTUNITY**. Buyers with sessions now outside the new hours get no notice (by design: times kept). Does H3's toast link to those sessions?

## TZ-43 — Bell rows are grouped by recipient zone `[local]`

**Needs:** an H2 webinar with seats held by B1 (IST), B2 (London) and DR (Sydney), at least 48 h away.

**Steps:**

1. As H2, re-time it with **Move to a new date** to a Free start ≥ 24 h away.
2. N-1 for the webinar's appointment.

**Expect:** `APPOINTMENT_RESCHEDULED` `outcome MOVED` rows, one per zone group: IST (B1), GMT or GMT+1 (B2), GMT+11 or GMT+10 (DR). Each `oldDateTime`, `newDateTime` and `leaveBy` is in that group's zone. Body: "Your webinar for <title> moved from <old> to <new>. … Can't make it? Leave with a full refund until <leaveBy>."

**Probe further:** if H2 receives a copy, is it worded for the host ("Your webinar … Can't make it? Leave with a full refund") — that would be false for the host. Emails: subject "Your webinar has moved"; body times in each zone (N-2).

## TZ-44 — Email subjects and bodies carry the right zone label

**Steps:** for TZ-02 (B2/H1), TZ-03 (B3/H1), TZ-04 (DR/H1), TZ-14 (B4 in Kathmandu) and TZ-23 (B1/H3), run N-2 and read each subject and `htmlBody` time.

**Expect:** `whenText`: "Wed, 18 Nov 2026 at 11:30 AM GMT", "… PST", "… GMT+11", "… GMT+5:45", "… EST"/"EDT", "… IST". Booked subject to buyer "Your consultation with <name> is confirmed"; to host "New booking: <buyer> for <plan>".

**Probe further:** reminder emails use the same `whenText`. Cancelled subject "Your session on <when> was cancelled" goes to both parties, including the one who cancelled. Report anything that prints an ISO string, a UTC time without "UTC", or the server zone.

## TZ-45 — The payment-link email: expiry in the server's zone, and a 24-hour promise that isn't always true

**Needs:** H1 in "Review requests first" mode (03-c). A request whose session is under 24 h away but more than 2 h (unpaid lead), so the pay window clamps to start − 15 min.

**Steps:**

1. As B1, request H1's 90-min consultation for a time about 6 h ahead (or shift a fresh request's tentative session with owner approval, keeping the UTC half hour).
2. As H1, approve with **Use requested times**.
3. N-2 for the payment (`entityRef` `payment:<id>`). Read the `htmlBody` "Expires:" row and the warning line.
4. Compare with `Payment."expiresAt"` and the bell `PAYMENT_LINK` "(pay by …)".

**Expect:** the email's expiry equals `expiresAt` in B1's zone with a label, and doesn't promise more time than B1 has.

**Probe further:**

- `PaymentLinkEmail` formats with `toLocaleDateString("en-US", …)` and no `timeZone`: the server's zone (UTC on Netlify), no label: "Thursday, November 19, 2026 at 08:45 AM" for 2:15 pm IST. **FALSE-INFO** (P1: wrong deadline).
- The non-reminder warning says "This payment link expires 24 hours after approval": false when clamped to start − 15 min. **FALSE-INFO** (P1). Writer report bug 5 found the same "24 hours" in the settings copy.
- "Great news! … has approved your consultation request." on a page whose deadline is wrong. **COPY** (P3).
- The bell `(pay by …)` is in B1's zone. Compare and report the **INCONSISTENCY**.

## TZ-46 — "Add to calendar": UTC times, the viewer's zone, and a moved session

**Steps:**

1. As B2, open TZ-02's appointment detail → **Add to calendar**. Save the `.ics`. Read `DTSTART`, `DTEND`, `X-WR-TIMEZONE`, `UID`, any `SEQUENCE`.
2. As H1, look for the same action on the consultant detail.
3. Move the booking (CO-46 path). Download again. Compare `UID` and `DTSTART`.
4. Open the signed link from B2's booked email (`/api/calendar/[appointmentId]?…`) signed out.

**Expect:**

- `DTSTART:20261118T113000Z` style UTC; `X-WR-TIMEZONE:Europe/London`; one `VEVENT` per upcoming booked session.
- After the move, the new file has the new `DTSTART`.
- The signed link works signed out and answers 404 for a tampered signature.

**Probe further:**

- The file has `METHOD:PUBLISH` and no `SEQUENCE`; the `UID` is the occurrence id, which a move keeps. Re-importing may not update the old event in Google or Outlook. Record what a calendar app does if you can test one; otherwise note the risk as **MISSED-OPPORTUNITY**.
- The consultant has no Add to calendar (only the consultee detail builds one; booked emails attach links only for the consultee). **MISSED-OPPORTUNITY**.

## TZ-47 — One booking, five date formats

**Steps:** for TZ-02's booking, collect every rendering of its start: grid tray, appointment list, detail, checkout, bell (N-1), email (N-2), "Free cancellation until" (if an event), a cap refusal's bucket note (TZ-09), the pay page.

**Expect:** one house format per medium is fine; the same medium shouldn't mix "pm" and "PM", "24 Nov" and "Nov 24".

**Probe further:** what the code produces today:

| Surface | Example |
| --- | --- |
| Grids, lists, details (`DISPLAY_LOCALE` en-IN) | "Wed 18 Nov, 11:30 am" |
| Bell | "Wed, 18 Nov 2026 · 11:30 AM GMT" |
| Email | "Wed, 18 Nov 2026 at 11:30 AM GMT" |
| Free-cancellation line | "Wed 18 Nov, 11:30 AM" |
| Cap bucket note | "Nov 18, 2026" |
| Consultation checkout | browser locale, seconds, IANA name |
| Payment-link email | "Wednesday, November 18, 2026 at 11:30 AM" (server zone) |

Report one **INCONSISTENCY** (P3) with the table you observed. A London or US user reading en-IN dates is acceptable if consistent; say whether it is.

## TZ-48 — Money formats

**Steps:** for one paid booking and one refund, read the amount on checkout, the cancel dialog, Payments, the payment detail, earnings (H1), the bell (`PAYMENT_SUCCESS`, `REFUND_PROCESSED`), emails and the staff payment page. R-04 for the paise values.

**Expect:** `formatCurrencyAmount` (en-IN): "₹500.00", lakh grouping for large values ("₹1,00,000.00"). Never raw paise ("50000"), never "Rs", never "INR 500" next to "₹500".

**Probe further:** the consultee refund line in `useEventActions` divides paise by 100 and calls `toLocaleString("en-IN")` itself. Compare its output ("500" vs "₹500.00") with the cancel dialog. Report each mismatch. Free bookings: "₹0.00", "Free" or nothing? Pick one per surface and report mixes.

## TZ-49 — Plurals and units

**Steps:** collect these strings while running the folder (and trigger them where you can):

1. Consultation checkout "Duration" for 60, 90 and 30-min plans.
2. The grid's "Not enough consecutive slots" toast on a 60-min plan (HM-31).
3. The tray and partial toasts with 1 and 2 remaining sessions.
4. The allocator's `ALREADY_ALLOCATED` copy ("… (1 confirmed slot(s) exist).").
5. "Remind sent · next in 1 h" and the remind toast.

**Expect:** "1 hour", "1.5 hours" or "90 minutes", "30 minutes"; no "slot(s)"; one name for a time unit across a page.

**Probe further:** code today: checkout `{durationInHours} hours` ("1 hours", "0.5 hours"); `notEnoughConsecutive` "Each session requires 1 hours (2 consecutive slots)"; "slot(s)". Report each as **COPY** (P3) with the page. 13-copy-a11y-responsive references this case instead of repeating it.

## TZ-50 — Twelve or twenty-four hours

**Steps:** as B2 (London), whose users expect 24-hour times, read the grid, list and emails. Look for any setting that changes the clock format.

**Expect:** the product picks one format and uses it everywhere. There is no 12/24-hour setting (code comment in `lib/time/display.ts`).

**Probe further:** the grid reads "7:30 pm", the bell "7:30 PM". Is a 24-hour user ever shown "19:30"? Only browser-locale surfaces (TZ-35, TZ-37) would. Note them under TZ-47's table.

## TZ-51 — Two personas, one week, no relative-time drift

**Steps:** with B3 (LA) and H1 (IST) both signed in (`[two-browser]`), open their Home pages within one minute of each other around 18:30Z (midnight IST). Read "Today", "Tomorrow" and countdowns for TZ-03's booking (or any shared booking).

**Expect:** each Home's "today" follows its own profile zone. Countdowns ("Starts in 3 h") agree to the minute.

**Probe further:** at 18:30Z H1's day changes. Does H1's Home refresh "Tomorrow" to "Today" without a reload? Stale relative words are **DESIGN** (P3).

## TZ-52 — Restore

**Steps:** restore every profile zone, quiet-hours setting and availability change made in this file; cancel the bookings you made (R-09 order); confirm H1 is back in Instant mode if you used TZ-45 (CO-45).

**Expect:** R-01 and R-02 match the personas and fixtures tables.

**Probe further:** none. Record the ledger.
