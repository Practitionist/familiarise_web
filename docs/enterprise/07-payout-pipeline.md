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

A cron that processes PENDING payouts (calls Razorpay Payouts /
Cashfree Payouts) is stubbed in v1 — see the harness verdict. The
current API response marks the row as "ready for manual processing"
and the admin flips it to `PROCESSED` via the PATCH handler.

## `OrganizationPayout` fields for India statutory

The model already carries every statutory column the Indian payout
pipeline needs; population is stubbed but the fields are authoritative:

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

- `ConsultantTaxInfo` + `ConsultantProfile.tdsSection` drive the TDS
  section per expert. Org-side payouts default to `194J` (professional
  services) unless `ConsultantProfile.tdsLowerRateCert` is populated
  (Section 197 cert reference, rare).
- The withheld amount is stored in `tdsAmountPaise` and filed against
  the org's PAN. A follow-up cron emits quarterly `TDSRecord` rows.

### MSME 15/45-day rule

When an expert has `ConsultantProfile.msmeStatus != NONE` and
`writtenAgreementWithFamiliarise = true`, payment must land within 15
days (no written agreement → 45 days) of the invoice date. The cron
sets `mustPayByDate` accordingly; breaches are flagged on the admin
payouts dashboard.

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
