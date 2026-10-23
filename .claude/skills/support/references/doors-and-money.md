# Support doors and money

Rules for any support change that moves money or freezes earnings. Human reference: `docs/support/05-money-remedies.md`.

## Door map

| Action / route                                                                | Door                                              | Surface                          | Ops-log action                    | Extra gates                                                                                                                                  |
| ----------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `RECOMMEND_REFUND`                                                            | none (`performCaseAction`)                        | `tickets.manage`                 | none                              | One open recommendation per payment (app + `support_recommendation_one_open_per_payment`).                                                   |
| `REVIEW_REFUND`                                                               | `reviewSupportRefundDoor`                         | `supportRefunds.executeBounded`  | `support.refund.review`           | `assertMoneyOpsBudget`, `assertMoneyDoorsOpen` (approve), `lockStaffRefunds`, `assertBoundedRefund`, `assertNotOwnRemedy`, `secondApprover`. |
| `VOID_RECOMMENDATION`                                                         | `voidSupportRecommendationDoor`                   | `refunds.manage` (ADMIN)         | `support.recommendation.void`     | Refund FAILED/CANCELLED, or none and older than `SUPPORT_REFUND_SEND_GRACE_MS` (15 min).                                                     |
| `APPLY_HOLD` / `RELEASE_HOLD`                                                 | `applySupportHoldDoor` / `releaseSupportHoldDoor` | `supportHolds.manage`            | `support.hold.apply` / `.release` | `assertMoneyDoorsOpen`; PROCESSING payout refuses (`PAYOUT_IN_FLIGHT`).                                                                      |
| Resolve or close a case that holds a payment                                  | `executePatchLifecycleTx`                         | `tickets.manage`                 | `support.case.release-holds`      | `holdReleaseRefusalTx`: no open recommendation, fresh session, money doors open.                                                             |
| `POST /api/staff/appointments/[appointmentId]/cancel`                         | `withOpsAction`                                   | `appointments.cancelForPlatform` | `appointment.cancel.platform`     | Budget, money doors, staff lock, `platformCancelCharges` + `assertBoundedRefund`. No second approver.                                        |
| `POST /api/staff/appointments/[appointmentId]/reschedule` (reschedule branch) | `withOpsAction`                                   | `appointments.manage`            | `appointment.reschedule.platform` | `assertBookingDoorsOpen`. No money moves.                                                                                                    |

All doors: step-up (15 min), reason 5–1,000 chars, one `OpsActionLog` row, `correlationId` `support-case:<caseId>` where a case exists.

## Numbers (grep before changing)

- `STAFF_REFUND_PER_PAYMENT_PAISE = 500_000` (₹5,000), `STAFF_REFUND_ROLLING_PAISE = 5_000_000` (₹50,000), `STAFF_REFUND_ROLLING_WINDOW_MS` 24 h, lock TTL 120 s — `lib/support/money-policy.ts` (limits move to `lib/support/staff-refund-limits.ts` on the reschedule branch).
- `SECOND_APPROVAL_THRESHOLD_PAISE = 2_500_000` (₹25,000), needs two or more active admins; `PROPOSAL_TTL_MS` 24 h — `lib/backoffice/ops-proposals.ts`.
- `BOUNDED_REFUND_ACTIONS` = `support.refund.review`, `appointment.cancel.platform`; the rolling cap sums `after.movedPaise` from these rows.
- Escalation for refund exposure at ≥ 50,000 paise (₹500) — `decideEscalation()` in `lib/support/escalation.ts`.

## Rules

- Per-payment `priorPaise` = `committedSupportPaiseByPayment()`: live non-remedy refunds + approved, unvoided remedies. Any new refund door that STAFF can use must price with it and call `assertBoundedRefund()`, then log `movedPaise`.
- The review claim is a compare-and-set on `decidedAt IS NULL`, guarded by `expectedRefundablePaise`, not by the case `updatedAt`. Keep it that way so second-admin replays survive case activity.
- Refunds go through `refundBookingPayment()` with `dedupeKey: case-recommendation:<id>`, `supportRecommendationId`, `keepSeat: !releaseSeat`, and no amount for `free_` payments. Never call the gateway directly.
- A live chargeback (status outside `DISPUTE_INACTIVE_FOR_GATING`) blocks support refunds (`REFUND_BLOCKED_BY_DISPUTE`). Do not add a bypass.
- `REFUND_APPROVED` decisions need a PENDING or SUCCEEDED refund under an approved recommendation; `REFUND_DECLINED` needs none approved.
- Holds: `EarningsHold` reason `SUPPORT_CASE`, `sourceRef = caseId`. Intent lives in `HOLD_APPLIED`/`HOLD_RELEASED` events (`toValue` = paymentId). New earnings on a held payment are frozen by `applyCaseHoldsToNewEarnings()`; keep that call in `lib/payments/payouts/earnings-service.ts`.
- Money doors close in any maintenance phase other than OFF (`assertMoneyDoorsOpen()`); intake stays open.
