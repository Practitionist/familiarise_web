# 13-d · Missed opportunities: a checklist per surface

**Needs:** one booking in each state on each surface (reuse 11-a's ledger, DB-01).
**Personas:** the owner of each surface, plus the other party for the "their time" check.
**Docs under test:** `_shared/reporting.md` (MISSED-OPPORTUNITY), the ADR's "say why, say what next" rule, `lib/dashboard/action-items.ts`, `lib/dashboard/money-state.ts`.

**How to run a checklist case:** on the surface, answer each question yes/no with the exact text that answers it (quote it) or "nothing". Every "nothing" is a **MISSED-OPPORTUNITY**; P2 when the user could lose money or a booking because of it, P3 otherwise. Don't report the same gap twice across cases: name the first case that found it.

The questions every checklist starts with:

- **Disabled control:** is every disabled or missing action explained next to it (why, and when it becomes possible)?
- **Deadline:** is the next deadline named (reply by, pay by, free cancel until, make-up by, plan end), with a zone?
- **Money:** does the user see what they'll pay or get back before they commit?
- **Other party:** does the user see the other party's local time when the zones differ?
- **What next:** after the action, does the page say what happens next and who acts?

## UX-78 — Expert page and booking dialog

**Surface-specific questions:**

1. Does the dialog say instant vs request before the click, and how long a request may wait (48 h)?
2. For a request: does it say the expert will send a pay link and how long it stays open?
3. For a plan: does it show the weekly cadence, total sessions, plan end and the "room for about N of S" hint?
4. For a trial: free or price, length, and that each side may move it once?
5. When no slot is free in view: does it say when the next free slot is, or offer the next week?
6. Signed out: does the dialog keep the pick across sign-in?

**Expect:** yes to each, with the quoted text.

**Probe further:** a paused expert (CO-06): what does the page say, and does it suggest another expert?

## UX-79 — Checkout pages

**Surface-specific questions:**

1. The cancellation policy and refund tiers in ₹, for this booking's time?
2. For an org learner: who pays, which program, what's left in the budget?
3. For a paid trial: the hold deadline and what happens if unpaid (the time is released)?
4. After a mock payment: the success page names the time (zone), the join method, and how to cancel?
5. On a refusal toast: a way back to pick another time without starting over?

**Expect:** yes to each.

**Probe further:** the subscription checkout's room hint: does it say which weeks are short and what the expert will do about them?

## UX-80 — Allocate page (consultant)

**Surface-specific questions:**

1. The buyer's local time for a hovered or picked session?
2. Why a cell is unpickable (each state's tooltip, HM-19)?
3. The plan week's dates and how many sessions remain this week and in the plan?
4. After Save: what the buyer will receive (bell, email, pay link) and the pay deadline for unpaid approvals?
5. When Auto can't fill the week: which days were tried and why they failed?

**Expect:** yes to each.

**Probe further:** the phone notice ("desktop only") with "Auto-schedule this week": does it say what Auto will pick before it saves?

## UX-81 — Reschedule pages (both sides)

**Surface-specific questions:**

1. Moves left for this session (consultee) or booking (expert)?
2. The 24-h rule and the session's own deadline?
3. Whether the new time confirms now or waits, and the respond-by time if it waits?
4. The other party's local time for the proposed slot?
5. "Any time works": what happens next, who places it, and by when?
6. After submit: the original time's state (released or still held)?

**Expect:** yes to each.

**Probe further:** while a proposal waits, does the booking page show both the original and the proposed time with their states?

## UX-82 — Cancel and leave dialogs

**Surface-specific questions:**

1. The refund amount in ₹, the tier, and the time it drops to the next tier?
2. Who is told, and what they're told?
3. For a subscription: which sessions are refunded at which tier, and what happens to sessions under 24 h?
4. For an expert cancel: the strike and the 3-in-90-days public notice?
5. After confirm: when the money arrives (5–7 working days for cards; credited at once for org wallets)?
6. An alternative before cancelling (reschedule, return a session, skip a make-up)?

**Expect:** yes to each.

**Probe further:** the cancel dialog inside 15 min (frozen): does it say why and what to do (report a problem)?

## UX-83 — Manage timings, pattern scheduler, re-time and series move

**Surface-specific questions:**

1. For a sold event: who will be told and that they may leave with a full refund until `retimeBy`?
2. Sessions under 24 h that won't move (series move): listed, with the reason?
3. Attendee clashes: who, and that they may leave?
4. Pattern scheduler: sessions beyond 4 weeks "Checked when you save" — is the host told what happens if one fails at save?
5. Kathmandu host: why no pattern can be scheduled (CL-17)?
6. Co-host busy: whose calendar, which session?

**Expect:** yes to each.

**Probe further:** after a re-time, does the host's detail page show the free-leave deadline and any seats that left?

## UX-84 — Appointment detail (consultee and consultant)

**Surface-specific questions:**

1. Join: when the join button becomes active and how to join?
2. Next deadline for this booking (pay, free cancel, reschedule cut-off)?
3. The other party's name, local time and notes?
4. History: who moved or cancelled what, when?
5. Money: what was paid, refunded, pending, and (consultant) earned and held until?
6. For a parked booking (CO-91): what's wrong and what each side should do?
7. Add to calendar (consultee) and its equivalent for the consultant (TZ-46)?

**Expect:** yes to each.

**Probe further:** for a subscription, does the detail show each session's state (held, upcoming, released, returned, refunded) and the plan's remaining count?

## UX-85 — Requests inbox and Home

**Surface-specific questions:**

1. Each row's deadline and what happens at it (request expires, pay link lapses, plan refunded at 48 h)?
2. Why a row sits in "Waiting on the client" and since when?
3. A disabled Approve (for example inside the unpaid lead): the reason?
4. Home items: each has one action that opens the exact booking?
5. A lapsed pay link: can the buyer actually ask for a new one ("Ask <expert> for a new link")?

**Expect:** yes to each.

**Probe further:** batch approve: does the outcome list say which rows failed and why, in the same words as single approve (UX-48)?

## UX-86 — Payments, refunds, earnings

**Surface-specific questions:**

1. For each refund: amount, reason, method (card, org wallet, credits), status, expected arrival?
2. A failed refund: who acts and how the user follows up?
3. Earnings: why held, until when, and what a later refund does to it?
4. Org spend: which learner, which expert, which program, the balance left?

**Expect:** yes to each.

**Probe further:** does the consultee payment detail link back to the booking, and the booking back to the payment?

## UX-87 — Plan editors and availability

**Surface-specific questions:**

1. Plan editor: buyers' view previewed (price per session, total, cadence, plan end)?
2. Feasibility: warnings shown on a 201 publish (LOW_HEADROOM, WEEKS_SHORT)? (Writer report: not shown.)
3. Availability: what a change does to existing bookings (HM-11's "keeps the booking" note) and to buyers looking right now?
4. Availability in a DST zone: the transition dates ahead?
5. Zone change: what will and won't move (TZ-42)?

**Expect:** yes to each.

**Probe further:** the booking-mode switch ("Review requests first"): does it say it doesn't apply to trials (TR-16)?
