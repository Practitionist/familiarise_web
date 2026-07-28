---
title: Payment confirmation has exactly one writer
band: 70-design-decisions
audience: sde2
status: live
last-reviewed: 2026-07-28
---

# ADR 21 — Payment confirmation has exactly one writer

## Context

Three code paths could observe that a Razorpay payment had succeeded: the
`payment.captured` webhook, the client's return from the checkout modal
(`/api/checkout/verify-signature`), and an on-demand status sync
(`/api/checkout/verify?sync=true`). Only the first ran the confirmation
pipeline. The other two wrote the outcome directly:

```ts
// app/api/checkout/verify-signature/route.ts, before this decision
const updated = await prisma.payment.updateMany({
  where: { id: payment.id, paymentStatus: "PENDING" },
  data: { paymentStatus: "SUCCEEDED", paymentMethod: "razorpay", ... },
});
```

That looks safe. It is a conditional update, it is atomic, and it deliberately
guards on the current status to avoid racing the webhook. The problem is not the
write itself but what the write means to everything downstream.

`handlePaymentSuccess` — the function that confirms the appointment, creates
`ConsultantEarnings`, posts the `booking:<paymentId>` journal transaction,
accrues GST, and sends notifications — opens with an idempotency guard:

```ts
if (payment.paymentStatus === PaymentStatus.SUCCEEDED) {
  console.log(`Payment ${paymentIntentId} has already been processed.`);
  return null; // Signal: already processed, skip Phase 2
}
```

That guard is correct on the assumption that `SUCCEEDED` implies the pipeline
ran. Once a second writer can set `SUCCEEDED` without running it, the guard
inverts: it stops reading "this work is done" and starts reading "this work will
never be done". The webhook arrives, sees `SUCCEEDED`, and returns. No
appointment, no earnings, no journal entry, no GST, and — because the
capture-amount parity check sits _below_ the early return — no verification that
the amount captured matches the amount owed.

The buyer's money is taken and never enters the ledger.

This is not a rare interleaving. The client's return from the Razorpay modal is
a direct HTTP call from a browser that is already awake; the webhook is an
inbound call from Razorpay that the route ACKs and then processes inside
Next.js's `after()`. The client normally wins. The failure was the common case,
not the edge case. It had not been observed only because no live Razorpay
checkout had ever run through the path — the sole non-seed payments in the
database are `order_mock_*` rows created through `/api/dev/mock-webhook`, which
does call `handlePaymentSuccess`.

## Decision

**`Payment.paymentStatus` is written by the confirmation pipeline and by nothing
else.** Any path that learns a payment succeeded calls the pipeline rather than
recording the conclusion itself.

All three paths now funnel through one exported router:

```ts
// app/api/webhooks/razorpay-dispatch.ts
export async function routeCapturedPayment(params: {
  orderId: string;
  notes: Record<string, string>;
  amountPaise?: number;
  gatewayPaymentId?: string;
}): Promise<void>;
```

The router exists because the routing decision — `notes.type` selects between
`handleOrgPaymentSuccess`, `handleOverageMemberSuccess` and
`handlePaymentSuccess` — must be identical everywhere. Three copies of a
four-way branch is three chances to diverge, and the refund-status mapping in
this same subsystem had already drifted across three copies before anyone
noticed.

Two consequences follow for callers that are not the webhook:

**They must fetch gateway truth first.** The signature on the client's return
proves that the `(order_id, payment_id)` pair came from Razorpay. It carries
neither the captured amount nor the `notes`, and both are required — the amount
for the parity check, the notes to pick a handler. So `verify-signature` fetches
the payment from Razorpay before routing. If that fetch fails it reports
`pendingConfirmation` and defers to the webhook; it does **not** fall back to
writing the status, because that is precisely the behaviour being removed.

**They must expect to lose the race, and that must be fine.** The pipeline runs
at `Serializable` under `withSerializableRetry` and is idempotent on the
already-`SUCCEEDED` check. Whichever path arrives first does the work; the other
observes the completed state and returns. Both orderings produce one appointment,
one set of earnings, and one journal entry.

## Why not the alternatives

**Make the client path read-only and let the webhook be the sole writer.** This
is the architecturally purest option and it was seriously considered. It was
rejected on user experience: the buyer sits on a spinner until an asynchronous
callback from a third party completes, and every webhook delay becomes a visible
product defect. It also concentrates all recovery on the stuck-event sweeper,
which runs on a schedule GitHub Actions delivers at roughly one tick per 100
minutes (see ADR 22).

**Keep the direct write and add a `pipelinePending` marker for a sweeper to
re-drive.** Smallest diff, and rejected for what it leaves behind: a window in
which a payment reads `SUCCEEDED` with no journal entry. During that window the
reconciler is correct to alarm, the buyer is correct to expect a booking, and
neither is true. Encoding "money moved but is not recorded" as a valid
intermediate state is the thing to avoid, not to manage.

## Consequences

Adding a new way to learn about a payment means calling `routeCapturedPayment`,
not writing status. A reviewer's test for any new payment code is: _does this
set `paymentStatus` outside the pipeline?_ If yes, it is wrong.

`verify-signature` now makes an outbound call to Razorpay before responding,
adding roughly 200–600 ms to the checkout modal's handler. That is the price of
the parity check running on the path most buyers actually take, and it is paid
once per checkout.

The client contract gained `pendingConfirmation`, which is true when the payment
is settled but the booking has not materialised. `checkout-success` renders that
as "Payment received — confirming your booking" rather than either an
unqualified success or a failure. Before this, that page redirected to
`/checkout/checkout-failure` on the 400 that means "not completed yet", so a
buyer whose card had just been charged could be told their payment failed.

The regression tests live in `__tests__/payments/` and assert the race in both
directions: verify-signature first then webhook, and webhook first then
verify-signature. Both must produce exactly one of everything.

## Related

- ADR 13 — Postgres-native concurrency. The Serializable + idempotent-guard
  pattern this relies on is Layer 2 there.
- ADR 22 — queue posture. Explains why the sweeper cadence cannot be assumed
  tight enough to be the only recovery path.
- `docs/enterprise/10-money-and-ledger/12-payment-webhooks.md` — the runtime
  detail of the webhook tier.
