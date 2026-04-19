# E2E Enterprise Walkthrough — Arch 4-Modified End-to-End Acceptance

## Role & Mission

You are a **senior QA engineer** performing a hands-on acceptance walkthrough
of the Arch 4-Modified enterprise layer on branch `feature/enterprise-arch4`
of `/Users/kaustavghosh/Desktop/familiarise_web`.

This file is your single source of truth — you will have **no conversation
history**. Everything you need (capability model, funding sources, program
subtypes, rate-card semantics, ledger invariants, exact HTTP surface area,
expected status codes, and the SQL to verify each step against Supabase) is
baked in below.

Your job is to walk **Phases A through J** end-to-end, producing a per-phase
pass/fail matrix backed by Supabase SQL, `curl` logs, and Chrome DevTools
snapshots.

You have access to two critical MCP tools:

1. **Supabase MCP** — query / verify DB state via `execute_sql`.
2. **Chrome DevTools MCP** — drive the UI at `http://localhost:3000`.

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`

---

## CRITICAL RULES

1. **Fix bugs immediately.** If a flow is broken — bad status code, stale
   enum leak, unhandled 500, a UI crash, a ledger that doesn't net to zero
   — stop, diagnose, patch the source in-place, re-verify, and continue.
   Do NOT accumulate a bug list.

2. **Verify DB state after every meaningful action.** The UI can lie; the
   three ledgers (`UsageLedgerEntry`, `FundingLedgerEntry`,
   `SettlementLedgerEntry`) are the source of truth. Query them via
   Supabase MCP at every checkpoint.

3. **Test both happy paths AND guard paths.** Every route has 4xx branches
   (disabling both capabilities, WALLET→X with balance > 0, duplicate
   domain claims, last-OWNER demotion). Exercise each explicitly.

4. **Take snapshots liberally.** `take_snapshot` before every click,
   `take_screenshot` on anything visually wrong. Use `list_network_requests`
   to capture exact API shape when a response surprises you.

5. **All money in paise** (1 INR = 100 paise). Applies to
   `BillingAccount.walletBalance`, `WalletEntry.deltaPaise`,
   `OrganizationInvoice.totalPaise`, `OrganizationPayout.amountPaise`,
   `ProgramAssignment.*`, everything.

6. **Double-quote Postgres identifiers** that Prisma emitted as mixed-case
   (e.g. `"Membership"`, `"BillingAccount"`, `"Contract"`). BetterAuth-mapped
   tables are lower-case (`organizations`, `members`, `invitations`). The
   Schema Reference table below lists every model.

7. **App runs at** `http://localhost:3000`. Dev server must already be up
   (`npm run dev`). You will NOT be starting or building it.

---

## BACKGROUND YOU MUST INTERNALIZE BEFORE PHASE A

### Capability model (replaces OrganizationKind)

`Organization` carries two booleans — `canSponsor` and `canHost` — that
together express the four conceivable shapes:

