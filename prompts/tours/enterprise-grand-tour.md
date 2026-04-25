# Enterprise (Architecture-4) Grand Tour

> **Read first:** [`prompts/enterprise-tests/e2e-enterprise-shared-setup.md`](../enterprise-tests/e2e-enterprise-shared-setup.md)
> for the glossary (capability, role, funding source, program type),
> the schema reference, and the audit-action cheat sheet. This tour
> assumes you've read it. Tests live next to it; this file is the
> tour, not a test.
>
> **Generated from:** `prompts/tour-prompt-template.md` (template v1).

---

## Mode of operation

This is a **tour-guide walkthrough**, not a test suite. The agent acts
as a museum docent: paused at every stop, explaining what we're about
to do and why it matters, offering you the choice between automation
and manual driving, fixing bugs in flight when we encounter them, and
re-testing failed scenarios before continuing. The goal is for someone
new to the codebase to walk away having visited every nook and corner
of the enterprise subsystem.

The exhaustive 4xx-coverage and snapshot-stability work lives in the
sibling test suites (`e2e-enterprise-agent-001-arch4-modified-api.md`
and `e2e-enterprise-agent-002-arch4-modified-ui.md`). This tour
deliberately touches every happy path and a few representative guard
paths; it is NOT trying to enumerate every error code.

---

## MCP toolkit

**Permitted tools.**

| Tool | Use |
|---|---|
| `mcp__chrome-devtools__navigate_page` | Open a URL |
| `mcp__chrome-devtools__take_snapshot` | Get the accessibility tree of the current page |
| `mcp__chrome-devtools__click` | Click a labeled element |
| `mcp__chrome-devtools__fill` | Type into a single input |
| `mcp__chrome-devtools__fill_form` | Fill multiple inputs at once |
| `mcp__chrome-devtools__select_option` (where supported) or `mcp__chrome-devtools__click` on combobox items | Pick a dropdown value |
| `mcp__chrome-devtools__wait_for` | Wait for a piece of text or element to appear |
| `mcp__chrome-devtools__upload_file` | Pick a file in a `<input type=file>` |
| `mcp__chrome-devtools__handle_dialog` | Accept / dismiss confirm + alert dialogs |
| `mcp__chrome-devtools__list_network_requests` | Inspect what the page fired |
| `mcp__chrome-devtools__get_network_request` | Get headers + body of a specific request |
| `mcp__chrome-devtools__list_console_messages` | Inspect what the page logged |
| `mcp__chrome-devtools__take_screenshot` | Visual checkpoint |
| `mcp__chrome-devtools__new_page` / `select_page` / `list_pages` | Multi-tab journeys (e.g. invitation accept) |
| `mcp__supabase__execute_sql` | All DB reads, scoped writes (project `pzmbxqdgibfkhjwzeprf`) |
| `mcp__supabase__list_tables` | Schema discovery (rare; only if a column name surprises us) |
| `mcp__supabase__get_logs` | Inspect Supabase logs when a query unexpectedly errors |

**Prohibited tools.**

| Tool | Why |
|---|---|
| `mcp__chrome-devtools__evaluate_script` | Cheating. Defeats the purpose of a real-user tour. If a step requires arbitrary JS to complete, that's a UX bug — file it and stop. |

---

## Standing rules

These five rules apply to every stop. The agent must internalize them.

### 1. Pause at every T.x boundary
Each tour stop is numbered T.1, T.2, … At the start of every stop the
agent narrates: (a) what we're about to do, (b) why it matters in the
context of the enterprise subsystem, (c) what to watch for in the
snapshot or the database. Then the agent waits for one of these
explicit replies:

- `next` — proceed with this stop's actions
- `rewind` — re-narrate the previous stop (no DB changes)
- `skip` — mark this stop as skipped, continue to the next
- `stop` — exit the tour, leaving in-flight tour data in place

### 2. Two-flavor offer at every interactive step
Before any UI input or DB mutation, the agent offers TWO ways to
proceed and waits for the user to pick one:

- `auto` — agent drives via Chrome DevTools MCP, narrating each call
- `manual` — user drives in their own browser tab; agent narrates
  expected behavior and waits for `done`

Both flavors end at the same observable state, verified via Supabase
MCP `execute_sql` against `pzmbxqdgibfkhjwzeprf`.

### 3. Bug-fix in flight
On unexpected outcome (500, console error, DB row that disagrees with
the UI), the agent:

1. Reads `list_console_messages` + `list_network_requests`.
2. Opens the relevant source file.
3. Proposes a one-paragraph fix with `path:line-range`.
4. Asks `fix it` (apply now), `note it` (log to follow-up), or
   `skip` (move on without logging).
5. If `fix it`, applies the fix → Rule #4.

Never accumulate a bug list. Decide each one in the moment.

### 4. Re-test on fail
After any in-flight fix, re-run the failed scenario from the closest
stable navigation point. Confirm green before declaring the stop
complete and pausing for `next`.

### 5. Mock-data scope
All tour-created records use the slug / name prefix
`tour-2026-04-25-` so they are trivially identifiable and deletable
at the end. The tour MUST NOT modify any record that doesn't carry
this prefix.

Exception: the agent MAY read non-prefixed records (e.g. seed cohort)
for orientation. Writes to non-prefixed records require the user to
type `override scope <description>`.

---

## Coverage matrix

This tour visits every nook and corner of the Architecture-4 enterprise
subsystem. Cells marked **v2** are observed (the API rejects them with
a clean 400) but not exercised end-to-end.

### Capability shapes (`Organization.canSponsor` × `canHost`)

| Shape | canSponsor | canHost | Stop |
|---|---|---|---|
| Sponsor (BUYER) | true | false | T.2 |
| Host (PROVIDER) | false | true | T.4 |
| Hybrid | true | true | T.3 |
| Invalid | false | false | T.2 (rejected at create) |

### Funding × Program matrix (`BillingAccount.fundingSource` × `Program.type`)

| ↓ Funding / → Program | LICENSED_SEAT | CREDIT_POOL | PROJECT | RETAINER |
|---|---|---|---|---|
| **PERSONAL** | n/a (T.5) | n/a | n/a | n/a |
| **WALLET** | T.6 | T.7 | v2 (T.10) | v2 (T.10) |
| **INVOICE** | T.8 | (atypical, skipped) | v2 (T.10) | v2 (T.10) |
| **LICENSE** | T.9 (`coveredSessionsPerCycle=null`) | (atypical, skipped) | v2 | v2 |
| **PROJECT** | v2 (T.10) | v2 | v2 | v2 |

### Role lenses (`MemberRole`)

| Role | Stop | What we tour |
|---|---|---|
| OWNER | T.11 | Full chrome — billing, contracts, payouts, branding |
| MAINTAINER | T.12 | Admin minus org delete + final budget moves |
| MANAGER | T.13 | Department-level — programs, members |
| EXPERT | T.14 | Delivers services — earnings, payouts (own) |
| LEARNER | T.15 | Consumes — most restrictive chrome |
| SUPPORT | T.16 | Read-only, non-billing |

### Cross-cutting integrations

| Integration | Stop |
|---|---|
| Audit log viewer + CSV export | T.17 |
| Domain DNS verification + signin gate | T.18 |
| SSO provider config + cert expiry | T.19 |
| Invoice lifecycle + PDF cache | T.20 |
| Wallet top-up + Razorpay popup | T.21 |
| Payout request + 3-way split | T.22 |
| Anti-lockout guards (3 vectors) | T.23 |
| OrgContextFilter (Personal / Org / All) | T.24 |
| Novu org-lifecycle workflows (9 events) | T.25 |
| Reconcile cron (5 checks incl. session drift) | T.26 - T.27 |

