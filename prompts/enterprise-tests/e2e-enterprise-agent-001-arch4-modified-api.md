# E2E Enterprise Walkthrough — API Contract Suite (Arch 4-Modified)

> **READ FIRST: [`e2e-enterprise-shared-setup.md`](./e2e-enterprise-shared-setup.md).**
> That file owns the prerequisites (DB seed, dev-server health, role
> promotion, cookie capture, Razorpay test keys), the capability /
> role / funding glossary, the schema reference, the audit-action
> cheat sheet, and the cross-cutting CRITICAL RULES. Do not start
> Phase A until P.1-P.7 in that file are green.

## Role & Mission

You are a **senior QA engineer** performing a hands-on **API contract
acceptance walkthrough** of the Arch 4-Modified enterprise layer on
branch `feature/enterprise-arch4` of
`/Users/kaustavghosh/Desktop/familiarise_web`.

This suite is the **server-side source of truth**: every route is
exercised with `curl`, every state transition is verified with SQL
against the three ledgers, and every 4xx branch is exercised
explicitly. UI-only concerns (Razorpay popup, polling toasts,
hydration warnings, RBAC chrome visibility) live in the sibling
prompt `e2e-enterprise-agent-002-arch4-modified-ui.md`.

Your job is to walk **Phases A through K** end-to-end, producing a
per-phase pass/fail matrix backed by Supabase SQL and `curl` logs.

You have access to one critical MCP tool here:

- **Supabase MCP** — query / verify DB state via `execute_sql`.
  Project ID: `pzmbxqdgibfkhjwzeprf`.

> Chrome DevTools MCP is available but used sparingly in this suite —
> only to grab a fresh `better-auth.session` cookie when `$COOKIE`
> expires. UI-driving belongs in the sibling prompt.

---

## Suite-specific notes

- **Verbatim curl logs.** Every sub-step's `curl -i` (headers + body
  + status) goes into the per-phase report. Use `curl -i -s` to
  capture without the progress bar.
- **SQL after every mutation.** No exceptions — even idempotent
  retries get their `SELECT` checkpoint.
- **No UI assertions in this suite.** If a sub-step depends on a UI
  side-effect, mark it `DEFERRED → see UI suite §X.Y` rather than
  open Chrome DevTools here.

---

<!-- CRITICAL RULES live in e2e-enterprise-shared-setup.md.
     Re-read them before Phase A; do not duplicate them here. -->

---

<!-- The original walkthrough inlined the capability model, funding
     sources, program subtypes, member roles, ledger glossary, schema
     reference, and prereqs P.1-P.5 here. They now live in
     e2e-enterprise-shared-setup.md so the API and UI suites share one
     source of truth. The deletion stops just before "## PHASE A". -->

## PHASE A — Organization Creation + Capability Flips

> **Pre-flight**: every POST in A.1-A.3 fails **403** with
> `"Only organization administrators can create organizations…"` if the
> session user's `users.role` is not `ORG_ADMIN` or `ADMIN`. See
> prereq P.4. Run that first or every cell below will be red.

### A.0 — Creator-role gate (sanity)

Sign up a fresh `CONSULTEE` (default role for new accounts) and POST any
A.1-shaped body without flipping the role. **Expect 403** with the
literal `"Only organization administrators can create organizations.
Sign up with the Organization Owner role to continue."` Then promote
that user via P.4 and continue.

### A.1 — Create Sponsor-only org

```bash
curl -s -X POST http://localhost:3000/api/organizations \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "name": "TestCorp Sponsor",
    "slug": "testcorp-sponsor",
    "canSponsor": true,
    "canHost": false,
    "fundingSource": "INVOICE",
    "billingEmail": "ap@testcorp.test",
    "currency": "INR",
    "requiresPO": true
  }'
```

**Expect 201** with `{ organization, billingAccountId, membership }`.

### A.2 — Create Host-only org

```bash
curl -s -X POST http://localhost:3000/api/organizations \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "name": "TestCorp Host",
    "slug": "testcorp-host",
    "canSponsor": false,
    "canHost": true,
    "billingEmail": "ops@testcorp-host.test"
  }'
```

**Expect 201**. `billingAccountId` in the response must be `null`
because `canSponsor=false`.

### A.3 — Create Hybrid org

```bash
curl -s -X POST http://localhost:3000/api/organizations \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "name": "TestCorp Hybrid",
    "slug": "testcorp-hybrid",
    "canSponsor": true,
    "canHost": true,
    "fundingSource": "WALLET",
    "billingEmail": "billing@testcorp-hybrid.test"
  }'
```

**Expect 201**. A BillingAccount must exist with
`fundingSource=WALLET` and `walletBalance=0`.

### A.4 — DB verification

```sql
SELECT id, name, slug, "canSponsor", "canHost", status, "rootId", depth,
       "billingAccountId"
FROM organizations
WHERE slug IN ('testcorp-sponsor', 'testcorp-host', 'testcorp-hybrid');
```

All three rows:
- `status = 'PENDING_VERIFICATION'`
- `rootId = id` (self-referential — hierarchy is schema-only in v1)
- `depth = 0`
- Sponsor/Hybrid: `billingAccountId` non-null; Host-only: null.

```sql
SELECT id, "ownerOrgId", "fundingSource", currency, "walletBalance",
       "creditLimit"
FROM "BillingAccount"
WHERE "ownerOrgId" IN (
  SELECT id FROM organizations
  WHERE slug IN ('testcorp-sponsor', 'testcorp-hybrid')
);
```

Sponsor: `fundingSource='INVOICE'`, `walletBalance=NULL`.
Hybrid: `fundingSource='WALLET'`, `walletBalance=0`.

```sql
SELECT "organizationId", role, status, "userId"
FROM "Membership"
WHERE "organizationId" IN (
  SELECT id FROM organizations
  WHERE slug IN ('testcorp-sponsor', 'testcorp-host', 'testcorp-hybrid')
);
```

Each org must have exactly **one** `Membership` row: `role='OWNER'`,
`status='ACTIVE'`, `userId = auth session user id`.

```sql
SELECT category, action, description
FROM "OrgAuditLog"
WHERE "organizationId" IN (
  SELECT id FROM organizations
  WHERE slug IN ('testcorp-sponsor', 'testcorp-host', 'testcorp-hybrid')
)
ORDER BY "createdAt" ASC;
```

Each org gets one `category='MEMBER'`, `action='MEMBER_ADDED'` row
emitted in the creation transaction.

### A.5 — Invalid create: both capabilities false

```bash
curl -s -X POST http://localhost:3000/api/organizations \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "name": "Invalid",
    "canSponsor": false,
    "canHost": false,
    "billingEmail": "x@test.test"
  }'
```

**Expect 400** with `"At least one of canSponsor or canHost must be true"`
in `detail.fieldErrors`.

### A.6 — Invalid create: duplicate slug

Re-POST the sponsor org body from A.1. **Expect 409**
`"Slug 'testcorp-sponsor' is already taken"`.

### A.7 — Admin VERIFY

Switch session to a platform `UserRole.ADMIN` account. (If none exists,
seed one via SQL:

```sql
UPDATE users SET role = 'ADMIN' WHERE email = '<your-test-admin>';
```

)

```bash
curl -s -X POST "http://localhost:3000/api/admin/organizations/$ORG_ID/verify" \
  -H "Content-Type: application/json" \
  -H "Cookie: $ADMIN_COOKIE" \
  -d '{ "action": "VERIFY" }'
```

**Expect 200**; `organization.status` flips `PENDING_VERIFICATION →
ACTIVE`. Re-run the DB SELECT from A.4; expect `status='ACTIVE'` and a new
`OrgAuditLog` row with `category='SYSTEM'`, `action='VERIFIED'`,
`actorMembershipId=NULL` (admin actions have no membership).

### A.8 — PATCH guard: disabling both capabilities

As the sponsor org's OWNER:

```bash
curl -s -X PATCH "http://localhost:3000/api/organizations/$SPONSOR_ID" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{ "canSponsor": false, "canHost": false }'
```

**Expect 409** `"Cannot disable both capabilities — at least one of
canSponsor/canHost must remain true."`

### A.9 — PATCH guard: canSponsor=false while wallet non-zero

On the Hybrid org, force a wallet balance so the guard triggers:

```sql
UPDATE "BillingAccount"
SET "walletBalance" = 500000
WHERE "ownerOrgId" = (
  SELECT id FROM organizations WHERE slug = 'testcorp-hybrid'
);
```

Then:

```bash
curl -s -X PATCH "http://localhost:3000/api/organizations/$HYBRID_ID" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{ "canSponsor": false }'
```

**Expect 409** `"Cannot disable canSponsor while wallet has a non-zero
balance"`. Reset the balance to 0 after this check to not affect later
phases.

### A.10 — Invalid admin transition

After A.7 left the org in `ACTIVE`, attempt another VERIFY:

```bash
curl -s -X POST "http://localhost:3000/api/admin/organizations/$ORG_ID/verify" \
  -d '{ "action": "VERIFY" }' \
  -H "Content-Type: application/json" \
  -H "Cookie: $ADMIN_COOKIE"
```

**Expect 409** `"Cannot VERIFY an organization in ACTIVE state"`.

---

## PHASE B — Membership Lifecycle

### B.1 — Invite a LEARNER

