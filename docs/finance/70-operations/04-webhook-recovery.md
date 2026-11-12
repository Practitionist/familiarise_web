---
title: Recover stuck webhook events
type: how-to
band: 70-operations
audience: sde3
status: live
last-reviewed: 2026-10-23
---

# Recover stuck webhook events

Use this page when a Razorpay or RazorpayX event reached us but its effect never landed: a buyer paid but has no booking, a refund or dispute event keeps waiting, a wallet top-up was captured but not credited, or Sentry shows the warning "sweep-stuck-webhook-events: N webhook event(s) still unprocessed". Every inbound event is first written to the `WebhookEvent` table and then processed, so a lost effect leaves a row you can find and re-drive. How events are received and which handler each one reaches is in [capture confirmation and webhooks](../10-money-in/02-capture-confirmation-and-webhooks.md); this page is only about recovery.

## The four row shapes you will meet

A `WebhookEvent` row is described by `processed`, `error`, `claimedAt` and `deferCount`. The sweep `sweep-stuck-webhook-events` (`scripts/cleanup/sweep-stuck-webhook-events.ts`) treats them as follows.

| Shape                                                        | Meaning                                                                                                                               | What the sweep does                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `processed = false`, `error` empty, `claimedAt` old or empty | Received but not finished: the handler crashed, or it deferred because a prerequisite row (the `Payment`, usually) was not there yet. | Reclaims the row and re-runs the handler.                                 |
| `error` set, not prefixed `permanent:` or `gave up:`         | A transient failure on an earlier try (the sweep writes `sweep-failed: ...` when its own re-drive throws).                            | Retries until the row is 168 hours old.                                   |
| `error` starts with `permanent:`                             | The payload failed validation or is otherwise unprocessable.                                                                          | Never retried (`TERMINAL_ERROR_PREFIXES` in `lib/webhooks/event-log.ts`). |
| `error` starts with `gave up:`                               | A deferred event never became processable within 168 hours.                                                                           | Never retried.                                                            |

A row counts as stuck once it is older than 6 minutes (`staleMinutes`) with no live claim. The claim is a compare-and-set stamp on `claimedAt` (`reclaimStaleProcessingWebhookEvent`): if a frozen function container thaws after the sweep took over, its completion write matches zero rows and is discarded, so a stale run can never overwrite the sweep's result.

The sweep runs on the five-minute ticker every 15 minutes at `:00` (see [scheduled money jobs](01-scheduled-jobs.md)). One run starts batches of 200 for up to 15 seconds and processes each batch one event at a time, each with its own 15-second deadline. The budget is checked only between batches, so one slow upstream call can use up a run and leave the rest of its batch for the next tick. It never reports to Sentry per row: it raises at most one warning per run when an unprocessed event has `deferCount` of 5 or more, or is older than one hour, and one more when re-driven events are still failing.

## Step 1: confirm what is stuck

Run this read-only query against the production database (never in a transaction that writes):

```sql
SELECT id, provider, "eventType", "eventId", processed, "deferCount",
       "claimedAt", "receivedAt", error
FROM "WebhookEvent"
WHERE "receivedAt" < now() - interval '6 minutes'
  AND provider IN ('razorpay', 'stream', 'novu')
  AND ("claimedAt" IS NULL OR "claimedAt" < now() - interval '6 minutes')
  AND ((processed = false AND error IS NULL)
       OR (error IS NOT NULL AND "receivedAt" >= now() - interval '168 hours'
           AND error NOT LIKE 'permanent:%' AND error NOT LIKE 'gave up:%'))
ORDER BY "receivedAt" ASC
LIMIT 25;
```

To find the events for one order or payment, search the payload text for the Razorpay `order_` or `pay_` id:

```sql
SELECT id, provider, "eventType", processed, "deferCount", error, "receivedAt"
FROM "WebhookEvent"
WHERE payload::text LIKE '%' || 'pay_XXXXXXXX' || '%'
ORDER BY "receivedAt" DESC
LIMIT 20;
```

Impact depends on the event: a stuck `payment.captured` means a paid buyer without a booking (see "A paid buyer has no booking" in [the money runbooks](05-money-runbooks.md)); a stuck `refund.*` means a refund status that has not updated; a stuck `payout.*` means a payout row that has not moved.

## Step 2: read the `deferCount`

A handler answers a `DeferSignal` instead of failing when the row it needs has not arrived. A refund or dispute event commonly arrives before the capture event it belongs to. The row then reads `processed = false`, `error` empty, and `deferCount` grows on each sweep pass. To diagnose a high count:

1. Take the `pay_...` id from the payload (`payload.refund.entity.payment_id` or `payload.dispute.entity.payment_id`).
2. Look for the payment:
   ```sql
   SELECT id, "paymentIntent", "gatewayPaymentId", "paymentStatus", "createdAt"
   FROM "Payment"
   WHERE "gatewayPaymentId" = 'pay_XXXXXXXX' OR "paymentIntent" = 'order_XXXXXXXX';
   ```
3. If there is no row, the capture has not been confirmed. Run `reconcile-payment-status` (below); once the payment is confirmed the deferred event processes on the next sweep.
4. If the row exists but `gatewayPaymentId` is empty, the capture was confirmed without the gateway payment id. Check that `RAZORPAY_KEY_ID` and `RAZORPAY_SECRET` are valid, because the fallback that fills it calls Razorpay's payment fetch.