---

## Pre-flight

Run each command. If any fail, fix before starting T.1.

```bash
# 1. Dev server up at localhost:3000
curl -sf http://localhost:3000/api/health
# expected: 200 OK with { "status": "ok" } (or similar)

# 2. Prisma client generated for the current schema
npx prisma generate

# 3. Schema validates
npx prisma validate

# 4. Seed cohort present (don't reseed; just confirm)
# Run via Supabase MCP execute_sql against pzmbxqdgibfkhjwzeprf:
#   SELECT slug FROM "organizations"
#   WHERE slug IN ('wipro', 'iit-madras', 'learnpro-agency')
#   ORDER BY slug;
# expected: 3 rows (the dedicated cohort plus Rahul's solo org).
```

If the seed cohort is missing, you're working against an unseeded DB.
The tour will still run (it creates its own data) but the orientation
stops in Chapter 1 lose their reference points. Consider running
`npm run db:seed` first.

The tour does NOT auto-reset the DB. Your in-progress dev work is
safe.

---

# Chapter 1 — The three capability axes

The first thing to understand about the enterprise layer is that an
organization isn't a "type" — it's a pair of booleans that together
express what the org can do. Pre-Arch-4 we had a frozen
`OrganizationKind` enum (BUYER / PROVIDER / HYBRID); Arch-4 swapped it
for `canSponsor` + `canHost`, two booleans on `Organization`. Every
capability in the system grows from this pair.

This chapter visits the four logical combinations (one of which is
invalid) and shows how the dashboard chrome adapts.

---

### T.1 — Orientation: what's already in the seed cohort

**What we're about to do.** Read the seed cohort via Supabase MCP and
render a small table of the existing orgs with their capability
booleans. No writes; no UI. We're just orienting before we start
creating tour data.

**Why it matters.** The seed cohort is your reference for what each
shape *should* look like in the dashboard later. Wipro is a pure
sponsor; LearnPro is a hybrid; IIT Madras is a hybrid (HOST + WALLET);
Rahul's personal org is a host. When we create the tour orgs, we'll
mirror these shapes with `tour-2026-04-25-*` slugs.

**Coverage.** None — orientation only.

**Drive.**

> Pick one:
> - `auto` — I'll run the SQL via `mcp__supabase__execute_sql` and
>   render the result as a table.
> - `manual` — Open the Supabase project (`pzmbxqdgibfkhjwzeprf`) in
>   your browser, run the SQL below in the SQL editor, paste the
>   result back. Type `done` when ready.

**Verify.** Run this query and confirm 3-4 rows:

```sql
SELECT
  slug,
  name,
  "canSponsor",
  "canHost",
  CASE
    WHEN "canSponsor" AND "canHost" THEN 'Hybrid'
    WHEN "canSponsor" THEN 'Sponsor (BUYER)'
    WHEN "canHost"    THEN 'Host (PROVIDER)'
    ELSE 'Invalid'
  END AS shape,
  status
FROM "organizations"
WHERE slug IN ('wipro', 'iit-madras', 'learnpro-agency')
   OR slug LIKE '%rahul%'
ORDER BY slug;
```

**Watch for.** Wipro should be the only Sponsor-only row; the others
should be Hybrid or Host. If you see a row with both booleans false,
that's a data bug — flag it and `fix it`.

---

### T.2 — Create our first tour org as a BUYER

**What we're about to do.** Walk the org-creation wizard at
`/dashboard/org-admin/onboarding` and create a Sponsor-only org named
`tour-2026-04-25-acme`. We'll watch the wizard's three-step funnel
(role → org details → capability) and confirm the resulting row in
`organizations` carries `canSponsor=true, canHost=false`.

**Why it matters.** This is the canonical SPONSOR shape. A company
that pays for its employees' consults but doesn't deliver any.
Everything in Chapter 2 (funding × program matrix) builds on top of
this shape.

**Coverage.** Capability shape "Sponsor (BUYER)" → permutation #1 in
the matrix.

**Drive.**

> Pick one:
> - `auto` — I'll
>   `mcp__chrome-devtools__navigate_page("http://localhost:3000/dashboard/org-admin/onboarding")`,
>   take a snapshot, then `fill_form` for each wizard step. I'll
>   pause after each step's submit so you can watch the dashboard
>   update.
> - `manual` — Open
>   <http://localhost:3000/dashboard/org-admin/onboarding> in a fresh
>   browser tab. Pick role "Org admin", fill org name = "Tour Acme"
>   slug = "tour-2026-04-25-acme", capability = "Sponsor only".
>   Submit. Type `done` when the dashboard loads.

**Verify.**

```sql
SELECT id, slug, name, "canSponsor", "canHost", status
FROM "organizations"
WHERE slug = 'tour-2026-04-25-acme';
```

Expect exactly one row, `canSponsor=t`, `canHost=f`, `status='ACTIVE'`.

Also confirm the OWNER membership was created automatically:

```sql
SELECT m.role, m.status, u.email
FROM "Membership" m
JOIN "User" u ON u.id = m."userId"
WHERE m."organizationId" = (
  SELECT id FROM "organizations" WHERE slug = 'tour-2026-04-25-acme'
);
```

Expect one row, `role='OWNER'`, `status='ACTIVE'`, email = your
session user.

**Watch for.** The wizard should reject the "neither" capability
combination at the schema layer (try toggling both off in `auto` mode
and observe the 400). The dashboard hero should now show a "Sponsor"
badge — that label resolves through `lib/labels/org-labels.ts`.

---

### T.3 — Flip canHost on Acme → Hybrid

**What we're about to do.** Toggle `canHost = true` on
`tour-2026-04-25-acme` via the org settings page. Observe how the
dashboard chrome changes — a new "Hosting" section appears, the
capability badge changes from "Sponsor" to "Hybrid", and the sidebar
gains an "Experts" tab.

**Why it matters.** Capability flips are not destructive — an org can
add hosting later without losing its sponsor billing setup. This is
the seam that justified the Arch-4 rewrite (the old enum couldn't
express "added a capability mid-flight").

**Coverage.** Capability shape "Hybrid" → permutation #2 in the
matrix.

**Drive.**

> Pick one:
> - `auto` — Navigate to
>   `/dashboard/organization/<acmeId>/settings`, click the "Capability"
>   section, toggle "Can host experts" on, save. Wait for the success
>   toast.
> - `manual` — Same path; type `done` after saving.

**Verify.**

```sql
SELECT slug, "canSponsor", "canHost"
FROM "organizations"
WHERE slug = 'tour-2026-04-25-acme';
```

Expect `canSponsor=t, canHost=t`.

```sql
SELECT category, action, description
FROM "OrgAuditLog"
WHERE "organizationId" = (
  SELECT id FROM "organizations" WHERE slug = 'tour-2026-04-25-acme'
)
ORDER BY "createdAt" DESC LIMIT 3;
```

Expect a recent `SETTINGS` / `CAPABILITY_UPDATED` row (or similar —
check `lib/enterprise/audit-actions.ts` for the exact constant).

**Watch for.** The sidebar should re-render without a full page
reload (the layout reads from `useOrgRole`). The "Hosting" section in
settings should now expose payout-account fields.

---

### T.4 — Create a HOST-only org

**What we're about to do.** Create `tour-2026-04-25-mentora` with
`canHost=true, canSponsor=false`. Observe that this org has NO
billing-account section in its dashboard — host-only orgs don't need
a `BillingAccount` because they never pay; they only earn.

**Why it matters.** This is the PROVIDER shape (e.g. an agency
supplying experts to the platform). The absence of the billing tab
is itself a feature: the chrome adapts to the capability, hiding
sections that would have been confusing-empty.

