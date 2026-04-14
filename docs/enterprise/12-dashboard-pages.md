# Dashboard Pages

**Status**: Implemented (Apr 2026)
**Branch**: `feature/enterprise`
**Scope**: `/dashboard/organization/[orgId]/*`

## Overview

The org dashboard is a parallel dashboard that lives alongside the personal consultant and consultee dashboards. Each organization a user belongs to gets its own dashboard with a collapsible sidebar, role-gated navigation, and kind-specific pages. The layout fetches org metadata on mount and uses it to compute which sidebar items are visible.

---

## Entry Point

### Organization List

`/dashboard/organization` lists all organizations the user is a member of. Each card shows the org name, logo, kind, status, and the user's role. Clicking a card navigates to `/dashboard/organization/[orgId]/home`.

The billing mode badge on each card is conditional: it is hidden for PROVIDER orgs, which have `billingMode = null` (PROVIDER orgs have no billing mode — they earn via revenue splits rather than purchasing sessions).

### OrgSwitcher

A dropdown in `DashboardNavbar` (visible in consultant, consultee, and admin layouts) that lists the user's org memberships. It self-hides when the user has zero memberships. Clicking an org navigates to its dashboard.

---

## Layout

The layout (`app/dashboard/organization/[orgId]/layout.tsx`) is a client component that:

1. Fetches org details from `GET /api/organizations/[orgId]` (profile kind, billing mode, user role)
2. Computes sidebar items based on role rank and org kind
3. Renders a `CollapsibleSidebar` with the org's name, logo, and a bottom chip showing the logged-in user's name and role
4. Redirects bare `/dashboard/organization/[orgId]` to `/dashboard/organization/[orgId]/home`

### Role Rank Hierarchy

The layout mirrors `ORG_ROLE_RANK` from `lib/auth-helpers.ts`:

| Role | Rank |
|------|------|
| ORG_OWNER | 100 |
| ORG_ADMIN | 80 |
| ORG_MANAGER | 60 |
| ORG_CONSULTANT | 40 |
| ORG_SUPPORT | 30 |
| ORG_LEARNER | 20 |

A sidebar item with "minimum role ORG_MANAGER" is visible to ORG_MANAGER, ORG_ADMIN, and ORG_OWNER.

### Sidebar Navigation

| Page | Icon | Path | Minimum Role | Kind Required |
|------|------|------|-------------|---------------|
| Overview | Home | `home` | Any | Any |
| Members | Users | `members` | Any | Any |
| Invitations | Mail | `invitations` | ORG_ADMIN | Any |
| Learners | GraduationCap | `learners` | Any | BUYER or HYBRID |
| Consultants | UserCog | `consultants` | Any | PROVIDER or HYBRID |
| Plans | Briefcase | `plans` | Any | Any |
| Credits | Coins | `credits` | ORG_MANAGER | SEAT_PACK billing only |
| Billing | CreditCard | `billing` | ORG_MANAGER | Any |
| Payouts | Wallet | `payouts` | Any | PROVIDER or HYBRID |
| Analytics | BarChart3 | `analytics` | ORG_MANAGER | Any |
| Settings | Settings | `settings` | ORG_ADMIN | Any |

Items where `show` evaluates to `false` are filtered out entirely -- they do not appear as disabled links.

---

## Page-by-Page

### Overview (/home)

The hub page showing a snapshot of the organization. Built as a client component using React Query for parallel data fetching.

**Stat cards (top row, 4 columns)**:
- Active members (with learner count subtitle)
- Learners (with seat usage: "X / Y seats" or "Unlimited seats")
- Active plans
- This month (gross revenue with booking count and month-over-month trend)

**Billing-mode secondary cards (ORG_MANAGER+)**:
- Outstanding invoices (count + amount) -- shown when count > 0
- Pending charges (INVOICED_MONTHLY only): unbilled amount and payment count
- Credit balance (SEAT_PACK only): current balance and lifetime purchased

**PROVIDER/HYBRID stats (third row)**:
- Active consultants count
- Total payouts (completed payout amount)

**Onboarding checklist** (ORG_ADMIN+, dismissible via localStorage):
- Create organization (always done)
- Invite your first team member (done when members > 1)
- Create your first plan (done when active plans > 0)
- Configure billing settings (done when billing data loads)

Progress bar shows completion percentage. Dismiss button persists to `localStorage` key `orgOnboardingDismissed_[orgId]`.

