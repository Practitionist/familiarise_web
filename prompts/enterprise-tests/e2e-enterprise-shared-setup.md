# E2E Enterprise — Shared Setup, Glossary, and Invariants

> **Required reading.** Both the API walkthrough
> (`e2e-enterprise-agent-001-arch4-modified-api.md`) and the UI
> walkthrough (`e2e-enterprise-agent-002-arch4-modified-ui.md`) start
> with `> READ FIRST: e2e-enterprise-shared-setup.md`. This file is the
> single source of truth for prerequisites, ledger invariants, the
> capability/role/funding glossary, and the schema reference. If the
> API and UI prompts ever disagree, this file wins.

---

## CRITICAL RULES (apply to BOTH suites)

1. **Fix bugs immediately.** If a flow is broken — bad status code, stale
   enum leak, unhandled 500, a UI crash, a ledger that doesn't net to
   zero — stop, diagnose, patch the source in-place, re-verify, and
   continue. Do NOT accumulate a bug list.

2. **Verify DB state after every meaningful action.** The UI can lie;
   the three ledgers (`UsageLedgerEntry`, `FundingLedgerEntry`,
   `SettlementLedgerEntry`) are the source of truth. Query them via
   Supabase MCP at every checkpoint.

3. **Test both happy paths AND guard paths.** Every route has 4xx
   branches (disabling both capabilities, WALLET→X with balance > 0,
   duplicate domain claims, last-OWNER demotion). The API prompt
   exercises every 4xx exhaustively; the UI prompt exercises the
   user-facing guard rails (button hidden, toast surfaced, dialog
   blocked) — they are complementary, not duplicative.

4. **All money in paise** (1 INR = 100 paise). Applies to
   `BillingAccount.walletBalance`, `WalletEntry.deltaPaise`,
   `OrganizationInvoice.totalPaise`, `OrganizationPayout.amountPaise`,
   `ProgramAssignment.*`, everything. The dashboard formats with
   `formatCurrencyAmount(paise, currency)` — never divide by 100 in
   your test assertions; assert the paise integer.

5. **Double-quote Postgres identifiers** that Prisma emitted as
   mixed-case (e.g. `"Membership"`, `"BillingAccount"`, `"Contract"`).
   BetterAuth-mapped tables are lower-case (`organizations`, `members`,
   `invitations`). The Schema Reference table below lists every model.

6. **App runs at** `http://localhost:3000`. Dev server must already be
   up (`npm run dev`). Neither prompt starts or builds it — confirm
   with `curl -sf http://localhost:3000/api/health` and ask the user
   to start it if missing.

7. **Snapshots / network logs liberally.** UI runs use `take_snapshot`
   before every click and `list_network_requests` to capture exact API
   shape when a response surprises you. API runs save the verbatim
   `curl -i` output for every sub-step.

8. **Bug fixes go in the test report's "Bugs fixed" section** with the
   commit SHA / diff. No bug should appear without a fix — see Rule #1.

---

## BACKGROUND YOU MUST INTERNALIZE

### Capability model (replaces OrganizationKind)

`Organization` carries two booleans — `canSponsor` and `canHost` — that
together express the four conceivable shapes:

| canSponsor | canHost | Shape   | Example |
|------------|---------|---------|---------|
| `true`     | `false` | Sponsor | Wipro (pays for its engineers' consults) |
| `false`    | `true`  | Host    | IIT Madras (hosts professors who earn through the org) |
| `true`     | `true`  | Hybrid  | LearnPro (both buys sessions for staff AND hosts its own instructors) |
| `false`    | `false` | **Invalid** — at least one must be true |

An org can express further capabilities via the `capabilitiesExtra Json?`
escape hatch (e.g. `{ "RESELL": true }`) without a migration, but the
two typed booleans cover the 90% path.

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
- `PROJECT` — v2-reserved placeholder; not wired in v1 but must
  round-trip without 500.

One BillingAccount per org when `canSponsor=true`. `canSponsor=false`
orgs have NO BillingAccount at all.

### Program subtypes

`Program.type` drives a discriminated subtype:

- `LICENSED_SEAT` — has a 1:1 `LicensedSeatConfig` row.
  `ratePerSeatPaise` + `cycle` + optional `coveredSessionsPerCycle`
  (null = unlimited, which replaces the old `PREPAID_UNLIMITED`).
  `overageBehavior` ∈ `{ BLOCK, CHARGE_MEMBER, CHARGE_ORG }`.
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
  cards, funding source flips, payouts, branding uploads).
- `MAINTAINER` — org admin below owner. Was the old `ADMIN`; renamed
  to avoid colliding with `UserRole.ADMIN` (platform admin).
- `MANAGER` — read-heavy admin (invoices, earnings, audit log). Sees
  the wallet page but cannot top up.
- `EXPERT` — delivers services on behalf of the org. Was `CONSULTANT`;
  renamed because the org-side term must be disjoint from
  `UserRole.CONSULTANT`. Do NOT say "consultant" for a member — say
  "expert".
- `LEARNER` — consumes services through the org. No admin chrome at
  all; the org dropdown shows only the home page.
