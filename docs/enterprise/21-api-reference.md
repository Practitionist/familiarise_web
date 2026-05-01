# API reference

Every enterprise-layer HTTP endpoint, exhaustively. Roles are the
*minimum* required role — higher-rank roles and platform admins
always pass. Audit actions are the string literals emitted by the
route on success; rows land in `OrgAuditLog` with the category shown
in parentheses. Constants live in `lib/enterprise/audit-actions.ts`.

## Top-level collection

| Path | Verb | Min role | Purpose | Audit actions |
|------|------|----------|---------|----------------|
| `/api/organizations` | `GET` | authenticated | List the caller's orgs (switcher feed) | — |
| `/api/organizations` | `POST` | authenticated | Create org + BillingAccount + OWNER Membership. Also upserts an `OrgWorkspaceProfile` for the creator (so they become "an operator of at least one org") and returns `orgWorkspaceProfileId` on the response. | `MEMBER_ADDED` (MEMBER) |
| `/api/organizations/invitations/accept` | `POST` | authenticated | Accept an invite via token. Side-effects: LEARNER invites lazily upsert a `ConsulteeProfile` (via `ensureConsulteeProfile`); EXPERT invites upsert a placeholder `ConsultantProfile` (`Domain "General"`, `scheduleType = WEEKLY`, `verificationStatus = PENDING_VERIFICATION`) if the user doesn't already have one. | `INVITE_ACCEPTED` (MEMBER) |

## Org record

| Path | Verb | Min role | Purpose | Audit actions |
|------|------|----------|---------|----------------|
| `/api/organizations/[orgId]` | `GET` | LEARNER | Full org record + counts | — |
| `/api/organizations/[orgId]` | `PATCH` | OWNER | Branding + policy + capability flips | `SETTINGS_CHANGED` (SETTINGS) |
| `/api/organizations/[orgId]` | `DELETE` | OWNER | Hard-delete (refused if any refs exist) | — |
| `/api/organizations/[orgId]/branding/[asset]` | `POST` | OWNER | Upload logo or banner image (multipart `file`; `asset` = `logo` \| `banner`) | `SETTINGS_CHANGED` (SETTINGS) |
| `/api/organizations/[orgId]/branding/[asset]` | `DELETE` | OWNER | Remove logo or banner image (`asset` = `logo` \| `banner`) | `SETTINGS_CHANGED` (SETTINGS) |
| `/api/organizations/[orgId]/settings` | `GET` | MANAGER | Thin settings projection | — |
| `/api/admin/organizations/[orgId]/verify` | `POST` | platform ADMIN | Transition status (VERIFY / SUSPEND / REACTIVATE / DEACTIVATE) | `VERIFIED` / `SUSPENDED` / `REACTIVATED` / `DEACTIVATED` (SYSTEM) |

## Members and invitations

| Path | Verb | Min role | Purpose | Audit actions |
|------|------|----------|---------|----------------|
| `/api/organizations/[orgId]/members` | `GET` | active member | Paginated list; `?role=` / `?status=` / `?q=` | — |
| `/api/organizations/[orgId]/members` | `POST` | MAINTAINER | Direct add (idempotent on userId). If the userId matches a `REMOVED` membership the row is reactivated, with the same `LEARNER ↔ EXPERT` transition guard applied (`409 ROLE_TRANSITION_BLOCKED` on violation). | `MEMBER_ADDED` / `MEMBER_REACTIVATED` (MEMBER) |
| `/api/organizations/[orgId]/members/[memberId]` | `GET` | MAINTAINER | Full member record | — |
| `/api/organizations/[orgId]/members/[memberId]` | `PATCH` | MAINTAINER | Role / status / departmentLabel / payoutRecipient. Returns `409 ROLE_TRANSITION_BLOCKED` if the caller tries to flip LEARNER ↔ EXPERT (`lib/enterprise/role-transitions.ts`). | `ROLE_CHANGE` / `STATUS_CHANGE` (MEMBER) |
| `/api/organizations/[orgId]/members/[memberId]` | `DELETE` | MAINTAINER | Set `status = REMOVED` | `MEMBER_REMOVED` (MEMBER) |
| `/api/organizations/[orgId]/invitations` | `GET` | MAINTAINER | Pending + accepted + revoked invites | — |
| `/api/organizations/[orgId]/invitations` | `POST` | MAINTAINER | Send invite | `INVITE_SENT` (MEMBER) |
| `/api/organizations/[orgId]/invitations/[invitationId]` | `GET` | MAINTAINER | Invite detail | — |
| `/api/organizations/[orgId]/invitations/[invitationId]` | `DELETE` | MAINTAINER | Revoke | `INVITE_REVOKED` (MEMBER) |