**Quick action cards** (role-gated, 2x4 grid):
- Invite member (ORG_ADMIN)
- Create plan (ORG_ADMIN)
- View billing (ORG_MANAGER)
- Org settings (ORG_ADMIN)

**Recent activity feed**: Last 5 events (member_joined, payment, invoice_generated, invitation_sent) with time-ago labels.

**File**: `app/dashboard/organization/[orgId]/home/page.tsx`

### Members

Member list with roles. Supports add/remove/edit operations (ORG_ADMIN+). Shows all member types: owners, admins, managers, consultants, support staff, and learners.

Seat management: adding ORG_LEARNER members increments `seatsUsed` on the org profile. If `seatsTotal` is set, new additions are blocked when the seat budget is exhausted.

### Invitations

Send invites by email -- supports comma-separated or newline-separated addresses. Each invite creates a pending invitation record and sends an email via Resend.

Pending invitations list with resend/cancel actions. Invitations expire after a configurable period.

### Learners

Filtered view of ORG_LEARNER members. Shows seat join timestamps and allows removal (which decrements `seatsUsed`).

### Consultants (PROVIDER/HYBRID only)

Two sections rendered on `app/dashboard/organization/[orgId]/consultants/page.tsx`:

1. **Pending Applications** card (ORG_ADMIN+): a table of all PENDING consultant applications with Applicant, Note, Applied date, and Approve/Reject action buttons. Buttons POST to `/api/organizations/[orgId]/consultants` with `{ memberId, action: "APPROVE" | "REJECT" }`. Only rendered when there are pending applications.

2. **Active Consultants** card: a table of all ACTIVE consultants with Consultant, Headline, Rating, Earnings mode, Verified columns. The Earnings column shows:
   - `Internal` badge when `earningsRecipient === ORGANIZATION`
   - Custom rate percentage (e.g., `90%`) when `customConsultantPayoutRate` is set
   - `Default` otherwise

**Per-consultant payout controls** are edited via the member PATCH endpoint:

```
PATCH /api/organizations/[orgId]/members/[memberId]
{ customConsultantPayoutRate?: number | null, earningsRecipient?: "CONSULTANT" | "ORGANIZATION" }
```

Both fields are gated behind `ENABLE_PROVIDER_ORGS`. The inline edit UI for these fields is a follow-up — for now they are editable via direct API call or SQL.

When `ENABLE_PROVIDER_ORGS=false`, the consultants page shows a lock card (see Lock Card Pattern below).

**Files**:
- Page: `app/dashboard/organization/[orgId]/consultants/page.tsx`
- List/approval API: `app/api/organizations/[orgId]/consultants/route.ts`
- Payout-controls PATCH: `app/api/organizations/[orgId]/members/[memberId]/route.ts`

### Plans

Org-owned plan catalog spanning all four service types: CONSULTATION, SUBSCRIPTION, WEBINAR, CLASS. Plans are assigned to specific consultants or made available to all org consultants.

When `enforceOrganizationPlans=true`, consultants in the org can only use org-created plans (personal plans are hidden).

### Credits (SEAT_PACK only)

Visible only when `billingMode === SEAT_PACK` and role >= ORG_MANAGER.

- **Credit pool**: Current balance and total purchased
- **Purchase credits**: Razorpay checkout to add credits to the pool
- **Credit ledger**: Immutable transaction log showing every credit/debit (purchases, bookings, refunds)

### Billing

Invoice list with status badges (DRAFT, SENT, PAID, OVERDUE, CANCELLED). Manual invoice generation button (ORG_OWNER). Outstanding balance summary card.

For INVOICED_MONTHLY orgs: shows pending charges (unbilled bookings) and credit limit status.

See `docs/enterprise/10-invoicing.md` for full invoicing details.

### Payouts (PROVIDER/HYBRID only)

```
+------------------------------------------------------+
|  Payouts                                              |
|  Settlement history for the organization              |
+------------------------------------------------------+
|  [Total paid out]  [Pending]  [Total payouts]        |
|   Rs 2,40,000       Rs 45,000   8                    |
+------------------------------------------------------+
|  [ Create Payout Batch ]  (ORG_OWNER only)           |
+------------------------------------------------------+
|  Payout History                                       |
|  Period      | Gross      | Net       | Status | Date|
|  01/03-31/03 | Rs 3,00,000| Rs 2,70,000| Paid  | 5/4|
|  01/02-28/02 | Rs 2,50,000| Rs 2,25,000| Paid  | 3/3|
+------------------------------------------------------+
```