As the Sponsor org OWNER:

```bash
curl -s -X POST "http://localhost:3000/api/organizations/$SPONSOR_ID/invitations" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "email": "alice@testcorp-sponsor.test",
    "role": "LEARNER",
    "expiresInDays": 7
  }'
```

**Expect 201** with `{ invitation }`. Capture `invitation.id` as
`INV_ID`.

### B.2 — Invite same email again (dedupe behavior)

```bash
curl -s -X POST "http://localhost:3000/api/organizations/$SPONSOR_ID/invitations" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "email": "alice@testcorp-sponsor.test",
    "role": "LEARNER",
    "expiresInDays": 14
  }'
```

**Expect 200** (not 201; de-dupe path updates the row in place rather
than minting a fresh token). The SAME `invitation.id` comes back, with a
refreshed `expiresAt`. Confirm:

```sql
SELECT id, email, role, status, "expiresAt", "createdAt"
FROM invitations
WHERE "organizationId" = '<SPONSOR_ID>'
  AND email = 'alice@testcorp-sponsor.test';
```

Exactly **one** row. `"expiresAt"` moved forward by roughly 7 days. A
second `OrgAuditLog` row with `action='INVITE_RESENT'`.

### B.3 — Invalid role at invite

```bash
curl -s -X POST "http://localhost:3000/api/organizations/$SPONSOR_ID/invitations" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{ "email": "x@t.test", "role": "EXPERT" }'
```

**Expect 400** — EXPERT / SUPPORT are not on the self-service invitable
role list.

### B.4 — Accept invite as the invitee

Log out. Sign up with email `alice@testcorp-sponsor.test` via
`/auth/signup`. Then:

```bash
curl -s -X POST "http://localhost:3000/api/organizations/invitations/accept" \
  -H "Content-Type: application/json" \
  -H "Cookie: $ALICE_COOKIE" \
  -d "{ \"invitationId\": \"$INV_ID\" }"
```

**Expect 201** with `{ membership }`. Verify:

```sql
SELECT m.id, m.role, m.status, m."userId", m."betterAuthMemberId",
       i.status AS invitation_status
FROM "Membership" m
JOIN invitations i ON i."userId" = m."userId"
                   AND i."organizationId" = m."organizationId"
WHERE i.id = '<INV_ID>';
```

- `Membership.role = 'LEARNER'`
- `Membership.status = 'ACTIVE'`
- `Membership.betterAuthMemberId` non-null (bridge populated)
- `invitations.status = 'accepted'`

### B.5 — Atomic claim: second accept

Immediately replay the same accept:

```bash
curl -s -X POST "http://localhost:3000/api/organizations/invitations/accept" \
  -H "Content-Type: application/json" \
  -H "Cookie: $ALICE_COOKIE" \
  -d "{ \"invitationId\": \"$INV_ID\" }"
```

**Expect 409** `"Invitation is no longer pending"`. The atomic-claim
clause (`updateMany WHERE status=pending`) returns `count=0` on the
second caller.

### B.6 — Accept a different user's invite

Create a second invite for `bob@testcorp-sponsor.test`. Then try to
accept it while logged in as Alice:

**Expect 403** `"This invitation is not addressed to you"`.

### B.7 — List members with role filter

```bash
curl -s "http://localhost:3000/api/organizations/$SPONSOR_ID/members?role=LEARNER" \
  -H "Cookie: $COOKIE"
```

**Expect 200** with `{ data: [...], meta: { total, page, perPage } }`.
At least Alice should be present with `role='LEARNER'`.

Union filter:

```bash
curl -s "http://localhost:3000/api/organizations/$SPONSOR_ID/members?role=LEARNER,EXPERT"
```

**Expect 200**; LEARNER + EXPERT memberships merged.

### B.8 — PATCH member: LEARNER → MANAGER

```bash
curl -s -X PATCH \
  "http://localhost:3000/api/organizations/$SPONSOR_ID/members/$ALICE_MEMBERSHIP_ID" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{ "role": "MANAGER" }'
```

**Expect 200**. A `ROLE_CHANGE` OrgAuditLog row must land.

### B.9 — PATCH: MAINTAINER promoting to OWNER

Create another account with MAINTAINER role and have that session try to
promote Alice to OWNER:

**Expect 403** `"Only an OWNER can assign or revoke the OWNER role"`.

### B.10 — Last-OWNER guard (critical)

The Sponsor org has exactly one OWNER. Attempt to demote yourself:

```bash
curl -s -X PATCH \
  "http://localhost:3000/api/organizations/$SPONSOR_ID/members/$SELF_MEMBERSHIP_ID" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{ "role": "MAINTAINER" }'
```

**Expect 409** `"Cannot demote or remove the only active OWNER. Promote
another member to OWNER first."`

Same message for DELETE of the sole OWNER.

### B.11 — Verify membership indexes in DB

```sql
SELECT role, status, COUNT(*) AS n
FROM "Membership"
WHERE "organizationId" = '<SPONSOR_ID>'
GROUP BY role, status;
```

Sum must equal the response `meta.total` from B.7.

---

## PHASE C — Contract + Program

### C.1 — Create DRAFT contract (OWNER only)

```bash
curl -s -X POST "http://localhost:3000/api/organizations/$SPONSOR_ID/contracts" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{
    \"billingAccountId\": \"$SPONSOR_BA_ID\",
    \"effectiveFrom\": \"2026-01-01T00:00:00Z\",
    \"paymentTermsDays\": 60,
    \"autoRenew\": false,
    \"status\": \"DRAFT\"
  }"
```

**Expect 201** `{ contract }`. `contract.status='DRAFT'`. Capture
`contract.id` as `CONTRACT_ID`.

### C.2 — Non-OWNER attempt

Using the MAINTAINER session from B.9:

**Expect 403** from `requireOrgOwner`.

### C.3 — Cross-tenant BillingAccount theft

Try to create a contract on `$SPONSOR_ID` referencing the Hybrid org's
BillingAccount id:

**Expect 400** `"BillingAccount does not belong to this organization"`.

### C.4 — PATCH DRAFT → ACTIVE (simulated signature)

```bash
curl -s -X PATCH \
  "http://localhost:3000/api/organizations/$SPONSOR_ID/contracts/$CONTRACT_ID" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{ "status": "ACTIVE", "signedAt": "2026-04-19T00:00:00Z" }'
```

**Expect 200**. Verify a `CONTRACT_SIGNED` OrgAuditLog row landed (not
`CONTRACT_CREATED`; the PATCH path picks the lifecycle-specific action).

### C.5 — POST a LICENSED_SEAT program

```bash
curl -s -X POST "http://localhost:3000/api/organizations/$SPONSOR_ID/programs" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{
    \"type\": \"LICENSED_SEAT\",
    \"contractId\": \"$CONTRACT_ID\",
    \"name\": \"Wipro Engineer Leadership Program\",
    \"coveredPlanTypes\": [\"CONSULTATION\"],
    \"allowedCategories\": [\"Engineering\"],
    \"licensedSeatConfig\": {
      \"ratePerSeatPaise\": 1500000,
      \"cycle\": \"MONTHLY\",
      \"coveredEngagementsPerCycle\": 4,
      \"overageBehavior\": \"CHARGE_MEMBER\"
    }
  }"
```

**Expect 201**. DB check:

```sql
SELECT p.id, p.type, p.name, lsc."ratePerSeatPaise", lsc."cycle",
       lsc."coveredEngagementsPerCycle", lsc."overageBehavior"
FROM "Program" p
JOIN "LicensedSeatConfig" lsc ON lsc."programId" = p.id
WHERE p."contractId" = '<CONTRACT_ID>';
```

Exactly one `LicensedSeatConfig` row (1:1 with program). `cycle='MONTHLY'`.

### C.6 — POST a CREDIT_POOL program

```bash
curl -s -X POST "http://localhost:3000/api/organizations/$SPONSOR_ID/programs" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{
    \"type\": \"CREDIT_POOL\",
    \"contractId\": \"$CONTRACT_ID\",
    \"name\": \"Wipro Ad-hoc Coaching Pool\",
    \"coveredPlanTypes\": [\"CONSULTATION\", \"WEBINAR\"],
    \"creditPoolConfig\": {
      \"creditValuePaise\": 100000,
      \"minimumCreditsPerPeriod\": 50
    }
  }"
```

**Expect 201**. Corresponding `CreditPoolConfig` row.

### C.7 — Discriminated-union enforcement

Send a LICENSED_SEAT body carrying `creditPoolConfig`:

**Expect 400**. Zod's `discriminatedUnion` rejects the mismatch at the
edge, not at the DB.

### C.8 — POST program against TERMINATED contract

```sql
UPDATE "Contract" SET status = 'TERMINATED'
WHERE id = '<SOME_OTHER_CONTRACT_ID>';
```

Then POST a program referencing that contract:

**Expect 409** `"Cannot attach a program to a TERMINATED contract"`.
Reset the status if needed.

### C.9 — POST ProgramAssignment

```bash
curl -s -X POST \
  "http://localhost:3000/api/organizations/$SPONSOR_ID/programs/$PROGRAM_ID/assignments" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{
    \"membershipId\": \"$ALICE_MEMBERSHIP_ID\",
    \"periodStart\": \"2026-04-01T00:00:00Z\",
    \"periodEnd\": \"2026-05-01T00:00:00Z\"
  }"
```

