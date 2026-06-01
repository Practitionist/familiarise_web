# Concurrency & idempotency

**What this covers:** the atomic patterns that keep enterprise mutations correct under concurrency, and the idempotency keys that let every side-effect survive a duplicate call. (Merges the former concurrency-and-locking + idempotency-keys docs.)

> The layer uses Prisma transactions + a few conditional raw-SQL `UPDATE`s for its hottest mutations — **no Redis locks** (those are point mutations on known rows; Redis would add latency for no safety gain). Money idempotency is anchored by `LedgerTransaction.idempotencyKey @unique` and a handful of other unique constraints.

---

# Part 1 — Concurrency & locking

## Wallet debit (conditional UPDATE)
`lib/api/organizations/wallet.ts#walletDebit`
```sql
UPDATE "BillingAccount"
SET "walletBalance" = "walletBalance" - :amountPaise
WHERE "id" = :billingAccountId
  AND "walletBalance" IS NOT NULL
  AND "walletBalance" >= :amountPaise
```
The `>= :amountPaise` predicate **is** the lock: Postgres takes a row-level write lock for the UPDATE, so two concurrent debits can't both satisfy it. Zero rows updated → `WalletInsufficientFundsError`. This moves only the **cache** ([money model §4](06-money-model-overview.md)); the authoritative `Dr WALLET` leg posts later inside the `booking:<paymentId>` transaction, where the full split is known. Both run in the same Prisma transaction as the rest of checkout, so any downstream failure rolls back the decrement.

## Program-assignment claim (upsert on composite unique)
`lib/api/organizations/program-helpers.ts#claimProgramAssignment` — `@@unique([programId, membershipId, periodStart])` is the lock; two concurrent claims for the same member+period converge on one row via upsert (`ON CONFLICT DO NOTHING` semantics).

## Booking utilization (counter + usage ledger in lock-step)
`recordBookingUtilization` — one transaction: read the assignment + `coveredEngagementsPerCycle`; check cap (throw `ProgramAssignmentLimitError` if over and `overageBehavior = BLOCK`); `increment` `engagementsUsed` (atomic `= engagementsUsed + :n`); create `BookingUtilization` + its `UsageLedgerEntry` twin. The cap read isn't Serializable-safe, but the atomic increment makes it eventually consistent — the second over-cap booking writes `wasOverage = true`, and either checkout refuses (`BLOCK`) or the overage path bills it. A follow-up converts the cap check to a conditional UPDATE. The reconciler's `PROGRAM_ASSIGNMENT_ENGAGEMENTS_DRIFT` is the backstop ([ledger integrity](14-ledger-integrity.md)).

## Rate-card bump (two-step in one transaction)
`bumpRateCard` — close the current card (`effectiveTo = at`) and insert a new one (`effectiveFrom = at`) in one tx. A degenerate same-instant race can overlap, but `findEffective` orders by `effectiveFrom DESC` so the winner's row wins lookups; money impact is nil because earnings already carry bps snapshots ([booking → earnings](10-booking-to-earnings.md)).

## PO balance (atomic compare-and-swap)
`updateMany WHERE status='ACTIVE' AND remainingAmountPaise >= amount` decrements in one statement; two POSTs racing for the last ₹1 can't both win ([invoicing §6](12-invoicing.md)).

## Domain-claim uniqueness
`OrgDomainClaim.domain @unique` (global) — concurrent claims from two orgs resolve to `P2002`; the loser maps it to a 409.

## `OrgAuditLog` writes
Append-only, single `.create()` inside the business transaction — a failed operation leaves no phantom audit row, and an audit failure rolls back the operation it documents.

## What the layer avoids
- **Redis locks** — row-scoped mutations don't need slot-discovery locking.
- **Postgres advisory locks** — out of scope for the transactional surface.
- **Serializable isolation** — hot paths rely on conditional UPDATEs + unique constraints + immutable ledger rows instead of raising the isolation level.

---

# Part 2 — Idempotency keys

**The rule: every side-effect entry point derives an idempotency key from immutable request content** — never a client-supplied key (replay-attack vector), never `Date.now()/random` (defeats dedupe).

