# Enterprise subsystem — manual + scripted test recipes

Everything you need to validate the enterprise/B2B surface end-to-end after this session's changes (#674 hybrid scope split, A1 live RazorpayX payouts, A2 India compliance, A3 collaborator earnings, A4 isIndependent flip, A5 contract expiry, A7 EXPERT removal cascade, B2 Stream.io org tagging, C1 refund operation, C2 overage charging, C4 reimbursement UI, plus D1/D4/D7/C9 cleanup).

Schema migration `20260501120000_org_scope_split_and_payout_clawback` is live in Supabase.

---

## 0. Prereqs

**Reading list before running smoke tests:**
- `docs/enterprise/00-overview.md` — architecture + capability model
- `docs/enterprise/reference/money-glossary.md` — plain-English definitions of Refund / Reimbursement / Payout / Referral / Credits and all ~45 money-adjacent models/enums. Read this if any money term in the smoke output looks unfamiliar.
- `docs/enterprise/18-three-ledger-discipline.md` — invariants the ledger smoke probes verify

```bash
# Make sure you're on the feature/enterprise branch
git status

# Regenerate Prisma client + verify schema sync
npx prisma generate
npx prisma migrate status   # should say "Database schema is up to date!"

# Type-check + tests
npx tsc --noEmit -p .       # 0 errors
npx jest __tests__/enterprise __tests__/payments   # 164/164 pass
```

If migrate status reports drift, re-apply the SQL:

```bash
npx prisma db execute --file prisma/migrations/20260501120000_org_scope_split_and_payout_clawback/migration.sql
npx prisma migrate resolve --applied 20260501120000_org_scope_split_and_payout_clawback
```

---

## 1. Seed cohort (mock data)

The seed (`npm run db:seed`) provisions 5 representative orgs:

| Slug | Capability shape | Funding | OWNER login |
|------|-----------------|---------|-------------|
| `wipro` | SPONSOR (canSponsor=true, canHost=false) | INVOICE | `samantha.anderson@yahoo.com` / `SeedPass123!` |
| `learnpro-academy` | HOST (canSponsor=false, canHost=true) | — | `daniel.anderson@outlook.com` / `SeedPass123!` |
| `iit-madras` | HYBRID (both true) | WALLET | (look up via `npx prisma studio`) |
| `arjun-anderson-coaching-...` | HOST | — | `arjun.anderson@yahoo.com` / `SeedPass123!` |
| `wipro-test` | SPONSOR | — | `owner-test@example.com` / `SeedPass123!` |

Tour-owner alias: `tour-owner@familiarise.dev` (if `npm run db:seed` recently ran). Password from `SEED_PASSWORD` env var (default `SeedPass123!`).

Pull the org IDs you need:

```bash
npx tsx -r dotenv/config -e '
  import("@/lib/prisma").then(async ({default: p}) => {
    const orgs = await p.organization.findMany({select: {id:true, slug:true, name:true, canSponsor:true, canHost:true, billingAccount:{select:{fundingSource:true}}}});
    console.log(JSON.stringify(orgs, null, 2));
    await p.$disconnect();
  });
' dotenv_config_path=.env
```

---

## 2. Run backfills (one-shot, idempotent)

Required after the schema migration so existing seed appointments / waitlist / recordings get their `organizationId` populated and consultants with active EXPERT memberships at HOST orgs flip to `isIndependent=false`.

```bash
# Stamp Appointment.organizationId, Waitlist.organizationId, Recording.organizationId
# from each row's acting user's single active org membership.
npx tsx -r dotenv/config prisma/scripts/backfill-appointment-org-id.ts dotenv_config_path=.env

# Recompute ConsultantProfile.isIndependent against current Membership state.
npx tsx -r dotenv/config prisma/scripts/backfill-isindependent.ts dotenv_config_path=.env
```

Both accept `--dry-run` for a no-mutation preview. Expected output (your numbers may vary):

