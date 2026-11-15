# ADR: Notices the other party causes always arrive, deadline alerts for experts, and the series and trial notices

- **Status**: Accepted (owner decisions, 2026-11-15). Built on the branch `feat/train3-notices` (train 3 of the booking follow-up train) unless a decision says otherwise.
- **Date**: 2026-11-15
- **Author**: Platform engineering
- **Related**: [Postgres is the only owner of notification preferences](2026-11-06-notification-single-preference-owner.md) (decision 11, required bells), [The booking follow-up train](2026-11-12-booking-follow-up-train.md) (decisions 6 and 12), [Notifications start here](../notifications/README.md), the follow-up tracking issue [#2720](https://github.com/Practitionist/familiarise_web/issues/2720)

## Context

Every bell and every email passes a preference gate before it is sent: `isBellAllowedForRecipient` and its SQL twin `bellAllowedWhere` in `lib/novu/policy.ts` for bells, and `isEmailAllowedForUser` in `lib/email/preferences.ts` for email. Until this change a notice could skip the switches only when its whole template was required (`required: true` with `category: null`): the account, security, verification, moderation and compliance notices. Everything about a booking was optional, so a learner who turned the Bookings switch off never heard that the expert had cancelled their paid session (finding TZ-F2), and a reschedule proposal that lapsed and put the booking back on its original time was optional too (finding AC-F17).

Three smaller gaps sat beside it: experts had no alert when a request was about to lapse unanswered, the notice for a class series move named only the first session that moved, and a completed trial did not point the learner at the expert's plan.

## Decisions

1. **A notice the other party causes reaches the recipient whatever their switches say** (decided; built).
   - Required, whatever the master, In-App, Email or category switch says: an expert's or host's cancel of the recipient's booking or event, and the refund notice that cancel causes; a reschedule proposal, sent to the party who did not propose it; a proposal that lapses so the original time stands (restored); a series move of a class; a host releasing or removing the recipient's seat.
   - Still switchable: reminders, marketing, digests, and every notice about the recipient's own action (a learner's own cancel, the expert's copy of the cancel they made, the proposer's copy of their own proposal).
   - Erasure still stops everything: an erased user receives nothing, required or not.
   - **Reason.** These are service messages about a contract the user paid for. India's Telecom Commercial Communications Customer Preference Regulations, 2018 (TCCCPR) separate transactional and service messages from promotional ones, and only promotional messages need the recipient's opt-in.
   - **Options considered.** B, "cancellations only", was rejected because a proposal or a series move changes the paid booking just as much. C, "keep everything optional and fix only the Settings text", was rejected because a learner who muted bookings would still miss a cancelled paid session.

2. **How: a per-send required override passed at the stage call** (decided; built).
   - The template keeps its category, so the same event sent about the recipient's own action stays switchable. The caller passes `required: { kind, recipients }`: the kind is one of `REQUIRED_NOTICE_KINDS` (`lib/notifications/required-notices.ts`), and only the listed recipients skip the switches.
   - Bells: the override is written into the outbox row's payload as `requiredNotice` (the kind), so the first-attempt recheck (`currentBellRecipients`) honours it as well as the staging gate. `isBellAllowedForRecipient` and `bellAllowedWhere` read it through the same gate (`gateOf`), so the JavaScript rule and the SQL twin agree; the real-Postgres parity test covers it.
   - Email: a required recipient is loaded with no category (`loadEmailRecipients`, option `requiredFor`), which is the existing marker of a required email: `isEmailAllowedForUser` lets it through, the staged `FailedEmail` row carries a null `deliveryCategory` so the relay's recheck lets it through again, and it carries no unsubscribe link.
   - Settings > Notifications shows one line built from the same constant ("Always sent: changes the other person makes to your booking (…)"), and the panel no longer says that booking changes are optional.
   - **Options considered.** Twin templates (one required, one optional per event) were rejected because every change of copy would have to be made twice. Novu's workflow-level "critical" flag was rejected because it applies to the whole family, so it would remove the opt-out for every event in the family, and Postgres owns preferences, not Novu.

