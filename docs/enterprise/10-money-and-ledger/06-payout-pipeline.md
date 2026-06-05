---
title: Payout pipeline (host-side)
band: 10-money-and-ledger
audience: sde3
status: partial
last-reviewed: 2026-06-05
---

# Payout pipeline (host-side)

**What this covers:** how host-org earnings roll up into an `OrganizationPayout`, the `ORG_PAYOUT` ledger posting that settles the payable, and the India statutory fields (TDS / MSME / FEMA) the payout carries. The consultant-side payout (`PAYOUT`) is the mirror; the split that creates earnings is in [booking → earnings](05-booking-to-earnings.md).

> When a booking settles for a `canHost` org (or an EXPERT membership with `payoutRecipient = ORGANIZATION`), an `OrganizationEarnings` row accrues. A weekly/monthly/quarterly cron rolls `READY` earnings into one `OrganizationPayout`; when the gateway confirms, an `ORG_PAYOUT` transaction draws the org's `ORG_PAYABLE` down to match the cash that left.

---

## 1. `OrganizationEarnings` → `OrganizationPayout`

`OrganizationEarnings` is append-only (refunds **decrement** `refundedAmountPaise`, never delete) and carries the bps snapshot ([booking → earnings §4](05-booking-to-earnings.md)). Each row moves through `EarningStatus`:

```mermaid
stateDiagram-v2
  [*] --> PENDING: settled (org verified)
  [*] --> PENDING_TRUST: settled (org PENDING_VERIFICATION, INVOICE-funded)
  PENDING_TRUST --> PENDING: org ACTIVE or first invoice paid (#687 fraud guard)
  PENDING --> HELD: dispute window
  PENDING --> READY: hold elapsed
  HELD --> READY: dispute cleared
  READY --> PAID: rolled into a payout, gateway confirmed
  PENDING --> REFUNDED
  HELD --> REFUNDED
  READY --> REFUNDED
  PAID --> [*]
  REFUNDED --> [*]
```

`PENDING_TRUST` is the invoice-fraud guard (#687): earnings accrued for a still-unverified INVOICE-funded org are parked until the org goes `ACTIVE` or pays its first invoice — so an unverified org can't accrue real consultant earnings and ghost. `holdUntil` (≈ `completedAt + 3d`) gates `PENDING → READY` to cover dispute windows.

**Roll-up** (`POST /api/organizations/[orgId]/payouts`, OWNER only):
1. Select `READY` earnings for the org with `orgPayoutId IS NULL` in `[periodStart, periodEnd]`.
2. Sum `orgSharePaise − refundedAmountPaise`.
3. Create `OrganizationPayout(status = PENDING)`.
4. Stamp each earnings row with `orgPayoutId`.
5. Emit `OrgAuditLog(PAYOUT, PAYOUT_INITIATED)`.

A weekly cron does the same in batch (`createOrgPayoutBatch`, `lib/payments/payouts/org-payout-service.ts`); live submission to RazorpayX is gated by `ENABLE_LIVE_PAYOUTS` with idempotency-key persistence.

### 1.1 Worked walkthrough — LearnPro's weekly batch with TDS

**LearnPro Academy** (the seeded HOST org, `OrganizationPayoutAccount` `VERIFIED`, PAN on file via `taxInfo.panEncrypted`) hosts five panel experts. Say the week's `READY` `OrganizationEarnings` sum to an org pool of **₹40,000** (`orgSharePaise = 4_000_000`) with no refunds. The weekly cron's `createOrgPayoutBatch` does the math (`org-payout-service.ts:365`):

```
netPayout       = orgShareSum − refundsSum   = 4_000_000 − 0 = 4_000_000 paise
TDS section     = 194-O          (DEFAULT_SECTION for ECO payouts to host orgs)
TDS rate        = 0.001          (0.1% — Finance (No.2) Act 2024, w.e.f. 1-Oct-2024)
tdsAmountPaise  = floor(4_000_000 × 0.001) = floor(4_000.0) = 4_000   (₹40 withheld)
amountAfterTds  = 4_000_000 − 4_000 = 3_996_000               (₹39,960 wired)
```

So LearnPro is *owed* ₹40,000, the platform withholds **₹40** TDS (deposited with the government, reported on Form 26Q), and **₹39,960** is what goes through the gateway. The `ORG_PAYOUT` posting on `PROCESSING → COMPLETED` is `Dr ORG_PAYABLE(learnpro) 4_000_000 / Cr CASH 3_996_000 + Cr TDS_PAYABLE 4_000` — note the debit clears the **full** ₹40,000 payable (net + TDS), because the org's obligation is discharged whether the cash went to LearnPro or to the taxman. The TDS section defaults to **194-O at 0.1%** because Familiarise is the e-commerce operator (ECO); a non-resident host would instead carry a DTAA rate and the FEMA fields in §3.

> For a payee with **no PAN on file**, the 194-O no-PAN carve-out withholds **5%** (`NO_PAN_RATE_194O`) instead of 0.1% — on this pool that's ₹2,000, 50× the ₹40 with-PAN figure. That rate cliff is exactly what the `7f7e7d12` war story below was about: the code passed the *encrypted ciphertext* as the PAN, it failed format validation, and the engine over-withheld 50× even when a PAN *was* on file (as LearnPro's is).