## Contracts

| Path | Verb | Min role | Purpose | Audit actions |
|------|------|----------|---------|----------------|
| `/api/organizations/[orgId]/contracts` | `GET` | MAINTAINER | List with `?status=` filter | — |
| `/api/organizations/[orgId]/contracts` | `POST` | OWNER | Create DRAFT/ACTIVE contract | `CONTRACT_CREATED` (CONTRACT) |
| `/api/organizations/[orgId]/contracts/[contractId]` | `GET` | MAINTAINER | Contract detail + programs | — |
| `/api/organizations/[orgId]/contracts/[contractId]` | `PATCH` | OWNER | Status transitions + terms | `CONTRACT_SIGNED` / `CONTRACT_TERMINATED` (CONTRACT) |
| `/api/organizations/[orgId]/contracts/[contractId]` | `DELETE` | OWNER | DRAFT-only hard delete | — |

## Programs and assignments

| Path | Verb | Min role | Purpose | Audit actions |
|------|------|----------|---------|----------------|
| `/api/organizations/[orgId]/programs` | `GET` | active member | List programs for org | — |
| `/api/organizations/[orgId]/programs` | `POST` | MAINTAINER | Create LICENSED_SEAT or CREDIT_POOL program | `PROGRAM_CREATED` (PROGRAM) |
| `/api/organizations/[orgId]/programs/[programId]` | `GET` | active member | Program detail | — |
| `/api/organizations/[orgId]/programs/[programId]` | `PATCH` | MAINTAINER | Config update + pause/resume | `PROGRAM_PAUSED` (PROGRAM) |
| `/api/organizations/[orgId]/programs/[programId]` | `DELETE` | MAINTAINER | Cancel (soft if assignments exist) | — |
| `/api/organizations/[orgId]/programs/[programId]/assignments` | `GET` | active member | List assignments | — |
| `/api/organizations/[orgId]/programs/[programId]/assignments` | `POST` | MAINTAINER | Upsert assignment for a membership | `PROGRAM_ASSIGNED` (PROGRAM) |
| `/api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]` | `GET` | active member | Assignment detail + utilizations | — |
| `/api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]` | `PATCH` | MAINTAINER | Period / engagementsUsed reconciliation | — |
| `/api/organizations/[orgId]/programs/[programId]/assignments/[assignmentId]` | `DELETE` | MAINTAINER | Remove assignment | `PROGRAM_UNASSIGNED` (PROGRAM) |

## Billing account

| Path | Verb | Min role | Purpose | Audit actions |
|------|------|----------|---------|----------------|
| `/api/organizations/[orgId]/billing-account` | `GET` | MANAGER | Account summary + balance + creditLimit | — |
| `/api/organizations/[orgId]/billing-account` | `PATCH` | OWNER | Change billingEmail / fundingSource (guarded) | `SETTINGS_CHANGED` (SETTINGS) |
| `/api/organizations/[orgId]/billing-account/wallet` | `GET` | MANAGER | WalletEntry history | — |
| `/api/organizations/[orgId]/billing-account/wallet/top-ups` | `GET` | MANAGER | List top-ups (pending + confirmed) | — |
| `/api/organizations/[orgId]/billing-account/wallet/top-ups` | `POST` | OWNER | Mint Razorpay order for a wallet top-up; the webhook (`notes.type=wallet_topup`) credits `WalletEntry.deltaPaise` idempotently | `WALLET_TOPUP` (WALLET) — `WALLET_TOPUP_CONFIRMED` is emitted by the webhook |
| `/api/organizations/[orgId]/billing-account/wallet/top-ups/[topUpId]` | `GET` | MANAGER | Top-up detail; `topUpId` is the wallet-entry idempotency key (`we_<uuid>`), not the Razorpay order id | — |

## Invoices and purchase orders

