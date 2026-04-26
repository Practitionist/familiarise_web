# Route migration table

Map every pre-Arch-4 enterprise API route to its current home. Rows
with "removed" in the "Now" column have no successor — the capability
moved to a different surface or the feature was rolled up into an
existing route.

## Core org record

| Old | Now | Notes |
|-----|-----|-------|
| `GET/PATCH/DELETE /api/organizations/[orgId]` | same | Model merged (OrganizationProfile is gone); response shape changed (capability booleans instead of `kind`). |
| `GET /api/organizations/[orgId]/profile` | **removed** | OrganizationProfile merged into Organization. Use `/api/organizations/[orgId]`. |

## Billing / wallet / credits

| Old | Now | Notes |
|-----|-----|-------|
| `GET /api/organizations/[orgId]/billing` | `GET /api/organizations/[orgId]/billing-account` | `billingMode` replaced by `BillingAccount.fundingSource`. |
| `PATCH /api/organizations/[orgId]/billing` | `PATCH /api/organizations/[orgId]/billing-account` | — |
| `GET /api/organizations/[orgId]/credits` | `GET /api/organizations/[orgId]/billing-account/wallet` | `OrgCreditPool` → `BillingAccount.walletBalance`. |
| `POST /api/organizations/[orgId]/credits/purchase` | `POST /api/organizations/[orgId]/billing-account/wallet/top-ups` | `OrgCreditPurchase` → `WalletEntry(reason=TOPUP)` keyed by `providerOrderId @unique`. |
| `GET /api/organizations/[orgId]/credits/ledger` | `GET /api/organizations/[orgId]/billing-account/wallet` | `OrgCreditLedger` → `WalletEntry` + `FundingLedgerEntry`. Response includes both. |
| `GET /api/organizations/[orgId]/credits/purchases` | `GET /api/organizations/[orgId]/billing-account/wallet/top-ups` | — |
| `GET /api/organizations/[orgId]/credits/purchases/[id]` | `GET /api/organizations/[orgId]/billing-account/wallet/top-ups/[topUpId]` | — |

## Invoices + POs

| Old | Now | Notes |
|-----|-----|-------|
| `GET /api/organizations/[orgId]/invoices` | `GET /api/organizations/[orgId]/billing-account/invoices` | — |
| `POST /api/organizations/[orgId]/invoices` | `POST /api/organizations/[orgId]/billing-account/invoices` | — |
| `GET/PATCH /api/organizations/[orgId]/invoices/[invoiceId]` | `GET/PATCH /api/organizations/[orgId]/billing-account/invoices/[invoiceId]` | — |
| `POST /api/organizations/[orgId]/invoices/[invoiceId]/pay` | `POST /api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay` | Writes `SettlementLedgerEntry(kind=INVOICE_PAID)`. |
| `GET /api/organizations/[orgId]/purchase-orders` | `GET /api/organizations/[orgId]/billing-account/purchase-orders` | — |
| `POST /api/organizations/[orgId]/purchase-orders` | `POST /api/organizations/[orgId]/billing-account/purchase-orders` | — |
| `GET/PATCH/DELETE /api/organizations/[orgId]/purchase-orders/[poId]` | `GET/PATCH/DELETE /api/organizations/[orgId]/billing-account/purchase-orders/[poId]` | — |

## Contracts and programs

| Old | Now | Notes |
|-----|-----|-------|
| `GET /api/organizations/[orgId]/contract` | **removed** | Multiple contracts per org now; use `GET /contracts` list. |
| `PATCH /api/organizations/[orgId]/contract` | **removed** | — |
| _(new)_ | `GET/POST /api/organizations/[orgId]/contracts` | — |
| _(new)_ | `GET/PATCH/DELETE /api/organizations/[orgId]/contracts/[contractId]` | — |
| `GET /api/organizations/[orgId]/seats` | **removed** | Seats replaced by `Program` + `ProgramAssignment`. |
| _(new)_ | `GET/POST /api/organizations/[orgId]/programs` | — |
| _(new)_ | `GET/PATCH/DELETE /api/organizations/[orgId]/programs/[programId]` | — |
| _(new)_ | `GET/POST /api/organizations/[orgId]/programs/[programId]/assignments` | — |

## Members and consultants

| Old | Now | Notes |
|-----|-----|-------|
| `GET/POST /api/organizations/[orgId]/members` | same | Role vocabulary is `OWNER / MAINTAINER / MANAGER / EXPERT / LEARNER / SUPPORT`. Strings crossing the API boundary are narrowed with `MemberRoleSchema` (lib/labels/org-labels.ts); no legacy aliases accepted. |
| `GET/PATCH/DELETE /api/organizations/[orgId]/members/[memberId]` | same | — |
| `GET /api/organizations/[orgId]/consultants` | `GET /api/organizations/[orgId]/members?role=EXPERT` | Role filter on the unified `/members` endpoint. |
| `GET /api/organizations/[orgId]/learners` | `GET /api/organizations/[orgId]/members?role=LEARNER` | — |
| `POST /api/organizations/[orgId]/consultants/[consultantId]/approve` | **removed** | The Arch-4 refactor dropped the in-org "apply to deliver" workflow. EXPERT entry is now invite-driven (see `06-expert-lifecycle.md`); there is no approval step on the Membership row. `Membership.applicationNote / appliedAt / approvedAt / approvedBy` are gone, and `EXPERT_APPLIED / EXPERT_APPROVED / EXPERT_REJECTED` audit actions were deleted. |
| `POST /api/organizations/[orgId]/consultants/[consultantId]/reject` | `DELETE /api/organizations/[orgId]/members/[memberId]` | Use member removal (`status = REMOVED`) instead of reject; there is no pending-expert queue anymore. |