- `SUPPORT` — internal ops / CX role.

Disjoint from `UserRole = { CONSULTEE, CONSULTANT, ORG_ADMIN, ADMIN }`,
which is the platform-level role on `users.role`. `ORG_ADMIN` is the
gate for `POST /api/organizations`; `ADMIN` is the platform super-user.

### Three ledgers

All immutable; reconciliation invariants are in
`docs/enterprise/18-three-ledger-discipline.md`. The three surfaces:

- `UsageLedgerEntry` — sessions consumed (positive deltas; negative on
  reversal).
- `FundingLedgerEntry` — wallet deltas (`TOPUP`, `BOOKING_DEBIT`,
  `REFUND_CREDIT`, `ADJUSTMENT`, `GRANT`). `balanceAfterPaise` is
  persisted for reconciliation.
- `SettlementLedgerEntry` — invoices, payouts, refunds
  (`INVOICE_ISSUED`, `INVOICE_PAID`, `PAYMENT_RECEIVED`,
  `REFUND_ISSUED`, `PAYOUT_SENT`, `PAYOUT_REVERSED`, `CHARGEBACK`,
  `CREDIT_NOTE`).

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
CONSENT | SYSTEM`). Well-known action literals come from the
autocomplete constant `AUDIT_ACTIONS` in
`lib/enterprise/audit-actions.ts`. There's a legacy `OrgAuditAction`
enum in the schema kept for type-checking only — the DB column uses
the string.

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

### Razorpay async settlement (CRITICAL for both suites)

Razorpay confirms payment via webhook, not via the API response. The
client-side flows (wallet top-up, invoice pay) bridge the gap with
**bounded polling** against `GET /…/wallet/top-ups/{topUpId}` (or the
analogous invoice status endpoint). Three terminal outcomes:

- **`confirmed`** — webhook landed during the polling window; the
  ledger row exists; toast says "Top-up confirmed" / "Invoice paid".
- **`pending`** — popup `handler` fired (capture succeeded) but the
  webhook is slow; toast says "Awaiting confirmation"; balance will
  catch up on next page load.
- **`not_paid`** — popup dismissed or `payment.failed` fired; the
  silent-on-success contract means we lean on the `payment.failed`
  toast for the user-visible signal.

Webhook handler is idempotent on `WalletEntry.providerOrderId` /
`Payment.razorpayOrderId`, so a confirmed-but-already-paid replay is a
no-op.

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

**Supabase Project ID:** `pzmbxqdgibfkhjwzeprf`

---

## PREREQUISITES

### P.1 — DB reset + seed

```bash
cd /Users/kaustavghosh/Desktop/familiarise_web
npx prisma db push --force-reset
npm run db:seed
```

This seeds the four representative org shapes:

- **Wipro** — Sponsor-only, `fundingSource=INVOICE`, `LICENSED_SEAT`
  program.
- **LearnPro Academy** — Hybrid (canSponsor + canHost),
  `fundingSource=LICENSE`.
- **IIT Madras** — Host-only, `fundingSource=PERSONAL` (students pay
  their own card for external-consultant access).
- **Rahul's Coaching** — solo consultant, micro-Host org auto-created
  on onboarding.

Owner emails the seed stamps (use these for both API curl and Chrome
DevTools login):

| Org          | Owner email                 |
|--------------|-----------------------------|
| Wipro        | `founder@wipro.test`        |
| IIT Madras   | `founder@iitmadras.test`    |
| LearnPro     | `founder@learnpro.test`     |
| Rahul solo   | `rahul@familiarise.test`    |

Password for all seeded accounts: `TestPassword123!`.

### P.2 — Dev server health

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

These are guard rails — if either fails you've got pre-existing
breakage in the branch. Fix before touching test flows.

### P.4 — Promote your test user to `UserRole.ORG_ADMIN`

`POST /api/organizations` is gated to `UserRole.ORG_ADMIN` and the
platform `UserRole.ADMIN`
([`app/api/organizations/route.ts`](../../app/api/organizations/route.ts)
lines 129-142). A freshly-signed-up `CONSULTEE` cannot create an org —
the route returns **403** with `"Only organization administrators can
create organizations. Sign up with the Organization Owner role to
continue."` This will fail the create-org steps instantly if skipped.

Two ways to land in `ORG_ADMIN`:

1. Walk the role-picker in Chrome DevTools at `/form/onboarding` and
   pick "Organization Owner". The form action lives in
   [`actions/forms/onboarding.action.ts`](../../actions/forms/onboarding.action.ts)
   (`SELF_SELECTABLE_ONBOARDING_ROLES`) and flips both `users.role`
   and `users.onboardingCompleted`.
2. SQL fallback (faster for harness runs):

   ```sql
   UPDATE users
      SET role = 'ORG_ADMIN', "onboardingCompleted" = true
    WHERE email = '<test-email>';
   ```

For platform-admin steps (verify org, run seeded admin reports) you
also need a platform `ADMIN`:

```sql
UPDATE users SET role = 'ADMIN' WHERE email = '<your-test-admin>';
```

### P.5 — Get a session cookie for curl (API suite only)