## Step 3: fix

1. **Wait one cycle or run the sweep now.** The sweep is idempotent. To run it immediately:
   ```bash
   curl -sS -X POST -H "Authorization: Bearer $CRON_SECRET" \
     "$APP_URL/api/cleanup/sweep-stuck-webhook-events?limit=50"
   ```
   The answer carries `scanned`, `recovered`, `stillFailing`, `deferred`, `gaveUp` and an `errors` list. A 409 means another run holds the lease; a 503 with a `phase` means maintenance is holding it.
2. **A deferred capture event.** Run `reconcile-payment-status` the same way. It asks Razorpay about every `PENDING` payment and confirms real captures through the single confirmer, `handlePaymentSuccess`, so the booking is built and the deferred events then drain.
3. **A capture whose metadata failed validation.** The row is `permanent:` and the payment is `SUCCEEDED` with no booking. Use the admin recover door (`POST /api/payments/[paymentId]/recover`, step-up, reason, one ops-log row): an admin supplies corrected booking metadata, and the door builds the appointment, but only for a target that equals the notes the server minted on the Razorpay order, so a recovery cannot book a different expert. The door answers 409 `PAYMENT_RETURNED` for a payment whose money was returned or is contested (a pending or paid refund, an owed-refund or auto-refund marker, an open or lost dispute), because there is no `REFUNDED` payment status and such a payment still reads `SUCCEEDED` with no booking.
4. **A `permanent:` or `gave up:` row you believe is valid.** The sweep will not touch it again. Do not edit the row by hand: a manual `UPDATE` of `processed` or `claimedAt` breaks the claim fencing described above. Find the money effect it should have had (a refund, a payment, a payout status) and drive that through its own reconciler or door: `reconcile-refunds`, `reconcile-disputes`, `reconcile-payout-status` or the admin refund door.
5. **A signature that stopped verifying.** If events are being rejected after a secret rotation, fix the secret, not the verifier: see the rotation notes in [the Razorpay gateway page](../10-money-in/04-razorpay-gateway-and-currency.md). Never loosen signature verification to unblock a row.

Re-sending an event from the Razorpay dashboard is safe within one calendar year of its first delivery, because the receiver dedupes on `eventId` through the `WebhookEvent` row: an already processed event is acknowledged and ignored. After `archive-webhook-events` deletes that row at one year, a re-sent event is dispatched again, and only the handlers' own idempotency protects it.

## Step 4: verify

Re-run the Step 1 query and confirm the row is gone from the stuck set (`processed = true` and `error` empty). Then check the business effect: the payment is `SUCCEEDED` and linked to an appointment, the refund row is `SUCCEEDED`, the wallet shows the credit. A clean `reconcile-ledgers` run is the final check that no money drift remains.

## What the receiver does during an outage

The Razorpay webhook route answers 503 when the database health probe (`isDbHealthy`) fails, so Razorpay retries delivery with backoff for 24 hours. After that window only the sweep and the reconcilers can recover an event, which is why leaving a row unprocessed is safe for hours but not for days.

## Retention

The weekly `archive-webhook-events` job (`scripts/cleanup/archive-webhook-events.ts`) deletes every processed or failed `WebhookEvent` row (including terminal `permanent:` and `gave up:`) after 1 year (calendar), in 2,000-row batches, because the DPDP Rules 2025 keep logs of processing for at least a year, and finished `OutboundWebhookDelivery` rows after 30 days. `EmailEvent` is pruned elsewhere, by `prune-system-job-executions` at 1 year (calendar). A webhook older than that cannot be replayed from our table, only reconstructed from the gateway.

## Where in code

| Concern                                            | File                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------- |
| Row writes, claim, terminal prefixes, health probe | `lib/webhooks/event-log.ts`                                            |
| Recovery sweep                                     | `scripts/cleanup/sweep-stuck-webhook-events.ts`                        |
| Stale-claim takeover                               | `lib/stream/webhook-receipt.ts` (`reclaimStaleProcessingWebhookEvent`) |
| Razorpay dispatch and deferral                     | `app/api/webhooks/razorpay-dispatch.ts`                                |
| Admin recover door                                 | `app/api/payments/[paymentId]/recover/route.ts`                        |

## Related

- [Webhook reference](../10-money-in/03-razorpay-webhook-reference.md) for per-event payloads.
- [Money runbooks](05-money-runbooks.md) for the symptom-first procedures that start from a buyer or operator report.

## Deprecated & Superseded Approaches

1. **A 72-hour floor on sweeping.** Skipping rows older than 72 hours orphaned valid events after a long weekend incident. `maxAgeHours` (default 72) now only logs a warning for older rows; the 168-hour give-up cap is the only age limit.
2. **An unbounded per-event loop.** Replaced by the per-event 15-second deadline so one hung replay cannot exhaust the run or the single database connection.
3. **A `status`, `attempts` or `last_error` column on webhook rows.** `WebhookEvent` has no such columns; the state is `processed`, `error`, `claimedAt` and `deferCount`.
4. **Replaying by POSTing the original payload with a hand-built signature.** Use the sweep or the dashboard resend; the receiver dedupes on `eventId`.
5. **Stripe webhook recovery.** Stripe was removed; the receivers are Razorpay, Stream and Resend only.