| Path | Verb | Min role | Purpose | Audit actions |
|------|------|----------|---------|----------------|
| `/api/organizations/[orgId]/billing-account/invoices` | `GET` | MANAGER | List with `?status=` filter | — |
| `/api/organizations/[orgId]/billing-account/invoices` | `POST` | OWNER | Manual invoice. Dashboard composer defaults `dueDate` to NET-60 and posts `issueImmediately: true` so the row lands as `ISSUED` in a single call. | `INVOICE_GENERATED` (INVOICE) |
| `/api/organizations/[orgId]/billing-account/invoices/[invoiceId]` | `GET` | MANAGER | Invoice detail | — |
| `/api/organizations/[orgId]/billing-account/invoices/[invoiceId]` | `PATCH` | OWNER | Status transitions (DRAFT→ISSUED, DRAFT→CANCELLED, ISSUED/OVERDUE→VOID) | `INVOICE_ISSUED` / `INVOICE_CANCELLED` / `INVOICE_VOIDED` (INVOICE) |
| `/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay` | `POST` | OWNER | Mint Razorpay order for the invoice; the webhook (`notes.type=invoice_payment`) flips ISSUED→PAID and writes the SettlementLedgerEntry | `INVOICE_PAYMENT_INITIATED` (INVOICE) — `INVOICE_PAID` is emitted by the webhook |
| `/api/organizations/[orgId]/billing-account/purchase-orders` | `GET` | MANAGER | List POs | — |
| `/api/organizations/[orgId]/billing-account/purchase-orders` | `POST` | OWNER | Create PO | `PURCHASE_ORDER_CREATED` (INVOICE) |
| `/api/organizations/[orgId]/billing-account/purchase-orders/[poId]` | `GET` | MANAGER | PO detail + linked invoices | — |
| `/api/organizations/[orgId]/billing-account/purchase-orders/[poId]` | `PATCH` | OWNER | Update PO metadata | — |
| `/api/organizations/[orgId]/billing-account/purchase-orders/[poId]` | `DELETE` | OWNER | Cancel PO (if unused) | — |

## Rate cards, earnings, payouts (host side)

| Path | Verb | Min role | Purpose | Audit actions |
|------|------|----------|---------|----------------|
| `/api/organizations/[orgId]/rate-cards` | `GET` | MANAGER | Effective cards + history | — |
| `/api/organizations/[orgId]/rate-cards` | `POST` | OWNER | Create / bump a card (atomic two-step) | `RATE_CARD_BUMPED` (PROGRAM) |
| `/api/organizations/[orgId]/rate-cards/[cardId]` | `GET` | MANAGER | Card detail | — |
| `/api/organizations/[orgId]/rate-cards/[cardId]` | `PATCH` | OWNER | Close (set `effectiveTo`) | — |
| `/api/organizations/[orgId]/payout-account` | `GET` | MANAGER | Account summary + last4 | — |
| `/api/organizations/[orgId]/payout-account` | `PUT` | OWNER | Replace account (encrypted at rest) | `SETTINGS_CHANGED` (SETTINGS) |
| `/api/organizations/[orgId]/earnings` | `GET` | MANAGER | List OrganizationEarnings rows | — |
| `/api/organizations/[orgId]/payouts` | `GET` | MANAGER | List OrganizationPayouts | — |
| `/api/organizations/[orgId]/payouts` | `POST` | OWNER | Roll up earnings → PayoutCycle | `PAYOUT_INITIATED` (PAYOUT) |
| `/api/organizations/[orgId]/payouts/[payoutId]` | `GET` | MANAGER | Payout detail + earnings list | — |
| `/api/organizations/[orgId]/payouts/[payoutId]` | `PATCH` | OWNER | Flip to PROCESSED / FAILED | `PAYOUT_PROCESSED` / `PAYOUT_FAILED` (PAYOUT) |

## SSO and domains

| Path | Verb | Min role | Purpose | Audit actions |
|------|------|----------|---------|----------------|
| `/api/organizations/[orgId]/sso` | `GET` | MANAGER | Settings read | — |
| `/api/organizations/[orgId]/sso` | `PATCH` | OWNER | allowedEmailDomains / enforceSSO / defaultRoleForAutoJoin | `SSO_ENABLED` / `SSO_DISABLED` (SETTINGS) |
| `/api/organizations/[orgId]/sso/providers` | `GET` | MANAGER | List providers | — |
| `/api/organizations/[orgId]/sso/providers` | `POST` | OWNER | Add SAML/OIDC provider | `SSO_ENABLED` (SETTINGS) |
| `/api/organizations/[orgId]/sso/providers/[providerId]` | `GET` | MANAGER | Provider detail. Response includes a derived `providerType` of `SAML` or `OIDC`, inferred from whether `samlConfig` or `oidcConfig` is populated on the row. | — |
| `/api/organizations/[orgId]/sso/providers/[providerId]` | `DELETE` | OWNER | Remove provider | `SSO_DISABLED` (SETTINGS) |
| `/api/organizations/[orgId]/domain-claims` | `GET` | MANAGER | List claims | — |
| `/api/organizations/[orgId]/domain-claims` | `POST` | OWNER | Claim domain | `DOMAIN_CLAIMED` (SETTINGS) |
| `/api/organizations/[orgId]/domain-claims/[domain]` | `DELETE` | OWNER | Release claim | `DOMAIN_RELEASED` (SETTINGS) |

