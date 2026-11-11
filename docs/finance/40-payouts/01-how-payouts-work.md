---
title: How payouts work
type: explanation
audience: new engineers, the owner, support and finance operators
status: live
last-reviewed: 2026-11-11
---

# How payouts work

This page explains, in plain language, how money that a session earns reaches the expert or the host organisation that hosted it. Read it before the detailed pages: [earnings lifecycle](02-earnings-lifecycle.md) for the status machine and holds, [consultant payouts](03-consultant-payouts.md) for the batch, approval and disbursement rules, [RazorpayX](04-razorpayx.md) for the bank rail, [organisation payouts and clawbacks](05-org-payouts-and-clawbacks.md) for the organisation side, and [TDS withholding](06-tds-withholding.md) for the tax taken out.

Two ideas hold everything together. First, an earning is a promise, not money in the bank. It moves through a hold period and a series of states before any rupee leaves. Second, the platform pays by batch: it collects everything an expert is owed into one payout row, an approver or a rule lets it through, and a separate step sends it to the bank. A person can always tell where an expert's money is by reading one status.

Payouts go to Indian-resident experts and organisations only, in rupees. A non-resident expert cannot be paid: the eligibility check answers `NON_INDIA`, and the disbursement step refuses a non-resident row (`payoutEligibilityReason`, `lib/payments/payouts/payout-requirements.ts`).

## From a session to an earning

When a learner's payment is confirmed, the platform keeps its fee and records the expert's share as an earning. The fee is the marketplace rate of the latest approved `PlatformFeeSchedule`, with 20 percent as the fallback when no schedule is approved, and a platform-granted fee waiver (`ConsultantFeeWaiver`) can zero it for a set number of sessions. For example, Priya pays ₹5,000 (500,000 paise) before GST for a one-hour consultation with Hannah. At a 20 percent fee the platform fee is 100,000 paise and Hannah's earning is 400,000 paise (₹4,000).

## An expert's money, step by step

1. **PENDING, the hold.** The earning waits out a hold so that a cancellation, a refund or a no-show can still be handled before money leaves. The hold is 48 hours after a consultation, which covers the 48-hour window in which a buyer can raise a scope claim, 24 hours after a class, 48 hours after a webinar and 7 days for a subscription, counted from the later of the capture and the end of the last live session (`computeHoldUntil`, `lib/payments/payouts/earnings-hold.ts`). A new expert waits 3 days longer, while their first earning is under 30 days old or their lifetime share after refunds is under ₹10,000 (`withNewExpertHold`). Each value is a `PAYOUT_CONSTANTS` field, and the hold is stamped when the earning is created, so changing a constant never moves an existing earning.
2. **HELD, a freeze.** An earning is HELD while at least one hold is active on it. A hold has a reason: a chargeback on the payment, a ban of the expert, an operator's decision, an unpaid member overage, or a service complaint that staff froze. Each owner releases only its own hold. The [earnings lifecycle](02-earnings-lifecycle.md) lists the rules.
3. **READY.** Once the hold has passed and the payment has no open refund and owes none (no owed-refund marker), the `release-earnings` job marks the earning READY. It runs every 15 minutes on the ticker.
4. **BATCHED, Monday night.** On Mondays from 20:00 UTC, which is 01:30 IST on Tuesday, for three hours, the `create-payout-batch` job runs in small slices. It gathers each expert's READY earnings into one payout if the total is at least ₹250 (`MINIMUM_PAYOUT_AMOUNT`). The earnings become BATCHED, which means promised to that payout but not yet sent. An expert who owes the platform more than ₹10,000 of clawback is skipped until the debt comes down, and an expert whose default payout account is less than 48 hours old or frozen is skipped.
5. **Approval.** A payout below ₹5,000 is approved automatically. A payout of ₹5,000 or more waits for a platform administrator, who approves or rejects it with a reason. While the platform has more than one administrator, the administrator who created a payout cannot approve it, and the one who approved it cannot trigger its disbursement by hand.
6. **Sent, hourly.** The `process-payouts` job runs every hour. It takes an APPROVED payout, works out the TDS to withhold, and sends the remainder to the bank through RazorpayX. The payout becomes PROCESSING.
7. **The outcome.** COMPLETED means the bank confirmed the transfer, and the earnings become PAID. FAILED means the bank definitively refused it, and the earnings return to READY so the next Monday batch picks them up. REVERSED means the bank returned money it had already confirmed, and the earnings reopen as READY.

