# ADR: A notify-me list for sold-out webinars and classes

- **Status**: Accepted (owner decisions, 2026-11-07)
- **Date**: 2026-11-07
- **Author**: Platform engineering
- **Related**: [Attendee comms for webinars, classes and 1:1 sessions](2026-11-07-attendee-comms.md), [Notification preferences have one owner](2026-11-06-notification-single-preference-owner.md), `docs/start-here/01-booking-system-hld.md`, `docs/booking/13-cron-jobs-and-background-tasks.md`, `docs/notifications/02-workflows-and-api.md`

## Context

A webinar or class that sold out gave a learner nothing to do. The checkout refused them, and the toast pointed at a "waitlist" that did not exist. Seats do free up: a learner leaves, a host removes an attendee, an unpaid hold lapses, or the host raises capacity. A learner who wanted in had to keep reloading the page. The platform already has a similar list for 1:1 windows (`WindowBackupInterest`), but a group event has many seats, one shared roster and a checkout that already decides who may buy.

## Decision

1. **Notify only; nothing is reserved.** A learner on a sold-out event presses "Notify me" and gets a row in `AppointmentWaitlist`. When a seat frees, every eligible waiter is told at the same moment and the first to pay gets the seat. There is no queue position, no reservation and no offer window, so no seat can sit unsold behind a waiter who never answers. The capacity gates and the 200-seat ceiling (`MAX_GROUP_SESSION_PARTICIPANTS`) are unchanged.
2. **A notified waiter is told again after 12 hours.** `INTEREST_RENOTIFY_COOLDOWN_MS` (`lib/booking/interest/lifecycle.ts`) is 12 hours, so a waiter receives at most two notices a day per event. The owner asked for one or two a day to save the free email quota, and 12 hours is the upper end of that; 24 hours is the alternative if volume needs it. The bucket in the dedupe keys is `floor(now / cooldown)`, so a retried transaction re-stages the same keys.
3. **Quiet hours are not applied.** Seat-opened notices go out the moment a seat opens, at any hour. The race is first to pay, so holding some waiters' notices until their quiet window ends would hand the seat to the others, and bells are in-app only, so they make no noise at night. The email copy says so. Only the consultant planning reminder (`lib/booking/week-nudge.ts`) reads `quietHours*`.
4. **The notice links straight to checkout** for that session (`eventCheckoutHref`: `/checkout/plans/<webinar|class>/<planId>?eventId=<eventId>`). The bell uses it as its redirect (`checkoutUrl`) and the email as its button.
5. **Caps.** The list holds at most `min(waitlistMax ?? 200, 200)` open rows (`WAITLIST_FULL`); `waitlistMax` is a nullable plan column, at least 1 by the sidecar CHECKs `webinar_plan_waitlist_max_min` and `class_plan_waitlist_max_min` and at most 200 in Zod. A learner may hold at most five open rows across events (`EVENT_WAITLIST_USER_CAP`, `EVENT_WAITLIST_CAP`). The host can switch the list off per plan (`waitlistEnabled`); switching it off expires the plan's open rows silently (`expireEventWaitlistForPlan`).
6. **On sale, including late join (owner decision, 2026-11-08).** A webinar is on sale while it is `SCHEDULED` with a session ahead. A class is on sale by checkout's own rule: `SCHEDULED` or `IN_PROGRESS` with `classEnrolmentFrom(...).state === "open"`, so a running class whose late-join cut-off has not passed takes waiters and notifies them. The join and the notice share this one rule (`onSale` in `lib/booking/event-waitlist.ts`).
7. **Who may join.** `joinEventWaitlist` refuses in this order: a missing event or a plan the caller may not view (the same 404 `EVENT_NOT_FOUND`, so a hidden plan does not leak), a closed event (`EVENT_CLOSED`), a class past its enrolment cut-off (`ENROLMENT_CLOSED`), the host or an accepted co-host (`assertNotSelfBooking`, like checkout), a plan with the list switched off (`WAITLIST_DISABLED`), an event with seats left (`EVENT_NOT_FULL`), a learner who already holds a seat or may not buy one again (`seatRebuyRefusal`, the same classifier checkout uses, with the existing messages; a learner who left a price-free seat may wait and take an offer, and a removed one may not until the block is lifted, see [Free seat rejoin](2026-11-18-free-seat-rejoin.md)), and then the two caps inside a Serializable transaction. The transaction re-reads the event and repeats every one of these checks on each attempt, so a seat released between the first read and the insert answers `EVENT_NOT_FULL` instead of a stale "sold out". Joining twice is idempotent, and an `EXPIRED` row reopens as `WAITING`. A waiter keeps a "You're on the list · Leave" control on the plan page after a seat opens, so a `NOTIFIED` row can always be left.
8. **Eligibility at notice time.** `stageSeatOpenedNotices` returns nothing unless the event is on sale, has the list on and has a seat left. It then reads at most 200 waiters in `createdAt` order (`WAITING`, or `NOTIFIED` for longer than the cooldown), keeps only active members of the organisation for an organisation-only plan, drops anyone who holds a seat or cannot buy one (`canBuySeat`, `findPriorSeatPayments`), and marks anyone who already holds a paid seat `BOOKED` as a backstop. One `updateManyAndReturn` whose `WHERE` repeats the status and cooldown test flips the rest to `NOTIFIED`; Postgres re-checks the `WHERE` on the newest row version, so two concurrent releases notify each waiter once. The query count is the same for one waiter or 200.
9. **Where a released seat triggers the notice.** Every row below calls `stageSeatOpenedNotices` inside its own transaction with a `now` captured outside the retry, and `finishSeatOpenedNotices` after the commit.

   | Release path                                      | Where it stages                                                                                                                            |
   | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
   | A learner leaves, or the host removes an attendee | `leaveEventSeat` (`lib/booking/seat-leave.ts`), after the refund marker is stamped; the finish runs through `scheduleAfter`                |
   | An unpaid hold lapses                             | `releaseGroupSeats` in `scripts/payments/cleanup-abandoned-payments.ts`, once per appointment and only if a release freed a seat           |
   | A buyer abandons their held seat                  | `abandonSeat` (`lib/booking/abandon.ts`)                                                                                                   |
   | A buyer cancels a pending checkout                | the group branch of `releaseSlots` (`lib/payments/operations/cancel-pending.ts`)                                                           |
   | The host raises capacity above the enrolled count | the PATCH of `app/api/bookings/webinars/crud-with-plan/route.ts` and `app/api/bookings/classes/crud-with-plan/route.ts`; the guards decide |

   Doors left unhooked on purpose: a superseded hold in `checkout/order-reuse.ts` (the same buyer re-mints, so no seat is freed overall); a whole-event cancel, which the expiry arm of the stale-requests job closes within 15 minutes and which the `SCHEDULED` guard would refuse anyway; and the rare doors (an admin seat refund, moderation, organisation member removal), where a missed notice costs one reload.

