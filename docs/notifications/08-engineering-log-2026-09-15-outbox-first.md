# Outbox-first delivery for email and Novu triggers

**Date:** 2026-09-15 · **Branch:** `feat/email-outbox-first` · **Issue:** #1654 (design), #691 NTF-1, #1648 · **Schema:** #1659 · **Scope:** `lib/email/deliver.ts` and every sender, the payment webhook handlers, `lib/novu/service.ts` and every `notify*` call site, two relays on the Netlify ticker.

This entry records why the send-first shape that #1646 left behind was still two defects away from correct, what the outbox-first shape changed, and the budgets and cadences that were chosen.

## What was wrong after #1646

The email path after #1646 was already durable on failure: a send that threw or that Resend rejected was written to `FailedEmail` and replayed with backoff. Two gaps remained, and issue #1654 walks the failure matrix that exposed them. First, the Resend SDK calls `fetch` with no timeout, so a slow provider held the caller's request until Netlify's ~26-second ceiling; a signup that had succeeded answered 504, the user retried and was told the email already existed. Second, the row was written only after the failure, so a function that froze between the business commit and the `FailedEmail` insert lost the message with no trace. Novu triggers were worse: fired without awaiting and forgotten on failure, which is how the void-trigger losses of #1616 happened and what #691 NTF-1 had recorded.

## What changed

The order of the two writes was reversed. `deliver()` is now `stage()` followed by `attempt()`: the rendered message becomes a `PENDING` `FailedEmail` row (with `entityRef`) before any network call, and the inline send runs under a per-caller `AbortSignal.timeout` budget. Success marks the row `SENT` with `resendId`; a terminal error dead-letters it; a transient error leaves it `PENDING` with `lastError`; a timeout leaves it `PENDING` and untouched, logs once and never pages, because the relay finishes the send and the content-hash Idempotency-Key makes a late duplicate harmless. The Resend SDK swallows a fetch abort into a generic "could not be resolved" error, so `attempt()` creates the signal itself and checks `signal.aborted` to tell a timeout from a network failure.

The payment webhook handlers are the one caller with a transaction of their own. `handlePaymentSuccess` reads the receipt's inputs through its Phase 1 transaction, renders with the new render-only `renderPaymentSuccessEmail()`, stages the row inside that transaction, and attempts after the commit under the `WEBHOOK` budget; the two blocked outcomes that Phase 2 refunds stage nothing. `handlePaymentFailure` stages both its email and its Novu bell inside its transaction and attempts both after the commit. Nothing else inside the money transaction changed (ADR 21).

Novu triggers got the same shape in `lib/novu/outbox.ts`. `stageTrigger()` upserts a `NotificationOutbox` row on a `transactionId` derived at stage time by `deriveTransactionId()`, whose sort became a code-point comparator instead of `localeCompare`, because a collation-dependent sort had produced different ids for the same mixed-case recipients on different runtimes. `attemptTrigger()` makes the wire call under the client's existing five-second timeout and settles the row the same way the email side does; a 2xx the SDK could not parse counts as sent, a terminal 4xx (an unknown workflow, a rejected body, a bad key) dead-letters and pages once per reason on the fingerprint `["novu-trigger-terminal", reason]`, and a timeout, 5xx or connection failure leaves the row `PENDING`. Every `notify*` call site that was `void` is now awaited, thirty-seven of them, and the four sites inside transactions (`notifyPaymentFailed`, `notifyRefundProcessed`, `notifyDisputeCreated`, `notifyDisputeResolved`) pass `{ tx, entityRef }` and run `attemptTrigger()` after the commit. The zoned trigger variants only shape the rendered payload per recipient timezone and do not defer the send, so `notBefore` stays null until the quiet-hours work uses it.

## Budgets and cadences

The table below records the inline budgets, all named in `EMAIL_BUDGET_MS` in `lib/email/config.ts`, and the relay cadences.

| Where                     | Value                                                                        | Why                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Auth senders              | 8 000 ms                                                                     | A verification link should be instant when it can be; the request has nothing else to do.             |
| Contact form and waitlist | 5 000 ms                                                                     | The visitor is waiting on a form; the row is durable either way.                                      |
| Payment webhook senders   | 3 000 ms                                                                     | The webhook has a gateway on the other end and Phase 2 work behind it.                                |
| Jobs and both relays      | 10 000 ms per send                                                           | A job can wait longer, but one hung call must not hold a tick past the ceiling.                       |
| Novu inline attempt       | 5 000 ms (the client's existing `timeoutMs`)                                 | Already bounded since #1446; the outbox only changes what happens when it expires.                    |
| Email relay on the ticker | every 15 minutes, `?limit=20`, 20-second target timeout, one send per 125 ms | Resend's team limit is 10 requests/s and the inline path sends alongside; Actions stays the backstop. |
| Novu relay on the ticker  | every 5 minutes, `?limit=20`, 20-second target timeout                       | One round trip per row under a 5-second timeout fits the target timeout even when Novu is slow.       |

## What was deliberately not done

`deliver()` does not accept a `tx` option even though the spec sketched one, because an attempt inside an open transaction would send before the business write is durable; a transaction owner calls `stage()` and `attempt()` itself. `lib/novu/org-workflows.ts` keeps its own wire helpers and does not stage rows yet; its call sites are awaited, and moving it onto the outbox is a follow-up under #691. The relays run on the existing five-minute ticker rather than a queue, which is the posture of ADR 14 and ADR 27 and the recommendation of #1654; a workflow engine is revisited only if #1653's reminder sequences and digests need orchestration the ticker cannot express.