**Coverage.** Capability shape "Host (PROVIDER)" → permutation #3.

**Drive.**

> Pick one:
> - `auto` — Wizard run with capability = "Host only".
> - `manual` — Same wizard.

**Verify.**

```sql
SELECT
  o.slug,
  o."canSponsor",
  o."canHost",
  ba.id IS NOT NULL AS has_billing_account
FROM "organizations" o
LEFT JOIN "BillingAccount" ba ON ba."ownerOrgId" = o.id
WHERE o.slug = 'tour-2026-04-25-mentora';
```

Expect `canSponsor=f, canHost=t, has_billing_account=f`.

**Watch for.** In the dashboard for Mentora, the left sidebar should
omit "Billing", "Wallet", "Invoices". The "Payouts" section IS
present (host-only orgs need to receive money even though they don't
send any). This is governed by the capability gates in
`lib/labels/org-labels.ts` and the layout in
`app/dashboard/organization/[orgId]/layout.tsx`.

---

# Chapter 2 — Funding × Program matrix

Now that we have the capability shapes, the next axis is *how money
moves*. `BillingAccount.fundingSource` answers that question (5
values, one v2-reserved). On top of funding, `Program.type` answers
*what's covered per person* (4 values, two v2-reserved). The
combinations are not all equally useful; this chapter walks every
cell that ships in v1.

The matrix is in the Coverage Matrix above. The seed cohort already
demonstrates 3 of the 4 v1 cells; the tour creates fresh orgs so we
can inspect each in isolation.

---

### T.5 — PERSONAL funding (no program)

**What we're about to do.** Create `tour-2026-04-25-personal` as a
SPONSOR with `fundingSource=PERSONAL`. Observe that no contract is
required and no program is created. Members will eventually pay for
their own sessions; the org is attribution-only.

**Why it matters.** PERSONAL is the "lightweight org" model — handy
for free trials, design partners, and any cohort where the sponsor
doesn't actually want to pay. The `Payment.organizationId` tag still
flows through so analytics can segment.

**Coverage.** `FundingSource.PERSONAL`.

**Drive.**

> Pick one:
> - `auto` — Wizard with funding = "PERSONAL (members pay their own card)".
> - `manual` — Same.

**Verify.**

```sql
SELECT
  o.slug,
  ba."fundingSource",
  ba."walletBalance",
  ba."creditLimit"
FROM "organizations" o
LEFT JOIN "BillingAccount" ba ON ba."ownerOrgId" = o.id
WHERE o.slug = 'tour-2026-04-25-personal';
```

Expect `fundingSource='PERSONAL'`, `walletBalance=NULL`,
`creditLimit=NULL`.

Confirm no programs or contracts exist:

```sql
SELECT COUNT(*) FROM "Contract" c
WHERE c."organizationId" = (SELECT id FROM "organizations" WHERE slug = 'tour-2026-04-25-personal');
```

Expect `0`.

**Watch for.** The dashboard "Programs" section should be empty with
a friendly empty state. The "Wallet" section should be hidden.

---

### T.6 — WALLET funding + LICENSED_SEAT program

**What we're about to do.** Create `tour-2026-04-25-wallet-seat` as a
SPONSOR with `fundingSource=WALLET`. Then create a `Contract`, attach
a `LICENSED_SEAT` Program with `coveredSessionsPerCycle=10` per month
and `overageBehavior=BLOCK`. We'll skip the actual top-up here (T.21
walks the Razorpay flow); we just want the schema rows in place.

**Why it matters.** This is the most common enterprise shape — the
employer pre-loads cash, the employees get N sessions per cycle, and
overage either blocks or charges the org.

**Coverage.** `FundingSource.WALLET` × `ProgramType.LICENSED_SEAT`.

**Drive.**

> Pick one:
> - `auto` — Wizard for WALLET, then `mcp__chrome-devtools__navigate_page`
>   to the contract page, click "New contract", fill rate +
>   payment terms, save. Then "New program" → LICENSED_SEAT.
> - `manual` — Same path.

**Verify.**

```sql
SELECT
  o.slug,
  c.id AS contract_id,
  p.type,
  lsc."coveredSessionsPerCycle",
  lsc."overageBehavior",
  lsc."ratePerSeatPaise"
FROM "organizations" o
JOIN "Contract" c ON c."organizationId" = o.id
LEFT JOIN "Program" p ON p."contractId" = c.id
LEFT JOIN "LicensedSeatConfig" lsc ON lsc."programId" = p.id
WHERE o.slug = 'tour-2026-04-25-wallet-seat';
```

Expect one row with `type='LICENSED_SEAT'`,
`coveredSessionsPerCycle=10`, `overageBehavior='BLOCK'`.

**Watch for.** The dashboard's Programs page should render the new
program with a status pill (`ACTIVE`) and a per-cycle cap pill (`10
sessions / month · BLOCK overage`). If the cap pill says
"unlimited", check that you didn't accidentally leave the field
blank — `null` means unlimited (which we'll do in T.9).

---

### T.7 — WALLET funding + CREDIT_POOL program (1 credit = ₹1)

**What we're about to do.** Create `tour-2026-04-25-wallet-pool` as
SPONSOR + WALLET. Add a Contract + a `CREDIT_POOL` Program with
`creditsPerCycle=1000`, `cycle=MONTHLY`. Confirm the schema
simplification: there's no `creditValuePaise` field anymore (1
credit = ₹1 fixed) and no `premiumMultiplier`.

**Why it matters.** CREDIT_POOL was simplified post-Arch-4 (see commit
`9d33c652`). The dormant denomination layer was dropped because it
added a translation step at debit time without enabling any feature
the rate-card couldn't already express. Finance dashboards now read
in ₹ end-to-end.

**Coverage.** `FundingSource.WALLET` × `ProgramType.CREDIT_POOL`.

**Drive.**

> Pick one:
> - `auto` — Wizard, contract, then "New program" → CREDIT_POOL,
>   credits per cycle = 1000, cycle = MONTHLY.
> - `manual` — Same.

**Verify.**

```sql
SELECT
  p.type,
  cpc.cycle,
  cpc."creditsPerCycle",
  cpc."minimumCreditsPerPeriod"
FROM "Program" p
JOIN "CreditPoolConfig" cpc ON cpc."programId" = p.id
WHERE p."contractId" IN (
  SELECT c.id FROM "Contract" c
  JOIN "organizations" o ON o.id = c."organizationId"
  WHERE o.slug = 'tour-2026-04-25-wallet-pool'
);
```

Expect `cycle='MONTHLY'`, `creditsPerCycle=1000`,
`minimumCreditsPerPeriod=NULL`.

Schema sanity check:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'CreditPoolConfig' ORDER BY ordinal_position;
```

Expect: `programId`, `cycle`, `creditsPerCycle`,
`minimumCreditsPerPeriod`. Specifically, `creditValuePaise` and
`premiumMultiplier` should NOT appear.

**Watch for.** The Programs page UI label should show "1000 credits
/ monthly" (not "₹1000 / monthly" — the unit is credits even though
1 credit = ₹1 by spec). See `app/dashboard/organization/[orgId]/programs/page.tsx`
line ~660 for the formatting helper.

---

### T.8 — INVOICE funding + LICENSED_SEAT program

**What we're about to do.** Create `tour-2026-04-25-invoice-seat`
with `fundingSource=INVOICE`, `creditLimit=500000` (₹5000), and a
LICENSED_SEAT Program. We'll skip the actual booking-and-accrual
flow here (it requires a learner + a consultant + an availability
slot). Instead we'll just observe the schema rows and confirm the
dashboard shows "INVOICE — billed monthly" in the funding label.

**Why it matters.** INVOICE is the postpaid mode — sessions accrue,
a roll-up `OrganizationInvoice` gets cut at month-end. The
`creditLimit` caps outstanding accrual so a bad actor can't run up
an unlimited bill. T.20 walks the invoice lifecycle in detail.

**Coverage.** `FundingSource.INVOICE` × `ProgramType.LICENSED_SEAT`.

**Drive.**

> Pick one:
> - `auto` — Wizard with funding = "INVOICE (billed monthly)",
>   credit limit = 5000 (rupees). Then contract + program.
> - `manual` — Same.

**Verify.**

```sql
SELECT
  o.slug,
  ba."fundingSource",
  ba."walletBalance",
  ba."creditLimit"
