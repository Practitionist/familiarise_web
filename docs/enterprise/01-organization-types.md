# Organization Types

**Status**: Implemented (Apr 2026)
**Branch**: `feature/enterprise`
**Scope**: `OrganizationKind` enum, dashboard visibility, feature gating

## Overview

Every organization on Familiarise has a `kind` field on its `OrganizationProfile` that determines its capabilities, billing options, dashboard sections, and available roles. There are three kinds: **BUYER** (companies sponsoring training for employees), **PROVIDER** (consulting agencies hosting freelance consultants), and **HYBRID** (both streams running independently). PROVIDER and HYBRID are gated by the `ENABLE_PROVIDER_ORGS` feature flag and require platform admin verification before activation.

---

## BUYER

A BUYER organization sponsors its employees or students to consume services on the platform. The org does not host consultants -- it pays for sessions delivered by independent consultants in the marketplace.

```
Money Flow (BUYER)
┌──────────┐                          ┌────────────────┐
│ Org Admin│──── purchases credits ──►│ OrgCreditPool  │
│ (Wipro)  │     or pays invoice      │ or Invoice     │
└──────────┘                          └───────┬────────┘
                                              │
                                              ▼
┌──────────┐    books session      ┌──────────────────┐
│ Employee │───────────────────────►│ Checkout         │
│ (Learner)│                       │ deducts credits / │
└──────────┘                       │ bills to invoice  │
                                   └────────┬─────────┘
                                            │
                               standard 80/20 split
                                            │
                              ┌─────────────┴──────────────┐
                              ▼                            ▼
                     ┌──────────────┐             ┌──────────────┐
                     │ Consultant   │             │ Platform     │
                     │ gets 80%     │             │ gets 20%     │
                     └──────────────┘             └──────────────┘
```

**Who uses it**: Corporates (Wipro, TCS), schools (DPS), bootcamps buying mentoring for students.

**Example**: Wipro buys a SEAT_PACK of 500 sessions. Employee Ravi opens the marketplace, books a React consultation, and the ₹2,000 fee is deducted from the org credit pool instead of his personal card.

**Available billing modes**: TAG_ONLY, SEAT_PACK, INVOICED_MONTHLY, PREPAID_UNLIMITED

**Available roles**: ORG_OWNER, ORG_ADMIN, ORG_MANAGER, ORG_LEARNER, ORG_SUPPORT

**Dashboard sections**: Overview, Members, Invitations, Learners, Plans, Credits (SEAT_PACK only), Billing, Analytics, Settings

---

## PROVIDER

A PROVIDER organization is a consulting agency that hosts multiple consultants. When a learner books with one of those consultants, the payment is split three ways: platform, org, and consultant.

```
Money Flow (PROVIDER)
┌──────────┐                          ┌────────────────┐
│ Learner  │──── pays ₹10,000 ──────►│ Checkout       │
│ (public) │                          └───────┬────────┘
└──────────┘                                  │
                                    3-way split (default rates)
                                              │
                          ┌───────────────────┼────────────────────┐
                          ▼                   ▼                    ▼
                 ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
                 │ Platform     │    │ Org (Agency)  │    │ Consultant   │
                 │ 10% = ₹1,000│    │ 5% = ₹500     │    │ 85% = ₹8,500│
                 └──────────────┘    └──────────────┘    └──────────────┘
```

**Who uses it**: Freelancer collectives, boutique consulting firms, tutoring agencies.

**Example**: "LearnPro Academy" hosts 12 tutors. Platform admin verifies the org, sets `status = ACTIVE`. Each tutor applies via `/api/organizations/[orgId]/consultants/apply` and is approved by an ORG_ADMIN. When a student books with tutor Priya, her ₹5,000 session is split: ₹500 platform, ₹250 LearnPro, ₹4,250 Priya.

**Feature flag**: `ENABLE_PROVIDER_ORGS` must be `true`. When `false`:
- POST `/api/organizations` rejects `kind === "PROVIDER"` with 501
- POST `/api/organizations/[id]/members` rejects `role === "ORG_CONSULTANT"` with 501
- Payout, payout-account, and consultant routes return 501
- Dashboard hides Consultants and Payouts nav items

**Requires**: Platform admin sets `status` from `PENDING_VERIFICATION` to `ACTIVE`.

**Available roles**: ORG_OWNER, ORG_ADMIN, ORG_MANAGER, ORG_CONSULTANT, ORG_SUPPORT

**Public page**: `/org/[slug]` -- org profile visible to the public, lists hosted consultants.

**Org badge**: Consultants belonging to a PROVIDER org show the org logo/name on their `/explore` card.

