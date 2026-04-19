# E2E Enterprise Walkthrough — UI Journey Suite (Arch 4-Modified)

> **READ FIRST: [`e2e-enterprise-shared-setup.md`](./e2e-enterprise-shared-setup.md).**
> That file owns the prerequisites (DB seed, dev-server health, role
> promotion, Razorpay test keys), the capability / role / funding
> glossary, the schema reference, the audit-action cheat sheet, and
> the cross-cutting CRITICAL RULES. Do not start Phase U.1 until
> P.1-P.7 in that file are green.

## Role & Mission

You are a **senior QA engineer** performing a hands-on **UI journey
acceptance walkthrough** of the Arch 4-Modified enterprise dashboard
on branch `feature/enterprise-arch4` of
`/Users/kaustavghosh/Desktop/familiarise_web`.

This suite is the **client-side source of truth**: every journey is
driven through the live React app via Chrome DevTools MCP, every
network call the page makes is cross-checked, every console message is
inspected, and every Razorpay popup → bounded-polling → toast cycle is
walked end-to-end. The exhaustive 4xx-branch coverage lives in the
sibling prompt `e2e-enterprise-agent-001-arch4-modified-api.md`; this
file focuses on what only the UI can prove.

You have access to two MCP tools:

- **Chrome DevTools MCP** — drive the UI at `http://localhost:3000`.
- **Supabase MCP** — read-only ledger + audit checkpoints
  (`execute_sql`). Project ID: `pzmbxqdgibfkhjwzeprf`.

---

## CRITICAL UI-SUITE RULES (in addition to shared-setup CRITICAL RULES)

1. **NEVER call `evaluate_script`.** This suite simulates a real user.
   No JS-in-page execution, no DOM probing via JavaScript, no
   `document.querySelector`. Drive everything with `navigate_page`,
   `take_snapshot`, `click`, `fill`, `fill_form`, `select_option`,
   `wait_for`, `key_press`, `scroll`, `upload_file`, `handle_dialog`,
   `resize_page`, `list_network_requests`, `get_network_request`, and
   `list_console_messages`. If a journey can't be completed without
   `evaluate_script`, that's a UX bug — file it and stop.

2. **Snapshot before every interaction.** `take_snapshot` immediately
   before each `click` / `fill` / `select_option` so the report shows
   what the user saw. `take_screenshot` only when something looks
   visually wrong (hydration mismatch, broken layout, missing chrome).

3. **Network log after every state-changing journey step.** Pull
   `list_network_requests` after the action and assert:
   - The expected route fired (path + method + status).
   - The request body matches what the user typed (no silent
     transformation drift).
   - There were **no unexpected 4xx/5xx** in the burst (one acceptable
     exception: the explicit guard-rail steps that intentionally
     trigger a 403/409 — those must be the only failed requests in
     their burst).

4. **Console must stay clean.** Run `list_console_messages` at the end
   of every phase. Allowed: `info` / `log` / Razorpay's own
   `[Razorpay]` chatter. Forbidden: any `error` or `warn` from React,
   Next.js, or our app code. A single uncaught console error is a
   phase failure — fix the source, don't suppress it.

5. **Cross-check the DB at the END of every phase.** This suite is
   thinner on per-action SQL than the API suite (the API suite already
   verifies every ledger row), but the phase boundary always asserts:
   the audit log gained the expected `OrgAuditLog.action` literals
   from `lib/enterprise/audit-actions.ts`, and any ledger writes the
   journey implied are present with `balanceAfterPaise` continuity.

6. **Tolerate the Razorpay async window.** When polling is involved
   (top-up, invoice pay), wait up to 25 s for the toast to flip from
   "Initiating…" → "Top-up confirmed" / "Invoice paid". If it stalls
   on "Awaiting confirmation from Razorpay" past that window, that
   is the documented `pending` outcome — verify the page re-renders
   the credited balance after a `navigate_page` reload.

7. **Two-tab journeys use `new_page`, not `navigate_page`.** The
   accept-invitation flow (U.2) requires the inviter session staying
   open while the invitee accepts in a second tab. Same for the
   LEARNER-RBAC visibility check in U.8.

8. **Fix-on-sight from CRITICAL RULES #1 in shared-setup applies
   here too.** A visual bug, a stale React Query cache, a polling
   loop that never resolves, a missing `wait_for` hook — patch the
   source, replay the failed sub-step from the closest stable
   navigation, then continue. Do not accumulate a bug list.

