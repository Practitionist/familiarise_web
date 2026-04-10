> **⚠️ SUPERSEDED on 2026-04-08.** This proposal's PROVIDER-only vision will become part of the unified BUYER/PROVIDER/HYBRID organization model in PR2 (`feature/enterprise`) as `docs/enterprise/00-canonical-design.md`. Role enum will be `OrgMemberRole` with 6 values (not `OrganizationRole` with 4). Revenue split mechanics and payment flow diagrams here are still accurate for PROVIDER orgs. Retained for historical context.

# B2B Consultant Company Onboarding - Architecture Documentation

## Executive Summary

This document outlines the architecture for onboarding **Consultant Companies** (organizations with multiple consultants) to the Familiarise consultation SaaS platform. Currently, the platform supports individual consultants. This feature would add multi-tenancy support for B2B clients.

---

## Table of Contents

1. [Current vs Proposed Architecture](#1-current-vs-proposed-architecture)
2. [Database Schema Changes](#2-database-schema-changes)
3. [Authentication & Registration](#3-authentication--registration)
4. [Onboarding Flow](#4-onboarding-flow)
5. [UI/UX Changes](#5-uiux-changes)
6. [Payments, Payouts, Refunds & Disputes](#6-payments-payouts-refunds--disputes)
7. [Appointment Types for Companies](#7-appointment-types-for-companies)
8. [Migration Strategy](#8-migration-strategy)

---

## 1. Current vs Proposed Architecture

### Current State (Individual Consultants)

```
User (role: CONSULTANT)
  └── ConsultantProfile (1:1)
        ├── Domain, SubDomains, Tags
        ├── Availability Slots
        ├── Plans (Consultation, Subscription, Webinar, Class)
        └── Reviews
```

**Limitations:**

- No organization/company concept
- Each consultant operates independently
- No shared branding, settings, or revenue pooling
- No team management or hierarchy

### Proposed State (Company + Consultants)

```
Organization (Company)
  ├── OrganizationSettings
  │     ├── Branding (logo, colors, custom domain)
  │     ├── Payment Settings (payout account, commission rate)
  │     └── Default Policies (cancellation, refund)
  │
  ├── OrganizationMembers (Many Users)
  │     ├── Owner (role: ORG_OWNER) - Full admin
  │     ├── Admin (role: ORG_ADMIN) - Manage consultants
  │     ├── Consultant (role: ORG_CONSULTANT) - Provide services
  │     └── Support (role: ORG_SUPPORT) - Handle requests
  │
  ├── ConsultantProfiles (linked to members)
  │     └── Same structure as individual consultants
  │
  ├── OrganizationPlans (company-wide plans)
  │     └── Can override individual consultant plans
  │
  └── Revenue & Analytics
        ├── Aggregated payments
        ├── Payout schedules
        └── Performance dashboards
```

---

## 2. Database Schema Changes

### New Models Required

```prisma
// ==================== ORGANIZATION ====================

model Organization {
  id          String   @id @default(cuid())
  name        String
  slug        String   @unique  // URL-friendly identifier
  description String?  @db.Text
  website     String?

  // Branding
  logo        String?
  bannerImage String?
  primaryColor    String?  @default("#000000")
  secondaryColor  String?  @default("#ffffff")
  customDomain    String?  @unique

  // Status
  status          OrganizationStatus @default(PENDING_VERIFICATION)
  verifiedAt      DateTime?

  // Settings
  settings        OrganizationSettings?

  // Members
  members         OrganizationMember[]
  invitations     OrganizationInvitation[]

  // Financial
  payoutAccount   PayoutAccount?
  payouts         Payout[]

  // Content (org-level plans override individual)
  organizationPlans OrganizationPlan[]

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([slug])
  @@index([status])
}

enum OrganizationStatus {
  PENDING_VERIFICATION  // Just registered, awaiting verification
  ACTIVE                // Verified and operational
  SUSPENDED             // Temporarily disabled
  DEACTIVATED           // Permanently closed
}

model OrganizationSettings {
  id              String @id @default(cuid())

  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  organizationId  String @unique

  // Commission & Revenue
  platformCommissionRate  Float @default(0.10)  // 10% platform fee
  consultantPayoutRate    Float @default(0.85)  // 85% to consultant
  companyRetainRate       Float @default(0.05)  // 5% company retains

  // Policies
  defaultCancellationPolicy   String? @db.Text
  defaultRefundPolicy         String? @db.Text
  autoApproveConsultants      Boolean @default(false)
  requireConsultantVerification Boolean @default(true)

  // Booking Settings
  allowIndividualPricing      Boolean @default(true)  // Consultants set own prices
  enforceOrganizationPlans    Boolean @default(false) // Use only org plans
  defaultCurrency             String @default("INR")
  supportedCurrencies         String[] @default(["INR", "USD"])

  // Notifications
  notifyOwnerOnBooking        Boolean @default(true)
  notifyOwnerOnPayout         Boolean @default(true)

  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}

// ==================== MEMBERSHIP ====================

model OrganizationMember {
  id              String @id @default(cuid())

  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  organizationId  String

  user            User @relation(fields: [userId], references: [id], onDelete: Cascade)
  userId          String

  role            OrganizationRole
  status          MemberStatus @default(ACTIVE)

  // Consultant-specific (if role is ORG_CONSULTANT)
  consultantProfile   ConsultantProfile? @relation(fields: [consultantProfileId], references: [id])
  consultantProfileId String? @unique

  // Revenue sharing (can override org defaults)
  customPayoutRate    Float?  // If null, use org default

  joinedAt        DateTime @default(now())
  invitedBy       String?  // User ID who invited

  @@unique([organizationId, userId])
  @@index([organizationId])
  @@index([userId])
}

enum OrganizationRole {
  ORG_OWNER       // Full control, billing, can delete org
  ORG_ADMIN       // Manage consultants, view analytics
  ORG_CONSULTANT  // Provide services, manage own profile
  ORG_SUPPORT     // Handle requests, basic support tasks
}

enum MemberStatus {
  PENDING     // Invited but not accepted
  ACTIVE      // Active member
  SUSPENDED   // Temporarily disabled
  REMOVED     // Left or removed from org
}

model OrganizationInvitation {
  id              String @id @default(cuid())

  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  organizationId  String

  email           String
  role            OrganizationRole
  token           String @unique
  expiresAt       DateTime

  invitedBy       String  // User ID
  acceptedAt      DateTime?

  createdAt       DateTime @default(now())

  @@unique([organizationId, email])
  @@index([token])
}

// ==================== PAYOUTS ====================

model PayoutAccount {
  id              String @id @default(cuid())

  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  organizationId  String @unique

  // Bank Details (encrypted)
  accountHolderName   String
  accountNumber       String  // Encrypted
  bankName            String
  ifscCode            String?  // India
  routingNumber       String?  // US
  swiftCode           String?  // International

  // Gateway-specific IDs
  stripeConnectId     String? @unique
  razorpayContactId   String? @unique
  razorpayFundAccountId String?

  // Status
  status          PayoutAccountStatus @default(PENDING_VERIFICATION)
  verifiedAt      DateTime?

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
}

enum PayoutAccountStatus {
  PENDING_VERIFICATION
  VERIFIED
  FAILED_VERIFICATION
  SUSPENDED
}

model Payout {
  id              String @id @default(cuid())

  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  organizationId  String

  amount          Int         // In smallest currency unit
  currency        String

  // Period covered
  periodStart     DateTime
  periodEnd       DateTime

  // Breakdown
  grossRevenue    Int         // Total payments received
  platformFee     Int         // Platform commission
  refunds         Int         // Refunds during period
  netPayout       Int         // Final payout amount

  // Status
  status          PayoutStatus @default(PENDING)
  processedAt     DateTime?
  failureReason   String?

  // Gateway reference
  payoutReference String? @unique
  paymentGateway  PaymentGateway

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([organizationId])
  @@index([status])
  @@index([periodStart, periodEnd])
}

enum PayoutStatus {
  PENDING       // Scheduled for payout
  PROCESSING    // Being processed
  COMPLETED     // Successfully paid out
  FAILED        // Payout failed
  ON_HOLD       // Held for review
}

// ==================== ORGANIZATION PLANS ====================

model OrganizationPlan {
  id              String @id @default(cuid())

  organization    Organization @relation(fields: [organizationId], references: [id], onDelete: Cascade)
  organizationId  String

  planType        AppointmentsType  // CONSULTATION, SUBSCRIPTION, WEBINAR, CLASS

  // Common fields
  title           String
  description     String? @db.Text
  price           Int
  priceCurrency   String @default("INR")

  // Settings
  isActive        Boolean @default(true)
  assignedTo      String[]  // Consultant profile IDs who can use this plan

  // Type-specific JSON config
  config          Json  // Duration, sessions, participants, etc.

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([organizationId])
  @@index([planType])
}
```

### User Model Updates

```prisma
model User {
  // ... existing fields ...

  // NEW: Organization membership
  organizationMemberships OrganizationMember[]

  // NEW: Primary organization (for consultants belonging to one org)
  primaryOrganizationId   String?

  // ... rest of fields ...
}
```

### ConsultantProfile Updates

```prisma
model ConsultantProfile {
  // ... existing fields ...

  // NEW: Organization link
  organizationMember  OrganizationMember?

  // NEW: Flag for independent vs org consultant
  isIndependent       Boolean @default(true)

  // ... rest of fields ...
}
```

---

## 3. Authentication & Registration

### Registration Flows

#### Flow A: Company Registration (New Organization)

```
1. Company Admin visits /auth/signup?type=company

2. Step 1: Company Details
   - Company Name (required)
   - Company Email (required)
   - Company Website (optional)
   - Industry/Domain (select)

3. Step 2: Admin Account
   - Admin Name (required)
   - Admin Email (required, must match company domain or verified)
   - Password
   - Phone (optional)

4. Step 3: Verification
   - Email verification sent to company email
   - Option for domain verification (DNS TXT record)

5. On Verification:
   - Organization created (status: ACTIVE)
   - User created (role: CONSULTANT, but with ORG_OWNER in membership)
   - OrganizationMember created (role: ORG_OWNER)
   - Redirect to /onboarding/company
```

#### Flow B: Consultant Joining Company (Invitation)

```
1. Company Admin sends invitation from dashboard
   - POST /api/organizations/[orgId]/invitations
   - Email sent with unique token

2. Consultant clicks invitation link
   - /auth/signup?invitation=[token]

3. If existing user:
   - Verify email matches invitation
   - Add OrganizationMember record
   - Redirect to company onboarding

4. If new user:
   - Standard signup with pre-filled email
   - Create User + OrganizationMember
   - Redirect to consultant onboarding (company context)
```

#### Flow C: Individual Consultant (Existing Flow)

```
- No changes to existing individual consultant registration
- User.primaryOrganizationId remains null
- ConsultantProfile.isIndependent = true
```

### Session & JWT Updates

```typescript
// next-auth.d.ts additions
interface Session {
  user: {
    // ... existing fields ...

    // NEW
    organizationMemberships: {
      organizationId: string;
      organizationName: string;
      organizationSlug: string;
      role: OrganizationRole;
      status: MemberStatus;
    }[];

    primaryOrganizationId: string | null;
    currentOrganizationId: string | null; // For org switching
  };
}
```

### API Authentication Middleware

```typescript
// New middleware for organization-scoped routes
export async function withOrganization(
  req: NextRequest,
  handler: (
    req: NextRequest,
    org: Organization,
    member: OrganizationMember,
  ) => Promise<NextResponse>,
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const orgId =
    req.headers.get("x-organization-id") || session.user.currentOrganizationId;
  if (!orgId) {
    return NextResponse.json(
      { error: "Organization required" },
      { status: 400 },
    );
  }

  const membership = await prisma.organizationMember.findUnique({
    where: {
      organizationId_userId: { organizationId: orgId, userId: session.user.id },
    },
    include: { organization: true },
  });

  if (!membership || membership.status !== "ACTIVE") {
    return NextResponse.json(
      { error: "Not a member of this organization" },
      { status: 403 },
    );
  }

  return handler(req, membership.organization, membership);
}
```

---

## 4. Onboarding Flow

### Company Onboarding (ORG_OWNER)

```
Step 0: Organization Profile
├── Company Name (pre-filled)
├── Company Description
├── Industry/Domain Selection
├── Logo Upload
├── Banner Image Upload
├── Primary & Secondary Colors

Step 1: Business Details
├── Business Registration Number (optional)
├── Tax ID / GST Number (optional)
├── Business Address
├── Support Email
├── Support Phone

Step 2: Payout Setup
├── Account Holder Name
├── Bank Account Number
├── Bank Name
├── IFSC Code / Routing Number
├── (Or) Connect Stripe / Razorpay

Step 3: Policies & Settings
├── Default Cancellation Policy (text editor)
├── Default Refund Policy (text editor)
├── Auto-approve Consultants (toggle)
├── Require Consultant Verification (toggle)
├── Default Commission Rates

Step 4: Invite Team (Optional)
├── Invite Admins (email list)
├── Invite Consultants (email list)
├── Bulk CSV Upload

Step 5: Review & Submit
├── Review all information
├── Accept Terms of Service (B2B specific)
├── Submit for verification

Post-Onboarding:
├── Platform reviews company
├── If approved: status → ACTIVE
├── Owner receives confirmation email
├── Dashboard unlocked
```

### Consultant Onboarding (Within Company)

```
Step 0: Personal Info (same as individual)
├── Name, Email (pre-filled from invitation)
├── Phone, Address, Timezone

Step 1: Professional Profile
├── Description, Qualifications
├── Specialization, Experience
├── Domain, SubDomains, Tags
├── Schedule Type (Weekly/Custom)
├── (Company branding applied to profile)

Step 2: Availability Setup
├── Weekly slots OR Custom dates
├── Same UI as individual consultants

Step 3: Service Offerings
├── Option A: Use Organization Plans
│   └── Select from pre-defined org plans
├── Option B: Create Custom Plans (if allowed)
│   └── Same plan creation as individual
│   └── Prices may have org minimums

Step 4: Agreement
├── Company-specific consultant agreement
├── Platform terms acceptance
├── Revenue sharing acknowledgment

Step 5: Review & Submit

Post-Onboarding:
├── If org.autoApproveConsultants: Active immediately
├── Else: Pending approval from ORG_ADMIN/OWNER
├── Once approved: Profile visible on company page
```

---

## 5. UI/UX Changes

### New Pages Required

```
/auth/signup?type=company          → Company registration
/auth/signup?invitation=[token]    → Invitation acceptance

/onboarding/company                → Company onboarding wizard
/onboarding/company-consultant     → Consultant onboarding (company context)

/dashboard/organization/[orgId]    → Organization dashboard
  ├── /home                        → Overview, stats, quick actions
  ├── /team                        → Manage members, invitations
  ├── /consultants                 → View/manage consultants
  ├── /plans                       → Organization-wide plans
  ├── /bookings                    → All bookings across consultants
  ├── /revenue                     → Revenue analytics, payouts
  ├── /settings                    → Organization settings
  └── /branding                    → Logo, colors, custom domain

/[orgSlug]                         → Public company page
/[orgSlug]/consultants             → Company's consultant directory
/[orgSlug]/[consultantSlug]        → Consultant profile (company branded)
```

### Navigation Updates

```typescript
// Consultant Dashboard - Add org switcher if member of org
const DashboardLayout = () => {
  const { organizationMemberships } = useSession()

  return (
    <nav>
      {organizationMemberships.length > 0 && (
        <OrganizationSwitcher
          organizations={organizationMemberships}
          onSwitch={handleOrgSwitch}
        />
      )}
      {/* existing nav items */}
    </nav>
  )
}
```

### Explore Page Updates

```
/explore/experts                   → Individual consultants
/explore/companies                 → NEW: Company directory
/explore/companies/[orgSlug]       → Company detail page
```

### Checkout Page Updates

```typescript
// Add organization context to checkout
interface CheckoutContext {
  // Existing
  planId: string
  planType: AppointmentsType
  consultantId: string

  // NEW
  organizationId?: string
  organizationPlanId?: string  // If using org plan
}

// Display company branding on checkout if org consultant
const CheckoutPage = () => {
  const { organization } = useCheckoutContext()

  return (
    <div style={{
      '--primary': organization?.primaryColor,
      '--secondary': organization?.secondaryColor
    }}>
      {organization && <OrgHeader logo={organization.logo} />}
      {/* checkout content */}
    </div>
  )
}
```

---

## 6. Payments, Payouts, Refunds & Disputes

### Payment Flow for Organization Consultants

```
CONSULTEE PAYS
     │
     ▼
┌─────────────────┐
│  Payment        │
│  Gateway        │
│  (Stripe/RZP)   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Platform       │
│  Receives 100%  │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  REVENUE SPLIT (Configurable)       │
│                                     │
│  Platform Fee:     10%  ──────────► Platform Revenue
│  Company Retain:    5%  ──────────► Organization Balance
│  Consultant:       85%  ──────────► Consultant Balance
│                                     │
│  (Rates from OrganizationSettings)  │
└─────────────────────────────────────┘
         │
         ▼
┌─────────────────┐
│  Payout         │    Weekly/Monthly/On-demand
│  Schedule       │───────────────────────────►
└─────────────────┘
         │
         ├──► Organization Bank Account (company share)
         └──► Individual Consultant (if direct payout enabled)
```

### Payout Implementation

```typescript
// POST /api/organizations/[orgId]/payouts/process
async function processOrganizationPayout(orgId: string, periodEnd: Date) {
  const org = await prisma.organization.findUnique({
    where: { id: orgId },
    include: { settings: true, payoutAccount: true },
  });

  if (!org?.payoutAccount || org.payoutAccount.status !== "VERIFIED") {
    throw new Error("Payout account not verified");
  }

  // Calculate revenue for period
  const payments = await prisma.payment.findMany({
    where: {
      paymentStatus: "SUCCEEDED",
      createdAt: { gte: lastPayoutDate, lte: periodEnd },
      appointment: {
        OR: [
          {
            consultation: {
              consultationPlan: {
                consultantProfile: {
                  organizationMember: { organizationId: orgId },
                },
              },
            },
          },
          {
            subscription: {
              subscriptionPlan: {
                consultantProfile: {
                  organizationMember: { organizationId: orgId },
                },
              },
            },
          },
          // ... webinar, class
        ],
      },
    },
  });

  const grossRevenue = payments.reduce((sum, p) => sum + p.amount, 0);
  const refunds = await calculateRefundsForPeriod(
    orgId,
    lastPayoutDate,
    periodEnd,
  );

  const platformFee = Math.round(
    grossRevenue * org.settings.platformCommissionRate,
  );
  const netPayout = grossRevenue - platformFee - refunds;

  // Create payout record
  const payout = await prisma.payout.create({
    data: {
      organizationId: orgId,
      amount: netPayout,
      currency: org.settings.defaultCurrency,
      periodStart: lastPayoutDate,
      periodEnd,
      grossRevenue,
      platformFee,
      refunds,
      netPayout,
      status: "PENDING",
      paymentGateway: "STRIPE", // or based on payout account
    },
  });

  // Process via gateway
  if (org.payoutAccount.stripeConnectId) {
    await processStripePayout(
      org.payoutAccount.stripeConnectId,
      netPayout,
      payout.id,
    );
  } else if (org.payoutAccount.razorpayFundAccountId) {
    await processRazorpayPayout(
      org.payoutAccount.razorpayFundAccountId,
      netPayout,
      payout.id,
    );
  }

  return payout;
}
```

### Refunds for Organization Payments

```typescript
// Refund flow with organization revenue adjustment
async function processOrganizationRefund(
  paymentId: string,
  amount: number,
  reason: string,
) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      appointment: {
        include: {
          consultation: {
            include: {
              consultationPlan: {
                include: {
                  consultantProfile: { include: { organizationMember: true } },
                },
              },
            },
          },
        },
      },
    },
  });

  const orgMember =
    payment.appointment?.consultation?.consultationPlan?.consultantProfile
      ?.organizationMember;

  // Process refund via gateway
  const refundResult = await processGatewayRefund(payment, amount, reason);

  // Create refund record
  const refund = await prisma.refund.create({
    data: {
      amount,
      currency: payment.currency,
      reason,
      status: refundResult.status,
      refundId: refundResult.refundId,
      paymentGateway: payment.paymentGateway,
      paymentId: payment.id,
    },
  });

  // If org payment, track for payout adjustment
  if (orgMember) {
    await prisma.organizationRefundLog.create({
      data: {
        organizationId: orgMember.organizationId,
        refundId: refund.id,
        amount,
        // Will be deducted from next payout
      },
    });
  }

  return refund;
}
```

### Disputes for Organization Payments

```
DISPUTE RECEIVED
      │
      ▼
┌──────────────────────────────────────┐
│  Notification to:                    │
│  1. Platform Admin                   │
│  2. Organization Owner/Admin         │
│  3. Consultant (if applicable)       │
└──────────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────────┐
│  Evidence Collection                 │
│                                      │
│  Platform: Payment records, logs     │
│  Organization: Business policies     │
│  Consultant: Service delivery proof  │
└──────────────────────────────────────┘
      │
      ▼
┌──────────────────────────────────────┐
│  Platform Submits Combined Evidence  │
│  (Platform manages dispute response) │
└──────────────────────────────────────┘
      │
      ▼
   OUTCOME
      │
      ├─► WON: No action needed
      │
      └─► LOST: Chargeback amount deducted
            │
            ├─► From Organization balance (if sufficient)
            └─► From future payouts (if insufficient)
```

---

## 7. Appointment Types for Companies

### How Each Type Works with Organizations

#### Consultation (1-on-1)

```
INDIVIDUAL CONSULTANT:
└── ConsultantProfile → ConsultationPlan → Consultation → Appointment

ORGANIZATION CONSULTANT:
└── Organization → OrganizationMember → ConsultantProfile → ConsultationPlan → Consultation → Appointment
                                     OR
└── Organization → OrganizationPlan (type: CONSULTATION) → Consultation → Appointment
    (Assigned to multiple consultants, bookable from any)

ORGANIZATION BENEFIT:
- Company can define standard consultation packages
- Consultants can offer org plans + their own (if allowed)
- Revenue automatically split per org settings
- Company branding on booking page
```

#### Subscription (Recurring)

```
INDIVIDUAL CONSULTANT:
└── ConsultantProfile → SubscriptionPlan → Subscription → Appointments (multiple)

ORGANIZATION CONSULTANT:
└── Same structure, but:
    - Org can enforce minimum commitment periods
    - Org can set max subscription price caps
    - Org retains % of recurring revenue

ORGANIZATION BENEFIT:
- Monthly recurring revenue for company
- Consultant retention tracking
- Bulk subscription management
- Company-wide subscription analytics
```

#### Webinar (Group - Many-to-Many)

```
INDIVIDUAL CONSULTANT:
└── ConsultantProfile → WebinarPlan → Webinar → Appointment → SlotOfAppointment (per attendee)

ORGANIZATION:
└── Organization → OrganizationPlan (type: WEBINAR) → Webinar
    - Can be hosted by ANY consultant in org
    - Can have multiple co-hosts from same org
    - Company branding on webinar landing page
    - Revenue split across participating consultants

NEW FEATURE FOR ORGS:
└── Multi-Consultant Webinars
    - WebinarPlan.hosts = [consultantProfileId, consultantProfileId, ...]
    - Revenue split defined per host
    - Each host can manage their segment
```

#### Class (Extended Course)

```
INDIVIDUAL CONSULTANT:
└── ConsultantProfile → ClassPlan → Class → Appointments (multiple sessions)

ORGANIZATION:
└── Organization → OrganizationPlan (type: CLASS) → Class
    - Organization-branded course
    - Can have guest instructors from org
    - Curriculum managed at org level
    - Certificate issued by organization

NEW FEATURE FOR ORGS:
└── Cohort-Based Classes
    - Multiple consultants teach different modules
    - Shared curriculum and materials
    - Organization issues completion certificate
    - Revenue pooled then distributed
```

### Booking Flow Modifications

```typescript
// Updated checkout API for organization context
interface CheckoutRequest {
  // Existing fields
  planId: string;
  appointmentType: AppointmentsType;
  paymentGateway: PaymentGateway;

  // NEW: Organization context
  organizationId?: string; // If booking from org consultant
  organizationPlanId?: string; // If using org-level plan

  // Determines revenue split
  // If organizationId present: Use org settings for split
  // Else: 100% to consultant (minus platform fee)
}

// Updated payment metadata
interface PaymentMetadata {
  // Existing
  appointmentId: string;
  appointmentType: string;
  userId: string;
  consultantProfileId: string;

  // NEW
  organizationId?: string;
  organizationPlanId?: string;
  revenueSplit?: {
    platform: number;
    organization: number;
    consultant: number;
  };
}
```

---

## 8. Migration Strategy

### Phase 1: Schema & Core Infrastructure

```
1. Add new Prisma models (Organization, OrganizationMember, etc.)
2. Run migration (non-breaking, all new tables)
3. Add isIndependent field to ConsultantProfile (default: true)
4. Update User model with organization fields
```

### Phase 2: Auth & Registration

```
1. Create company registration flow
2. Create invitation system
3. Update session/JWT to include org memberships
4. Add organization middleware for API routes
```

### Phase 3: Onboarding

```
1. Build company onboarding wizard
2. Build consultant-in-company onboarding
3. Create payout account setup flow
```

### Phase 4: Dashboard & Management

```
1. Build organization dashboard
2. Build team management UI
3. Build org plans management
4. Build revenue analytics
```

### Phase 5: Payments & Payouts

```
1. Implement revenue splitting logic
2. Integrate Stripe Connect / Razorpay X
3. Build payout scheduling system
4. Update refund/dispute handling
```

### Phase 6: Public Pages & Booking

```
1. Build company public pages
2. Add company branding to checkout
3. Update explore pages with companies
4. Test full booking flow
```

### Rollout Strategy

```
Week 1-2: Phase 1 (Schema) - No user impact
Week 3-4: Phase 2 (Auth) - Feature flag for company signup
Week 5-6: Phase 3 (Onboarding) - Beta with select companies
Week 7-8: Phase 4 (Dashboard) - Beta continues
Week 9-10: Phase 5 (Payments) - Financial testing
Week 11-12: Phase 6 (Public) - Full launch preparation
Week 13: General Availability
```

---

## Summary

This documentation provides a comprehensive blueprint for adding B2B consultant company support to the Familiarise platform. Key components:

1. **Multi-tenancy**: Organizations with members, roles, and permissions
2. **Flexible Onboarding**: Separate flows for companies and their consultants
3. **Revenue Management**: Configurable splits, payouts, and financial tracking
4. **All 4 Appointment Types**: Enhanced for organization context
5. **Gradual Migration**: Non-breaking changes with feature flags

The implementation maintains backward compatibility with existing individual consultants while adding powerful B2B capabilities.
