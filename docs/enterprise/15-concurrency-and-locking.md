# Concurrency and locking

The enterprise layer uses Prisma transactions plus a small set of
conditional raw-SQL UPDATEs for its hottest atomic mutations. No Redis
locks — enterprise operations are point mutations on known rows, and
Redis adds latency with no benefit. Redis is still used by the booking
allocation surface because slot discovery spans many queries; the
enterprise primitives don't.

## Wallet debit (conditional UPDATE)

`lib/api/organizations/wallet.ts#walletDebit`

```sql
UPDATE "BillingAccount"
SET "walletBalance" = "walletBalance" - :amountPaise
WHERE "id" = :billingAccountId
  AND "walletBalance" IS NOT NULL
  AND "walletBalance" >= :amountPaise
```

The `WHERE walletBalance >= :amountPaise` clause is the lock. Postgres
takes a row-level write lock on the billing account for the duration
of the UPDATE, and two concurrent calls cannot both satisfy the
predicate. Zero rows updated → `WalletInsufficientFundsError`.

The helper runs inside a Prisma transaction together with the ledger
write; any downstream failure (e.g. WalletEntry insert) rolls back the
balance decrement.

## Program assignment claim (upsert on composite unique)

`lib/api/organizations/program-helpers.ts#claimProgramAssignment`

```ts
tx.programAssignment.upsert({
  where: {
    programId_membershipId_periodStart: {
      programId, membershipId, periodStart,
    },
  },
  create: { ... },
  update: {},
});
```

The composite unique `@@unique([programId, membershipId, periodStart])`
on `ProgramAssignment` is the lock. Two concurrent calls for the same
member in the same period converge on the same row. Postgres resolves
the race at constraint-check time with `ON CONFLICT DO NOTHING`
semantics courtesy of Prisma's upsert.

## Booking utilization (engagementsUsed + ledger in lock-step)

`lib/api/organizations/program-helpers.ts#recordBookingUtilization`

Single transaction:

1. `findUniqueOrThrow` the assignment with
   `LicensedSeatConfig.coveredEngagementsPerCycle` joined.
2. Check `assignment.engagementsUsed + consumed > cap`. If over cap and
   `overageBehavior = BLOCK`, throw `ProgramAssignmentLimitError`.
3. `programAssignment.update({ engagementsUsed: { increment: consumed } })`
   — Prisma emits the atomic increment as `engagementsUsed = engagementsUsed
   + :n`, which Postgres serialises.
4. `bookingUtilization.create(...)` — the row.
5. `usageLedgerEntry.create(...)` — the ledger twin.

The cap check is not technically safe under Serializable concurrency
(two transactions could both read `engagementsUsed = cap - 1` and both
write `cap`). In practice the incremental UPDATE in step 3 makes step
2 eventually consistent — the first transaction wins, the second
writes `engagementsUsed = cap + 1` and marks `wasOverage = true`. For the
`BLOCK` case the overage flag causes the downstream cron to reverse
the second utilization; no money was debited because the checkout
path refuses when `wasOverage && overageBehavior === BLOCK`. A
follow-up PR converts the cap check into a conditional UPDATE to
close the window without relying on compensating actions.

## Rate-card bump (two-step inside one transaction)

`lib/api/organizations/rate-card.ts#bumpRateCard`

```ts
const current = await findEffective(tx, scope, at);
if (current) {
  await tx.rateCard.update({ where: { id: current.id }, data: { effectiveTo: at } });
}
return tx.rateCard.create({ data: { ...scope, effectiveFrom: at, effectiveTo: null } });
```

Runs inside a caller-supplied transaction. Two concurrent bumps on
the same scope race to set `effectiveTo` on the current card and
insert a new one; the winner owns both mutations, the loser sees
`effectiveTo` already set and either restarts or accepts an overlap.
The scope's `(ownerOrgId | ownerContractId) + planType + planId +
effectiveFrom` is not a unique constraint, so overlaps are possible
in the degenerate two-bumps-at-the-same-instant case. The impact is
read-time: `findEffective` returns the first card ordered by
`effectiveFrom DESC`, so the winner's row wins lookups. Impact on
money flow: none — earnings already-created carry bps snapshots.

## Top-up idempotency (unique providerOrderId)

`WalletEntry.providerOrderId @unique` is the idempotency key for top-
ups. A second `initiateTopUp()` call with the same provider order id
raises a P2002 error; the POST handler catches and returns
`{ reused: true }` with the existing row.

Webhook confirmations are idempotent by marker:

- Placeholder `WalletEntry` has `deltaPaise = 0`.
- `confirmTopUp()` reads, checks for non-zero delta (= already
  confirmed), and exits early on retry.

## Domain-claim uniqueness

`OrgDomainClaim.domain @unique` (global). Concurrent POSTs from two
different orgs for the same domain resolve into a P2002 at the first
commit. The second handler maps the error to a 409.

## `OrgAuditLog` writes

Audit rows are append-only and don't contend with each other. Every
write is a single `.create()` call inside the same transaction as
the business-logic write — so a failed business operation doesn't
leave a phantom audit row, and an audit-row failure rolls back the
operation it documents.

## No Redis, no advisory locks

The layer intentionally avoids:

- **Redis locks** — enterprise mutations are row-scoped, not slot-
  discovery operations. Adding a Redis hop would double the write
  latency for zero safety gain.
- **Postgres advisory locks** (`pg_advisory_lock`) — out of scope for
  the transactional surface. If a new primitive needs them
  (e.g. a long-running import), this doc will be updated.
- **Serializable isolation** — Prisma transactions default to Read
  Committed. The hot paths rely on conditional UPDATEs + composite
  unique constraints + immutable ledger rows rather than upgrading
  the isolation level.

## Related docs

- `09-wallet-and-ledger.md` — wallet debit / credit specifics.
- `16-programs.md` — program-assignment claim flow.
- `03-earnings-and-revenue.md` — rate-card bump semantics.
- `18-three-ledger-discipline.md` — ledger immutability invariants.