**Expect 201**. DB:

```sql
SELECT id, "programId", "membershipId", "periodStart", "periodEnd",
       "engagementsUsed", "overageCount"
FROM "ProgramAssignment"
WHERE "programId" = '<PROGRAM_ID>'
  AND "membershipId" = '<ALICE_MEMBERSHIP_ID>';
```

Exactly one row; `engagementsUsed=0`, `overageCount=0`.

### C.10 — Atomicity of claimProgramAssignment

Replay the POST immediately (same period). The unique
`(programId, membershipId, periodStart)` should prevent a duplicate:

**Expect 200 OR 409** — `claimProgramAssignment` is idempotent upsert
over that tuple; confirm you end up with exactly **one** row, not two.

### C.11 — Cross-org ProgramAssignment attempt

Try to assign Alice (Sponsor org membership) to a Program that lives on
IIT Madras's contract:

**Expect 400 or 404** — either "Program not found" (the scoped lookup by
`contract: { organizationId }` filter excludes it) or "Membership does
not belong to this organization". Both are acceptable; never 500.

---

## PHASE D — BillingAccount + Wallet

### D.1 — GET current BillingAccount

```bash
curl -s "http://localhost:3000/api/organizations/$HYBRID_ID/billing-account" \
  -H "Cookie: $COOKIE"
```

**Expect 200** with `{ billingAccount: { fundingSource: "WALLET",
walletBalance: 0, ... } }`.

### D.2 — GET on Host-only org

```bash
curl -s "http://localhost:3000/api/organizations/$HOST_ID/billing-account" \
  -H "Cookie: $COOKIE"
```

**Expect 404** `"Organization does not have a BillingAccount
(canSponsor=false)"`.

### D.3 — PATCH fundingSource WALLET → INVOICE with non-zero balance

Force a balance, then attempt the switch:

```sql
UPDATE "BillingAccount"
SET "walletBalance" = 250000
WHERE "ownerOrgId" = '<HYBRID_ID>';
```

```bash
curl -s -X PATCH "http://localhost:3000/api/organizations/$HYBRID_ID/billing-account" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{ "fundingSource": "INVOICE" }'
```

**Expect 409** `"Cannot switch funding source with a non-zero wallet
balance. Drain or refund the wallet first."`. Reset balance to 0.

### D.4 — PATCH fundingSource WALLET → LICENSE (clean)

```bash
curl -s -X PATCH "http://localhost:3000/api/organizations/$HYBRID_ID/billing-account" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{ "fundingSource": "LICENSE" }'
```

**Expect 200**. Confirm `walletBalance` cleared to `NULL`:

```sql
SELECT "fundingSource", "walletBalance"
FROM "BillingAccount"
WHERE "ownerOrgId" = '<HYBRID_ID>';
```

Switch it back to WALLET (balance will re-init to 0) for D.5:

```bash
curl -s -X PATCH "http://localhost:3000/api/organizations/$HYBRID_ID/billing-account" \
  -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d '{ "fundingSource": "WALLET" }'
```

### D.5 — Wallet top-up init

> **Auth gates** (see [`app/api/organizations/[orgId]/billing-account/wallet/top-ups/route.ts`](app/api/organizations/[orgId]/billing-account/wallet/top-ups/route.ts)
> lines 99-108): the route is **OWNER-only**, `canSponsor=true`, and
> `requireActive: true`. Top-ups move real money — the gate is
> deliberately the strictest in the wallet surface.

```bash
curl -s -X POST \
  "http://localhost:3000/api/organizations/$HYBRID_ID/billing-account/wallet/top-ups" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{ "amountPaise": 500000 }'
```

**Expect 201** with the pair-of-ids body:

```json
{
  "topUpId": "we_<32-hex>",
  "razorpayOrderId": "order_<…>",
  "keyId": "<NEXT_PUBLIC_RAZORPAY_KEY_ID>",
  "amountPaise": 500000,
  "currency": "INR",
  "status": "pending",
  "reused": false
}
```

`topUpId` is our wallet-entry idempotency key (stored as
`WalletEntry.providerOrderId @unique` and used as the URL parameter for
the polling endpoint in D.5b). `razorpayOrderId` is the gateway order
the dashboard hands to `new Razorpay({ order_id })`.

A pending `WalletEntry` row is created:

```sql
SELECT id, "deltaPaise", reason, "balanceAfter", "providerOrderId",
       "providerPaymentId", "createdAt"
FROM "WalletEntry"
WHERE "billingAccountId" = '<HYBRID_BA_ID>'
ORDER BY "createdAt" DESC
LIMIT 3;
```

The pending row carries `providerOrderId = topUpId` (the `we_<…>`
value, NOT the Razorpay order id), `deltaPaise = 0`,
`reason = 'TOPUP'`, `providerPaymentId IS NULL`. The webhook flips
`deltaPaise` to the credited amount and writes `providerPaymentId`.

### D.5a — Auth-gate sub-steps

- As a MAINTAINER session: **Expect 403** (`requireOrgAccess` minimum
  role check).
- Against an org with `status = 'PENDING_VERIFICATION'`: **Expect 403**
  (`requireActive: true`). Verify with the SQL: `SELECT status FROM
  organizations WHERE id = '<…>'` should be `PENDING_VERIFICATION`.
- Against a Host-only org (`canSponsor = false`): **Expect 403** —
  `canSponsor: true` requirement on `requireOrgAccess` rejects before
  the BillingAccount lookup.

### D.5b — Razorpay-keys-missing guard

If `RAZORPAY_KEY_ID` / `RAZORPAY_SECRET` are unset (preview / CI /
pre-config dev):

**Expect 503** with body
`{ "error": "Payment gateway not configured. Set RAZORPAY_KEY_ID and
RAZORPAY_SECRET to enable top-ups.", "errorType":
"RAZORPAY_NOT_INITIALIZED" }`.

Critically: NO `WalletEntry` row gets persisted on this branch — the
route mints the Razorpay order **before** the DB transaction so a
gateway failure can't leave behind a pending placeholder. Verify with
`SELECT COUNT(*) FROM "WalletEntry" WHERE "billingAccountId" = …` —
unchanged.

### D.5c — Bounded post-checkout polling

Once D.5 has landed a pending row, exercise the polling endpoint the
dashboard uses to bridge the webhook race
([`app/api/organizations/[orgId]/billing-account/wallet/top-ups/[topUpId]/route.ts`](app/api/organizations/[orgId]/billing-account/wallet/top-ups/[topUpId]/route.ts)):

```bash
curl -s "http://localhost:3000/api/organizations/$HYBRID_ID/billing-account/wallet/top-ups/$TOPUP_ID" \
  -H "Cookie: $COOKIE"
```

**Pre-webhook (Expect 200):**

```json
{
  "topUp": {
    "topUpId": "we_<…>",
    "providerPaymentId": null,
    "status": "pending",
    "amountPaise": 0,
    "balanceAfter": 0,
    "createdAt": "..."
  }
}
```

Now simulate the webhook (POST a signed payload to
`/api/webhooks/razorpay` with `notes.type=credit_purchase` +
`notes.walletEntryOrderId=$TOPUP_ID`, or call the dev confirm helper).
Replay the GET:

**Post-webhook (Expect 200):**

```json
{
  "topUp": {
    "topUpId": "we_<…>",
    "providerPaymentId": "pay_<…>",
    "status": "confirmed",
    "amountPaise": 500000,
    "balanceAfter": 500000,
    "createdAt": "..."
  }
}
```