An expert who does not want to wait for Monday can use **Get paid now** on the Earnings page. It pays out the expert's READY earnings at once, free of charge, at most once per India day. An instant payout of ₹5,000 or less is approved and sent immediately. A larger one joins the administrator approval queue (`INSTANT_PAYOUT_AUTO_APPROVE_PAISE`, `lib/payments/payouts/constants.ts`).

**Worked example.** Hannah has three READY earnings of 400,000 paise each, from three ₹5,000 sessions with different learners. On Monday 2026-10-19 at 20:05 UTC (Tuesday 2026-10-20 at 01:35 IST) the batch job totals 1,200,000 paise (₹12,000). That is above the ₹250 minimum and above ₹5,000, so the payout is created PENDING and Hannah's three earnings become BATCHED. An administrator approves it on Tuesday at 11:00 IST. At the next hourly run, 12:00 IST, `process-payouts` checks the dispute and refund gates, plans the TDS, finds that Hannah's year-to-date gross is well under ₹5,00,000 and so withholds nothing, and sends 1,200,000 paise to her verified bank account by IMPS. When RazorpayX reports `payout.processed`, the payout is COMPLETED and the three earnings are PAID.

When the bank's answer never arrives, for example because the request timed out, the payout is never marked FAILED on a guess, because the money might already have left and a second payout would pay the expert twice. It stays PROCESSING, and the `handle-stuck-payouts` and `reconcile-payout-status` jobs ask RazorpayX about it: by the stored RazorpayX payout id when the row has one, and, for a row whose reply was lost before that id was saved, `handle-stuck-payouts` looks it up with the platform's own payout id as the reference. [Consultant payouts](03-consultant-payouts.md) describes how each outcome is handled.

## A host organisation's money

An organisation that hosts sessions earns its share into an organisation earning, and its payouts follow a stricter approval rule.

1. **PENDING.** The organisation's READY earnings are gathered into one payout, either by the Monday ticker job or by a person with the `payouts.manage` permission (an Owner or a Billing admin) on the organisation's payouts page.
2. **APPROVED, the two-person rule.** Someone with `payouts.approve` (also an Owner or a Billing admin) must approve it. The person who created the batch cannot approve it while the organisation has a second person who can. In an organisation with only one such person, that person approves their own batch by typing the organisation's slug, and the audit log records the self-approval.
3. **A platform administrator may also have to co-approve.** If the payout is above ₹50,000, or was created within seven days of the organisation changing its payout account, the organisation's approval leaves it PENDING until an administrator co-approves it. The administrator cannot be the person who created or approved it at the organisation. An administrator can also place a hold on a PENDING or APPROVED payout, and the payout run skips a held payout.
4. **Paid by the hourly run.** The same `process-payouts` run sends only APPROVED, un-held organisation payouts.

A payout can be cancelled only while PENDING, and cancelling returns its earnings to READY. After approval it can only be paid, fail or be reversed by the bank. A FAILED organisation payout is final: its earnings return to READY, and a new batch with its own approval pays them.

## Changing a payout account

When an expert or an organisation makes a new account the default, the platform emails the payee a notice with a link to a confirm page. The new account cannot be paid for 48 hours. If the change was not the payee's, the payee can freeze payouts from that page, and only a platform administrator can lift the freeze. A payee's very first account is exempt, but only while no money has accrued. Each payout records the account it was created for and is sent only there, so changing the default afterwards does not redirect an existing payout. For an organisation, a payout whose account changed after it was created is failed and its earnings are batched again.

## What switches live disbursement