10. **BOOKED and EXPIRED.** `markEventWaitlistBooked` sets `BOOKED` when a capture confirms the seat (`confirmSeatAfterCapture` in `lib/payments/webhooks/handlers.ts`) and when a seat is confirmed without a payment (`skipPayment` in `lib/payments/checkout/commit/payment-row.ts`). `expireEventWaitlist` runs inside the existing stale-requests job (`scripts/appointments/expire-stale-requests.ts`), with `hasLapsedEventWaitlist` in its idle probe: it expires open rows whose event ended, was cancelled or has no future session, and deletes `EXPIRED` and `BOOKED` rows 30 days after their last change (`INTEREST_RETENTION_MS`). No new cron job is registered.
11. **The bell's scope.** A waiter holds no seat yet, so `stageScopedPages` (`lib/novu/scoped-pages.ts`) stages one page set per scope: an organisation-only plan's bell carries the plan's organisation scope, and every other plan's bell is personal.
12. **Best-effort email after the commit.** The bell is staged inside the freeing transaction and is durable. The email (`EVENT_SEAT_OPENED`, `stageEventSeatOpenedEmails`) is rendered and staged after the commit under a claim (scope `event-waitlist.seat-opened`, key `<appointmentId>:<bucket>:<userId>`), then goes through the outbox and `deliver()`, so `EMAIL_DELIVERY_MODE` still applies. If the process dies between the commit and that staging, the waiter keeps the bell and loses the email. Measure the loss by comparing `notifiedAt` rows with staged `EVENT_SEAT_OPENED` rows in `FailedEmail`.
13. **Privacy.** `scrubUser` deletes the user's `AppointmentWaitlist` rows and, in the same change, their `WindowBackupInterest` rows inside the erasure transaction, because users are scrubbed rather than deleted and the foreign-key cascade never fires. The host sees a count only ("N waiting"), never names.
14. **An ordered offer later needs no migration.** Rows are ordered by `createdAt` and carry `notifiedAt` and `bookedAt`. An offer wave for the first N waiters is a `take` plus `orderBy: { createdAt: "asc" }` inside the same compare-and-set.