FROM "organizations" o
JOIN "BillingAccount" ba ON ba."ownerOrgId" = o.id
WHERE o.slug = 'tour-2026-04-25-invoice-seat';
```

Expect `fundingSource='INVOICE'`, `walletBalance=NULL`,
`creditLimit=500000` (paise).

**Watch for.** Issue #687 (invoice-fraud threat model) recommends
defaulting `creditLimit` to ₹50,000 for new INVOICE orgs to bound
shell-org risk. As of this tour the default is `null` (unlimited);
the recommended default is tracked but not yet enforced.

---

### T.9 — LICENSE funding + LICENSED_SEAT (`coveredSessionsPerCycle=null`)

**What we're about to do.** Create `tour-2026-04-25-license` with
`fundingSource=LICENSE`. Add a Contract + a LICENSED_SEAT Program
with `coveredSessionsPerCycle=NULL` (the unmetered mode). Observe
that the DB stores the `null` cap correctly and that bookings (in
T.20+) will produce a `PaymentLeg` with `source=LICENSE,
amountPaise=0` — a marker, not a real money entry.

**Why it matters.** LICENSE is the "flat enterprise contract" mode.
The org pays a lump sum offline; the platform's job is to track
usage but not bill per booking. The `coveredSessionsPerCycle=null`
convention replaces the pre-Arch-4 `OrgBillingMode.PREPAID_UNLIMITED`
enum value with a much simpler shape.

**Coverage.** `FundingSource.LICENSE` × `ProgramType.LICENSED_SEAT`
(unmetered).

**Drive.**

> Pick one:
> - `auto` — Wizard, funding = "LICENSE (flat fee)", then
>   contract + program with the "Unmetered (no cap)" toggle on.
> - `manual` — Same.

**Verify.**

```sql
SELECT
  ba."fundingSource",
  lsc."coveredSessionsPerCycle"
FROM "organizations" o
JOIN "BillingAccount" ba ON ba."ownerOrgId" = o.id
JOIN "Contract" c ON c."organizationId" = o.id
JOIN "Program" p ON p."contractId" = c.id
JOIN "LicensedSeatConfig" lsc ON lsc."programId" = p.id
WHERE o.slug = 'tour-2026-04-25-license';
```

Expect `fundingSource='LICENSE'`, `coveredSessionsPerCycle=NULL`.

**Watch for.** The Programs page should display "Unlimited sessions"
where the cap pill normally shows a number. The PaymentLeg with
`amountPaise=0` is intentional — see
`docs/enterprise/20-payment-legs.md` and the schema comment in
`prisma/schema.prisma` at the PaymentLeg model.

---

### T.10 — Observe PROJECT and RETAINER as v2-reserved

**What we're about to do.** Try to create a Program with
`type='PROJECT'` via `mcp__chrome-devtools__fill_form` (or
`curl -X POST` if you prefer manual). Confirm the API returns 400
with a specific message that PROJECT is v2-reserved. Same for
RETAINER. We don't actually want to wire these up — we want to
confirm the rejection works.

**Why it matters.** Schema-reserved enum values must round-trip
without 500 errors. If a future client sends a PROJECT body, we want
a helpful 400, not a Prisma validation crash. This is the kind of
soft-failure surface that's easy to miss until a customer trips it.

**Coverage.** `ProgramType.PROJECT` (v2 observed),
`ProgramType.RETAINER` (v2 observed).

**Drive.**

> Pick one:
> - `auto` — Use `mcp__chrome-devtools__navigate_page` to the
>   programs page of one of our tour orgs, open the dropdown, observe
>   PROJECT + RETAINER options are greyed out (label says "v2
>   reserved"). Then fire a raw POST via `curl` (or via the network
>   panel's "replay" if available) with `type='PROJECT'`.
> - `manual` — Curl from your shell:
>   ```bash
>   curl -i -X POST http://localhost:3000/api/organizations/<orgId>/programs \
>     -H 'Content-Type: application/json' \
>     -b "<your session cookie>" \
>     -d '{"type":"PROJECT","contractId":"<contractId>","name":"x"}'
>   ```
>   Expect 400.

**Verify.**

```sql
SELECT COUNT(*) FROM "Program"
WHERE type IN ('PROJECT', 'RETAINER');
```

Expect `0` (no v2 programs in the tour DB; the seed may have some
demo rows but the tour orgs should be clean).

**Watch for.** The 400 response body should include
`code: "PROJECT_NOT_SUPPORTED"` or similar (check
`app/api/organizations/[orgId]/programs/route.ts`'s discriminated
union).

---

# Chapter 3 — The six role lenses

The enterprise layer has 6 `MemberRole` values. The dashboard chrome
adapts to each: a LEARNER sees almost nothing in the org admin
section; an OWNER sees everything; a SUPPORT role can read but can't
write. This chapter creates one tour user per role and tours the
dashboard from each lens.

We'll add all 6 users as members of `tour-2026-04-25-acme` (the
Hybrid org from T.3). Each user is created via Supabase MCP with a
predictable email pattern: `tour-2026-04-25-<role>@example.com`.

---

### T.11 — OWNER lens

**What we're about to do.** The user who created Acme is already its
OWNER (T.2). We'll log out, log back in as that same user, and tour
every section of the org dashboard. Pay attention to which sidebar
entries appear, which buttons are enabled, and which destructive
actions are gated.

**Why it matters.** The OWNER lens is the maximum chrome — every
later role lens is "OWNER minus restrictions". You need to remember
this baseline.

**Coverage.** `MemberRole.OWNER`.

**Drive.**

> Pick one:
> - `auto` — Logout via `/api/auth/sign-out`, then login flow with
>   the OWNER credentials. Then `take_snapshot` of the sidebar.
> - `manual` — Sign out, sign back in, type `done`.

**Verify.**

```sql
SELECT role, status FROM "Membership"
WHERE "organizationId" = (SELECT id FROM "organizations" WHERE slug = 'tour-2026-04-25-acme')
  AND "userId" = (SELECT id FROM "User" WHERE email = '<your email>');
```

Expect `role='OWNER'`, `status='ACTIVE'`.

**Watch for.** The sidebar should include: Members, Invitations,
Contracts, Programs, Billing, Wallet, Invoices, Payouts (Hybrid
only), Settings, Audit. The Settings page should expose the
"Delete organization" button (gated behind a confirmation).

---

### T.12 — MAINTAINER lens

**What we're about to do.** Create a MAINTAINER user via Supabase
MCP (insert into `User` + `Membership`), then sign in as that user
and tour the dashboard. MAINTAINER ≈ admin — can do almost
everything except delete the org and finalize budget moves.

**Why it matters.** MAINTAINER is the role we assign to engineering /
ops staff at the customer site. They run the org day-to-day; the
OWNER (typically an exec) only signs off on contract-level changes.

**Coverage.** `MemberRole.MAINTAINER`.

**Drive.**

> Pick one:
> - `auto` — Run two SQL inserts (User, Membership), then sign in
>   via `/api/auth/sign-in/email` (BetterAuth) with the password
>   we set. Tour the sidebar.
> - `manual` — Same SQL, then sign in.

**Verify.**

```sql
INSERT INTO "User" (id, email, name, role, "emailVerified", "createdAt", "updatedAt")
VALUES (gen_random_uuid()::text, 'tour-2026-04-25-maintainer@example.com',
        'Tour Maintainer', 'CONSULTEE', true, now(), now())
