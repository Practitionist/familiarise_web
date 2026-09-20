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

## PR-Y — consultant Earnings: Available / Pending / Paid out on an earnings-state layer

**Branch:** `feat/consultant-earnings-available-pending-paid` · **Date:** 2026-09-20

### What was wrong

The consultant Earnings page at `/dashboard/consultant/[consultantId]/earnings` spoke the machine's vocabulary: five stat tiles (Net Earnings, Ready for Payout, Pending (In Hold), Already Paid Out, Processing Payout, Pending Org Trust) and eight status filter tabs (All, Pending, Ready, Processing, Paid, On Hold, Org Trust, Refunded), each a server round-trip. The hold-date rule (`holdUntil && status === "PENDING" && holdUntil > now`) was hardcoded inline in the status cell. No consultant route read `ConsultantPayout`, so a consultant never saw the TDS withheld from a payout, the net amount that reached the bank, or the UTR to trace it with; the "Payout" column showed a raw `PayoutStatus` word when no date was available. The row named the booking by its `appointmentType` rather than the plan the client bought, and never said when an organisation had paid.

### What changed

`lib/dashboard/earnings-state.ts` is the new pure derivation. `deriveEarningPresentation(row, { now, livePayoutsEnabled })` maps every `EarningStatus` onto one of three buckets — Available (`READY`, `BATCHED`), Pending (`PENDING`, `HELD`, `PENDING_TRUST`), Paid out (`PAID`) — plus Refunded, with a badge word, a tone from `money-state.ts`, one line (the hold date for a `PENDING` row, the dispute-or-review reason for `HELD`, the sponsor's name for `PENDING_TRUST`) and the `availableOn` instant. `derivePayoutPresentation(payout)` does the same for every `PayoutStatus`, with the failure reason reduced to plain words by an idempotent `sanitizePayoutFailure`. `nextPayoutCopy(now, live)` is flag-aware: "Payouts begin at launch — your balance is safe with us" while `ENABLE_LIVE_PAYOUTS` is off, "Paid every Monday · next: <date>" from `PAYOUT_BATCH_UTC = { weekday: 1, hour: 20 }` (mirroring `create-payout-batch.yml`, never importing it) when on. `moneyWalk` and `sumEarningBuckets` feed the tiles and the sheet. Dates on this page are formatted in `Asia/Kolkata` because the payout rail is India-only, which also keeps the server seed and the client render identical.

The reads changed in two places. `getConsultantEarnings` widened only its payment sub-select — the funding legs and method (the inputs `isSponsoredPayment` reads; its parameter type was narrowed to those two fields), `organizationId` with the organisation's name, and the plan title behind each appointment kind; the earning scalars the page needs were already returned by the `include`. `getConsultantPayouts(consultantProfileId, { take = 50 })` is a new, clearly separated block at the end of `payout-service.ts` with an earner-safe `CONSULTANT_PAYOUT_SELECT` (id, status, amount, tdsDeducted, netAmount, tdsRateAppliedBps, tdsFinancialYear, processedAt, gatewayUtr, failureReason, mustPayByDate, createdAt), newest first. `buildConsultantEarningsPayload` awaits it after the existing fan-out, maps every earning to carry `title` and `sponsorOrgName`, sanitises `failureReason` before the payload leaves the server, and the route answers with an inline `Cache-Control: no-store`.

The page is three tiles and one segmented list. The tile sums are whole-account figures computed in the read (`getConsultantBucketTotals` in `lib/data/consultant-earnings-analytics.ts`: one `groupBy` over `ConsultantEarnings` by status and one aggregate over `COMPLETED` `ConsultantPayout` rows, fed through Y-1's `sumEarningBuckets` so the tiles and the row badges share one bucket map), never a total of the page of rows fetched: Available is the share less refunds over `READY` + `BATCHED`, Pending the three waiting states netted the same way, Paid out the `COMPLETED` payouts' `netAmount`, falling back to `amount − tdsDeducted` where a row completed after a failed attempt left `netAmount` null (the review round of #1774 replaced the `_sum` with a reduce through `payoutNet`). `EarningsBuckets` renders them with `nextPayoutCopy` as the Available subtitle and a caution callout — "Add your bank account to get paid" → `/dashboard/consultant/[consultantId]/settings/payouts` — when `eligibility.hasPayoutAccount` is false or PR-Y2's `reason` is `NO_ACCOUNT` or `UNVERIFIED` (read defensively, since that field lands in PR-Y2). The segmented control offers Available / Pending / Payouts, and a Refunded segment only when a refunded row exists, so no money history disappears; the third segment is named Payouts rather than Paid out because it lists every payout with its state, Queued and Failed included, while the tile of that name sums only the completed ones (QA of #1774, case 3). An earning row reads title · date · "₹price → −₹fee platform → ₹share yours (Owner 80 % / Collab 20 %)" · the badge · the derivation's line, with the sponsoring organisation as a chip; the Payouts segment lists payouts, each with a `PayoutWalkSheet` (share → TDS @ rate, s.194-O → net · UTR · date). `EarningsSummaryPanel` is reduced to the query container — one read of up to 200 rows, no server-side status filter, client-side paging of 15, and the same owner gate `AnalyticsPageClient` applies (the route is session-scoped while the seed is keyed by the URL's id, so only the profile owner refetches) — and `page.tsx` seeds the same query key on the server so the tiles paint on first render. The eligibility bar and `IndiaOnlyPayoutNotice` are kept. `AnalyticsPageClient` takes its tile word from `BUCKET_LABEL.AVAILABLE` and its figure from the same `totals.available`, so the two tabs agree; the chart is untouched.

### What was deliberately not done

The payout-account onboarding behind the callout's link is PR-Y2; on this PR's preview the link answers 404. `checkPayoutEligibility` is untouched (also PR-Y2). `money-state.ts` gained nothing; `Tone` and `toneBadge` are imported from it. The list shows the 200 newest earnings and says so when more exist; the tiles are whole-account figures regardless. `ConsultantPayout` has no `paidAt` column — the spec's select named one — so `processedAt` is the paid date.

### Verification

`npx prisma generate && NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit` cold, `npx eslint` and `npx prettier --check` on every touched file, and `npx jest __tests__/dashboards __tests__/enterprise/earning-status-transitions.test.ts __tests__/payments/earnings-hold.test.ts` — the pins are the derivation table over every `EarningStatus` and every `PayoutStatus` with the flag on and off, the source guard that the payout select never names `providerPayoutId` or `idempotencyKey`, the page render (three tile sums, the money-walk line, the hold date and sponsor chip, the payout line and walk, no raw enum in the DOM) and the hold-date test driven through the query container.

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

## PR-Z2 — subscription escrow: refund unused sessions against the plan, one earnings tranche per cycle stamped on delivery (#1766 row 5; #1729 schema rows)

### The problem

Two money defects followed from progressive allocation. The refund quote prorated `gross × sessionsRemaining / slotsTotal` where `slotsTotal` was the number of allocated occurrences, so a 144-session plan with six slots allocated and three delivered paid back half the price to a buyer owed 141 sessions. Earnings were one row per plan payment whose hold anchored on the last live occurrence, so the consultant was paid the whole plan a week after the first cycle's last session, against the locked delivery-enforced escrow.

### The decision

The owner locked this on 2026-09-20 and it is not to be re-asked. The refund of unused sessions is `sessionsTotal − completed − late-window scheduled` at `gross / sessionsTotal` through the existing front door. Earnings are one PENDING tranche per cycle with `holdUntil` NULL, stamped by the completion path when the cycle's last occurrence completes; a refund consumes the newest un-matured tranches first; batching and payouts do not change.

### What changed, in commit order

The schema gained `ConsultantEarnings.cycleOrdinal` and a nullable `holdUntil`, and the sidecar unique `consultant_earnings_occurrence_key` widened to include the ordinal under `NULLS NOT DISTINCT`, with the preflight suite asserting the columns. `createEarningsFromPayment` reads the plan shape through the transaction and mints one row per cycle for the owner, floored per tranche with the residual on tranche 0, so the rows still sum to what the booking journal credits; `subscriptionTranches` and `maturedTrancheOrdinal` were added to `lib/booking/entitlement.ts` because PR-Z1 shipped no matured-tranche helper. `recomputeEarningsHold` skips a NULL hold and the release job was pinned as never matching one. `settleSubscriptionCycle` stamps every unstamped tranche up to the highest matured one before the bell's early return, and the cancel route stamps whatever is still NULL inside the cancel transaction. `quoteBookingRefund` gained the unused-session arm with the floor taken once per notice tier, so an untouched plan whose price does not divide still refunds the whole gross, and the percentage it reports is the effective share of the undelivered base; the context resolves `sessionsTotal` via `appointment.subscription` and both cancel routes pass it. `allocateCycleClawback` is the one ordering both refund writers use, and the refund journal's payable debits read what each row absorbed. The healer cohort and the payout batch were pinned unchanged.

### What was deliberately not done

The spec placed the terminal stamp "after the refund, in the cancel transaction"; the refund runs after that transaction commits and may defer its cascade to the webhook, so the stamp runs inside the cancel transaction before the refund, which the allocator's ordering makes equivalent. Plan edits after purchase are not refused here. UNVERIFIED→CANCELLED corrections do not un-stamp or refund. Pre-Z2 single-row subscription earnings keep the legacy path end to end.

### Owner apply steps

The shared Supabase project is live dev and prod, and `prisma db push` would drop the hand-applied partial uniques, so the schema change is applied by hand before the preview QA, verbatim from the pull request body: add the `cycleOrdinal` column, drop the NOT NULL on `holdUntil`, then drop and recreate `consultant_earnings_occurrence_key` with the fifth column.
