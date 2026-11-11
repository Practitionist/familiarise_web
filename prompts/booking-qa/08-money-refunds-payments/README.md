# 08-money-refunds-payments (MO-)

Money from the buyer's click to the expert's payout: what each checkout front door writes, holds and their expiry, cancel quotes against actual refunds on every rail, refund rows and their keys, credit notes and org documents, earnings and holds, the org-hosted split, refunds owed and their retries, gateway failures and webhook disorder, and whether the consultee Payments page and the consultant Earnings page agree with the database.

Journeys that create the money are owned by 03–07 (for example CO-01 books, CO-71 cancels at 100 %). Cases here reuse those bookings and assert the **money**; they don't re-run the journey.

| File | Cases | What |
| --- | --- | --- |
| [01-checkout-front-doors.md](01-checkout-front-doors.md) | MO-01 – MO-14 | Full money graph of a mock charge, mock flag off-local, subscription/webinar/class charges, approval and trial pay-link rows, zero-amount and credits, discount code and welcome discount as refund basis, tax split, lapsed hold, seat re-mint, totals vs charge |
| [02-cancel-quotes-and-rails.md](02-cancel-quotes-and-rails.md) | MO-15 – MO-28 | Preview contract and authz, exact 24 h / 2 h edges, unbound and credit-bound quotes, capture after an unpaid quote, prorated maths, seat and class-seat leave quotes, whole-event quote, rails (GATEWAY / INTERNAL / CREDITS), Wipro ledger reversal, IIT wallet and credit pool, frozen org ladder, expert full refund of a partly refunded booking, the refund across surfaces |
| [03-refund-rows-and-reconciliation.md](03-refund-rows-and-reconciliation.md) | MO-29 – MO-42 | Key per door, money invariants, cascade to earnings, admin refund door (partial, replay, over-refund), clamp after partial, no rows for free/credits, consumer credit notes, Wipro invoice rail, consultee Payments vs DB, failed-refund surfaces, Earnings vs DB, back-office views, class seat multi-door, overseas currency |
| [04-earnings-holds-org-split.md](04-earnings-holds-org-split.md) | MO-43 – MO-54 | LearnPro 10/10/80 split and its refund, Wipro booking earnings, release follows a reschedule, new-expert hold, trial earnings hold, holds while money moves, operator hold, co-host split, both sides' refund wording, free and credits earnings, totals after refunds |
| [05-refund-owed-gateway-webhooks.md](05-refund-owed-gateway-webhooks.md) | MO-55 – MO-70 | Marker lifecycle, dropped drive re-driven once, grace and backoff, definitive refusal ×3 and escalation, ambiguous PENDING owned by reconcile, ops visibility, gateway refusal on cancel, dispute block, duplicate and reordered webhooks, unknown-order adoption, capture after lapse, orphan healing, stuck auto-refund, checkout gateway failure, ledger and cleanup |

**Count:** 70 cases.

## Fixtures and personas

- 01 fixtures (F-AV1, F-PL1, F-PL2, F-PL3, F-BUSY). Bookings from CO-01, CO-07, CO-12, CO-17, CO-25, SU-23, WE-05/WE-19, CL-14/CL-27, TR-04.
- **IL — an IIT Madras learner** (not in `_shared` personas; needed for the WALLET / CREDIT_POOL rail, MO-25). Find one, then sign in with the seed default password:

  ```sql
  SELECT u.email, u.id, m.role, m.status FROM "Membership" m JOIN "users" u ON u.id = m."userId"
  JOIN "organizations" o ON o.id = m."organizationId"
  WHERE o.name = 'Indian Institute of Technology Madras' AND m.role = 'LEARNER' AND m.status = 'ACTIVE' LIMIT 3;
  ```

  If none exists, MO-25 is BLOCKED. Don't add memberships. (Adjust `role`/`status` literals to the enum if the query errors; record.)

## Folder queries (MQ)