ON CONFLICT (email) DO NOTHING;

INSERT INTO "Membership" (id, "organizationId", "userId", role, status, "createdAt", "updatedAt")
SELECT gen_random_uuid()::text,
       (SELECT id FROM "organizations" WHERE slug = 'tour-2026-04-25-acme'),
       (SELECT id FROM "User" WHERE email = 'tour-2026-04-25-maintainer@example.com'),
       'MAINTAINER', 'ACTIVE', now(), now()
ON CONFLICT DO NOTHING;
```

(The user's password is set via BetterAuth's signup flow; for the
tour, set a known temp password via the BetterAuth admin or via a
direct insert into the BetterAuth account table — check
`docs/enterprise/sso-testing-guide.md` for the exact pattern.)

**Watch for.** MAINTAINER should NOT see "Delete organization" in
Settings. They CAN demote/promote other members but they CAN'T
demote the OWNER. They can issue invoices but can't sign contracts.

---

### T.13 — MANAGER lens

**What we're about to do.** Same as T.12 but with `role='MANAGER'`.
Tour the chrome — MANAGER is department-level, can manage members
and programs but not billing or contracts.

**Why it matters.** MANAGER is the role for L&D heads inside the
org — they curate which programs apply to which members but don't
touch the money side.

**Coverage.** `MemberRole.MANAGER`.

**Drive.**

> Pick one (analogous to T.12).

**Verify.** Same membership query as T.12 with `role='MANAGER'`.

**Watch for.** MANAGER should see Members, Invitations, Programs,
but NOT Billing, Wallet, Invoices, Payouts. Settings should be
read-only (or hidden entirely).

---

### T.14 — EXPERT lens

**What we're about to do.** Create a tour EXPERT (this requires the
user to also have a `ConsultantProfile` — see
`prisma/seedFiles/1a-create-users.ts` for the pattern). Tour the
chrome — EXPERTs see their own earnings, their own payouts, their
own assigned programs.

**Why it matters.** EXPERT is the host-side role — the actual
service deliverer. On a Hybrid org like Acme, an EXPERT is also
typically a member of the host's pool.

**Coverage.** `MemberRole.EXPERT`.

**Drive.**

> Pick one (analogous to T.12, but also create a `ConsultantProfile`
> for the user via Supabase MCP).

**Verify.** Membership row + `ConsultantProfile` row exist for the
tour expert. The dashboard's "My earnings" section renders without
500 (even if the earnings are empty).

**Watch for.** EXPERT should see "My earnings", "My payout account"
in the sidebar. They should NOT see other experts' earnings or
other members' org-level analytics.

---

### T.15 — LEARNER lens

**What we're about to do.** Create a tour LEARNER. Tour the chrome
— LEARNERs see almost nothing in the org admin section because they
consume rather than administer. They DO see their own program
assignments, their booking history, and any vouchers/credits they
have.

**Why it matters.** LEARNER is the most restrictive lens. If
anything LEARNER-visible accidentally exposes another member's data,
that's a privacy bug — the "fix it" rule (Standing Rule #3) kicks
in immediately.

**Coverage.** `MemberRole.LEARNER`.

**Drive.**

> Pick one (analogous to T.12; LEARNER also needs a
> `ConsulteeProfile` for the booking flow to work).

**Verify.** Membership row + `ConsulteeProfile` row exist for the
tour learner.

**Watch for.** When a LEARNER navigates to
`/dashboard/organization/<orgId>`, the sidebar should redirect them
to a personal scope view (not the org-admin view). If they CAN see
the org-admin sidebar, that's the bug fixed in commit `a535fea2`
(consumer roles routed away from operator dashboard) regressing —
file it.

---

### T.16 — SUPPORT lens

**What we're about to do.** Create a tour SUPPORT user. Tour the
chrome — SUPPORT can read everything in the dashboard but can't
write anything. Useful for customer-success teams that need to
debug a customer's account without risk of breaking it.

**Why it matters.** SUPPORT is the lowest-privilege admin role.
It's the role we'd give to a CS rep who needs to look up "what
happened with this customer's invoice" without being able to refund
or void anything themselves.

**Coverage.** `MemberRole.SUPPORT`.

**Drive.**

> Pick one (analogous to T.12).

**Verify.** Membership row exists.

**Watch for.** Every "save" button on every page should be either
hidden or disabled for SUPPORT. The audit log viewer (T.17) should
still be accessible because it's read-only by nature.

---

# Chapter 4 — Cross-cutting integrations

These are the features that don't fit cleanly into "capability" or
"funding × program" but that every enterprise install will use. Each
stop is self-contained — you can do them in any order if you want
to skip around.

---

### T.17 — Audit log viewer + CSV export

**What we're about to do.** Sign in as the OWNER of
`tour-2026-04-25-acme`, navigate to
`/dashboard/organization/<acmeId>/audit`, walk the filter UI
(category dropdown, action search, date range), then trigger a CSV
export and download the file. Confirm the export is itself audited
— a row with `action='AUDIT_LOG_EXPORTED'` should appear in the
log immediately after.

**Why it matters.** The audit log is the customer's "who did what"
breadcrumb trail — load-bearing for SOC2 review and for "we got
hacked, what was changed?" forensics. The self-audit on export
closes a loophole where someone could exfiltrate the log and hide
the act.

**Coverage.** Cross-cutting integration — Audit log viewer + CSV
export.

**Drive.**

> Pick one:
> - `auto` — Navigate, take snapshot, click each filter, set
>   date range to "Last 7 days", click Export. Inspect the network
>   tab for the CSV response.
> - `manual` — Navigate, click around, click Export, type `done`.

**Verify.**

```sql
SELECT category, action, description, "createdAt"
FROM "OrgAuditLog"
WHERE "organizationId" = (SELECT id FROM "organizations" WHERE slug = 'tour-2026-04-25-acme')
  AND action = 'AUDIT_LOG_EXPORTED'
ORDER BY "createdAt" DESC LIMIT 1;
```

Expect a row dated within the last 60 seconds with the export's
filter parameters in the `details` JSON.

**Watch for.** The CSV download should chunk at 500 rows (per
`app/api/organizations/[orgId]/audit/export/route.ts`). For our
tour org with very few rows it'll be a single chunk. Open the CSV
in a text editor and confirm the header row matches the schema.

---

### T.18 — Domain DNS verification + signin gate

**What we're about to do.** Claim a fake domain (`tour.example.com`)
on `tour-2026-04-25-acme`. Observe the DNS TXT record we're asked
to publish. Since we can't actually set DNS for `tour.example.com`,
we'll fake it via Supabase MCP — UPDATE the
`OrgDomainClaim.verifiedAt` directly to mimic a successful DNS
proof. Then attempt to sign in with an email at that domain and
observe the SSO redirect kick in.

**Why it matters.** Without DNS proof, a malicious OWNER could
claim `gmail.com` and intercept SSO routing for unrelated users.
The `verifiedAt IS NOT NULL` enforcement landed in commit
`4479eb5f` and it gates both
`/api/auth/sso/domain-check` AND the customSession walk in
`lib/auth.ts`.

**Coverage.** Cross-cutting integration — Domain DNS verification.

**Drive.**

> Pick one:
> - `auto` — Navigate to
>   `/dashboard/organization/<acmeId>/sso/domains`, click "Add
>   domain", fill `tour.example.com`, save. Read the
>   verificationToken from the response. Then run the SQL to fake
>   the DNS proof (Standing Rule #5 — `tour-` prefix scope, OK).
>   Re-attempt the verify endpoint and watch `verifiedAt` flip.
> - `manual` — Same path; type `done` after each substep.

**Verify.**

```sql
SELECT domain, "verificationToken", "verifiedAt"
FROM "org_domain_claims"
WHERE "organizationId" = (SELECT id FROM "organizations" WHERE slug = 'tour-2026-04-25-acme')
  AND domain = 'tour.example.com';
