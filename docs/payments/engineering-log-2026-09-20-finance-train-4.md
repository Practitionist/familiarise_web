# Finance train 4 (2026-09-20): engineering log

**Date:** 2026-09-20 · **Tracking:** #1675, #1527 W2 · **Scope:** the consultee and consultant money surfaces, the money-state layer under them, and the reads they share with their API routes.

This log collects the pull requests of the fourth finance train. Each PR appends its own dated section and keeps that section self-contained, so a reader can follow one PR without the others.

## PR-X — consultee Payments: Needs you + History on the money-state layer

**Branch:** `feat/consultee-payments-needs-you-history` · **Date:** 2026-09-20

### What was wrong

The consultee Payments page at `/dashboard/consultee/[consulteeId]/payments` was the only money surface with no server-side seed: a client component fetched its own route after mount, so every visit painted a skeleton first. The route computed a payment's displayed status with an algorithm of its own (`displayStatus`, refund sums and a client-side "PENDING past its expiry reads EXPIRED" rule) rather than through `lib/dashboard/money-state.ts`, the derivation the appointment detail page, the checkout success page and the Home widget already share, and the tab re-implemented the receipt link that `receiptHref` in `lib/appointments/payment-display.ts` already resolves. The list also resolved a sponsoring organisation's name from the viewer's session memberships instead of from the row.

### What changed

The read moved behind `readConsulteePayments` in `lib/data/consultee-payments.ts`. It runs the same `payment.findMany` the route ran, bound to the profile owner (`userId` plus `user.consulteeProfileId`), with the org-scope filter and the 250-row cap kept, and the buyer-safe select widened by the funding legs (source and amount, shared through `FUNDING_LEG_SUMMARY_SELECT` and `BUYER_PAYMENT_DISPLAY_SELECT` in `lib/data/payments-select.ts`), the dispute status, the CHARGE_MEMBER co-pay children, the lifecycle status per appointment kind, the plan price and the EXPIRED history edges. Gateway ids and organisation billing internals stay out. A CHARGE_MEMBER side-charge is presented on its parent's line, so top-level rows exclude `parentPaymentId`-linked payments. Each row carries a ready `presentation` input built with the same `lifecycleOf` and `planOf` helpers `lib/appointments/presentation-input.ts` uses for the detail page, so the client never assembles one. The route is a thin wrapper — the same guard, the same `?orgScope=` resolution, the read, and an inline `Cache-Control: no-store` header that PR #1755 will later swap for a shared constant.

`money-state.ts` exports `derivePaymentPresentation(input, viewer, options)`, a thin adapter that runs `deriveBookingPresentation` with an empty occurrence list and picks the money state, the next action and the settled flag. It contains no logic of its own, and a table pin over PAID, PARTIALLY_REFUNDED, REFUNDED, REFUND_PENDING, SPONSORED, DISPUTED, DUE and FREE asserts that the two entry points agree.

The page is a server component. It runs `requirePersonalProfileAccess("consultee", …)`, resolves the profile owner, prefetches the `["consultee-payments", consulteeId, "personal"]` key inside a `Suspense` boundary whose fallback is `PageSkeleton`, and hands the dehydrated state to `PaymentsTab`, which keeps its `useQuery` on the same key with `refetchOnMount: "always"` so a purchase made elsewhere in the same session still lands within one navigation. The "Payments" tab renders `NeedsYouBand`, which reads the Home widget's `pending-payments` query and mounts `PendingPaymentsWidget` itself when there is a pending payment or a lapsed pay link, and `PaymentsHistoryList`, which groups rows under month headers, renders one money line and one badge per row from `derivePaymentPresentation`, offers "View receipt" through `receiptHref`, and links each row to its appointment detail page, where every money door lives. Chips filter client-side on the money state; a charge that failed or expired stays visible under a caution badge. The Credits tab is unchanged.

The three rail sentences the cancel dialog shows moved out of `CancelConfirmationDialog.tsx` into `refundRailLine` in `payment-display.ts`, whose header now names the two vocabularies that meet there.

### What was deliberately not done

Cursor pagination for the history is post-MVP; the list is capped at the 250 newest rows. The Home widget exports no standalone pending-row component, so the band mounts the whole widget rather than forking its rows. The summary cards above the tabs (Total spent, Credits earned, Credit balance) were left as they were.

### Verification

`npx prisma generate && NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit` cold, `npx eslint` and `npx prettier --check` on every touched file, and `npx jest __tests__/dashboards __tests__/appointments/detail-payment-scope.test.ts __tests__/payments/pending-payments-frozen-amount.test.ts` — the pins are the route's 403 for a foreign consultee, the derivation table, the band's absent/present cases, the History rendering test (rail words present, no amount on the sponsored row, no raw enum text) and the three distinct rail sentences.

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
