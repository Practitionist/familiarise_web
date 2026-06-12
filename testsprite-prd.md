# Familiarise — Product Requirements Document (TestSprite Input)

## 1. Platform Overview

Familiarise is a B2B2C consulting / mentorship marketplace built on Next.js 15 (App Router), Prisma, Supabase (PostgreSQL), and Netlify. It connects independent consultants/experts with individuals (B2C) and enterprises (B2B). The platform handles end-to-end booking, video sessions, payments, payouts, and compliance.

**Base URL (dev):** `http://localhost:3000`

---

## 2. User Roles

| Role | Email (seeded) | Password | Dashboard path |
|---|---|---|---|
| Consultant | `aarav.anderson@gmail.com` | `SeedPass123!` | `/dashboard/consultant/[id]` |
| Consultee | `aarav.campbell@hotmail.com` | `SeedPass123!` | `/dashboard/consultee/[id]` |
| Admin | `robert.davis@yahoo.com` | `SeedPass123!` | `/dashboard/admin` |
| Staff | `lauren.davis@gmail.com` | `SeedPass123!` | `/dashboard/staff` |
| Org Owner | (via org invite) | `SeedPass123!` | `/dashboard/organization/[orgId]` |

Authentication is handled by **BetterAuth** — cookie-based sessions via `POST /api/auth/sign-in/email` with `{ email, password }` body.

---

## 3. Core Features

### 3.1 Authentication & Onboarding
- Sign up / sign in (email+password, Google OAuth, GitHub OAuth, Facebook OAuth)
- Multi-step onboarding: role selection → profile fields → availability setup
- Forgot password / reset password flows
- Cookie consent (GDPR-style preferences)
- Notification preference configuration

### 3.2 Booking System — 5 Event Types

All bookings flow: **Browse → Consultant profile → Slot selection → Checkout → Confirmation → Appointment → Meeting → Completion**.

| Event Type | Cardinality | Recurrence | Cost | Key API |
|---|---|---|---|---|
| Consultation | 1:1 | One-time | Paid | `POST /api/bookings/consultation/[id]/allocate` |
| Subscription | 1:1 | Recurring weekly | Paid | `POST /api/bookings/subscription/[id]/allocate` |
| Webinar | 1:Many | One-time | Paid | `POST /api/bookings/webinar/[id]/allocate` |
| Class | 1:Many | Recurring | Paid | `POST /api/bookings/class/[id]/allocate` |
| Trial | 1:1 | One-time | Free | `POST /api/trials` |

Slots are **30-minute atomic units**. The system supports three allocation modes:
- **Auto**: system picks available slots
- **Manual**: user selects from calendar
- **Requested**: consultee requests, consultant approves

Validation layers: Zod schema → SlotValidationService (business rules) → DB constraints.

#### Rescheduling
`PATCH /api/appointments/[id]/reschedule` — within and outside cancellation window; triggers refund if outside window.

#### Cancellation
`DELETE /api/appointments/[id]` — cascades to: payment refund, waitlist promotion (group events), slot release, earnings reversal.

#### Waitlist (Webinars & Classes)
`POST /api/waitlist` — automatic promotion when a slot opens; ordered FIFO.

### 3.3 Payment System

#### Checkout Flow
`POST /api/checkout` — creates Payment + PaymentLeg(s). Funding sources:
- **CARD** (Razorpay test mode): `rzp_test_*` keys
- **WALLET** (platform credits from top-ups)
- **REFERRAL_CREDIT** (earned credits from referral program)
- **INVOICE_ACCRUAL** (enterprise orgs on invoice billing)
- **LICENSE** (enterprise seat-based entitlement)

Multi-leg payments stack sources (e.g., WALLET + CARD for the remainder).

#### Razorpay Integration
- Payments: `RAZORPAY_KEY_ID` + `RAZORPAY_SECRET`
- Webhooks: `POST /api/webhooks/razorpay`
- Webhook events: `payment.captured`, `payment.failed`, `refund.created`, `dispute.created`

#### Refunds
`POST /api/payments/[paymentId]/refund` — two-phase (reverse PaymentLegs in order); referral credits are restored; TDS is reversed.

