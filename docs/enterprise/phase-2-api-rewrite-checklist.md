# Phase 2b — API Route Rewrite Checklist

**Status:** Authoritative checklist for the follow-up PR that rehydrates
the 35 `@arch4-stub` routes (Issue #681).

## The Rules

1. **Schema is frozen.** No schema changes when rehydrating these
   routes; all fields are already in `prisma/schema.prisma`.
2. **Use the new helpers.** Every route must use the helpers shipped in
   Phase 1:
   - `lib/api/organizations/program-helpers.ts` (claim/release assignments)
   - `lib/api/organizations/wallet.ts` (debit/credit/topUp)
   - `lib/api/organizations/hierarchy.ts` (rootId / descendant ids)
   - `lib/auth-helpers.ts` (requireOrgAccess with new MemberRole)
   - `lib/compliance/**` (stubs, safe to call — return sensible defaults)
3. **Every write must produce a ledger entry.** Use
   `tx.usageLedgerEntry.create`, `tx.fundingLedgerEntry.create`, or
   `tx.settlementLedgerEntry.create` in the same transaction as the
   mutation. No exceptions — this is the foundation of audit/reconciliation.
4. **Idempotency via unique constraints.** Webhook + top-up routes must
   key idempotency by `providerOrderId` (already `@unique` on
   `WalletEntry`). Use `updateMany WHERE status = PENDING` for claim.
5. **Platform admin bypass.** `requireOrgAccess` handles this — admins
   get a synthesized OWNER stub. Don't re-implement.

## The Routes

### Critical path (P0) — rewrite first

| Route | Current stub | Target shape |
|---|---|---|
| `POST /api/organizations` | 501 | Create Organization + BillingAccount + OWNER Membership in a single transaction |
| `GET/PATCH /api/organizations/[orgId]` | 501 | Read/update org metadata; validate capability-mode invariants |
| `POST /api/organizations/[orgId]/invitations` | 501 | Create Invitation; email via Novu |
| `POST /api/organizations/invitations/accept` | 501 | Create Member + Membership transactionally; link via `betterAuthMemberId` |
| `GET/POST /api/organizations/[orgId]/contracts` | NEW | CRUD on `Contract`; validate `paymentTermsDays` and `effectiveFrom/To` |
| `GET/POST /api/organizations/[orgId]/programs` | NEW | CRUD on `Program`; validate type-specific config |
| `POST /api/organizations/[orgId]/programs/[programId]/assignments` | NEW | `claimProgramAssignment` |
| `POST /api/organizations/[orgId]/purchase-orders` | NEW | CRUD on `PurchaseOrder`; required if `org.requiresPO=true` |
| `POST /api/organizations/[orgId]/credits/purchase` | 501 | `initiateTopUp` → Razorpay order; webhook calls `confirmTopUp` |
| `GET /api/organizations/[orgId]/credits` | 501 | Read `WalletEntry` ledger + current `BillingAccount.walletBalance` |
| `POST /api/organizations/[orgId]/billing/generate-invoice` | 501 | Manual invoice generation with GST breakdown via `lib/compliance/gst.ts` |

### Read-only path (P1)

| Route | Current stub | Notes |
|---|---|---|
| `GET /api/organizations/[orgId]/members` | 501 | Join Membership + User |
| `PATCH /api/organizations/[orgId]/members/[memberId]` | 501 | Role/status updates; audit log entry |
| `GET /api/organizations/[orgId]/activity` | 501 | Read `OrgAuditLog` |
| `GET /api/organizations/[orgId]/analytics` | 501 | Aggregate `UsageLedgerEntry` + `SettlementLedgerEntry` |
| `GET /api/organizations/[orgId]/billing` | 501 | Snapshot of BillingAccount + latest 10 invoices |
| `GET /api/organizations/[orgId]/billing/invoices` | 501 | Paginated OrganizationInvoice list |
| `POST /api/organizations/[orgId]/billing/invoices/[invoiceId]/pay` | 501 | Razorpay order; webhook transitions ISSUED → PAID |
| `GET /api/organizations/[orgId]/catalog` | 501 | OrganizationPlan list |
| `GET /api/organizations/[orgId]/learners` | 501 | Membership where role=MEMBER |
| `GET /api/organizations/[orgId]/payouts` | 501 | OrganizationPayout history |
| `GET/PATCH /api/organizations/[orgId]/sso` | 501 | OrganizationSSOSettings |

### Admin + cron (P2)

| Route | Current stub | Notes |
|---|---|---|
| `POST /api/admin/organizations/[orgId]/verify` | 501 | PENDING_VERIFICATION → ACTIVE |
| `POST /api/admin/org-payouts/process` | 501 | Batch creation; calls `createOrgPayoutBatch` (also currently stubbed) |
| `POST /api/cleanup/mark-overdue-invoices` | 501 | Sweep ISSUED invoices with dueDate < now → OVERDUE |

## Acceptance bar per route

Every rehydrated route must ship with:
1. Zod validation schema
2. `requireOrgAccess` (or `requireOrgOwner`) gate
3. At least one integration test against a sandbox DB
4. OrgAuditLog entry for any state mutation
5. Per-appropriate ledger entry inside the same transaction
