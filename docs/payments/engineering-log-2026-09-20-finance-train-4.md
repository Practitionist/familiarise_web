# Finance train 4 (2026-09-20): engineering log

**Date:** 2026-09-20 · **Tracking:** #1675, #1527 W2 · **Scope:** the consultee and consultant money surfaces, the money-state layer under them, and the reads they share with their API routes.

This log collects the pull requests of the fourth finance train. Each PR appends its own dated section and keeps that section self-contained, so a reader can follow one PR without the others.

## PR-X — consultee Payments: Needs you + History on the money-state layer

**Branch:** `feat/consultee-payments-needs-you-history` · **Date:** 2026-09-20

### What was wrong

The consultee Payments page at `/dashboard/consultee/[consulteeId]/payments` was the only money surface with no server-side seed: a client component fetched its own route after mount, so every visit painted a skeleton first. The route computed a payment's displayed status with an algorithm of its own (`displayStatus`, refund sums and a client-side "PENDING past its expiry reads EXPIRED" rule) rather than through `lib/dashboard/money-state.ts`, the derivation the appointment detail page, the checkout success page and the Home widget already share, and the tab re-implemented the receipt link that `receiptHref` in `lib/appointments/payment-display.ts` already resolves. The list also resolved a sponsoring organisation's name from the viewer's session memberships instead of from the row.

### What changed

The read moved behind `readConsulteePayments` in `lib/data/consultee-payments.ts`. It runs the same `payment.findMany` the route ran, bound to the profile owner (`userId` plus `user.consulteeProfileId`), with the org-scope filter and the 250-row cap kept, and the buyer-safe select widened by the funding legs (source and amount, shared through `FUNDING_LEG_SUMMARY_SELECT` and `BUYER_PAYMENT_DISPLAY_SELECT` in `lib/data/payments-select.ts`), the dispute status, the CHARGE_MEMBER co-pay children, the lifecycle status per appointment kind, the plan price and the EXPIRED history edges. Gateway ids and organisation billing internals stay out. A CHARGE_MEMBER side-charge is presented on its parent's line, so top-level rows exclude `parentPaymentId`-linked payments. Each row carries a ready `presentation` input built the way `lib/appointments/presentation-input.ts` builds the detail page's, so the client never assembles one. The route is a thin wrapper — the same guard, the same `?orgScope=` resolution, the read, and an inline `Cache-Control: no-store` header that PR #1755 will later swap for a shared constant.

`money-state.ts` exports `derivePaymentPresentation(input, viewer, options)`, a thin adapter that runs `deriveBookingPresentation` with an empty occurrence list and picks the money state, the next action and the settled flag. It contains no logic of its own, and a table pin over PAID, PARTIALLY_REFUNDED, REFUNDED, REFUND_PENDING, SPONSORED, DISPUTED, DUE and FREE asserts that the two entry points agree.

The page is a server component. It runs `requirePersonalProfileAccess("consultee", …)`, resolves the profile owner, prefetches the `["consultee-payments", consulteeId, "personal"]` key inside a `Suspense` boundary whose fallback is `PageSkeleton`, and hands the dehydrated state to `PaymentsTab`, which keeps its `useQuery` on the same key with `refetchOnMount: "always"` so a purchase made elsewhere in the same session still lands within one navigation. The "Payments" tab renders `NeedsYouBand`, which reads the Home widget's `pending-payments` query and mounts `PendingPaymentsWidget` itself when there is a pending payment or a lapsed pay link, and `PaymentsHistoryList`, which groups rows under month headers, renders one money line and one badge per row from `derivePaymentPresentation`, offers "View receipt" through `receiptHref`, and links each row to its appointment detail page, where every money door lives. Chips filter client-side on the money state; a charge that failed or expired stays visible under a caution badge. The Credits tab is unchanged.

The three rail sentences the cancel dialog shows moved out of `CancelConfirmationDialog.tsx` into `refundRailLine` in `payment-display.ts`, whose header now names the two vocabularies that meet there.

### What was deliberately not done

Cursor pagination for the history is post-MVP; the list is capped at the 250 newest rows. The Home widget exports no standalone pending-row component, so the band mounts the whole widget rather than forking its rows. The summary cards above the tabs (Total spent, Credits earned, Credit balance) were left as they were.

### Verification

`npx prisma generate && NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit` cold, `npx eslint` and `npx prettier --check` on every touched file, and `npx jest __tests__/dashboards __tests__/appointments/detail-payment-scope.test.ts __tests__/payments/pending-payments-frozen-amount.test.ts` — the pins are the route's 403 for a foreign consultee, the derivation table, the band's absent/present cases, the History rendering test (rail words present, no amount on the sponsored row, no raw enum text) and the three distinct rail sentences.
