# Engineering log — 2026-09-20 finance train 4

This log collects the day's decisions and the code that carried them out. Each section names the pull request it belongs to, the owner decisions it implements verbatim, and the places a later reader should look first.

## PR-Z1 — subscription entitlement: one counter, first-cycle checkout window, per-cycle allocation, next-cycle row and bell (#1766 rows 1–4 and 6; #1729 schema row)

### The problem

A subscription plan is an entitlement plus a duration, but the code had no column for the entitlement and five independent formulas for "N of M". Checkout persisted whatever window the client sent, which defaulted to the whole plan lifetime, so the allocate page asked a consultant for all 144 sessions of a long plan at once. A consultant editing a plan after purchase silently changed a paid entitlement, and the auto-complete sweep flipped a subscription to the terminal `COMPLETED` status as soon as its first batch of sessions had ended.

### The decisions

The owner locked three points on 2026-09-20 and they are not to be re-asked. First, `Subscription.sessionsTotal` is one new nullable column snapshotted from the plan at purchase, with everything else derived by one pure helper and no consumed counter. Second, the server derives the scheduling window as the first cycle from the client's start, and an oversize client end is clamped rather than refused; the picker asks "When do you want to start?". Third, there is no new job: the consultant's Home row derives at read time and the consultee's bell is staged from the completion path.

### The cycle model

`lib/booking/entitlement.ts` is Prisma-free so client components can import it. Its capacity is `sessionsPerWeek` (the month arm survives only for a hand-zeroed plan), its buckets count live rows only (`completed` is COMPLETED plus UNVERIFIED, `scheduled` is non-tentative SCHEDULED, `held` is their sum), and the current cycle is `floor(completed / capacity)` with `nextBatch = min(capacity of this cycle − filled, remaining)`. The window starts at the latest of the stored start, the last held session's end and now, and runs one cycle in the scheduling timezone. The five locked scenarios are pinned as a table in `__tests__/booking/subscription-entitlement.test.ts`.

### What changed, in commit order

The schema gained the column with its `///` note, the check-constraints banner gained the staged NOT NULL and CHECK as a comment, and the seed writes the snapshot. Both subscription creators (`handleSubscriptionCheckout` and the webhook's legacy `createSubscription`) derive the window through `firstCycleWindow` and write `sessionsTotal`; the Zod edge needs a start only, and the `SCHEDULING_PERIOD_TOO_LONG` refusal is deleted. The expert-page dialog dropped its End Date input and the checkout page derives only the start and shows the first-cycle line.

The allocator's `fetchEventData` feeds `nextBatch` and the cycle window into the config, `calculateRequiredSlots` honours `cycleTargetSessions`, and a subscription with held sessions always takes the additive arm in both manual and auto mode: nothing is deleted or excluded, the batch must be exactly `nextBatch` sessions, and `assertHeldSessionCountInTx` re-counts held sessions under the per-event advisory lock so a stale tab cannot append a second cycle. The client's `initialAllocation` flag is ignored for that arm, because the allocate page sends it for any request without released slots. The four source-text suites that read `SchedulingService.ts` stayed green throughout.

Every N-of-M site now reads the helper: the validator's total and window, the detail header's `sessionProgress`, the allocate grid's heading (`subscriptionCycleHeading`) and batch size, the Home progress meter, the Requests tab's required count and the allocate reader's `allowedStart/End`. The consultant Home gained a "Next cycle to schedule" strip from `nextCycleSubscriptionWhere` plus a JS filter on `remaining > 0`, linking to the existing allocate route. The consultee bell rides the `subscription-renewed` workflow id, re-bodied as the cycle-done notice and staged by `settleSubscriptionCycle` inside the completing transaction with the dedupe key `sub:<id>:cycle:<n>`. The auto-complete sweep leaves a plan with entitlement remaining `APPROVED`, and the two expiry sweeps were pinned as already skipping a plan with one held session.

### What this PR deliberately did not do

Money per cycle — refund quotes and earnings tranches — belongs to PR-Z2. The double-buy guard in checkout still compares stored windows, which are now first-cycle windows, so it only catches a repurchase inside the first week; a status-based guard is a separate decision. Refusing plan edits while live subscriptions exist is a separate PR. The reconcile sweep's top-up cohort still compares live rows with `plan.totalSessions` and will pass over a mid-plan subscription every hour as a silent no-change.

### Owner apply steps

Run `npx prisma db push` from the merged `dev` before the deploy, and `npm run novu:sync` after it, because the step body of `subscription-renewed` changed.