---

## HYBRID

A HYBRID organization combines both BUYER and PROVIDER capabilities. The two streams are independent -- a HYBRID org can sponsor its students to book external consultants (BUYER stream) while simultaneously hosting its own professors as consultants with revenue sharing (PROVIDER stream).

**Who uses it**: Universities, corporate training firms, research labs.

**Example**: IIT Bombay creates a HYBRID org:
- **BUYER stream**: Students (ORG_LEARNER) are assigned seats. The university pays for external mentoring sessions via INVOICED_MONTHLY.
- **PROVIDER stream**: Professor Sharma (ORG_CONSULTANT) teaches a public webinar. Revenue is split 3 ways: 10% platform, 5% IIT, 85% Prof. Sharma.

**Edge case**: A student and a professor from the same HYBRID org -- the student books a session with the professor. Both streams fire: the org's credit pool (or invoice) pays for the session, and the professor's earnings go through the 3-way split. The org effectively pays on one side and receives on the other.

---

## Decision Tree

```
"Which type do I need?"

Start
  │
  ├─► Does the org PAY for sessions consumed by its members?
  │     │
  │     ├─► Yes ──► Does the org also HOST consultants who earn revenue?
  │     │             │
  │     │             ├─► Yes ──► HYBRID
  │     │             │
  │     │             └─► No  ──► BUYER
  │     │
  │     └─► No  ──► Does the org HOST consultants who earn revenue?
  │                   │
  │                   ├─► Yes ──► PROVIDER
  │                   │
  │                   └─► No  ──► BUYER (TAG_ONLY — analytics only)
  │
  Scenarios:
  ┌────────────────────────────────────────────────────────────┐
  │ Wipro sponsors employee coaching          → BUYER         │
  │ LearnPro Academy hosts freelance tutors   → PROVIDER      │
  │ IIT with students and professors          → HYBRID        │
  │ StartupCo just wants usage analytics      → BUYER TAG_ONLY│
  └────────────────────────────────────────────────────────────┘
```

---

## Feature Comparison

| Feature | BUYER | PROVIDER | HYBRID |
|---------|-------|----------|--------|
| Billing modes (TAG_ONLY, SEAT_PACK, etc.) | All 4 | N/A | All 4 (BUYER stream) |
| Credit pool / invoicing | Yes | No | Yes |
| 3-way revenue split | No (standard 80/20) | Yes | Yes (PROVIDER stream) |
| Org payouts | No | Yes | Yes |
| OrganizationPayoutAccount | N/A | Required | Required |
| OrganizationEarnings rows | N/A | Created per payment | Created per payment |
| SSO / domain enforcement | Yes | Yes | Yes |
| ORG_LEARNER role | Yes | No | Yes |
| ORG_CONSULTANT role | No | Yes | Yes |
| Public page `/org/[slug]` | No | Yes | Yes |
| Org badge on `/explore` cards | No | Yes | Yes |
| `/explore/companies` listing | No | Yes | Yes |
| `enforceOrganizationPlans` | N/A | Yes (optional) | Yes (optional) |
| `autoApproveConsultants` | N/A | Yes (optional) | Yes (optional) |
| Requires admin verification | No | Yes | Yes |
| Feature flag gate | None | `ENABLE_PROVIDER_ORGS` | `ENABLE_PROVIDER_ORGS` |
| Dashboard: Learners page | Yes | No | Yes |
| Dashboard: Consultants page | No | Yes | Yes |
| Dashboard: Payouts page | No | Yes | Yes |
| Dashboard: Credits page | SEAT_PACK only | No | SEAT_PACK only |

---

## Schema

**File**: `prisma/schema.prisma` (line 542)

```
enum OrganizationKind {
  BUYER     // Schools, corporates, agencies buying for their employees/students
  PROVIDER  // Consultant agencies hosting multiple consultants (FEATURE-FLAGGED)
  HYBRID    // Both — covers university/training-firm scenarios (FEATURE-FLAGGED)
}
```

The `kind` field is set at org creation (POST `/api/organizations`) and is effectively immutable -- there is no migration path between kinds because each kind implies different financial models, role assignments, and payout accounts.

**How kind affects the dashboard sidebar**: The layout at `app/dashboard/organization/[orgId]/layout.tsx` computes two booleans from `kind`:

- `isBuyerOrHybrid` = BUYER or HYBRID -- shows Learners page
- `isProviderOrHybrid` = PROVIDER or HYBRID -- shows Consultants and Payouts pages

These booleans control which nav items render. The API layer enforces the same constraints independently, so hiding nav items is cosmetic safety, not the auth boundary.
