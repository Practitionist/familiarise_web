# E2E Enterprise Test — Billing Modes, PROVIDER/HYBRID Orgs, Earnings Split, Payouts

## Role & Mission

You are a **senior QA engineer** performing exhaustive end-to-end testing of the enterprise billing and organization tier system. This test covers the **complete permutation matrix** of org kinds (BUYER, PROVIDER, HYBRID), billing modes (TAG_ONLY, SEAT_PACK, INVOICED_MONTHLY, PREPAID_UNLIMITED), earnings modes (Marketplace, Agency Split, Platform-only), and their interactions with checkout, refunds, and payouts.

You have access to two critical MCP tools:

1. **Supabase MCP** — for seeding mock data directly into PostgreSQL via `execute_sql`
2. **Chrome DevTools MCP** — for interacting with the app UI at `http://localhost:3000`

**Supabase Project ID: `pzmbxqdgibfkhjwzeprf`**

---

## CRITICAL RULES

1. **FIX BUGS IMMEDIATELY.** If you discover ANY bug during testing — broken UI, wrong API response, incorrect DB state, missing auth, wrong earnings split, missing refund path — **STOP testing, fix the bug in the source code, verify the fix, and retest the entire flow from the beginning of that phase.** Do NOT accumulate a bug list.

2. **Verify DB state after every operation.** After each significant action (create org, checkout, refund, credit purchase, payout batch), use `execute_sql` to query the database and verify expected state. Do not trust the UI alone.

3. **Test both happy path AND error paths.** For every flow, test what happens when things go RIGHT and when things go WRONG.

4. **Take snapshots liberally.** Use `take_snapshot` after every page navigation and before every interaction to understand the current UI state.

5. **Use the correct Supabase project ID** for all MCP calls: `pzmbxqdgibfkhjwzeprf`

6. **The app runs at** `http://localhost:3000`. Assume the dev server is already running.

7. **All amounts in the DB are in paise** (1 INR = 100 paise).

8. **Set `ENABLE_PROVIDER_ORGS=true`** in the `.env` file before starting. This test requires PROVIDER/HYBRID orgs to be active.

---

## SCHEMA REFERENCE — Tables Added/Modified in This PR

| Prisma Model | PostgreSQL Table | Notes |
|---|---|---|
| `OrganizationProfile` | `"OrganizationProfile"` | Added: `payoutFrequency`, `enforceOrganizationPlans`, `contractStartDate`, `contractEndDate` |
| `OrganizationMemberProfile` | `"OrganizationMemberProfile"` | Added: `earningsRecipient`, `applicationNote`, `appliedAt`, `approvedAt`, `approvedBy` |
| `OrganizationEarnings` | `"OrganizationEarnings"` | Added: `orgPayoutId`. Changed: `paymentId` from `@unique` to `@@unique([paymentId, organizationProfileId])` |
| `OrganizationPayout` | `"OrganizationPayout"` | Added: `earnings` relation |
| `OrganizationPayoutAccount` | `"OrganizationPayoutAccount"` | Encryption changed from base64 to AES-256-GCM |
| `OrgAuditLog` | `"OrgAuditLog"` | New actions: `CONSULTANT_APPLIED`, `CONSULTANT_APPROVED`, `CONSULTANT_REJECTED`, `PAYOUT_INITIATED`, `PAYOUT_PROCESSED`, `SETTINGS_CHANGED` |

## KEY ENUMS

```sql
-- OrganizationKind: 'BUYER', 'PROVIDER', 'HYBRID'
-- OrganizationBillingMode: 'TAG_ONLY', 'SEAT_PACK', 'INVOICED_MONTHLY', 'PREPAID_UNLIMITED'
-- OrgMemberRole: 'ORG_OWNER', 'ORG_ADMIN', 'ORG_MANAGER', 'ORG_CONSULTANT', 'ORG_LEARNER', 'ORG_SUPPORT'
-- EarningsRecipient: 'CONSULTANT', 'ORGANIZATION'
-- PayoutFrequency: 'WEEKLY', 'BI_WEEKLY', 'MONTHLY'
-- EarningStatus: 'PENDING', 'READY', 'PAID', 'HELD', 'REFUNDED'
-- PayoutStatus: 'PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'ON_HOLD'
```

