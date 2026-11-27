# ADR: What happens to a plan or a class when life changes part-way through

- **Status**: Accepted (owner decisions, 2026-11-25). The owner approved every rule in the section "Decided rules" as recommended. Rules 3, 4, 5 and 11 and the erasure check in rule 12 are **(built)**; every other rule is **(planned)** and names the work that builds it. The column "Today" describes `dev` as it was read on 2026-11-25; a built rule's column reads "Before".
- **Date**: 2026-11-25
- **Author**: Platform engineering
- **Related**: [Class series money rules](2026-09-25-class-series-money-rules.md), [Session outcome report window](2026-11-23-session-outcome-report-window.md), [Product lifecycles](2026-11-13-product-lifecycles.md), [Subscription demand bounds](2026-11-13-subscription-demand-bounds.md), [Cancellation flow](../booking/08-cancellation-flow.md), [Recurring events journey](../booking/16-recurring-events-journey.md), [Earnings lifecycle](../finance/40-payouts/02-earnings-lifecycle.md); issue #3053 (paying an expert per delivered class session)
- **Supersedes**: nothing. It fills gaps the records above left open.

## Context

A plan (a subscription of 1:1 sessions) and a class (a series of group sessions) run for weeks. The buyer pays once, at the start. Over those weeks people fall ill, travel, lose interest, quit, get banned, or ask their bank for the money back. A booking that lasts one hour rarely meets these events. A booking that lasts twelve weeks meets several.

A read-only walk through about forty such situations compared what the code does with what a reasonable buyer or expert would expect. Most situations were already handled. This record decides the ones that were not, and states a few existing rules plainly so they can be published.

Two worked bookings are used throughout:

- **The plan**: 24 sessions over 12 weeks for ₹36,000 (3,600,000 paise), so ₹1,500 a session. The expert's share is 80 %, ₹1,200 a session.
- **The class**: 8 weekly sessions, 20 seats at ₹8,000 (800,000 paise) a seat, so ₹1,000 a session per seat. The expert's share is ₹800 per seat per session.

Vocabulary: a _strike_ is an entry on the expert's reliability record (`lib/booking/expert-reliability.ts`); three in ninety days puts the expert in an operations review. A _tranche_ is the part of a plan's earning that belongs to one cycle of sessions. A _void_ is a session that took place badly or not at all through no fault of the learner, and is owed again or refunded.

## Decided rules

Each rule lists what happens today, the rule, a worked example, and the abuse the rule is shaped to resist.

### 1. A chargeback freezes the booking for the learner who raised it **(planned)**

- **Today**: when a learner's bank opens a dispute, the expert's earnings on that payment are held. On a 1:1 booking, cancel and reschedule are refused for both sides (`hasActiveDisputeForAppointment` in `lib/payments/dispute-guard.ts`), and a session return is refused by its own check (`lib/booking/session-return.ts`); a class or webinar can be cancelled or re-timed (rule 5), and a learner's own seat leave is not refused. Sessions already placed still run, and nothing stops new ones being placed. If the dispute is lost, the plan stays live.
- **Rule**: while the dispute is open, no new session can be placed, and sessions already placed in the future are released back to the plan with no strike. Both sides are told. If the platform wins, the plan resumes and its end date moves out by the days it was frozen. If the platform loses, the plan ends with no further refund and no strike. For a class, only the disputing seat is suspended; the class runs on for everyone else.
- **Example**: on the plan, 5 sessions are delivered and the learner disputes the payment in week 6. Under the old behaviour, a lost dispute left the learner with 19 sessions to use for nothing while the expert had to teach them unpaid or cancel and take a strike. Under the rule, sessions stop on the day the dispute opens.
- **Abuse resisted**: taking the service and the money back at once. A dispute cannot be used as a free pause either, because only a dispute the learner _loses_ resumes the plan, and every dispute is visible to operations.

### 2. The expert bears a lost chargeback, delivered sessions included (existing behaviour, now stated)

