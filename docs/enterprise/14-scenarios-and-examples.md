# Scenarios and Examples

**Status**: Reference doc (Apr 2026)
**Branch**: `feature/enterprise`
**Scope**: All org types, billing modes, and earnings modes

## Overview

This doc walks through six complete real-world scenarios showing how org types, billing modes, and earnings modes combine. Each scenario includes the org configuration, a step-by-step flow, and a money trail table. All amounts are in INR (paise internally, rupees in display). These scenarios are the fastest way for a new developer to understand how the enterprise system works end-to-end.

### Quick Reference

| Org Kind | Who It Serves | Billing Mode Options | Earnings Mode |
|----------|---------------|----------------------|---------------|
| BUYER | Corporates/schools buying coaching for employees | TAG_ONLY, SEAT_PACK, INVOICED_MONTHLY | N/A (marketplace consultants) |
| PROVIDER | Agencies hosting consultants | N/A (org is the seller) | 3-way split (platform + org + consultant) |
| HYBRID | Both buyer and provider | All modes | Both (buyer side + provider side independently) |

---

## Scenario 1: Infosys Buys Coaching for Employees

**Org type**: BUYER
**Billing mode**: SEAT_PACK
**Earnings mode**: Marketplace (consultants are independent, not org-affiliated)

### Setup

Infosys HR wants to offer career coaching to 500 engineers. They purchase a block of credits upfront and employees book sessions with marketplace consultants of their choice.

### Step-by-Step

1. HR admin Priya creates a BUYER org with `billingMode: SEAT_PACK`
   - `POST /api/organizations` with `kind: BUYER, billingMode: SEAT_PACK`
   - Status: ACTIVE immediately (BUYER orgs skip verification)
   - `OrgCreditPool` created with `balance: 0, totalPurchased: 0`

2. Priya purchases Rs 50,00,000 of credits via Razorpay
   - Credit pool: `balance: 5000000000` (paise), `totalPurchased: 5000000000`
   - Credit ledger entry: `type: PURCHASE, amount: 5000000000`

3. Priya invites 500 employees as ORG_LEARNER
   - `POST /api/organizations/[orgId]/invitations` x 500
   - Each accepted invitation increments `seatsUsed`
   - If `seatsTotal = 500`, the 501st invite is rejected

4. Employee Rahul books a Rs 5,000 coaching session with marketplace consultant Deepak
   - Checkout detects `organizationId` on the booking
   - `paymentMethod: ORG_CREDITS` -- deducted from credit pool
   - Credit pool: `balance: 49,95,000` (Rs)
   - Credit ledger entry: `type: BOOKING, amount: -500000`

5. Earnings split (standard 2-way, not 3-way -- Deepak is independent)
   - Platform fee: Rs 1,000 (20%)
   - Consultant payout: Rs 4,000 (80%)
   - No OrganizationEarnings row (BUYER org does not earn from bookings)

6. Infosys sees usage analytics on the dashboard: bookings per employee, total spend, remaining credits

### Money Trail

| Step | Amount | From | To |
|------|--------|------|----|
| Credit purchase | Rs 50,00,000 | Infosys (Razorpay) | Platform credit pool |
| Booking deduction | Rs 5,000 | Credit pool | Payment record |
| Platform fee | Rs 1,000 (20%) | Payment | Platform revenue |
| Consultant payout | Rs 4,000 (80%) | Payment | Deepak's ConsultantEarnings |

---

## Scenario 2: TCS Monthly Invoicing

**Org type**: BUYER
**Billing mode**: INVOICED_MONTHLY
**Earnings mode**: Marketplace (consultants are independent)

### Setup

TCS wants monthly invoicing with NET-30 payment terms. Their finance team prefers paying one consolidated invoice per month rather than per-booking charges. They set a credit limit of Rs 10,00,000 to cap exposure.

### Step-by-Step

1. HR admin creates BUYER org with `billingMode: INVOICED_MONTHLY`
   - `paymentTermsDays: 30`
   - `orgInvoiceCreditLimit: 10000000` (Rs 10L in paise)

2. Throughout April, 200 employees book sessions worth Rs 8,00,000 total
   - Each booking creates a Payment with `paymentMethod: ORG_INVOICED, paymentStatus: SUCCEEDED`
   - No upfront charge -- bookings accumulate
   - `billableToOrgInvoiceId: null` on each payment

3. Mid-April: Employee tries to book a Rs 2,50,000 session
   - Checkout calculates exposure: Rs 8,00,000 (unbilled) + Rs 0 (outstanding invoices) = Rs 8,00,000
   - Rs 8,00,000 < Rs 10,00,000 limit -- booking allowed
   - New total unbilled: Rs 10,50,000