```
[backfill][Appointment] scanned=375 updated=49 skipped=326
[backfill][Waitlist]    scanned=215 updated=47 skipped=168
[backfill][Recording]   scanned=64  updated=5  skipped=59
[backfill-isindependent] scanned=31 flipped=10 unchanged=21
```

---

## 3. Live API smoke (authenticated as Wipro OWNER)

```bash
# Start dev
PORT=3001 npm run dev   # in one terminal

# In another: get a session cookie
SESSION_COOKIE=$(
  curl -s -D - -X POST http://localhost:3001/api/auth/sign-in/email \
    -H "Content-Type: application/json" \
    -d '{"email":"samantha.anderson@yahoo.com","password":"SeedPass123!"}' \
    -o /dev/null \
  | grep -i 'set-cookie: better-auth.session_token=' | head -1 \
  | sed 's/^[Ss]et-[Cc]ookie: //;s/;.*$//'
)
WIPRO_ORG="<paste id from §1>"
LEARNPRO_ORG="<paste id>"
IIT_ORG="<paste id>"
```

### 3.1 New B1-hybrid endpoints (this session)

```bash
# Org-scoped lists — all should return 200 with {items, total, page, perPage}
for path in appointments waitlist trials documents recordings stream/channels; do
  printf "%-25s %s\n" "$path:" "$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Cookie: $SESSION_COOKIE" \
    http://localhost:3001/api/organizations/$WIPRO_ORG/$path)"
done

# Reimbursements (Wipro is INVOICE — should 404; only PERSONAL orgs see it)
curl -s -H "Cookie: $SESSION_COOKIE" \
  http://localhost:3001/api/organizations/$WIPRO_ORG/reimbursements
# → {"error":"Reimbursements view is only available for organizations on PERSONAL funding."}

# Personal endpoints with scope toggle
curl -s -H "Cookie: $SESSION_COOKIE" "http://localhost:3001/api/appointments?orgScope=personal" | head -c 200
curl -s -H "Cookie: $SESSION_COOKIE" "http://localhost:3001/api/appointments?orgScope=$WIPRO_ORG" | head -c 200
curl -s -o /dev/null -w "all-scope (CONSULTEE→403): %{http_code}\n" \
  -H "Cookie: $SESSION_COOKIE" "http://localhost:3001/api/appointments?orgScope=all"
```

### 3.2 Cross-tenant guards (everything should return 403)

```bash
# Wipro user hitting LearnPro endpoints
curl -s -o /dev/null -w "→ learnpro/payouts: %{http_code}\n" \
  -H "Cookie: $SESSION_COOKIE" \
  http://localhost:3001/api/organizations/$LEARNPRO_ORG/payouts
curl -s -o /dev/null -w "→ iit/billing-account/wallet: %{http_code}\n" \
  -H "Cookie: $SESSION_COOKIE" \
  http://localhost:3001/api/organizations/$IIT_ORG/billing-account/wallet
```

### 3.3 Capability gates (structural 404 — not auth 403)

```bash
# Wipro is SPONSOR-only; HOST routes return 404 (not 403):
curl -s -o /dev/null -w "wipro/payouts (SPONSOR only): %{http_code}\n" \
  -H "Cookie: $SESSION_COOKIE" \
  http://localhost:3001/api/organizations/$WIPRO_ORG/payouts   # → 404

# LearnPro is HOST-only; SPONSOR routes return 404:
LEARNPRO_COOKIE=$(...login as daniel.anderson...)
curl -s -o /dev/null -w "learnpro/billing (HOST only): %{http_code}\n" \
  -H "Cookie: $LEARNPRO_COOKIE" \
  http://localhost:3001/api/organizations/$LEARNPRO_ORG/billing   # → 404
```

---

## 4. Live payouts (A1) sandbox test

Without `ENABLE_LIVE_PAYOUTS=true`, the cron simply flips PENDING→PROCESSING and stops:

