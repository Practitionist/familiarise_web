# Enterprise Concurrency & Locking

**Status**: Fixed (Apr 2026, commit 19da4448)
**Branch**: `feature/enterprise-1b`
**Scope**: Race conditions across invitation, member, SSO, billing, verification, and credit-purchase routes

---

## Overview

Enterprise operations are point-mutations on known rows (accept one invitation, demote one member, claim one domain). Unlike the booking/allocation system -- where discovering an available slot spans many queries and requires Redis distributed locks -- every enterprise critical section fits inside a single short `$transaction()`.

**Rule of thumb**: Enterprise = Prisma transactions. Booking = Redis + Prisma.

---

## Design Principles

| Principle | Why |
|-----------|-----|
| Atomic `updateMany` with a status filter instead of `findFirst` + `update` | The WHERE clause is the lock: only the first transaction sees the right status; all others update 0 rows and branch to an error |
| All counts and reads inside the same `tx` client | Reads outside the TX may reflect stale data from concurrent transactions that haven't committed yet |
| Serializable isolation for insert-then-check patterns | PostgreSQL SSI aborts the losing transaction with P2034 on write-write or read-write conflict |
| DB-level `@unique` constraints as the last-resort guard | Protects against concurrent inserts that both pass application-level checks |
| No Redis locks for enterprise | Adds latency and a new failure mode; unnecessary when the operation scope is a single row |

---

## Fixed Race Conditions (commit 19da4448)

### 1. Invitation Double-Accept (CRITICAL)

**File**: `app/api/organizations/invitations/accept/route.ts`

**Problem**: The old code checked `invitation.status !== "pending"` before opening the transaction. Two concurrent accept requests both passed this check, both created `Member` + `OrganizationMemberProfile` rows, and both returned 200. The second member creation silently orphaned the first (or threw a unique-constraint error as an unhandled 500).

**Fix**: The transaction now begins with an atomic `updateMany`:

```
tx.invitation.updateMany({
  where: { id, status: "pending" },
  data:  { status: "accepted" }
})
// count === 0  →  throw INVITATION_ALREADY_ACCEPTED (409)
// count === 1  →  proceed to create Member + OrgMemberProfile
```

Only one concurrent request sees `count = 1`; the other sees `count = 0` and rolls back.

---

### 2. Last-Owner Demotion/Removal Race (CRITICAL)

**File**: `app/api/organizations/[orgId]/members/[memberId]/route.ts` (PATCH + DELETE)