## Earnings / payouts / rate cards

| Old | Now | Notes |
|-----|-----|-------|
| `GET /api/organizations/[orgId]/earnings` | same | Response fields snapshotted: `rateCardIdApplied`, `platformBpsApplied`, etc. |
| `GET /api/organizations/[orgId]/payouts` | same | — |
| `POST /api/organizations/[orgId]/payouts` | same | Now OWNER (was MANAGER). |
| `GET/PATCH /api/organizations/[orgId]/payouts/[payoutId]` | same | — |
| `GET /api/organizations/[orgId]/payout-account` | same | — |
| `PUT /api/organizations/[orgId]/payout-account` | same | — |
| `GET /api/organizations/[orgId]/rate-card` | `GET /api/organizations/[orgId]/rate-cards` | Plural; multiple cards with `effectiveFrom/To`. |
| `PATCH /api/organizations/[orgId]/rate-card` | `POST /api/organizations/[orgId]/rate-cards` | "Patching" is now an append (new card with new bps + close old one). |

## SSO

| Old | Now | Notes |
|-----|-----|-------|
| `GET/PATCH /api/organizations/[orgId]/sso` | same | Response shape unchanged; `defaultRoleForAutoJoin` now values `MemberRole`. |
| `GET/POST /api/organizations/[orgId]/sso/providers` | same | — |
| `GET/DELETE /api/organizations/[orgId]/sso/providers/[providerId]` | same | — |
| `POST /api/organizations/[orgId]/sso/providers/[providerId]/verify` | **removed** | Verification is handled inline by BetterAuth's SSO plugin on first sign-in. |
| `GET /api/organizations/[orgId]/sso/domain-claims` | `GET /api/organizations/[orgId]/domain-claims` | Same location, kept for parity. |

## Plans + catalog

| Old | Now | Notes |
|-----|-----|-------|
| `GET /api/organizations/[orgId]/plans` | `GET /api/organizations/[orgId]/catalog` | Collection moved. The pre-Arch-4 per-plan CRUD (`.../plans/[planId]`) was deleted in `2b9da181` (no 501 stub left behind); it returns when the plan refactor PR ships. |
| `POST /api/organizations/[orgId]/plans` | `POST /api/organizations/[orgId]/catalog` | — |
| `DELETE /api/organizations/[orgId]/plans` | `DELETE /api/organizations/[orgId]/catalog` | Bulk deactivate. |
| `GET /api/organizations/[orgId]/plans/search` | `GET /api/organizations/[orgId]/catalog/search` | — |

## HRIS, consent, analytics, activity

| Old | Now | Notes |
|-----|-----|-------|
| _(new)_ | `GET/PUT/DELETE /api/organizations/[orgId]/hris` | — |
| _(new)_ | `GET/POST /api/organizations/[orgId]/hris/sync` | — |
| _(new)_ | `POST /api/organizations/[orgId]/hris/csv-upload` | — |
| _(new)_ | `GET/POST /api/organizations/[orgId]/consent` | DPDP artifact roster. |
| _(new)_ | `GET /api/organizations/[orgId]/analytics` | Rollups. |
| _(new)_ | `GET /api/organizations/[orgId]/activity` | OrgAuditLog feed. |

## Admin

| Old | Now | Notes |
|-----|-----|-------|
| `POST /api/admin/organizations/[orgId]/status` | `POST /api/admin/organizations/[orgId]/verify` | One route handles `VERIFY / SUSPEND / REACTIVATE / DEACTIVATE`. |
| `POST /api/admin/organizations/[orgId]/verify-consultants` | **removed** | Consultant verification is a separate flow on `ConsultantProfile.verificationStatus`. |

## Removed outright

- `GET /api/organizations/[orgId]/credits/pool` — `OrgCreditPool` is
  gone; use `BillingAccount.walletBalance` via `/billing-account`.
- Any route that referenced `OrganizationProfile.*` columns — merged
  into `Organization` directly.
- Any route that emitted the old `OrgAuditAction` enum value — the
  column is now a free-form string, values come from
  `lib/enterprise/audit-actions.ts`.

## Related docs

- `21-api-reference.md` — the live route table with min-roles and
  audit actions.
- `04-roles-and-permissions.md` — role catalog + the `MemberRoleSchema`
  narrowing pattern at the API boundary.
- `09-wallet-and-ledger.md` — credit-pool → wallet migration.