```bash
# Trigger a payout batch via the admin UI or:
curl -s -X POST -H "Cookie: $LEARNPRO_COOKIE" \
  "http://localhost:3001/api/organizations/$LEARNPRO_ORG/payouts" \
  -H "Content-Type: application/json" \
  -d '{"periodStart":"2026-04-01","periodEnd":"2026-04-30"}'

# Then trigger processOrgPayout (cron entry-point):
npx tsx -r dotenv/config -e '
  import("@/lib/payments/payouts").then(async ({processOrgPayout, default: _}) => {
    const r = await processOrgPayout("<payoutId>");
    console.log(r);
  });
' dotenv_config_path=.env
# → {status: "PROCESSING", submittedToGateway: false}  (live disabled)
```

To exercise the live path against the RazorpayX sandbox, set:

```env
# .env (LOCAL ONLY — never commit)
ENABLE_LIVE_PAYOUTS=true
RAZORPAY_KEY_ID=rzp_test_xxxxxxxxxxxx
RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
RAZORPAY_ACCOUNT_NUMBER=2323230012345678   # RazorpayX virtual account
RAZORPAYX_WEBHOOK_SECRET=test_secret_xxx
```

Then re-run the same `processOrgPayout` call. Expected:
- `submittedToGateway: true`
- `OrganizationPayout.gatewayPayoutId` populated
- Watch `/tmp/dev.log` for the SDK call
- A successful gateway response leaves status at PROCESSING; the webhook reconciler flips to COMPLETED

Webhook reconciler test (use the local razorpay-test-webhook plugin):

```bash
# Simulate a payout.processed webhook
WEBHOOK_BODY='{"event":"payout.processed","payload":{"payout":{"entity":{"id":"<gatewayPayoutId>","status":"processed","utr":"AXIS123456","failure_reason":null}}}}'
WEBHOOK_SIG=$(node -e "console.log(require('crypto').createHmac('sha256', '$RAZORPAYX_WEBHOOK_SECRET').update('$WEBHOOK_BODY').digest('hex'))")

curl -s -X POST http://localhost:3001/api/webhooks/razorpay \
  -H "Content-Type: application/json" \
  -H "x-razorpay-signature: $WEBHOOK_SIG" \
  -d "$WEBHOOK_BODY"
```

After the webhook hits, the OrganizationPayout row should have:
- `status = COMPLETED`
- `gatewayUtr = AXIS123456`
- `processedAt = <now>`
- A new `OrgAuditLog` row with `action = PAYOUT_COMPLETED`
- A Novu `org-payout-completed` notification fired to the visibility roster

---

## 5. India compliance smoke (A2)

The TDS, MSME, and IRP modules are live but env-gated. With no `CLEARTAX_*` env, IRN generation falls back to STUB (returns `{status:"FAILED", reason:"STUB: ..."}`).

```bash
# TDS unit test
npx jest __tests__/enterprise/tds-derivation.test.ts

# MSME unit test
npx jest __tests__/enterprise/msme-deadline.test.ts

# IRP live mode (requires ClearTax sandbox creds in .env)
# CLEARTAX_API_KEY=...
# CLEARTAX_GSP_TOKEN=...
# CLEARTAX_GSTIN=29AAAPL1234C1Z2
# CLEARTAX_ENV=sandbox
npx tsx -r dotenv/config -e '
  import("@/lib/compliance/irp").then(async (m) => {
    console.log("ClearTax configured?", m.isClearTaxConfigured());
    const r = await m.generateIrn({invoiceId: "test-1", payload: {}});
    console.log(r);
  });
' dotenv_config_path=.env
```

---

## 6. C1 refund operation smoke

```bash
# Run the unit suite
npx jest __tests__/payments/refund-operation.test.ts   # 10 tests

# Manual test against real seed payment
npx tsx -r dotenv/config -e '
  import("@/lib/payments/operations/refund").then(async ({refundPayment}) => {
    const r = await refundPayment({
      paymentId: "<seed payment id>",
      reason: "Smoke test refund",
      initiatedByUserId: "<your admin user id>",
    });
    console.log(r);
  });
' dotenv_config_path=.env
```