- **Today and rule**: a lost dispute reverses the expert's share in proportion to the amount lost, all of it when the whole payment is lost (`settleLostDispute` in `app/api/webhooks/utils.ts`). A share not yet paid out is simply reversed. A share already paid in a completed payout becomes an amount the expert owes, net of the tax withheld on it (that tax is reversed separately); it is recovered from later payouts, or collected by operations when nothing was booked automatically. Operations contest a dispute by hand through the admin dispute route (`app/api/payments/disputes`), with a written summary and uploaded documents; nothing attaches attendance records automatically, and a dispute raised before the first session has none. The owner's intent is that a dispute over delivered sessions is always contested with their attendance record; attaching it automatically is **(planned)** with no work scheduled. The terms an expert accepts must state who bears a lost dispute.
- **Example**: on the plan above, lost in full, the expert loses ₹6,000 for five sessions taught.
- **Abuse resisted**: collusion. If the platform absorbed the loss for delivered sessions, a learner and an expert acting together could charge back and keep the payout, and the platform would pay twice.
- **Alternative rejected**: the platform absorbs the loss for sessions with confirmed attendance. Kinder to experts, and one freelancing marketplace does this when its time-tracking rules were followed, but it opens the collusion route and needs a new ledger path.

### 3. A moderation ban refunds what was not delivered, whoever was banned **(built)**

- **Before**: a ban cancels the banned person's live bookings. A plan or a consultation is refunded its full remaining balance (`lib/moderation/cancel-user-engagements.ts`), delivered sessions included, and a plan with no session placed ahead is not collected at all. When the banned person is an expert, their class is cancelled and each seat is already refunded from its series ledger, keeping delivered sessions. When the banned person is a learner, their own class or webinar seat is refunded in full.
- **Rule**: a plan refunds its undelivered sessions in full and nothing for delivered ones, whoever was banned. A banned learner's class seat follows the same rule, and a webinar seat is refunded only if the webinar has not ended. Every live plan is collected, placed ahead or not. A consultation is a single session and keeps its full refund while that session has not been held. An operator can add a goodwill refund by hand in a serious case.
- **Example**: 8 of 24 sessions delivered, then a ban. The refund is ₹24,000, not ₹36,000, and the expert keeps ₹9,600 for the eight sessions taught. This holds whether the expert or the learner was banned. A learner banned after 3 of 8 class sessions is refunded ₹5,000, not ₹8,000.
- **Abuse resisted**: a learner who behaves badly enough to be banned no longer gets eight delivered sessions for free.

### 4. A conduct-removal case that support does not decide in time refunds what was not delivered **(built)**

- **Before**: a host removes a learner from a class for conduct. The seat is released with no refund and support has 72 hours to decide. If the deadline passes, the learner is refunded the full remaining balance of the seat (`lib/support/conduct-removal-case.ts`).
- **Rule**: on lapse, refund the undelivered sessions only, measured at the moment of removal. A session that was under way when the learner was removed counts as not delivered: the learner was put out of the room and support did not rule against them in time, so the doubt goes to the learner.
- **Example**: removed after session 3 of 8, or ten minutes into session 4. The refund is ₹5,000, not ₹8,000, and the host keeps ₹2,400 for three sessions taught. The host no longer pays for the platform's missed deadline. A webinar seat removed while the webinar is running is refunded in full; one removed after it ended is refunded nothing.
- **Abuse resisted**: a host cannot remove a learner five minutes into a session and keep that session's pay by default.

### 5. One seat's dispute does not stop a class being cancelled **(built)**

- **Before**: the cancel route (`app/api/appointments/[appointmentId]/cancel/route.ts`) refuses while any payment on the booking is disputed. A class is one booking carrying every seat's payment, so one seat's dispute blocks the host and staff from cancelling the class for all twenty.
- **Rule**: the booking-wide refusal applies to 1:1 bookings only. A class or a webinar can be cancelled or re-timed; every other seat is refunded as usual, and the disputed seat's refund waits for its dispute.

### 6. An expert who does not turn up to a plan session is held to account **(planned)**

- **Today**: the session quietly returns to the learner's allowance. Nobody is told, no strike is recorded (the detector in `scripts/appointments/detect-consultant-no-shows.ts` covers consultations only), and the plan's end does not move.
- **Rule**: once the no-show is confirmed (the 48-hour report window closes, or a report confirms it), both sides are told, the plan's end moves out 7 days so the session can be retaken, and a strike is recorded.

### 7. An expert can drop one plan session honestly **(planned)**

- **Today**: an expert who cannot make one session can propose a new time (the learner must accept), cancel the whole plan, or not show up. The learner can return a session to the plan twice with 24 hours' notice (`lib/booking/session-return-rules.ts`); the expert has no equivalent.
- **Rule**: an "I can't make this session" action. The session returns to the plan, the plan's end moves out 7 days, and both sides are told. There is no strike with 24 hours' notice or more, and a strike inside 24 hours. At most two strike-free uses per plan.
- **Abuse resisted**: the cap of two stops an expert stretching a paid plan for months, and the strike inside 24 hours keeps short-notice cancelling costly.

