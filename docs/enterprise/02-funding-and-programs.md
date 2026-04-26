# Funding sources and programs

Sponsor-side orgs (`canSponsor=true`) attach exactly one `BillingAccount`
row. The account carries a `fundingSource` enum that controls how
sessions are paid for. Most commercial variations (seat caps, overage
behaviour, session rollover) live one layer below, on `Program` rows
hanging off `Contract`s.

## `FundingSource` enum (schema.prisma)

```prisma
enum FundingSource {
  PERSONAL   // learner pays own card; Payment.organizationId tagged only
  LICENSE    // flat enterprise license (was PREPAID_UNLIMITED)
  WALLET     // credit pool (was SEAT_PACK)
  INVOICE    // NET-X postpaid (was INVOICED_MONTHLY)
  PROJECT    // v2 reserved
}
```

Labels and taglines come from `FUNDING_SOURCE_LABEL` and
`FUNDING_SOURCE_TAGLINE` in `lib/labels/org-labels.ts`.

## Mapping from the old billing modes

| Old `OrgBillingMode`    | New `FundingSource` | Notes |
|-------------------------|---------------------|-------|
| `TAG_ONLY`              | `PERSONAL`          | Members pay at checkout; the org is attribution-only. |
| `SEAT_PACK`             | `WALLET`            | Credits live as paise on `BillingAccount.walletBalance`. |
| `INVOICED_MONTHLY`      | `INVOICE`           | Roll-up invoice at month-end; `PaymentLeg.source=INVOICE_ACCRUAL`. |
| `PREPAID_UNLIMITED`     | `LICENSE`           | Flat fee contract; `coveredEngagementsPerCycle=null` on the LICENSED_SEAT Program. |
| _(not previously modelled)_ | `PROJECT`       | Per-engagement fixed-fee or hourly billing. v2-reserved; not exposed in the self-service wizard (see `SelfServiceFundingSourceSchema` in `lib/labels/org-labels.ts`). |

## Funding-source matrix

| FundingSource | Wallet column | Credit limit column | Per-booking leg (`PaymentLeg.source`) | Invoice rhythm |
|---------------|---------------|---------------------|---------------------------------------|----------------|
| `PERSONAL`    | `null`        | `null`              | `CARD` (on the learner's card)        | None |
| `WALLET`      | `Int` paise (balance) | `null`      | `WALLET` (debit from balance)         | None |
| `INVOICE`     | `null`        | `Int` paise (optional, `null` = unlimited) | `INVOICE_ACCRUAL` (rolled up) | Cron rolls `Payment`s into one `OrganizationInvoice` at month-end |
| `LICENSE`     | `null`        | `null`              | `LICENSE` (no money moves; Program absorbs it) | None (flat fee already paid) |
| `PROJECT`     | `null`        | `null`              | _(v2)_ | _(v2)_ |

Pre-launch verified: the "unmetered" experience of a LICENSE org is not
a separate funding model — it's a `LICENSED_SEAT` Program with
`coveredEngagementsPerCycle = null`. The old PREPAID_UNLIMITED enum value
pretended the two were distinct; they are not.

## Programs layer

A `Contract` holds commercial terms. A `Program` sits under the contract
and defines the per-booking rules. Two subtypes ship in v1, and two are
enum-reserved for v2:

```prisma
enum ProgramType {
  LICENSED_SEAT   // seat cap per cycle (was SEAT_PACK + PREPAID_UNLIMITED)
  CREDIT_POOL     // credit cap per cycle (1 credit = ₹1)
  PROJECT         // v2 reserved
  RETAINER        // v2 reserved
}
```

Each subtype has its own config table:

```prisma
model LicensedSeatConfig {
  programId               String @id
  ratePerSeatPaise        Int
  cycle                   BillingCycle       // MONTHLY | QUARTERLY | ANNUAL
  coveredEngagementsPerCycle Int?               // null = unlimited (LICENSE)
  overageBehavior         OverageBehavior    // BLOCK | CHARGE_MEMBER | CHARGE_ORG
  activeSeatCount         Int @default(0)
  priceCapPerEngagementPaise Int?
}

model CreditPoolConfig {
  programId               String @id
  cycle                   BillingCycle       // when does the pool reset?
  creditsPerCycle         Int                // hard cap (1 credit = ₹1)
  minimumCreditsPerPeriod Int?               // optional commitment minimum
}
```

`CREDIT_POOL` was simplified post-Arch-4: 1 credit is fixed at ₹1
(100 paise). The dormant `premiumMultiplier` field was dropped and
`creditValuePaise` was retired in favor of the fixed mapping —
finance, audit, and reconciliation all read in rupees end-to-end with
no translation layer. Per-tier rate adjustments live on a Program
rate-card override rather than as JSON escape hatches.

## `OverageBehavior`

Drives what happens when a `LICENSED_SEAT` program hits its per-cycle
cap mid-session:

| Value           | Behaviour                                                                 |
|-----------------|---------------------------------------------------------------------------|
| `BLOCK`         | Checkout returns 402. `ProgramAssignmentLimitError` in `lib/api/organizations/program-helpers.ts`. |
| `CHARGE_MEMBER` | Learner pays the overage on their own card. Recorded as `wasOverage=true` on the `BookingUtilization`. |
| `CHARGE_ORG`    | Overage is rolled into the next `OrganizationInvoice` cycle (INVOICE funding). |

## `CoveredPlanType`

`Program.coveredPlanTypes: CoveredPlanType[]` enumerates which product
lines a Program applies to. Values: `CONSULTATION`, `CLASS`, `WEBINAR`,
`SUBSCRIPTION`. An empty array means "any plan type" (wildcard).

## `BillingCycle` and `BillingSubscription`

When a Program sits on a subscription billing cadence, a single
`BillingSubscription` row hangs off the Contract and tracks:

- `cycle`: `MONTHLY | QUARTERLY | ANNUAL`
- `ratePerSeatPaise` or `flatFeePaise` (mutually exclusive via the
  subtype)
- `activeSeatCount` (aggregated across programs)
- `currentCycleStart`, `currentCycleEnd`, `nextInvoiceDate`

The cron that walks active subscriptions and emits invoices is stubbed
in v1 (see `19-harness-verdict.md`). Hand-rolled
`POST /api/organizations/[orgId]/billing-account/invoices` takes the
slack.

## Related docs

- `09-wallet-and-ledger.md` — wallet top-ups, debits, refunds.
- `10-invoicing.md` — invoice generation, GST, PO 3-way match.
- `16-programs.md` — deeper dive into Program / ProgramAssignment /
  BookingUtilization.
- `20-payment-legs.md` — the `PaymentLeg` model that carries
  per-source breakdown of every payment.
