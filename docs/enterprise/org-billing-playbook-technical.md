# Enterprise Org Billing Playbook — Technical Reference

> **Audience:** CTO / Founder / Engineering  
> **Branch:** `feature/enterprise-1b`  
> **Last updated:** April 2026

This document covers every supported combination of **org kind** × **billing mode**, including setup steps, relevant schema fields, API routes, checkout behaviour, webhook flows, and cron job dependencies.

---

## 1. Taxonomy Refresher

### 1.1 Org Kinds

| Kind | Direction of Money | When to use |
|---|---|---|
| `BUYER` | Org **pays** the platform for sessions | Corp buys consulting for its employees / students |
| `PROVIDER` | Org **earns** from the platform | Coaching firm lists its own consultants on the marketplace |
| `HYBRID` | Both directions simultaneously | EdTech company with internal mentors AND learner employees |

### 1.2 Billing Modes (BUYER / HYBRID only — PROVIDER always `NULL`)

| Mode | Mental model | Payment timing |
|---|---|---|
| `TAG_ONLY` | Org-tagged learners pay at standard individual rates; org gets reports | Per session, learner's own wallet/card |
| `SEAT_PACK` | Org pre-buys a credit pool; learners draw ₹0 at checkout | Upfront batch purchases |
| `INVOICED_MONTHLY` | Sessions accrue to a monthly invoice; org pays NET-30 | Monthly, deferred |
| `PREPAID_UNLIMITED` | Flat license fee for a contract window; all sessions ₹0 during period | Lump sum upfront (offline) |

### 1.3 Feature Flag

All `PROVIDER` and `HYBRID` org kinds, plus associated roles (`ORG_CONSULTANT`, `ORG_LEARNER`) and PROVIDER-specific routes, are gated by:

```ts
// lib/feature-flags.ts
ENABLE_PROVIDER_ORGS = process.env.NEXT_PUBLIC_ENABLE_PROVIDER_ORGS === "true"
```

Routes return `{ error: "...", flag: "ENABLE_PROVIDER_ORGS" }` with `501` when the flag is off.

---

## 2. Combination 1 — BUYER + TAG_ONLY

### Use case
Large enterprise that wants **HR-level visibility** into which employees are booking sessions and with whom — no financial subsidy, employees pay their own way.

### Setup steps

**Step 1 — Create org**
```
POST /api/organizations
{
  "name": "Acme Corp",
  "type": "BUYER",
  "billingMode": "TAG_ONLY"
}
```

**Step 2 — Invite employees as ORG_LEARNER**
```
POST /api/organizations/{orgId}/invitations
{ "email": "alice@acme.com", "role": "ORG_LEARNER" }
```

**Step 3 — (Optional) Configure credit limit for reporting threshold**
```
PATCH /api/organizations/{orgId}
{ "orgInvoiceCreditLimit": 50000000 }  // ₹5L ceiling before checkout blocks — optional safety
```

### Schema fields used
```prisma
OrganizationProfile {
  orgKind            OrgKind           // BUYER
  billingMode        BillingMode?      // TAG_ONLY
  orgInvoiceCreditLimit Int?           // optional spend cap
}
```

### Checkout behaviour
- `deductCredits()` is **not** called (no credit pool)
- `orgBillingMode === TAG_ONLY` → payment flows through learner's own payment method at full listed price
- Booking is tagged `organizationProfileId` on the `Appointment` row for reporting

### Revenue split
Standard platform split (no org revenue share). Platform collects full commission from the consultant's listed price.

### Cron / webhook dependencies
- No enterprise-specific crons needed
- Standard `payment.captured` / `order.paid` webhook applies

### When NOT to use
If the org wants to subsidise even partially → use SEAT_PACK or INVOICED_MONTHLY.

---

## 3. Combination 2 — BUYER + SEAT_PACK

### Use case
Company pre-buys a credit bundle (e.g., ₹2L worth of consulting hours) and distributes them to employees. Employees book at ₹0 — the org pool is debited invisibly.

### Setup steps

