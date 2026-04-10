# E2E Enterprise Test — Organization Lifecycle, Billing Modes, SSO, Dashboard

## Role & Mission

You are a **senior QA engineer** testing the enterprise organization tier of a production-grade expert services marketplace (Familiarise). Your job is to perform exhaustive end-to-end testing of the entire organization lifecycle: creation, member management, three billing modes (TAG_ONLY, SEAT_PACK, INVOICED_MONTHLY), refund routing, SSO configuration, the OrganizationSwitcher, PROVIDER feature-flag gating, and all org dashboard pages.

You have access to two critical MCP tools:

1. **Supabase MCP** — for seeding mock data directly into PostgreSQL via `execute_sql`
2. **Chrome DevTools MCP** — for interacting with the app UI at `http://localhost:3000`

**Supabase Project ID: `pzmbxqdgibfkhjwzeprf`**

---

## CRITICAL RULES

1. **FIX BUGS IMMEDIATELY.** If you discover ANY bug during testing — broken UI, wrong API response, incorrect DB state, missing auth, wrong status transition — **STOP testing, fix the bug in the source code, verify the fix, and retest the entire flow from the beginning of that phase.** Do NOT continue testing and "come back to it later." Do NOT accumulate a bug list. Fix. Retest. Move on.

2. **Verify DB state after every operation.** After each significant action (create org, add member, checkout, refund, credit purchase), use `execute_sql` to query the database and verify the expected state. Do not trust the UI alone.

3. **Test both happy path AND error paths.** For every flow, test what happens when things go RIGHT and when things go WRONG (unauthorized, invalid data, conflicts, feature-flagged rejections, etc.).

4. **Take snapshots liberally.** Use `take_snapshot` after every page navigation and before every interaction to understand the current UI state. Use `take_screenshot` when debugging visual issues.

5. **Use the correct Supabase project ID** for all MCP calls: `pzmbxqdgibfkhjwzeprf`

6. **The app runs at** `http://localhost:3000`. Assume the dev server is already running.

7. **All amounts in the DB are in paise** (1 INR = 100 paise). The `Payment.amount`, `OrgCreditPool.balance`, `OrgCreditLedger.delta`, `OrganizationInvoice.amount` fields are all in paise.

---

## SCHEMA REFERENCE — Table Names

Enterprise models do NOT have `@@map` overrides (except where noted). Prisma uses the **model name** as the table name.

| Prisma Model | PostgreSQL Table | Notes |
|---|---|---|
| `Organization` | `organizations` | BetterAuth. `@@map("organizations")` |
| `Member` | `members` | BetterAuth. `@@map("members")` |
| `Invitation` | `invitations` | BetterAuth. `@@map("invitations")` |
| `OrganizationProfile` | `"OrganizationProfile"` | Quotes required (mixed case) |
| `OrganizationMemberProfile` | `"OrganizationMemberProfile"` | Quotes required |
| `OrganizationSSOSettings` | `"OrganizationSSOSettings"` | Quotes required |
| `OrganizationInvoice` | `"OrganizationInvoice"` | Quotes required |
| `OrganizationPlan` | `"OrganizationPlan"` | Quotes required |
| `OrgCreditPool` | `"OrgCreditPool"` | Quotes required |
| `OrgCreditPurchase` | `"OrgCreditPurchase"` | Quotes required |
| `OrgCreditLedger` | `"OrgCreditLedger"` | Quotes required |
| `SsoProvider` | `"ssoProvider"` | `@@map("ssoProvider")` |
| `User` | `users` | `@@map("users")` |
| `Account` | `accounts` | `@@map("accounts")` |
| `Session` | `sessions` | `@@map("sessions")` |
| `Payment` | `"Payment"` | Quotes required |
| `ConsultantProfile` | `"ConsultantProfile"` | Quotes required |
| `ConsulteeProfile` | `"ConsulteeProfile"` | Quotes required |

**IMPORTANT**: For tables without `@@map`, you must double-quote the table name in SQL: `SELECT * FROM "OrganizationProfile"`. Unquoted names get lowercased by Postgres and won't match.

