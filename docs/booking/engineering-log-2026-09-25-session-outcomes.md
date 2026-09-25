# Engineering log — 2026-09-25 — session outcomes

**Date:** 2026-09-25 · **Issues:** #1569, #1543, #1607, #1493, #1746 (item B) · **Scope:** PR-A, the money half of the session-outcomes design; the copy half is PR-B.

## What changed

The branch adds per-device presence, one outcome decider, voids as misses, and the ops door that overturns a verdict. Each item below was its own commit.

- **A-1, schema.** `OccurrenceCompletionStatus.VOIDED`, the `OccurrenceOutcome` enum, five columns on `AppointmentOccurrence` (`voidedAt`, `outcome`, `outcomeAt`, `deliveredMinutes`, `lostMinutes`) and the `MeetingPresence` table. The live-ordinal partial unique in `prisma/sql/check-constraints.sql` ignores `VOIDED` rows.
- **A-2, presence writer.** The participant webhooks write one `MeetingPresence` interval per `user_session_id`, rebuild a lost join from the leave's `duration_seconds`, and count distinct device sessions in `joinCount`.
- **A-3, classifier.** `classifySessionOutcome` in `lib/booking/session-outcome.ts` is a pure function pinned by a table test.
- **A-4, single decider.** The slot pass in `auto-complete-appointments` writes each verdict through `decideSlotOutcome` (`lib/booking/session-outcome-sweep.ts`); the Stream end webhooks and `reconcile-orphaned-sessions` no longer complete sessions. The pass defers live overruns, leaves consultation host no-shows to the detector, runs the #1543 feed-gap watchdog, and stages the learner no-show bell (`session-no-show`, in the `appointment` family).
- **A-5, detector.** `detect-consultant-no-shows` reads the same classifier, and the handoff clock pauses for maintenance.
- **A-6, make-ups.** `MISS_WHERE` and `UNSETTLED_MISS` (`lib/booking/misses.ts`) make a void a miss. The make-up and skip paths accept voided sources; `settle-cancelled-sessions` settles voided class, webinar and consultation sessions and refunds unused subscription voids at plan end; parents with an unsettled miss or an undecided session do not complete.
- **A-7, ledger.** Voids are dead for delivery and keep their ordinal; `hostMisses` alone feeds the reliability flag and the consultant completion rate; the void writer re-checks the exit right and sends the voided variant of the cancel bell.
- **A-8, earnings.** A void never anchors a hold, and `release-earnings` keeps an earning `PENDING` while its booking has an unsettled miss.
- **A-9, transitions.** The ops overturn edges between `VOIDED` and `COMPLETED`.
- **A-10, ops.** `session.set-outcome` and the needs-human list, shown on the Money hub's class-series tab.
- **A-11, reviews.** The no-attendance review arm admits only `OFFLINE`, `INCONCLUSIVE` or unclassified sessions.
- **B-4 and B-5.** The host's per-seat attendance list on the booking detail page, and "missed sessions" in the class exit bell.

## Findings that contradicted the design

The design listed "no report and no intervals" as `INCONCLUSIVE`, but a call nobody joined has no Stream report either, so that rule would never produce `NOBODY_JOINED`. The classifier returns `NOBODY_JOINED` for a call with no intervals unless Stream's report shows participants, which is the feed-gap case and returns `INCONCLUSIVE`. Both write `UNVERIFIED`, so no money depends on the choice.

The reconciler also completed sessions, which the design did not list. It now only closes the room, because the decision is that one job writes the outcome.

The design said a make-up for a voided webinar or consultation is scheduled by the host, but the only make-up door is class-only. Those voids therefore wait 14 days and are then refunded by the settle sweep; the ADR records this as deferred.

## Verification

The classifier table, the sweep's CAS shape, the presence writer's lost-join case, the maintenance pause of the handoff, the voided-session settle and the plan-end subscription refund, the attribution split, the earnings claim guard, the overturn refusal and the review arm each have one compact pin. The presence writer and the watchdog can only be proven on production after release, because Stream's event hook reaches production only.
