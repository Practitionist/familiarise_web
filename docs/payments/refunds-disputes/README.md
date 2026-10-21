# Refunds, service complaints and chargebacks

The active gateway is Razorpay with INR settlement. Booking refunds use
`refundBookingPayment`: gateway, organization-funded and credit-funded bookings
share the same front door while returning value through their original funding
rail. Staff can inspect money; admin executes financial remedies.

## Service complaint to refund

A customer files a `SupportCase` linked to the booking/payment. Staff investigate
and collect private expert/host evidence. A structured recommendation records the
payment, paise and reason. Admin reviews the current refundable balance and
approves or declines. Approval uses a stable recommendation key on the existing
refund operation; the reservation links the `Refund` in the same transaction.

The gateway call happens outside the reservation transaction. A capture/refund
webhook or reconciliation adopts provider truth, then runs the existing ledger,
earnings reversal and tax credit-note cascade. A webhook binding race transfers
the recommendation before retiring its placeholder refund. Repeated requests
cannot duplicate the financial effect.

Gateway processing, settled refund state and actual bank arrival are distinct.
The dashboard shows the known state and provider reference, not an unsupported
promise that a gateway acceptance means the bank already credited the buyer.
Credit-funded bookings restore their credits in full and send no cash refund.

## Issuing-bank chargebacks

`Dispute` records are gateway chargebacks, not customer support complaints.
Their provider reference, `dueBy`, status and evidence workflow remain separate
from a linked case. Admin accepts/contests through the existing Razorpay action;
staff investigate and supply context. Assignment is audited and concurrency
controlled. The provider's deadline governs evidence submission.

Live disputes retain automatic earnings holds and refund/payout guards. Admin
can independently apply a service-case payment hold to eligible unpaid earnings.
Releasing that hold does not release a bank dispute or refund reservation.
Completed or in-flight transfers cannot be recalled merely by recording a hold.

Organization views derive scope from actual sponsorship billing and host
revenue. A payment's reporting tag alone neither grants financial visibility nor
establishes who bears a chargeback loss. Counts and disputed amounts are computed
server-side across the complete filtered result, independently of pagination.

## Engineering references

- [Support architecture](../../support/10-production-architecture.md)
- [Financial architecture](../05-high-level-design.md)
- [Organization refund accounting](../../enterprise/10-money-and-ledger/10-refunds.md)
- [Organization payout pipeline](../../enterprise/10-money-and-ledger/07-payout-pipeline.md)

Money retains conditional state updates, Serializable reservations, cumulative
refund caps, the single capture writer, integer paise and immutable balanced
ledger postings. Database constraints are not duplicated by application sweeps.
Tax treatment and legal commercial-model classifications remain unchanged.

## Deprecated & Superseded Approaches

Stripe and webhook-only Razorpay evidence descriptions in older references are
superseded by the Razorpay-only implementation. Internal service complaints do
not use gateway dispute statuses. A universal refund-arrival promise and totals
computed from the latest page are superseded by provider-specific guidance and
server-side aggregates.