**Step 1 — Create org**
```
POST /api/organizations
{
  "name": "TechCorp Learning",
  "type": "BUYER",
  "billingMode": "SEAT_PACK"
}
```

**Step 2 — Buy credits (org owner initiates Razorpay order)**
```
POST /api/organizations/{orgId}/credits/purchase
{ "amountPaise": 20000000 }   // ₹2,00,000 = 20,000,000 paise
```
→ Returns `{ orderId, amount, currency, purchaseId, key }` for Razorpay SDK checkout

**Step 3 — Razorpay webhook confirms**
- `payment.captured` / `order.paid` fires
- `app/api/webhooks/utils.ts` matches `metadata.type === "credit_purchase"`
- Calls `purchaseCredits(orgProfileId, amountPaise)` → atomically increments `OrgCreditPool.balance` and writes `OrgCreditLedger` row with `type: PURCHASE`
- `OrgCreditPurchase.status` flips `PENDING → CONFIRMED` via `updateMany WHERE status=PENDING` (idempotent)

**Step 4 — Invite employees as ORG_LEARNER**
```
POST /api/organizations/{orgId}/invitations
{ "email": "bob@techcorp.com", "role": "ORG_LEARNER" }
```

### Schema fields used
```prisma
OrgCreditPool {
  organizationProfileId  String   @unique
  balance                Int      // current paise balance — raw SQL UPDATE WHERE balance >= amount
  totalPurchased         Int
  totalConsumed          Int
}

OrgCreditLedger {
  type    OrgCreditLedgerType   // PURCHASE | DEDUCTION | REFUND | ADJUSTMENT
  amount  Int
  memberProfileId String?        // which learner triggered the deduction/refund
}

OrgCreditPurchase {
  status           OrgCreditPurchaseStatus  // PENDING | CONFIRMED | FAILED
  providerOrderId  String?                  // Razorpay order ID
}
```

### Checkout behaviour
```ts
// lib/payments/operations/org-credits.ts
await deductCredits(orgProfileId, sessionAmountPaise, memberProfileId);
// Raw SQL: UPDATE OrgCreditPool SET balance = balance - amount WHERE id = ? AND balance >= amount
// Returns false if balance insufficient → checkout aborts with "Insufficient credits"
```

### Refund behaviour
```ts
await creditRefund(orgProfileId, refundAmountPaise, memberProfileId);
// Atomically increments balance + writes REFUND ledger row
```

### Orphaned purchase cleanup
`GET /api/cleanup/orphaned-org-credit-purchases` (cron, daily)  
Finds `OrgCreditPurchase` rows in `PENDING` status older than 2 hours and marks them `FAILED`.

### When NOT to use
If the org wants to pay after the fact rather than pre-load → use INVOICED_MONTHLY.  
If the contract is time-boxed with unlimited sessions → use PREPAID_UNLIMITED.

---

## 4. Combination 3 — BUYER + INVOICED_MONTHLY

### Use case
Enterprise buying on **NET-30 / NET-60 commercial terms**. Sessions accrue during the month; a consolidated invoice is generated and sent; org pays. Standard B2B procurement flow.

### Setup steps

**Step 1 — Create org**
```
POST /api/organizations
{
  "name": "Enterprise Client Ltd",
  "type": "BUYER",
  "billingMode": "INVOICED_MONTHLY"
}
```

**Step 2 — Set credit limit (exposure cap)**
```
PATCH /api/organizations/{orgId}
{ "orgInvoiceCreditLimit": 100000000 }   // ₹10L cap — blocks new bookings if outstanding >= limit
```

**Step 3 — Invite learners**
```
POST /api/organizations/{orgId}/invitations
{ "email": "carol@enterprise.com", "role": "ORG_LEARNER" }
```

**Step 4 — Generate monthly invoice (manual or cron)**
```
POST /api/organizations/{orgId}/billing/generate-invoice
```
- Aggregates all `COMPLETED` appointments with `billedToOrgInvoiceId IS NULL`
- Nets out refunded bookings
- Applies 18% GST via `determineTax()` for Indian orgs
- Stores `taxAmount`, `taxRate: 0.18`, `hsnCode: "999293"` (or service-type-specific SAC)
- Updates each `Appointment.billableToOrgInvoiceId` inside the same `$transaction`
- Writes `INVOICE_GENERATED` audit log