Expected return shape: `{refundId, amountRefundedPaise, legsReversed, consultantEarningsReversed, organizationEarningsReversed, clawbackInitiated}`.

If the original payment's earnings were already PAID via OrganizationPayout, `clawbackInitiated=true` and the payout row gets `clawbackAmountPaise` incremented + `clawbackInitiatedAt` stamped.

---

## 7. C2 overage charging smoke

```bash
# Set up a LICENSED_SEAT program with overageBehavior=CHARGE_ORG and a low cap.
# Book past the cap via the existing checkout flow:
curl -s -X POST -H "Cookie: $SESSION_COOKIE" \
  -H "Content-Type: application/json" \
  http://localhost:3001/api/checkout \
  -d '{
    "appointmentType": "CONSULTATION",
    "planId": "<consultation plan id>",
    "programAssignmentId": "<assignment that's at-cap>",
    "slotStartTimeInUTC": "2026-06-01T10:00:00Z",
    "slotEndTimeInUTC": "2026-06-01T11:00:00Z"
  }'

# CHARGE_ORG → expect 200 + an additional PaymentLeg(source=INVOICE_ACCRUAL, sourceRef="overage:<assignmentId>")
# CHARGE_MEMBER → expect 402 with code "OVERAGE_REQUIRES_SEPARATE_PAYMENT"
# BLOCK         → expect 409 (existing behavior)
```

Verify the leg landed:

```bash
npx tsx -r dotenv/config -e '
  import("@/lib/prisma").then(async ({default: p}) => {
    const legs = await p.paymentLeg.findMany({
      where: {sourceRef: {startsWith: "overage:"}},
      take: 5,
      orderBy: {createdAt: "desc"},
    });
    console.log(JSON.stringify(legs, null, 2));
    await p.$disconnect();
  });
' dotenv_config_path=.env
```

---

## 8. C4 reimbursement-report UI smoke

Only fires for sponsor orgs on **PERSONAL** funding. Wipro is INVOICE-funded so it'll 404. Use a PERSONAL-funded test org:

```bash
# Create one or pick from seed (if any is PERSONAL):
npx tsx -r dotenv/config -e '
  import("@/lib/prisma").then(async ({default: p}) => {
    const a = await p.billingAccount.findFirst({where: {fundingSource: "PERSONAL"}, include: {organization: {select: {id: true, slug: true}}}});
    console.log(a?.organization);
    await p.$disconnect();
  });
' dotenv_config_path=.env

# Then GET the report
curl -s -H "Cookie: $OWNER_COOKIE" \
  http://localhost:3001/api/organizations/<personal_org_id>/reimbursements

# CSV export downloads inline
curl -s -H "Cookie: $OWNER_COOKIE" \
  -o reimbursements.csv \
  http://localhost:3001/api/organizations/<personal_org_id>/reimbursements/export
head reimbursements.csv
```

---

## 9. Comprehensive smoke (all 30+ org endpoints × 3 personas)

Quick bash recipe:

```bash
ORG_GET=( "" /activity /analytics /audit /audit/export /billing /billing-account
  /billing-account/invoices /billing-account/purchase-orders /billing-account/wallet
  /billing-account/wallet/top-ups /catalog /catalog/search /consent /contracts
  /domain-claims /earnings /hris /invitations /members /payout-account /payouts
  /programs /rate-cards /settings /sso /sso/providers
  /appointments /waitlist /trials /documents /recordings /reimbursements /stream/channels )

for p in "${ORG_GET[@]}"; do
  printf "%-45s %s\n" "$p" \
    "$(curl -s -o /dev/null -w '%{http_code}' \
      -H "Cookie: $SESSION_COOKIE" \
      http://localhost:3001/api/organizations/$WIPRO_ORG$p)"
done
```