The `status` flip from `pending → confirmed` is the contract the client
poll loop in
[`app/dashboard/organization/[orgId]/credits/page.tsx`](app/dashboard/organization/[orgId]/credits/page.tsx)
relies on (1 s × 20 attempts = 20 s budget). Cross-tenant lookup
(another org's `topUpId`) → **404** `"Top-up not found"` — the
`billingAccount: { ownerOrgId: orgId }` filter prevents leakage.

### D.6 — Idempotent retry via client key

First POST mints the entry:

```bash
curl -s -X POST \
  "http://localhost:3000/api/organizations/$HYBRID_ID/billing-account/wallet/top-ups" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{ "amountPaise": 500000, "clientIdempotencyKey": "ckey-phaseD-001" }'
```

**Expect 201** with `topUpId = "ckey-phaseD-001"` and `reused: false`
— the supplied key is used verbatim as the wallet-entry order id.

Replay the same body. **Expect 200** with the explicit "use a fresh
key" advice baked in:

```json
{
  "topUpId": "ckey-phaseD-001",
  "amountPaise": 500000,
  "status": "pending",
  "reused": true,
  "error": "A top-up with this idempotency key already exists. Retry without the key to launch a new gateway order."
}
```

The `WalletEntry.providerOrderId @unique` constraint guarantees the
de-dupe even without the key — passing the same physical request twice
in a millisecond can't double-mint. The `error` field on the 200 is the
load-bearing UX hint: it tells the client a fresh idempotency key is
needed to launch a NEW Razorpay order (we cannot resume the original
order from this endpoint).

### D.7 — Top-up with amount below ₹100

```bash
curl -s -X POST \
  "http://localhost:3000/api/organizations/$HYBRID_ID/billing-account/wallet/top-ups" \
  -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d '{ "amountPaise": 5000 }'
```

**Expect 400** — Zod `min(10_000)` paise (₹100). Below the floor,
gateway fees would dwarf the credit.

### D.8 — Top-up on non-WALLET account

PATCH Hybrid back to INVOICE (only possible once wallet is zero). Then:

**Expect 409** `"Top-ups are only allowed on WALLET funding"`. Revert to
WALLET after.

### D.9 — Ledger invariant (post-confirmed top-up)

Simulate webhook confirmation (signed payload to `/api/webhooks/razorpay`
with `notes.type=credit_purchase`, or the dev `confirmTopUp` helper) so
one WalletEntry settles with `reason='TOPUP'`, `deltaPaise=500000`,
`balanceAfter=500000`, `providerPaymentId` populated. Then verify the
**three-ledger discipline** AND the **two-action audit split**:

```sql
-- 1. WalletEntry balance must equal BillingAccount.walletBalance.
SELECT ba."walletBalance",
       (SELECT COALESCE(SUM("deltaPaise"), 0)
        FROM "WalletEntry"
        WHERE "billingAccountId" = ba.id
          AND "providerPaymentId" IS NOT NULL) AS wallet_ledger_sum
FROM "BillingAccount" ba
WHERE ba."ownerOrgId" = '<HYBRID_ID>';

-- 2. FundingLedgerEntry must mirror confirmed WalletEntry rows 1:1
--    via the walletEntryId @unique FK.
SELECT COUNT(*) FROM "FundingLedgerEntry" WHERE "billingAccountId" =
  (SELECT id FROM "BillingAccount" WHERE "ownerOrgId" = '<HYBRID_ID>');

-- 3. Two-stage audit split: WALLET_TOPUP from the route, then
--    WALLET_TOPUP_CONFIRMED from the webhook handler. Both must land.
SELECT action, COUNT(*) FROM "OrgAuditLog"
WHERE "organizationId" = '<HYBRID_ID>'
  AND category = 'WALLET'
GROUP BY action;
```

Invariants:

- Wallet balance equals wallet-ledger sum for settled rows (pending-
  but-unconfirmed rows are excluded from the balance).
- The audit split must show **both** `WALLET_TOPUP` (route-emitted at
  initiation, see [`app/api/organizations/[orgId]/billing-account/wallet/top-ups/route.ts`](app/api/organizations/[orgId]/billing-account/wallet/top-ups/route.ts)
  line 235) and `WALLET_TOPUP_CONFIRMED` (webhook-emitted at settlement,
  see [`app/api/webhooks/utils.ts`](app/api/webhooks/utils.ts)). Missing
  the second row means the webhook never fired or signature verification
  rejected it — re-check `RAZORPAY_WEBHOOK_SECRET`.

---

## PHASE E — Invoices + Purchase Orders (India-aware)

Switch context to the Sponsor org (`canSponsor=true`,
`fundingSource=INVOICE`).

### E.1 — POST a PurchaseOrder

```bash
curl -s -X POST \
  "http://localhost:3000/api/organizations/$SPONSOR_ID/billing-account/purchase-orders" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "poNumber": "PO-2026-00042",
    "poDate": "2026-04-01T00:00:00Z",
    "validUntil": "2027-03-31T00:00:00Z",
    "totalAmountPaise": 5000000,
    "currency": "INR"
  }'
```

**Expect 201**. `remainingAmountPaise === totalAmountPaise` at creation
time.

### E.2 — Duplicate poNumber

Replay the same body:

**Expect 409** `"PO number PO-2026-00042 already exists for this org"`.
The `(organizationId, poNumber)` `@@unique` composite catches it.

### E.3 — POST an intra-state invoice (GST split CGST + SGST)

Set the Sponsor org's `gstStateCode = 'KA'` (Karnataka, same as the
platform supplier state) before issuing:

```sql
UPDATE organizations SET "gstStateCode" = 'KA', gstin = '29ABCDE1234F1Z5'
WHERE id = '<SPONSOR_ID>';
```

```bash
curl -s -X POST \
  "http://localhost:3000/api/organizations/$SPONSOR_ID/billing-account/invoices" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{
    \"purchaseOrderId\": \"$PO_ID\",
    \"displayCurrency\": \"INR\",
    \"items\": [
      {\"description\": \"Seat licence Apr 2026\", \"quantity\": 10, \"unitPrice\": 150000}
    ],
    \"dueDate\": \"2026-05-31T00:00:00Z\",
    \"issueImmediately\": false
  }"
```

**Expect 201**. Status `DRAFT`. Verify GST:

```sql
SELECT "invoiceNumber", status, "subtotalPaise", "cgstPaise",
       "sgstPaise", "igstPaise", "totalPaise", "placeOfSupply",
       "hsnCode", gstin, "irpStatus"
FROM "OrganizationInvoice"
WHERE "organizationId" = '<SPONSOR_ID>';
```

Intra-state: `cgstPaise + sgstPaise > 0`, `igstPaise = 0`,
`placeOfSupply = 'KA'`, `irpStatus = 'PENDING'`.

### E.4 — Inter-state invoice (IGST only)

Flip the org to a different state and issue another:

```sql
UPDATE organizations SET "gstStateCode" = 'MH' WHERE id = '<SPONSOR_ID>';
```

Re-issue. The new invoice must have `igstPaise > 0` and
`cgstPaise = sgstPaise = 0`.

### E.5 — State machine: DRAFT → ISSUED (PATCH path)

The PATCH route in
[`app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/route.ts`](app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/route.ts)
is deliberately narrow:

```
DRAFT    → ISSUED, CANCELLED
ISSUED   → VOID
OVERDUE  → VOID
PAID     → (terminal)
VOID     → (terminal)
CANCELLED→ (terminal)
```

- PATCH `{ "status": "ISSUED" }` from DRAFT: **200**, `issuedAt`
  populated, `SettlementLedgerEntry(kind='INVOICE_ISSUED')` lands, and
  an `OrgAuditLog(action='INVOICE_ISSUED')` row appears.
- PATCH `{ "status": "PAID" }` from any state: **400** —
  `PatchStatusSchema = z.enum(["ISSUED", "CANCELLED", "VOID"])` rejects
  the value at Zod parsing. PAID is **only** reachable via the webhook
  handler in `/pay` (E.5c).
- PATCH `{ "status": "VOID" }` from ISSUED: **200**, audit
  `INVOICE_VOIDED`, `voidedAt` populated.
- PATCH `{ "status": "ISSUED" }` from PAID/VOID/CANCELLED: **409**
  `"Cannot transition invoice from <state> to ISSUED"` — the explicit
  per-state allow-list rejects.

### E.5b — Pay an issued invoice (mints Razorpay order)

```bash
curl -s -X POST \
  "http://localhost:3000/api/organizations/$SPONSOR_ID/billing-account/invoices/$INVOICE_ID/pay" \
  -H "Cookie: $COOKIE"
```

**Expect 200** (no `{ status: 201 }` wrapper; route uses default
`NextResponse.json`):

```json
{
  "razorpayOrderId": "order_<…>",
  "keyId": "<NEXT_PUBLIC_RAZORPAY_KEY_ID>",
  "amountPaise": 1500000,
  "currency": "INR",
  "invoice": {
    "id": "<INVOICE_ID>",
    "invoiceNumber": "INV-…",
    "status": "ISSUED"
  }
}
```

Verify the audit row:

```sql
SELECT action, details FROM "OrgAuditLog"
WHERE "organizationId" = '<SPONSOR_ID>'
  AND category = 'INVOICE'
  AND action = 'INVOICE_PAYMENT_INITIATED'
ORDER BY "createdAt" DESC LIMIT 1;
```

Critical: this route does NOT mutate the invoice. `status` stays
`ISSUED`, `paidAt` stays NULL, no `SettlementLedgerEntry(INVOICE_PAID)`
yet. The webhook is the only path that flips PAID — see E.5c.

Guard sub-steps (cite [`app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay/route.ts`](app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay/route.ts)):

- Already-PAID invoice → **409** `"Invoice already paid"` with
  `paidAt` echoed.
- DRAFT / VOID / CANCELLED invoice → **409**
  `"Cannot pay an invoice in <STATE> state"`.
- Razorpay keys missing → **503**
  `"Payment gateway not configured. Set RAZORPAY_KEY_ID and
  RAZORPAY_SECRET to enable invoice payments."` with `errorType:
  "RAZORPAY_NOT_INITIALIZED"`. No audit row written, no order minted.
- Non-OWNER session → **403** (`requireOrgAccess(..., {
  minimumRole: "OWNER", canSponsor: true, requireActive: true })`).

### E.5c — Webhook simulation flips ISSUED → PAID

Either invoke the dev `confirmInvoicePayment` helper or POST a
signature-valid `payment.captured` payload to `/api/webhooks/razorpay`
with `notes.type=invoice_payment` + `notes.invoiceId=$INVOICE_ID` (see
[`app/api/webhooks/utils.ts`](app/api/webhooks/utils.ts) for the
expected shape).

Verify:

```sql
-- Status flipped + paidAt populated
SELECT status, "paidAt" FROM "OrganizationInvoice"
WHERE id = '<INVOICE_ID>';

-- SettlementLedgerEntry written
SELECT kind, "amountPaise", "providerPaymentId" FROM "SettlementLedgerEntry"
WHERE "invoiceId" = '<INVOICE_ID>'
ORDER BY "createdAt" ASC;

-- Audit
SELECT action FROM "OrgAuditLog"
WHERE "organizationId" = '<SPONSOR_ID>'
  AND details->>'invoiceId' = '<INVOICE_ID>'
ORDER BY "createdAt" ASC;
```

Expect: `status='PAID'`, `paidAt` NOT NULL, one
`SettlementLedgerEntry(kind='INVOICE_PAID')` row matching `totalPaise`,
and the audit-action sequence `INVOICE_PAYMENT_INITIATED → INVOICE_PAID`.

Idempotency check: replay the webhook with the same
`razorpay_payment_id`. The handler must short-circuit (see
`OrganizationInvoice.providerOrderId @unique` + the `paidAt IS NULL`
guard) — no second `INVOICE_PAID` ledger row, no duplicated audit.

### E.6 — 3-way match: invoice within PO remaining

Issue a second invoice against the PO with total less than
`remainingAmountPaise`: **200**. Issue one **exceeding**
remainingAmountPaise: the endpoint should 409 (if the guard is live;
if stub returns 200, log it as a compliance stub gap — see
`docs/enterprise/10-invoicing.md`).

### E.7 — Cross-org PO theft

Issue an invoice on `$SPONSOR_ID` referencing the Hybrid org's PO id:

**Expect 400** `"PurchaseOrder does not belong to this organization"`.

### E.8 — PO with non-ACTIVE status

Cancel a PO:

```sql
UPDATE "PurchaseOrder" SET status = 'CANCELLED' WHERE id = '<SOME_PO_ID>';
```

Then try to invoice against it. **Expect 409** `"PurchaseOrder is
CANCELLED; only ACTIVE POs can be invoiced against"`.

---

## PHASE F — Hosting Side (Host / Hybrid only)

Switch to the **Host-only** org (`$HOST_ID`, canHost=true,
canSponsor=false). Log in as `founder@iitmadras.test` for the seeded
scenario or your test Host OWNER.

### F.1 — PUT payout account (creation)

```bash
curl -s -X PUT "http://localhost:3000/api/organizations/$HOST_ID/payout-account" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "accountHolderName": "Testcorp Host Pvt Ltd",
    "accountNumber": "001122334455",
    "bankName": "HDFC Bank",
    "ifscCode": "HDFC0000123"
  }'
```

**Expect 200**. DB:

```sql
SELECT id, status, "accountNumberLast4", "verifiedAt"
FROM "OrganizationPayoutAccount"
WHERE "organizationId" = '<HOST_ID>';
```

Creation: `status='PENDING_VERIFICATION'`, `verifiedAt=NULL`.
Simulate verification to continue:

```sql
UPDATE "OrganizationPayoutAccount"
SET status = 'VERIFIED', "verifiedAt" = NOW()
WHERE "organizationId" = '<HOST_ID>';
```

### F.2 — PUT payout account (account-number change flips to PENDING)

```bash
curl -s -X PUT "http://localhost:3000/api/organizations/$HOST_ID/payout-account" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "accountHolderName": "Testcorp Host Pvt Ltd",
    "accountNumber": "99887766554433",
    "bankName": "HDFC Bank",
    "ifscCode": "HDFC0000123"
  }'
```

**Expect 200**. Re-read the row — `status` reset to
`PENDING_VERIFICATION`, `verifiedAt` cleared, `razorpayContactId`
cleared. The account-number change must NOT retain old verification
artifacts. An OrgAuditLog row with
`details.verificationReset=true`.

Re-verify via SQL for the next steps.

### F.3 — Seed earnings so payouts have something to roll up

```sql
-- Three READY earnings to roll into a payout.
INSERT INTO "OrganizationEarnings"
  (id, "organizationId", "paymentId", "grossAmountPaise",
   "platformFeePaise", "orgSharePaise", "consultantSharePaise",
   currency, "rateCardIdApplied", "platformBpsApplied",
   "orgBpsApplied", "consultantBpsApplied",
   status, "createdAt", "updatedAt")
SELECT
  gen_random_uuid(), '<HOST_ID>', p.id,
  p.amount, p.amount / 10, (p.amount / 10) * 4, p.amount - (p.amount / 10) - ((p.amount / 10) * 4),
  'INR', NULL, 1000, 4000, 5000,
  'READY', NOW(), NOW()
FROM "Payment" p
WHERE p."organizationId" = '<HOST_ID>'
LIMIT 3;
```

(Adjust to your seed's exact payment shape. Key point: `status='READY'`,
one currency, `platformBpsApplied + orgBpsApplied + consultantBpsApplied
= 10000`.)

### F.4 — GET earnings with filters

```bash
curl -s "http://localhost:3000/api/organizations/$HOST_ID/earnings?status=READY" \
  -H "Cookie: $COOKIE"
```

**Expect 200** with all READY rows. Also test
`?from=...&to=...&payoutId=...&limit=5&cursor=...`.

### F.5 — POST payout

```bash
curl -s -X POST "http://localhost:3000/api/organizations/$HOST_ID/payouts" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "periodStart": "2026-04-01T00:00:00Z",
    "periodEnd": "2026-05-01T00:00:00Z",
    "paymentGateway": "RAZORPAY"
  }'
```

**Expect 201**. DB verification:

```sql
-- Payout row at PENDING, net > 0
SELECT id, status, "amountPaise", "netPayoutPaise", "grossRevenuePaise",
       "platformFeePaise", "refundsPaise"
FROM "OrganizationPayout"
WHERE "organizationId" = '<HOST_ID>' ORDER BY "createdAt" DESC LIMIT 1;

-- Every READY earning in the window is now PAID + orgPayoutId set
SELECT COUNT(*), status FROM "OrganizationEarnings"
WHERE "orgPayoutId" = '<PAYOUT_ID>'
GROUP BY status;

-- A SettlementLedgerEntry(kind='PAYOUT_SENT', amountPaise < 0) row exists
SELECT kind, "amountPaise" FROM "SettlementLedgerEntry"
WHERE "payoutId" = '<PAYOUT_ID>';
```

### F.6 — POST payout guards

- No VERIFIED payout account → **409**.
- No READY earnings in the window → **409**.
- Mixed-currency earnings → **409**.
- `periodEnd <= periodStart` → **400**.
- Net payout `<= 0` (refunds exceed earnings) → **409**.

Exercise each.

### F.7 — PATCH payout: PENDING → CANCELLED releases earnings

```bash
curl -s -X PATCH \
  "http://localhost:3000/api/organizations/$HOST_ID/payouts/$PAYOUT_ID" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{ "status": "CANCELLED", "notes": "Rollback test" }'
```

**Expect 200**. Verify in three places (cite [`app/api/organizations/[orgId]/payouts/[payoutId]/route.ts`](app/api/organizations/[orgId]/payouts/[payoutId]/route.ts)
lines 122-172):

```sql
-- 1. Earnings released back to READY, orgPayoutId cleared.
SELECT status, "orgPayoutId" FROM "OrganizationEarnings"
WHERE "orgPayoutId" IS NULL
  AND "organizationId" = '<HOST_ID>';
-- (Was attached to <PAYOUT_ID> a moment ago; now NULL/READY.)

-- 2. Compensating settlement row written as PAYOUT_REVERSED
--    (NOT a negative-sign PAYOUT_SENT — the route uses a distinct kind
--    so analytics queries don't double-count cancelled payouts).
SELECT kind, "amountPaise", notes FROM "SettlementLedgerEntry"
WHERE "payoutId" = '<PAYOUT_ID>'
ORDER BY "createdAt" ASC;
-- Expect two rows:
--   1. kind='PAYOUT_SENT', amountPaise = -netPayoutPaise (from F.5)
--   2. kind='PAYOUT_REVERSED', amountPaise = +netPayoutPaise (this step)

-- 3. Audit action is PAYOUT_CANCELLED.
SELECT action FROM "OrgAuditLog"
WHERE "organizationId" = '<HOST_ID>'
  AND details->>'payoutId' = '<PAYOUT_ID>'
ORDER BY "createdAt" DESC LIMIT 1;
```

The two settlement rows must net to zero for this payout: `SUM(amountPaise) = 0`.

### F.7b — PATCH payout: PENDING → APPROVED (manager sign-off)

```bash
curl -s -X PATCH \
  "http://localhost:3000/api/organizations/$HOST_ID/payouts/$ANOTHER_PAYOUT_ID" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{ "status": "APPROVED" }'
```

**Expect 200**. The route reuses `PAYOUT_INITIATED` for non-cancel
transitions (see route lines 153-172 — the audit action is
`PAYOUT_CANCELLED` only when `status === 'CANCELLED'`, otherwise
`PAYOUT_INITIATED`). Verify:

```sql
SELECT status FROM "OrganizationPayout" WHERE id = '<ANOTHER_PAYOUT_ID>';
-- APPROVED

SELECT action, details->>'from' AS from, details->>'to' AS to
FROM "OrgAuditLog"
WHERE "organizationId" = '<HOST_ID>'
  AND details->>'payoutId' = '<ANOTHER_PAYOUT_ID>'
ORDER BY "createdAt" DESC LIMIT 1;
-- action='PAYOUT_INITIATED', from='PENDING', to='APPROVED'
```