4. Next booking attempt (Rs 5,000)
   - Exposure: Rs 10,50,000 >= Rs 10,00,000 limit
   - Checkout blocked: "Organization has reached its invoice credit limit"

5. May 1: Org admin generates invoice manually
   - `POST /api/organizations/[orgId]/billing/generate-invoice`
   - Aggregates 201 payments, nets out any refunds
   - Creates `OrganizationInvoice`: `amount: Rs 10,50,000, status: SENT`
   - `dueDate: May 31` (30 days from generation)
   - All 201 payments now have `billableToOrgInvoiceId` set

6. Exposure resets: unbilled = Rs 0, outstanding = Rs 10,50,000
   - New bookings allowed until exposure hits Rs 10,00,000 again

7. TCS pays invoice before May 31
   - Invoice status: SENT -> PAID
   - Outstanding drops to Rs 0

### Money Trail

| Step | Amount | From | To |
|------|--------|------|----|
| 201 bookings (April) | Rs 10,50,000 | No charge yet | Payment records (ORG_INVOICED) |
| Invoice generated | Rs 10,50,000 | Platform | OrganizationInvoice (SENT) |
| Invoice paid | Rs 10,50,000 | TCS (Razorpay) | Platform (invoice settled) |
| Platform fees (aggregate) | Rs 2,10,000 (20%) | Payment records | Platform revenue |
| Consultant payouts (aggregate) | Rs 8,40,000 (80%) | Payment records | Individual ConsultantEarnings |

---

## Scenario 3: TechConsult Agency with Freelancers

**Org type**: PROVIDER
**Billing mode**: N/A (org is the seller, not the buyer)
**Earnings mode**: 3-way split (10% platform / 5% agency / 85% consultant)

### Setup

TechConsult is a consulting agency that hosts 20 freelance software engineers. External clients find consultants through TechConsult's page on Familiarise and book sessions. TechConsult takes a 5% cut, the platform takes 10%, and consultants keep 85%.

### Step-by-Step

1. Agency founder Vikram creates a PROVIDER org (requires `ENABLE_PROVIDER_ORGS=true`)
   - `POST /api/organizations` with `kind: PROVIDER`
   - Status: `PENDING_VERIFICATION` (PROVIDER orgs require platform admin approval)
   - Rates: `platformCommissionRate: 0.10, orgRetainRate: 0.05, consultantPayoutRate: 0.85`

2. Platform admin verifies and activates the org
   - Status: `PENDING_VERIFICATION` -> `ACTIVE`
   - Public page now visible at `/org/techconsult`

3. Freelancer Ananya applies to join via the public page
   - `POST /api/organizations/[orgId]/consultants/apply`
   - Creates `OrganizationMemberProfile` with `role: ORG_CONSULTANT, status: PENDING`

4. Vikram approves Ananya's application
   - `POST /api/organizations/[orgId]/consultants` with `{ memberId, action: "APPROVE" }`
   - Status: `PENDING` -> `ACTIVE`
   - Ananya now appears on the public org page and gets an org badge on `/explore/experts`

5. External client Rajesh books a Rs 10,000 session with Ananya
   - Checkout processes normally (Rajesh pays via Razorpay/Stripe)
   - `resolveOrgSplit()` detects Ananya is ORG_CONSULTANT in an active PROVIDER org

6. 3-way earnings split

### Money Trail for Rs 10,000 Session

| Recipient | Rate | Amount | Record |
|-----------|------|--------|--------|
| Platform | 10% | Rs 1,000 | `platformFee` on ConsultantEarnings |
| TechConsult (agency) | 5% | Rs 500 | `OrganizationEarnings.orgShare` |
| Ananya (consultant) | 85% | Rs 8,500 | `ConsultantEarnings.consultantShare` |
| **Total** | **100%** | **Rs 10,000** | |

7. Payout cycle (monthly)
   - After hold period, earnings move from PENDING -> READY
   - Vikram creates a payout batch: `POST /api/organizations/[orgId]/payouts`
   - Platform admin processes: `POST /api/admin/org-payouts/process`
   - Rs 500 transferred to TechConsult's bank account
   - Ananya's Rs 8,500 goes through standard consultant payout pipeline

### Per-Consultant Rate Override

Vikram wants to give senior consultant Pradeep a better deal (90% instead of 85%):

| Recipient | Rate | Amount (Rs 10,000 session) |
|-----------|------|----------------------------|
| Platform | 10% | Rs 1,000 |
| TechConsult | 0% | Rs 0 |
| Pradeep | 90% | Rs 9,000 |

