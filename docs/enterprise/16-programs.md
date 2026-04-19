# Programs, assignments, and booking utilization

`Program` is the commercial primitive inside the enterprise layer.
Every sponsored booking **will be** attributed to a `ProgramAssignment`
(the per-member entitlement row), and every successful booking **will
leave** a `BookingUtilization` row + a `UsageLedgerEntry` twin.

> **Wiring status (as of this PR).** The schema, the server-side
> helpers (`recordBookingUtilization`, `claimProgramAssignment`,
> `reverseBookingUtilization`), and the management APIs under
> `/api/organizations/[orgId]/programs/**` are live. `lib/payments/
> operations/checkout.ts` still maps `BillingAccount.fundingSource` back
> into the legacy `SEAT_PACK / INVOICED_MONTHLY / PREPAID_UNLIMITED /
> TAG_ONLY` branches today — the live checkout path does **not** yet
> resolve a `ProgramAssignment` or write `BookingUtilization` /
> `PaymentLeg` rows. That wiring ships in the next stacked PR; the
> primitives documented below are ready to consume.

## Schema

```prisma
model Program {
  id   String @id @default(uuid())
  contractId String
  type       ProgramType     // LICENSED_SEAT | CREDIT_POOL | PROJECT (v2) | RETAINER (v2)
  name       String
  status     ProgramStatus @default(ACTIVE)
  coveredPlanTypes  CoveredPlanType[]
  allowedCategories String[]

  licensedSeatConfig LicensedSeatConfig?
  creditPoolConfig   CreditPoolConfig?
  customConfig       Json?

  assignments ProgramAssignment[]
  ...
}
```

The subtype is declared by `type`, and the corresponding config row is
one of two sibling tables. A `customConfig: Json` escape hatch exists
for bespoke enterprise splits that don't fit either typed subtype;
checkout defers to a custom resolver when that column is non-null.

## `LicensedSeatConfig`

```prisma
model LicensedSeatConfig {
  programId               String @id
  ratePerSeatPaise        Int
  cycle                   BillingCycle  // MONTHLY | QUARTERLY | ANNUAL
  coveredSessionsPerCycle Int?          // null = unlimited (LICENSE)
  overageBehavior         OverageBehavior @default(BLOCK)
  activeSeatCount         Int @default(0)
  priceCapPerSessionPaise Int?
}
```

- `coveredSessionsPerCycle = null` is the v1 "unlimited" marker — it
  is the new home for the pre-Arch-4 `PREPAID_UNLIMITED` billing mode.
  A LICENSE-funded org typically has exactly one LICENSED_SEAT Program
  with this column null.
- `priceCapPerSessionPaise` limits the grossAmount the program will
  absorb for a single booking. If a plan price exceeds the cap, the
  excess is treated as overage and routed according to
  `overageBehavior`.
- `activeSeatCount` is the aggregate across non-completed assignments.
  A follow-up cron reconciles drift nightly.

## `CreditPoolConfig`

```prisma
model CreditPoolConfig {
  programId               String @id
  creditValuePaise        Int
  premiumMultiplier       Decimal?
  minimumCreditsPerPeriod Int?
}
```

GLG-style per-minute credit pool: `creditValuePaise` is the paise
value of one credit; `premiumMultiplier` multiplies the credit cost
for premium tiers (e.g. 1.5x for high-demand experts).

The actual debits land on `BillingAccount.walletBalance` via
`walletDebit()` — the CreditPool Program is the *policy*, not the
storage.

## `ProgramAssignment`

```prisma
model ProgramAssignment {
  id           String @id @default(uuid())
  programId    String
  membershipId String

  periodStart DateTime
  periodEnd   DateTime

  sessionsUsed Int @default(0)
  overageCount Int @default(0)

  utilizations BookingUtilization[]

  @@unique([programId, membershipId, periodStart])
  @@index([membershipId, periodEnd])
}
```

One row per (Program, Membership, cycle). `claimProgramAssignment()`
in `lib/api/organizations/program-helpers.ts` upserts on the composite
unique, which makes the claim idempotent under concurrent bookings.

`sessionsUsed` is incremented atomically by Prisma's `{ increment }`
operator; a nightly cron will reconcile it against
`sum(UsageLedgerEntry.sessionsConsumed)` where the ledger is the
source of truth.

## `BookingUtilization`

```prisma
model BookingUtilization {
  id                  String @id @default(uuid())
  programAssignmentId String
  paymentId           String @unique
  sessionsConsumed    Int @default(1)
  priceAtBookingPaise Int
  wasOverage          Boolean @default(false)

  // Rate-card snapshot (ties to OrganizationEarnings for settlement).
  platformBpsAtBooking   Int?
  orgBpsAtBooking        Int?
  consultantBpsAtBooking Int?

  // Reversal marker. Row is never deleted.
  reversedAt     DateTime?
  reversalReason String?
  ...
}
```

The rate-card snapshot columns mirror the ones on
`OrganizationEarnings` (see `03-earnings-and-revenue.md`). Settlement
reconciliation compares these two snapshots to detect drift.

### Reversal (refund path)

`reverseBookingUtilization()` stamps `reversedAt = now()` and appends
an opposing `UsageLedgerEntry` with negative `sessionsConsumed`. The
row is never deleted because:

- Partial refunds may run more than once per booking — the original
  row is still needed.
- Point-in-time analytics ("who used seats on 2026-04-10?") must
  still find the row.
- Audit trail needs the original cap decision.

The `sessionsUsed` counter on the parent assignment is decremented at
the same time.

## `OverageBehavior`

| Value           | When a LICENSED_SEAT assignment exceeds cap                |
|-----------------|------------------------------------------------------------|
| `BLOCK`         | Checkout throws `ProgramAssignmentLimitError` → HTTP 402. |
| `CHARGE_MEMBER` | Booking proceeds. Learner pays the overage on their own card. `wasOverage = true`. |
| `CHARGE_ORG`    | Booking proceeds. Overage is attributed to the next `OrganizationInvoice` cycle. |

## API surface

| Route | Verbs | Role |
|-------|-------|------|
| `/api/organizations/[orgId]/programs` | `GET` | any active member |
| `/api/organizations/[orgId]/programs` | `POST` | MAINTAINER |
| `/api/organizations/[orgId]/programs/[programId]` | `GET` | any active member |
| `/api/organizations/[orgId]/programs/[programId]` | `PATCH`, `DELETE` | MAINTAINER |
| `/api/organizations/[orgId]/programs/[programId]/assignments` | `GET` | any active member |
| `/api/organizations/[orgId]/programs/[programId]/assignments` | `POST` | MAINTAINER |
| `/api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]` | `GET` | any active member |
| `/api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]` | `PATCH`, `DELETE` | MAINTAINER |

The POST body is a Zod `discriminatedUnion("type", [...])` so a
`LICENSED_SEAT` body with `creditPoolConfig` fails validation at the
edge, not at the FK layer. See
`app/api/organizations/[orgId]/programs/route.ts`.

## Related docs

- `02-funding-and-programs.md` — funding × program matrix.
- `03-earnings-and-revenue.md` — where the bps snapshots feed.
- `15-concurrency-and-locking.md` — upsert-based claim pattern.
- `18-three-ledger-discipline.md` — UsageLedgerEntry invariants.