### 8. The expert's reschedule cap counts per session **(planned)**

- **Today**: an expert may reschedule twice per booking in total, however many sessions it has; a learner may move each session twice (`lib/booking/reschedule-caps.ts`).
- **Rule**: an expert may move each session at most twice, the learner's rule. A single-session consultation is unchanged.
- **Example**: on the plan, an expert who moved two sessions in the first three weeks is no longer left with nothing but cancelling or not showing for the other nine weeks.

### 9. Leaving a class follows one ladder before and after the first session **(planned)**

- **Today**: before any session has been held, a learner inside the host's refund window (24 hours by default) is refused and gets nothing. After the first session, the same learner can leave and is refunded each remaining session on the notice ladder (`lib/booking/seat-leave.ts`).
- **Rule**: one ladder throughout. Each remaining session refunds at its own notice tier: in full at 24 hours or more, half between 2 and 24 hours, nothing under 2 hours.
- **Example**: five hours before session 1 the refund is ₹7,500 (half of session 1, all of sessions 2 to 8). Under the old behaviour it was ₹0 five hours before and ₹7,000 one hour after.

### 10. A class pays the expert once, after its last session (existing behaviour, now stated)

- **Today and rule for launch**: a class seat's earning is released 24 hours after the last session ends, plus 3 days for a new expert (`lib/payments/payouts/earnings-hold.ts`, gate in `scripts/earnings/release-earnings.ts`). The class creation form and the earnings page must say so **(planned)**. A plan pays per delivered cycle.
- **Example**: a class running 5 January to 23 March pays its ₹1,28,000 (20 seats) on 24 March.
- **Later**: paying for each delivered class session after its own hold. The design, the peer practice and the fraud cases are in issue #3053.

### 11. Operator rulings on session outcomes **(built)**

These four extend the [session outcome report window](2026-11-23-session-outcome-report-window.md) record, whose "As built" section names the code. Each bullet states the rule, then where the build differs.

- When an operator marks "expert absent" on a consultation, the expert always gets a strike and the learner always gets the money back where money was paid. A consultation is one call, and it has no make-up feature, so nothing waits 14 days. A booking still live is cancelled and refunded in full. A booking that had already completed, or a session already voided as cut short, is refunded in full at once. An unpaid booking records the strike only. During a declared outage the operator is refused, because an outage is not the expert's fault. _As built:_ the unpaid booking's session is also voided. Two cases get no refund from this door: a booking already cancelled keeps what its cancellation paid and records the strike only, and a paid booking whose other sessions stand is refused (`NO_SHOW_OTHER_SESSIONS_STAND`), which a consultation sold as one call should never be. While another session of the booking is still undecided the door refuses and asks for that session first (`NO_SHOW_SIBLING_SESSION`).
- A session that was voided and not yet settled is refunded in full whoever cancels the booking, because it was not delivered and that was not the learner's doing: a ₹1,000 consultation whose session was cut short and voided pays ₹1,000 back when the learner cancels it. The cancellation settles that session, so an operator's later "expert absent" on the cancelled booking adds only the strike. While the void's negative verdict is unconfirmed the booking cannot be cancelled by anyone, as a class cannot: every money effect of an unconfirmed void waits for its confirmation, and a cancel does not settle a session that awaits its verdict. The refusal says what is waiting, that it is confirmed within 48 hours or by support, and that the session is refunded in full once confirmed. If the verdict is overturned to held, the session was delivered and the booking can no longer be cancelled. _As built:_ the 100 % applies to a consultation's void once any negative verdict on it is confirmed (`unsettledVoidIds` in `lib/booking/cancellation-scope.ts`); the refusal is 409 `CANCEL_WAITS_FOR_VERDICT` at the cancel and its preview, and a consultation that cost nothing is not refused. A plan's voided session is priced as an unused session of the plan, at the ladder's top rung.
- While any session of a plan carries a "learner absent" verdict that nobody has confirmed, no tranche of that plan is released. A verdict on strong evidence that nobody disputes is confirmed when its 48-hour window closes, so it holds the plan about 48 hours. Windows can overlap: a second absence 24 hours after the first keeps the plan held until the second window closes, 72 hours after the first opened. A weak or disputed verdict holds the plan until an operator decides, with no cap; the ageing alert on the operator queue chases it (`alertStaleNeedsHuman`, after `NEEDS_HUMAN_ESCALATE_DAYS`). _As built:_ as stated. A dated tranche still does not wait for the plan's later sessions (`RELEASE_GATES_BESIDE_DELIVERY` in `scripts/earnings/release-earnings.ts`).
- When an operator relabels a void that was waiting for confirmation, the 14-day make-up window counts from the relabel, the date the learners were told. _As built:_ a void that was already confirmed, or never needed a confirmation, keeps the start it had.