---

## 2. `PayoutStatus` + the `ORG_PAYOUT` posting

```mermaid
stateDiagram-v2
  [*] --> PENDING: roll-up
  PENDING --> APPROVED: admin/cron approves
  APPROVED --> PROCESSING: submitted to gateway
  PROCESSING --> COMPLETED: webhook confirms (posts ORG_PAYOUT)
  PROCESSING --> FAILED: gateway rejects (earnings → READY)
  PROCESSING --> CANCELLED: manual
  COMPLETED --> [*]
  FAILED --> [*]
  CANCELLED --> [*]
```

On `PROCESSING → COMPLETED` the service posts the settlement (`orgpayout:<payoutId>`, kind `ORG_PAYOUT`):

```
Dr ORG_PAYABLE(org)   net + TDS         (clear what we owed the org)
   Cr CASH(platform)  net paid
   Cr TDS_PAYABLE     TDS withheld      (only if > 0)
```

```mermaid
sequenceDiagram
  autonumber
  participant CR as Payout cron
  participant DB as Postgres (tx)
  participant GW as RazorpayX
  participant WH as Payout webhook
  participant L as Ledger
  CR->>DB: createOrgPayoutBatch — claim READY earnings, compute TDS/MSME
  CR->>GW: submit transfer (idempotencyKey persisted)
  GW-->>WH: payout processed
  WH->>DB: status PROCESSING → COMPLETED
  WH->>L: postLedgerTxn(orgpayout:<id>) — Dr ORG_PAYABLE / Cr CASH + TDS_PAYABLE
```

The **consultant** payout is the mirror — `payout:<payoutId>`, kind `PAYOUT`: `Dr CONSULTANT_PAYABLE / Cr CASH + TDS_PAYABLE` (`lib/payments/payouts/payout-service.ts`). On `FAILED`/`CANCELLED`, earnings are unlinked (`orgPayoutId = null`, back to `READY`) and provisional TDS records deleted. The reconciler asserts `sum(orgShare − refunded) == netPayoutPaise` (`ORG_PAYOUT_TOTAL_MISMATCH`, [ledger integrity](09-ledger-integrity.md)).

> 🔒 **`ENABLE_LIVE_PAYOUTS` is still off.** The whole pipeline runs — batching, TDS/MSME, the status machine, the ledger posting — but **gateway submission is held**, so payouts sit at `PROCESSING` (surfaced in the UI as "pending platform enablement", never as a failure). The `ORG_PAYOUT`/`PAYOUT` ledger leg posts only on the real `PROCESSING → COMPLETED` webhook, so no cash-leaving entry exists until go-live. See [feature flags](../30-programs-and-lifecycle/06-feature-flags-and-rollout.md) and the [live-payout go-live runbook](../50-operations/06-live-payout-go-live-runbook.md).

---

## 3. India statutory fields on `OrganizationPayout`

The model carries every column the Indian payout needs; TDS + MSME deadline are populated live, FEMA (15CA/CB, FIRC) is manual until the first non-resident host org ships.