#### Disputes
Admin-assigned via `/dashboard/admin` — statuses: `WARNING_NEEDS_RESPONSE → UNDER_REVIEW → WON/LOST/CLOSED`.

#### Discount Codes
Applied at checkout via `POST /api/checkout` with `discountCode` field — `PERCENTAGE` or `FIXED_AMOUNT`.

### 3.4 Earnings & Payouts

#### Consultant Payouts
- Earnings hold period after session completion → `PENDING → HELD → READY → PAID`
- TDS deducted at source (Section 194J / 194O depending on entity type)
- Batch payout: `POST /api/consultant/payouts`
- Payout account: `POST /api/consultant/payout-accounts`

#### Organization Payouts (Enterprise HOST/HYBRID orgs)
- 3-way split: platform fee + org share + consultant share
- Org payout batch with TDS and GST fields
- MSME 43B compliance: mustPayByDate enforced

### 3.5 Meetings & Recordings

- **Stream.io** video calls embedded at `/meetings/[id]`
- Call start/end managed via `POST /api/meetings/[id]/start` and `/end`
- Recording: `POST /api/recordings/[id]/start` → async processing → `READY` state
- Appointment document upload: `POST /api/documents` (resume, code files for review)

### 3.6 Referral System

- Consultant generates referral code: `POST /api/referrals/codes`
- Referee signs up via `/r/[code]`
- Both parties receive `ReferralCredit` (minted automatically on `QUALIFIED` status)
- Credits applied at checkout; partially restored on refund

### 3.7 Collaborators (Multi-Creator Events)

- Co-host / guest speaker / TA / moderator on webinars/classes
- `POST /api/collaborators` — invite by email
- Revenue share configured in basis points (`revenueShareBps`)
- Statuses: `PENDING → ACCEPTED / DECLINED / REMOVED`

### 3.8 Support & Feedback

- Support tickets: `POST /api/support-tickets` → staff responds via `/dashboard/staff`
- Ticket statuses: `OPEN → IN_PROGRESS → ON_HOLD → RESOLVED → CLOSED`
- Feedback: `POST /api/feedbacks` (star rating + comment by consultee)
- Moderation report: `POST /api/report` for reviews/profiles

### 3.9 Notification Preferences

- `PATCH /api/user/notification-preferences` — channels (inApp/email/push), quiet hours, per-category toggles

---

## 4. Enterprise Subsystem (B2B)

### 4.1 Organization Lifecycle

`POST /api/organizations` → status: `PENDING_VERIFICATION`  
→ KYB verification (GSTIN, PAN, HSN code) → `ACTIVE`  
→ Can issue invoices and accept enterprise bookings

Org types: `SPONSOR` (buys for employees), `HOST` (earns revenue), `HYBRID` (both), `NEUTRAL`  
Funding sources: `PERSONAL`, `WALLET`, `LICENSE`, `INVOICE`

### 4.2 Membership & IAM

- Invite: `POST /api/organizations/[orgId]/invitations`
- Roles: `OWNER, MAINTAINER, BILLING_ADMIN, MANAGER, EXPERT, LEARNER, SUPPORT`
- SSO: SAML/OIDC via `PATCH /api/organizations/[orgId]/sso-settings`
- Domain claim (DNS verification): `POST /api/organizations/[orgId]/domain-claims`
- Break-glass login (bypasses enforceSSO)
- SCIM v2 provisioning at `/scim/v2/`

### 4.3 Programs & Contracts

**Program types:**
- `LICENSED_SEAT`: engagement-cap based; overage behavior: `BLOCK / CHARGE_MEMBER / CHARGE_ORG`
- `CREDIT_POOL`: budget in credits (1 credit = ₹1)

**Contract lifecycle:** `DRAFT → ACTIVE → EXPIRED/TERMINATED`; supports RENEWAL and AMENDMENT supersession chains.

`ProgramAssignment` is issued per member per contract period; `BookingUtilization` records each booking's consumption.

### 4.4 Invoicing (GST-compliant)

- Invoice statuses: `DRAFT → ISSUED → PAID → OVERDUE → VOID`
- GST fields: CGST/SGST (intra-state) or IGST (inter-state), HSN code
- E-invoice: IRN generation via IRP (`irn`, `ackNumber`, `signedQrPayload`)
- Credit notes (GST Sec 34) issued on partial refunds
- Invoice counter resets on April 1 (Indian fiscal year)

