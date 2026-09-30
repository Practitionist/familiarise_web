# How payouts work

This page explains, in plain language, how money that a session earns reaches the expert or the host organisation. It is the starting point for anyone who needs the whole picture before reading the detailed pages, and every rule below was checked against the code on `dev` on 2026-09-28 (#1527). The detailed mechanics live in [earnings lifecycle](./02-earnings-lifecycle.md), [payout processing](./03-payout-processing.md) and, for organisations, the [payout pipeline](../../enterprise/10-money-and-ledger/07-payout-pipeline.md).

## Expert earnings

When a learner pays for a session, the platform keeps its share and records the expert's share as an earning. An earning is not money in the bank yet, and it moves through the statuses below before it is paid.

1. **PENDING (the hold).** The earning waits out a hold period so that a cancellation, a refund or a no-show can still be handled before any money leaves. The hold is 24 hours after a consultation or a class, 48 hours after a webinar, and 7 days for a subscription (`PAYOUT_CONSTANTS.HOLD_PERIOD_HOURS` in `lib/payments/payouts/constants.ts`).
2. **HELD (a dispute).** If the learner's bank opens a dispute on the payment, the earning is frozen as HELD until the dispute ends. It goes back to where it was if the expert wins, and it is refunded if the learner wins.
3. **READY.** Once the hold has passed, an hourly job marks the earning READY, which means it can be paid.
4. **BATCHED (Monday 20:00 UTC).** Every Monday at 20:00 UTC, the `create-payout-batch` job gathers each expert's READY earnings into one payout, as long as the total is at least ₹500. The earnings become BATCHED, which means they are promised to that payout but the money has not left yet.
5. **Approval.** A payout under ₹5,000 is approved automatically. A larger payout waits for a platform admin, who approves or rejects it in the back office and must give a reason; at ₹10,000 or more the admin must also type a confirmation word (`lib/ui/typed-confirm.ts`).
6. **Paid (Monday 21:00 UTC).** One hour later, at 21:00 UTC on Monday, the `process-payouts` job sends every approved payout to the bank through RazorpayX (or Stripe for an expert paid abroad), and the payout becomes PROCESSING.
7. **The outcome.** The payout ends in one of three states. COMPLETED means the bank confirmed the transfer, and the earnings become PAID. FAILED means the bank definitively refused it, and the earnings go back to READY so that the next Monday's batch picks them up again. REVERSED means the bank returned the money after it had already been confirmed, and the earnings re-open as READY.

An expert who does not want to wait for Monday can use **Get paid now** on the Earnings page. It pays out the expert's READY earnings at once, free of charge, at most once a day. An instant payout of up to ₹25,000 is approved and sent immediately, and a larger one joins the admin approval queue (`INSTANT_PAYOUT_AUTO_APPROVE_PAISE`).

Sometimes the bank's answer never arrives, for example because the request to RazorpayX timed out. Since #1853, such a payout is never marked FAILED on a guess, because the money might already have left and a second payout would pay the expert twice. The payout stays PROCESSING, and every four hours the `handle-stuck-payouts` job asks RazorpayX about it using our own payout id as the reference. If RazorpayX has the payout, the job records the outcome; if RazorpayX has no record of it, the job retries it safely under the same idempotency key; and if the answer is unclear, an operator is alerted.

## Organisation payouts

An organisation that hosts sessions earns its share into the same kind of earning, and its payouts follow a stricter approval rule since #1860.

1. **PENDING.** The organisation's READY earnings are gathered into one payout batch, either by the Monday 20:00 UTC job or by someone with the `payouts.manage` permission (an Owner or a Billing admin) on Org › Payouts. The batch appears on Org › Payouts › Runs as "Awaiting approval".
2. **APPROVED (the two-person rule).** Someone with the `payouts.approve` permission (an Owner or a Billing admin) must approve the batch. The person who created a batch cannot approve it themselves while the organisation has a second person who can approve payouts. In an organisation with only one such person, that person approves their own batch by typing the organisation's slug, and the audit log records that it was a self-approval.
3. **Paid by the weekly run.** An approved batch shows as "Queued for the next run", the Monday 21:00 UTC run pays only APPROVED batches, and a PENDING batch keeps waiting until someone approves it.

A batch can be cancelled only before it is approved, and cancelling it returns its earnings to READY for a later batch. After approval a batch can only be paid, fail, or be reversed by the bank. A FAILED organisation payout is final, which means that payout row is never retried or cancelled. Its earnings return to READY when it fails, so a new batch, with its own approval, pays them instead.

## Going live

Real money does not leave the platform today, because the `ENABLE_LIVE_PAYOUTS` flag in `lib/feature-flags.ts` is off and the RazorpayX keys are not set in production. With the flag off, every step above still runs, including batching, approval, tax withholding and the ledger, but approved payouts stay APPROVED and are shown as "pending platform enablement" rather than as a failure.

Turning live payouts on is done in four steps, in this order, and the [live-payout go-live runbook](../../enterprise/50-operations/06-live-payout-go-live-runbook.md) holds the full checklist.

1. **Finish KYC.** Complete the RazorpayX account's KYC and business verification, and fund the RazorpayX balance to cover the first batch.
2. **Set the keys.** Set `RAZORPAYX_KEY_ID`, `RAZORPAYX_KEY_SECRET`, `RAZORPAYX_ACCOUNT_NUMBER` and `RAZORPAYX_WEBHOOK_SECRET` in the production environment. While the flag is on, the payout client refuses to start with a RazorpayX test key (`RAZORPAYX_TEST_KEYS_IN_LIVE_MODE`).
3. **Send one small test payout.** Prove the path end to end with one small payout to a verified account, and confirm that the `payout.processed` webhook arrives and the payout reaches COMPLETED.
4. **Turn on the flag.** Set `ENABLE_LIVE_PAYOUTS=true` in the production environment and redeploy, because the flag is read when the app starts and is not a runtime switch.
