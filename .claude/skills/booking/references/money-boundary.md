---
name: booking-money-boundary
description: Where the booking subsystem touches money — the tentative hold and Payment.expiresAt, mock and zero-amount payments, the one price derivation, the one refund quote, the three funding rails, EXPIRED versus REJECTED versus CANCELLED, the earnings healer, and everything checkout re-validates inside its lock. Load when changing checkout, a payment hold, a refund amount or rail, a cancellation quote, earnings accrual, or anything under lib/payments/pricing/, lib/payments/operations/, or app/api/checkout.
---

# Booking Money Boundary

Booking and money meet at four seams: the hold that reserves a slot before the
money lands, the price the buyer is charged, the amount a cancellation returns,
and the earnings that accrue afterwards. Each seam has exactly one implementation
on purpose, because two implementations of a number is how a quote and a charge
come to disagree.

## 1. The hold is a tentative slot plus `Payment.expiresAt`

Checkout writes a `Payment` and its slot atoms together. When real money is
involved the payment is `PENDING`, the slots are created with `isTentative:
true`, and `expiresAt` is set thirty minutes out. That window is
`DIRECT_CHECKOUT_HOLD_MS` in `lib/payments/constants.ts`, applied in
`lib/payments/checkout/orchestrate.ts`. The
abandoned-payments sweep mirrors it independently with a 35-minute buffer for
legacy rows that carry a null `expiresAt`. `Payment` is indexed on
`[expiresAt, paymentStatus]` for exactly this cohort.

A webinar or class seat holds for 15 minutes instead: a 12-minute gateway
window plus a 3-minute capture grace (`SEAT_CHECKOUT_HOLD_MS`; see
`references/concurrency.md` §11).

Checkout resumes or supersedes the same buyer's open orders before it mints
(`lib/payments/checkout/order-reuse.ts`). It supersedes only a lapsed hold, a
released seat, or a same-window order at a stale price, stamping the old row
`EXPIRED` with `expiresAt: new Date()` so its hold dies immediately. A live order
for a **different** window is another booking and is neither resumed nor
superseded, so one buyer can hold two checkouts in two tabs. A replay under the
same idempotency key must match the priced inputs it was minted with: the
`Payment.requestFingerprint` is compared, and a mismatch mints a fresh attempt
instead of replaying (`replayByIdempotencyKey` in
`lib/payments/operations/checkout-replay.ts`). `PaymentStatus` has exactly
four values — `PENDING`, `SUCCEEDED`, `FAILED`, `EXPIRED` — with no `CAPTURED`;
`SUCCEEDED` is the success terminal and `EXPIRED` means timed out rather than
gateway-rejected. See `references/availability.md` for when such a hold stops
occupying its slot.

## 2. Mock, zero-amount and org-funded payments share one bypass

`isMockPayment` is read from the **raw request body**, not from `checkoutSchema`,
and is gated by `body.isMockPayment === true && process.env.NODE_ENV ===
"development"`. That is a strict equality, so it is unavailable in production and
also in `test` and preview builds; a client cannot set it anywhere that matters.

Inside checkout it feeds `skipPayment = isMockPayment || isZeroAmountPayment ||
isOrgSponsoredPayment`, and that one flag drives the whole bypass: the payment
is written `SUCCEEDED` rather than `PENDING`, `expiresAt` is null, slots are
created non-tentative (`isTentative: !skipPayment`), the gateway call is skipped
and earnings are created inline instead of by webhook. Note the trap: the
persisted `Payment.isMockPayment` column is set true for all three cases, so the
column does **not** mean "a developer's mock" — do not filter production
analytics on it expecting only test rows.