**Step 5 — Send invoice to org (admin action)**
- Change `status: DRAFT → SENT` via `PATCH /api/organizations/{orgId}/billing/invoices/{invoiceId}`

**Step 6 — Org pays**
```
POST /api/organizations/{orgId}/billing/invoices/{invoiceId}/pay
```
→ Creates Razorpay order with `metadata.type = "invoice_payment"`  
→ Webhook flips invoice `SENT/OVERDUE → PAID` atomically via `updateMany WHERE status IN ["SENT","OVERDUE"]`  
→ Stores `providerPaymentId` (Razorpay payment ID) on the invoice for reconciliation  
→ Writes `INVOICE_PAID` audit log

### Invoice state machine
```
DRAFT → SENT → PAID
             ↘ OVERDUE (via daily cron if dueDate passed)
             ↘ CANCELLED (manual admin)
```

### Schema fields used
```prisma
OrganizationInvoice {
  status            OrgInvoiceStatus   // DRAFT | SENT | PAID | OVERDUE | CANCELLED
  amount            Int                // total paise (subtotal + taxAmount)
  taxAmount         Int?               // GST in paise
  taxRate           Float?             // 0.18
  hsnCode           String?            // "999293"
  gstin             String?            // validated with /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/
  dueDate           DateTime?
  paidAt            DateTime?
  providerPaymentId String?            // Razorpay paymentId stored on capture
  autoGenerated     Boolean
}
```

### Overdue cron
`GET /api/cleanup/mark-overdue-invoices` (daily at 01:00 UTC, auth: Bearer CRON_SECRET)  
Single bulk update: `updateMany WHERE status="SENT" AND dueDate < now()`

### Checkout behaviour
- `billingMode === INVOICED_MONTHLY` → session amount accrues to outstanding balance
- If `outstandingBalance >= orgInvoiceCreditLimit` → new bookings blocked at checkout

### When NOT to use
If the org has already paid upfront → use SEAT_PACK or PREPAID_UNLIMITED.

---

## 5. Combination 4 — BUYER + PREPAID_UNLIMITED

### Use case
Org pays a **flat license fee** upfront (offline: bank transfer, cheque, PO). For the duration of the contract, every session costs learners ₹0. Suitable for schools, government bodies, and enterprise deals where per-session billing is impractical.

### Setup steps

**Step 1 — Create org**
```
POST /api/organizations
{
  "name": "Springfield School",
  "type": "BUYER",
  "billingMode": "PREPAID_UNLIMITED"
}
```

**Step 2 — Set contract window**
```
PATCH /api/organizations/{orgId}
{
  "contractStartDate": "2026-05-01T00:00:00Z",
  "contractEndDate":   "2026-09-30T23:59:59Z"
}
```

**Step 3 — Record the payment (create + mark invoice)**
```
POST /api/organizations/{orgId}/billing/invoices
{
  "items": [{ "description": "Annual license fee — 10,000 sessions", "quantity": 1, "unitPrice": 100000000 }],
  "currency": "INR",
  "taxRate": 0.18,
  "hsnCode": "999293",
  "gstin": "27AABCU9603R1ZX",
  "dueDate": "2026-04-20T00:00:00Z",
  "notes": "As per PO #2026/EDU/004"
}
```
Then `PATCH .../invoices/{invoiceId}` to flip `DRAFT → SENT → PAID` once payment received.

**Step 4 — Invite learners**
```
POST /api/organizations/{orgId}/invitations
{ "email": "student@springfield.edu", "role": "ORG_LEARNER" }
```

### Schema fields used
```prisma
OrganizationProfile {
  billingMode       BillingMode?   // PREPAID_UNLIMITED
  contractStartDate DateTime?
  contractEndDate   DateTime?
}
```