## The money journal — `LedgerTransaction.idempotencyKey`
Every cash event posts through `postLedgerTxn`, which is idempotent on a **structured, unique** key. A repeat is a no-op (`{ created: false }`); a racing duplicate hits the `@unique` `P2002`, aborts its tx, and the retry lands on the fast-path ([ledger & postings §2](08-ledger-and-postings.md)).

| Flow | Key |
|---|---|
| top-up | `topup:<providerOrderId>` |
| booking | `booking:<paymentId>` |
| invoice paid | `invoicepaid:<invoiceId>` |
| top-up refund | `topup-refund:<providerPaymentId>` |
| booking refund | `refund:<refundId>` |
| consultant payout | `payout:<payoutId>` |
| host-org payout | `orgpayout:<payoutId>` |

## Webhooks
| Source | Key | Storage |
|---|---|---|
| Razorpay / Stripe | `event.id` (vendor) | `WebhookEvent.id` (permanent) |
| fallback | `sha256(raw_body)` | `WebhookEvent.id` |

Deterministic body-hash fallback (not `Date.now()+random`) makes replays truly idempotent.

## Payment orders & top-ups
| Operation | Key | Collision handling |
|---|---|---|
| Wallet top-up | `providerOrderId` (mint on create-order) | `P2002` on `WalletTopUp.providerOrderId` unique → POST returns the existing row |
| Invoice payment | `razorpay_order_id` | `P2002` on `OrganizationInvoice.providerPaymentOrderId` |
| One-time / day-pass checkout | `razorpay_order_id` | same |

The server never accepts a client-supplied key — it reuses the `razorpay_order_id` it minted. Top-up confirmation is doubly idempotent: the `WalletTopUp` claim is `updateMany WHERE status='PENDING'` (exactly one delivery wins) **and** the `topup:` ledger key dedupes the posting ([wallet & top-ups](09-wallet-and-topups.md)).

## Invoices
Subscription cron computes `invoiceNumber` from `subscriptionId + billingCycleIndex`; the atomic claim (`updateMany WHERE nextInvoiceDate <= now`) prevents double-invocation, and `OrganizationInvoice.invoiceNumber @unique` rejects any second insert (`P2002` → logged `subs.invoice.skipped`).

## Payment legs
`PaymentLeg.sourceRef` carries the per-source key: `CARD` → gateway payment id; `REFERRAL_CREDIT` → `referralCreditUsageId`; `INVOICE_ACCRUAL`/`LICENSE` → `programAssignmentId`. `@@unique([paymentId, source])` blocks duplicate-source legs ([payment legs](13-payment-legs.md)).

## Emails (Resend)
`X-Entity-Ref-ID` from `orgId + mustPayByDate` (MSME alert) / `invoiceId` (receipt) / `organizationId + ssoProviderId` (SSO activation) — Resend dedupes automatically.

---

## Anti-patterns
- ❌ **Client-supplied idempotency keys for money** — a chosen collision forces a replayed success. Derive from immutable content.
- ❌ **`Date.now() + Math.random()` fallback** — replays aren't deduped; explicitly removed from webhook handlers.
- ❌ **Keys in the URL path** — caches/CDN may dedupe on path; keep keys in the body.
- ❌ **"Merge the duplicate later"** — a duplicate ledger posting double-counts a balance (balances are sums). Reject at write time with the `@unique` `P2002`; never reconcile two rows after the fact.

## Testing idempotency
Every money-touching path has a replay test: run the happy path, retry the identical request, assert **zero** additional mutations.
```ts
it("is idempotent on replay", async () => {
  const before = await prisma.ledgerTransaction.count();
  await handler(req);
  const afterFirst = await prisma.ledgerTransaction.count();
  await handler(req); // same req, same signature
  const afterSecond = await prisma.ledgerTransaction.count();
  expect(afterFirst - before).toBe(1);
  expect(afterSecond - afterFirst).toBe(0); // no new posting
});
```

---

### Related docs
- [Wallet & top-ups](09-wallet-and-topups.md) — the debit/credit + top-up idempotency specifics.
- [Ledger & postings](08-ledger-and-postings.md) — `postLedgerTxn` idempotency.
- [Programs](21-programs.md) — the assignment-claim flow.
- [Booking → earnings](10-booking-to-earnings.md) — rate-card bump semantics.
- [Ledger integrity](14-ledger-integrity.md) — the drift checks that backstop these guards.