**Expected matrix** (Wipro = SPONSOR/INVOICE):
- 200 on: org-detail, activity, analytics, audit (CSV export = 200 text/csv), billing, billing-account, invoices, purchase-orders, catalog, catalog/search, consent, contracts, domain-claims, hris, invitations, members, programs, settings, sso, sso/providers, appointments, waitlist, trials, documents, recordings, stream/channels
- 404 on: earnings, payout-account, payouts, rate-cards (HOST-only)
- 404 on: reimbursements (PERSONAL-only)
- 409 on: billing-account/wallet, /top-ups (WALLET-funding-only)

Same pattern, mirror-imaged, for LearnPro (HOST) — billing-side returns 404, host-side returns 200.

---

## 10. Stream.io org tagging (B2)

```bash
# After creating any new appointment via checkout, the chat channel +
# video call should now carry `custom.organizationId` (chat) /
# `custom.organizationId` (video). Verify in the Stream dashboard:

# Or via the new endpoint:
curl -s -H "Cookie: $SESSION_COOKIE" \
  "http://localhost:3001/api/organizations/$WIPRO_ORG/stream/channels"
# → {items: [{cid, name, memberCount, lastMessageAt}, ...]}
```

For existing pre-migration channels, run the backfill:

```bash
npx tsx -r dotenv/config scripts/stream/backfill-channel-org.ts dotenv_config_path=.env
```

---

## 11. Final sanity checks before commit

```bash
# 1. Type check
npx tsc --noEmit -p .   # 0 errors

# 2. Test suite — should be 164/164
npx jest __tests__/enterprise __tests__/payments

# 3. Production build
npm run build   # passes

# 4. Reconciliation cron clean
npx tsx -r dotenv/config scripts/reconcile/reconcile-ledgers.ts dotenv_config_path=.env

# 5. Schema in sync with DB
npx prisma migrate status

# 6. Make sure SMOKE_BYPASS_AUTH is NOT set in your shell or .env
# (the bypass code was removed but the env var being set is still suspicious)
unset SMOKE_BYPASS_AUTH
grep -v "^SMOKE_BYPASS_AUTH" .env > .env.tmp && mv .env.tmp .env
```

---

## 12. Files created / modified this session