### Checkout behaviour
```ts
// lib/payments/operations/checkout.ts
if (org.billingMode === "PREPAID_UNLIMITED") {
  const now = new Date();
  if (now >= org.contractStartDate && now <= org.contractEndDate) {
    // Session amount = ₹0 to learner
    // Consultant still earns their listed plan price (platform absorbs margin from ₹10L collected)
  } else {
    // Contract expired → normal pricing
  }
}
```

### Revenue accounting
- ₹10L collected upfront is the platform's gross revenue for the contract
- Each session: platform pays consultant their standard rate from the listed plan price
- Platform P&L: ₹10L (collected) − Σ(consultant earnings over contract) = platform margin

### When NOT to use
If sessions need to be individually invoiced and auditable → use INVOICED_MONTHLY.  
If the org wants a credit balance with refund capability → use SEAT_PACK.

---

## 6. Combination 5 — PROVIDER + NULL (no billing mode)

### Use case
A **coaching institute**, consulting firm, or mentorship network wants to **list its own experts** on the Familiarise marketplace. Revenue flows from the learner → platform → split between platform, org, and consultant.

> Feature flag: `ENABLE_PROVIDER_ORGS` must be `true`.

### Setup steps

**Step 1 — Create org (admin route — not self-serve)**
```
POST /api/admin/organizations   (staff/admin only)
{
  "name": "EliteCoach Academy",
  "type": "PROVIDER",
  "platformRevenueRate": 0.10,
  "orgRevenueRate":      0.05,
  "consultantRevenueRate": 0.85
}
```
`billingMode` is omitted — stored as `NULL` in DB.

**Step 2 — Verify org (admin)**
```
PATCH /api/admin/organizations/{orgId}/verify
{ "verified": true }
```

**Step 3 — Invite consultants as ORG_CONSULTANT**
```
POST /api/organizations/{orgId}/invitations
{ "email": "expert@elitecoach.com", "role": "ORG_CONSULTANT" }
```
- On acceptance, a `ConsultantProfile` is created/linked and `orgConsultantProfileId` is set
- The consultant's services are discoverable on the marketplace

**Step 4 — (Optional) Configure domain claim for SSO**
```
PUT /api/organizations/{orgId}/sso
{ "domains": ["elitecoach.com"], "ssoEnabled": true }
```

### Schema fields used
```prisma
OrganizationProfile {
  orgKind               OrgKind    // PROVIDER
  billingMode           BillingMode?  // NULL — no billing mode
  platformRevenueRate   Float?     // e.g. 0.10
  orgRevenueRate        Float?     // e.g. 0.05
  consultantRevenueRate Float?     // e.g. 0.85
  // sum must = 1.0 ± 0.0001
}
```

### Revenue split (per session)
```
Learner pays ₹1,000
→ Platform receives:  ₹100  (10%)
→ Org receives:       ₹50   (5%)
→ Consultant gets:    ₹850  (85%)
```

### Payout pipeline
PROVIDER org earnings accumulate in `OrganizationPayoutAccount`.  
`createOrgPayoutBatch()` → `processOrgPayout()` in `lib/payments/payouts/org-payout-service.ts`  
Cron: `create-payout-batch`, `process-payouts`, `reconcile-payout-status`, `handle-stuck-payouts`

### Org deactivation
`DELETE /api/organizations/{orgId}` (ORG_OWNER):
```ts
await prisma.$transaction(async (tx) => {
  await tx.orgDomainClaim.deleteMany({ where: { organizationProfileId: org.id } });
  await tx.organizationProfile.update({ data: { status: "DEACTIVATED" } });
});
```
Domain claims cleared atomically — domains become claimable by other orgs immediately.

---

## 7. Combination 6 — HYBRID + TAG_ONLY

### Use case
An organisation whose **members are both mentors AND learners** — e.g., a peer learning community, alumni network, or professional association — but the org doesn't subsidise sessions. Org earns revenue from its consultant-members and gets reporting on its learner-members.

> Feature flag: `ENABLE_PROVIDER_ORGS` must be `true`.