### 12. Smaller rules decided without alternatives **(planned)**

- **(built)** An erasure request processed by an admin runs the same live-booking check as a self-serve account deletion (`liveBookingsForUser` in `lib/compliance/erasure/scrub-user.ts`), so a learner with a live plan is not scrubbed while the plan runs on. The check also counts a paid seat on a class or webinar until its last session ends, on both doors.
- A learner is told when a week of their plan closes with sessions unplaced, with the way to cancel for a refund; operations are told after two such weeks in a row.
- A learner is told after two absences in a row what is left on the plan and how to cancel it.
- A learner whose plan-end refund is waiting on a session under review is told the plan is in review.

## What peers do

Cited briefly to justify the rules above. These are from public search summaries read on 2026-11-25; the source pages were not opened, so each is indicative, not authoritative.

| Question                                           | Public practice found                                                                                                                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An expert misses one lesson of a package           | Preply, italki, Wyzant and Outschool credit, refund or reschedule that one lesson; the rest of the package stands                                                                                                                        |
| Who bears a lost chargeback                        | Preply, italki, Airbnb and Outschool recover it from the tutor or host; Upwork absorbs it only when its tracking rules were followed                                                                                                     |
| When a teacher is paid for a multi-session product | Topmate and Exly (India): within about a week of each session. UrbanPro (India): after all classes or by milestone. Preply: after each confirmed lesson. Outschool: 7 to 10 days after a fixed-length course starts. Maven: at enrolment |
| A session lost to a platform outage                | The teacher is paid when it is made up, and not paid if it is refunded                                                                                                                                                                   |
| Pausing a subscription                             | Preply lets a learner pause once per 28-day cycle; this product has no pause and offers two session returns instead                                                                                                                      |

## Rules that stay as they are, stated so they can be published

The walk found these existing rules to be sound but nowhere stated to the people they bind.

1. A plan week that passes with sessions unplaced cannot be caught up later. The sessions come back as money when the plan ends.
2. There is no pause. A learner can return a session twice, each with 24 hours' notice and each extending the plan 7 days, or cancel the plan.
3. A learner's cancel of a whole plan refunds never-placed sessions in full and placed ones on the 24-hour and 2-hour ladder. One placed session inside 24 hours cannot be cancelled on its own for a part refund; an absence counts as delivered.
4. An expert's cancel refunds every undelivered session in full whatever the notice, and records a strike. This includes a class called off for low enrolment.
5. A missed class session is not refunded. The recording is the remedy.
6. A cancelled or voided class session has 14 days to be made up before it refunds.
7. A sold plan keeps the price, cadence, session length and split it was sold with. An expert's later edits apply to new buyers only.
8. A new payout account waits 48 hours before it is used.
9. A refund for a session lost to a platform outage reduces the expert's earning for that session unless the session is made up.

## Not verified here

- Every "Today" statement is from reading code, not from running it. Amounts follow from the stated unit prices.
- The peer practice comes from search summaries, not from the platforms' own pages.
- These situations were not traced and are not decided here: an organisation-sponsored learner who leaves the organisation or whose organisation is suspended mid-plan; a missing or changed payout account and a reversed payout mid-plan; mid-series edits to a class (capacity, price, added sessions); a co-presenter removed mid-series.
- Whether holding a class expert's share until the series ends fits the platform's arrangement with its payment aggregator is a question for the accountant and counsel.

## Build plan

| Rules                               | Work                                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 3, 4, 5 and the erasure check in 12 | One pull request: bans, lapsed removal cases, class cancel under a seat dispute, admin erasure                       |
| 1                                   | Its own pull request, after the refunds and disputes work in flight merges, because both change the dispute handlers |
| 6, 7, 8, 9 and the notices in 12    | One pull request, after the session outcome reports work merges, because rule 6 builds on confirmed voids            |
| 10 (wording)                        | With the checkout and notices work                                                                                   |
| 11                                  | In the session outcome reports pull request                                                                          |
