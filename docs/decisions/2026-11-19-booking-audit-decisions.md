# ADR: Booking audit decisions: nothing is placed without a click, batches for long classes, and the limits that follow one clock

- **Status**: Accepted (owner decisions, 2026-11-19). Each decision carries its own marker: **built** means built in [#2892](https://github.com/Practitionist/familiarise_web/pull/2892), the pull request that adds this record; **built in the follow-up change** means built in the pull request after it; **follow-up PR**, **planned** and **deferred** are not built yet.
- **Date**: 2026-11-19
- **Author**: Platform engineering
- **Related**: [Booking v2 direction](2026-11-03-booking-v2-direction.md) (item 7 is reversed here), [Booking v2 train B](2026-11-04-booking-v2-train-b.md) (decisions 1 to 5 are deferred here), [Allocation and reschedule correctness](2026-11-14-allocation-reschedule-and-short-notice-moves.md), [Scheduling surfaces and feasibility](2026-11-09-scheduling-surfaces-and-feasibility.md), [Booking system HLD](../start-here/01-booking-system-hld.md), [Cron jobs and background tasks](../booking/13-cron-jobs-and-background-tasks.md), [Cancellation flow](../booking/08-cancellation-flow.md), [Rescheduling flow](../booking/07-rescheduling-flow.md), [Booking API reference](../booking/04-api-reference.md)

## Context

A read-only audit of `dev` on 18 and 19 November 2026 found 77 code findings and 16 documentation findings in booking. None was a double booking or a cross-tenant leak. Several findings were product questions, not defects: who may place a session, how a long class is scheduled, what a learner can undo, and how far ahead a 1:1 can be booked. The owner answered those questions on 19 November. This record holds the answers, what is built, and what waits.

## Decisions

1. **Nothing is placed on a calendar unless a person clicks.** The hourly `reconcile-occurrence-availability` job no longer places sessions, for classes or for subscriptions. It clears stale tentative flags, detects double bookings and reports appointments with no live seat. This reverses item 7 ("Top-up retry") of the [3 November record](2026-11-03-booking-v2-direction.md), which let the job place open weeks for plans scheduled with Auto.
   - **Built.** The top-up pass and the plan-level Auto choice are deleted. Every plan with an unplaced current week is reminded on days 0, 1 and 3 from 09:00 in the expert's zone (`nudgeUnplacedPlanWeeks` in `lib/booking/week-nudge.ts`); no plan skips the first day. The reminder and the allocate page keep the one-tap "Auto-schedule this week", and a person may still append sessions with the `topUp` flag on the allocate API. Each allocation records how its batch was placed as one of three tokens in the `reason` of its `BookingStatusHistory` row (`schedule:auto`, `schedule:by-hand`, `schedule:reschedule`, in `lib/booking/allocation/schedule-choice.ts`). `scheduleReasonWords` turns a token into the timeline's words and still reads the retired tokens on stored rows. Tests: `__tests__/maintenance/reconcile-tentative-clear-race.test.ts`, `__tests__/booking/week-nudge-scan.test.ts`, `__tests__/booking-algorithm/schedule-choice.test.ts`.
   - **Why.** The pass had never run in production. It caused two serious defects: a second, auto-placed session beside the make-up a host owed for a cancelled session, and a class its host was scheduling in part by hand filled by the job. The weekly reminder and the one-tap button cover the need.
   - **Worked example.** Dr Rao sold Priya a 26-week plan, three sessions a week, that started on Monday 2 November 2026. Week 4 opens on Monday 23 November. At 09:00 IST that Monday Dr Rao gets one bell and one email that list the plan. He taps "Auto-schedule this week" and the week's three sessions are placed in his open hours. If he does nothing, he is reminded again on Tuesday 24 November and on Thursday 26 November, and nothing is placed for him.
   - Options not chosen: keeping the pass for Auto subscriptions only; keeping both arms with a rule against replacing a host-cancelled session.

2. **Regular time and the four-week roll-forward are deferred.** Decisions 1 to 5 of the [4 November record](2026-11-04-booking-v2-train-b.md) (Regular time, the rolling horizon, the conflict list, catch-up and pause) are not being built now. Pull request #2595 is closed. Issue [#2893](https://github.com/Practitionist/familiarise_web/issues/2893) holds the design and the unused schema (`RegularTime`, `Subscription.lastRolledAt`, `rollPausedAt`). **Deferred.**

3. **Long classes are scheduled in rolling batches.** A host publishes a class with a first batch of sessions, adds more from the grid as the class runs, and is reminded before the last placed session. The class completes only when every sold session is placed or the class period ends.
   - **Built: the completion rule.** A class completes when every sold session is placed, counted by ordinal so a session and its make-up count once and a host-cancelled session counts as answered for, or when its scheduling period has ended. `classIsFinished` (`lib/booking/class-completion.ts`) checks it inside the completing transaction, after the status compare-and-set holds the class row. A class between batches stays `SCHEDULED` and nothing is refunded. Test: `__tests__/booking/class-end-completion.test.ts`.
   - **Planned (the next pull request):** the editor for a batch, the grid's top-up for a sold class, the reminder to the host, and checkout for a partly scheduled class.
   - **Worked example.** Hannah's 12-session class runs to 28 February 2027 and has sessions 1 to 4 placed. Priya paid ₹1,200 for her seat. Session 4 ends on Thursday 3 December 2026 at 19:00 IST. The class stays open, and Priya is not refunded for sessions 5 to 12. Hannah places the next batch. If the remaining sessions are never placed, the class completes on the first run after 28 February, and Priya is refunded ₹800 for the 8 sessions never placed.
   - Options not chosen: every session placed before publishing; keeping the job that filled the rest.

4. **A session added to a class that is already sold needs 24 hours' notice.** While no seat is sold the notice is 15 minutes. **Planned.**
   - Options not chosen: 15 minutes for a sold class; 1 hour.

5. **There is no "unschedule" action.** A learner has "Move" (with times, or "Any time works") and "Return to plan". Each verb means one thing. **Built**: no code change was needed beyond the wording of decision 9.

   | What the person does             | What it means                                                                                     |
   | -------------------------------- | ------------------------------------------------------------------------------------------------- |
   | Move, with "Any time works"      | Reversible. The original time stays busy until the expert places a new one, or the request ends.  |
   | Return to plan                   | Final. Allowed twice per plan, and each return moves the plan end out by 7 days.                  |
   | Cancel                           | Ends the booking.                                                                                 |
   | A host cancels one class session | A miss. The host owes a make-up within 14 days, or the session is refunded.                       |
   | A void                           | A verdict of the system or of ops about a session that did not happen as sold. Nobody chooses it. |
   - Options not chosen: removing "Any time works" for plans; one Unschedule button.

6. **A plan cancel prices a released session at its original start, capped by the notice the learner gave when releasing it.** A released session is on the calendar for the quote; it is never treated as "never scheduled". An expert's unanswered proposal does not change the price: the session is priced at its original start.
   - **Built.** The quote carries one start per confirmed session and per released session (`scheduledStarts` in `resolveBookingRefundContext`, `lib/booking/cancellation-scope.ts`). A session the learner moved keeps the cap at its new time. An expert's cancel still refunds every undelivered session in full. Test: `__tests__/payments/notice-floor-consultee-only.test.ts`.
   - **Worked example.** Priya's plan session is on Thursday 3 December 2026 at 18:00 IST and is worth ₹1,000. The platform ladder is 100% at 24 hours or more, 50% from 2 hours, and 0% inside 2 hours. At 17:00 Priya proposes a new time, which releases the session with one hour of notice. At 17:01 she cancels the plan. That session refunds ₹0, not ₹1,000.
   - Options not chosen: refusing a plan cancel while a move is open; keeping 100%.

7. **An unanswered request stops holding the expert's time when its hold window passes by the clock**, everywhere, as it already did for the request caps. A booking that is being moved keeps its hold.
   - **Built.** Both occupancy twins drop an unanswered request (`PENDING`, `REQUEST_SUBMITTED`) once its hold window has passed: `buildDeadHoldFilter` in `utils/scheduling-engine/occupancyPolicy.ts` and `isOccupiedByLiveAppointment` in `utils/scheduling-engine/ScheduleValidationService.ts`. The window is 48 hours for a 1:1 and 30 days for a plan, the one the caps count by (`requestHoldDeadline`). A booking with an open reschedule request or a released session keeps its time. The `expire-stale-requests` job then tidies the row and tells the learner. Test: `__tests__/booking-algorithm/hold-expiry-predicate.test.ts`.
   - **Worked example.** On Monday 23 November 2026 at 10:00 IST Priya asks Hannah for a 1:1 on Friday 27 November at 18:00 IST. Hannah does not answer. From Wednesday 25 November at 10:00 IST the Friday time reads free on Hannah's grid and another learner can book it, whether or not the job has run. The job's next run expires Priya's request and tells her.
   - Options not chosen: freeing the time only when the sweep runs; leaving it as it was.

8. **A 1:1 session, request or trial starts at most 90 days ahead.** One constant holds the limit (`MAX_BOOKING_HORIZON_DAYS` in `lib/booking/lead-time.ts`). It does not apply to a subscription's plan weeks, a webinar or a class.
   - **Built: the grid.** The grid route flags such cells `beyondHorizon` and they read "Too far ahead". Tests: `__tests__/scheduling/booking-horizon.test.ts`, `__tests__/scheduling/grid-route-flags.test.ts`.
   - **Built: the server refusal.** `slotStartRefusal` (`lib/payments/utils/slot-validation.ts`) answers `SLOT_TOO_FAR` ("Bookings open up to 90 days ahead. Pick an earlier time.") at consultation checkout, request-for-approval and trials. The reschedule route refuses a proposed time past it for a 1:1 or a trial (400 `SLOT_TOO_FAR`), and the allocator refuses a consultation time past it. Test: `__tests__/booking/booking-horizon.test.ts`.
   - **Worked example.** At 10:00 IST on Thursday 19 November 2026 the latest 1:1 start a learner can book is 10:00 IST on Wednesday 17 February 2027, 90 days ahead. A cell at 10:30 IST that day reads "Too far ahead", and a request for it is refused with `SLOT_TOO_FAR`.
   - Options not chosen: 180 days; no limit.

9. **A one-off booking whose only session was voided or awaits review reads "Confirmed"**, with a line that names the remedy and its date, and it offers no rating until it is settled. Approved example: "This session was cut short. Hannah owes you a new time by 2 Dec, or you are refunded." **Follow-up PR.**
   - Options not chosen: keeping "Completed"; a new status word.

10. **One "Your sessions are scheduled" email, with calendar links, on a booking's first placement only.** **Built in the follow-up change.**
    - Built: the learner's booked email is staged inside the allocation transaction on a 1:1 booking's first placement, listing every placed session with its calendar links; later batches ring the bell only. Not built: it is sent by the email retry job, not attempted right after the commit.
    - Options not chosen: an email for every batch; the bell only.

11. **Move and cancel notices carry calendar links**, with one identity per session and a rising sequence, so importing the file again replaces the entry. The subscribable feed is deferred indefinitely ([#2894](https://github.com/Practitionist/familiarise_web/issues/2894)). **Built in the follow-up change.**
    - Built: every calendar file names a session by its booking and ordinal with a sequence from its last change; the moved and cancelled emails carry the attendee's `.ics` link; a seat that ended with a cancel downloads a cancellation only. Not built: cancel emails still follow the refund, and the "move proposed" notice still stages after its commit.

12. **Host-organisation operators are notified only where they can act**: a new request, and a plan week still unplaced after the expert's third reminder. **Built in the follow-up change.**
    - Built: one bell to each member holding `catalog.manage`, in the organisation's scope, linking to its requests page, keyed per request and per subscription and week. Not built: no email and no digest, by decision.
    - Options not chosen: no notices; a daily digest to sponsors.

13. **The learner-side double-booking refusal stays as it is** ("You already have a session booked during this time"). Nothing new is tracked on the learner's side. **No change.**
    - Option not chosen: a warning only.

14. **Accepted defaults.**
    - The trial daily limit is hard and counted in Postgres: three trial requests in any 24 hours per learner, inside the booking transaction and under the learner's lock (`MAX_TRIALS_PER_DAY` in `lib/trials/book-trial.ts`). **Built.**
    - "k/n sessions" counts the sessions sold. **Follow-up PR.**
    - The Requests badge also counts consultations parked with a refund deadline. **Follow-up PR.**
    - Organisation dashboards keep IST and say "IST". **Follow-up PR.**
    - A free time outside a co-host's published hours says so on the grid (`outsideCoHostHours`, naming the co-host when one is known) instead of reading "Unavailable". It still cannot be picked: the allocator refuses a webinar or class time a co-host has not published (`[COLLABORATOR_SCHEDULE]`), so the hours bind. The default first proposed, a label on a cell that stays pickable, rested on a wrong reading that no writer enforces a co-host's hours; it was built and corrected in this pull request. **Built.**
    - A learner may move a session onto its own slot on the phone, as on desktop. **Built.**
    - A move opened by an organisation can be withdrawn by anyone on that side (`rescheduleWithdrawAuthority` in `lib/booking/reschedule-withdraw.ts`). **Built.**
    - A sponsoring organisation's cancel is a required notice that names the organisation. **Built in the follow-up change**: required for the member (as `CANCELLED_BY_STAFF`), with the organisation named in the bell and the email. Not built: the refund notice that cancel causes keeps its own rule.
    - A class takes sessions beyond its plan total only through a top-up, and refunds still divide by the plan total (`assertPickedSessionCount` in `lib/booking/allocation/counts.ts`). **Built.**

## The other corrections in this pull request

- **The stale-hold sweep** (`cleanup-tentative-occurrences`) skips a session whose booking has an open reschedule request, and the session of a live trial.
- **A plan or event cancel** leaves a session that awaits ops review (`UNVERIFIED`) in the review queue.
- **`POST /api/admin/subscriptions` with `CANCEL`** answers 409 `USE_CANCEL_DOOR` for a subscription that has a booking.
- **"Any time works"**, with or without a stated preference, closes `ACCEPTED` when the expert places the new time. A request that named times and got different ones closes `DECLINED`.
- **A webinar re-time and a class series move** write one `BookingStatusHistory` row per moved session (`SCHEDULED` to `SCHEDULED`, reason "Moved to a new time", with the actor).
- **A staff release** tells the operator that the expert places the new time and that the original time is not put back on its own.
- **The heat map** sends `Vary: Cookie`, moves its change marker on a seat change alone (marker version `av5`), re-reads this booking's own sessions when a poll returns a changed body, and titles a trial's block "Trial session". On the phone the day list uses the grid's model. In a reschedule, a session of the same booking that is not being moved cannot be picked over.
- **The allocator** returns `takenSlotStarts` and `retryAfterSeconds` in a refusal, with a `Retry-After` header; allocate and validate bodies share one schema; the subscription validator counts placed sessions through the entitlement; and the conflict check reads an expert buyer's own co-host commitments.
- **The cancel and reschedule routes** renew their locks before each transaction attempt (`beforeAttempt` in `lib/db/booking-transaction.ts`).

## Not built (and why)

- **A staff release that opens a reschedule request.** It needs a new `OPERATOR` initiator value, which is a schema change ([#2900](https://github.com/Practitionist/familiarise_web/issues/2900)).
- **The "Proposed" outline on the expert's own grids** ([#2901](https://github.com/Practitionist/familiarise_web/issues/2901)).
- **A restore that refuses a session whose start has passed.** It was built and withdrawn, because it contradicts decision 6 of the [14 November record](2026-11-14-allocation-reschedule-and-short-notice-moves.md): a lapsed move's original time stands.
- **No change for now** on a remedy for a trial that was "not a fit", on a host organisation seeing trials on its plans, and on the expert reschedule cap on long plans ([#2899](https://github.com/Practitionist/familiarise_web/issues/2899)).
- **Suspected findings still to trace** ([#2897](https://github.com/Practitionist/familiarise_web/issues/2897)).
- **The row order of auto-schedule** ([#2895](https://github.com/Practitionist/familiarise_web/issues/2895)).
- **The rule set of the validate endpoints** ([#2896](https://github.com/Practitionist/familiarise_web/issues/2896)).
- **The volume of booked bells to co-hosts** ([#2898](https://github.com/Practitionist/familiarise_web/issues/2898)).
- **The grid can show a lapsed request's time as busy for up to 30 minutes** ([#2919](https://github.com/Practitionist/familiarise_web/issues/2919)).
- **A retry of a subscription's or class's later batch still does not replay.** The grid hook keeps its key after a success, so a server-side replay would answer "saved" for the next week's click and place nothing. The hook has to be fixed first ([#2902](https://github.com/Practitionist/familiarise_web/issues/2902)).

## Consequences

- An expert who used Auto once is no longer scheduled by a job. They get the same three reminders as everyone else and place each week with one tap.
- A class is not closed between batches. Selling a class before every session has a time, and the editor and the reminder for the later batches, are planned for the next pull request.
- A learner cannot turn a late release into a full refund by cancelling the plan.
- A request nobody answers frees the expert's calendar on time even when the job is late, and the booking surfaces keep reading "Requested" until the job ends the request, as decision 6 of the 14 November record says.
- A 1:1 cannot be booked or moved more than 90 days ahead.
- The trial limit no longer lets a request through when the rate limiter cannot be read.

## Deprecated & Superseded Approaches

- **The top-up pass and the plan-level Auto choice.** The hourly job placed open weeks for plans first scheduled with Auto and filled short classes, and those plans skipped the first reminder day. Delete any reference to `topUpIncompleteEvents`, the `TOP_UP_*` constants, `planIdsOnAuto`, `plansScheduledOnAuto`, `PLAN_CHOICES`, `lastChoiceWasAuto`, or the `bySweep` and `byConsultant` request fields. The tokens `schedule:week-auto`, `schedule:week-by-hand` and `schedule:top-up` are read for stored history rows only; nothing writes them.
- **A class completing after its last placed session.** It closed a class between batches and refunded the sessions not yet placed. `classIsFinished` decides now.
- **A released plan session refunded as never scheduled.** It came back at 100% whatever notice the learner gave. It is priced at its original start, capped by the learner's release notice.