### F.8 — PATCH payout: illegal transition matrix

The route accepts only:

| From       | Allowed transitions   |
|------------|-----------------------|
| PENDING    | APPROVED, CANCELLED   |
| APPROVED   | CANCELLED             |
| PROCESSING | (none — cron-managed) |
| COMPLETED  | (terminal)            |
| FAILED     | CANCELLED             |
| CANCELLED  | (terminal)            |

Validation order matters:

- PATCH body `{ "status": "PROCESSING" }` → **400** at Zod —
  `PatchStatusSchema = z.enum(["APPROVED", "CANCELLED"])` rejects.
- PATCH `{ "status": "CANCELLED" }` against a `COMPLETED` payout →
  **409** `"Cannot transition payout from COMPLETED to CANCELLED
  manually"`.
- PATCH `{ "status": "APPROVED" }` against a `PROCESSING` payout →
  **409** `"Cannot transition payout from PROCESSING to APPROVED
  manually"`.

Force a row into `COMPLETED` for the negative test:

```sql
UPDATE "OrganizationPayout" SET status = 'COMPLETED'
WHERE id = '<SOME_PAYOUT_ID>';
```

Then run the PATCH. Reset state if subsequent phases need a clean board.

### F.9 — Sponsor-only org attempts payout

On `$SPONSOR_ID`:

```bash
curl -s -X POST "http://localhost:3000/api/organizations/$SPONSOR_ID/payouts" \
  -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d '{ "periodStart":"2026-04-01", "periodEnd":"2026-05-01" }'
```

**Expect 409** `"Organization does not host — payouts are unavailable"`.

---

## PHASE G — Rate Cards

### G.1 — POST initial rate card (org-default)

```bash
curl -s -X POST "http://localhost:3000/api/organizations/$HOST_ID/rate-cards" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "platformBps": 1000,
    "orgBps": 4000,
    "consultantBps": 5000,
    "reason": "Initial org default"
  }'
```

**Expect 201**. DB:

```sql
SELECT id, "ownerOrgId", "ownerContractId", "planType",
       "platformBps", "orgBps", "consultantBps",
       "effectiveFrom", "effectiveTo"
FROM "RateCard"
WHERE "ownerOrgId" = '<HOST_ID>'
ORDER BY "effectiveFrom" DESC;
```

One live row; `effectiveTo IS NULL`.

### G.2 — Invalid sum

```bash
curl -s -X POST "http://localhost:3000/api/organizations/$HOST_ID/rate-cards" \
  -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d '{ "platformBps": 1500, "orgBps": 4000, "consultantBps": 5000 }'
```

**Expect 400** `"platformBps + orgBps + consultantBps must equal 10000"`.

### G.3 — Bump the card

```bash
curl -s -X POST "http://localhost:3000/api/organizations/$HOST_ID/rate-cards" \
  -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d '{
    "platformBps": 1500,
    "orgBps": 3500,
    "consultantBps": 5000,
    "reason": "Commission adjustment"
  }'
```

**Expect 201**. Verify `bumpRateCard` rotated atomically:

```sql
SELECT id, "platformBps", "orgBps", "consultantBps",
       "effectiveFrom", "effectiveTo"
FROM "RateCard"
WHERE "ownerOrgId" = '<HOST_ID>'
ORDER BY "effectiveFrom" ASC;
```

Exactly **two** rows:
- Row 1: old splits `1000/4000/5000`, `effectiveTo = <timestamp of bump>`.
- Row 2: new splits `1500/3500/5000`, `effectiveTo IS NULL`.

An OrgAuditLog row with `action='RATE_CARD_BUMPED'`.

### G.4 — Snapshot invariance

Read the earnings seeded in F.3:

```sql
SELECT id, "platformBpsApplied", "orgBpsApplied", "consultantBpsApplied",
       "rateCardIdApplied"
FROM "OrganizationEarnings"
WHERE "organizationId" = '<HOST_ID>';
```

The settled bps values MUST match the **old** `1000/4000/5000` snapshot.
A later bump of the live card cannot rewrite historical earnings. This
is the core "never read the live card for settlement" invariant.

### G.5 — Contract-scoped card

POST a rate card with `contractId` set (contract must belong to this
org). **Expect 201**; new row has `ownerContractId` set and
`ownerOrgId` null. `bumpRateCard` scopes closures by owner-tuple so
contract bumps don't touch org-default rows.

### G.6 — `scope=current` vs `scope=all` GET

```bash
curl -s "http://localhost:3000/api/organizations/$HOST_ID/rate-cards?scope=current" \
  -H "Cookie: $COOKIE"
curl -s "http://localhost:3000/api/organizations/$HOST_ID/rate-cards?scope=all" \
  -H "Cookie: $COOKIE"
```

`current`: only rows with `effectiveFrom ≤ now < effectiveTo`.
`all`: includes closed historical rows.

### G.7 — Cross-tenant contractId enum

GET with a contractId that belongs to another org: **404** `"Contract
not found for this organization"`. Never leaks.

---

## PHASE H — SSO + Domain Claims

### H.1 — PATCH SSO settings (happy)

```bash
curl -s -X PATCH "http://localhost:3000/api/organizations/$HOST_ID/sso" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "allowedEmailDomains": ["testcorp-host.test"],
    "enforceSSO": false,
    "defaultRoleForAutoJoin": "LEARNER"
  }'
```

**Expect 200**. Settings upserted.

### H.2 — Invalid enforce with no provider AND no domain

First clear the allowed-domains list:

```bash
curl -s -X PATCH "http://localhost:3000/api/organizations/$HOST_ID/sso" \
  -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d '{ "allowedEmailDomains": [] }'
```

Then try to enforce:

```bash
curl -s -X PATCH "http://localhost:3000/api/organizations/$HOST_ID/sso" \
  -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d '{ "enforceSSO": true }'
```

**Expect 409** `"Cannot enforce SSO without at least one allowed domain
or SSO provider configured."`

### H.3 — POST an OIDC provider

```bash
curl -s -X POST "http://localhost:3000/api/organizations/$HOST_ID/sso/providers" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "providerType": "oidc",
    "providerId": "testcorp-host-google",
    "issuer": "https://accounts.google.com",
    "domain": "testcorp-host.test",
    "oidcConfig": {
      "clientId": "fake-client",
      "clientSecret": "fake-secret",
      "scopes": ["openid", "email", "profile"]
    }
  }'
```

**Expect 201** with `{ provider: { id, providerId, acsUrl, metadataUrl, ... } }`.
Validate ACS and metadata URLs match `lib/sso/derive-urls.ts` output
(ACS includes `provider.providerId` in the path; metadata url is the
federation metadata endpoint).

### H.4 — POST a SAML provider

```bash
curl -s -X POST "http://localhost:3000/api/organizations/$HOST_ID/sso/providers" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "providerType": "saml",
    "providerId": "testcorp-host-okta",
    "issuer": "https://okta.testcorp-host.test/app/metadata",
    "domain": "eng.testcorp-host.test",
    "samlConfig": {
      "entryPoint": "https://okta.testcorp-host.test/app/sso",
      "cert": "-----BEGIN CERTIFICATE-----MIIC...-----END CERTIFICATE-----"
    }
  }'
```

**Expect 201**.

### H.5 — Mismatched providerType + config body

POST with `providerType="oidc"` but include only `samlConfig`:

**Expect 400** `"oidcConfig is required for providerType=oidc"`.

### H.6 — Duplicate providerId across orgs

POST on a different org with the same `providerId` as H.3:

**Expect 409** `"providerId 'testcorp-host-google' is already in use."`.

### H.7 — Enforce with provider(s), no domain

Clear domains again, then enforce:

```bash
curl -s -X PATCH "http://localhost:3000/api/organizations/$HOST_ID/sso" \
  -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d '{ "enforceSSO": true, "allowedEmailDomains": [] }'
```

**Expect 200** — with at least one SSO provider, enforce is safe.

### H.8 — DELETE last provider while enforced

Delete providers one by one. The DELETE of the **last** provider while
`enforceSSO=true` AND `allowedEmailDomains=[]`:

**Expect 409** `"Cannot delete the last SSO provider while
enforceSSO=true and no allowed domains. Disable enforcement or add a
domain first."`

### H.9 — POST domain claim

```bash
curl -s -X POST "http://localhost:3000/api/organizations/$HOST_ID/domain-claims" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{ "domain": "testcorp-host.test" }'
```

**Expect 201**. DB:

```sql
SELECT id, domain, "organizationId", "claimedAt"
FROM org_domain_claims
WHERE "organizationId" = '<HOST_ID>';
```

### H.10 — Duplicate domain claim (same org)

Replay the same body:

**Expect 409** `"Domain 'testcorp-host.test' is already claimed by this
organization"`.

### H.11 — Duplicate domain claim (other org)

Attempt the same domain on a different org:

**Expect 409** `"Domain 'testcorp-host.test' is already claimed by
another organization"`.

The error phrase distinguishes same-org vs cross-org — both 409, but the
message carries the tenant scope.

### H.12 — DELETE domain-claim safety

Release the last domain while enforceSSO=true + no providers:

**Expect 409** `"Cannot release the last claimed domain while
enforceSSO=true and no SSO providers configured."`

---

## PHASE I — Consent Artifact + HRIS

### I.1 — POST a consent artifact