## NEW API ROUTES

| Method | Path | Min Role | Notes |
|---|---|---|---|
| POST | `/api/organizations/[orgId]/consultants/apply` | Authenticated consultant | Self-application to PROVIDER/HYBRID org |
| POST | `/api/organizations/[orgId]/consultants` | ORG_ADMIN | Approve/reject: `{ memberId, action: "APPROVE"/"REJECT" }` |
| GET | `/api/organizations/[orgId]/consultants?status=PENDING` | Active member | Filter by status |
| POST | `/api/organizations/[orgId]/payouts` | ORG_OWNER | Create payout batch from READY earnings |
| POST | `/api/admin/org-payouts/process` | ADMIN | Process all PENDING org payouts |
| POST | `/api/admin/organizations/[orgId]/verify` | ADMIN | Approve/reject PENDING_VERIFICATION org |
| GET | `/api/organizations/public/[slug]` | Public | Public org profile + consultant roster |

---

## PHASE 0: DATA SEEDING

### Step 0.1: Create Test Users via Signup UI

Navigate to `http://localhost:3000/auth/signup` and create these users:

| Name | Email | Password | Purpose |
|---|---|---|---|
| Owner Alice | `owner-alice@test.familiarise.com` | `TestPass123!` | ORG_OWNER for all test orgs |
| Admin Bob | `admin-bob@test.familiarise.com` | `TestPass123!` | ORG_ADMIN |
| Learner Charlie | `learner-charlie@test.familiarise.com` | `TestPass123!` | ORG_LEARNER (student) |
| Learner Diana | `learner-diana@test.familiarise.com` | `TestPass123!` | ORG_LEARNER (student #2) |
| Consultant Eve | `consultant-eve@test.familiarise.com` | `TestPass123!` | Independent consultant + ORG_CONSULTANT |
| Consultant Frank | `consultant-frank@test.familiarise.com` | `TestPass123!` | ORG_CONSULTANT (internal/salaried) |
| Outsider Grace | `outsider-grace@test.familiarise.com` | `TestPass123!` | Never joins any org (auth denial tests) |
| Platform Admin | `admin@test.familiarise.com` | `TestPass123!` | Platform ADMIN role |

After signup, set the Platform Admin's role:
```sql
UPDATE users SET role = 'ADMIN' WHERE email = 'admin@test.familiarise.com';
```

### Step 0.2: Create Consultant Profiles

Create consultant profiles for Eve and Frank via the onboarding UI or SQL. Each needs:
- A `ConsultantProfile` with `isVerified = true`, `verificationStatus = 'VERIFIED'`
- A `ConsultationPlan` with a known price (e.g., ₹5,000 = 500000 paise)
- Weekly availability slots (at least 5 slots in the next 7 days)

```
OWNER_USER_ID = '...'
ADMIN_USER_ID = '...'
LEARNER_CHARLIE_ID = '...'
LEARNER_DIANA_ID = '...'
CONSULTANT_EVE_ID = '...'
CONSULTANT_FRANK_ID = '...'
CONSULTANT_EVE_PROFILE_ID = '...'
CONSULTANT_FRANK_PROFILE_ID = '...'
CONSULTATION_PLAN_EVE_ID = '...'
CONSULTATION_PLAN_FRANK_ID = '...'
```

---

## PHASE 1: BUYER ORG — ALL 4 BILLING MODES

### Test 1.1: Create BUYER org with TAG_ONLY

1. Log in as Owner Alice
2. Navigate to `/dashboard/organization/create`
3. **Verify**: org kind selector shows BUYER, PROVIDER, HYBRID
4. Select BUYER, fill org info, proceed to billing step
5. **Verify**: billing step shows all 4 modes (TAG_ONLY, SEAT_PACK, INVOICED_MONTHLY, PREPAID_UNLIMITED)
6. Select TAG_ONLY, complete wizard
7. **DB verify**: `SELECT kind, status, "billingMode" FROM "OrganizationProfile" WHERE "organizationId" = '<orgId>'`
   - Expected: `kind = 'BUYER', status = 'ACTIVE', billingMode = 'TAG_ONLY'`

Store: `BUYER_TAGONLY_ORG_ID`, `BUYER_TAGONLY_PROFILE_ID`

### Test 1.2: Create BUYER org with SEAT_PACK

Repeat wizard, select SEAT_PACK. Set seatsTotal = 10.
- **DB verify**: `seatsTotal = 10, seatsUsed = 0, billingMode = 'SEAT_PACK'`

Store: `BUYER_SEATPACK_ORG_ID`, `BUYER_SEATPACK_PROFILE_ID`

### Test 1.3: Create BUYER org with INVOICED_MONTHLY

Repeat wizard, select INVOICED_MONTHLY. Set paymentTermsDays = 30.
- **DB verify**: `billingMode = 'INVOICED_MONTHLY', paymentTermsDays = 30`

Store: `BUYER_INVOICED_ORG_ID`, `BUYER_INVOICED_PROFILE_ID`

### Test 1.4: Create BUYER org with PREPAID_UNLIMITED

Repeat wizard, select PREPAID_UNLIMITED.
- **DB verify**: `billingMode = 'PREPAID_UNLIMITED', contractStartDate IS NULL, contractEndDate IS NULL`
- Set contract dates via API:
  ```
  PATCH /api/organizations/<orgId>
  { "contractStartDate": "2026-04-01", "contractEndDate": "2027-03-31" }
  ```
  Wait — `contractStartDate` and `contractEndDate` might not be in the PATCH schema. Check if PATCH accepts them. If not, set via SQL:
  ```sql
  UPDATE "OrganizationProfile"
  SET "contractStartDate" = '2026-04-01', "contractEndDate" = '2027-03-31'
  WHERE "organizationId" = '<orgId>';
  ```

Store: `BUYER_PREPAID_ORG_ID`, `BUYER_PREPAID_PROFILE_ID`

### Test 1.5: Add members to each org

For each of the 4 BUYER orgs, add Learner Charlie as ORG_LEARNER:
```
POST /api/organizations/<orgId>/members
{ "userId": "<LEARNER_CHARLIE_ID>", "role": "ORG_LEARNER" }
```
- **DB verify**: `OrganizationMemberProfile` created with `role = 'ORG_LEARNER', status = 'ACTIVE'`

---

## PHASE 2: CHECKOUT FLOW — EVERY BILLING MODE

For each BUYER org, book a session with Consultant Eve as Learner Charlie.

### Test 2.1: TAG_ONLY checkout

1. Log in as Learner Charlie
2. Navigate to Consultant Eve's profile → Book consultation
3. **Verify**: OrgPayerSelector shows the TAG_ONLY org
4. Select "Bill to [Org Name]" (TAG_ONLY tags the payment)
5. Complete checkout with card payment
6. **DB verify**:
   ```sql
   SELECT "paymentMethod", "organizationProfileId", amount, "paymentStatus"
   FROM "Payment" WHERE id = '<paymentId>';
   ```
   - Expected: `paymentMethod = 'CARD'` (learner pays), `organizationProfileId` set, `paymentStatus = 'SUCCEEDED'`
7. **DB verify**: `ConsultantEarnings` created with standard 80/20 split
   - `consultantShare = amount * 0.8, platformFee = amount * 0.2`
8. **DB verify**: NO `OrganizationEarnings` row (BUYER orgs don't get earnings)

### Test 2.2: SEAT_PACK checkout

1. First, purchase credits for the SEAT_PACK org:
   ```sql
   INSERT INTO "OrgCreditPool" ("organizationProfileId", balance, "totalPurchased")
   VALUES ('<BUYER_SEATPACK_PROFILE_ID>', 1000000, 1000000);
   ```
2. Log in as Learner Charlie, book with Eve
3. Select "Bill to [SEAT_PACK Org]"
4. **Verify**: checkout skips payment gateway (no card form)
5. **DB verify**:
   ```sql
   SELECT "paymentMethod", amount, "paymentStatus", "isMockPayment"
   FROM "Payment" WHERE "organizationProfileId" = '<BUYER_SEATPACK_PROFILE_ID>'
   ORDER BY "createdAt" DESC LIMIT 1;
   ```
   - Expected: `paymentMethod = 'ORG_CREDIT', paymentStatus = 'SUCCEEDED', isMockPayment = true`
6. **DB verify**: credit pool balance decreased
7. **DB verify**: `OrgCreditLedger` row with negative delta
8. **DB verify**: `ConsultantEarnings` created with standard 80/20 split

### Test 2.3: INVOICED_MONTHLY checkout

1. Log in as Learner Charlie, book with Eve
2. Select "Bill to [INVOICED Org]"
3. **Verify**: checkout skips payment gateway
4. **DB verify**: `paymentMethod = 'ORG_INVOICED', paymentStatus = 'SUCCEEDED', isMockPayment = true`
5. **DB verify**: NO invoice generated yet (month-end rollup)
6. Trigger manual invoice generation:
   ```
   POST /api/organizations/<BUYER_INVOICED_ORG_ID>/billing/generate-invoice
   ```
7. **DB verify**: `OrganizationInvoice` created with correct amount

### Test 2.4: PREPAID_UNLIMITED checkout

1. Log in as Learner Charlie, book with Eve
2. Select "Bill to [PREPAID Org]"
3. **Verify**: checkout skips payment gateway entirely
4. **DB verify**:
   ```sql
   SELECT "paymentMethod", amount, "paymentStatus", "isMockPayment"
   FROM "Payment" WHERE "organizationProfileId" = '<BUYER_PREPAID_PROFILE_ID>'
   ORDER BY "createdAt" DESC LIMIT 1;
   ```
   - Expected: `paymentMethod = 'ORG_PREPAID', paymentStatus = 'SUCCEEDED', isMockPayment = true`
5. **DB verify**: NO credit deduction, NO invoice tagging
6. **DB verify**: `ConsultantEarnings` created with standard 80/20 split (marketplace mode)

### Test 2.5: PREPAID_UNLIMITED — expired contract

1. Set contract end date to yesterday via SQL:
   ```sql
   UPDATE "OrganizationProfile"
   SET "contractEndDate" = NOW() - INTERVAL '1 day'
   WHERE id = '<BUYER_PREPAID_PROFILE_ID>';
   ```
2. Attempt to book as Learner Charlie → should fail with "license expired" error
3. **Verify**: error message mentions expired license
4. Reset contract date for remaining tests:
   ```sql
   UPDATE "OrganizationProfile"
   SET "contractEndDate" = NOW() + INTERVAL '1 year'
   WHERE id = '<BUYER_PREPAID_PROFILE_ID>';
   ```

---

## PHASE 3: PROVIDER ORG — CREATION + VERIFICATION

### Test 3.1: Create PROVIDER org

1. Log in as Owner Alice
2. Navigate to `/dashboard/organization/create`
3. Select PROVIDER org kind
4. **Verify**: billing step adapts for PROVIDER (no billing mode needed for PROVIDER — or shows billing mode for HYBRID)
5. Complete wizard
6. **DB verify**:
   ```sql
   SELECT kind, status, "platformCommissionRate", "orgRetainRate", "consultantPayoutRate"
   FROM "OrganizationProfile" WHERE "organizationId" = '<orgId>';
   ```
   - Expected: `kind = 'PROVIDER', status = 'PENDING_VERIFICATION'` (NOT ACTIVE!)
   - Rates: `0.10, 0.05, 0.85` (defaults)

Store: `PROVIDER_ORG_ID`, `PROVIDER_PROFILE_ID`

### Test 3.2: Verify PENDING_VERIFICATION blocks operations

1. Try to access `/dashboard/organization/<PROVIDER_ORG_ID>/home` as Owner Alice
2. **Verify**: should show pending verification message or be accessible but limited
3. Try PATCH to update settings → should work (owner can configure while pending)
4. Try POST to add member → should work (can build team while pending)

### Test 3.3: Admin approves PROVIDER org

1. Log in as Platform Admin
2. Call API:
   ```
   POST /api/admin/organizations/<PROVIDER_ORG_ID>/verify
   { "action": "APPROVE" }
   ```
3. **DB verify**: `status = 'ACTIVE'`

### Test 3.4: Admin rejects a PROVIDER org (separate test org)

1. Create another PROVIDER org via API
2. Reject it:
   ```
   POST /api/admin/organizations/<testOrgId>/verify
   { "action": "REJECT", "reason": "Insufficient documentation" }
   ```
3. **DB verify**: `status = 'DEACTIVATED'`

---

## PHASE 4: CONSULTANT APPLICATION + APPROVAL

### Test 4.1: Consultant applies to PROVIDER org

1. Log in as Consultant Eve
2. Navigate to `/org/<provider-slug>` (public org page)
3. **Verify**: page shows org name, description, consultant roster (empty)
4. Call apply API:
   ```
   POST /api/organizations/<PROVIDER_ORG_ID>/consultants/apply
   { "note": "I specialize in ML consulting" }
   ```
5. **DB verify**:
   ```sql
   SELECT role, status, "applicationNote", "appliedAt", "earningsRecipient"
   FROM "OrganizationMemberProfile"
   WHERE "organizationProfileId" = '<PROVIDER_PROFILE_ID>'
     AND "consultantProfileId" = '<CONSULTANT_EVE_PROFILE_ID>';
   ```
   - Expected: `role = 'ORG_CONSULTANT', status = 'PENDING', applicationNote = 'I specialize in ML consulting'`
6. **DB verify**: `OrgAuditLog` with action `CONSULTANT_APPLIED`

### Test 4.2: Admin approves consultant

1. Log in as Owner Alice
2. Navigate to `/dashboard/organization/<PROVIDER_ORG_ID>/consultants`
3. **Verify**: pending applications section shows Eve
4. Call approve API:
   ```
   POST /api/organizations/<PROVIDER_ORG_ID>/consultants
   { "memberId": "<eveMemberProfileId>", "action": "APPROVE" }
   ```
5. **DB verify**: `status = 'ACTIVE', approvedAt IS NOT NULL`
6. **DB verify**: `OrgAuditLog` with action `CONSULTANT_APPROVED`

### Test 4.3: Add internal consultant (earningsRecipient = ORGANIZATION)

1. Add Consultant Frank as ORG_CONSULTANT via invite/API
2. Set `earningsRecipient = 'ORGANIZATION'` via API:
   ```
   PATCH /api/organizations/<PROVIDER_ORG_ID>/members/<frankMemberProfileId>
   ```
   Or via SQL:
   ```sql
   UPDATE "OrganizationMemberProfile"
   SET "earningsRecipient" = 'ORGANIZATION'
   WHERE "consultantProfileId" = '<CONSULTANT_FRANK_PROFILE_ID>'
     AND "organizationProfileId" = '<PROVIDER_PROFILE_ID>';
   ```
3. **DB verify**: `earningsRecipient = 'ORGANIZATION'`

### Test 4.4: Auto-approve (set autoApproveConsultants = true)

1. Create another PROVIDER org with `autoApproveConsultants = true`
2. Have a consultant apply
3. **DB verify**: `status = 'ACTIVE'` immediately (no PENDING step)
4. **DB verify**: `OrgAuditLog` with action `CONSULTANT_APPROVED` (auto)

### Test 4.5: Duplicate application → 409

1. Have Eve apply again to the same org
2. **Verify**: 409 Conflict response

---

## PHASE 5: 3-WAY EARNINGS SPLIT

This is the most critical financial test. External clients book sessions with PROVIDER org consultants.

### Test 5.1: Standard 3-way split (10/5/85)

1. Log in as Outsider Grace (external client, NOT an org member)
2. Book a consultation with Consultant Eve (who is ORG_CONSULTANT in the PROVIDER org)
3. Pay with card normally
4. **DB verify** — ConsultantEarnings:
   ```sql
   SELECT "consultantShare", "platformFee", "grossAmount"
   FROM "ConsultantEarnings"
   WHERE "paymentId" = '<paymentId>';
   ```
   - Expected: `platformFee = grossAmount * 0.10, consultantShare = grossAmount * 0.85`
5. **DB verify** — OrganizationEarnings:
   ```sql
   SELECT "orgShare", "platformFee", "grossAmount", status
   FROM "OrganizationEarnings"
   WHERE "paymentId" = '<paymentId>';
   ```
   - Expected: `platformFee = grossAmount * 0.10, orgShare = grossAmount * 0.05, status = 'PENDING'`
6. **Verify math**: `platformFee + orgShare + consultantShare = grossAmount`

### Test 5.2: Internal consultant split (earningsRecipient = ORGANIZATION)

1. Book a consultation with Consultant Frank (internal, earningsRecipient = ORGANIZATION)
2. **DB verify** — ConsultantEarnings:
   - Expected: `consultantShare = 0, platformFee = grossAmount * 0.10`
3. **DB verify** — OrganizationEarnings:
   - Expected: `orgShare = grossAmount * 0.90` (org captures consultant's share)
4. **Verify**: `platformFee + orgShare = grossAmount` (consultant gets nothing)

### Test 5.3: Custom per-consultant rate

1. Set a custom rate on Eve's membership:
   ```sql
   UPDATE "OrganizationMemberProfile"
   SET "customConsultantPayoutRate" = 0.90
   WHERE "consultantProfileId" = '<CONSULTANT_EVE_PROFILE_ID>'
     AND "organizationProfileId" = '<PROVIDER_PROFILE_ID>';
   ```
2. Book with Eve again
3. **DB verify**: `consultantShare = grossAmount * 0.90` (custom rate)
4. **Verify**: orgShare adjusts: `grossAmount - platformFee - consultantShare`
5. Reset custom rate:
   ```sql
   UPDATE "OrganizationMemberProfile"
   SET "customConsultantPayoutRate" = NULL
   WHERE "consultantProfileId" = '<CONSULTANT_EVE_PROFILE_ID>'
     AND "organizationProfileId" = '<PROVIDER_PROFILE_ID>';
   ```

### Test 5.4: Platform-only mode (100% platform rate)

1. Set rates to 100% platform:
   ```sql
   UPDATE "OrganizationProfile"
   SET "platformCommissionRate" = 1.0, "orgRetainRate" = 0.0, "consultantPayoutRate" = 0.0
   WHERE id = '<PROVIDER_PROFILE_ID>';
   ```
2. Book with Eve
3. **DB verify**: `ConsultantEarnings.consultantShare = 0`
4. **DB verify**: NO `OrganizationEarnings` row created (zero guard: orgShare = 0 → skipped)
5. Reset rates:
   ```sql
   UPDATE "OrganizationProfile"
   SET "platformCommissionRate" = 0.10, "orgRetainRate" = 0.05, "consultantPayoutRate" = 0.85
   WHERE id = '<PROVIDER_PROFILE_ID>';
   ```

---

## PHASE 6: REFUND ROUTING — ALL PAYMENT METHODS

### Test 6.1: Refund TAG_ONLY payment → gateway refund

1. Use a TAG_ONLY booking from Phase 2.1
2. Initiate refund via refund API
3. **DB verify**: gateway refund created, `ConsultantEarnings.status = 'REFUNDED'`

### Test 6.2: Refund SEAT_PACK payment → credit pool restored

1. Use a SEAT_PACK booking from Phase 2.2
2. Initiate refund
3. **DB verify**: `OrgCreditPool.balance` increased by refund amount
4. **DB verify**: `OrgCreditLedger` row with positive delta (refund)

### Test 6.3: Refund INVOICED_MONTHLY payment → unbilled

1. Use an INVOICED_MONTHLY booking from Phase 2.3
2. Initiate refund
3. **DB verify**: `Payment.billableToOrgInvoiceId = NULL` (unbilled)

### Test 6.4: Refund PREPAID_UNLIMITED payment → no financial action

1. Use a PREPAID_UNLIMITED booking from Phase 2.4
2. Initiate refund
3. **DB verify**: refund status = `SUCCEEDED`
4. **DB verify**: NO gateway call (synthetic payment)
5. **DB verify**: `ConsultantEarnings` reversed
6. **Verify**: no crash, no gateway error

### Test 6.5: Refund 3-way split payment → both earnings reversed

1. Use a PROVIDER org booking from Phase 5.1
2. Initiate refund
3. **DB verify**: `ConsultantEarnings.refundedShareAmount` incremented
4. **DB verify**: `OrganizationEarnings.refundedAmount` incremented
5. **Verify math**: both reversals proportional to the refund ratio

---

## PHASE 7: PAYOUT PIPELINE

### Test 7.1: Release earnings from hold

1. After Phase 5 bookings, earnings are in PENDING status
2. Fast-forward hold period via SQL:
   ```sql
   UPDATE "OrganizationEarnings"
   SET "holdUntil" = NOW() - INTERVAL '1 hour'
   WHERE "organizationProfileId" = '<PROVIDER_PROFILE_ID>'
     AND status = 'PENDING';
   ```
3. Call the earnings release function (or wait for cron)
4. **DB verify**: `status = 'READY'`

### Test 7.2: Create payout batch

1. Log in as Owner Alice
2. Navigate to `/dashboard/organization/<PROVIDER_ORG_ID>/payouts`
3. **Verify**: payouts page shows earnings summary (not a lock card)
4. Click "Create Payout Batch"
5. **DB verify**:
   ```sql
   SELECT amount, "netPayout", "grossRevenue", "platformFee", status
   FROM "OrganizationPayout"
   WHERE "organizationProfileId" = '<PROVIDER_PROFILE_ID>';
   ```
   - Expected: `status = 'PENDING'`
6. **DB verify**: linked earnings have `orgPayoutId` set
7. **DB verify**: `OrgAuditLog` with action `PAYOUT_INITIATED`

### Test 7.3: Payout eligibility guard (minimum amount)

1. Create a very small earning (below ₹500 threshold)
2. Try to create payout batch → should fail with minimum amount error

### Test 7.4: Concurrent payout lock

1. Trigger two simultaneous POST /payouts requests
2. **Verify**: one succeeds, one returns 409 (lock contention)

---

## PHASE 8: HYBRID ORG

### Test 8.1: Create HYBRID org

1. Create a HYBRID org via wizard
2. **DB verify**: `kind = 'HYBRID', status = 'PENDING_VERIFICATION'`
3. Admin-approve it
4. **DB verify**: `status = 'ACTIVE'`

Store: `HYBRID_ORG_ID`, `HYBRID_PROFILE_ID`

### Test 8.2: HYBRID dashboard shows both BUYER + PROVIDER sections

1. Navigate to `/dashboard/organization/<HYBRID_ORG_ID>/home`
2. **Verify sidebar**: shows Learners, Consultants, Billing, Payouts, Credits (if SEAT_PACK)
3. **Verify overview**: shows both BUYER cards and PROVIDER cards

### Test 8.3: HYBRID — learner booking uses BUYER billing

1. Add Learner Charlie as ORG_LEARNER
2. Set billing mode to SEAT_PACK, seed credits
3. Charlie books with an external consultant
4. **DB verify**: `paymentMethod = 'ORG_CREDIT'`, credit pool deducted
5. **DB verify**: `ConsultantEarnings` with standard 80/20 split (marketplace)
6. **DB verify**: NO `OrganizationEarnings` (BUYER billing, not PROVIDER)

### Test 8.4: HYBRID — external client booking uses PROVIDER earnings

1. Add Eve as ORG_CONSULTANT in the HYBRID org
2. Outsider Grace books with Eve
3. **DB verify**: `OrganizationEarnings` created with 3-way split
4. **DB verify**: `ConsultantEarnings` with PROVIDER rates (not 80/20)

### Test 8.5: HYBRID — same-org learner books with same-org consultant

1. Charlie (ORG_LEARNER) books with Eve (ORG_CONSULTANT), both in same HYBRID org
2. **DB verify**: BUYER billing applies (credit deducted from pool)
3. **DB verify**: PROVIDER earnings ALSO created (Eve is in a PROVIDER/HYBRID org)
4. **Verify**: both financial streams are independent

---

## PHASE 9: PUBLIC ORG PAGE + EXPLORE

### Test 9.1: Public org page renders for PROVIDER/HYBRID

1. Navigate to `/org/<provider-slug>` (no auth)
2. **Verify**: page shows org name, description, consultant roster
3. **Verify**: Eve appears in the consultant list

### Test 9.2: Public org page 404s for BUYER

1. Navigate to `/org/<buyer-slug>`
2. **Verify**: 404 page

### Test 9.3: Explore companies page

1. Navigate to `/explore/companies`
2. **Verify**: PROVIDER and HYBRID orgs appear, BUYER orgs do not

### Test 9.4: Org badge on consultant cards

1. Navigate to `/explore/experts`
2. **Verify**: Eve's card shows an org badge linking to `/org/<slug>`
3. **Verify**: Frank's card also shows the badge (if Frank is in a PROVIDER org)

---

## PHASE 10: EDGE CASES + ERROR PATHS

### Test 10.1: PROVIDER org creation when ENABLE_PROVIDER_ORGS = false

1. Temporarily set `ENABLE_PROVIDER_ORGS=false` in `.env` and restart
2. Try to create PROVIDER org → 501
3. Try to apply as consultant → 501
4. Try GET /payouts → 501
5. Restore `ENABLE_PROVIDER_ORGS=true`

### Test 10.2: Rate validation — sum must equal 1.0

```
PATCH /api/organizations/<PROVIDER_ORG_ID>
{ "platformCommissionRate": 0.5, "orgRetainRate": 0.3, "consultantPayoutRate": 0.3 }
```
Expected: 400 error (sum = 1.1)

### Test 10.3: Outsider cannot access org APIs

1. Log in as Outsider Grace
2. Try GET `/api/organizations/<any-org-id>/billing` → 403
3. Try POST `/api/organizations/<any-org-id>/payouts` → 403

### Test 10.4: ORG_LEARNER cannot create payouts

1. Log in as Learner Charlie (ORG_LEARNER)
2. Try POST `/api/organizations/<org-id>/payouts` → 403

### Test 10.5: Multi-org consultant

1. Eve is in multiple PROVIDER orgs
2. Book a session with Eve
3. **Verify**: earnings go to the FIRST active PROVIDER org membership
4. **Note**: this is a known limitation — future improvement will allow per-booking org selection

---

## PHASE 11: DASHBOARD VERIFICATION

### Test 11.1: Payouts dashboard (PROVIDER org)

1. Navigate to `/dashboard/organization/<PROVIDER_ORG_ID>/payouts`
2. **Verify**: stat cards show total paid, pending amounts
3. **Verify**: payout history table with period, gross, net, status columns
4. **Verify**: "Create Payout Batch" button visible for ORG_OWNER

### Test 11.2: Consultants dashboard (PROVIDER org)

1. Navigate to `/dashboard/organization/<PROVIDER_ORG_ID>/consultants`
2. **Verify**: active consultants table shows Eve and Frank
3. **Verify**: pending applications section (if any)
4. **Verify**: can filter by `?status=ACTIVE` and `?status=PENDING`

### Test 11.3: Overview hub — PROVIDER cards

1. Navigate to `/dashboard/organization/<PROVIDER_ORG_ID>/home`
2. **Verify**: "Active consultants" stat card
3. **Verify**: "Total payouts" stat card

### Test 11.4: Billing dashboard — PREPAID_UNLIMITED

1. Navigate to `/dashboard/organization/<BUYER_PREPAID_ORG_ID>/billing`
2. **Verify**: shows "Prepaid Unlimited" billing mode
3. **Verify**: no outstanding invoices, no credit pool
4. **Verify**: no "Generate Invoice" button

---

## SUCCESS CRITERIA

All phases pass when:
- [ ] 4 BUYER orgs created (one per billing mode), all ACTIVE
- [ ] Checkout works for all 4 billing modes with correct payment methods
- [ ] PREPAID_UNLIMITED expired contract blocks checkout
- [ ] PROVIDER org requires admin verification (PENDING_VERIFICATION → ACTIVE)
- [ ] Consultant application/approval workflow works (PENDING → ACTIVE)
- [ ] 3-way earnings split creates correct ConsultantEarnings + OrganizationEarnings
- [ ] Internal consultant (earningsRecipient=ORGANIZATION) gets 0 consultant share
- [ ] Platform-only mode (100% platform rate) skips OrganizationEarnings creation
- [ ] Refund routing correct for all 4 payment methods + 3-way split
- [ ] Payout batch aggregates READY earnings correctly
- [ ] HYBRID org shows dual dashboard + independent financial streams
- [ ] Public org page renders for PROVIDER/HYBRID, 404s for BUYER
- [ ] Org badge visible on consultant cards in /explore
- [ ] All auth denial tests pass (outsider, wrong role)
