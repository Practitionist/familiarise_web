# Payout pipeline (host-side)

When a booking fires for an expert whose active EXPERT membership has
`payoutRecipient = ORGANIZATION`, or for any org with `canHost = true`
that captures its own share, an `OrganizationEarnings` row is written.
A weekly / monthly / quarterly cron rolls those earnings into an
`OrganizationPayout`.

## `OrganizationEarnings`

```prisma
model OrganizationEarnings {
  id             String @id @default(uuid())
  organizationId String
  paymentId      String
  grossAmountPaise     Int
  platformFeePaise     Int
  orgSharePaise        Int
  consultantSharePaise Int
  refundedAmountPaise  Int @default(0)
  currency             Currency @default(INR)

  // Rate-card snapshot at earnings creation.
  rateCardIdApplied    String?
  platformBpsApplied   Int?
  orgBpsApplied        Int?
  consultantBpsApplied Int?

  status    EarningStatus
  holdUntil DateTime?

  orgPayoutId String?
  orgPayout   OrganizationPayout? @relation(...)
  ...
}
```

Writes happen in the settlement path alongside `ConsultantEarnings` and
`PaymentLeg` rows. The `refundedAmountPaise` column is decremented by
the refund handler rather than the earnings row being deleted — an
earnings row is append-only.

## `EarningStatus`

| Value      | Transitions                                 |
|------------|---------------------------------------------|
| `PENDING`  | → `HELD` (cron moves past-hold), `REFUNDED` |
| `HELD`     | → `RELEASED`, `REFUNDED`                    |
| `RELEASED` | → `PAID`                                    |
| `PAID`     | terminal                                    |
| `REFUNDED` | terminal                                    |

`holdUntil` is the earliest instant at which earnings may roll into a
payout; it's typically `booking.completedAt + 3d` to cover dispute
windows.

## Payout roll-up

`POST /api/organizations/[orgId]/payouts`
(`app/api/organizations/[orgId]/payouts/route.ts`) rolls a
`periodStart..periodEnd` window of RELEASED earnings into a single
`OrganizationPayout`. OWNER only. The handler:

1. Selects all `OrganizationEarnings` rows for the org that are
   RELEASED and have `orgPayoutId IS NULL` within the window.
2. Sums `orgSharePaise` minus `refundedAmountPaise` across the
   selection.
3. Creates an `OrganizationPayout` with `status = PENDING`.
4. Updates each selected earnings row with `orgPayoutId = <new.id>`.
5. Emits an `OrgAuditLog` entry (`PAYOUT` category,
   `PAYOUT_INITIATED`).

A weekly cron rolls RELEASED earnings into payout batches; live
submission to RazorpayX is gated by `ENABLE_LIVE_PAYOUTS` and
implemented in `lib/payments/payouts/org-payout-service.ts` with
idempotency-key persistence. `PROCESSING → COMPLETED` requires the
webhook reconciler (PR-3 — currently admin can flip via the PATCH
handler).

## `OrganizationPayout` fields for India statutory

The model carries every statutory column the Indian payout pipeline
needs. TDS and MSME deadline are populated live by `createOrgPayoutBatch`
(see below); FEMA (Form 15CA/CB, FIRC) remains manual until the first
non-resident host org ships.

```prisma
tdsSectionApplied String?   // "194J" | "194O" | "194C"
tdsAmountPaise    Int?
mustPayByDate     DateTime? // derived from MSME 15/45-day rule
paRouteProvider   String?   // "RAZORPAYX" | "CASHFREE_PAYOUTS"
paReferenceId     String?
form15caPartCRef  String?
form15cbRef       String?
dtaaRateApplied   Decimal?
rbiPurposeCode    String?   // P0802 | P0807
fxRateUsed        Decimal?
firceRef          String?
```

### TDS