First make sure the target user has a `Membership` in the org (Alice in
`$SPONSOR_ID`). Then:

```bash
curl -s -X POST "http://localhost:3000/api/organizations/$SPONSOR_ID/consent" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{
    \"userId\": \"$ALICE_USER_ID\",
    \"purposeCodes\": [\"BOOKING_ATTRIBUTION\", \"INVOICING\"],
    \"language\": \"en\",
    \"version\": 1
  }"
```

**Expect 201** `{ consent }`. DB:

```sql
SELECT id, "userId", "dataFiduciary", "purposeCodes", "grantedAt",
       "withdrawnAt", language, version, hash, "auditRetainedUntil"
FROM "ConsentArtifact"
WHERE "userId" = '<ALICE_USER_ID>'
ORDER BY "grantedAt" DESC LIMIT 1;
```

Invariants:
- `dataFiduciary = 'org:<SPONSOR_ID>'`.
- `hash` is a 64-char hex SHA-256 (actually computed from
  `purposeCodes + userId + ...`; validate it's not a placeholder by
  re-hashing in your head).
- `auditRetainedUntil = grantedAt + 7 years` (DPDP Rule 8).

### I.2 — Consent for a non-member

```bash
curl -s -X POST "http://localhost:3000/api/organizations/$SPONSOR_ID/consent" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d "{
    \"userId\": \"$RANDOM_NON_MEMBER_USER_ID\",
    \"purposeCodes\": [\"BOOKING_ATTRIBUTION\"],
    \"language\": \"hi\",
    \"version\": 1
  }"
```

**Expect 404** `"User is not a member of this organization"`.

### I.3 — GET scoped consent list

```bash
curl -s "http://localhost:3000/api/organizations/$SPONSOR_ID/consent?active=true&limit=20" \
  -H "Cookie: $COOKIE"
```

**Expect 200** with `data: [ artifact, ... ]`. An admin in `$HOST_ID`
querying this endpoint for a different user in another org must see an
empty list — the org-scope filter via `membership.userId` is load-bearing.

### I.4 — PUT HRIS config

```bash
curl -s -X PUT "http://localhost:3000/api/organizations/$SPONSOR_ID/hris" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{
    "provider": "CSV",
    "tenantKey": "sponsor-csv-tenant",
    "active": true
  }'
```

**Expect 200 or 201**. DB:

```sql
SELECT id, "organizationId", provider, "tenantKey", active,
       "lastSyncedAt"
FROM "HrisConfig"
WHERE "organizationId" = '<SPONSOR_ID>';
```

One row; `provider='CSV'`, `active=true`, `lastSyncedAt=NULL`.

### I.5 — POST an HRIS sync

For CSV-provider orgs this is the CSV upload path. Exercise it (the
endpoint is at `/hris/csv-upload`); for Workday-style providers there's
a sync trigger at `/hris/sync`.

After the sync:

```sql
SELECT id, status, "recordsProcessed", "startedAt", "completedAt"
FROM "HrisSyncJob"
WHERE "hrisConfigId" = '<HRIS_CONFIG_ID>'
ORDER BY "startedAt" DESC LIMIT 5;

SELECT COUNT(*) FROM "HrisEmployeeMap"
WHERE "hrisConfigId" = '<HRIS_CONFIG_ID>';

-- HrisConfig.lastSyncedAt must advance on success
SELECT "lastSyncedAt" FROM "HrisConfig" WHERE id = '<HRIS_CONFIG_ID>';
```

The last-synced-at timestamp must move forward after a successful sync
(`completedAt IS NOT NULL`, `status='COMPLETED'`).

### I.6 — Sync failure path

Upload a malformed CSV row. The sync must record a `status='FAILED'`
HrisSyncJob with a non-null `errorMessage`, and **must NOT** advance
`HrisConfig.lastSyncedAt`. Treat this as a non-negotiable invariant:
`lastSyncedAt` only moves on full success.

---

## PHASE J — Analytics + Activity Feed

### J.1 — GET one-call analytics aggregate

```bash
curl -s "http://localhost:3000/api/organizations/$SPONSOR_ID/analytics" \
  -H "Cookie: $COOKIE"
```

**Expect 200** with sections:

- `capabilities` — `{ canSponsor, canHost, fundingSource, walletBalance }`
- `members` — `{ total, active, byRole: { OWNER, LEARNER, ... } }`
- `programs` — `{ total, active, activeAssignments }`
- `invoices` (INVOICE funding) — `{ outstanding, pastDue, paidLast30d }`
- (wallet / earnings sections populate based on capability + fundingSource)

On a Hybrid org (`$HYBRID_ID`, WALLET + canHost), the same endpoint must
return BOTH `wallet` and `earnings` sections — the aggregate is driven
by capability, not by a single shape.

All numbers are produced via `groupBy` / `aggregate` queries — no row
enumeration. Verify by cross-checking with direct SQL counts.

### J.2 — Analytics with zero data

On a freshly-created org with no members / programs / invoices, the
endpoint must NOT 500 on empty inputs — it returns zeros for every
section. Test this on a fourth freshly-created org from Phase A.

### J.3 — GET activity feed

```bash
curl -s "http://localhost:3000/api/organizations/$SPONSOR_ID/activity?limit=20" \
  -H "Cookie: $COOKIE"
```

**Expect 200** `{ data: [...], pagination: { hasMore, nextCursor, limit } }`.

The feed must contain every audit-log row written across phases A-I.
Cross-check against the canonical literals in
[`lib/enterprise/audit-actions.ts`](lib/enterprise/audit-actions.ts).
Expected from a clean run of phases A-K:

- **MEMBER**: `MEMBER_ADDED`, `INVITE_SENT`, `INVITE_RESENT`,
  `INVITE_ACCEPTED`, `ROLE_CHANGE`.
- **CONTRACT**: `CONTRACT_CREATED`, `CONTRACT_SIGNED`.
- **PROGRAM**: `PROGRAM_CREATED`, `PROGRAM_ASSIGNED`,
  `RATE_CARD_BUMPED`.
- **WALLET**: `WALLET_TOPUP` (route, D.5) AND `WALLET_TOPUP_CONFIRMED`
  (webhook, D.9). Both literals must appear — missing the second means
  the webhook never settled the entry.
- **INVOICE**: `PURCHASE_ORDER_CREATED`, `INVOICE_GENERATED`,
  `INVOICE_ISSUED`, `INVOICE_PAYMENT_INITIATED` (E.5b),
  `INVOICE_PAID` (E.5c, webhook-emitted), and `INVOICE_VOIDED` if you
  exercised the void path in E.5.
- **PAYOUT**: `PAYOUT_INITIATED` (F.5 + F.7b reuse), `PAYOUT_CANCELLED`
  (F.7).
- **SETTINGS**: `SETTINGS_CHANGED` (Phase K branding upload + any
  general settings PATCH), `SSO_ENABLED`, `DOMAIN_CLAIMED`.
- **CONSENT**: `CONSENT_GRANTED`.
- **SYSTEM**: `VERIFIED` (A.7, admin-initiated, `actorMembershipId`
  NULL).

### J.4 — Filter by category

```bash
curl -s "http://localhost:3000/api/organizations/$SPONSOR_ID/activity?category=MEMBER&limit=10" \
  -H "Cookie: $COOKIE"
```

**Expect 200**; every row has `category='MEMBER'`.

### J.5 — Filter by action literal

```bash
curl -s "http://localhost:3000/api/organizations/$SPONSOR_ID/activity?action=ROLE_CHANGE"
```

**Expect 200**; only ROLE_CHANGE rows. `action` is a free-form string
— pass any literal from [`lib/enterprise/audit-actions.ts`](lib/enterprise/audit-actions.ts).
Do NOT pass strings that aren't in that constant; the route accepts
them (the column is free-form) but the activity feed will be empty
because nothing wrote that literal.

### J.6 — Cursor pagination

First page returns `pagination.nextCursor`. Replay with
`?cursor=<nextCursor>&limit=20`. The second page's first row must be
strictly older than the first page's last row (reverse chronological).

### J.7 — Invalid query

```bash
curl -s "http://localhost:3000/api/organizations/$SPONSOR_ID/activity?category=BOGUS"
```

**Expect 400** with Zod `detail.fieldErrors`.

### J.8 — Cross-org activity leak check

Alice (LEARNER in `$SPONSOR_ID`) must NOT be able to GET activity for
`$HOST_ID`. Also, a LEARNER in `$SPONSOR_ID` should 403 on
`/activity` because the route requires `MANAGER` role satisfaction via
`requireOrgAccess(orgId, "MANAGER")`. Exercise both.

---

## PHASE K — Branding (Logo + Banner Upload)

The branding surface is two assets behind one route:
[`app/api/organizations/[orgId]/branding/[asset]/route.ts`](app/api/organizations/[orgId]/branding/[asset]/route.ts)
where `[asset] ∈ { "logo", "banner" }`. Storage helpers and constants
live in [`lib/supabase.ts`](lib/supabase.ts):
`ORG_LOGO_MAX_SIZE = 2 MB`, `ORG_BANNER_MAX_SIZE = 5 MB`,
`ALLOWED_ORG_BRANDING_IMAGE_TYPES = ["image/jpeg", "image/jpg",
"image/png", "image/webp", "image/svg+xml"]`. OWNER-only on both verbs.