```prisma
tdsSectionApplied String?   // "194J" | "194O" | "194C"
tdsAmountPaise    Int?
mustPayByDate     DateTime? // MSME 15/45-day rule
paRouteProvider   String?   // "RAZORPAYX" | "CASHFREE_PAYOUTS"
paReferenceId     String?
form15caPartCRef  String?
form15cbRef       String?
dtaaRateApplied   Decimal?
rbiPurposeCode    String?   // P0802 | P0807
fxRateUsed        Decimal?
firceRef          String?
```

- **TDS** — `computeTdsForPayout` (`lib/compliance/tds.ts`). Default section **194-O** for ECO payouts (Familiarise is the e-commerce operator); `ConsultantProfile.tdsSection` overrides to 194J/194C; a Section 197 cert applies `tdsLowerRateCert` + rate; PAN fallback withholds punitively (**194-O carries its own 5% no-PAN rate** — *not* the 20% of Section 206AA, which applies to 194J/194C). DTAA rates apply to non-residents only when strictly lower than the section default. `createOrgPayoutBatch` deducts TDS before dispatch; the `ORG_PAYOUT` posting's `Cr TDS_PAYABLE` records the withheld amount. Form 26Q/27Q export is backlog, and the refund-driven `TdsAdjustment` reversal is **schema-only — not yet written by any code** (#778 §E/§F; see [invoicing §8](07-invoicing.md)). **For the current rate, defer to [`../compliance/01-tds-overview.md`](../../compliance/01-tds-overview.md)** — the compliance docs are authoritative on rates.
  > 🟡 **Income-tax Act 2025 (effective 1-Apr-2026).** The code and `tdsSectionApplied` still store the **1961-Act** section labels (`194J`/`194O`/`194C`). Under the new Income-tax Act, 2025 the TDS sections (192–194T) are consolidated — non-salary TDS folds into **Section 393** (salary into 392) and quarterly returns/challans now key off numeric payment codes rather than the old `194x` numbers, which trigger validation errors on filings for payments on/after 1-Apr-2026. The withholding math is unchanged; only the section *citation* used at filing time is renumbered. Treat every `194x` label in this band as "needs a 2025-Act mapping before the next 26Q/27Q export" — tracked in the compliance band, not yet reflected in `tds.ts`.
- **MSME 15/45-day** — `computeMsmePaymentDeadline` (`lib/compliance/msme.ts`) from `OrganizationMsmeInfo`: MICRO + written agreement → 45d; MICRO/SMALL no agreement → 15d; MEDIUM/NONE → `contract.paymentTermsDays`. Daily overdue sweep: `jobs/compliance/msme-payment-alerts.ts`.
- **Cross-border (FEMA)** — for `NON_RESIDENT` experts: `form15caPartCRef`/`form15cbRef` (CA tax clearance), `rbiPurposeCode` (P0802 computing / P0807 consultancy), `dtaaRateApplied`, `fxRateUsed` + `firceRef`.

---

## 4. `OrganizationPayoutAccount`

`PUT /api/organizations/[orgId]/payout-account` (OWNER) creates/replaces the row. `accountNumberEncrypted` is AES-GCM at rest; only `accountNumberLast4` is plain for display. Holds `stripeConnectId` / `razorpayContactId` / `razorpayFundAccountId`. Payout processing refuses any account not `VERIFIED` (`OrgPayoutAccountStatus`).

## 5. Payment attribution

`Payment.organizationId` is the **sponsoring** org; the **hosting** org is reached via `OrganizationEarnings.paymentId`. They coincide when a HYBRID org sponsors its own expert; independent otherwise. Post-A3, one payment can carry multiple `OrganizationEarnings` (one per collaborator HOST org) — see [booking → earnings §4](05-booking-to-earnings.md).

---

## 6. Design decisions & trade-offs