| canSponsor | canHost | Shape name | Example             |
|------------|---------|-----------|---------------------|
| `true`     | `false` | Sponsor   | Wipro (pays for its engineers' consults) |
| `false`    | `true`  | Host      | IIT Madras (hosts professors who earn through the org) |
| `true`     | `true`  | Hybrid    | LearnPro (both buys sessions for staff AND hosts its own instructors) |
| `false`    | `false` | **Invalid** — at least one must be true |

An org can express further capabilities via the `capabilitiesExtra Json?`
escape hatch (e.g. `{ "RESELL": true }`) without a migration, but the two
typed booleans cover the 90% path.

### FundingSource (replaces OrganizationBillingMode)

`BillingAccount.fundingSource` is one of:

- `PERSONAL` — learner pays their own card; `Payment.organizationId` is
  tagged for attribution but the org pays nothing.
- `LICENSE` — flat enterprise license (superset of the old
  `PREPAID_UNLIMITED`).
- `WALLET` — GLG-style credit pool. `walletBalance` is int paise;
  topped up via `/wallet/top-ups`; debited at booking with a
  `WalletEntry` row.
- `INVOICE` — NET-X postpaid. Bookings accrue until an
  `OrganizationInvoice` gets cut; `creditLimit` caps outstanding.
- `PROJECT` — v2-reserved placeholder; not wired in v1 but must round-trip
  without 500.

One BillingAccount per org when `canSponsor=true`. `canSponsor=false` orgs
have NO BillingAccount at all.

### Program subtypes

`Program.type` drives a discriminated subtype:

- `LICENSED_SEAT` — has a 1:1 `LicensedSeatConfig` row. `ratePerSeatPaise`
  + `cycle` + optional `coveredSessionsPerCycle` (null = unlimited, which
  replaces the old `PREPAID_UNLIMITED`). `overageBehavior` ∈
  `{ BLOCK, CHARGE_MEMBER, CHARGE_ORG }`.
- `CREDIT_POOL` — has a 1:1 `CreditPoolConfig` row. `creditValuePaise`
  + optional `premiumMultiplier` (GLG-style tier) +
  `minimumCreditsPerPeriod`.
- `PROJECT` / `RETAINER` — enum values reserved for v2. Not accepted at
  the create endpoint today; a v2 body must 400.

Per-member entitlement: `ProgramAssignment` (with
`(programId, membershipId, periodStart)` unique). Per-booking usage:
`BookingUtilization`.

### Member roles (disjoint from UserRole)

`MemberRole = { OWNER, MAINTAINER, MANAGER, EXPERT, LEARNER, SUPPORT }`.

- `OWNER` — full org control, budget-moving actions (contracts, rate
  cards, funding source flips, payouts).
- `MAINTAINER` — org admin below owner. Was the old `ADMIN`; renamed to
  avoid colliding with `UserRole.ADMIN` (platform admin).
- `MANAGER` — read-heavy admin (invoices, earnings, audit log).
- `EXPERT` — delivers services on behalf of the org. Was `CONSULTANT`;
  renamed because the org-side term must be disjoint from
  `UserRole.CONSULTANT`. Do NOT say "consultant" for a member — say
  "expert".
- `LEARNER` — consumes services through the org.
- `SUPPORT` — internal ops / CX role.

### Three ledgers

All immutable; reconciliation invariants are in
`docs/enterprise/18-three-ledger-discipline.md`. The three surfaces:

- `UsageLedgerEntry` — sessions consumed (positive deltas; negative on
  reversal).
- `FundingLedgerEntry` — wallet deltas (`TOPUP`, `BOOKING_DEBIT`,
  `REFUND_CREDIT`, `ADJUSTMENT`, `GRANT`). `balanceAfterPaise` is
  persisted for reconciliation.
- `SettlementLedgerEntry` — invoices, payouts, refunds (`INVOICE_ISSUED`,
  `INVOICE_PAID`, `PAYMENT_RECEIVED`, `REFUND_ISSUED`, `PAYOUT_SENT`,
  `CHARGEBACK`, `CREDIT_NOTE`).

### RateCard and bumping

`RateCard` has `effectiveFrom` / `effectiveTo`. **Rate cards are never
mutated after creation**; a change rotates via
`lib/api/organizations/rate-card.ts#bumpRateCard`, which:

1. `UPDATE` the currently-live card's `effectiveTo = now()`.
2. `INSERT` a new row with `effectiveFrom = now()`, `effectiveTo = null`.

Invariant: `platformBps + orgBps + consultantBps === 10000` (basis
points; integer math — no float drift).

Settlement reads the **snapshot** on `OrganizationEarnings.{platformBps,
orgBps, consultantBps}Applied` — never the live card. Bumping doesn't
rewrite history.

### Refund semantics

`BookingUtilization.reversedAt` + `reversalReason`. The row is **never
deleted**; reversal is expressed by setting those two fields and
appending a counter `UsageLedgerEntry` (negative `sessionsConsumed`).

### Audit log

`OrgAuditLog.action` is a **free-form String** (so new actions like
`REFUND_DENIED`, `CONSENT_WITHDRAWN`, `OVERAGE_CHARGED` land without a
migration) paired with a small stable `category: OrgAuditCategory` enum
(`MEMBER | CONTRACT | PROGRAM | WALLET | INVOICE | PAYOUT | SETTINGS |
CONSENT | SYSTEM`). Well-known action literals come from the autocomplete
constant `AUDIT_ACTIONS` in `lib/enterprise/audit-actions.ts`. There's a
legacy `OrgAuditAction` enum in the schema kept for type-checking only
— the DB column uses the string.

### Stackable funding

`PaymentLeg` rows attach to a `Payment` when `> 1` funding source
contributed to it. Sources: `CARD | WALLET | REFERRAL_CREDIT |
INVOICE_ACCRUAL | LICENSE`. When a single source paid, no `PaymentLeg`
rows are written — the parent `Payment` is sufficient.

### India compliance

Fields are final on `Invoice` / `PurchaseOrder` / `OrganizationPayout`
/ `Organization`. The actual logic (TDS, MSME, GST, IRP, DPDP, Form-15)
is stubbed in `lib/compliance/**` — stubs return sensible defaults
(zero tax, null IRN, default 60-day payment deadline). Do not treat
those defaults as bugs; the schema is ready, the wiring is in-flight.

---

## SCHEMA REFERENCE — Table Names

| Prisma Model | PostgreSQL Table | Key notes |
|---|---|---|
| `Organization` | `organizations` | BetterAuth `@@map` |
| `Member` | `members` | BetterAuth `@@map`; invitation-token shim only |
| `Invitation` | `invitations` | BetterAuth `@@map` |
| `Membership` | `"Membership"` | Typed source of truth for roles |
| `BillingAccount` | `"BillingAccount"` | fundingSource + walletBalance + creditLimit |
| `Contract` | `"Contract"` | status: DRAFT/ACTIVE/EXPIRED/TERMINATED |
| `BillingSubscription` | `"BillingSubscription"` | PER_SEAT or FLAT_FEE |
| `WalletEntry` | `"WalletEntry"` | Immutable; `providerOrderId @unique` |
| `Program` | `"Program"` | LICENSED_SEAT or CREDIT_POOL |
| `LicensedSeatConfig` | `"LicensedSeatConfig"` | 1:1 with Program |
| `CreditPoolConfig` | `"CreditPoolConfig"` | 1:1 with Program |
| `ProgramAssignment` | `"ProgramAssignment"` | Per-member entitlement |
| `BookingUtilization` | `"BookingUtilization"` | Per-booking usage + reversedAt |
| `RateCard` | `"RateCard"` | Sum of 3 bps fields = 10000 |
| `OrganizationPayoutAccount` | `"OrganizationPayoutAccount"` | |
| `OrganizationEarnings` | `"OrganizationEarnings"` | `platformBpsApplied` etc. snapshot |
| `OrganizationPayout` | `"OrganizationPayout"` | Includes TDS/MSME/FEMA fields |
| `OrganizationInvoice` | `"OrganizationInvoice"` | GST + IRN fields |
| `PurchaseOrder` | `"PurchaseOrder"` | `@@unique([organizationId, poNumber])` |
| `OrganizationPlan` | `"OrganizationPlan"` | |
| `OrganizationSSOSettings` | `"OrganizationSSOSettings"` | |
| `SsoProvider` | `"SsoProvider"` | BetterAuth-managed |
| `OrgDomainClaim` | `org_domain_claims` | `@@map` |
| `OrgAuditLog` | `"OrgAuditLog"` | `action: String` (free-form) |
| `UsageLedgerEntry` | `"UsageLedgerEntry"` | |
| `FundingLedgerEntry` | `"FundingLedgerEntry"` | |
| `SettlementLedgerEntry` | `"SettlementLedgerEntry"` | |
| `ConsentArtifact` | `"ConsentArtifact"` | DPDP grants |
| `HrisConfig` | `"HrisConfig"` | |
| `HrisSyncJob` | `"HrisSyncJob"` | |
| `HrisEmployeeMap` | `"HrisEmployeeMap"` | |
| `PaymentLeg` | `"PaymentLeg"` | |

Remember: unquoted identifiers are lower-cased by Postgres. Double-quote
every mixed-case model table.

---

## PREREQUISITES

### P.1 — DB reset + seed

```bash
cd /Users/kaustavghosh/Desktop/familiarise_web
npx prisma db push --force-reset
npm run db:seed
```

This seeds the four representative org shapes:

- **Wipro** — Sponsor-only, `fundingSource=INVOICE`, `LICENSED_SEAT` program.
- **LearnPro Academy** — Hybrid (canSponsor + canHost),
  `fundingSource=LICENSE`.
- **IIT Madras** — Host-only, `fundingSource=PERSONAL` (students pay their
  own card for external-consultant access).
- **Rahul's Coaching** — solo consultant, micro-Host org auto-created on
  onboarding.

Owner emails the seed stamps (use these for Chrome DevTools login):

| Org          | Owner email                 |
|--------------|-----------------------------|
| Wipro        | `founder@wipro.test`        |
| IIT Madras   | `founder@iitmadras.test`    |
| LearnPro     | `founder@learnpro.test`     |
| Rahul solo   | `rahul@familiarise.test`    |

Password for all seeded accounts: `TestPassword123!`.

### P.2 — Dev server

```bash
curl -sf http://localhost:3000/api/health
# Expect { "ok": true } or 200.
```

If unreachable, ask the user to start `npm run dev` — do NOT start it
yourself.

### P.3 — Static checks before mutating

```bash
npx tsc --noEmit
npm run lint
```

These are guard rails — if either fails you've got pre-existing breakage
in the branch. Fix before touching test flows.

### P.4 — Get a session cookie for curl

Log in via Chrome DevTools MCP first, then copy the `better-auth.session`
cookie from `list_network_requests` and export it:

```bash
export COOKIE='better-auth.session=<paste-here>; better-auth.session_token=<paste-here>'
```

Replay throughout the walkthrough. Each `curl` below assumes `$COOKIE`.

---

## PHASE A — Organization Creation + Capability Flips

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
      \"coveredSessionsPerCycle\": 4,
      \"overageBehavior\": \"CHARGE_MEMBER\"
    }
  }"
