# The appointment detail page

This page explains how the appointment detail page is laid out and why. The page is the same component for every booking kind (consultation, subscription, webinar, class, trial) and every viewer (consultant, consultee, organisation): `AppointmentDetailClient` in `components/appointments/detail/`, mounted by the `appointments/[appointmentId]/page.tsx` route of each dashboard tree.

## The layout

The page has four parts, read top to bottom.

1. **The banner.** One amber banner sits at the very top whenever the viewer must act: pay (with the hold's deadline and Pay), accept or decline new times (the other party of an open reschedule), approve or decline a request, or place a paid plan's sessions. It carries the deadline, a countdown and the primary button, and there is never a second banner (`NeedsYouCallout` in `components/appointments/detail/`). A learner waiting on a request sees a quiet grey line instead, and a joinable session or a session to rate uses the same slot.
2. **The header.** An eyebrow names the kind ("Class", "Subscription") beside the one status badge, and under the badge one plain reason line ("Payment was not completed in time.", "Hannah proposed Tue 18 Nov, 10:00 am; originally Mon 17 Nov, 9:00 am."). The badge and the line come from `bookingStatus` (`lib/appointments/booking-status.ts`) through `deriveBookingPresentation`, so they read the same as the Appointments list. The title follows, then the other party with their avatar and the session count. Under it, a **Next up** panel shows the next session as a day tile, the time range, the full date and a live countdown. When the other party's saved time zone differs from the viewer's, the panel adds their wall clock ("Mon 5:30 AM for Hannah (GMT)"). The panel also carries the next session's **Join** button the whole time: disabled with "Opens at 9:45 AM" until the join window opens (15 minutes before the start for both sides, `CONSULTEE_JOIN_WINDOW_MS` and `CONSULTANT_JOIN_WINDOW_MS` in `lib/appointments/occurrences.ts`), then Join, then Rejoin. A held seat whose payment never succeeded has no Join.
3. **The main column.** Notices (the trial's "Continue with {expert}" card, quiet before the session and prominent once it is completed), the open reschedule proposal (its times and expiry; the proposer withdraws here), the review nudge, then the **Sessions** card and, for the host, the participants (attendees only; the host and co-hosts are not counted).
4. **The right rail.** Details, Resources, Help, Payment and the timeline, in that order. The rail stays narrow (280–340 px) so the sessions keep the width. A session inside a plan or class is never paid on its own, so the Payment card shows the plan-level or seat-level payment.

**One zone.** Every deadline and time on the page, the Payment card's "link valid until" and the timeline included, is in the viewer's profile zone (the page passes `viewerZone` to the derivation).

**Fresh after an action.** Withdrawing, cancelling or answering a reschedule refetches the page; opening Pay marks it stale so the return shows the paid state. A successful seat leave goes to the Appointments list instead, because the released seat can no longer read the page.

Destructive booking actions (Cancel booking, Withdraw request) stay in the "Manage booking" row at the foot of the page, after Get help, so they never lead the page.

## One list of sessions

The Sessions card renders `SessionSchedule` (`components/appointments/detail/SessionSchedule.tsx`), which replaces the old pair of a compact timeline plus a second list of the same dates carrying "Cancel this session" or "Return to plan" buttons.

- **Rows.** Each row is a day tile, the time range, a detail line ("Session 4", the length when lengths differ, "Same day as another session") and the row's status.
- **Status.** Upcoming is the default and carries no word. The next session shows its countdown, a session in its join window shows Join, and only the states a reader must notice carry a word and a dot: Done, Cut short, No-show, Verifying, No record, Live now, Cancelled. Colour is kept for those exceptions; the colour palette itself is a separate pass.
- **Cancelled class sessions stay listed.** A session the host cancelled keeps its row with its state ("Cancelled by the host · make-up owed", "· make-up Tue 18 Nov, 4:00 pm", "· refunded instead"), so a week with only a cancelled session no longer reads "No sessions this week".
- **Per-session actions.** A row's actions come from `rowActions(session)`. The first enabled, non-destructive action also shows inline on hover or keyboard focus; every action is in the row's menu. A blocked action stays in the menu, disabled, with its reason under the label (for example why a session can't be returned to the plan). Confirmation goes through one shared `SessionConfirmDialog`.
  - The host's "Cancel this session" for a class comes from `useClassSessionActions` (`ClassSessionControls.tsx`). A make-up is scheduled from the cancelled (or missed) session's own row: "Schedule make-up" opens a dialog with `SingleTimePicker` (host audience, purpose `makeup`), which keeps the pick inside the 14-day make-up window through `allowedEnd`. Nothing stacks above the list.
  - The consultee's "Return to plan" for a subscription comes from `useSubscriptionReturnActions` (`SubscriptionReturnControls.tsx`), with the rule and the returns used as a footnote under the list.
- **Grouping.** Past sessions fold behind "N past sessions". Upcoming sessions are grouped by week when the schedule spans weeks. Weeks are counted from the first session's day in the viewer's zone (`buildScheduleModel` in `lib/appointments/session-schedule.ts`), so a week never splits at the server's midnight. An empty week between sessions is listed as "No sessions this week", and a week with fewer sessions than the plan's weekly count says "1 of 2 this week".
- **Moving a sold class.** The host's "Move upcoming sessions" (`ClassSeriesRetimeButton`) sits in the Sessions card header beside the schedule buttons, because it changes every session in the list.
- **Progress.** A class shows one "N of M done" bar at the top of the card. A subscription keeps its entitlement count in the header ("1 of 4 sessions scheduled") and shows no second bar.
- **Time zone.** The zone is named once, above the list ("Times shown in IST (UTC+05:30)"), with a switch to the device's zone when it differs. Rows never repeat the zone.

## Money on a group event

The host's Payments card for a webinar or class counts attendee seats, not amounts. A seat that cost nothing (a free event or a full discount) reads "Free" (not "Paid") and is counted as a free seat, not a paid one; when every seat was free the card says "Nothing — every paid seat was free" instead of a bare "₹0.00 collected". The learner's money door reads "Problem with this charge" only when they were charged (a succeeded payment above zero), otherwise "Problem with this booking".

## What the money line may claim

The Payment card's money line, the Billing history row and the payment page read one payment through the same derivation (`deriveBookingPresentation` in `lib/dashboard/money-state.ts`), so all three print the same badge and sentence. Each reader hands it the booking's `source` (pay-first checkout or submitted request), the payer's own live seat on a webinar or class, and, per payment, `gatewayOrderMinted`: false only for a pre-mint placeholder whose order was never created (`isPreMintIntent`). The gateway order id itself never leaves the server.

| What the rows hold                                                      | Badge         | Line (learner)                                                                                                                                                                             |
| ----------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An open order inside its window                                         | Due           | "₹500.00 due · Razorpay · link valid until Fri 20 Nov 14:00"                                                                                                                               |
| An order still `PENDING` past its window, on a booking that is not over | Not completed | "The payment window closed on Fri 20 Nov. If your payment still goes through, the booking is confirmed while the time can still be booked; otherwise the money is refunded automatically." |
| An order the expiry sweep closed (`EXPIRED`)                            | Not completed | "The payment link expired on Fri 20 Nov. If you were charged, the money is refunded automatically."                                                                                        |
| An order on a booking that was cancelled                                | Not completed | "This order was cancelled. If you were charged, the money is refunded automatically."                                                                                                      |
| A failed payment                                                        | Not completed | "The payment did not go through. If you were charged, the money is refunded automatically."                                                                                                |
| Only pre-mint placeholders, or no Payment row at all                    | Not charged   | "Nothing was charged for this booking." (or "Nothing was charged — the payment link expired.")                                                                                             |

"If you were charged, the money is refunded automatically" is said only where `handlePaymentSuccess` really refunds a late capture: on an `EXPIRED` or `FAILED` order it records the capture as `SUCCEEDED`, confirms nothing and refunds it, and on a booking that has ended (cancelled, declined or expired) the confirmation finds it terminal and refunds. An order still `PENDING` past its window is different, because the sweep has not claimed it yet: its capture goes through `confirmExistingAppointment`, which confirms the booking when the time is still free and refunds only when another booking now holds the time or the session has started. Its line therefore names both outcomes and never promises a refund or says "Not due yet". A webinar or class seat reads "while a place can still be booked".

"Nothing was charged" is said only in the last row, because a created order can still capture. "Not due yet — you are asked to pay after the expert approves" is said only for a request with no order open; a request carrying an open order reads Due, or the closed-window line once its window has passed, even on a reader that does not know the booking's source. The expert reads the same lines with the learner's name ("If Charlotte's payment still goes through, …", "If Charlotte was charged, …"), on the booking page and on the Requests row. The payment page labels the amount "Would have been" and offers no "Problem with this charge" only when nothing was provably charged. The table is pinned through each screen's real query by `__tests__/dashboards/money-state-provable.test.ts`, and the closed-window and swept rows are paired with the real capture's outcome on Postgres by `__tests__/db/booking/late-capture-money-line.db.test.ts`.

### Book again while an order can still capture

The learner's "Book again" (shown on a past or cancelled booking) is the shared `RequestAgainButton`. When the booking still holds an order that is `PENDING` past its window (the closed-window row above), it first asks "Close your earlier payment link? Your earlier payment link will be closed. If it was already paid, the money is refunded automatically." Then it calls `POST /api/bookings/[bookingId]/request-again`, and it opens the expert's page only when the route answers `{ closed }`. A capture that won first answers `409 ALREADY_PAID` ("Your earlier payment went through, so that booking is confirmed. No new request was started."), and the page refreshes onto the confirmed booking. With no such order, "Book again" is a plain link. See `docs/decisions/2026-11-20-request-again-closes-the-old-order.md`.

## The public class schedule

The class listing's schedule (`BatchSchedule` under `app/explore/programs/plans/classes/[classPlanId]/components/`) follows the same rules. It names the zone once per batch, shows no status pill on upcoming sessions, groups by week in the page's zone through the same `buildScheduleModel`, and shows a session's length only when lengths differ. When fewer sessions are on the calendar than the plan sells, the enrolment line says so: "Join now for ₹X · all 24 sessions (12 scheduled so far)".

## Deprecated & Superseded Approaches

- **"Nothing was charged" on every unpaid booking.** A cancelled or expired gateway order read "Nothing was charged for this booking." and a lapsed link "Nothing was charged — the payment link expired", although the order could still capture. Replaced by the table in "What the money line may claim".
- **Payment rows read without the booking's source.** The Billing row and the payment page called a pay-first hold a submitted request, so a hold whose window had passed read "Not due yet — you are asked to pay after the expert approves" while its booking page read "Payment link expired".

- **The rail order Payment, details, resources, timeline, help, and the needs-you callout inside the header.** The banner now leads the page and the Payment card sits under Help.
- **Per-surface status words.** The header badge used the learner's list chip for a confirmed booking and the derivation's own words otherwise; both now come from `bookingStatus`.

- **A second list of session actions.** `ClassSessionControls` and `SubscriptionReturnControls` used to render their own list of upcoming dates under the Sessions card, each with a button. The same dates appeared twice. The actions now live on the session rows.
- **`SessionTimeline` on the detail page.** The compact timeline with uppercase status words (UPCOMING, COMPLETED) and emoji icons is still used by `AppointmentSheet`, but the detail page no longer renders it.
- **A zone suffix on every row.** The public schedule printed "GMT+5:30" after every time; the zone is now named once per batch.
- **`groupSessionsByWeek`.** It grouped weeks at the runtime's midnight and was removed in favour of `buildScheduleModel`.