- **Weekly batch + `idempotencyKey` dedup, not per-earning payout.** Each `READY` earning *could* fire its own transfer the moment its hold elapses, but that means N gateway calls, N TDS computations, and N rows per consultant per week — and TDS thresholds/section logic want the *aggregate*. So the cron rolls a period's `READY` earnings into **one** `OrganizationPayout`, computes TDS once on the pool, and submits one transfer. The dedup is `OrganizationPayout.idempotencyKey @unique`: two overlapping cron workers racing the same period both build a batch, but the loser's insert hits `P2002` and falls through to return the sibling's already-created row (`org-payout-service.ts:456`) — so a cron retry or a replica can't double-pay. The cost is up-to-a-week of settlement latency; the benefit is one auditable payout per period and no N-way gateway fan-out.
- **`PENDING_TRUST` parks earnings for unverified INVOICE-funded orgs (#687).** An org that's still `PENDING_VERIFICATION` and funds by INVOICE could otherwise accrue real consultant earnings and vanish before paying its first invoice. So those earnings sit in `PENDING_TRUST` until the org goes `ACTIVE` or pays once — the rejected alternative (accrue straight to `PENDING`) trades a fraud hole for a little less state. See §1's state diagram.
- **The flag freezes submission, not the pipeline.** With `ENABLE_LIVE_PAYOUTS` off, batching + TDS/MSME + the status machine + the (eventual) ledger posting all run; only the gateway call is held. That keeps the whole path exercised in staging/seed and makes go-live a flag flip, not a code path that's never been run. The cost is rows sitting at `PROCESSING` that an operator must read as "held," not "stuck" — hence the explicit "pending platform enablement" UI copy (§2). The alternative — short-circuit the whole pipeline behind the flag — would mean the first real payout runs untested code.

### 🛠️ What this design survived

- **A false-FAILed payout the gateway had already accepted → double disbursement (`8a924d41`, #785 task #24).** `process-payouts`' catch block marked a payout `PROCESSING → FAILED` and **unlinked its earnings** (back to `READY`) on *any* throw — including a DB write that threw *after* RazorpayX/Stripe had already accepted the transfer. The released earnings would then re-batch under a **fresh `idempotencyKey` the gateway won't dedupe** → the same money paid twice. The fix hoists `providerPayoutId` above the `try` (`process-payouts.ts:163`) so the catch can tell a **pre-gateway** failure (no provider id yet — safe to FAIL + release) from a **post-gateway** one (provider id set — money already sent): the latter persists the gateway id and leaves the row `PROCESSING` with earnings *linked* (so `create-payout-batch`'s `payoutId: null` filter can't re-batch them), and `jobs/payouts/handle-stuck-payouts.ts` reconciles it against the gateway. The flag was off, so no prod money was double-paid — this was caught in end-to-end testing before go-live.
- **TDS over-withholding 50× because the PAN was encrypted (`7f7e7d12`, #785).** Both payout services passed `OrganizationTaxInfo.panEncrypted` *ciphertext* straight into `computeTdsForPayout` as `panNumber`. The ciphertext failed `isValidPan()`'s `[A-Z]{5}[0-9]{4}[A-Z]` regex, so the engine hit the **194-O no-PAN fallback (5%)** instead of the with-PAN **0.1%** — withholding 50× too much from every host-org payout that had a PAN safely on file. The fix added `panOnFile: boolean` to `TdsConsultantInput`: callers now pass `panNumber: null, panOnFile: !!taxInfo.panEncrypted` (`org-payout-service.ts:374`), so "a PAN exists" is signalled without trying to format-check ciphertext that can't be validated until decrypt-at-filing-time. This is why §1.1's with-PAN figure is ₹40, not ₹2,000.

---

### Related docs
- [Booking → earnings](05-booking-to-earnings.md) — the rate-card bps snapshot that feeds the earnings row.
- [Ledger & postings](03-ledger-and-postings.md) — the `ORG_PAYOUT` / `PAYOUT` transactions.
- [Ledger integrity](09-ledger-integrity.md) — `ORG_PAYOUT_TOTAL_MISMATCH`.
- [Expert lifecycle](../30-programs-and-lifecycle/03-expert-lifecycle.md) — how `payoutRecipient` decides whether an earnings row exists.
- [Compliance map](../40-compliance-and-data/01-compliance-dpdp-gst-tds-msme.md) → [`../compliance/`](../../compliance/00-overview.md) — authoritative TDS/MSME/FEMA rules.