3. **Deadline alerts for the expert: both** (decided; built).
   - (a) A submitted request about to lapse unanswered: the expert who must answer gets one bell and one email 6 hours before the request's 48-hour hold ends (`REQUEST_EXPIRY_ALERT_HOURS`). It is a new arm of the existing `expire-stale-requests` job, runs after the arm that expires lapsed requests, and is the `new-booking-request` event with an `expiresAt` field (the `appointment` family; no new Novu workflow).
   - (b) A paid plan still unplaced 36 hours after payment, 12 hours before the automatic 48-hour refund: this alert already existed as the hour-36 stage of the unscheduled-plan nudge (`nudgeUnscheduledSubscriptions`, stages 12, 24 and 36 hours, in the same job), one bell and one email that name the learner. It now also names the refund time in the expert's zone, rather than adding a second notice at the same hour.
   - Both are about the expert's own pending action, so both respect the expert's switches (the `appointments` category).
   - **Once per item.** The bell's outbox row is the claim: its `transactionId` is derived from a dedupe key per request (`request-expiring:<consultationId>`) or per plan stage, and the arm skips an item whose row already exists. The email's claim is its `FailedEmail` row, found by its email type and `entityRef`. A second run sends nothing. No column was added.
   - **Quota.** At 100 active experts, if each receives 10 requests a month and one in five is still unanswered at hour 42, alert (a) adds about 200 bell runs (2 % of Novu Free's 10,000 a month) and 200 emails (under 7 % of Resend Free's 3,000 a month, a few a day) a month. Alert (b) adds nothing: the hour-36 stage was already sent.
   - **Options considered.** The unplaced-plan alert only, and neither alert, were rejected. A new job or route for the alerts was not considered: the job rules (`lib/cron/AGENTS.md`) put a new pass on the sweep that already reads the rows.

4. **A completed trial points the learner at the expert's plan** (decided; built). Decision 6 of the booking follow-up train. The learner gets one bell and one email headed "Continue with {expert}" that open the plan's checkout page; the expert gets a bell only, with no email. Both completion paths (the trial route and the auto-complete sweep) send it through `notifyTrialCompletedParties` (`lib/booking/trial-completed-notice.ts`).

5. **The series-move notice lists every moved session** (decided; built). Decision 12 of the booking follow-up train. One notice per recipient lists every moved session as old time → new time, at most 10 rows and then "and N more", with a link to the booking. The shared `appointment-rescheduled` payload (`moves`, formatted per recipient zone) and its email were extended; it is not one notice per session.

6. **A reschedule proposal names its answer-by time** (decided; built). The proposal's bell and email name the time the proposal lapses (`RescheduleRequest.proposalExpiresAt`), formatted in the recipient's zone.

7. **Stale Novu definitions** (decided; built). Items 2 and 3 of #2781: the `trial-refunded` description now says a paid trial is refunded when the expert cancels it, and the `trial-session-requested` event, which had no sender, is deleted with its template and family mapping. Items 1 and 4 of that issue are out of scope. The Novu environments are not synced from the branch: after merge the owner runs the Novu sync, which rewrites the `trial` family (one branch fewer, the new description, the completed-trial copy) and the `appointment` family's copy (decisions 3, 5 and 6).

8. **Experts' bells on the reschedule QA** (decided: no code without a cause). #2783 reported that experts saw no bell during the reschedule QA although the code stages one. No cause was found in the code while building this change, so it is listed for the preview round with a seed expert whose switches are on.

## Deprecated & Superseded Approaches

- **Required as a property of the whole template only.** A template marked `required` still skips the switches for every send; it is no longer the only way, because a booking event is required for one recipient and optional for another.
- **Settings copy that listed only account, security and moderation notices as always sent.** Replaced by the line built from `REQUIRED_NOTICE_KINDS`.