Whether real money leaves is controlled by the `ENABLE_LIVE_PAYOUTS` flag (`lib/feature-flags.ts`), which is read when the app starts. When the flag is off, every step up to approval still runs: earnings are released, batches are created, administrators approve, and the TDS plan waits until disbursement, so no TDS record exists yet. Approved payouts simply wait as APPROVED, the hourly run returns without sending, an instant payout is refused with `PAYOUTS_DISABLED`, and the Earnings page says the money is reserved until payouts begin. Turning the flag on needs the RazorpayX credentials and a static-egress proxy, because live RazorpayX accepts calls only from allowlisted IP addresses and the hosting platform has no static address. The [go-live checklist](../70-operations/07-go-live-checklist.md) holds the steps.

## Rules and their enforcers

| Rule                                                          | Enforcer                                                                                                             | Test                                                        | Repair                                           |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------ |
| A batched earning always points at a payout                   | `consultant_earnings_batched_has_payout` and `org_earnings_batched_has_payout` in `prisma/sql/check-constraints.sql` | none (database constraint)                                  | None needed; the write is refused                |
| A payout moves status only from the expected prior status     | Conditional `updateMany` in the payout service (CAS in WHERE)                                                        | `__tests__/enterprise/payout-approval-cas.test.ts`          | Re-read the row and retry                        |
| An uncertain gateway answer never fails a payout              | `isDefinitiveGatewayRejection` in `lib/payments/payouts/razorpay-payouts.ts`                                         | `__tests__/enterprise/process-payouts-false-failed.test.ts` | The stuck-payout job asks RazorpayX by reference |
| A changed payout account waits 48 hours before it can be paid | `payoutAccountHold` (`PAYOUT_ACCOUNT_COOLING_OFF`) in `lib/payments/payouts/payout-requirements.ts`                  | `__tests__/enterprise/payout-eligibility-reason.test.ts`    | None needed; the hold expires by itself          |
| A payee-frozen payout account cannot be paid                  | `payoutAccountHold` (`PAYOUT_ACCOUNT_FROZEN`) in `lib/payments/payouts/payout-requirements.ts`                       | `__tests__/enterprise/payout-eligibility-reason.test.ts`    | An administrator lifts the freeze                |
| Disbursement waits behind the live flag                       | `ENABLE_LIVE_PAYOUTS` checked in `processApprovedPayouts` and `processOrgPayout`                                     | `__tests__/payments/process-payouts-flag-off.test.ts`       | Turn the flag on at go-live                      |

## Where in code

- `lib/payments/payouts/payout-service.ts` — the consultant rail.
- `lib/payments/payouts/org-payout-service.ts` — the organisation rail.
- `lib/payments/payouts/scheduled-runs.ts` — `runCreatePayoutBatches` and `runProcessPayouts`, the two ticker entry points.
- `lib/payments/payouts/payout-account-change.ts` — the cooling-off and freeze links.
- `lib/payments/payouts/constants.ts` — `PAYOUT_CONSTANTS`.

## Related

- [Money map](../00-overview/01-money-map.md)
- [Scheduled jobs](../70-operations/01-scheduled-jobs.md)
- [Admin money doors](../70-operations/02-admin-money-doors.md)

## Deprecated & Superseded Approaches

- **Stripe Connect transfers** for experts paid abroad. Stripe was removed and non-resident experts are not paid at all, so any code or text that routes an expert through Stripe is dead.
- **An instant-payout auto-approve limit of ₹25,000.** The instant limit is `INSTANT_PAYOUT_AUTO_APPROVE_PAISE`, which an environment variable of the same name can override and which otherwise defaults to the batch threshold `PAYOUT_CONSTANTS.AUTO_APPROVE_THRESHOLD` (₹5,000, 500,000 paise). Text that says ₹25,000 is wrong.
- **RTGS as a payout mode.** The code selects only UPI, IMPS and NEFT.
- **Marking a payout FAILED when the gateway call times out.** That released the earnings into the next batch, which then paid twice. The current rule keeps the payout PROCESSING until the bank is asked.