- **Summary cards**: Total paid out, pending amount, total payout count
- **Create Payout Batch**: ORG_OWNER only. Calls `POST /api/organizations/[orgId]/payouts` which checks eligibility and creates a batch from READY earnings
- **Payout history table**: Period, gross, net, status badge, date

When `ENABLE_PROVIDER_ORGS=false`, shows a lock card.

**File**: `app/dashboard/organization/[orgId]/payouts/page.tsx`

### Analytics

Six-card stat grid for ORG_MANAGER+. Shows aggregate metrics across bookings, revenue, member growth, and plan performance.

### Settings

ORG_ADMIN+ access. Sub-sections:

- **Profile**: Name, description, industry, website
- **Branding**: Logo, banner image, primary/secondary colors
- **Billing config**: Payment terms, seat budget, credit limit — this card is hidden for PROVIDER orgs (`billingMode = null`)
- **PROVIDER/HYBRID specific**: Rate configuration (`platformCommissionRate`, `orgRetainRate`, `consultantPayoutRate` -- must sum to 1.0), payout frequency (`payoutFrequency`: WEEKLY, BIWEEKLY, MONTHLY), `autoApproveConsultants` toggle, `enforceOrganizationPlans` toggle
- **SSO sub-page**: `/settings/sso` for SAML/OIDC configuration

---

## Lock Card Pattern

When `ENABLE_PROVIDER_ORGS=false`, the Consultants and Payouts pages display a lock card instead of their normal content:

```
+------------------------------------------------------+
|  [Lock icon]  Provider tier required                 |
|                                                       |
|  Payouts are available once your organization joins   |
|  the Provider tier. Contact us to enable it.          |
+------------------------------------------------------+
```

The detection mechanism:
1. Page fetches data from the API (e.g., `GET /api/organizations/[orgId]/payouts`)
2. API returns `{ error: "...", flag: "ENABLE_PROVIDER_ORGS" }` with status 501
3. Dashboard checks `res.status === 501` and inspects the `flag` field
4. If `flag` is present, renders the lock card instead of the normal view

This pattern ensures the sidebar links can remain visible (for discoverability) while clearly communicating that the feature requires a tier upgrade.

---

## Org Creation Wizard

The org creation flow at `/dashboard/organization/create` has a variable number of steps depending on org kind:

- **BUYER** — 5 steps: Org Info → Billing & Seats → Branding → Invite Team → Review
- **PROVIDER** — 5 steps: Org Info → Revenue Rates → Branding → Invite Team → Review (`billingMode` is omitted from the POST)
- **HYBRID** — 6 steps: Org Info → Billing & Seats → Revenue Rates → Branding → Invite Team → Review

| Step | Kind | Name | Fields |
|------|------|------|--------|
| 1 | All | OrgInfo | Name, slug, description, industry, size bucket, kind selector |
| 2 | BUYER, HYBRID | Billing & Seats | Billing email, billing mode (TAG_ONLY / SEAT_PACK / INVOICED_MONTHLY), seats |
| 2 (PROVIDER) / 3 (HYBRID) | PROVIDER, HYBRID | Revenue Rates | Platform commission %, org retain %, consultant payout % — must sum to 100% |
| 3/4 | All | Branding | Logo upload, primary color, secondary color |
| 4/5 | All | InviteTeam | Email addresses (comma/newline separated), role selector |
| 5/6 | All | Review | Summary of all fields, "Create Organization" button |

The `RevenueRatesStep` component renders three percentage inputs with a live sum validator; the "Next" button is disabled until all three values sum to exactly 100%.

When `ENABLE_PROVIDER_ORGS=false`, PROVIDER and HYBRID options are hidden from the kind selector in Step 1.

**Types file**: `app/dashboard/organization/create/types.ts`

---

## Key Files

| File | Purpose |
|------|---------|
| `app/dashboard/organization/[orgId]/layout.tsx` | Sidebar, role gating, org data fetch |
| `app/dashboard/organization/[orgId]/home/page.tsx` | Overview dashboard |
| `app/dashboard/organization/[orgId]/payouts/page.tsx` | Payouts page with lock card |
| `app/dashboard/organization/create/types.ts` | Wizard step types |
| `components/dashboard/CollapsibleSidebar.tsx` | Shared sidebar component |
| `components/dashboard/StatCard.tsx` | Stat card component |
| `app/dashboard/organization/[orgId]/useOrgRole.ts` | `useOrgRole` hook (`isAtLeast` helper) |