### Setup steps

**Step 1 — Create org**
```
POST /api/admin/organizations
{
  "name": "CFA Alumni Network",
  "type": "HYBRID",
  "billingMode": "TAG_ONLY",
  "platformRevenueRate": 0.10,
  "orgRevenueRate":      0.08,
  "consultantRevenueRate": 0.82
}
```

**Step 2 — Invite dual-role members**
- Consultants: `role: "ORG_CONSULTANT"`
- Learners: `role: "ORG_LEARNER"`
- A single user can hold both roles (separate profile rows linked by `userId`)

### Checkout behaviour
- Learner pays at listed price (no subsidy — TAG_ONLY)
- Booking tagged to org for analytics

### Revenue
- Sessions by org's consultants → 3-way split
- Sessions booked by org's learners → standard platform commission only (org earns nothing from learner side under TAG_ONLY)

---

## 8. Combination 7 — HYBRID + SEAT_PACK

### Use case
EdTech company that **employs its own trainers** AND wants to **pre-fund learning credits** for its student cohorts. Both revenue streams active simultaneously.

### Setup steps

**Step 1 — Create org**
```
POST /api/admin/organizations
{
  "name": "CodeBridge Academy",
  "type": "HYBRID",
  "billingMode": "SEAT_PACK",
  "platformRevenueRate": 0.10,
  "orgRevenueRate":      0.05,
  "consultantRevenueRate": 0.85
}
```

**Step 2 — Buy credit pool** (same as BUYER + SEAT_PACK)
```
POST /api/organizations/{orgId}/credits/purchase
{ "amountPaise": 50000000 }   // ₹5L pool
```

**Step 3 — Invite trainers as ORG_CONSULTANT**
**Step 4 — Invite students as ORG_LEARNER**

### Revenue flows
```
When a student books an internal trainer:
  → learner: ₹0 (deducted from org credit pool)
  → Trainer (ORG_CONSULTANT): earns their revenue share
  → Platform: earns platform share
  → Org net: orgRevenueShare MINUS credits deducted from pool

When a student books an external marketplace consultant:
  → learner: ₹0 (deducted from org credit pool)
  → External consultant: earns their full rate
  → Platform: earns commission
  → Org: nothing (paid from pool)
```

---

## 9. Combination 8 — HYBRID + INVOICED_MONTHLY

### Use case
Professional association or industry body where members can be both practitioners and learners. **Org earns** from practitioner sessions and **is invoiced monthly** for member learning sessions.

### Setup steps

**Step 1 — Create org**
```
POST /api/admin/organizations
{
  "name": "IIT Alumni Mentorship Circle",
  "type": "HYBRID",
  "billingMode": "INVOICED_MONTHLY",
  "orgInvoiceCreditLimit": 200000000
}
```

**Step 2 — Invite mentors and mentees** (as in HYBRID + TAG_ONLY)

**Step 3 — End of month: generate invoice**
```
POST /api/organizations/{orgId}/billing/generate-invoice
```
Aggregates all INVOICED_MONTHLY bookings by org learners. GST applied. Invoice sent.

### Net settlement consideration
This combination can support **net settlement** in a future billing enhancement:
```
Org earns ₹50,000 from consultant sessions this month
Org owes ₹80,000 for learner sessions this month
Net invoice: ₹30,000 payable
```
Current implementation does not auto-net — the invoice and payout pipeline are independent.  
Track: Issue #661 (auto-generation cron), Issue #655 (credit notes).

---

## 10. Combination 9 — HYBRID + PREPAID_UNLIMITED

### Use case
The **₹10L scenario**. A school, college, or corporate sends a payment order for the entire contract period. Their own teachers/mentors are the consultants. Students book freely.

### Setup steps

**Step 1 — Create org**
```
POST /api/admin/organizations
{
  "name": "Delhi Public School — Mentorship",
  "type": "HYBRID",
  "billingMode": "PREPAID_UNLIMITED",
  "platformRevenueRate": 0.10,
  "orgRevenueRate":      0.05,
  "consultantRevenueRate": 0.85
}
```