```
# Schema migration
prisma/migrations/20260501120000_org_scope_split_and_payout_clawback/migration.sql

# Schema fields (in prisma/schema.prisma)
- Appointment.organizationId, Waitlist.organizationId, Recording.organizationId (+ indexes)
- OrganizationPayout.{gatewayPayoutId@unique, gatewayUtr, gatewayResponseRaw, failedAt,
                     clawbackAmountPaise, clawbackInitiatedAt}

# Backfill scripts
prisma/scripts/backfill-appointment-org-id.ts
prisma/scripts/backfill-isindependent.ts

# Compliance
lib/compliance/{tds,msme,irp}.ts                  # live derivation / ClearTax scaffold
lib/compliance/dtaa-rates.json                     # India DTAA partner rates

# Payments
lib/payments/operations/refund.ts                  # canonical refund op (C1)
lib/payments/operations/checkout.ts                # B1-checkout stamp + C2 overage
lib/payments/payouts/org-payout-service.ts         # A1 live submission + Failed/Reversed helpers
lib/payments/payouts/earnings-service.ts           # A3 collaborator org earnings
lib/payments/payouts/index.ts                      # re-exports
scripts/refunds/cascade-refund-earnings.ts         # refactored to call refund op

# Membership / lifecycle
lib/api/organizations/membership-transitions.ts    # recomputeConsultantIsIndependent
app/api/organizations/[orgId]/members/route.ts     # A4 callsites
app/api/organizations/[orgId]/members/[memberId]/route.ts  # A4 + A7 cascade + Novu
app/api/organizations/invitations/accept/route.ts  # A4 callsite
lib/auth.ts                                        # SSO auto-join A4 callsite

# Cron + jobs
jobs/contracts/expire-contracts.ts                 # A5
.github/workflows/expire-contracts.yml             # daily 03:00 UTC
.github/workflows/{auto-complete,cleanup-invalid,release-earnings,sync-payment,reconcile-disputes,reconcile-payout-status,transfer-expiring-recordings}.yml
                                                   # C9 cron stagger

# Stream.io org tagging (B2)
actions/stream/chat/channel.action.ts              # all 5 createChannel helpers
lib/meeting.ts                                     # createMeeting + getOrCreateAppointmentMeeting
scripts/stream/backfill-channel-org.ts             # one-shot backfill
app/api/organizations/[orgId]/stream/channels/route.ts  # query Stream by org

# B1-hybrid: scope service + routes + dashboards + hook
lib/api/scope/{parse,list-appointments,list-waitlist,list-trials,list-documents,list-recordings}.ts
lib/hooks/useOrgScope.ts
app/api/{appointments,documents,recordings}/route.ts        # personal LIST with ?orgScope=
app/api/organizations/[orgId]/{appointments,waitlist,trials,documents,recordings,reimbursements,reimbursements/export}/route.ts
app/dashboard/organization/[orgId]/{appointments,waitlist,trials,documents,recordings,reimbursements}/page.tsx
components/enterprise/ScopedListTable.tsx          # shared table
app/dashboard/organization/[orgId]/layout.tsx      # +Reimbursements sidebar entry

# Novu
lib/novu/{workflows,service,org-workflows}.ts      # ORG_PAYOUT_FAILED/REVERSED + ORG_EXPERT_REMOVED

# Webhook
app/api/webhooks/razorpay/route.ts                 # +utr field
app/api/webhooks/utils.ts                          # handleRazorpayPayoutWebhook dispatcher

# Audit
lib/enterprise/audit-actions.ts                    # +PAYOUT_REVERSED + PAYOUT_CLAWBACK

# Tests
__tests__/enterprise/{tds-derivation,msme-deadline,collaborator-org-earnings,
                     live-payout-submission,payout-webhook-reconciler}.test.ts
__tests__/payments/refund-operation.test.ts

# Doc cleanup (D1, D7)
docs/enterprise/playbooks/billing-technical.md
docs/enterprise/explainers/billing-architecture.md
docs/enterprise/13-feature-flags-and-rollout.md
docs/enterprise/00-overview.md   # ENABLE_HOST_ORGS rename
docs/roadmap/enterprise/*.md                        # ARCHIVED banner

# WIP banner removals
app/dashboard/organization/[orgId]/programs/page.tsx        # C2 banner removed
components/organization/create-wizard/BillingStep.tsx        # C4 banner removed
```

---

## 13. Consultant-side scope toggle smoke

Verify `OrgContextFilter` is mounted and functional on the three consultant pages
that were retrofitted in Stacked PR #2 (requests, planner, documents). The other
three (appointments, recordings, trials) are deferred — see the enterprise readiness
backlog issue.

```bash
# Prerequisites: a consultant user who belongs to ≥1 org (e.g. vipro or any
# EXPERT in wipro-tech).  Sign in and get a session cookie first.

BASE="http://localhost:3001"
CONSULTANT_ID="<the consultantProfileId from the DB>"

# 1. Default (personal scope) — no ?orgScope= param
curl -s -o /dev/null -w "%{http_code}" \
  -H "Cookie: $SESSION" \
  "$BASE/api/dashboard/consultant/$CONSULTANT_ID/requests"
# Expect: 200

# 2. Org scope — filter to wipro-tech
WIPRO="cmoedzie002b2xukbphy4c6br"
curl -s "$BASE/api/dashboard/consultant/$CONSULTANT_ID/requests?orgScope=$WIPRO" \
  -H "Cookie: $SESSION" | jq '.data | length'
# Expect: ≤ total rows (a strict subset when filtered)

# 3. "All" scope (staff-level, should be 403 for EXPERT role)
curl -s -o /dev/null -w "%{http_code}" \
  -H "Cookie: $SESSION" \
  "$BASE/api/dashboard/consultant/$CONSULTANT_ID/requests?orgScope=all"
# Expect: 403 (EXPERT cannot request all-scope)
```

