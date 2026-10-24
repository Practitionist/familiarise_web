# Razorpay (fees as a cost line)

Razorpay has no quota to exhaust; it charges a fee on every transaction, so model it as unit cost, not capacity. The fee schedule is account-specific and is not in the repo (unknown); read it in the Razorpay dashboard, Account and Settings, and do not hard-code a percentage.

- Per-transaction fees apply to successful captures; GST is added to the fee. The booking price is derived in `lib/payments/pricing/`; fees are the platform's cost, not the buyer's, unless the pricing code adds them.
- Refunds: the original fee is generally not returned to the merchant on a refund (INFERRED from Razorpay policy; confirm in the dashboard), so every refund is a net cost. Cancellation policy changes (more refunds, earlier refunds) change margin; price them before shipping.
- RazorpayX payouts carry their own per-payout fee (`lib/payments/payouts/`, issue notes record that these fees are public). A payout batching change that increases payout count increases cost.
- Auto-debit for subscriptions follows RBI e-mandate rules; the repo bills subscriptions in-house with per-cycle orders, not Razorpay's subscription API.
- Monitor with the opt-in Razorpay MCP (see `finance/references/verification.md`): `fetch_all_settlements`, `fetch_settlement_recon_details` (fees and tax per settlement), `fetch_all_refunds`, `fetch_all_payouts`. The ledger is the repo's source of truth for money; see the `finance` skill for verification.