```

Expect a row, `verificationToken` non-null, `verifiedAt` initially
null. After the fake-DNS UPDATE, expect `verifiedAt` populated.

Then test the signin gate:

```bash
curl -i 'http://localhost:3000/api/auth/sso/domain-check?email=anyone@tour.example.com'
```

Expect `enforceSSO=true` (after verifiedAt is set).

**Watch for.** Before `verifiedAt` is set, the same curl should
return `enforceSSO=false`. This is the security gate — unverified
claims must NOT steer signin.

---

### T.19 — SSO provider config + cert expiry warning

**What we're about to do.** Add a SAML SSO provider to Acme via
the SSO providers page. Use the test certificate from
`docs/enterprise/sso-testing-guide.md` (or generate one with
`openssl`). Set the cert's `notAfter` to 20 days from now via
Supabase MCP, then trigger the cert-expiry alert cron via
`/api/admin/sso-cert-expiry-alert`. Observe the WARN-level alert
fire (audit log entry + Novu workflow).

**Why it matters.** SSO certs expire silently in production unless
someone watches them. The cron + Novu workflow catches it 30 days
out (WARN) and 7 days out (CRITICAL).

**Coverage.** Cross-cutting integration — SSO provider config + cert
expiry.

**Drive.**

> Pick one:
> - `auto` — Navigate to provider config, paste cert, save. Then
>   `mcp__supabase__execute_sql` to UPDATE `notAfter`. Then `curl
>   POST` the cron route.
> - `manual` — Same.

**Verify.**

```sql
SELECT category, action, description, details
FROM "OrgAuditLog"
WHERE "organizationId" = (SELECT id FROM "organizations" WHERE slug = 'tour-2026-04-25-acme')
  AND action = 'SSO_CERT_EXPIRING'
ORDER BY "createdAt" DESC LIMIT 1;
```

Expect a row, `details.severity='WARN'`, `details.daysRemaining≈20`.

**Watch for.** The cron has a 20-hour dedup window
(`scripts/cleanup/sso-cert-expiry-alert.ts`) — re-running it within
20 hours should NOT produce a duplicate audit row.

---

### T.20 — Invoice lifecycle + PDF cache

**What we're about to do.** On `tour-2026-04-25-invoice-seat` (T.8),
generate a manual invoice via
`POST /api/organizations/<orgId>/billing-account/invoices`. Walk
DRAFT → ISSUED via PATCH. Hit the new
`/billing-account/invoices/<invoiceId>/pdf` route — watch the PDF
generate on the first hit and serve from the cached signed URL on
the second. Then PATCH status to VOID and re-hit the PDF route to
confirm the cache invalidates and a fresh PDF is generated.

**Why it matters.** The PDF route landed in commit `05efb1a5` along
with the consolidated renderer (`lib/pdf/invoice-renderer.tsx` —
both consumer and B2B in one file, no React-18-vs-RSC-19 hack
anymore). Cache invalidation on VOID/CANCELLED is in
`app/api/organizations/[orgId]/billing-account/invoices/[invoiceId]/route.ts`.

**Coverage.** Cross-cutting integration — Invoice lifecycle + PDF
cache.

**Drive.**

> Pick one:
> - `auto` — Curl POST to create a draft invoice, PATCH to
>   ISSUED, GET PDF (download), GET PDF again (verify Supabase
>   signed URL is reused), PATCH to VOID, GET PDF (regen).
> - `manual` — Same via a tool of your choice.

**Verify.**

```sql
SELECT
  status,
  "pdfStoragePath",
  "pdfGeneratedAt"
FROM "OrganizationInvoice"
WHERE "organizationId" = (SELECT id FROM "organizations" WHERE slug = 'tour-2026-04-25-invoice-seat')
ORDER BY "createdAt" DESC LIMIT 1;
```

Before VOID: `pdfStoragePath` populated, `pdfGeneratedAt` recent.
After VOID PATCH: BOTH columns nullified (cache invalidated).
After re-GET: `pdfStoragePath` re-populated.

**Watch for.** The first PDF GET returns 302 to a Supabase signed
URL; the second GET (within 24h TTL) returns the SAME signed URL
without regenerating the PDF. Confirm via `list_network_requests`
that the second request did NOT call out to Supabase storage's
upload endpoint.

---

### T.21 — Wallet top-up + Razorpay popup

**What we're about to do.** On `tour-2026-04-25-wallet-seat` (T.6),
navigate to the Wallet page and trigger a ₹100 top-up. The
Razorpay popup will open in test mode; complete the test payment
(card `4111 1111 1111 1111`, any future date, any CVV). Watch the
bounded-polling loop wait for the webhook to confirm, then observe
the wallet balance update.

**Why it matters.** This is the most fragile UX in the system —
popup integration + polling + webhook race conditions. The
`orgWalletTopUpLimiter` (20/hr per-org from commit `ae3f5226`)
prevents single-tenant Razorpay-order minting.

**Coverage.** Cross-cutting integration — Wallet top-up + Razorpay
popup.

**Drive.**

> Pick one:
> - `auto` — `mcp__chrome-devtools__navigate_page` to the wallet
>   page, click "Top up ₹100", `wait_for` the Razorpay popup, fill
>   the test card, complete. The agent will need to handle the
>   popup dialog via `handle_dialog` if BetterAuth shows a
>   confirmation.
> - `manual` — Same path; type `done` once the wallet balance
>   updates.

**Verify.**

```sql
SELECT
  ba."walletBalance",
  we."deltaPaise",
  we.reason,
  we."providerOrderId"
FROM "BillingAccount" ba
JOIN "WalletEntry" we ON we."billingAccountId" = ba.id
WHERE ba."ownerOrgId" = (SELECT id FROM "organizations" WHERE slug = 'tour-2026-04-25-wallet-seat')
ORDER BY we."createdAt" DESC LIMIT 1;
```

Expect a `WalletEntry` with `deltaPaise=10000`, `reason='TOPUP'`,
`providerOrderId` populated. Confirm `walletBalance=10000` after
the credit.

Also verify the FundingLedgerEntry mirror:

```sql
SELECT "deltaPaise", reason, "balanceAfterPaise"
FROM "FundingLedgerEntry"
WHERE "billingAccountId" = (
  SELECT id FROM "BillingAccount"
  WHERE "ownerOrgId" = (SELECT id FROM "organizations" WHERE slug = 'tour-2026-04-25-wallet-seat')
)
ORDER BY "createdAt" DESC LIMIT 1;
```

Expect `deltaPaise=10000`, `reason='TOPUP'`, `balanceAfterPaise=10000`.

**Watch for.** If the polling loop times out before the webhook
arrives (test mode is usually instant; production occasionally
delays), the UI should show a "still processing" state — NOT a
hard error. The webhook handler is at
`app/api/webhooks/razorpay/route.ts`.

---

### T.22 — Payout request + 3-way revenue split

**What we're about to do.** On `tour-2026-04-25-acme` (Hybrid),
configure an OrganizationPayoutAccount via the Payouts page. Then
create a synthetic OrganizationEarnings row via Supabase MCP
(simulating that an EXPERT delivered a session and earned money).
Request a payout. Walk through the 3-way split:
platformBps + orgBps + consultantBps.

**Why it matters.** The 3-way split is the heart of a marketplace
where the platform takes a cut, the org takes a cut, and the
expert takes a cut. Snapshotting bps at booking time
(`BookingUtilization.platformBpsAtBooking` etc.) means a later
rate-card rotation doesn't retroactively rewrite history.

**Coverage.** Cross-cutting integration — Payout request + 3-way
split.

**Drive.**

> Pick one:
> - `auto` — Configure payout account (fake bank details, OK for
>   tour), then SQL-insert a synthetic earnings row, then click
>   "Request payout".
> - `manual` — Same.

**Verify.**

```sql
SELECT
  oe."grossAmountPaise",
  oe."platformBpsApplied",
  oe."orgBpsApplied",
  oe."consultantBpsApplied",
  oe."netToOrgPaise",
  oe."netToConsultantPaise",
  op.status AS payout_status