Conversion, to be read once a month: how many notified waiters went on to book, per plan.

```sql
SELECT "planKind", "planId",
       count(*) FILTER (WHERE "status" = 'BOOKED')               AS booked,
       count(*) FILTER (WHERE "notifiedAt" IS NOT NULL)          AS ever_notified,
       round(100.0 * count(*) FILTER (WHERE "status" = 'BOOKED' AND "notifiedAt" IS NOT NULL)
             / nullif(count(*) FILTER (WHERE "notifiedAt" IS NOT NULL), 0), 1) AS booked_pct_of_notified
FROM "AppointmentWaitlist"
GROUP BY "planKind", "planId"
ORDER BY ever_notified DESC;
```

Rows are deleted 30 days after they settle, so this reads the recent window only.

## Alternatives considered

| Alternative                                     | Why it lost                                                                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| A reserved, queued waitlist with a claim window | Needs an offer timer, a re-offer sweep and a hold on a paid seat; a waiter who never answers blocks the seat. Notify-only needs none of it. |
| Extending `WindowBackupInterest`                | It is keyed on a 1:1 consultant and time windows; a group event is keyed on the shared appointment roster.                                  |
| A 6-hour cooldown                               | Up to four notices a day per event, which spends the free email quota faster than the owner wanted.                                         |
| Per-recipient quiet hours                       | Delaying some waiters' notices gives the others a head start in a first-to-pay race, and bells are silent anyway.                           |
| A notice that links to the event page           | One more click before checkout while the seat may be taken.                                                                                 |
| Notifying from a new cron sweep                 | A sweep notices a free seat minutes late; the releasing transaction already knows, and a new job would add a scheduler entry for nothing.   |
| Hooking every release door                      | The unhooked doors are rare or already closed by the expiry arm, and each extra hook widens a money transaction.                            |

## Consequences

- The event catalogue is 98 events in 16 Novu families (`event-seat-opened` joins the `appointment` family); no family is added.
- The owner steps, in order. Before the deploy, run the read-only drift check `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` and expect only the new table, its indexes and foreign keys, and the two `ADD COLUMN` statements per plan table on top of the known baseline, then run `npm run db:push`, which applies the sidecar CHECKs (`appointment_waitlist_plan_kind_chk`, `appointment_waitlist_notified_at_chk`, `appointment_waitlist_booked_at_chk` and the two `waitlist_max_min` checks), and confirm them with the sidecar check. The plan pages select the new columns, so the push comes before any preview or deploy reads them. At release, run `npm run novu:sync` against Development and then against Production so the `appointment` family body carries the new case.
- A host who switches `waitlistEnabled` off loses the open rows; they are not restored when it is switched back on.
- Hosts cannot see who is waiting; they see how many.