## HRIS and consent

| Path | Verb | Min role | Purpose | Audit actions |
|------|------|----------|---------|----------------|
| `/api/organizations/[orgId]/hris` | `GET` | MANAGER | Config summary | — |
| `/api/organizations/[orgId]/hris` | `PUT` | OWNER | Upsert provider + tenantKey | `SETTINGS_CHANGED` (SETTINGS) |
| `/api/organizations/[orgId]/hris` | `DELETE` | OWNER | Disable HRIS | `SETTINGS_CHANGED` (SETTINGS) |
| `/api/organizations/[orgId]/hris/sync` | `GET` | MANAGER | Sync job history | — |
| `/api/organizations/[orgId]/hris/sync` | `POST` | OWNER | Kick a sync job | `HRIS_SYNC_STARTED` (SYSTEM) |
| `/api/organizations/[orgId]/hris/csv-upload` | `POST` | OWNER | CSV fallback sync | `HRIS_SYNC_STARTED` / `HRIS_SYNC_COMPLETED` (SYSTEM) |
| `/api/organizations/[orgId]/consent` | `GET` | MANAGER | ConsentArtifact roster | — |
| `/api/organizations/[orgId]/consent` | `POST` | MANAGER | Record a grant / withdrawal. `userId` is validated as a non-empty string (1–128 chars) because `User.id` is a `cuid()`, not a UUID. | `CONSENT_GRANTED` / `CONSENT_WITHDRAWN` (CONSENT) |

## Catalog, analytics, activity

| Path | Verb | Min role | Purpose | Audit actions |
|------|------|----------|---------|----------------|
| `/api/organizations/[orgId]/catalog` | `GET` | MANAGER | List OrganizationPlan rows | — |
| `/api/organizations/[orgId]/catalog` | `POST` | OWNER | Create a plan | — |
| `/api/organizations/[orgId]/catalog` | `DELETE` | OWNER | Bulk deactivate (`{ planIds[] }`) | — |
| `/api/organizations/[orgId]/catalog/search` | `GET` | active member | ILIKE search | — |
| `/api/organizations/[orgId]/analytics` | `GET` | MANAGER | Rollups (bookings, revenue, earnings, wallet burn) | — |
| `/api/organizations/[orgId]/activity` | `GET` | MANAGER | OrgAuditLog feed (filterable by category/date) | — |

## Retired audit actions

The Arch-4 refactor removed the in-org "apply to deliver" workflow. The
following action strings are no longer emitted and have been deleted
from `lib/enterprise/audit-actions.ts`:

- `EXPERT_APPLIED`
- `EXPERT_APPROVED`
- `EXPERT_REJECTED`

EXPERT entry is now invite-driven (or direct admin add); see
`06-expert-lifecycle.md`. The corresponding `Membership` columns
(`applicationNote`, `appliedAt`, `approvedAt`, `approvedBy`) were
dropped in the same cycle — any doc referencing those is stale.

## Invariants across the table

- Every mutating route writes an `OrgAuditLog` row in the same Prisma
  transaction as its business-logic mutation. Action strings live in
  `lib/enterprise/audit-actions.ts` and the corresponding `category`
  is always one of the nine `OrgAuditCategory` values.
- Every route gates on `requireOrgAccess(orgId, minRole)` or
  `requireOrgOwner(orgId)` from `lib/auth-helpers.ts`. Platform admins
  bypass the gate and get a synthesised OWNER stub Membership.
- Every body is parsed through a Zod schema before it reaches Prisma.
  No handler uses `as` casts to narrow. Invalid bodies return 400
  with the flattened error.
- Cross-tenant id theft is rejected at the handler, not at the FK
  layer. Routes that accept a nested id (e.g. `billingAccountId` in
  POST /contracts, `contractId` in POST /programs) verify ownership
  against the outer `orgId` before writing.

## Related docs

- `04-roles-and-permissions.md` — full rank ladder and the rationale
  for OWNER-vs-MAINTAINER splits on sensitive routes.
- `22-route-migration-table.md` — old-route → new-route map for
  anyone porting code from a pre-Arch-4 branch.