```

**Expect 201**. DB check:

```sql
SELECT p.id, p.type, p.name, lsc."ratePerSeatPaise", lsc."cycle",
       lsc."coveredSessionsPerCycle", lsc."overageBehavior"
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
       "sessionsUsed", "overageCount"
FROM "ProgramAssignment"
WHERE "programId" = '<PROGRAM_ID>'
  AND "membershipId" = '<ALICE_MEMBERSHIP_ID>';
```

Exactly one row; `sessionsUsed=0`, `overageCount=0`.

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

```bash
curl -s -X POST \
  "http://localhost:3000/api/organizations/$HYBRID_ID/billing-account/wallet/top-ups" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{ "amountPaise": 500000 }'
```

**Expect 201** `{ providerOrderId, amountPaise: 500000, status: "pending",
reused: false }`. A pending `WalletEntry` row is created:

```sql
SELECT id, "deltaPaise", reason, "balanceAfter", "providerOrderId",
       "providerPaymentId", "createdAt"
FROM "WalletEntry"
WHERE "billingAccountId" = '<HYBRID_BA_ID>'
ORDER BY "createdAt" DESC
LIMIT 3;
```

The pending row carries the `providerOrderId` from the response,
`reason='TOPUP'`.

### D.6 — Idempotent retry via client key

```bash
curl -s -X POST \
  "http://localhost:3000/api/organizations/$HYBRID_ID/billing-account/wallet/top-ups" \
  -H "Content-Type: application/json" \
  -H "Cookie: $COOKIE" \
  -d '{ "amountPaise": 500000, "clientIdempotencyKey": "ckey-phaseD-001" }'
