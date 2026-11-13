# 07-trials (TR-)

Free and paid trials on subscription plans: the buyer picks the time, a free trial confirms at once, a paid trial holds its time until payment, each side may move it once, either side may cancel (expert: full refund and a strike), late captures are refunded, completion and conversion to a subscription.

| File | Cases | What |
| --- | --- | --- |
| [01-book-free-and-paid.md](01-book-free-and-paid.md) | TR-01 – TR-18 | Free trial, trial-step gates, window refusals, paid hold, hold blocks others, capture confirms in place, short pay window, lapse sweep, capture after start, abandon, no manual confirm, one per pair, trial-disabled and draft plans, paused expert, no room, REQUEST mode, dual-role calendar, open-request cap |
| [02-reschedule-cancel-convert.md](02-reschedule-cancel-convert.md) | TR-19 – TR-41 | Learner move and cap, named time required, taken/unbookable, 24-h rule, expert proposal and cap, decline restores, expiry, party-only, unpaid can't move, expert cancel paid (refund + strike) and free (strike), staff cancel, learner cancel tiers with bound quote, frozen/delivered, PATCH refusals, cancel with open proposal, completion, conversion, 30-day window, expert's view, 15-minute trial lengths |

**Fixtures:** S-11 (H1 weeks plan, free 30-min trial; needs `minTrialPriceInPaise = 0`), S-12 (H1 months plan, paid ₹100 30-min trial), F-AV1, F-BUSY. Each case names what it books. H4 is used once (TR-15) and restored.

**Run order:** after 01; after 03 has restored H1 to "Instant booking" (03-d CO-45). 01-book first, then 02. TR-16 switches H1 to "Review requests first" and back.

**Environment:** free trials run on a preview. Paid trials can be **held** anywhere the gateway mints an order, but **paying** needs Razorpay test mode or an owner-run capture webhook replay: there is no Mock Pay on `/checkout/plans/trial/[trialId]` (it hands off to `/checkout/pay/[paymentId]`). Sweeps (`expire-unpaid-trials`, reschedule-proposal expiry, `auto-complete-appointments`, `retry-auto-refunds`) are NEEDS-OWNER-RUN off production.

**Open points written into the cases (report the result either way):**

- The expert cancel records a strike for a **free** trial (doc and code); a free **consultation** cancelled by the expert records none (CO-82). Pending owner confirmation (TR-30).
- `CANCELLED` frees the learner–expert pair even when the expert cancelled (TR-12, TR-30, TR-33).
- Two pay-window rules: `payWindowEnd` (start − 15 min) and `computeTrialPaymentDueAt` (clamped to the start) (TR-07).
- Conversion: doc says any plan of the same expert; the PATCH `CONVERTED` handler checks the same plan. No trial-fee credit on the plan price (TR-38).
- The booking-mode setting ("Review requests first") doesn't apply to trials in code (TR-16).
- Trial lengths step by 15 minutes (TR-41).
- `prisma/schema.prisma` comments on `TrialStatus` call `AWAITING_PAYMENT` "Legacy" and say a paid trial is paid at `PENDING`; the doc and the route use `AWAITING_PAYMENT` as the live paid hold.