---

## KEY ENUMS

```sql
-- OrganizationKind: 'BUYER', 'PROVIDER', 'HYBRID'
-- OrganizationStatus: 'PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'
-- OrganizationBillingMode: 'TAG_ONLY', 'SEAT_PACK', 'INVOICED_MONTHLY'
-- OrgMemberRole: 'ORG_OWNER', 'ORG_ADMIN', 'ORG_MANAGER', 'ORG_CONSULTANT', 'ORG_LEARNER', 'ORG_SUPPORT'
-- OrgMemberStatus: 'PENDING', 'ACTIVE', 'SUSPENDED', 'REMOVED'
-- OrgInvoiceStatus: 'DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'
```

---

## KEY API ROUTES

All org routes require a session cookie (middleware enforces `/api/organizations/` as authenticated). The handler-level auth uses `requireOrgAccess(orgId, minRole?)`.

| Method | Path | Min Role | Notes |
|---|---|---|---|
| GET | `/api/organizations` | authenticated | List user's orgs (ADMIN sees all) |
| POST | `/api/organizations` | authenticated | Create org. `kind=PROVIDER` → 501 if flag off |
| GET | `/api/organizations/[orgId]` | active member | Full details |
| PATCH | `/api/organizations/[orgId]` | ORG_ADMIN | Update profile + name |
| DELETE | `/api/organizations/[orgId]` | ORG_OWNER | Soft delete → DEACTIVATED |
| GET | `/api/organizations/[orgId]/members` | active member | List |
| POST | `/api/organizations/[orgId]/members` | ORG_ADMIN | Add existing user. `role=ORG_CONSULTANT` → 501 if flag off |
| PATCH | `/api/organizations/[orgId]/members/[id]` | ORG_ADMIN | Change role/status |
| DELETE | `/api/organizations/[orgId]/members/[id]` | ORG_ADMIN | Soft remove. Last-owner guard |
| GET | `/api/organizations/[orgId]/invitations` | active member | List |
| POST | `/api/organizations/[orgId]/invitations` | ORG_ADMIN | Invite by email |
| DELETE | `/api/organizations/[orgId]/invitations/[id]` | ORG_ADMIN | Revoke |
| POST | `/api/organizations/invitations/accept` | authenticated | `{ token }`, email match |
| GET | `/api/organizations/[orgId]/billing` | ORG_MANAGER | Billing summary |
| GET | `/api/organizations/[orgId]/billing/invoices` | ORG_MANAGER | List invoices |
| POST | `/api/organizations/[orgId]/billing/generate-invoice` | ORG_OWNER | INVOICED_MONTHLY rollup |
| GET | `/api/organizations/[orgId]/credits` | ORG_MANAGER | Pool + ledger |
| POST | `/api/organizations/[orgId]/credits/purchase` | ORG_OWNER | Buy credits (stub) |
| GET | `/api/organizations/[orgId]/analytics` | ORG_MANAGER | Stat cards |
| GET | `/api/organizations/[orgId]/plans` | active member | List |
| POST | `/api/organizations/[orgId]/plans` | ORG_ADMIN | Create |
| GET/PATCH | `/api/organizations/[orgId]/sso` | ORG_OWNER | SSO settings |
| POST | `/api/organizations/[orgId]/sso/providers` | ORG_OWNER | Register provider |
| DELETE | `/api/organizations/[orgId]/sso/providers/[id]` | ORG_OWNER | Remove |
| GET | `/api/organizations/[orgId]/payouts` | ORG_MANAGER | **501 unless ENABLE_PROVIDER_ORGS** |
| GET | `/api/organizations/[orgId]/consultants` | active member | **501 unless ENABLE_PROVIDER_ORGS** |
| GET | `/api/auth/sso/domain-check?email=x` | public | SSO enforcement check |

---

## PHASE 0: DATA SEEDING

Seed all test data using Supabase MCP `execute_sql`. Run each SQL block in order.

**Recommended approach for user creation**: Use the app's signup flow via Chrome DevTools to create accounts (more reliable for BetterAuth password hashing + session creation). Then enhance profiles via SQL.