Set via `customConsultantPayoutRate: 0.90` on Pradeep's `OrganizationMemberProfile`. The org's share absorbs the difference (5% -> 0%).

---

## Scenario 4: IIT Bombay Internal Training

**Org type**: HYBRID
**Billing mode**: PREPAID_UNLIMITED
**Earnings mode**: Platform-only (100% to platform via annual license)

### Setup

IIT Bombay pays Rs 1,00,00,000 (Rs 1 crore) annual license fee. Professors host sessions for students. Students attend for free (no per-session charge). The university uses the platform as internal training infrastructure.

### Configuration

| Field | Value |
|-------|-------|
| kind | HYBRID |
| billingMode | PREPAID_UNLIMITED |
| platformCommissionRate | 1.00 |
| orgRetainRate | 0.00 |
| consultantPayoutRate | 0.00 |
| contractStartDate | 2026-04-01 |
| contractEndDate | 2027-03-31 |

Professors are added as ORG_CONSULTANT with `earningsRecipient: ORGANIZATION`. Since `consultantPayoutRate` is 0 and `orgRetainRate` is 0, the platform retains 100% of any per-session fees (but in practice, sessions are free under the unlimited license).

### Step-by-Step

1. IIT admin creates HYBRID org with PREPAID_UNLIMITED
   - Contract: April 2026 to March 2027
   - Annual fee of Rs 1,00,00,000 handled as a custom contract (outside standard billing)

2. Admin adds 50 professors as ORG_CONSULTANT
   - Each professor's `earningsRecipient: ORGANIZATION`
   - Professors receive no per-session payment (salaried by IIT)

3. Admin invites 5,000 students as ORG_LEARNER
   - `seatsTotal: 5000`

4. Student Meera books a session with Professor Sharma
   - Checkout detects PREPAID_UNLIMITED billing mode
   - No credit deduction, no invoice -- covered by annual license
   - Session proceeds normally via Stream.io

5. Contract period check
   - If `contractEndDate` has passed, checkout returns: "license expired"
   - IIT renews contract to continue access

### Money Trail

| Step | Amount | From | To |
|------|--------|------|----|
| Annual license | Rs 1,00,00,000 | IIT Bombay | Platform (custom contract) |
| Per session | Rs 0 | N/A | N/A (unlimited) |
| Professor payout | Rs 0 | N/A | N/A (salaried, earningsRecipient=ORGANIZATION) |

---

## Scenario 5: Design Agency with Salaried Designers

**Org type**: PROVIDER
**Billing mode**: N/A
**Earnings mode**: 3-way split with earningsRecipient=ORGANIZATION (10% platform / 90% agency / 0% consultant)

### Setup

PixelCraft Design employs 5 salaried designers. External clients pay for design consultation sessions. Since the designers are salaried employees (not freelancers), all consultant earnings are redirected to the agency.

### Configuration

| Field | Value |
|-------|-------|
| kind | PROVIDER |
| platformCommissionRate | 0.10 |
| orgRetainRate | 0.05 |
| consultantPayoutRate | 0.85 |
| All consultants: earningsRecipient | ORGANIZATION |

Note: The rates still show 5%/85%, but because `earningsRecipient=ORGANIZATION`, the consultant's 85% share is redirected to the org. The org effectively receives 90% (5% org retain + 85% consultant redirect).

### Step-by-Step

1. PixelCraft admin Meera creates PROVIDER org
   - Platform admin approves and activates

2. Meera adds 5 designers as ORG_CONSULTANT
   - Each set to `earningsRecipient: ORGANIZATION`
   - Designers appear on `/org/pixelcraft` and get org badges

3. External client Suresh books a Rs 15,000 design consultation with designer Arjun

4. Earnings split (earningsRecipient=ORGANIZATION path in resolveOrgSplit):

### Money Trail for Rs 15,000 Session

| Recipient | Calculation | Amount |
|-----------|-------------|--------|
| Platform fee | 10% of Rs 15,000 | Rs 1,500 |
| PixelCraft (org) | Everything except platform fee | Rs 13,500 |
| Arjun (consultant) | Rs 0 (earningsRecipient=ORGANIZATION) | Rs 0 |
| **Total** | | **Rs 15,000** |

When `earningsRecipient=ORGANIZATION`, the `resolveOrgSplit()` function skips the normal 3-way calculation:

```
consultantShare: 0
orgShare: grossAmount - platformFee = 15000 - 1500 = 13500
```