FROM "OrganizationEarnings" oe
LEFT JOIN "OrganizationPayout" op ON op.id = oe."payoutId"
WHERE oe."organizationId" = (SELECT id FROM "organizations" WHERE slug = 'tour-2026-04-25-acme')
ORDER BY oe."createdAt" DESC LIMIT 1;
```

Expect bps values that sum to 10000 (100%) and net amounts that
match the gross × bps math.

**Watch for.** If the payout status is stuck in `PENDING` for more
than a few seconds, check the payout cron at
`scripts/cleanup/process-payouts.ts` — it might not be wired in
dev. T.22 is observational; payouts are only fully exercised in
the API test suite.

---

### T.23 — Anti-lockout demo (3 vectors)

**What we're about to do.** Three sub-stops:
- (a) Try to demote the OWNER of `tour-2026-04-25-acme` via PATCH
  `/members/[memberId]` — observe 409.
- (b) Try to terminate the contract on `tour-2026-04-25-wallet-seat`
  while it has a live ProgramAssignment — observe 409.
- (c) Try to delete a Program with utilization history — observe
  409 (we'll need to first create a fake `BookingUtilization` row).

**Why it matters.** These three guards are what prevent a customer
from accidentally orphaning their own org. Commits `9d33c652` (last
OWNER), and the contract + program guards from the same batch
landed via batch 7 with the explicit anti-lockout test file
`__tests__/enterprise/anti-lockout-gaps.test.ts`.

**Coverage.** Cross-cutting integration — Anti-lockout guards (3
vectors).

**Drive.**

> Pick one:
> - `auto` — Three curl PATCH/DELETE calls, one per vector, with
>   `take_snapshot` of the resulting toast.
> - `manual` — Same.

**Verify.**

For (a), confirm the membership wasn't actually demoted:

```sql
SELECT role FROM "Membership"
WHERE "organizationId" = (SELECT id FROM "organizations" WHERE slug = 'tour-2026-04-25-acme')
  AND role = 'OWNER';
```

Expect at least 1 row still.

For (b) and (c), confirm the contract / program is still ACTIVE:

```sql
SELECT status FROM "Contract"
WHERE "organizationId" = (SELECT id FROM "organizations" WHERE slug = 'tour-2026-04-25-wallet-seat');
```

Expect `ACTIVE` (not `TERMINATED`).

**Watch for.** Each 409 should include a specific error message
(not a generic "Conflict"). For the contract case, the message
should name the offending assignment count.

---

### T.24 — OrgContextFilter (Personal / Org / All)

**What we're about to do.** Sign in as a user who's a member of
multiple orgs (any of the tour learners we created in T.15 — they're
all members of Acme). Navigate to the consultant or consultee
dashboard. Find the OrgContextFilter dropdown. Switch between
"Personal", "Org: tour-2026-04-25-acme", and "All". Observe the
appointment list change as the filter changes.

**Why it matters.** The filter lets a user separate their personal
sessions from sessions they took as an org member. Without it,
analytics get muddied. The component is at
`components/dashboard/OrgContextFilter.tsx`.

**Coverage.** Cross-cutting integration — OrgContextFilter.

**Drive.**

> Pick one:
> - `auto` — Navigate to the consultant dashboard, take_snapshot
>   to find the filter combobox, click each option, take snapshot
>   between each.
> - `manual` — Same.

**Verify.** No DB-level verification needed — the filter is a
client-side query param. Just confirm the URL changes (the filter
serializes to a query string via
`lib/dashboard/org-context-filter.ts:serializeOrgFilter`).

**Watch for.** When the user has zero orgs, the filter should be
hidden entirely (per the component's render guard). If you see it
rendered with no options, that's a bug.

---

# Chapter 5 — Notifications + reconciliation

The last two integration stops cover the platform's "background
hygiene" surfaces: outbound notifications via Novu, and the nightly
reconcile cron that catches drift between the three ledgers.

---

### T.25 — Trigger every Novu org workflow

**What we're about to do.** Walk through each of the 9 Novu org
workflows (added in commit `aad0027c`) and trigger each one at
least once during the tour. For each workflow, we'll inspect the
payload that would have been sent (Novu's debug mode logs the
payload locally) and confirm the recipient roster matches the
roster resolver's expectation.

The 9 workflows:
1. `notifyOrgInviteSent` — sent when an invite is created
2. `notifyOrgInviteAccepted` — sent when accepted
3. `notifyOrgInvoiceIssued` — sent when an invoice is issued
4. `notifyOrgInvoicePaid` — sent on payment webhook
5. `notifyOrgWalletTopupConfirmed` — sent on top-up webhook
6. `notifyOrgPayoutCompleted` — sent on payout success
7. `notifyOrgProgramExhausted` — sent when ProgramAssignment hits cap
8. `notifyOrgSsoProviderDeleted` — sent on SSO provider DELETE
9. `notifyOrgSsoCertExpiring` — sent by the cert-expiry cron

**Why it matters.** If notifications silently fail, customers don't
know about state changes that affect them. The non-throwing pattern
in `lib/novu/org-workflows.ts` means we don't break the originating
mutation, but we DO need observability that the trigger fired.

**Coverage.** Cross-cutting integration — Novu org workflows (9
events).

**Drive.**

> Pick one:
> - `auto` — Trigger each: invite a tour user → 1, accept → 2,
>   issue invoice → 3, pay it (we already did in T.20) → 4, top
>   up wallet (T.21) → 5, request payout (T.22) → 6, exceed
>   program cap (we may need to create + book a session) → 7,
>   delete the SSO provider from T.19 → 8, the cron in T.19
>   already fired 9.
> - `manual` — Same; agent narrates each Novu trigger as it fires.

**Verify.** Novu sends are non-throwing — there's no DB row to
check. The agent should inspect `list_console_messages` and look
for the `console.error` lines that fire on Novu failure (per
`lib/novu/org-workflows.ts`'s `triggerOne` / `triggerMany` helpers).
Absence of error lines = workflows triggered cleanly.

For roster verification, run:

```sql
SELECT u.email, m.role
FROM "Membership" m
JOIN "User" u ON u.id = m."userId"
WHERE m."organizationId" = (SELECT id FROM "organizations" WHERE slug = 'tour-2026-04-25-acme')
  AND m.status = 'ACTIVE'
  AND m.role IN ('OWNER', 'MAINTAINER');