**Step 2 — Record the ₹10L payment**
```
POST /api/organizations/{orgId}/billing/invoices
{
  "items": [{ "description": "4-month unlimited mentorship license", "quantity": 1, "unitPrice": 100000000 }],
  "currency": "INR",
  "taxRate": 0.18,
  "hsnCode": "999293",
  "gstin": "07AABFD1234G1ZQ"
}
```

**Step 3 — Set contract window**
```
PATCH /api/organizations/{orgId}
{
  "contractStartDate": "2026-05-01T00:00:00Z",
  "contractEndDate":   "2026-09-30T23:59:59Z"
}
```

**Step 4 — Invite teachers as ORG_CONSULTANT, students as ORG_LEARNER**

### Financial reality
```
₹10L collected upfront (your revenue)
Each session: student pays ₹0
Each session: teacher (ORG_CONSULTANT) earns e.g. ₹80 per 30-min session (85% of ₹94 listed price)
Platform margin = ₹10L − Σ teacher earnings over 4 months

Example:
10,000 sessions × ₹94 avg listed price = ₹9.4L total listed value
Teacher earns 85% = ₹7.99L
Platform keeps 10% + org earns 5% = ₹94K platform + ₹47K org fund
Your take: ₹10L (collected) − ₹7.99L (paid to teachers) = ₹2.01L net margin (~20%)
```

---

## 11. Webhook Flow Summary

```
payment.captured / order.paid
│
├── metadata.type === "credit_purchase"
│   └── handleOrgPaymentSuccess(purchaseId)
│       → updateMany OrgCreditPurchase WHERE status=PENDING → CONFIRMED  (idempotent)
│       → purchaseCredits() → atomic balance increment + PURCHASE ledger row
│
├── metadata.type === "invoice_payment"
│   └── handleOrgPaymentSuccess(invoiceId)
│       → updateMany OrganizationInvoice WHERE status IN [SENT, OVERDUE] → PAID  (idempotent + state-machine safe)
│       → stores providerPaymentId for reconciliation
│       → INVOICE_PAID audit log (fire-and-forget)
│
└── standard appointment payment
    └── normal checkout handler
```

---

## 12. Audit Log Events

```prisma
enum OrgAuditAction {
  MEMBER_INVITED
  MEMBER_REMOVED
  ROLE_CHANGED
  SETTINGS_UPDATED
  SSO_CONFIGURED
  PAYOUT_INITIATED
  PAYOUT_PROCESSED
  INVOICE_GENERATED    // added in enterprise-1b
  CREDITS_PURCHASED    // added in enterprise-1b
  INVOICE_PAID         // added in enterprise-1b
}
```

---

## 13. Cron Job Inventory (Enterprise Finance)

| Route | Schedule | Purpose |
|---|---|---|
| `cleanup/orphaned-org-credit-purchases` | Daily | Expire PENDING credit purchases >2h old |
| `cleanup/mark-overdue-invoices` | Daily 01:00 UTC | Flip SENT invoices past `dueDate` to OVERDUE |
| `process-payouts` | Daily | Execute PROVIDER/HYBRID payout batches |
| `create-payout-batch` | Monthly | Group PROVIDER earnings into payout batches |
| `reconcile-payout-status` | Hourly | Sync Razorpay/Stripe payout status |
| `handle-stuck-payouts` | Daily | Alert + retry payouts stuck in PROCESSING >24h |

Auth on all routes: `Authorization: Bearer $CRON_SECRET`

---

## 14. Known Deferred Items

| # | Gap | Issue / Phase |
|---|---|---|
| Monthly invoice auto-generation (Inngest cron) | Issue #661 / Phase K |
| Invoice PDF rendering (`pdfUrl` stays null) | Issue #438 |
| Credit notes for refunds on paid invoices | Issue #655 |
| Stripe support for org credit purchase + invoice pay | Phase L |
| PREPAID_UNLIMITED in org-creation wizard UI | Not wired yet |
| Net settlement for HYBRID (earn vs owe in same month) | Future |