### Step 0.1: Create Test Users via Signup UI

Navigate to `http://localhost:3000/auth/signup` and create these 4 users:

| Name | Email | Password | Role after setup |
|---|---|---|---|
| Org Owner Alice | `orgowner@test.familiarise.com` | `TestPass123!` | CONSULTEE (default, we'll use her as ORG_OWNER) |
| Org Admin Bob | `orgadmin@test.familiarise.com` | `TestPass123!` | CONSULTEE |
| Learner Charlie | `learner@test.familiarise.com` | `TestPass123!` | CONSULTEE |
| Outsider Dave | `outsider@test.familiarise.com` | `TestPass123!` | CONSULTEE (never joins the org — for auth denial tests) |

After signup, verify each user exists:

```sql
SELECT id, name, email, role, "onboardingCompleted", "consulteeProfileId"
FROM users
WHERE email IN (
  'orgowner@test.familiarise.com',
  'orgadmin@test.familiarise.com',
  'learner@test.familiarise.com',
  'outsider@test.familiarise.com'
);
```

### Step 0.2: Create a Consultant + Plan (for checkout tests)

Either sign up a consultant through the UI + onboarding flow, or create one via SQL following the pattern from `e2e-booking-agent-001`. You need at minimum:
- A `ConsultantProfile` linked to a `User` with `role='CONSULTANT'`
- A `ConsultationPlan` with a known price (e.g., 50000 paise = ₹500)
- Weekly availability slots so the checkout flow can find a bookable slot

**Store all created IDs for later use:**
```
CONSULTANT_USER_ID = '...'
CONSULTANT_PROFILE_ID = '...'
CONSULTATION_PLAN_ID = '...'
OWNER_USER_ID = '...'
ADMIN_USER_ID = '...'
LEARNER_USER_ID = '...'
OUTSIDER_USER_ID = '...'
```

---

## PHASE 1: Organization CRUD

### 1.1 Create a TAG_ONLY org (as Alice)

Sign in as Alice (`orgowner@test.familiarise.com`).

**API test:**
```
POST /api/organizations
{
  "name": "Acme School of Engineering",
  "billingEmail": "billing@acme-school.test",
  "kind": "BUYER",
  "billingMode": "TAG_ONLY"
}
```
Expected: 201 with `organization.id`, `profile.kind=BUYER`, `profile.billingMode=TAG_ONLY`.

**DB verification:**
```sql
SELECT o.id, o.name, o.slug, op.kind, op.status, op."billingMode", op."billingEmail"
FROM organizations o
JOIN "OrganizationProfile" op ON op."organizationId" = o.id
WHERE o.name = 'Acme School of Engineering';
```
Expected: status = `ACTIVE`, kind = `BUYER`, billingMode = `TAG_ONLY`.

**Verify owner membership was auto-created:**
```sql
SELECT m.id, m."userId", m.role, omp.role AS typed_role, omp.status
FROM members m
JOIN "OrganizationMemberProfile" omp ON omp."memberId" = m.id
WHERE m."organizationId" = '<ORG_ID>';
```
Expected: 1 row, Alice's userId, role = `ORG_OWNER`, status = `ACTIVE`.

Store: `TAG_ONLY_ORG_ID = '<org.id>'`

### 1.2 Create a SEAT_PACK org (as Alice)

```
POST /api/organizations
{
  "name": "TechCorp Training",
  "billingEmail": "billing@techcorp.test",
  "kind": "BUYER",
  "billingMode": "SEAT_PACK"
}
```

**DB verification**: verify `OrgCreditPool` was auto-created with balance = 0.

```sql
SELECT cp.balance, cp."totalPurchased"
FROM "OrgCreditPool" cp
JOIN "OrganizationProfile" op ON op.id = cp."organizationProfileId"
JOIN organizations o ON o.id = op."organizationId"
WHERE o.name = 'TechCorp Training';
```

Store: `SEAT_PACK_ORG_ID = '<org.id>'`

### 1.3 Create an INVOICED_MONTHLY org (as Alice)

```
POST /api/organizations
{
  "name": "LearnCo University",
  "billingEmail": "finance@learnco.test",
  "kind": "BUYER",
  "billingMode": "INVOICED_MONTHLY"
}
```

Store: `INVOICED_ORG_ID = '<org.id>'`

### 1.4 Update org profile (as Alice)

```
PATCH /api/organizations/<TAG_ONLY_ORG_ID>
{
  "description": "A premier engineering school",
  "industry": "Education",
  "website": "https://acme-school.test",
  "paymentTermsDays": 15
}
```
Expected: 200. Verify fields updated in DB.

### 1.5 Error: PROVIDER org creation should return 501

```
POST /api/organizations
{
  "name": "Provider Agency Test",
  "billingEmail": "billing@agency.test",
  "kind": "PROVIDER",
  "billingMode": "TAG_ONLY"
}
```
Expected: 501 with `flag: "ENABLE_PROVIDER_ORGS"`.

### 1.6 Error: Outsider Dave cannot access org

Sign in as Dave (`outsider@test.familiarise.com`).

```
GET /api/organizations/<TAG_ONLY_ORG_ID>
```
Expected: 403 "Not a member of this organization".

### 1.7 List orgs (as Alice)

```
GET /api/organizations
```
Expected: 3 orgs (TAG_ONLY, SEAT_PACK, INVOICED_MONTHLY), all with role = ORG_OWNER.

---

## PHASE 2: Members + Invitations

### 2.1 Add Bob as ORG_ADMIN (as Alice, TAG_ONLY org)

```
POST /api/organizations/<TAG_ONLY_ORG_ID>/members
{
  "email": "orgadmin@test.familiarise.com",
  "role": "ORG_ADMIN"
}
```
Expected: 201. Verify in DB: Bob has OrganizationMemberProfile with role=ORG_ADMIN, status=ACTIVE.

### 2.2 Add Charlie as ORG_LEARNER

```
POST /api/organizations/<TAG_ONLY_ORG_ID>/members
{
  "email": "learner@test.familiarise.com",
  "role": "ORG_LEARNER"
}
```
Expected: 201. Verify:
- `OrganizationMemberProfile.consulteeProfileId` is set to Charlie's consulteeProfileId
- `OrganizationMemberProfile.seatAssignedAt` is set
- `OrganizationProfile.seatsUsed` incremented to 1

### 2.3 Error: Add duplicate member

```
POST /api/organizations/<TAG_ONLY_ORG_ID>/members
{
  "email": "learner@test.familiarise.com",
  "role": "ORG_LEARNER"
}
```
Expected: 409 "User is already a member".

### 2.4 Error: Add ORG_CONSULTANT role (feature-flagged)

```
POST /api/organizations/<TAG_ONLY_ORG_ID>/members
{
  "email": "outsider@test.familiarise.com",
  "role": "ORG_CONSULTANT"
}
```
Expected: 501 with `flag: "ENABLE_PROVIDER_ORGS"`.

### 2.5 Invite an email (as Alice)

```
POST /api/organizations/<TAG_ONLY_ORG_ID>/invitations
{
  "email": "newperson@test.familiarise.com",
  "role": "ORG_LEARNER"
}
```
Expected: 201 with invitation token.

**DB verification:**
```sql
SELECT id, email, role, status, "expiresAt"
FROM invitations
WHERE "organizationId" = '<TAG_ONLY_ORG_ID>';
```
Expected: 1 row, status = `pending`.

Store: `INVITATION_TOKEN = '<invitation.id>'`

### 2.6 Revoke invitation

```
DELETE /api/organizations/<TAG_ONLY_ORG_ID>/invitations/<INVITATION_TOKEN>
```
Expected: 200. DB: status = `revoked`.

### 2.7 Invite + accept flow

Create another invitation for Charlie (who is already a member — test idempotent accept):

Actually, create an invitation for a NEW email, sign up that user, then accept:

1. POST invite for `invitee@test.familiarise.com` (as Alice)
2. Sign up `invitee@test.familiarise.com` via the UI
3. POST `/api/organizations/invitations/accept` with `{ "token": "<invitation_id>" }` (as invitee)
4. Verify: new Member + OrganizationMemberProfile rows, invitation status = `accepted`

### 2.8 Error: Last-owner protection

```
DELETE /api/organizations/<TAG_ONLY_ORG_ID>/members/<ALICE_MEMBER_PROFILE_ID>
```
Expected: 400 "Cannot remove the last organization owner."

### 2.9 Remove learner Charlie

```
DELETE /api/organizations/<TAG_ONLY_ORG_ID>/members/<CHARLIE_MEMBER_PROFILE_ID>
```
Expected: 200. Verify:
- `OrganizationMemberProfile.status` = `REMOVED`
- `OrganizationProfile.seatsUsed` decremented

### 2.10 Bob's access (ORG_ADMIN)

Sign in as Bob. Verify:
- `GET /api/organizations/<TAG_ONLY_ORG_ID>` → 200
- `POST /api/organizations/<TAG_ONLY_ORG_ID>/members` → should work (ORG_ADMIN sufficient)
- `DELETE /api/organizations/<TAG_ONLY_ORG_ID>` → 403 (only ORG_OWNER can delete)

---

## PHASE 3: Plans CRUD

### 3.1 Create a plan (as Alice)

```
POST /api/organizations/<TAG_ONLY_ORG_ID>/plans
{
  "planType": "CONSULTATION",
  "title": "System Design 1:1",
  "description": "60-minute deep dive into system design",
  "price": 50000
}
```
Expected: 201.

### 3.2 List plans

```
GET /api/organizations/<TAG_ONLY_ORG_ID>/plans
```
Expected: 1 plan, isActive = true.

### 3.3 Archive plan (soft delete)

```
DELETE /api/organizations/<TAG_ONLY_ORG_ID>/plans/<PLAN_ID>
```
Expected: 200. DB: `isActive = false`.

---

## PHASE 4: TAG_ONLY Billing

Re-add Charlie as ORG_LEARNER to the TAG_ONLY org. Then:

### 4.1 Checkout with org context

Sign in as Charlie. Perform a standard consultation checkout (follow the existing booking flow — pick a slot, use the checkout API) but include `organizationId` in the checkout payload:

```json
{
  "appointmentType": "CONSULTATION",
  "planId": "<CONSULTATION_PLAN_ID>",
  "paymentGateway": "RAZORPAY",
  "organizationId": "<TAG_ONLY_ORG_ID>",
  "slotStartTimeInUTC": "...",
  "slotEndTimeInUTC": "...",
  "slotOfAvailabilityWeeklyId": "..."
}
```

**DB verification after checkout:**
```sql
SELECT id, amount, "paymentMethod", "paymentStatus", "organizationProfileId", "isMockPayment"
FROM "Payment"
WHERE "userId" = '<CHARLIE_USER_ID>'
ORDER BY "createdAt" DESC
LIMIT 1;
```
Expected: `organizationProfileId` is set (not null), `paymentMethod = 'CARD'` (TAG_ONLY uses normal gateway).

### 4.2 Verify billing summary includes the tagged payment

```
GET /api/organizations/<TAG_ONLY_ORG_ID>/billing
```
Expected: `monthToDate.gross > 0`, `monthToDate.paymentCount > 0`.

---

## PHASE 5: SEAT_PACK Billing

Add Alice + Charlie as members of the SEAT_PACK org. Then:

### 5.1 Seed credits into the pool (via SQL)

```sql
-- Get the org profile ID
SELECT op.id AS profile_id
FROM "OrganizationProfile" op
JOIN organizations o ON o.id = op."organizationId"
WHERE o.id = '<SEAT_PACK_ORG_ID>';

-- Grant 500 INR (50000 paise) to the credit pool
UPDATE "OrgCreditPool"
SET balance = 50000, "totalPurchased" = 50000
WHERE "organizationProfileId" = '<SEAT_PACK_ORG_PROFILE_ID>';

-- Write a ledger row for the grant
INSERT INTO "OrgCreditLedger" (
  id, "organizationProfileId", delta, reason, "balanceAfter", "createdAt"
) VALUES (
  gen_random_uuid(), '<SEAT_PACK_ORG_PROFILE_ID>', 50000, 'purchase', 50000, NOW()
);
```

### 5.2 Verify credits endpoint

```
GET /api/organizations/<SEAT_PACK_ORG_ID>/credits
```
Expected: `pool.balance = 50000`, ledger has 1 row.

### 5.3 Checkout with SEAT_PACK (as Charlie)

Checkout a consultation with `organizationId = <SEAT_PACK_ORG_ID>`.

**DB verification:**
```sql
-- Payment should use ORG_CREDIT method, SUCCEEDED immediately
SELECT id, amount, "paymentMethod", "paymentStatus", "organizationProfileId", "isMockPayment"
FROM "Payment"
WHERE "userId" = '<CHARLIE_USER_ID>'
ORDER BY "createdAt" DESC
LIMIT 1;
```
Expected: `paymentMethod = 'ORG_CREDIT'`, `paymentStatus = 'SUCCEEDED'`, `isMockPayment = true`.

**Pool should be decremented:**
```sql
SELECT balance FROM "OrgCreditPool"
WHERE "organizationProfileId" = '<SEAT_PACK_ORG_PROFILE_ID>';
```
Expected: `balance = 50000 - <plan_price>`.

**Ledger should have a deduction row:**
```sql
SELECT delta, reason, "balanceAfter"
FROM "OrgCreditLedger"
WHERE "organizationProfileId" = '<SEAT_PACK_ORG_PROFILE_ID>'
ORDER BY "createdAt" DESC
LIMIT 1;
```
Expected: `delta = -<plan_price>`, `reason = 'booking'`.

### 5.4 Error: Insufficient credits

Drain the pool to 0 via SQL, then attempt another checkout. Expected: error "Insufficient credits".

---

## PHASE 6: INVOICED_MONTHLY Billing

Add Alice + Charlie as members of the INVOICED_MONTHLY org. Then:

### 6.1 Checkout with INVOICED_MONTHLY (as Charlie)

Checkout a consultation with `organizationId = <INVOICED_ORG_ID>`.

**DB verification:**
```sql
SELECT id, amount, "paymentMethod", "paymentStatus", "organizationProfileId", "billableToOrgInvoiceId"
FROM "Payment"
WHERE "userId" = '<CHARLIE_USER_ID>'
AND "organizationProfileId" IS NOT NULL
ORDER BY "createdAt" DESC
LIMIT 1;
```
Expected: `paymentMethod = 'ORG_INVOICED'`, `paymentStatus = 'SUCCEEDED'`, `billableToOrgInvoiceId = null` (not yet invoiced).

### 6.2 Generate invoice (as Alice)

```
POST /api/organizations/<INVOICED_ORG_ID>/billing/generate-invoice
```
Expected: 201 with invoice details, `items` array containing the unbilled payment.

**DB verification:**
```sql
-- Invoice should exist
SELECT id, "invoiceNumber", amount, status, "billingCycleStart", "billingCycleEnd"
FROM "OrganizationInvoice"
WHERE "organizationProfileId" = '<INVOICED_ORG_PROFILE_ID>';

-- Payment should now be linked to the invoice
SELECT "billableToOrgInvoiceId"
FROM "Payment"
WHERE id = '<PAYMENT_ID>';
```
Expected: `billableToOrgInvoiceId` is now set to the invoice's ID.

### 6.3 Error: Generate invoice with no unbilled payments

```
POST /api/organizations/<INVOICED_ORG_ID>/billing/generate-invoice
```
Expected: 400 "No unbilled payments to invoice".

### 6.4 Error: Generate invoice on TAG_ONLY org

```
POST /api/organizations/<TAG_ONLY_ORG_ID>/billing/generate-invoice
```
Expected: 400 "only valid for INVOICED_MONTHLY orgs".

---

## PHASE 7: Refund Routing

### 7.1 TAG_ONLY refund

Refund a TAG_ONLY payment (from Phase 4). This should hit the normal gateway refund path.

```
POST /api/payments/refunds
{ "paymentId": "<TAG_ONLY_PAYMENT_ID>" }
```
Expected: gateway refund created (or mock refund if using mock payments).

### 7.2 SEAT_PACK refund (credit return)

Refund a SEAT_PACK payment (from Phase 5).

```
POST /api/payments/refunds
{ "paymentId": "<SEAT_PACK_PAYMENT_ID>" }
```

**DB verification:**
```sql
-- Credit pool should be credited back
SELECT balance FROM "OrgCreditPool"
WHERE "organizationProfileId" = '<SEAT_PACK_ORG_PROFILE_ID>';

-- Ledger should have a refund row
SELECT delta, reason FROM "OrgCreditLedger"
WHERE "organizationProfileId" = '<SEAT_PACK_ORG_PROFILE_ID>'
ORDER BY "createdAt" DESC
LIMIT 1;
```
Expected: `delta = +<refund_amount>`, `reason = 'refund'`.

### 7.3 INVOICED_MONTHLY refund (unbill)

Refund a payment from Phase 6 that was already rolled into an invoice.

```
POST /api/payments/refunds
{ "paymentId": "<INVOICED_PAYMENT_ID>" }
```

**DB verification:**
```sql
SELECT "billableToOrgInvoiceId" FROM "Payment" WHERE id = '<INVOICED_PAYMENT_ID>';
```
Expected: `billableToOrgInvoiceId = null` (unbilled).

---

## PHASE 8: SSO Configuration

### 8.1 Configure SSO settings (as Alice, TAG_ONLY org)

```
PATCH /api/organizations/<TAG_ONLY_ORG_ID>/sso
{
  "allowedEmailDomains": ["acme-school.test"],
  "enforceSSO": true,
  "defaultRoleForAutoJoin": "ORG_LEARNER"
}
```

**DB verification:**
```sql
SELECT "allowedEmailDomains", "enforceSSO", "defaultRoleForAutoJoin"
FROM "OrganizationSSOSettings"
WHERE "organizationProfileId" = '<TAG_ONLY_ORG_PROFILE_ID>';
```

### 8.2 Register an SSO provider

```
POST /api/organizations/<TAG_ONLY_ORG_ID>/sso/providers
{
  "providerId": "acme-okta",
  "domain": "acme-school.test",
  "issuer": "https://acme-school.okta.com",
  "samlConfig": "<EntityDescriptor entityID='urn:acme'>test</EntityDescriptor>"
}
```
Expected: 201.

### 8.3 Domain-check endpoint

```
GET /api/auth/sso/domain-check?email=alice@acme-school.test
```
Expected: `{ enforceSSO: true, providerId: "acme-okta", ssoSignInUrl: "/api/auth/sso/sign-in/acme-okta" }`

```
GET /api/auth/sso/domain-check?email=alice@gmail.com
```
Expected: `{ enforceSSO: false }`

### 8.4 Delete SSO provider

```
DELETE /api/organizations/<TAG_ONLY_ORG_ID>/sso/providers/<PROVIDER_ID>
```
Expected: 200. Verify domain-check now returns `enforceSSO: false` for `acme-school.test`.

---

## PHASE 9: OrganizationSwitcher UI

### 9.1 OrgSwitcher visible for org member

Sign in as Alice via Chrome DevTools. Navigate to `/dashboard`. Use `take_snapshot` / `take_screenshot`.

**Verify**: The OrganizationSwitcher dropdown is visible in the navbar (a Building2 icon + org name or "3 organizations"). Click it — should list Alice's 3 orgs with kind + role badges. Click one — should navigate to `/dashboard/organization/<orgId>/home`.

### 9.2 OrgSwitcher hidden for non-org user

Sign in as Dave (outsider). Navigate to `/dashboard`.

**Verify**: The OrganizationSwitcher dropdown is NOT rendered (Dave has no org memberships). The navbar should look exactly like the standard B2C navbar.

---

## PHASE 10: PROVIDER Feature Flag Gate

### 10.1 PROVIDER-gated routes return 501

As Alice:

```
GET /api/organizations/<TAG_ONLY_ORG_ID>/payouts
```
Expected: 501 with `flag: "ENABLE_PROVIDER_ORGS"`.

```
GET /api/organizations/<TAG_ONLY_ORG_ID>/consultants
```
Expected: 501 with `flag: "ENABLE_PROVIDER_ORGS"`.

```
GET /api/organizations/<TAG_ONLY_ORG_ID>/payout-account
```
Expected: 501 with `flag: "ENABLE_PROVIDER_ORGS"`.

### 10.2 PROVIDER-gated dashboard pages show lock UI

Navigate to `/dashboard/organization/<TAG_ONLY_ORG_ID>/consultants` via Chrome DevTools.

**Verify**: Page renders a "Provider tier required" card with a Lock icon, NOT a crash or blank page.

Same for `/dashboard/organization/<TAG_ONLY_ORG_ID>/payouts`.

---

## PHASE 11: Dashboard Pages Smoke Test

Navigate to each page as Alice and verify it renders without errors:

1. `/dashboard/organization` — landing: lists 3 orgs
2. `/dashboard/organization/<TAG_ONLY_ORG_ID>/home` — stat cards
3. `/dashboard/organization/<TAG_ONLY_ORG_ID>/members` — table with members
4. `/dashboard/organization/<TAG_ONLY_ORG_ID>/invitations` — invite list
5. `/dashboard/organization/<TAG_ONLY_ORG_ID>/learners` — learner table
6. `/dashboard/organization/<TAG_ONLY_ORG_ID>/plans` — plans table
7. `/dashboard/organization/<TAG_ONLY_ORG_ID>/billing` — billing summary + invoices
8. `/dashboard/organization/<TAG_ONLY_ORG_ID>/analytics` — 6 stat cards
9. `/dashboard/organization/<TAG_ONLY_ORG_ID>/settings` — profile form + billing mode badge
10. `/dashboard/organization/<TAG_ONLY_ORG_ID>/settings/sso` — SSO config + provider list
11. `/dashboard/organization/<SEAT_PACK_ORG_ID>/credits` — credit pool + ledger table
12. `/dashboard/organization/<TAG_ONLY_ORG_ID>/consultants` — PROVIDER-gated card
13. `/dashboard/organization/<TAG_ONLY_ORG_ID>/payouts` — PROVIDER-gated card

For each page: `take_snapshot`, verify no console errors (`list_console_messages`), verify meaningful content renders (not a blank page or error state).

---

## PHASE 12: Public Invitation Accept Page

### 12.1 Unauthenticated view

Sign out. Navigate to `/organizations/invite/<INVITATION_TOKEN>`.

**Verify**: Shows "Sign in" and "Create account" buttons. No crash.

### 12.2 Authenticated accept

Sign up or sign in as the invited email. Navigate back to `/organizations/invite/<INVITATION_TOKEN>`.

**Verify**: Shows "Accepting invitation…" → "You're in!" → auto-redirects to the org dashboard.

---

## PHASE 13: Soft Delete + Deactivation

### 13.1 Delete org (as Alice)

```
DELETE /api/organizations/<TAG_ONLY_ORG_ID>
```
Expected: 200. DB: `OrganizationProfile.status = 'DEACTIVATED'`.

### 13.2 Deactivated org blocks access

```
GET /api/organizations/<TAG_ONLY_ORG_ID>
```
Expected: 403 "Organization has been deactivated".

### 13.3 Deactivated org hidden from list

```
GET /api/organizations
```
Expected: deactivated org NOT in the list (members endpoint filters by status != DEACTIVATED).

---

## SUCCESS CRITERIA

All phases pass with:
- Zero TypeScript compilation errors
- All DB state assertions verified via `execute_sql`
- All dashboard pages render without console errors
- All error paths return the expected status code and message
- OrganizationSwitcher self-hides for B2C users
- PROVIDER feature flag consistently returns 501
- All three billing modes work end-to-end (checkout → billing summary → refund routing)

**If you find ANY bug, fix it immediately, verify the fix, and retest.**