```

This is the OPERATOR_ROLES roster — `notifyOrgInviteSent`,
`notifyOrgInvoiceIssued`, etc. should target exactly these users.

**Watch for.** The `notifyOrgSsoProviderDeleted` workflow targets
OWNER_ONLY (security-sensitive), not all operators. If a
MAINTAINER-only org ever deletes a provider, no one gets paged —
that's a known gap tracked in the broader follow-up issue.

---

### T.26 — Reconcile cron — walk all 5 checks

**What we're about to do.** Trigger the reconcile cron via
`POST /api/admin/reconcile-ledgers`. Walk through the 5 checks the
auditor runs:
- (A) Wallet balance drift
- (B) Funding-ledger mirror
- (C) Settlement coverage (INVOICE_ISSUED)
- (D) Settlement coverage (INVOICE_PAID)
- (E) **NEW:** ProgramAssignment session-counter drift (from commit
  `7231f75f`)

For each check, the agent reads the corresponding section of
`scripts/reconcile/reconcile-ledgers.ts` and explains what
invariant is being asserted.

**Why it matters.** The reconcile cron is the safety net that
catches drift between the three ledgers (Usage / Funding /
Settlement) and between cached counters (ProgramAssignment.sessionsUsed)
and the immutable ledger they're derived from. The cron now runs at
03:45 UTC nightly.

**Coverage.** Cross-cutting integration — Reconcile cron (5
checks).

**Drive.**

> Pick one:
> - `auto` — Curl POST to `/api/admin/reconcile-ledgers` with
>   admin credentials. Read the resulting `LedgerReconciliationReport`
>   row. Walk through each finding (or absence of findings).
> - `manual` — Same.

**Verify.**

```sql
SELECT id, scope, ok, "durationMs", summary, findings
FROM "LedgerReconciliationReport"
ORDER BY "runAt" DESC LIMIT 1;
```

Expect `ok=true` (no drift) for our tour data. Inspect `summary`
to confirm `assignmentsChecked > 0` (proves check E ran).

**Watch for.** If `ok=false`, the `findings` JSON will list each
discrepancy with `kind`, expected/actual, and details. Walk each
finding and decide whether to `fix it` or `note it` per Standing
Rule #3.

---

### T.27 — Force a ProgramAssignment drift, observe the finding

**What we're about to do.** On `tour-2026-04-25-wallet-seat` (T.6),
manually UPDATE `ProgramAssignment.sessionsUsed = 99` via Supabase
MCP — creating a deliberate drift between the counter and the (zero)
UsageLedgerEntry sum. Re-run the reconcile cron. Watch the new
`PROGRAM_ASSIGNMENT_SESSIONS_DRIFT` finding appear. Then UPDATE
back to `0` and re-run to confirm clean.

**Why it matters.** Closing the loop on the safety net we just
toured. The drift check from commit `7231f75f` is the answer to
"what if a partial-rollback bug or a manual SQL edit pushed
sessionsUsed out of sync with the ledger?". This stop proves the
check actually catches it.

**Coverage.** Cross-cutting integration — Reconcile cron drift
detection.

**Drive.**

> Pick one:
> - `auto` — UPDATE SQL, POST to reconcile route, read findings,
>   restore SQL.
> - `manual` — Same.

**Verify.** Before the restore:

```sql
SELECT findings::text
FROM "LedgerReconciliationReport"
ORDER BY "runAt" DESC LIMIT 1;
```

Expect a finding with `kind='PROGRAM_ASSIGNMENT_SESSIONS_DRIFT'`,
`expectedPaise=0` (ledger total), `actualPaise=99` (counter),
`deltaPaise=99`.

After the restore + re-run:

```sql
SELECT ok FROM "LedgerReconciliationReport"
ORDER BY "runAt" DESC LIMIT 1;
```

Expect `ok=true`.

**Watch for.** The `expectedPaise` / `actualPaise` field names
hold session counts here, not paise — see the comment in
`scripts/reconcile/reconcile-ledgers.ts` where the Finding type was
extended. The auditor UI should render the units correctly based
on `kind`.

---

# Chapter 6 — Cleanup

We're about to leave. Time to delete every record we created and
confirm the seed cohort is intact.

---

### T.28 — Delete every tour-prefixed org

**What we're about to do.** Run a CASCADE delete on every
organization carrying the `tour-2026-04-25-` slug prefix. This
removes the orgs + everything that hangs off them via FK cascade
(Memberships, Contracts, Programs, BillingAccounts, WalletEntries,
…). Also delete the tour users we created in Chapter 3.

**Why it matters.** Standing Rule #5 — mock data is scoped, and
that scope must be cleaned up. Leaving tour-prefixed records around
between runs makes the next tour's verification queries return
non-deterministic data.

**Coverage.** Cleanup.

**Drive.**

> Pick one:
> - `auto` — Run the SQL deletes via `mcp__supabase__execute_sql`.
> - `manual` — Same SQL via the Supabase SQL editor.

**Verify.**

```sql
DELETE FROM "organizations" WHERE slug LIKE 'tour-2026-04-25-%';
DELETE FROM "User" WHERE email LIKE 'tour-2026-04-25-%@example.com';

-- Confirm
SELECT COUNT(*) FROM "organizations" WHERE slug LIKE 'tour-2026-04-25-%';
SELECT COUNT(*) FROM "User" WHERE email LIKE 'tour-2026-04-25-%@example.com';
```

Both counts should be `0`.

**Watch for.** If a delete fails on a FK constraint we didn't
expect (e.g. an `OrganizationInvoice` whose `paidByPaymentId` points
at a non-cascading `Payment`), the delete may need to be done in a
specific order. The tour orgs are simple enough that CASCADE should
handle everything; if it doesn't, inspect the FK and add a manual
delete for the offending child table.

---

### T.29 — Verify the seed cohort is intact

**What we're about to do.** Re-run the orientation query from T.1.
Confirm Wipro / LearnPro / IIT / Rahul are still there with their
original capability booleans.

**Why it matters.** Sanity check that we didn't accidentally
override the scope rule and touch a non-tour record. If anything
seed-cohort changed during the tour, that's a bug we introduced in
flight; trace it via the audit log.

**Coverage.** Cleanup verification.

**Drive.**

> No interactive flavor needed — pure read.

**Verify.**

```sql
SELECT slug, name, "canSponsor", "canHost", status
FROM "organizations"
WHERE slug IN ('wipro', 'iit-madras', 'learnpro-agency')
ORDER BY slug;
```

Expect the same 3 rows we saw in T.1 with identical column values.

**Watch for.** If any row's `canSponsor` / `canHost` differs from
T.1's snapshot, restore from a backup or reseed. File the bug.

---

### T.30 — Wrap-up

**What we're about to do.** The agent gives a one-screen recap of
the tour: how many stops we visited, how many bugs we fixed
in flight (if any), how many follow-up issues we should file. Then
the agent offers to:

- File any bug-fix follow-up issues via `gh issue create`.
- Generate a summary post (e.g. for a team Slack channel) of what
  the new dev/PM learned during the tour.
- Run the tour again with a different role's eyes (e.g. "now do
  T.11-T.16 from the LEARNER lens").

**Why it matters.** A tour without a recap is a tour you forget. The
recap is the artifact you keep.

**Coverage.** Wrap-up.

**Drive.**

> No interactive flavor — agent narrates the recap and offers
> options. User picks one or types `done` to exit the tour cleanly.

**Verify.** None.

**Watch for.** The recap should mention every chapter and call out
any stop the user `skip`-ped. The `note it` items from Standing
Rule #3 should be surfaced as proposed follow-up issues with
suggested titles.

---

> End of tour. Thanks for visiting Architecture-4. The seed cohort
> is back where you found it; the tour data is gone. If anything
> still feels mysterious, file an issue against `docs/enterprise/`
> — the docs should answer the question that puzzled you.