---

## SCOPE — what this suite covers, and what it doesn't

**Covered (UI-exclusive concerns):**

- The signup → onboarding role-picker → org-creation wizard funnel,
  including the BrandingStep colour PATCH.
- React Query polling loops for Razorpay top-up and invoice pay (the
  `pending → confirmed` toast flip).
- Razorpay JS SDK popup integration — `payment.failed`, dismissal,
  successful capture handler.
- Dashboard role-based chrome (the LEARNER cannot see the Top-up
  button; OWNER sees Settings + Payouts; MANAGER sees Wallet read-only).
- Two-tab invitation acceptance with React Query cache hand-off.
- Form validation rendering (Zod errors surface as inline field
  messages, not just network 400s).
- Navigation continuity (back-button, in-dashboard sidebar, breadcrumb).
- Empty-state fallbacks (zero-data analytics card, no-payouts panel).
- Console + hydration cleanliness across every phase.

**Not covered here (handled by the API suite):**

- Exhaustive 4xx coverage of every route (the API suite does each).
- Idempotency-key replay logic (curl-only).
- The `503 "Razorpay is not configured"` branch — exercised by the
  API suite by blanking `RAZORPAY_KEY_ID`. Verifying it again via UI
  is rerun cost without new signal.
- Webhook signature verification (no UI surface).
- Branding asset (logo / banner) **uploads** — there is no UI surface
  for these today (`components/organization/create-wizard/BrandingStep.tsx`
  comments confirm "logo + banner uploads land with the live
  image-upload route (follow-up PR); the wizard stays colors-only").
  When that PR ships, add a U.7b sub-step here.

---

## SEED PRE-FLIGHT (must be green before U.1)

Run these from the workspace root:

```bash
cd /Users/kaustavghosh/Desktop/familiarise_web
npx prisma db push --force-reset
npm run db:seed
curl -sf http://localhost:3000/api/health
```

All four must succeed (`{ ok: true }` from health). If health 4xx/5xx,
ask the user to start `npm run dev` — do NOT start it yourself.

> The seeded org-owner accounts (`founder@wipro.test`,
> `founder@iitmadras.test`, `founder@learnpro.test`,
> `rahul@familiarise.test`) all use `TestPassword123!`. The U.1
> phase signs up a **fresh** account from scratch — the seeded
> accounts are reused from U.2 onwards.

---

## PHASE U.1 — Signup → Onboarding → Org Creation Wizard

> **Goal:** prove a brand-new user can sign up, pick the
> "Organization Owner" role, walk the create-org wizard end-to-end
> (capability + funding + branding-colours), and land on a freshly
> minted org's dashboard with `Membership.role = 'OWNER'`.

### U.1.1 — Sign up a fresh ORG_ADMIN candidate

1. `navigate_page` → `http://localhost:3000/auth/signup`.
2. `take_snapshot`.
3. `fill_form`:
   - `name`: `UI Test Owner`
   - `email`: `ui-owner-${RUN_ID}@familiarise.test` (use a
     timestamp-suffixed email so reruns don't collide).
   - `password`: `TestPassword123!`
   - `confirmPassword`: `TestPassword123!`
4. `click` the "Sign Up" button.
5. `wait_for` redirect to `/form/onboarding`.
6. `list_network_requests` → assert `POST /api/auth/sign-up/email`
   returned `200`.

### U.1.2 — Pick "Organization Owner" on the role step

1. `take_snapshot` of `/form/onboarding`.
2. `click` the "Organization Owner" tile (the first step is
   `PersonalInfoAndRoleForm`).
3. `wait_for` the wizard to advance to the `CreateOrganizationWizard`.
4. `list_network_requests` → assert the `setOnboardingRoleAction`
   server-action POST landed and returned 200, then check via
   Supabase MCP:

   ```sql
   SELECT role, "onboardingCompleted"
     FROM users
    WHERE email LIKE 'ui-owner-%@familiarise.test'
    ORDER BY "createdAt" DESC LIMIT 1;
   ```

   Expect `role = 'ORG_ADMIN'`. (If it's `CONSULTEE`, the role-picker
   wired to the wrong action — fix in
   `actions/forms/onboarding.action.ts`.)

### U.1.3 — Walk the CreateOrganizationWizard

1. **Identity step** — `fill_form`:
   - `name`: `UI Test Sponsor`
   - `slug`: `ui-test-sponsor-${RUN_ID}`
   - `billingEmail`: `ap-ui@familiarise.test`
   `click` "Next".
2. **Capability step** — confirm `canSponsor=true`, `canHost=false`
   are the defaults; toggle if not. `click` "Next".
3. **Funding step** — `select_option` `fundingSource = INVOICE`,
   `requiresPO = true`. `click` "Next".
4. **Branding step** — change `primaryColor` to `#2563eb` and
   `secondaryColor` to `#1e40af` (the colour inputs have
   `id="primaryColor"` / `id="secondaryColor"`). `click` "Save and
   continue".
5. **Review step** — `take_snapshot` for the report; `click` "Create
   organization".
6. `wait_for` redirect to `/dashboard/organization/{newOrgId}`.

### U.1.4 — Verify the org landed correctly

`list_network_requests` and capture the `POST /api/organizations`
response — record the `organization.id` and `billingAccountId`. Then:

```sql
SELECT o."id", o."slug", o."canSponsor", o."canHost",
       o."primaryColor", o."secondaryColor",
       ba."fundingSource", ba."currency",
       m."role", m."status",
       (SELECT COUNT(*) FROM "OrgAuditLog" WHERE "organizationId" = o."id"
          AND action = 'ORG_CREATED') AS audit_org_created
  FROM "organizations" o
  JOIN "BillingAccount" ba ON ba."organizationId" = o."id"
  JOIN "Membership" m ON m."organizationId" = o."id"
                    AND m."userId" = (SELECT id FROM users
                                       WHERE email LIKE 'ui-owner-%' LIMIT 1)
 WHERE o."slug" = 'ui-test-sponsor-${RUN_ID}';
```

Expect: `canSponsor=t`, `canHost=f`, `fundingSource=INVOICE`,
`primaryColor='#2563eb'`, `m.role='OWNER'`, `m.status='ACTIVE'`,
`audit_org_created=1`.

### U.1.5 — Console + chrome sanity

1. `list_console_messages` — zero `error` / `warn`.
2. `take_snapshot` of the org home page.
3. Confirm the sidebar shows: Home, Members, Invitations, Programs,
   Contracts, Billing, Payouts, Analytics, Settings (the OWNER chrome).

> **Phase U.1 acceptance:** signup → onboarding → wizard → dashboard
> with no console errors, ORG_CREATED audited, OWNER membership
> active, branding colours persisted on the row.

---

## PHASE U.2 — Member Invitation + Two-Tab Acceptance

> **Goal:** prove the OWNER can invite a teammate, the invitation
> link works in a second tab, the invitee can accept, and both sides
> see the membership take effect without a manual refresh (React
> Query cache invalidation).

### U.2.1 — Sign in as a seeded owner

`navigate_page` → `/auth/signin`, log in as
`founder@wipro.test` / `TestPassword123!`. `wait_for` the dashboard.
Capture the Wipro `orgId` from the URL.

### U.2.2 — Send an invitation as MAINTAINER

1. `navigate_page` → `/dashboard/organization/{wiproOrgId}/invitations`.
2. `take_snapshot`.
3. `click` "Invite member".
4. `fill_form`:
   - email: `ui-invitee-${RUN_ID}@familiarise.test`
   - role: `MAINTAINER`
5. `click` "Send invitation".
6. `wait_for` the toast "Invitation sent".
7. `list_network_requests` → assert `POST
   /api/organizations/{wiproOrgId}/invitations` returned 201; capture
   the response `invitation.token`.
8. SQL: `SELECT id, email, role, status FROM invitations WHERE
   "organizationId" = '{wiproOrgId}' AND email LIKE 'ui-invitee-%';`
   — expect `status='pending'`, `role='MAINTAINER'`.

### U.2.3 — Open a second tab, accept as invitee

1. `new_page` (this is the invitee tab — keep the inviter tab open).
2. `navigate_page` → `/auth/signup` in the new tab.
3. Sign up `ui-invitee-${RUN_ID}@familiarise.test` /
   `TestPassword123!`. After signup, the user lands on
   `/form/onboarding` — pick **"Member"** (CONSULTEE), not Org Owner.
4. After onboarding completes, `navigate_page` to the invitation
   accept URL (recover from the email payload in the API response;
   the format is `/invite/{token}` or
   `/dashboard/organization/{wiproOrgId}/invitations/accept?token={token}`
   depending on `app/api/organizations/invitations/accept/route.ts`
   — read that file to confirm the route).
5. `take_snapshot`, `click` "Accept invitation".
6. `wait_for` redirect to `/dashboard/organization/{wiproOrgId}`.
7. `list_network_requests` → assert `POST /api/organizations/invitations/accept`
   returned 200.

### U.2.4 — Verify both sides

- **Invitee tab:** `take_snapshot`, sidebar should match MAINTAINER
  scope (no Settings, has Members + Invitations).
- **Inviter tab:** switch back, `navigate_page` to
  `/dashboard/organization/{wiproOrgId}/members`, confirm the new
  member row appears with role `MAINTAINER` (React Query
  auto-invalidates on the inviter's next mount).
- SQL:

  ```sql
  SELECT m.role, m.status, m."acceptedAt", m."invitationId"
    FROM "Membership" m
   WHERE m."organizationId" = '{wiproOrgId}'
     AND m."userId" = (SELECT id FROM users
                        WHERE email LIKE 'ui-invitee-%' LIMIT 1);
  ```

  Expect `role='MAINTAINER'`, `status='ACTIVE'`,
  `"acceptedAt" IS NOT NULL`. Audit log:

  ```sql
  SELECT action FROM "OrgAuditLog"
   WHERE "organizationId" = '{wiproOrgId}'
     AND action IN ('MEMBER_INVITED', 'INVITATION_ACCEPTED')
   ORDER BY "createdAt" DESC LIMIT 5;
  ```

  Both must appear.

### U.2.5 — Console sanity (both tabs)

`list_console_messages` on each tab — zero errors / warns.

> **Phase U.2 acceptance:** invitation sent + accepted in two tabs,
> membership row materialises with `MEMBER_INVITED` +
> `INVITATION_ACCEPTED` audited, both tabs render the new state
> without manual reload.

---

## PHASE U.3 — Programs (LICENSED_SEAT happy path)

> **Goal:** prove the OWNER can create a `LICENSED_SEAT` program with
> a cycle + per-seat rate + covered sessions cap, then assign it to
> the U.2 invitee.

### U.3.1 — Open the Programs page

`navigate_page` → `/dashboard/organization/{wiproOrgId}/programs`.
`take_snapshot`.

### U.3.2 — Create a LICENSED_SEAT program

1. `click` "New program".
2. `fill_form`:
   - `name`: `UI Test Seat Program`
   - `type`: `LICENSED_SEAT`
   - `ratePerSeatPaise`: `499000` (₹4,990 per seat)
   - `cycle`: `MONTHLY`
   - `coveredSessionsPerCycle`: `4`
   - `overageBehavior`: `BLOCK`
3. `click` "Create".
4. `wait_for` the toast "Program created" + the new row in the table.
5. `list_network_requests` → `POST
   /api/organizations/{wiproOrgId}/programs` returned 201; capture
   `program.id`.

### U.3.3 — Assign the program to the U.2 invitee

1. `click` the row's "Assign" button.
2. `fill_form`:
   - membership: pick the U.2 invitee (`ui-invitee-…`).
   - `periodStart`: today's date.
3. `click` "Assign".
4. `wait_for` toast + table refresh showing 1 active assignment.
5. SQL:

   ```sql
   SELECT pa."programId", pa."membershipId", pa."periodStart",
          p.type, lsc."ratePerSeatPaise", lsc."coveredSessionsPerCycle"
     FROM "ProgramAssignment" pa
     JOIN "Program" p ON p.id = pa."programId"
     JOIN "LicensedSeatConfig" lsc ON lsc."programId" = p.id
    WHERE p."organizationId" = '{wiproOrgId}'
      AND p.name = 'UI Test Seat Program';
   ```

   One row, `type='LICENSED_SEAT'`, `ratePerSeatPaise=499000`,
   `coveredSessionsPerCycle=4`. Audit:

   ```sql
   SELECT action FROM "OrgAuditLog"
    WHERE "organizationId" = '{wiproOrgId}'
      AND action IN ('PROGRAM_CREATED', 'PROGRAM_ASSIGNED')
    ORDER BY "createdAt" DESC LIMIT 5;
   ```

   Both present.

### U.3.4 — Console sanity

`list_console_messages` — zero errors / warns.

> **Phase U.3 acceptance:** LICENSED_SEAT program + assignment
> created via UI, `LicensedSeatConfig` row materialised,
> `PROGRAM_CREATED` + `PROGRAM_ASSIGNED` audited.

---

## PHASE U.4 — Wallet Top-up via Razorpay Popup + Bounded Polling

> **Goal:** prove the wallet top-up dialog opens, the Razorpay popup
> accepts a test card, the bounded polling loop in
> `app/dashboard/organization/[orgId]/credits/page.tsx` flips the
> toast to "Top-up confirmed", and the displayed balance updates
> without a manual refresh. Also exercise the `payment.failed`
> branch.

> **Pre-flight:** swap the seeded Wipro org's funding source to
> `WALLET` so the credits page is reachable. The fastest path is the
> API suite's D.4 step (`PATCH /…/billing-account` with
> `{fundingSource:'WALLET'}`). For this UI run, do that PATCH via
> a one-off `curl` from the shell with `$COOKIE` (the cookie capture
> from shared-setup P.5). Re-snapshot the credits page after.

### U.4.1 — Navigate to the wallet page

1. `navigate_page` → `/dashboard/organization/{wiproOrgId}/credits`.
2. `take_snapshot`. Expect the `StatCard` "Current balance" + a
   "Top up" button in the header.
3. SQL baseline:

   ```sql
   SELECT "walletBalance" FROM "BillingAccount"
    WHERE "organizationId" = '{wiproOrgId}';
   ```

   Record this number.

### U.4.2 — Happy path: top up ₹1,000

1. `click` "Top up".
2. `take_snapshot` of the dialog. Confirm the input has
   `id="credit-amount"` with default `1000`.
3. `fill` `id=credit-amount` with `1000`.
4. `click` "Continue".
5. `wait_for` the Razorpay popup iframe to load (look for the
   `razorpay-checkout-frame` element in the next snapshot).
6. Inside the Razorpay popup, `fill_form` test card:
   - card number: `4111 1111 1111 1111`
   - expiry: `12/30`
   - CVV: `123`
   - OTP (when prompted): `1234`
7. `wait_for` either the success toast "Top-up confirmed" (within
   25 s — the polling window) or the fallback "Awaiting confirmation
   from Razorpay".
8. `list_network_requests` → assert this sequence in order:
   - `POST /api/organizations/{wiproOrgId}/billing-account/wallet/top-ups`
     returned 201 with `{ topUpId, razorpayOrderId, keyId,
     amountPaise:100000, currency:'INR', status:'pending', reused:false }`.
   - `GET /api/organizations/{wiproOrgId}/billing-account/wallet/top-ups/{topUpId}`
     fired 1+ times (the bounded poll), returning 200 with eventually
     `{ topUp: { … }, deltaPaise: 100000 }` — that's the "confirmed"
     flip in the polling-status schema.
9. `list_console_messages` — zero errors. Razorpay's own info logs
   are acceptable.

### U.4.3 — Verify the dashboard re-renders

After the toast, the `StatCard` "Current balance" should now show
₹(baseline + 1000) **without a manual reload** (the
`queryClient.invalidateQueries({ queryKey: ['org-wallet', orgId] })`
in the success handler is the bridge). `take_snapshot` to confirm.
SQL cross-check:

```sql
SELECT "walletBalance" FROM "BillingAccount"
 WHERE "organizationId" = '{wiproOrgId}';

SELECT "deltaPaise", reason, "balanceAfterPaise"
  FROM "FundingLedgerEntry" fle
  JOIN "WalletEntry" we ON we.id = fle."walletEntryId"
 WHERE we."billingAccountId" = (
       SELECT id FROM "BillingAccount" WHERE "organizationId" = '{wiproOrgId}')
 ORDER BY fle."createdAt" DESC LIMIT 1;
```

Expect `walletBalance` increased by `100000`, and the latest
`FundingLedgerEntry` is `+100000 / TOPUP / balanceAfterPaise = new
balance`. Audit log gained both `WALLET_TOPUP` (POST handler) and
`WALLET_TOPUP_CONFIRMED` (webhook handler):

```sql
SELECT action FROM "OrgAuditLog"
 WHERE "organizationId" = '{wiproOrgId}'
   AND action IN ('WALLET_TOPUP', 'WALLET_TOPUP_CONFIRMED')
 ORDER BY "createdAt" DESC LIMIT 5;
```

### U.4.4 — `payment.failed` branch

1. `click` "Top up" again. `fill` `id=credit-amount` with `500`.
   `click` "Continue".
2. In the Razorpay popup, use the **failure card** `5104 0600 0000 0008`
   (Razorpay test catalogue). The popup will fire `payment.failed`.
3. `wait_for` the destructive toast "Payment failed — Your card was
   declined or the payment timed out. Please try again." (verbatim
   from `credits/page.tsx` line 257-263).
4. Confirm:
   - The dashboard balance did **not** change.
   - `list_console_messages` is still clean.
   - `list_network_requests` shows the POST `/top-ups` returned 201
     and there were **no follow-up GETs** to `/top-ups/{topUpId}` (the
     polling loop is gated behind `paid === true` — see the
     `if (!paid) { return { outcome: "not_paid", … } }` branch).

### U.4.5 — Popup dismissal branch

Repeat U.4.4's first two steps, but in the popup, close it with the
× button (no card entered). Same expectations as U.4.4 minus the
toast — the silent-dismiss path leaves the user where they were
without surfacing anything (intentional UX per
`credits/page.tsx` lines 268-271 comment block).

> **Phase U.4 acceptance:** wallet balance updates without a reload
> on success; `payment.failed` toasts but doesn't mutate; dismiss is
> silent; polling fires only on success; both audit actions land.

---

## PHASE U.5 — Invoice Payment via Razorpay Popup + Polling

> **Goal:** prove the Billing page can pay an `ISSUED`
> `OrganizationInvoice` through the Razorpay popup, the `POST
> /…/invoices/{id}/pay` route mints the order, the popup captures,
> the webhook flips status to `PAID`, and the dashboard re-renders
> the new status without a manual refresh.

> **Pre-flight:** create one `ISSUED` invoice on Wipro using the API
> suite's E.4 step via curl (the UI doesn't have an "Issue invoice"
> button today — that's an admin/cron action). Capture `invoiceId`.

### U.5.1 — Navigate to the Billing page

1. `navigate_page` → `/dashboard/organization/{wiproOrgId}/billing`.
2. `take_snapshot`. The invoice from pre-flight should be visible
   with status badge `ISSUED` and a "Pay" button.

### U.5.2 — Happy path: pay the invoice

1. `click` "Pay" on the invoice row.
2. `wait_for` Razorpay popup; complete with the success card from
   U.4.2.
3. `wait_for` the success toast "Invoice paid".
4. `list_network_requests` — assert:
   - `POST /api/organizations/{wiproOrgId}/billing-account/invoices/{invoiceId}/pay`
     returned 200 with `{ razorpayOrderId, keyId, amountPaise,
     currency, invoice: { id, status: 'ISSUED' } }`.
   - The polling GET fired 1+ times until `status === 'PAID'`.
   - The dashboard's invoice list re-fetched (a second `GET
     /…/billing-account/invoices` ran post-toast).
5. Confirm the row's status badge re-renders to `PAID` without a
   manual reload.

### U.5.3 — Audit + ledger checkpoint

```sql
SELECT status, "paidAt", "providerOrderId"
  FROM "OrganizationInvoice" WHERE id = '{invoiceId}';

SELECT kind, "amountPaise" FROM "SettlementLedgerEntry"
 WHERE "invoiceId" = '{invoiceId}'
   AND kind = 'INVOICE_PAID';

SELECT action FROM "OrgAuditLog"
 WHERE "organizationId" = '{wiproOrgId}'
   AND action IN ('INVOICE_PAYMENT_INITIATED', 'INVOICE_PAID')
 ORDER BY "createdAt" DESC LIMIT 5;
```

Expect: invoice `status='PAID'`, `"paidAt"` populated, settlement
row exists, both audit actions present (the `_INITIATED` one came
from the route, `INVOICE_PAID` from the webhook).

### U.5.4 — Console sanity

`list_console_messages` — zero errors / warns.

> **Phase U.5 acceptance:** invoice flips ISSUED → PAID via popup +
> polling without manual refresh; settlement row + both audit
> actions land.

---

## PHASE U.6 — Payouts (Host-side journey)

> **Goal:** prove a HOST org's OWNER can review accumulated earnings,
> request a payout, and see the payout row materialise.

### U.6.1 — Sign in as IIT Madras owner

`navigate_page` → `/auth/signin`; sign in
`founder@iitmadras.test` / `TestPassword123!`. Capture `iitOrgId`.

### U.6.2 — Open Payouts page

`navigate_page` → `/dashboard/organization/{iitOrgId}/payouts`.
`take_snapshot`. Expect the StatCards "Available for payout",
"Pending", and a "Request payout" button.

### U.6.3 — Request a payout

> **Pre-flight check:** the seed must have left at least one
> `OrganizationEarnings` row with status `READY` for IIT Madras. If
> the StatCard reads ₹0, run the API suite's F.3 step (post a
> booking + settle it) before continuing — the UI suite cannot
> manufacture earnings on its own.

1. `click` "Request payout".
2. `fill_form` with the suggested available amount (read it off the
   StatCard).
3. `click` "Submit".
4. `wait_for` the toast + the new payout row (status badge `PENDING`).
5. `list_network_requests` → `POST /api/organizations/{iitOrgId}/payouts`
   returned 201.
6. SQL:

   ```sql
   SELECT id, status, "amountPaise", "createdAt"
     FROM "OrganizationPayout"
    WHERE "organizationId" = '{iitOrgId}'
    ORDER BY "createdAt" DESC LIMIT 1;
   ```

   `status='PENDING'`. Audit:

   ```sql
   SELECT action FROM "OrgAuditLog"
    WHERE "organizationId" = '{iitOrgId}' AND action = 'PAYOUT_INITIATED'
    ORDER BY "createdAt" DESC LIMIT 1;
   ```

   Should appear (the route emits `PAYOUT_INITIATED` on PENDING
   create — confirm against `lib/enterprise/audit-actions.ts`; if
   the route only emits on the APPROVED transition, mark this as a
   `DEFERRED → see API suite §F` and continue).

### U.6.4 — Empty-state fallback

`navigate_page` → `/dashboard/organization/{wiproOrgId}/payouts`
(Wipro is Sponsor-only, no payouts). `take_snapshot`. Expect a
graceful empty state ("No payouts yet" or equivalent) — not a crash,
not a Suspense flash, not a 500.

### U.6.5 — Console sanity

`list_console_messages` — zero errors / warns.

> **Phase U.6 acceptance:** Host owner can request a payout from the
> dashboard; sponsor-only orgs render the empty state; PAYOUT
> audit lands.

---

## PHASE U.7 — Settings: SSO Provider Configuration

> **Goal:** prove the OWNER can configure a SAML SSO provider
> through the UI (the dashboard surface for
> `app/api/organizations/[orgId]/settings/sso/...`) and see the
> derived ACS / metadata URLs populate.

### U.7.1 — Open the SSO settings page

1. Sign in as `founder@learnpro.test` / `TestPassword123!` (Hybrid
   org, full OWNER chrome). Capture `learnproOrgId`.
2. `navigate_page` →
   `/dashboard/organization/{learnproOrgId}/settings/sso`.
3. `take_snapshot`.

### U.7.2 — Add a SAML provider

1. `click` "Add SSO provider".
2. `fill_form`:
   - `providerName`: `LearnPro Okta`
   - `protocol`: `SAML`
   - SAML metadata URL or paste the IdP-provided XML (whichever the
     UI exposes — read `lib/sso/provider-schemas.ts` to confirm the
     accepted body shape).
3. `click` "Save".
4. `wait_for` the toast "SSO provider configured" + the row appears
   in the providers table.
5. `list_network_requests` → `POST
   /api/organizations/{learnproOrgId}/settings/sso/providers` returned
   201 (confirm path against the actual route file under
   `app/api/organizations/[orgId]/settings/sso/`).
6. Confirm the response includes derived `acsUrl` and `metadataUrl`
   (from `lib/sso/derive-urls.ts`).
7. SQL:

   ```sql
   SELECT id, "providerName", protocol
     FROM "SsoProvider"
    WHERE "organizationId" = '{learnproOrgId}'
    ORDER BY "createdAt" DESC LIMIT 1;
   ```

   One row matching the wizard input. Audit:

   ```sql
   SELECT action FROM "OrgAuditLog"
    WHERE "organizationId" = '{learnproOrgId}'
      AND action = 'SSO_PROVIDER_CONFIGURED'
    ORDER BY "createdAt" DESC LIMIT 1;
   ```

### U.7.3 — Console sanity

`list_console_messages` — zero errors / warns.

> **Phase U.7 acceptance:** OWNER can configure an SSO provider end
> to end through the dashboard; ACS/metadata URLs render; audit
> lands.

---

## PHASE U.8 — RBAC Visibility (LEARNER chrome)

> **Goal:** prove that a `LEARNER` membership sees a stripped-down
> dashboard chrome — no Top-up, no Settings, no Payouts — and that
> the API gates also hold (defence in depth: even if they navigated
> directly to the URL, they get a 403 page, not a crash).

### U.8.1 — Provision a LEARNER

Use SQL to flip the U.2 invitee's role to `LEARNER` for Wipro:

```sql
UPDATE "Membership"
   SET role = 'LEARNER'
 WHERE "organizationId" = '{wiproOrgId}'
   AND "userId" = (SELECT id FROM users WHERE email LIKE 'ui-invitee-%' LIMIT 1);
```

### U.8.2 — Sign in as the LEARNER

`navigate_page` → `/auth/signout`, then `/auth/signin`, log in as
`ui-invitee-${RUN_ID}@familiarise.test` / `TestPassword123!`.

### U.8.3 — Confirm the chrome is stripped

1. `navigate_page` → `/dashboard/organization/{wiproOrgId}`.
2. `take_snapshot`. The sidebar should show **only** the Home (and
   maybe a Help / Profile entry). NO: Members, Programs, Contracts,
   Billing, Payouts, Analytics, Settings. The `useRequireOrgAccess`
   hook + the layout chrome filter handle this; if any admin entry
   is visible, that's a bug — file it and patch the chrome filter
   in `app/dashboard/organization/[orgId]/layout.tsx`.

### U.8.4 — Confirm direct URL navigation is blocked

1. `navigate_page` → `/dashboard/organization/{wiproOrgId}/credits`.
2. `take_snapshot`. Expect a "You don't have access" empty state or
   a redirect to the home page — not a JS error, not a blank page.
3. `list_network_requests` → if any `/wallet/...` call fired, it
   returned 403.
4. `list_console_messages` — zero errors.

> **Phase U.8 acceptance:** LEARNER cannot see admin chrome, cannot
> reach admin routes via direct URL; failure is graceful.

---

## WRAP-UP — UI ACCEPTANCE MATRIX

Per phase, render the following table in the report:

| Phase | Sub-step | Expected | Observed | Pass/Fail | Bug fixed? (commit) |
|-------|----------|----------|----------|-----------|---------------------|
| U.1   | …        | …        | …        | ✓ / ✗     | (sha if applicable) |
| …     | …        | …        | …        | …         | …                   |

Plus:

1. **Console-cleanliness summary** — total errors/warns across all
   phases (target: 0). List any allowed Razorpay info logs separately.
2. **Network-burst summary** — total requests fired, count of 4xx
   (must equal the count expected by guard-rail sub-steps), count of
   5xx (must be zero).
3. **Cross-suite ledger reconciliation** — re-run the API suite's
   J.1 / J.5 SQL queries verbatim. The UI suite's mutations must net
   into the same ledger invariants the API suite asserts.
4. **Bugs fixed** — every defect found + the source patch + the
   replay sub-step, per Critical Rule #1 (in shared-setup).

---

## REFERENCES

The full code-pointer index lives in
[`e2e-enterprise-shared-setup.md` § REFERENCES](./e2e-enterprise-shared-setup.md#references-read-once-if-stuck).

Plus UI-specific files this suite drives:

- `app/auth/signup/page.tsx` — signup form, post-signup redirect
  rules, SSO-required short-circuit.
- `app/form/onboarding/page.tsx` — role picker + the
  `CreateOrganizationWizard` mount.
- `components/organization/create-wizard/Wizard.tsx` and
  `BrandingStep.tsx` (colour-only today; no logo/banner upload UI
  yet).
- `app/dashboard/organization/[orgId]/credits/page.tsx` — wallet
  top-up dialog, Razorpay popup wiring, bounded polling
  (`pollTopUpUntilConfirmed`), success/pending/not_paid toasts.
- `app/dashboard/organization/[orgId]/billing/BillingPageClient.tsx`
  — invoice list + pay-button + Razorpay wiring.
- `app/dashboard/organization/[orgId]/payouts/page.tsx` — earnings
  StatCards + payout request flow + empty-state.
- `app/dashboard/organization/[orgId]/layout.tsx` — sidebar chrome
  + role-aware navigation filter (the LEARNER U.8 check exercises
  this).
- `app/dashboard/organization/[orgId]/useOrgRole.ts` —
  `useRequireOrgAccess` gate hook used by every dashboard page.

---

**Drive every journey. Snapshot before every click. Fix on sight.
Verify in SQL at every phase boundary. Report the matrix.**