### 4.5 Double-Entry Ledger

Every monetary event posts a balanced `LedgerTransaction` with multiple `LedgerEntry` rows (DEBIT/CREDIT). Account types: `CASH, WALLET, PLATFORM_FEE, CONSULTANT_PAYABLE, ORG_PAYABLE, ORG_RECEIVABLE, TDS_PAYABLE, GST_PAYABLE`.

LedgerReconciliationReport runs nightly to verify balance integrity.

### 4.6 Compliance (DPDP / India)

- Erasure request (Right to be forgotten): `POST /api/user/erasure-request`
- Data export (Right to access): `POST /api/organizations/[orgId]/data-export`
- Consent artifact versioning: each new T&C version creates a `ConsentArtifact`
- TDS: Section 194J/O/C rates in `TdsRate` lookup table
- GstTcsBatch: monthly GSTR-8 filing tracking

### 4.7 Outbound Webhooks

Org-level webhook endpoints: `POST /api/organizations/[orgId]/webhooks`  
Events: booking lifecycle, invoice, payout, member events  
Delivery with exponential retry → dead-letter after max attempts

---

## 5. Key API Endpoints Reference

| Domain | Method | Path | Description |
|---|---|---|---|
| Auth | POST | `/api/auth/sign-in/email` | Sign in with email/password → session cookie |
| Auth | POST | `/api/auth/sign-up/email` | Create account |
| Auth | POST | `/api/auth/sign-out` | Sign out (clear session) |
| Health | GET | `/api/health` | `{ status: "healthy", database: "connected" }` |
| Booking | POST | `/api/bookings/consultation/:id/validate` | Validate slot selection |
| Booking | PATCH | `/api/bookings/consultation/:id/allocate` | Allocate slots |
| Checkout | POST | `/api/checkout` | Create payment + payment legs |
| Checkout | DELETE | `/api/checkout/pending/:paymentId` | Release tentative slots |
| Payments | POST | `/api/payments/:id/refund` | Refund a payment |
| Slots | GET | `/api/slots/:consultantId` | Get available slots |
| Organizations | POST | `/api/organizations` | Create org |
| Organizations | GET | `/api/organizations/:orgId` | Get org details |
| Programs | POST | `/api/programs` | Create program |
| Invoices | GET | `/api/organizations/:orgId/billing-account/invoices` | List invoices |
| Meetings | POST | `/api/meetings/:id/start` | Start Stream.io call |
| Recordings | POST | `/api/recordings/:id/start` | Start recording |
| Referrals | POST | `/api/referrals/codes` | Generate referral code |
| Trials | POST | `/api/trials` | Book free trial |
| Support | POST | `/api/support-tickets` | Create support ticket |
| Webhooks | POST | `/api/webhooks/razorpay` | Razorpay inbound webhook |

---

## 6. Test Scenarios Priority

### P0 (Must Pass)
1. Sign up as consultant → complete onboarding → show in explore page
2. Book a consultation (consultee → consultant) → payment → appointment confirmed
3. Trial booking → conversion to subscription
4. Cancel consultation within refund window → payment refunded
5. Enterprise: create org → invite member → member books via license entitlement
6. Overage BLOCK: exceed seat limit → booking rejected

### P1 (Should Pass)
1. Multi-leg checkout: wallet + card combined
2. Refund with referral credit → credit restored
3. Webinar waitlist: join when full → get promoted when a seat opens
4. Reschedule appointment → new slot allocated, old slot released
5. Enterprise invoice: INVOICE-funded org → booking accrues to invoice → invoice ISSUED
6. Consultant payout: earnings READY → batch payout COMPLETED

### P2 (Edge Cases)
1. Double-booking same slot → second attempt blocked
2. Checkout abandonment → tentative slots released after 24h
3. Booking in different timezone → slot displayed correctly in local time
4. SCIM: provision new user → membership created automatically
5. Dispute: payment.dispute.created webhook → dispute record created → admin resolves
6. Erasure request: user data zeroed from DB