**Problem**: `countActiveOwners()` was called outside the transaction. Two concurrent demotion requests (e.g., two browser tabs, both logged in as the org's two owners demoting each other simultaneously) both observed `count = 2`, both passed the "not last owner" guard, and both proceeded. Result: an org with zero owners.

**Fix**: The owner count is now computed **inside** the TX using the `tx` client, **after** the role update or member deletion:

```
// PATCH: role change
await tx.organizationMemberProfile.update({ ... role: newRole })
const remaining = await tx.organizationMemberProfile.count({
  where: { organizationProfileId, role: "ORG_OWNER", status: "ACTIVE" }
})
if (remaining === 0) throw LAST_OWNER  // rolls back the update

// DELETE: member removal (same pattern after delete)
```

The TX that commits second sees the committed state of the first and correctly reads 0 owners.

---

### 3. SSO Domain Claim TOCTOU (HIGH)

**File**: `app/api/organizations/[orgId]/sso/route.ts`
**Schema**: `prisma/schema.prisma` (new `OrgDomainClaim` model)

**Problem**: The old PATCH handler did `findMany(hasSome: newDomains)` to check for conflicts, then a separate `upsert`. Two organizations concurrently updating their SSO settings with the same domain both passed the findMany check (neither had committed yet), both proceeded to upsert, and both claimed the same domain.

**Fix**:

1. New `OrgDomainClaim` model with `domain @unique` (DB-level enforcement).
2. PATCH now syncs domain claims atomically inside one TX: `deleteMany` (old claims for this org) + `createMany` (new claims) + `upsert` (SSO settings). A concurrent claim on the same domain hits the `@unique` constraint → Prisma P2002 → caught and re-thrown as 409.

```
// Inside one $transaction():
tx.orgDomainClaim.deleteMany({ where: { orgId, domain: { notIn: newDomains } } })
tx.orgDomainClaim.createMany({ data: newDomains.map(d => ({ orgId, domain: d })) })
tx.organizationSSOSettings.upsert({ ... })
// P2002 on createMany → caller catches → 409 "domain already claimed"
```

---

### 4. Duplicate Pending Invitations (HIGH)

**File**: `app/api/organizations/[orgId]/invitations/route.ts`

**Problem**: The POST handler called `findFirst` to check whether a pending invite already existed for the email, then called `create`. Two concurrent POST requests for the same email both found no existing invite and both created one. The result was two pending invitations for the same email + org.

**Fix**: The `findFirst` + `create` pair is now wrapped in a **Serializable** transaction:

```
prisma.$transaction(async tx => {
  const existing = await tx.invitation.findFirst({ where: { email, orgId, status: "pending" } })
  if (existing) throw ALREADY_INVITED (409)
  await tx.invitation.create({ ... })
}, { isolationLevel: "Serializable" })
```

PostgreSQL SSI detects the read-write conflict between the two concurrent transactions and aborts the loser with P2034 → caught → 409.

---

### 5. Billing Mode Change After First Payment (HIGH)

**File**: `app/api/organizations/[orgId]/route.ts`

**Problem**: The `billingMode` immutability check called `payment.count()` outside the transaction. A Stripe/Razorpay webhook could land between that count (0 payments found) and the subsequent `update`, leaving the org with an inconsistent billing mode.

**Fix**: The count is now inside an interactive transaction:

```
prisma.$transaction(async tx => {
  const paymentCount = await tx.payment.count({ where: { organizationProfileId } })
  if (paymentCount > 0) throw BILLING_MODE_IMMUTABLE (400)
  await tx.organizationProfile.update({ data: { billingMode } })
})
```

---

### 6. Admin Org Verification Double-Approve/Reject (MEDIUM)

**File**: `app/api/admin/organizations/[orgId]/verify/route.ts`

**Problem**: Two platform admins racing on the same org both called `findFirst` (seeing `PENDING_VERIFICATION`), both passed the check, and both called `update`. The second update silently re-applied the same status transition.

**Fix**: Atomic `updateMany` with a status guard:

```
const { count } = await prisma.organizationProfile.updateMany({
  where: { id: orgId, status: "PENDING_VERIFICATION" },
  data:  { status: action === "APPROVE" ? "ACTIVE" : "DEACTIVATED" }
})
if (count === 0) return 404  // already processed
```

---

### 7. OrgCreditPurchase Duplicate Webhook (MEDIUM)

**Schema**: `prisma/schema.prisma`

**Problem**: A Razorpay webhook retried a `payment.captured` event. The handler queried by `providerOrderId` and, if no `OrgCreditPurchase` row was found, created one and credited the pool. Without a uniqueness constraint, a duplicate webhook created a second purchase row and double-credited the pool.

**Fix**: `OrgCreditPurchase.providerOrderId` is now `@unique`. A duplicate webhook's `create` call hits the constraint → Prisma P2002 → caller returns 200 (idempotent acknowledge) without double-crediting.

---

## Error Code Map

| Error constant | HTTP | Trigger |
|----------------|------|---------|
| `INVITATION_ALREADY_ACCEPTED` | 409 | Invitation `updateMany` → count = 0 |
| `LAST_OWNER` | 409 | Post-update owner count = 0 |
| `BILLING_MODE_IMMUTABLE` | 400 | Payment count > 0 inside TX |
| `ALREADY_INVITED` | 409 | Serializable TX aborted (P2034) or existing found |
| `DOMAIN_ALREADY_CLAIMED` | 409 | `OrgDomainClaim.createMany` → P2002 |
| `DUPLICATE_CREDIT_PURCHASE` | 200 (idempotent) | `OrgCreditPurchase.create` → P2002 |
| (verify) `count = 0` | 404 | `updateMany` on non-PENDING_VERIFICATION org |

---

## Pattern Reference

### Pattern A — Atomic status-gate (most enterprise operations)

```
const { count } = await prisma.MODEL.updateMany({
  where: { id: rowId, status: EXPECTED_STATUS },
  data:  { status: NEW_STATUS }
})
if (count === 0) throw AlreadyProcessedError
// proceed with downstream writes (still safe in same TX if needed)
```

### Pattern B — Post-mutation count inside TX

```
await prisma.$transaction(async tx => {
  await tx.MODEL.update({ where: { id }, data: { ... } })
  const remaining = await tx.MODEL.count({ where: { ... critical condition ... } })
  if (remaining === 0) throw InvariantViolationError
  // TX rolls back the update above
})
```

### Pattern C — Serializable TX for insert-after-read

```
await prisma.$transaction(async tx => {
  const existing = await tx.MODEL.findFirst({ where: { ... } })
  if (existing) throw DuplicateError
  await tx.MODEL.create({ data: { ... } })
}, { isolationLevel: "Serializable" })
// Loser gets P2034 (serialization failure) → map to 409
```

### Pattern D — DB @unique as idempotency guard

```
// schema.prisma
model OrgCreditPurchase {
  providerOrderId String @unique
}

// handler
try {
  await prisma.orgCreditPurchase.create({ data: { providerOrderId, ... } })
} catch (e) {
  if (isPrismaP2002(e)) return NextResponse.json({ ok: true })  // idempotent
  throw e
}
```

---

## Contrast with Booking/Allocation Concurrency

| Dimension | Booking/Allocation | Enterprise |
|-----------|-------------------|------------|
| Critical section scope | Multi-query (discover + validate + insert slots) | Single-row mutation |
| Mechanism | Redis distributed lock + Prisma TX + conflict validation | Prisma TX (Serializable where needed) |
| Why Redis? | Lock must span the discovery phase across multiple queries | Not needed; WHERE clause does the work |
| Failure surface | Lock expiry, semaphore TTL, slot conflict | P2002 (unique), P2034 (serializable), updateMany count=0 |
| Reference doc | `docs/booking/12-concurrency-and-locking.md` | This document |

---

## Key Files

| File | Fix |
|------|-----|
| `app/api/organizations/invitations/accept/route.ts` | Invitation double-accept (Pattern A) |
| `app/api/organizations/[orgId]/members/[memberId]/route.ts` | Last-owner race (Pattern B) |
| `app/api/organizations/[orgId]/sso/route.ts` | Domain TOCTOU (atomic TX + OrgDomainClaim) |
| `app/api/organizations/[orgId]/invitations/route.ts` | Duplicate pending invite (Pattern C) |
| `app/api/organizations/[orgId]/route.ts` | Billing mode race (payment count inside TX) |
| `app/api/admin/organizations/[orgId]/verify/route.ts` | Double verify (Pattern A) |
| `prisma/schema.prisma` | `OrgDomainClaim` model, `OrgCreditPurchase.providerOrderId @unique` |