**UI verification checklist:**
1. Sign in as a consultant who is member of ≥1 org.
2. Open `/dashboard/consultant/[id]/requests` — confirm OrgContextFilter dropdown appears top-right.
3. Dropdown shows: `All activity` / `Personal only` / `<org name>`.
4. Select a specific org → URL updates to `?orgScope=<orgId>`, request list refetches.
5. Select `Personal only` → `?orgScope=` removed from URL (clean URL = personal default).
6. Sign in as a consultant with **zero** org memberships → dropdown must be invisible (self-hides).

---

## 14. Admin/staff `?orgId=` filter smoke

Eight back-office endpoints now accept an optional `?orgId=` query param to scope
their list to a single tenant. Added in Stacked PR #2 (`S2` task).

```bash
BASE="http://localhost:3001"
# Get an admin session first (requirePrivilegedAuth / requireAdminAuth)
# SESSION=...

WIPRO="cmoedzie002b2xukbphy4c6br"

echo "=== Admin routes ==="
for path in payments disputes users subscriptions; do
  UNFILTERED=$(curl -s -H "Cookie: $SESSION" "$BASE/api/admin/$path" \
    | jq '.data | length // .total // . | if type=="array" then length else . end')
  FILTERED=$(curl -s -H "Cookie: $SESSION" "$BASE/api/admin/$path?orgId=$WIPRO" \
    | jq '.data | length // .total // . | if type=="array" then length else . end')
  printf "admin/%-16s unfiltered=%-4s filtered=%-4s\n" "$path" "$UNFILTERED" "$FILTERED"
  # Expect: filtered ≤ unfiltered
done

echo "=== Staff routes ==="
for path in appointments invoices payouts; do
  UNFILTERED=$(curl -s -H "Cookie: $SESSION" "$BASE/api/staff/$path" \
    | jq '.data | length // .total // . | if type=="array" then length else . end')
  FILTERED=$(curl -s -H "Cookie: $SESSION" "$BASE/api/staff/$path?orgId=$WIPRO" \
    | jq '.data | length // .total // . | if type=="array" then length else . end')
  printf "staff/%-16s unfiltered=%-4s filtered=%-4s\n" "$path" "$UNFILTERED" "$FILTERED"
done

# All should return 200 with filtered ≤ unfiltered
# Verify a bogus orgId returns 200 with empty data (not a 400):
curl -s -o /dev/null -w "%{http_code}" \
  -H "Cookie: $SESSION" \
  "$BASE/api/admin/payments?orgId=nonexistent-org-id"
# Expect: 200 (Prisma WHERE on organizationId=nonexistent → empty results, not an error)
```

---

## Open known-deferred items (NOT in this push)

These were explicitly marked "defer until customer pull" in the plan:

- **B3 Recordings library MVP** (#367) — defer
- **C5 multi-currency gateway auto-routing** — defer until first cross-border deal
- **D3 unify `Invitation` into `Membership(PENDING)`** — separate refactor PR
- **A6 Programs v2 (PROJECT, RETAINER)** — defer until 3+ design partners ask
- **C6 SSO live wiring deep audit (#670, #672)** — separate PR
- **C7 HRIS sync** (#701) — defer until 100+ seat customer
- **C8 DPDP / DataBreach UI** (#701) — per regulatory deadline
- **B1 personal-dashboard scope retrofit** — new APIs accept `?orgScope=` but the existing personal dashboard pages don't toggle it yet (out of scope this batch)

---

## Smoke validation summary (May 2026)

Ran a **112-probe smoke harness** against a temp-bypassed dev server (bypass code was removed before commit). Result:

```
TOTAL: 112  PASS=112  FAIL=0
```

Every:
- new endpoint returns the expected status + JSON shape
- capability gate (sponsor-only / host-only) firing correctly
- cross-tenant scope guard rejecting non-members with 403
- scope-leak invariant holding (no item bleed across orgs)
- CSV export correctly returning text/csv

The bypass code was deleted from `lib/auth-helpers.ts` and `middleware.ts` after validation — auth is back to strict.