Log in via Chrome DevTools MCP first, then copy the
`better-auth.session` cookie from `list_network_requests` and export
it:

```bash
export COOKIE='better-auth.session=<paste-here>; better-auth.session_token=<paste-here>'
```

Replay throughout the API walkthrough. Each `curl` assumes `$COOKIE`
for the org-OWNER session and `$ADMIN_COOKIE` for the platform-admin
session.

> The UI walkthrough does NOT use `$COOKIE` directly — Chrome DevTools
> carries the session in the browser. But the same login is required;
> sign in to the UI _before_ either suite runs.

### P.6 — Razorpay test keys

Both wallet top-up and invoice payment require a Razorpay test
key/secret pair in the dev `.env`:

```
RAZORPAY_KEY_ID=rzp_test_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
```

If any are missing, the relevant routes 503 with
`"Razorpay is not configured"`. Both suites have explicit sub-steps
that exercise this 503 by temporarily blanking `RAZORPAY_KEY_ID`. Use
official test cards (`4111 1111 1111 1111`, OTP `1234`) in the popup
flows.

### P.7 — Audit-action cheat sheet

The activity feed and the J.3 / wrap-up ledger checks reference these
action literals (verbatim from `lib/enterprise/audit-actions.ts`).
Pass nothing else when filtering:

```
ORG_CREATED, MEMBER_INVITED, INVITATION_ACCEPTED, MEMBER_ROLE_CHANGED,
MEMBER_REMOVED, CONTRACT_SIGNED, RATE_CARD_BUMPED, PROGRAM_CREATED,
PROGRAM_ASSIGNED, WALLET_TOPUP, WALLET_TOPUP_CONFIRMED,
INVOICE_ISSUED, INVOICE_PAYMENT_INITIATED, INVOICE_PAID,
INVOICE_VOIDED, PAYOUT_INITIATED, PAYOUT_SENT, PAYOUT_REVERSED,
PAYOUT_CANCELLED, SETTINGS_CHANGED, BRANDING_UPLOADED,
BRANDING_REMOVED, SSO_PROVIDER_CONFIGURED, DOMAIN_CLAIMED, VERIFIED,
CONSENT_GRANTED, CONSENT_WITHDRAWN, HRIS_CONFIGURED, HRIS_SYNC_RAN
```

---

## REFERENCES (READ ONCE IF STUCK)

- Capability model: `prisma/schema.prisma` `model Organization`
  (line ~417).
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
- Create-org route: `app/api/organizations/route.ts` (the `ORG_ADMIN`
  gate lives at lines 129-142).
- Accept-invitation race: `app/api/organizations/invitations/accept/route.ts`
  (the `updateMany WHERE status=pending` atomic-claim is the core).
- SSO URL derivation: `lib/sso/derive-urls.ts` (`deriveAcsUrl`,
  `deriveMetadataUrl`); SSO body schemas: `lib/sso/provider-schemas.ts`.
- India compliance stubs: `lib/compliance/{tds,msme,gst,irp,dpdp,form15}.ts`.
- Wallet top-up POST: `app/api/organizations/[orgId]/billing-account/wallet/top-ups/route.ts`
  — the OWNER + active-org gate, Razorpay-order-then-WalletEntry
  ordering, and the idempotency / 503 branches.
- Wallet top-up status polling: `app/api/organizations/[orgId]/billing-account/wallet/top-ups/[topUpId]/route.ts`
  — `pending → confirmed` contract used by the dashboard polling loop
  in `app/dashboard/organization/[orgId]/credits/page.tsx`.
- Invoice /pay handler: `app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/pay/route.ts`
  — mints the Razorpay order + emits `INVOICE_PAYMENT_INITIATED`;
  webhook is the only path that flips `status=PAID`.
- Invoice PATCH allow-list: `app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/route.ts`
  (lines 100-120) — proves PAID is unreachable via PATCH.
- Payout PATCH state machine: `app/api/organizations/[orgId]/payouts/[payoutId]/route.ts`
  — the `PAYOUT_REVERSED` settlement row + `PAYOUT_CANCELLED` audit
  on cancel (lines 122-172).
- Branding upload: `app/api/organizations/[orgId]/branding/[asset]/route.ts`
  + helpers in `lib/supabase.ts` (`uploadOrganizationLogo`,
  `uploadOrganizationBanner`, `ORG_LOGO_MAX_SIZE`,
  `ORG_BANNER_MAX_SIZE`, `ALLOWED_ORG_BRANDING_IMAGE_TYPES`).
- Razorpay webhook entry: `app/api/webhooks/razorpay/route.ts`;
  signature verification + payload routing live in
  `app/api/webhooks/utils.ts` (`handleOrgPaymentSuccess` handles
  `notes.type ∈ {credit_purchase, invoice_payment}`).

When a step yields unexpected behaviour, read the exact route file
from `app/api/organizations/**` before escalating — most answers live
in the handler's inline comments, not in higher-level docs.

---

**Done? Open the suite the user asked for:**

- API contract suite: `e2e-enterprise-agent-001-arch4-modified-api.md`
- UI walkthrough suite: `e2e-enterprise-agent-002-arch4-modified-ui.md`
