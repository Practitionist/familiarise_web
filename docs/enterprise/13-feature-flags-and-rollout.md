# Feature Flags and Rollout

**Status**: Active (Apr 2026)
**Branch**: `feature/enterprise`
**Scope**: PROVIDER and HYBRID org gating

## Overview

A single feature flag, `ENABLE_PROVIDER_ORGS`, controls whether PROVIDER and HYBRID organization functionality is available. The flag is a deployment-time environment variable (not a runtime toggle), read from `process.env` at module load time. All checks across the codebase import from a single source file: `lib/feature-flags.ts`.

---

## ENABLE_PROVIDER_ORGS

### What It Is

```
// lib/feature-flags.ts (entire file)

export const ENABLE_PROVIDER_ORGS =
  process.env.ENABLE_PROVIDER_ORGS === "true";
```

- **Type**: Boolean (string comparison against `"true"`)
- **Default**: `false`
- **Requires redeploy to change**: Yes, intentionally

### Why Deployment-Time (Not Runtime)

Flipping a billing-affecting flag mid-stream creates a compliance nightmare:

```
Timeline when runtime flip goes wrong:

  10:01 AM  Payment A processed  -->  2-way split (BUYER logic)
  10:02 AM  Flag flipped to true
  10:03 AM  Payment B processed  -->  3-way split (PROVIDER logic)

  Result: Two payments from the same org, same day, different
  revenue splits. GST filings become inconsistent. TDS records
  show conflicting rates. Reconciliation is manual and painful.
```

By requiring a redeploy, the flag change is atomic and auditable -- every payment after the deploy uses the same split logic.

---

## What's Gated

### API Routes

| Feature | Endpoint | Behavior When Off |
|---------|----------|-------------------|
| PROVIDER org creation | `POST /api/organizations` (kind=PROVIDER) | 501 |
| HYBRID org creation | `POST /api/organizations` (kind=HYBRID) | 501 |
| ORG_CONSULTANT role assignment | `POST /api/organizations/[orgId]/members` | 501 |
| ORG_SUPPORT role assignment | `POST /api/organizations/[orgId]/members` | 501 |
| ORG_CONSULTANT invitation | `POST /api/organizations/[orgId]/invitations` | 501 |
| ORG_SUPPORT invitation | `POST /api/organizations/[orgId]/invitations` | 501 |
| Invitation acceptance (consultant/support) | `POST /api/organizations/invitations/accept` | 501 |
| Role change to consultant/support | `PATCH /api/organizations/[orgId]/members/[memberId]` | 501 |
| Consultant listing | `GET /api/organizations/[orgId]/consultants` | 501 |
| Consultant approval | `POST /api/organizations/[orgId]/consultants` | 501 |
| Consultant application | `POST /api/organizations/[orgId]/consultants/apply` | 501 |
| Payouts list | `GET /api/organizations/[orgId]/payouts` | 501 |
| Payout batch creation | `POST /api/organizations/[orgId]/payouts` | 501 |
| Payout account | `GET/PUT/DELETE /api/organizations/[orgId]/payout-account` | 501 |
| Admin payout processing | `POST /api/admin/org-payouts/process` | 501 |
| Rate validation | `PATCH /api/organizations/[orgId]` (rate fields) | 501 |
| Plan consultant assignment (PROVIDER org) | `POST/PATCH /api/organizations/[orgId]/plans/[planId]` | 501 |

All 501 responses include the flag name in the response body for debugging:

```json
{
  "error": "PROVIDER organization consultants are not yet available.",
  "flag": "ENABLE_PROVIDER_ORGS"
}
```

### Earnings Split

In `lib/payments/payouts/earnings-service.ts`, the `resolveOrgSplit()` function returns `null` when the flag is off:

```
if (!ENABLE_PROVIDER_ORGS) return null;
```

This means all payments use the standard 2-way split (platform fee + consultant) regardless of the consultant's org membership. No `OrganizationEarnings` rows are created.

### Dashboard UI

| Element | Behavior When Off |
|---------|-------------------|
| Sidebar: Consultants link | Hidden (isProviderOrHybrid evaluates to false for BUYER orgs) |
| Sidebar: Payouts link | Hidden |
| Consultants page | Shows lock card (API returns 501 with flag) |
| Payouts page | Shows lock card |
| Org create wizard: Kind selector | PROVIDER and HYBRID options hidden |

---

## How to Flip

### Steps

1. Set `ENABLE_PROVIDER_ORGS=true` in the deployment environment (Netlify/Vercel env vars)
2. Redeploy the application
3. Run the verification checklist below

### Verification Checklist

After flipping the flag, verify each gated feature works:

- [ ] `POST /api/organizations` with `kind: "PROVIDER"` returns 201 (not 501)
- [ ] `POST /api/organizations` with `kind: "HYBRID"` returns 201 (not 501)
- [ ] `POST /api/organizations/[orgId]/members` with `role: "ORG_CONSULTANT"` returns 201
- [ ] `GET /api/organizations/[orgId]/consultants` returns 200 with empty array
- [ ] `GET /api/organizations/[orgId]/payouts` returns 200 with empty array
- [ ] `GET /api/organizations/[orgId]/payout-account` returns 200 with null account
- [ ] Dashboard sidebar shows Consultants and Payouts links for PROVIDER orgs
- [ ] Org create wizard shows PROVIDER and HYBRID kind options
- [ ] A test booking through a PROVIDER org consultant creates both `ConsultantEarnings` and `OrganizationEarnings` rows
- [ ] `POST /api/admin/org-payouts/process` returns 200 (not 501)

---

## Rollout Strategy

```
Phase 1: Development (current)
  ENABLE_PROVIDER_ORGS=true in local .env
  All PROVIDER code paths testable

Phase 2: Staging validation
  Flip flag in staging environment
  End-to-end test with seed PROVIDER org
  Verify 3-way split, payout batch, public page

Phase 3: Production launch
  First PROVIDER customer identified
  Flip flag in production
  Monitor: OrganizationEarnings rows created correctly
  Monitor: Payout batch settlement amounts match

Phase 4: Steady state
  Flag stays true permanently
  Future: remove flag checks (code cleanup, Issue #646)
```

No schema migration is needed when flipping the flag -- all PROVIDER models (`OrganizationPayout`, `OrganizationPayoutAccount`, `OrganizationEarnings`, `ORG_CONSULTANT` role) already exist in the database. The flag only controls API-layer and UI-layer access.

---

## Key Files

| File | Purpose |
|------|---------|
| `lib/feature-flags.ts` | Single source of truth (entire flag definition) |
| `lib/payments/payouts/earnings-service.ts` | `resolveOrgSplit()` guard |
| `app/api/organizations/route.ts` | PROVIDER/HYBRID creation gate |
| `app/api/organizations/[orgId]/consultants/route.ts` | Consultant listing/approval gate |
| `app/api/organizations/[orgId]/payouts/route.ts` | Payouts gate |
| `app/api/organizations/[orgId]/payout-account/route.ts` | Payout account gate |
| `app/api/organizations/[orgId]/members/route.ts` | ORG_CONSULTANT/ORG_SUPPORT role gate |
| `app/api/organizations/[orgId]/invitations/route.ts` | Invitation role gate |
| `app/api/admin/org-payouts/process/route.ts` | Admin payout processing gate |