Run this phase against any seeded org — every shape qualifies because
branding is a pure settings surface (no `canSponsor` / `canHost`
dependency).

### K.1 — Upload a logo

```bash
curl -s -X POST \
  "http://localhost:3000/api/organizations/$SPONSOR_ID/branding/logo" \
  -H "Cookie: $COOKIE" \
  -F "file=@./test-fixtures/logo-512.png;type=image/png"
```

**Expect 200** with `{ organization: { id, logo, bannerImage } }` —
`logo` populated to the public Supabase URL. Verify:

```sql
SELECT id, logo, "bannerImage" FROM organizations WHERE id = '<SPONSOR_ID>';

SELECT action, category, details
FROM "OrgAuditLog"
WHERE "organizationId" = '<SPONSOR_ID>'
  AND category = 'SETTINGS'
ORDER BY "createdAt" DESC LIMIT 1;
-- action='SETTINGS_CHANGED'; details->>'asset'='logo';
-- details->>'storagePath' present; details->>'fileUrl' matches the column.
```

### K.2 — Upload a banner

```bash
curl -s -X POST \
  "http://localhost:3000/api/organizations/$SPONSOR_ID/branding/banner" \
  -H "Cookie: $COOKIE" \
  -F "file=@./test-fixtures/banner-1920.jpg;type=image/jpeg"
```

**Expect 200**. `Organization.bannerImage` populated; new
`SETTINGS_CHANGED` audit row with `details.asset = 'banner'`.

### K.3 — Invalid asset path

```bash
curl -s -X POST \
  "http://localhost:3000/api/organizations/$SPONSOR_ID/branding/avatar" \
  -H "Cookie: $COOKIE" \
  -F "file=@./test-fixtures/logo-512.png;type=image/png"
```

**Expect 400** `"Invalid asset — must be 'logo' or 'banner'"`. The
asset enum is enforced at the very top of both POST and DELETE handlers
so this rejects before any auth check (cheap pre-flight).

### K.4 — Disallowed content type

```bash
curl -s -X POST \
  "http://localhost:3000/api/organizations/$SPONSOR_ID/branding/logo" \
  -H "Cookie: $COOKIE" \
  -F "file=@./test-fixtures/notes.pdf;type=application/pdf"
```

**Expect 400** `"Invalid file type. Please upload a JPEG, PNG, WebP,
or SVG image."` `Organization.logo` unchanged (verify with the same
SELECT as K.1 — value identical to the K.1 result).

### K.5 — Oversized file

Logo limit is **2 MB**; banner is **5 MB**.

```bash
curl -s -X POST \
  "http://localhost:3000/api/organizations/$SPONSOR_ID/branding/logo" \
  -H "Cookie: $COOKIE" \
  -F "file=@./test-fixtures/huge-3mb.png;type=image/png"
```

**Expect 400** `"File size exceeds 2MB limit"` (the route uses 400, not
413, because the size guard is a Zod-style validation, not an HTTP
content-length rejection — see route lines 93-100).

Banner equivalent with a >5 MB file → `"File size exceeds 5MB limit"`.

### K.6 — Non-OWNER session

As a MAINTAINER / MANAGER session:

**Expect 403** — `requireOrgOwner` rejects everything below OWNER even
though branding is a "soft" surface. Branding is the org's public face;
the gate is intentional.

### K.7 — DELETE clears the column

```bash
curl -s -X DELETE \
  "http://localhost:3000/api/organizations/$SPONSOR_ID/branding/logo" \
  -H "Cookie: $COOKIE"
```

**Expect 200** with `{ organization: { id, logo: null, bannerImage: <previous-or-null> } }`.
Verify:

```sql
SELECT logo, "bannerImage" FROM organizations WHERE id = '<SPONSOR_ID>';
-- logo IS NULL; bannerImage unchanged.

SELECT action, details FROM "OrgAuditLog"
WHERE "organizationId" = '<SPONSOR_ID>'
  AND category = 'SETTINGS'
  AND details->>'removed' = 'true'
ORDER BY "createdAt" DESC LIMIT 1;
-- action='SETTINGS_CHANGED'; details->>'asset'='logo'; details->>'removed'='true'.
```

### K.8 — DELETE on already-empty asset

Re-issue the K.7 DELETE.

**Expect 200** with `{ organization, message: "No logo to delete" }`
— short-circuit branch (route lines 174-179). No new audit row.

### K.9 — DELETE invalid asset

```bash
curl -s -X DELETE \
  "http://localhost:3000/api/organizations/$SPONSOR_ID/branding/wallpaper" \
  -H "Cookie: $COOKIE"
```

**Expect 400** `"Invalid asset — must be 'logo' or 'banner'"`.

---

## WRAP-UP — Acceptance Matrix

At the end of the run, produce a matrix:

```
             A    B    C    D    E    F    G    H    I    J    K
Sponsor      ✓    ✓    ✓    -    ✓    -    -    ✓    ✓    ✓    ✓
Host         ✓    ✓    -    -    -    ✓    ✓    ✓    -    ✓    ✓
Hybrid       ✓    ✓    ✓    ✓    -    -    -    -    -    ✓    ✓
Rahul solo   ✓    -    -    -    -    ✓    ✓    -    -    ✓    ✓
```

(`-` = N/A for that capability combo; every `✓` must be backed by either
a Supabase SQL query result or a curl log attached to the phase section.
Phase K is `✓` for every seeded org because branding has no capability
gate — every org has a logo/banner surface.)

Flag any cells that deviate from the expected 200 / 4xx codes.
Flag any SQL queries whose rows don't match the invariants stated in
the "BACKGROUND YOU MUST INTERNALIZE" section (capability booleans,
funding-source transitions, rate-card snapshots, ledger net-to-zero).

### Ledger cross-check (must run after all phases)

```sql
-- Funding ledger nets to current wallet balance for every WALLET org.
SELECT ba."ownerOrgId", ba."walletBalance",
       COALESCE(SUM(f."deltaPaise"), 0) AS ledger_sum
FROM "BillingAccount" ba
LEFT JOIN "FundingLedgerEntry" f ON f."billingAccountId" = ba.id
WHERE ba."fundingSource" = 'WALLET'
GROUP BY ba.id, ba."ownerOrgId", ba."walletBalance";

-- Settlement ledger: for every payout with status='COMPLETED' (or test
-- surrogate), the PAYOUT_SENT settlement total equals payout.netPayoutPaise.
SELECT p.id AS payout, p."netPayoutPaise",
       COALESCE(SUM(-s."amountPaise"), 0) AS ledger_sum
FROM "OrganizationPayout" p
LEFT JOIN "SettlementLedgerEntry" s
       ON s."payoutId" = p.id AND s.kind = 'PAYOUT_SENT'
GROUP BY p.id;

-- Usage ledger: for every non-reversed BookingUtilization, there is a
-- matching positive UsageLedgerEntry. For reversed rows, a second
-- negative entry exists.
SELECT bu.id, bu."reversedAt",
       (SELECT COUNT(*) FROM "UsageLedgerEntry" u
        WHERE u."paymentId" = bu."paymentId") AS ledger_rows
FROM "BookingUtilization" bu
LIMIT 20;
```

Report any row where the ledger doesn't reconcile — that's a blocking
defect regardless of which phase surfaced it.

### Snapshot invariance cross-check

```sql
-- No earnings row should have bps values that match the CURRENT live
-- rate card AFTER a bump happened. If they do, settlement is reading
-- the live card instead of the snapshot.
SELECT e.id, e."platformBpsApplied", e."orgBpsApplied",
       e."consultantBpsApplied",
       rc."platformBps" AS live_platform, rc."orgBps" AS live_org,
       rc."consultantBps" AS live_consultant
FROM "OrganizationEarnings" e
LEFT JOIN "RateCard" rc
       ON rc."ownerOrgId" = e."organizationId"
      AND rc."effectiveTo" IS NULL
WHERE e."createdAt" < rc."effectiveFrom"
  AND (e."platformBpsApplied" = rc."platformBps"
    OR e."orgBpsApplied" = rc."orgBps"
    OR e."consultantBpsApplied" = rc."consultantBps");
```

Zero rows expected on a clean run — any hit implies retroactive-settlement
drift.

---

## EXPECTED OUTPUT FROM A TEST RUN

A markdown report with:

1. **One H2 per phase** (A-J) containing:
   - Pass/fail for each sub-step (A.1, A.2, …).
   - Exact `curl` commands run + status codes received.
   - The SQL queries executed + a small summary of the rows returned.
   - A Chrome DevTools screenshot path (if the step touched the UI).
2. **An H2 "Bugs fixed"** section listing every defect that surfaced and
   the commit/diff that resolved it. No bug should appear without a
   fix — see Critical Rule #1.
3. **Final acceptance table** as rendered in WRAP-UP.
4. **Ledger cross-check output** — verbatim query results.
5. **Snapshot invariance output** — verbatim query results (expected
   empty).

---

## REFERENCES

The full code-pointer index lives in
[`e2e-enterprise-shared-setup.md` § REFERENCES](./e2e-enterprise-shared-setup.md#references-read-once-if-stuck).
Read it once when stuck on a sub-step, then come back here.

---

**Proceed phase by phase. Fix on sight. Verify in SQL. Report the matrix.**