A zero-amount order is one with nothing left to charge after credits, a full
discount or both (`isZeroAmountOrder` in `lib/payments/checkout/zero-amount.ts`).
It takes this no-gateway rail and succeeds at birth, because gateways reject an
amount of 0; it never mints a ₹0 order. A discount code's use is consumed at
checkout and given back only when that PENDING payment ends unpaid
(`returnDiscountUse` in `lib/payments/checkout/discount-use.ts`, called on the
caller's PENDING → EXPIRED or FAILED CAS win). A paid booking keeps its use, even
when it is later refunded.

## 3. One price derivation

As of 2026-09-19 (#1583 C-P0-01, owner decision Q3) `deriveCheckoutAmount` has a
second production call site: `createApprovalPaymentIntent`
(`lib/payments/operations/approval-payment.ts`) mints an approval pay-link
through the same function, so a consultant-minted pay-link charges the same
GST a direct checkout would, instead of the plan's raw pre-tax price with
`taxAmount` frozen at 0. `buyerCountry` comes from `detectBuyerCountry({
userCountry: buyer.country })` rather than a request header, because the mint
runs inside the consultant's approval action, not the buyer's own request; no
`discount` and no `useReferralCredits` are passed, so a pay-link is tax-only —
discount codes and referral credits on the approval rail are a deliberate
follow-up, not an oversight. `originalAmount` stays the pre-tax list price
(what earnings read as the consultant's base) and the CARD leg carries the
taxed `amount`, matching the leg-sum identity checkout already keeps. A
re-mint always re-derives; it never copies a prior mint's frozen figure.

`deriveCheckoutAmount` (`lib/payments/pricing/derive-checkout-amount.ts`) is the
only place a checkout price is computed, with two production call sites now,
both inside a transaction. It works in **integer paise as plain `number`**,
not BigInt. The fixed order of operations is why it is centralised: list price,
discount, tax on the discounted base, then referral credits against the
tax-inclusive total. It returns `originalAmount`, `discountPaise`,
`discountedAmount`, `taxAmount`, `taxRate`, `isZeroRated`, `taxedAmount`,
`creditsApplied`, `amount`, `isInternational` and `tax`. Its helpers
`computeDiscountPaise` (which multiplies before dividing, and throws outright on
a negative `discountValue` or `maxDiscount`, since either would raise the price
above list) and `isCreditRedemptionEligible` are exported only so the parity
suite can drive them; neither has a production call site outside the module, and
neither should be reimplemented.

## 4. One refund quote

As of wave 5 (#1327), `quoteBookingRefund` in
`lib/payments/operations/cancellation-policy.ts` is the only refund
calculation, and both the cancel POST route and the `cancel/preview` GET route
call it. It returns `refundPct`, `tierRefundPct`, `noticeHours`,
`proratedBasePaise`, `prorated`, `refundPaise` and `creditRestoresInFull`. Unlike
the price derivation it **does** use BigInt for its two multiplications, on the
stated grounds that the products can leave the safe-integer range long before the
amounts stop being real money. A booking that was never scheduled has
`noticeHours` of positive infinity, so it sits in the top tier rather than the
already-started floor. `PLATFORM_DEFAULT_TIERS` is 100% at 24 hours, 50% at 2
hours, 0% below.

An expert, admin or host-org cancel refunds 100 % on every ladder
(`CONSULTANT_INITIATED_PCT`); the org policy route pins it and the engine ignores
any stored value below it. A subscription quote nets out per-session refunds
already paid (a void, an incident) before it applies the tier
(`alreadyRefundedPaise`). The public `/refund` page renders its tiers from these
same constants, so the policy text cannot drift from the engine.

A quote that restates the rule is a rule that can drift from the charge. If you
change a tier, a proration denominator or a clamp, change it here.

**The cancel window comes before any quote.** `cancelWindowState`
(`lib/booking/session-window.ts`) reads the booking's live sessions: a confirmed
SCHEDULED session inside `[start − 15 min, end]` makes the booking IN_PROGRESS,
and a delivered session (held, or past its end and not yet swept) with nothing
still owed makes it DELIVERED. The cancel route, its preview and trial cancel
refuse those with 409 `SESSION_IN_PROGRESS` or `SESSION_ALREADY_DELIVERED`
(`cancelWindowRefusal`), with nothing committed, so a delivered consultation or
paid trial can never quote 100 %. The host is told to end the call and let the
outcome sweep settle it. A class session under way counts as delivered for an
attendee who leaves and as refundable for a host who cancels.

**The notice floor is the consultee's own, per session.** The tier's notice is
the hours to the next live session, floored by the shortest notice the consultee
gave when they released that same session (by ordinal) in an earlier reschedule.
The floor is read from `RescheduleRequest.releasedSessions` through
`countedReleases` (`lib/booking/released-sessions.ts`), counting only
consultee-initiated requests that really moved sessions (not withdrawn, not
restored), and timed from the request's `createdAt`. An expert's reschedule never
lowers the buyer's refund. A released session whose original time passed with no
replacement counts as full notice (past every tier), unless the consultee
released it, in which case the recorded floor still applies. A booking with no live session left gets no notice
figure at all, so it never falls back to the floor; the window refuses it first
(`resolveBookingRefundContext` in `lib/booking/cancellation-scope.ts`). Preview
and POST resolve the actor through one function, `resolveCancelActor`
(`lib/booking/cancel-actor.ts`), so their tiers agree.

The dialog speaks to who is cancelling (`CancelConfirmationDialog`,
`viewerRole`). The consultant's copy is "{client} gets a full refund of ₹X.
Cancelling a paid booking counts against your reliability.", with the buttons
"Keep booking" and "Cancel and refund"; the consultee's confirm button is
"Cancel booking".

**The tiers are typed rows, not a Json snapshot (#1499).** `CancellationPolicy` +
`CancellationPolicyTier` hold one published, immutable version of a ladder;
`Appointment.cancellationPolicyId` points at the version that governed the sale.
`Appointment.cancellationPolicySnapshot` was FROZEN and has since been **dropped** —
it is no longer a column on `Appointment`, so there is nothing left to add a reader
to. The only surviving trace of the name is a cross-reference comment in the
`SupportTicket` SLA block of `prisma/schema.prisma`. Refund terms come from the
typed rows via `cancellationPolicyId` alone. Loading and publishing live
in `lib/payments/operations/cancellation-policy-store.ts`
(`POLICY_TERMS_INCLUDE`, `termsFromPolicyRow`, `ensurePlatformCancellationPolicy`,
`resolveCheckoutCancellationPolicyId`, `publishOrgCancellationPolicy`); the maths
module above stays Prisma-free. Checkout resolves the version once inside the
booking transaction, and an org's ladder governs only the bookings that **org
funds** — a personal booking merely tagged to an org keeps the platform ladder.
Webinar and class seats always use the platform ladder, because one shared
`Appointment` serves every registrant. Editing a ladder publishes a new version
and archives the old one under `withSerializableRetry`; nothing updates a version
in place.

## 5. Refunds travel on three rails, and the rail is named before the click

`FundingRail` is `"GATEWAY" | "INTERNAL" | "CREDITS"`, decided from the payment
intent prefix: `org_` is `INTERNAL` (an in-ledger reversal against the org's
wallet, invoice or licence), `free_` is `CREDITS` (referral credits restored,
no gateway money), everything else is `GATEWAY`. The two front doors are
`refundBookingPayment` and `refundWholeEventPayments`, plus
`refundRemovedAttendeeSeat` for one seat; see the booking doctrine in `../SKILL.md`.
`refundBookingPayment` refuses a partial `amountPaise` on the credits rail with
`RefundValidationError` / `INVALID_AMOUNT`.

**The credits rail cannot pay a fraction, so #1500 rounds the tier, not the
rail.** A booking funded entirely by credit (`free_` intent **and** amount 0)
restores its credit IN FULL inside any tier above 0%, and restores NOTHING inside
a 0% tier — a late cancel bites a credit buyer exactly as it bites a card buyer.
The whole rule is one predicate in `quoteBookingRefund`
(`isFreeCreditFunded && refundPct > 0`) surfaced as `creditRestoresInFull`; the
cancel route calls `refundBookingPayment` with no `amountPaise` when it is true
and falls through to `POLICY_ZERO` when it is not. There is no `MANUAL_REVIEW`
status any more. A `free_` intent with a NON-zero amount is a mixed payment that
still settles on the money arm and is still refused `INVALID_AMOUNT`; both halves
of the predicate are load-bearing.

A subscription paid wholly in credit follows the same rule only while nothing
was delivered: then the credit restores in full. Once a session was delivered,
restoring the whole credit would also reverse that session's earnings, so the
quote shows 0 % with `creditReturnNeedsReview` and the undelivered share goes to
ops by hand (`lib/payments/operations/credit-plan-return.ts`; the admin closes a
queued return that owes nothing through
`app/api/admin/refunds/credits/close/route.ts`).

As of wave 5 (#1325) the rail is also computed **ahead of the refund** by
`fundingRailForIntent` (`lib/payments/operations/booking-refund.ts`), so the
cancel dialog can say which way the money comes back. `GET
/api/appointments/{appointmentId}/cancel/preview` surfaces it as `fundingRail`,
and the cancel POST response carries `rail`. Both readings come from the same
two prefixes, which is the point: the dialog used to promise every learner that
their card would be credited in five to seven working days, including learners
whose card was never charged. For a whole-event cancellation `fundingRail` is
deliberately `null` — the seats of one event may be funded through several rails
at once, so no single sentence is true of the aggregate.

## 6. EXPIRED, REJECTED and CANCELLED are three different stories

`EXPIRED` means a window lapsed: nobody paid in time, or an approved request was
never allocated. `REJECTED` means the consultant declined, and reads that way on
every surface. `CANCELLED` means a party with standing ended a live booking.
Picking the wrong one is a user-facing lie even when the row state is otherwise
correct, and it changes which refund path runs.

A decline is only for a request that was never confirmed. Every REJECTED door
(the consultation and subscription list and `[id]` PATCH routes) calls
`assertNotBeingMoved` (`lib/booking/request-route-guards.ts`) inside its
transaction: a booking with an open `PENDING_REVIEW` reschedule answers 409
`USE_RESCHEDULE_RESPOND` (respond or withdraw instead), and one with live
released sessions (tentative `RESCHEDULED`) and no proposal answers 409
`USE_CANCEL_ENDPOINT` (place a new time, or cancel, which quotes the refund and
records the strike).

## 7. The earnings healer has no age window

`scripts/earnings/sync-payment-earnings.ts` repairs payments that are
`SUCCEEDED` but carry no `ConsultantEarnings`, accruing the earning and its
balanced `booking:<paymentId>` ledger journal. As of wave 5 (#1327) its cohort
has **no `createdAt` filter at all**: it used to look back thirty days, so a
payment unaccrued for a month left the cohort silently and the consultant was
never paid for a session they had delivered. There is no age at which money
stops being owed. Runtime is bounded instead by `MAX_PAYMENTS_PER_RUN` (500),
oldest first, so a backlog drains across runs. An age threshold survives only
for _alerting_: `UNACCRUED_ALERT_AFTER_HOURS` is 24, after which a payment that
resolves no consultant is escalated as `EARNINGS_UNACCRUABLE_NO_CONSULTANT`.

## 8. What checkout re-validates inside the lock

Everything that could have changed between the pre-flight read and the write is
re-asserted after the lock is held, because a gate that ran before the lock is a
gate a concurrent writer walked through:

- The slot window against the union of published availability rows, atom by
  atom (see `references/availability.md`), **and** against the plan's own
  length: `assertWindowMatchesPlanDuration` (`lib/booking/slot-validation.ts`)
  refuses a window whose length differs from the plan's duration with 400
  `WINDOW_DURATION_MISMATCH`. Request-for-approval, direct checkout and the trial
  route all call it, so a 6-hour window can no longer be sold at a 1-hour price.
- A paused expert (`acceptingRequests = false`) refuses direct checkout and
  trials with 409 `NOT_ACCEPTING_BOOKINGS`; existing bookings are unaffected.
- Slot conflicts, via `validateSlotAvailability`, checkout's own in-transaction
  re-check. It subtracts `buildDeadHoldFilter(new Date())` from the occupancy
  query so a lapsed hold no longer blocks, and the consultee-side conflict reads
  beside it use the same subtraction for parity. (`revalidateConflicts` on
  `ScheduleValidationService` is the allocator's equivalent, not checkout's — do not
  cite it here.)
- The lock grant, renewed at the top of every Serializable attempt; lost
  ownership aborts the attempt.
- As of wave 5 (#1319, B2B gap 3) the **org funding context** — the org's
  `status` and `canSponsor` and the caller's membership status, re-read by id
  under the lock, because an org suspended or a membership revoked between the
  gate and the write previously still got a sponsored booking. The credit limit
  is re-checked inside the Serializable booking transaction.

## 9. The pay-link mint is its own atom

The mint has its own guarded key nested under the approval lock, in the order
approval → mint; see `references/concurrency.md` §1.

**The pay window ends before the session starts.** `payWindowEnd`
(`lib/payments/operations/approval-payment.ts`) sets `holdExpiresAt` to the
earlier of 24 hours from now and 15 minutes before the first live session. A
window shorter than 30 minutes (`MIN_PAY_WINDOW_MS`) is not minted:
`ApprovalTooCloseToStartError` (409 `TOO_CLOSE_TO_START`), and the approval is
lapsed to EXPIRED with its holds released and the consultee told once
(`lapseTooCloseApproval` in `lib/booking/lapse-approved-request.ts`). The
approving transaction itself refuses an unpaid approval whose first session is
under 2 hours away (`assertUnpaidApprovalFits` in `lib/booking/lead-time.ts`).
A capture that arrives after the first session started never confirms: the
capture commit closes the request as EXPIRED, releases its holds, and the payment
takes the late-capture path and is refunded in full
(`closeStartedBeforePayment` in `lib/payments/webhooks/handlers.ts`).

**A trial converts only when the plan is paid.** `convertCompletedTrial`
(`lib/trials/conversion.ts`) moves the consultee's COMPLETED trial with the same
expert (any plan) to CONVERTED and stamps `convertedToSubscriptionId`, by CAS,
only when the plan is paid within 30 days of `Trial.completedAt`
(`TRIAL_CONVERSION_WINDOW_MS`); a later purchase is not its conversion.
It runs in `confirmApprovalStatus` at capture (`lib/payments/webhooks/handlers.ts`)
and at a no-gateway subscription checkout that settles at once (`skipPayment` in
`lib/payments/checkout/handlers/subscription.ts`), never at checkout start, so an
abandoned checkout leaves the trial COMPLETED. A lost CAS never fails the capture.

**The row exists before the order does.** `createApprovalPaymentIntent`
(`lib/payments/operations/approval-payment.ts`) writes a PENDING `Payment` whose
`paymentIntent` is a `premint_` placeholder (`lib/payments/pre-mint-intent.ts`)
before calling the gateway, stamps that row's id into the order's `notes` as
`familiarisePaymentId` (first key, so Razorpay's 15-key cap never drops it), and
then fills the real order id into the row by CAS on the placeholder. A crash
between the two writes leaves a placeholder row that the lapsed pay-link sweep
retires. If the fill fails, the minted order is recorded as an EXPIRED tombstone
(`tombstoneAbortedGatewayOrder` in `lib/payments/checkout/gateway-intent.ts`, `appointmentId: null`) and the
placeholder row is expired, so a later capture on that order is auto-refunded
instead of landing on no row. A re-mint reuses the same row in place
(`claimRowForRemint`), keeping its id, user and appointment, and tombstones the
**old** intent so a payment on the old order is still matched.

**A capture on an order with no row is adopted, not guessed.** When
`handlePaymentSuccess` (`lib/payments/webhooks/handlers.ts`) finds no row for the
captured order, `verifiedPreMintAdoption` fetches the order from Razorpay
server-side (a client's notes are never trusted; a gateway failure throws so the
webhook is retried) and reads `familiarisePaymentId`. `adoptPreMintRow` then
swaps the placeholder for the order id by CAS, only for a row still carrying its
placeholder, at the order's exact amount and currency, and moves the CARD leg's
`sourceRef` with it.

**A seat re-buy never 500s.** Group-event seats share one appointment and
`@@unique([userId, appointmentId])`, so `findPriorSeatPayment` and
`assertSeatRemintable` (`lib/payments/checkout/seats.ts`) re-mint an EXPIRED or FAILED row in place
and tombstone its old intent in the same transaction. A PENDING row answers
`PAYMENT_ALREADY_EXISTS`; a fully refunded seat answers `SEAT_REBUY_UNSUPPORTED`
until the schema batch makes the unique re-buyable **(planned)**. Both are typed
refusals, never a 500.

## 10. A refund owed is never lost, and the quote is bound to the click

Every door that ends a booking and then refunds (the cancel route, trial
cancel, rejection, moderation, the maintenance freeze, a consultant no-show and
a whole-event cancel) is **state-as-outbox**. In the same transaction that ends
the booking it stamps the per-payment marker `Payment.refundOwedPaise`,
`refundOwedKey` (unique), `refundOwedReason`, `refundOwedAt`,
`refundOwedAttempts` and `refundOwedNextAt` through `stampRefundOwed` or `stampRefundsOwed`
(`lib/payments/operations/refund-owed.ts`). After the commit the door calls
`driveRefundOwed`, which runs `refundBookingPayment` under the marker's key
(`cancel:<appointmentId>:<paymentId>`, `trial-cancel:<trialId>:<paymentId>`,
`rejection:<requestId>:<paymentId>`, `moderation:<appointmentId>:<paymentId>`,
`freeze:<appointmentId>:<paymentId>`, `consultant-no-show:<paymentId>`,
`event-cancel:<eventId>:pay:<paymentId>`, `class-end:<classId>:pay:<paymentId>`,
`parked-consultation:<consultationId>:<paymentId>`)
and clears the marker by CAS on the key once the refund is not PENDING. The first
writer wins, so a second door cannot overwrite the amount owed. A death between
commit and drive leaves CANCELLED plus SUCCEEDED plus a marker, and the
`retry-auto-refunds` sweep (`scripts/payments/retry-auto-refunds.ts`) re-drives
every marker older than 15 minutes whose `refundOwedNextAt` is null or past,
fewest attempts first. A drive that fails counts an attempt by CAS on the key
and the prior count, and sets `refundOwedNextAt` 1 hour out after the first
failure and 4 hours out after the second, so a gateway outage of a few hours
does not page. At `MAX_REFUND_OWED_ATTEMPTS` (3), about 5 hours after the stamp,
the sweep stops and records one system error ("refund by hand"). A marker
unresolved after six hours is reported once a day from the persisted amount. Do not pre-create a `Refund` row
to mark intent: a PENDING row reduces the refundable balance and makes the
credits rail refuse. The older `Auto-refund pending:` family means "booking not
confirmed, refund the whole capture" and is a different thing.

A declared platform incident is one more door on this pattern. The
`settle-platform-incidents` sweep (`scripts/appointments/settle-platform-incidents.ts`)
writes one `IncidentRemedy` per seat and session, and a consultation, paid-trial
or webinar remedy calls `refundIncidentSeat`
(`lib/payments/operations/incident-refunds.ts`): it stamps the marker under
`incident:<incident>:<occurrence>:<user>` for the full remaining balance
(`amountPaise: null`), cancels a paid trial in that same commit, then drives the
refund. A payment that already owes a different key is a marker conflict: the
remedy counts an attempt and, at `MAX_REMEDY_ATTEMPTS` (3), is dead-lettered
with the `dead-letter:` prefix for an operator. The refund re-checks under the
appointment lock that the session is still `VOIDED`, so an ops un-void wins.
`occurrenceRefundsPaise` and `voidRefundExists` read the `incident:` prefix, so
never add a new refund-key family without teaching those two scans.
`occurrenceRefundsPaise` also reads the per-seat `seat-leave:`, `seat-exit:` and
`class-end:` prefixes; `voidRefundExists` stays per session, so a per-seat
family never belongs there.

How a gateway failure is classified decides who finishes the job
(`refundBookingPayment` and `isDefinitiveRefundRefusal`). A **definitive**
refusal (our own pre-checks, or Razorpay's 4xx validation class such as
`BAD_REQUEST_ERROR`, or a 404) proves no gateway refund exists, so the
reservation row is FAILED at once and frees the key and balance for a retry. An
**ambiguous** failure (timeout, 5xx, an in-flight idempotency key) may have moved
money, so the reservation stays PENDING with the original gateway idempotency key
and `reconcile-refunds` resolves it by lookup. The owed sweep skips any payment
with a PENDING refund for exactly that reason.

**A door that cannot own the marker refuses.** A payment carries one marker at
a time and the first writer wins, so a door that finds another door's marker
already on the payment commits nothing and answers through `heldMarkerRefusal`:
409 `REFUND_IN_PROGRESS` while that marker is still retrying, or 409
`REFUND_NEEDS_SUPPORT` once it has spent `MAX_REFUND_OWED_ATTEMPTS` or a live
dispute holds the payment. The cancel route, trial cancel, seat leave and the
whole-event cancel all follow this rule, so no door drives a refund it does not
own and none leaves its own refund undurable. `stampWholeEventRefundsOwed` stamps
the roster in one statement, accepts a replay of its own key, and throws the
refusal (subject `class` or `webinar`) on any seat whose marker is not its own,
so the cancel route, the ADMIN `cancel-series` door and the moderation cancel
commit nothing; `refundWholeEventPayments` then drives only the event's own keys. A `REFUND_NEEDS_SUPPORT` refusal writes one audited
`SystemEvent` per payment and marker (`recordRefundNeedsSupport`), and support
settles the marker through an operator refund door.

**A door that proceeds anyway holds the money for a hand top-up.** Rejection,
moderation of a 1:1 booking or a removed attendee, a consultant no-show, the
maintenance freeze and the overage credit-back end the booking even when another
door's partial marker holds the payment (a full-balance one already covers
them). `stampOwedOrHeld` / `heldInsteadOf` then records one
`owed-already-held:<payment>:<key>` `SystemEvent` with the top-up amount and
places an `OPERATOR` `EarningsHold` keyed on it, in the door's transaction; a
hold race refuses with a retryable 409 and rolls the door back.
`readOwedAlreadyHeld` lists it in the Refunds tab while the money is unpaid
(later refunds, oldest row first, minus any share that settled the holding
refund; the balance), then until the hold is released. Operators (ADMIN or
STAFF) read a held-marker refusal through `opsHeldMarkerMessage`: the payment,
the holding key and their own door's next step. The miss ledger's class lock
is `FOR NO KEY UPDATE`, compatible with the key-share lock history-row foreign
keys take.

**An operator's refund settles the owed refund by hand.** Every operator door
passes `settlesOwedByHand` to `refundBookingPayment`: the issue and ladder
override door (`app/api/admin/refunds/issue/route.ts`), the admin single-payment
refund (`app/api/admin/refunds/route.ts`) and the approved support remedy
(`executeApprovedRefund` in `lib/support/case-actions.ts`); the credit-return
door (`restoreSessionCredits`) always does. Inside the transaction that creates
the operator's `Refund` row, `settleOwedByHand` compares the hand refund with
what the marker owes (a null amount reads as the refundable balance before it),
by CAS on the key and the owed amount. A hand refund that covers it clears the
marker, `refundOwedNextAt` included. A smaller one lowers `refundOwedPaise` by
its amount and leaves the attempts and backoff alone, so the next drive pays
only the remainder. The outcome is written to the Refund row's
`metadata.settledOwed` (`key`, `reason`, `owedPaise`, `settledPaise`,
`stillOwedPaise`, `note`), returned as `settledOwed`, and the refund dialog shows
its note: "The owed ₹Y is fully settled." or "Settled ₹X of the owed ₹Y; ₹Z
still owed and retrying." A marker whose own refund is PENDING refuses the hand refund
with 409 `OWED_REFUND_IN_FLIGHT`. Every marker drive, the door's
own first drive included, carries the marker as `owedMarker`, and each rail's
transaction checks the marker still holds the payment at that amount
(`assertOwedMarkerHeld`). A drive whose marker was cleared ends `settled`, and
one whose marker was reduced ends `blocked`; neither moves money. A partial
credit return against a whole-restoration marker is refused with
`OWED_RESTORATION_WHOLE`. A hand refund that moves to FAILED, from the front
door, `reconcile-refunds` or the `refund.failed` webhook, gives back what it
settled in that same transaction (`failRefund`, `restoreOwedOnFailedRefund`).
A live marker grows back by CAS, and a cleared one is re-stamped under
`<key>:restored:<refundId>` with `refundOwedNextAt` 15 minutes out. Both are
capped at the refundable balance and made once-only by `settledOwedRestored` on
the refund. A late gateway success on that FAILED row takes it off again
(`resettleOwedOnLateSuccess`). A seat leave or removal stamps its marker in
the commit that releases the seat.

**A cancel cannot race a capture into a free cancellation.** The cancel's
request CAS is pinned to the status it read inside the transaction, and the same
commit expires the live PENDING payment (`expirePendingPaymentsInTx` in
`lib/booking/pending-payment-expiry.ts`). A capture that commits first makes the
cancel re-run and re-quote (409 `REFUND_QUOTE_CHANGED`); a capture that lands
after finds the payment EXPIRED and is parked and refunded.

The cancel route binds the quote to the click. `quoteBookingRefund` runs inside
the cancel transaction, then `assertQuoteMatchesClick` compares it with the
dialog's `expectedRefundPaise` (and `expectedCreditRestoresInFull` on the credits
rail). A difference commits nothing and answers 409 `REFUND_QUOTE_CHANGED` with
the new `refundPaise`, `refundPct` and `creditRestoresInFull`; the client
(`lib/appointments/cancel-requote.ts`) shows the new figure and re-asks. A body
without `expectedRefundPaise` is an older client and is accepted unbound. A retry
after a lost response gets the committed result, not `NOT_CANCELLABLE`:
`replayCommittedCancel` answers `replayed: true` for a booking this caller already
cancelled, reading the keyed `Refund` row or the owed marker rather than
requoting. The platform absorbs the gateway fee, so the consultee receives
exactly the quoted percentage.

## 11. Returning a session, reschedule caps and strikes

A consultee returns one live subscription session to the plan with `POST
/api/appointments/[appointmentId]/occurrences/[occurrenceId]/return`
(`returnSessionToPlan` in `lib/booking/session-return.ts`; replayed by
`Idempotency-Key`). It requires the plan's own buyer, an APPROVED subscription, a
SCHEDULED non-tentative occurrence starting at least 24 hours after the database's
`now()`, no open reschedule proposal and no active dispute. The occurrence moves
to CANCELLED through `transitionOccurrenceCompletion` with reason
`RETURNED_TO_PLAN`, `Subscription.sessionsReturned` rises by one (at most two per
plan, backed by the `subscription_sessions_returned_range` CHECK) and
`Subscription.planEndsAt` moves seven days later in the same conditional write. No
money moves. Refusals are typed: `RETURN_WINDOW_CLOSED`, `RETURN_CAP_REACHED`,
`RETURN_RESCHEDULE_OPEN`, `DISPUTE_ACTIVE`, `SESSION_NOT_RETURNABLE`. Inside 24
hours a missed session counts as delivered.

Reschedule caps count the release records on `RescheduleRequest`, not occurrence
rows, because the allocator hard-deletes the occurrences a re-allocation replaces
(`priorReschedules` in `lib/booking/reschedule-caps.ts`, over `countedReleases`).
Every party release opens a request and records the sessions it released in
`releasedSessions`; a request that was withdrawn, or whose ending restored the
booking (`restoredAt` set), moved nothing and costs nothing. A consultee may move
each session (by ordinal) twice (`MAX_CONSULTEE_RESCHEDULES`; 422
`MAX_RESCHEDULES_EXCEEDED`); an expert may reschedule a booking twice
(`MAX_EXPERT_RESCHEDULES`) and the third answers 409 `EXPERT_RESCHEDULE_CAP`. Staff
are exempt.

A published webinar is never rescheduled; its host re-times it
(`POST /api/appointments/[appointmentId]/retime`, `retimeWebinar` in
`lib/booking/event-retime.ts`). The session row moves in place and is stamped
`movedAt`, and the move needs the new time at least 24 hours out and on the half
hour (409 `RETIME_TOO_SOON`). The host and every ACCEPTED co-host must be free;
an attendee already busy then is flagged and notified, never a reason to refuse.
The move opens a free leave: every seat bought before it may leave with a full
refund of what is undelivered until `Webinar.retimeBy`, which is the earlier of 7
days after the move and the new start, and is only ever lengthened
(`retimeLeaveUntil` and `extendRetimeLeave` in `lib/booking/retime-leave.ts`). A
class make-up opens the same leave on `Class.retimeBy`. Seat leave reads it
through `inRetimeFreeLeave`.

An operator of the plan's host org who cancels is recorded as the actor and
strikes nobody; the buyer still gets 100 %.

An expert-side cancel of a paid booking, or a consultant no-show claim, writes
one reliability strike in the same transaction: a `SystemEvent` on the
`expert-reliability:<consultantProfileId>` correlation (`recordExpertStrike` in
`lib/booking/expert-reliability.ts`). A platform-caused miss records nothing. The
public profile shows a notice at three strikes in 90 days
(`EXPERT_STRIKE_THRESHOLD`), the completion rate reads them, and ops reads them
from `GET /api/admin/sessions/expert-strikes`. No money is taken from the expert.

No strike lands inside a declared platform incident. `classifySessionOutcome`
returns `PLATFORM_OUTAGE` first when the booked interval overlaps a declared
window at all (`overlapsDeclaredIncident` in `lib/booking/session-outcome.ts`);
the no-show detector claims only `HOST_ABSENT`, and `countExpertStrikes` and
`readExpertStrikeReview` drop any strike on an appointment that has a session
overlapping a declared incident, even one recorded before the declaration.

## 12. A doubtful session holds its money for a human

`AWAITING_HUMAN` in `lib/booking/misses.ts` is the one definition of a past
session that waits for ops: an `INCONCLUSIVE` verdict, a declined consultation
host no-show, a maintenance-cut call, and a `NOBODY_JOINED` or `OFFLINE` verdict
on a booking with a `SUCCEEDED` payment on any rail. `auto-complete-appointments`
will not complete its booking, `release-earnings` keeps its earnings `PENDING`
(`RELEASABLE_PAYMENT`), and the ops card lists it through `NEEDS_HUMAN`. The only
exit is `session.set-outcome`; nothing is refunded or released automatically. A
free session where nobody joined has no money to hold and completes. Widen this
predicate, never a caller's copy of it.

## 13. A subscription settles at its fixed plan end

A subscription's terms are fixed at purchase by `purchaseTermsOf`
(`lib/booking/entitlement.ts`): the weekly cap (`Subscription.sessionsPerWeek`),
the session length (`sessionMinutes`), the sessions sold (`sessionsTotal` =
weeks × sessions a week, where a months plan counts `durationInMonths × 4`
weeks) and the plan end (`planEndsAt`). A weeks plan ends `durationInWeeks × 7`
zone-days after the start at the same wall time (`weeksPlanEndOf`, so a DST
change never moves the end hour); a months plan ends on the same date
`durationInMonths` later, clamped to the month's last day (`planEndOf`),
exclusive. Every sweep, admin view, incident extension, document and renewal
reads the end through `subscriptionPlanEnd` or `subscriptionIsOver`; an incident
extension or a returned session moves the stored value. Readers of a sold plan's
cadence use `soldTermsOf` / `soldSessionsPerWeek` / `soldSessionMinutes`, which
fall back to the plan only for a row sold before the freeze, and a plan edit
stamps those rows first (`freezeSoldTerms`), so an edit applies to new buyers
only.

A support partial refund of k sessions (the `REVIEW_REFUND` door with a
session count) refunds `min(floor(paid × k / sessionsTotal), refundable)` and,
in the approval's commit, adds k to `Subscription.sessionsRefunded` by CAS on
the count read (`removePlanSessions`, `lib/booking/plan-refund.ts`). Those
sessions leave the schedulable total (`sessionsTotal − sessionsRefunded`), so
the expert never delivers a session whose earnings were already reversed. A
void of that approval puts them back (`restorePlanSessions`) while the plan is
live; a settled plan refuses the void. Only an open plan (live, before its end, no
owed marker) gives up sessions. Every other door nets them: the cancel quote
(`quoteUnusedSessions`) owes `T − sessionsRefunded − delivered` sessions over a
denominator of `T`, and `alreadyRefundedPaise` adds money-only support refunds;
the plan end waits while such a remedy's refund is failed or unsent. Once the
plan settled without those sessions, their refund is still owed: a retry pays it
and a void is refused. The cancel's subscription CAS is pinned to the
`sessionsRefunded` it quoted, so an approval landing mid-cancel re-quotes it.
Earnings tranches keep the allocation minted at capture (over `sessionsTotal`),
but once every session the buyer kept is delivered, every tranche left has
matured: `settleSubscriptionCycle` stamps them all, including the retained part
of one the refund cut short, and auto-complete runs that stamp in the commit
that marks the plan COMPLETED, so a refund that ends the entitlement with no
delivery left never strands an earned tranche.

At the plan end the `settle-cancelled-sessions` sweep
(`scripts/appointments/settle-cancelled-sessions.ts`) settles once: every
session not delivered (voided, returned or never placed) is refunded pro rata
through `refundBookingPayment`, under a durable owed marker keyed
`plan-end:<subscriptionId>:pay:<paymentId>` stamped in the commit that completes
the plan. While that marker is set, the tranches stamped in the same commit
stay `PENDING` (`RELEASABLE_PAYMENT`), so a refund that keeps failing never
releases them. The share is `floor(paid × (T − delivered) / T)` less what the
payment already returned, with `T = sessionsTotal` (the sessions sold, not the
schedulable count): on a ₹15,600 plan of 78 sessions, a ₹1,800 support refund
of 9 sessions in week 10 and a plan end with 61 delivered settle
`floor(15,600 × 17 / 78) − 1,800` = ₹1,600, so no session is paid twice.

The pass resumes each tick from a checkpoint, so plans that must wait
never starve the ones behind them. A void in the middle of a plan is not paid
back while the session can still be re-booked; it waits for the plan end.

## 14. A class settles its never-placed sessions when it completes

A class completes once every placed session has ended and been decided
(`completeClasses` in `scripts/appointments/auto-complete-appointments.ts`), and
the same transaction that moves it to COMPLETED stamps class-end settlement
(`stampClassEndRefundsOwed` in `lib/payments/operations/event-refunds.ts`).
Every live paid seat is owed `floor(paid × unplaced / heldCount)` less any
class-end refund already sent, clamped to the refundable balance. `heldCount` is
the sessions the seat bought (`sessionsPurchased`, so N for an on-time seat and
fewer for a late joiner), and `unplaced` is the bought sessions with no row at
all: `SeatLedger.unplaced` in `lib/booking/class-series.ts` counts distinct
ordinals that were delivered, are live, or were missed (host-cancelled or
voided), because a missed session is already answered by its make-up or its
`occ:` unit refund. A released row that was never re-placed counts as unplaced.
A ₹100 seat of a 10-session class that ran 8 is owed ₹20.

The marker is keyed `class-end:<classId>:pay:<paymentId>` and goes through
`stampWholeEventRefundsOwed` with `basis: "unplaced"`, so a payment that already
owes another door's refund refuses the completion and the class waits for the
next run. A credit-funded seat owed part of its value is queued for a human
(`partial-credit:<paymentId>`) in the same commit. Auto-complete moves no money
itself: the `retry-auto-refunds` sweep, a financial job that pauses in DEGRADED
maintenance, drives the markers, and each marker holds its payment's earnings
(`RELEASABLE_PAYMENT` waits for `refundOwedKey: null`) until the refund settles
and reverses the refunded share.

## Deprecated & Superseded Approaches

- **The notice floor from history.** The floor once read `BookingStatusHistory`
  timed from `updatedAt`, counted expert reschedules, and was used when no live
  session remained, which let a delivered booking quote 100 %. It now reads the
  consultee's own release records and never runs without a live session.
- **History-counted reschedule caps.** Caps once counted distinct RESCHEDULED
  history instants per side, so a declined or expired proposal that restored
  the booking still cost a reschedule. They count release records now.
- **A sold plan reading the live plan row's cadence.** A plan edit once changed
  the weekly cap and session length of plans already sold; they are frozen on
  the subscription now.
- **A plan end derived from the scheduling period.** Readers once treated
  `schedulingPeriodEndsAt` as the plan end, so a void mid-plan was refunded while
  still re-bookable. Read `subscriptionPlanEnd`.
- **₹0 gateway orders.** A fully discounted order once still minted a gateway
  order, which the gateway rejects. It takes the no-gateway rail now.
- **"Unschedule" for webinars and classes.** The host once pulled an event's date
  and left attendees with no time; re-time and the free leave replaced it.
- **`linkCompletedTrialToSubscription` at checkout start.** It stamped CONVERTED
  before any payment, so abandoned checkouts counted as conversions. Replaced by
  `convertCompletedTrial` at capture or no-gateway settle.
- **Decline as an implicit cancel.** A REJECTED PATCH on a booking being moved
  once cancelled every session, refunded in full and recorded no strike;
  `assertNotBeingMoved` refuses it now.
- **A passed, never-replaced released session quoted from its old start.** Its
  notice once came out negative, the lowest tier; it now counts as full notice.
- **A whole-event cancel that committed without owning every seat's marker.** It
  logged the seats another door held and drove whatever marker it found; it now
  refuses, and a losing door that proceeds holds the earnings for a top-up.
- **A class completing short with no settlement.** Auto-complete once moved a
  class to COMPLETED after its last placed session whatever it had sold, so the
  never-placed sessions were neither delivered nor refunded and the earnings
  released in full. Class-end settlement owes them now.