```

First call: 201 with `reused: false`. Repeat the same body: **200 with
`reused: true`** — the `providerOrderId @unique` stops a second row from
landing.

### D.7 — Top-up with amount below ₹100

```bash
curl -s -X POST \
  "http://localhost:3000/api/organizations/$HYBRID_ID/billing-account/wallet/top-ups" \
  -H "Content-Type: application/json" -H "Cookie: $COOKIE" \
  -d '{ "amountPaise": 5000 }'
```

**Expect 400** — Zod min is `10_000` paise (₹100).

### D.8 — Top-up on non-WALLET account

PATCH Hybrid back to INVOICE (only possible once wallet is zero). Then:

**Expect 409** `"Top-ups are only allowed on WALLET funding"`. Revert to
WALLET after.

### D.9 — Ledger invariant (post-confirmed top-up)

Simulate webhook confirmation (or use the dev helper `confirmTopUp`) so
one WalletEntry lands with `reason='TOPUP'`, `deltaPaise=500000`,
`balanceAfter=500000`. Then verify the **three-ledger discipline**:

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
```

Invariant: wallet balance equals wallet-ledger sum for settled rows. The
pending-but-unconfirmed rows are excluded from the balance.

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

### E.5 — State machine: DRAFT → ISSUED → PAID

- DRAFT → ISSUED via PATCH (covered in the `[invoiceId]` route; include
  that PATCH test; expect 200 + `issuedAt` populated + a
  `SettlementLedgerEntry(kind=INVOICE_ISSUED)` row).