- TDS derivation is live in `lib/compliance/tds.ts:computeTdsForPayout`.
  Default is Section 194-O (1%) for ECO payouts (Familiarise is the
  e-commerce operator). Explicit overrides honoured: `ConsultantProfile.tdsSection`
  pivots between 194J / 194-O / 194C; `ConsultantProfile.tdsLowerRateCert`
  + `tdsRate` applies a Section 197 certificate rate.
- PAN fallback (Section 206AA): if `panNumber` is null or malformed
  (`/^[A-Z]{5}[0-9]{4}[A-Z]$/`), withhold at 20% punitive rate.
- For non-residents, DTAA rates from `lib/compliance/dtaa-rates.json`
  are applied only when strictly lower than the section default.
- `createOrgPayoutBatch` deducts `tdsAmountPaise` from the gross before
  gateway dispatch and persists `tdsSectionApplied`, `tdsAmountPaise`,
  `dtaaRateApplied`. Settlement ledger reflects the post-TDS amount.
- Form 26Q / 27Q quarterly returns are still on the backlog
  (`docs/compliance/15-india-compliance-shipping-checklist.md` §2.1).

### MSME 15/45-day rule

`Organization.msmeStatus` + `msmeWrittenAgreementOnFile` are read by
`createOrgPayoutBatch` and passed to `computeMsmePaymentDeadline`
(`lib/compliance/msme.ts`). MICRO + written agreement → 45 days;
MICRO/SMALL no agreement → 15 days; MEDIUM/NONE → `contract.paymentTermsDays`.
The MSME alert cron (`jobs/compliance/msme-payment-alerts.ts`, daily
04:30 UTC) sweeps overdue payouts.

### Cross-border (FEMA)

For non-resident experts (`ConsultantProfile.residencyStatus =
NON_RESIDENT`):

- `form15caPartCRef` + `form15cbRef` hold the CA-certified tax
  clearance references.
- `rbiPurposeCode` is `P0802` (computing services) or `P0807`
  (consultancy), read from the expert's profile.
- `dtaaRateApplied` overrides `194J` when a DTAA treaty applies.
- `fxRateUsed` + `firceRef` record the FX conversion and the FIRC
  reference when the bank issues one.

## `OrgPayoutAccount`

```prisma
model OrganizationPayoutAccount {
  id                     String @id @default(uuid())
  organizationId         String @unique
  accountHolderName      String
  accountNumberEncrypted String
  accountNumberLast4     String
  bankName               String
  ifscCode               String?
  routingNumber          String?
  swiftCode              String?

  stripeConnectId       String? @unique
  razorpayContactId     String? @unique
  razorpayFundAccountId String?

  status     OrgPayoutAccountStatus @default(PENDING_VERIFICATION)
  verifiedAt DateTime?
  ...
}
```

`PUT /api/organizations/[orgId]/payout-account` (OWNER only) creates or
replaces the row. The account number is encrypted at rest (column
`accountNumberEncrypted`); only the last-4 is kept plain-text for
display. Payout processing refuses to run against an account that
isn't `VERIFIED`.

## Payment attribution

`Payment.organizationId` carries the org that sponsored the payment;
`Payment.earningsOrgId` (read via the relation through
`OrganizationEarnings.paymentId`) is the hosting org for the booking.
The two are equal when a HYBRID org sponsors its own expert; they are
independent in every other case.

## Related docs

- `03-earnings-and-revenue.md` — rate-card bps snapshots that feed the
  earnings row.
- `06-expert-lifecycle.md` — how `payoutRecipient` determines whether
  an earnings row even exists.
- `18-three-ledger-discipline.md` — the Settlement ledger invariants.
- `docs/compliance/**` — the live source of truth on TDS / MSME / FEMA
  obligations across both rails. See in particular
  [`docs/compliance/01-tds-overview.md`](../compliance/01-tds-overview.md),
  [`docs/compliance/03-msme-43b-h.md`](../compliance/03-msme-43b-h.md), and
  [`docs/compliance/07-cross-border-flows.md`](../compliance/07-cross-border-flows.md).
