# Complaint catalogue and regulatory expectations

> Read this before running any lane. The entries come from public complaint threads and secondary legal summaries gathered on 2026-10-09; verify any statute figure against the gazette or the BIS text before quoting it as law. Each entry is written as a test heuristic: what a good product does, which a case can observe. Lane cases cite entries as `[CX-A3]`, `[CX-B1]`, `[CX-C4]` and so on.

---

## CX-A — The customer (buyer)

1. **Bot loop with no human exit.** Gartner's 2026 survey found that 87 percent of customers say human access is essential and 27 percent retry a bot after a bad experience. Heuristic: "talk to a person" is reachable in two taps or fewer from any bot state and is offered automatically after two misses.
2. **Repeating yourself after handoff.** Five9 reports that 83 percent of customers dislike it. Heuristic: the agent sees the transcript, the appointment and the payment, and the customer is never asked for them again.
3. **Expert no-show, "chase the expert yourself".** Seen in Topmate complaints. Heuristic: an expert no-show triggers a refund or reschedule offer without the buyer having to prove it.
4. **Refund "in 5 to 7 days" and then silence.** Seen in Urban Company complaints. Heuristic: refund status shows stage, amount and expected date, and a missed date flags the case.
5. **Black box with no ticket number.** Seen in Practo and Urban Company complaints. Heuristic: a reference is returned immediately, in the app and by email.
6. **Closed without resolution.** Heuristic: closure carries a reason, a one-tap reopen exists, and a reply to a closed case either reopens it or routes to a new case with clear words.
7. **Dead support button.** Heuristic: a fallback form or email with a stated response time exists whenever chat is unavailable.
8. **Hidden or short dispute window.** Superpeer's 48-hour window is the cautionary example. Heuristic: the window is shown at booking and again at session end.
9. **Refusal with no reason.** Heuristic: every decision states the reason, the policy and the next step.
10. **Fake-helpline scams.** Heuristic: the interface says "we never ask for a UPI PIN or a screen share" and lists the official contacts.
11. **Review vanished after submit.** Heuristic: the author sees the review's status, published or held, with the reason.
12. **Review prompt while an issue is open.** Heuristic: rating prompts are suppressed while a ticket or dispute is open on that booking.
13. **Platform-caused failure cannot be attributed.** Heuristic: the review form separates expert from platform, and platform problems route to support.
14. **Dark patterns.** Forced rating, nagging and confirm-shaming. Heuristic: prompts are skippable and the copy is neutral.
15. **Unclear response-time promise.** Heuristic: the stated response time is shown at submission and matches what the system enforces.

## CX-B — The provider (expert)

1. **Review extortion.** "Refund me or I keep the one star." Heuristic: a report can be filed as coercion with evidence, and the review is held pending a decision.
2. **Retaliatory review.** Heuristic: the moderator sees the timeline context: dispute, refund, report and ticket on the same booking.
3. **No right of reply.** Heuristic: one public reply per review, and edits keep their history.
4. **Platform-caused lows counted.** Upwork-style complaints. Heuristic: such ratings are excluded from the aggregate and the exclusion is visible to the expert.
5. **Silent edits.** Heuristic: an "Edited" badge and a revision history are visible to the expert.
6. **Opaque takedowns and strikes.** Fiverr-style complaints. Heuristic: a report gets an id, a response-time promise, a reasoned decision and an appeal route.
7. **Payout delays.** Heuristic: status and hold reason are visible, and a breach is flagged to staff.
8. **Chargeback lost by default.** Heuristic: an immediate dispute notice with a deadline countdown, and auto-assembled evidence.
9. **Held funds with no communication.** Heuristic: amount, reason and release condition are shown.
10. **Penalty with no appeal.** Heuristic: every sanction shows a reason and an appeal route.

## CX-C — Staff and agents

1. **Ticket ping-pong.** Heuristic: reassignment requires a note, and an alert fires after three hops.
2. **Context lost on reassignment.** Heuristic: the new owner sees the full timeline and linked entities.
3. **Invisible SLA breaches.** Heuristic: sort by time-to-breach, with distinct acknowledgement-due and dispose-due states.
4. **Duplicate tickets.** Heuristic: a second ticket on the same booking prompts a merge or is deduplicated.
5. **Concurrent edits clobber each other.** Heuristic: a stale write is rejected by a version check, and a "claimed by" marker is visible.
6. **No audit trail.** Heuristic: every status, owner and visibility change logs actor, time and before and after values.
7. **PII in escalations to engineering.** Heuristic: the payload carries identifiers only, and nothing customer-identifying goes to a public tracker.
8. **Bot and human contradict each other.** Heuristic: promises made by the bot are stored on the ticket for the agent.

---

## Psychology heuristics

- **Peak-end rule.** The last screen of a ticket or dispute shows a clear outcome and a next step, never a bare "closed".
- **Service-recovery paradox is weak.** Never rely on recovery; a proactive apology and fix before the customer complains beats a good recovery after.
- **Procedural justice and voice.** Both sides can submit their side, and decisions give reasons.
- **Customer effort.** Count the taps and the re-entries between the problem and its resolution.
- **Expectation setting.** A response-time promise at submission, and a proactive update when it is breached.
- **Review timing.** Ask after completion, never during an open dispute or ticket.

---

## India regulatory expectations

- **Information Technology (Intermediary Guidelines) Rules 2021, rule 3(2).** Acknowledge a grievance within 24 hours and dispose of it within 15 days. The grievance officer's contact is public and an appeal route (the Grievance Appellate Committee) is visible.
- **Consumer Protection (E-Commerce) Rules 2020.** A named grievance officer, acknowledgement within 48 hours and redress within one month. The stricter clock applies per ticket type, so a test that checks the 48-hour acknowledgement must also check the 24-hour one.
- **BIS IS 19000:2022 (voluntary).** Equal moderation regardless of sentiment, prompt publication, right of reply, incentivised reviews labelled and excluded, and a disclosed exclusion policy.
- **CCPA Dark Patterns Guidelines 2023.** No false urgency, confirm-shaming, forced action, nagging, interface interference or trick questions.
