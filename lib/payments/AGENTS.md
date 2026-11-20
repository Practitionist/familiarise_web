# Payments & Money

Applies to `lib/payments/`. The root `AGENTS.md` still applies (BigInt paise, CAS-in-WHERE status transitions, `tx` inside `$transaction`).

1. **One confirmation path for gateway card captures**: only `handlePaymentSuccess` (`lib/payments/webhooks/handlers.ts`) confirms them, reached from the webhook, client verify, the reconcile sweep, the admin recover door and Request again's post-commit re-check (`lib/booking/request-again.ts`).
2. **The only other `SUCCEEDED` writers** are the no-gateway rails, the overage side-payments and the standalone sales (replays and digital products): `payment-row.ts`, `overage-handlers.ts`, `overage-settlement.ts`, `recording-purchase.ts`, `digital-product-purchase.ts` and their shared auto-refund stamp in `standalone-sale-capture.ts` (full list in `docs/start-here/02-money-system-hld.md` §1).
3. **Playbook**: `.claude/skills/finance/SKILL.md`.