```sql
-- MQ-1 legs, journal and invoice for one payment
SELECT l.source, l."amountPaise", l."sourceRef" FROM "PaymentLeg" l WHERE l."paymentId" = :pid;
SELECT "idempotencyKey", kind, "createdAt" FROM "LedgerTransaction" WHERE "idempotencyKey" IN ('booking:' || :pid) OR "idempotencyKey" LIKE 'refund:%' AND "createdAt" > :runStart ORDER BY "createdAt";
SELECT "invoiceNumber", "taxableValuePaise", "cgstPaise", "sgstPaise", "igstPaise", "totalPaise", "buyerStateCode", "needsBuyerAddress" FROM "ConsumerInvoice" WHERE "paymentId" = :pid;

-- MQ-2 credit notes for one payment
SELECT n."creditNoteNumber", n."refundId", n."totalPaise", n."cgstPaise", n."sgstPaise", n."igstPaise"
FROM "ConsumerCreditNote" n JOIN "ConsumerInvoice" i ON i.id = n."consumerInvoiceId" WHERE i."paymentId" = :pid;

-- MQ-3 org money for one payment
SELECT "organizationId", "hostOrganizationId", "billingAccountId", "paymentIntent", "billableToOrgInvoiceId" FROM "Payment" WHERE id = :pid;
SELECT "organizationId", "grossAmountPaise", "platformFeePaise", "orgSharePaise", "consultantSharePaise", "refundedAmountPaise",
       "platformBpsApplied", "orgBpsApplied", "consultantBpsApplied", status, "holdUntil" FROM "OrganizationEarnings" WHERE "paymentId" = :pid;

-- MQ-4 refund-owed state for one payment
SELECT "refundOwedKey", "refundOwedPaise", "refundOwedReason", "refundOwedAt", "refundOwedAttempts", "refundOwedNextAt", description FROM "Payment" WHERE id = :pid;

-- MQ-5 holds on one payment's earnings
SELECT h.reason, h."sourceRef", h."placedAt", h."releasedAt", h.note, e.status, e."preDisputeStatus"
FROM "EarningsHold" h JOIN "ConsultantEarnings" e ON e.id = h."consultantEarningsId" WHERE e."paymentId" = :pid;
```

If a column in MQ-1 (`LedgerTransaction.kind`, `PaymentLeg.amountPaise`) doesn't exist, drop it and record; the ids and keys are what matter.

## Standard money cross-check

For every case that moves money, check and record each surface:

1. consultee Payments `/dashboard/consultee/[consulteeId]/payments` and the row's detail page;
2. consultee appointment detail (refund line) and bell; outgoing mail subject in `NotificationOutbox`;
3. consultant Earnings `/dashboard/consultant/[cid]/earnings` (Summary and Activity);
4. org surfaces when org-funded or org-hosted (OS billing/spend, OH compensation, IIT billing);
5. staff `/dashboard/staff/payments/[paymentId]` and Money → Refunds;
6. DB: R-04, the invariants in `_shared/sql-recipes.md`, MQ as needed.

## Run order and environment

- After 03–07 have produced their bookings. 01 → 02 → 03 → 04 → 05. Within a file, cases are ordered to share bookings.
- **Local only (`[local]`):** Mock Pay exists only in `next dev` (`isMockPayment` is honoured only when `NODE_ENV=development`). Approval pay links and trial pay links have **no** mock path; paying them needs Razorpay test mode or an owner-run webhook replay.
- **Webhook cases (MO-63…MO-68):** BLOCKED (no gateway) on a preview; locally they need test keys, the webhook secret and the owner to sign and post deliveries.
- **Sweeps:** NEEDS-OWNER-RUN off production. Owner command shape: `curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cleanup/<slug>?limit=50`. See [12's README](../12-sweeps-background-jobs/README.md) for slugs and the shared-database caveat.
- **QA-ONLY emulations** (MO-38, MO-49, MO-56–MO-59, MO-65, MO-66) write money columns on QA mock rows only, with owner approval, and are reverted at MO-70.

## Salvaged from `prompts/booking-algorithm-tests/`

| Old | New |
| --- | --- |
| 010 Phase 1 (quote = charge, one refund per payment) | MO-17, MO-29, MO-30 (journey: CO-71) |
| 010 Phase 2 (preview authz 403 / 401 / 404) | MO-15 |
| 010 Phase 3 (whole-event quote: paid seats, sum, rail null) | MO-22 |
| 010 Phase 4 (rails: `org_` INTERNAL, `free_` CREDITS, no gateway on org) | MO-23, MO-24 |
| 010 Phase 5 (`?orgScope=`) | CC-63 (authz, folder 09) |
| 016 Phase 2 (stale quote, unbound old client) | MO-17 (bound-quote 409 is CO-75) |
| 018 Phases 1–3 (duplicate / reordered webhooks, pre-mint adoption, wrong amount, unknown order) | MO-63, MO-64, MO-65 |
| 018 Phases 4–5 (abandoned sweep scope, sweep vs capture) | SW-02, CC-12; late-capture money MO-66 |
| 019 Phases 1–5 (marker happy path, dropped drive, grace, key shapes, definitive ×3, ambiguous PENDING) | MO-55, MO-56, MO-57, MO-29, MO-58, MO-59 |
| 020 money parts (return moves no money; no-show refund `consultant-no-show:`) | SU-68 (return), MO-29 key table, SW-21 |
| 013 Phase 7 (seat re-buy after lapse, `PAYMENT_ALREADY_EXISTS`) | MO-13 |
| 008 Phase 2.3 (one refund, one clawback, one journal after re-drives) | MO-30 invariants; the freeze itself is CC-67 – CC-70 and SW-33 |