- PAID is **webhook-only**. A manual PATCH setting `status='PAID'` must
  refuse (either 400 or 409 depending on the guard). Confirm via code
  reading if the UI path is blocked.

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

**Expect 200**. Earnings flip back to `READY`, `orgPayoutId` cleared.
A compensating SettlementLedgerEntry (opposite sign) lands so the ledger
nets to zero for the cancelled payout.

### F.8 — PATCH payout: illegal transition

Try `COMPLETED → CANCELLED`:

**Expect 409** `"Cannot transition payout from COMPLETED to CANCELLED
manually"`.

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

The feed must contain every audit-log row written across phases A-I:
MEMBER_ADDED, INVITE_SENT, INVITE_RESENT, INVITE_ACCEPTED, ROLE_CHANGE,
CONTRACT_CREATED, CONTRACT_SIGNED, PROGRAM_CREATED, PROGRAM_ASSIGNED,
WALLET_TOPUP, PURCHASE_ORDER_CREATED, INVOICE_GENERATED,
SETTINGS_CHANGED, SSO_ENABLED, DOMAIN_CLAIMED, CONSENT_GRANTED,
PAYOUT_INITIATED, VERIFIED, RATE_CARD_BUMPED, etc.

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
— pass any literal from `lib/enterprise/audit-actions.ts`.

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

## WRAP-UP — Acceptance Matrix

At the end of the run, produce a matrix:

```
             A    B    C    D    E    F    G    H    I    J
Sponsor      ✓    ✓    ✓    -    ✓    -    -    ✓    ✓    ✓
Host         ✓    ✓    -    -    -    ✓    ✓    ✓    -    ✓
Hybrid       ✓    ✓    ✓    ✓    -    -    -    -    -    ✓
Rahul solo   ✓    -    -    -    -    ✓    ✓    -    -    ✓
```

(`-` = N/A for that capability combo; every `✓` must be backed by either
a Supabase SQL query result or a curl log attached to the phase section.)

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

## REFERENCES (READ ONCE IF STUCK)

- Capability model: `prisma/schema.prisma` `model Organization` (line ~417).
- Member roles: `prisma/schema.prisma` `enum MemberRole` (~643).
- Funding sources: `prisma/schema.prisma` `enum FundingSource` (~737).
- Program subtypes: `prisma/schema.prisma` `model Program` (~859),
  `LicensedSeatConfig` / `CreditPoolConfig` (~889 / ~900).
- Rate-card bumping: `lib/api/organizations/rate-card.ts`.
- Audit-action constants: `lib/enterprise/audit-actions.ts`.
- Three-ledger invariants: `docs/enterprise/18-three-ledger-discipline.md`.
- Auth helpers: `lib/auth-helpers.ts` — `requireApiAuth`,
  `requireOrgAccess(orgId, minRole)`, `requireOrgOwner(orgId)`,
  `requireAdminAuth`, `orgRoleSatisfies`.
- Create-org route: `app/api/organizations/route.ts`.
- Accept-invitation race: `app/api/organizations/invitations/accept/route.ts`
  (the `updateMany WHERE status=pending` atomic-claim is the core).
- SSO URL derivation: `lib/sso/derive-urls.ts` (`deriveAcsUrl`,
  `deriveMetadataUrl`).
- India compliance stubs: `lib/compliance/{tds,msme,gst,irp,dpdp,form15}.ts`.

When a step yields unexpected behaviour, read the exact route file
from `app/api/organizations/**` before escalating — most answers live
in the handler's inline comments, not in higher-level docs.

---

**Proceed phase by phase. Fix on sight. Verify in SQL. Report the matrix.**
