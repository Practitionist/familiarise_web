# ADR: an approval pay-link charges the same GST as checkout

- **Status**: Accepted
- **Date**: 2026-09-19
- **Part of**: the 2026-09-19 Muse Spark booking money train (#1583 C-P0-01), PR-M.

## Context

Every approval pay-link — the checkout hand-off a consultant sends after
accepting a consultation, subscription, or trial request — was minted at the
plan's raw price. `createApprovalPaymentIntent`
(`lib/payments/operations/approval-payment.ts`) set `amount = plan.price` (or
`trialPriceInPaise`), copied that same figure into `originalAmount`, and left
`taxAmount` at its schema default of 0. The buyer's card was charged the
pre-tax list price on every approval-rail booking, while the exact same plan
sold through direct checkout charged list price plus GST via the one
production price derivation, `deriveCheckoutAmount`. #1583 C-P0-01 named this
as a live P0: two purchase paths for the same product, two different prices,
and one of them silently under-collected tax on every sale.

The gap mattered beyond the missed revenue. Earnings, invoicing and the GST
outward register all read `originalAmount` and `taxAmount` off the `Payment`
row as the source of truth for what was owed and what was collected; a
pay-link Payment with `taxAmount: 0` reported an invoice tax split that did
not reflect what actually should have been charged.

## Decision

1. **The pay-link mint derives its amount through `deriveCheckoutAmount`**,
   the same pure function checkout's transaction calls, rather than reading
   the plan price directly. `calculateAmount` in `approval-payment.ts` now
   returns `{ amount, originalAmount, taxAmount, isInternational, currency,
plan }`, and `prisma.payment.create` persists all four: `amount` (taxed) is
   what the buyer is charged, `originalAmount` (pre-tax list price) is what
   earnings and the consultant's base continue to read, and `taxAmount` and
   `isInternational` are no longer frozen at their defaults. The CARD leg's
   `amountPaise` is the taxed `amount`, keeping the leg-sum identity intact.

2. **`buyerCountry` comes from `detectBuyerCountry({ userCountry:
buyer.country })`**, not from a request header the way checkout's own tax
   context resolves it. The mint runs inside the consultant's approval
   action — there is no buyer request to read a header from — so the buyer's
   stored profile country is the only signal available, read from the same
   consultee-profile lookup the mint already performs.

3. **No discount codes and no referral credits on a pay-link, by owner
   decision Q3.** `deriveCheckoutAmount` is called with no `discount` and no
   `useReferralCredits`, so parity is tax-only for now. Discount-code and
   referral-credit parity on the approval rail is a deliberate follow-up,
   filed after merge, not an oversight in this fix.

4. **A re-mint always re-derives**, never copies a prior mint's frozen
   figure — the reuse/re-mint path (`:150-204`, `:239-258`) compares a live
   PENDING row's `amount` against a freshly derived taxed amount, and a
   mismatch (a pre-fix row minted before this change) is superseded exactly
   as checkout supersedes an amount-mismatched open order.

5. **A concurrent double-accept is a typed 409, not a crash.** Two accepts
   racing past the mint lock both reaching `prisma.payment.create` can only
   have one winner, because `Payment` carries a `@@unique([userId,
appointmentId])`. The loser's P2002 is now mapped to
   `ApprovalPaymentExistsError` (409), declared beside
   `ApprovalWindowLapsedError` in the same file, so the caller retries and
   reuses the winner's row instead of surfacing a raw database error.

## Consequences

Earnings and the GST outward register now read a true tax split off every
approval-rail Payment, the same as a direct-checkout one; `originalAmount`
stays the consultant's base regardless of which rail the booking came
through. A trial's pay-link is unaffected in the common case — a ₹0 trial
base still derives to 0/0/0 — but a priced trial now collects tax the same
way a priced consultation does. The two approval routes that catch mint
errors still map only `ApprovalWindowLapsedError` to their own 409;
`ApprovalPaymentExistsError` answers their generic 502 ("approve again to
retry") until `app/api/bookings/**` adds its own mapping for the new error,
which is safe because the retry reuses the winner's row. Discount-code and
referral-credit parity on pay-links remains open, tracked as a follow-up
issue filed after merge.