The `ConsultantEarnings` row is still created (for the consultant's dashboard visibility) but with `consultantShare: 0`. The `OrganizationEarnings` row captures the full Rs 13,500.

5. PixelCraft pays designers their salary independently (outside the platform)

---

## Scenario 6: University with External Clients

**Org type**: HYBRID
**Billing mode**: SEAT_PACK (buyer side)
**Earnings mode**: 3-way split (provider side)

### Setup

National Institute of Technology (NIT) Trichy operates as a HYBRID org with two independent financial streams:

- **BUYER side**: NIT sponsors students to book career coaching with external marketplace consultants (funded by credit pool)
- **PROVIDER side**: NIT professors serve external professionals who pay for academic consultations (professors earn via 3-way split)

### Configuration

| Field | Value |
|-------|-------|
| kind | HYBRID |
| billingMode | SEAT_PACK |
| platformCommissionRate | 0.10 |
| orgRetainRate | 0.10 |
| consultantPayoutRate | 0.80 |
| seatsTotal | 2000 |

### BUYER Side: Students Book External Coaches

1. NIT purchases Rs 20,00,000 credits for 2,000 students
2. Student Kavitha books a Rs 3,000 career coaching session with external consultant Arun
3. Rs 3,000 deducted from credit pool
4. Standard 2-way split (Arun is not an org consultant):
   - Platform: Rs 600 (20%)
   - Arun: Rs 2,400 (80%)
5. NIT dashboard shows credit usage analytics

### PROVIDER Side: Professors Serve External Clients

1. Professor Ramesh is added as ORG_CONSULTANT (`earningsRecipient: CONSULTANT`)
2. External professional Vikram books a Rs 8,000 session with Prof. Ramesh
3. Vikram pays via Razorpay (normal checkout, no credits involved)
4. 3-way split (resolveOrgSplit detects HYBRID org):

| Recipient | Rate | Amount |
|-----------|------|--------|
| Platform | 10% | Rs 800 |
| NIT (org) | 10% | Rs 800 |
| Prof. Ramesh | 80% | Rs 6,400 |

### Combined Money Trail

| Stream | Event | Amount | From | To |
|--------|-------|--------|------|----|
| BUYER | Credit purchase | Rs 20,00,000 | NIT (Razorpay) | Credit pool |
| BUYER | Student booking | Rs 3,000 | Credit pool | Payment |
| BUYER | Platform fee | Rs 600 | Payment | Platform |
| BUYER | Consultant payout | Rs 2,400 | Payment | Arun (external) |
| PROVIDER | External booking | Rs 8,000 | Vikram (Razorpay) | Payment |
| PROVIDER | Platform fee | Rs 800 | Payment | Platform |
| PROVIDER | Org retain | Rs 800 | Payment | NIT OrganizationEarnings |
| PROVIDER | Consultant payout | Rs 6,400 | Payment | Prof. Ramesh ConsultantEarnings |

The two streams operate independently. Credit pool purchases fund the BUYER side. External client payments fund the PROVIDER side. The dashboard shows both: credit usage analytics and provider earnings/payouts.

---

## Edge Cases

| Scenario | What Happens |
|----------|-------------|
| Same-org learner books same-org consultant (HYBRID) | Both billing (credit deduction from pool) AND earnings (3-way split) activate. The org pays via credits and also receives an org share from the payment. |
| Credit pool hits Rs 0 | Next booking from an ORG_LEARNER is blocked: "insufficient credits" |
| PREPAID_UNLIMITED contract expires | Checkout checks `contractEndDate` and returns "license expired" |
| Consultant in 2 PROVIDER orgs | `resolveOrgSplit` uses `findFirst` with `orderBy: createdAt asc` — the **oldest** active PROVIDER/HYBRID membership determines the split. Badge query uses the same ordering so earnings and UI stay consistent. Future: allow per-booking org selection. |
| Refund on 3-way split | Both `ConsultantEarnings` and `OrganizationEarnings` are reversed proportionally. TDS reversal records created if payout was already completed. |
| PROVIDER org deactivated | Org profile status set to DEACTIVATED. API routes check `org.status === ACTIVE`; all bookings and payouts blocked. Existing READY earnings are held. |
| Rate override + collaborator split | Org share uses `customConsultantPayoutRate` to compute the consultant pool, then the pool is split among host and collaborators per their `revenueSharePercentage`. |
| Rs 0 invoice (all items refunded) | `generate-invoice` filters out zero-net items. If all items are zero, returns 400: "No billable payments after refund adjustments." |
| Concurrent payout batch creation | `createOrgPayoutBatch` uses a transaction lock. Second concurrent call gets 409: "try again." |
| Org admin changes rates mid-month | New rates apply only to future payments. Existing earnings rows are immutable. |
