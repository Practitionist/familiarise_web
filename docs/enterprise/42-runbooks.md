# 23 — Operational runbooks

This document captures the step-by-step procedures for responding to the
most common enterprise incidents and scheduled operational tasks. Pair it
with the alerting playbook in `43-monitoring.md`.

The goal is to make every runbook a **self-contained, copy-pasteable
sequence** — an on-call engineer at 3 AM should be able to execute one
top-to-bottom without reading any other document.

> Legend
> - 🚨 — incident response (reactive)
> - 🗓️ — scheduled operational task (proactive)
> - 🔬 — diagnostic helper (read-only, safe to run any time)

---

## 🚨 Webhook handler is backed up (Razorpay or Stripe)

**Symptoms:** `webhookEvent.status = "QUEUED"` rows accumulating, or
`payment.captured` events are delayed more than 5 minutes from the vendor
dashboard timestamp.

**Impact:** Wallet top-ups, invoice payments, and refunds appear "stuck"
to the user because the downstream `WalletTopUp` confirm + ledger
postings (and `OrganizationInvoice` updates) are gated on the webhook.
Subscriptions keep billing but the local `BillingSubscription` state lags.

**Response:**

1. Confirm the backup via the reconciler's `GET` endpoint —
   `/api/admin/reconcile-ledgers?onlyDirty=true` — and check the vendor
   dashboards for inbound-event volume.
2. Scan the app logs for the canonical webhook-failure log lines emitted
   by `app/api/webhooks/razorpay/route.ts` and `app/api/webhooks/stripe/route.ts`.
   The receive path is idempotent, so **replays are always safe** — the
   `WebhookEvent.id` deduplicator will no-op on already-processed rows.
3. If a specific event `id` is wedged on a downstream exception, inspect
   `WebhookEvent.attempts`, `lastError`, and the associated ledger rows.
   Manually replay by POSTing the original payload to the same endpoint
   with the original `X-Razorpay-Signature` / `Stripe-Signature` header.
4. If the signature has drifted (e.g. we rotated
   `RAZORPAY_WEBHOOK_SECRET`), re-register the webhook endpoint in the
   vendor dashboard — **never** loosen signature verification in code.

**Do not:**
- Increase the webhook HTTP timeout beyond 25s (Razorpay will retry
  regardless after 5s; wedging the Next.js edge function just holds
  memory).
- Skip the signature check to "unblock" a stuck event. Use admin SQL
  instead to mark the row `PROCESSED` with a human note.

---

## 🚨 Ledger reconciler flagged discrepancies

**Symptoms:** Nightly `reconcile-ledgers` cron (see
`.github/workflows/reconcile-ledgers.yml`) exits with code `2`, or the
admin dashboard shows a `LedgerReconciliationReport` with `ok=false`.

**Impact:** A money-journal or usage-ledger invariant (see
`08-ledger-and-postings.md`) is not holding. A `LedgerTransaction` may be
unbalanced, the `BillingAccount.walletBalance` cache may have drifted from
the WALLET account, or an aggregate (earnings / seats / org-payout) no
longer matches its journal postings.

**Response:**

1. Pull the latest report:
   ```bash
   curl -s https://app.familiarise.com/api/admin/reconcile-ledgers?onlyDirty=true \
     -H "Authorization: Bearer $PRIVILEGED_TOKEN" | jq .
   ```
2. Each `finding.kind` maps to a known invariant (codes defined in
   `scripts/reconcile/reconcile-ledgers.ts`; same set in the
   `jobs/reconcile/reconcile-ledgers.ts` cron entry point):
   - `WALLET_BALANCE_DRIFT` — `BillingAccount.walletBalance` cache
     disagrees with the signed balance of the org's WALLET
     `LedgerAccount` (`ledgerBalancePaise`).
   - `LEDGER_TXN_IMBALANCE` — a `LedgerTransaction` has
     `Σ DEBIT ≠ Σ CREDIT` across its `LedgerEntry` rows. Should be
     impossible (`postLedgerTxn` rejects unbalanced postings) — a hit
     means a row was hand-edited or partially written.
   - `EARNINGS_LEDGER_DRIFT` — `OrganizationEarnings` aggregates
     disagree with the `CONSULTANT_PAYABLE`/`ORG_PAYABLE` journal legs.
   - `PROGRAM_ASSIGNMENT_ENGAGEMENTS_DRIFT` — `ProgramAssignment`
     engagement counters disagree with the `UsageLedgerEntry` rows.
   - `ACTIVE_SEAT_COUNT_DRIFT` — cached active-seat count disagrees
     with live `ProgramAssignment` membership.
   - `PAYMENT_LEG_SUM_MISMATCH` — a `Payment`'s amount disagrees with
     the sum of its attributed journal legs.
   - `ORG_PAYOUT_TOTAL_MISMATCH` — an `OrganizationPayout` total
     disagrees with its `ORG_PAYABLE`/`PAYOUT` postings.
3. For each finding, identify the root cause — nearly always a
   half-applied transaction caused by a webhook that died before
   commit. Manually re-run the affected webhook replay (see above).
4. Once reconciled, trigger a fresh audit via `POST` to the admin
   endpoint with `{ organizationId }` scoped to the affected org and
   confirm `ok=true`.

**Correcting drift:** the journal is append-only. Never edit or delete a
`LedgerTransaction`/`LedgerEntry` row to "fix" a finding — post a
balanced **counter-transaction** (Σ DEBIT == Σ CREDIT) that reverses the
bad legs, then re-run reconcile. `WALLET_BALANCE_DRIFT` is the lone
exception: the balance is a derived cache, so re-deriving it from the
WALLET account is a legitimate repair (the journal is the source of
truth).

**Never** auto-close a finding. Every row represents real money drift.

---

## 🚨 DPDP consent-withdrawal purge didn't run

**Symptoms:** Stale `ConsentArtifact` rows older than
`CONSENT_RETENTION_DAYS` (default 365) are still present, or a user's
withdrawal-of-consent request doesn't propagate.

**Response:**

1. Verify the sweeper ran: check the last scheduled run of
   `jobs/compliance/consent-retention-sweeper.ts` in CI logs.
2. If `DPDP_SWEEPER_DELETE=false` (default), the sweeper only counts —
   **this is the deliberate pre-MVP posture**. Flip the env flag to
   `true` in production to enable deletions, roll out behind a feature
   flag per tenant if needed.
3. For individual withdrawal, call the API:
   ```bash
   curl -X DELETE "https://app.familiarise.com/api/organizations/$ORG/consent" \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{ "userId": "…", "purpose": "ANALYTICS" }'
   ```
   Omitting `purpose` withdraws all consents for that user in that org.
4. Confirm the `ConsentArtifact.withdrawnAt` timestamp is set and an
   `OrgAuditLog` row with `action = CONSENT_WITHDRAWN` exists.

---

## 🚨 MSME payment deadline alert not delivered

**Symptoms:** Finance team didn't receive the daily "at-risk payouts"
email from `jobs/compliance/msme-payment-alerts.ts`.

**Response:**

1. Confirm `MSME_ALERT_EMAIL` and `RESEND_API_KEY` are set in the job
   environment. Missing values degrade the job to **log-only** mode —
   the structured log line is still emitted for Cloud Logging to pick
   up, but no email is sent.
2. Check Resend's dashboard for bounces/rate-limit errors.
3. Trigger a manual run:
   ```bash
   npx tsx jobs/compliance/msme-payment-alerts.ts
   ```
   Expect to see `msme.alert.sent` or `msme.alert.logged` log lines.
4. If the alert window itself is wrong (e.g. 3 days, not 7), edit
   `ALERT_WINDOW_DAYS` in the job source, not the env — this is a
   compliance parameter that should be code-reviewed.

---

## 🗓️ Onboarding a new enterprise org

1. Verify creator role: `user.role = ORG_WORKSPACE` (or platform `ADMIN`).
2. Run through the wizard at `/dashboard/organization/create` —
   **org creation only fires on the Review step's "Launch" action**, so
   dropping out mid-flow is safe and leaves no orphan rows.
3. After launch, OWNER membership is created in the same transaction as
   the `Organization` and `BillingAccount` (when sponsoring).
4. If the org sponsors with `fundingSource = INVOICE`, ensure the
   finance team has approved the payment terms (default NET-60, capped
   at 180 days).
5. Kick off an SSO config if the org has `allowedEmailDomains` — domain
   claims must be verified via the out-of-band DNS TXT record process
   before `enforceSSO` can be enabled.

## 🗓️ Rotating Razorpay credentials

1. Generate new keys in the Razorpay dashboard.
2. Update `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and
   `RAZORPAY_WEBHOOK_SECRET` in the deployment environment.
3. **Deploy the change before updating the webhook endpoint** — the
   HMAC verification will reject any event signed with the new secret
   until the code has rolled out.
4. In the Razorpay dashboard, update the webhook's signing secret to
   match; Razorpay will start retrying failed webhooks immediately.
5. Run `POST /api/admin/reconcile-ledgers` after the dust settles to
   confirm no events were lost in the transition.

---

## 🔬 Inspect a specific organization's ledger state

```bash
curl -X POST "https://app.familiarise.com/api/admin/reconcile-ledgers" \
  -H "Authorization: Bearer $PRIVILEGED_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "organizationId": "$ORG_ID" }' | jq .
```

Returns a `LedgerReconciliationReport` scoped to just that org. `ok=true`
means every invariant holds; `findings` lists every drifted row.

## 🔬 List webhook events for an order

Given a Razorpay `order_id` or Stripe `payment_intent_id`:

```sql
SELECT id, provider, event_type, status, attempts, last_error, created_at
FROM webhook_events
WHERE payload::text LIKE '%' || :order_id || '%'
ORDER BY created_at DESC
LIMIT 20;
```

Use this when a user reports "I paid but nothing happened" — the
`status` column tells you whether the webhook was received, processed,
or failed.

## 🔬 Running cron jobs locally

Every standalone job under `jobs/**/*.ts` (cron entry points + their
shared helpers) is executable via `tsx`. Useful when you need to
reproduce a GitHub-Actions failure offline, force a one-off sweep,
or smoke-test a new cron before wiring its workflow.

```bash
# Minimum required env (loaded via dotenv/config from .env at the top
# of every standalone job):
#   DATABASE_URL, DIRECT_URL — Supabase Postgres connection strings
#   STREAM_API_KEY, STREAM_API_SECRET — for jobs/meetings/* + stream/*
#   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET — for jobs/payouts/*
#   RESEND_API_KEY — for jobs/compliance/* (email out)
#   DPDP_SWEEPER_DELETE=false — gates destructive scrub in any DPDP runs

npx tsx jobs/contracts/expire-contracts.ts
npx tsx jobs/compliance/databreach-deadline-alerts.ts
npx tsx jobs/compliance/irp-uploader.ts
npx tsx jobs/compliance/msme-payment-alerts.ts
npx tsx jobs/cleanup/release-pending-trust-earnings.ts
npx tsx jobs/meetings/reconcile-orphaned-sessions.ts
```

**Required boilerplate inside each job:**
1. `import "dotenv/config";` as the FIRST line. Without it, tsx
   doesn't load `.env` and `PrismaClient` throws on the first query.
2. An explicit `await prisma.$disconnect()` in `.finally()` of the
   `if (require.main === module)` block. Without it, the script
   process hangs after the work completes and CI marks the job as
   stuck.

The `expire-contracts.ts` job is the canonical template; the other
standalone jobs mirror its shape. New jobs should copy that
boilerplate verbatim — `jobs/contracts/expire-contracts.ts` lines
26 (dotenv) + 115-123 (main block with $disconnect).

**Exit codes:** `0` = success, `1` = at least one row failed and
the error was captured in the structured-log output. Any other exit
code indicates the script crashed before completing — check the
last log line for a stack trace.

## 🗓️ Flipping the CSP from report-only to enforce

The CSP shipped in PR #655 is `Content-Security-Policy-Report-Only`
by default. Receiver violations stream to `/api/csp-report` and
surface as `event: "csp_violation"` lines in the structured log.

**Cutover protocol** — do not flip before completing this:

1. **Day 0 → Day 7 (observe).** Tail production logs filtered to
   `event: "csp_violation"`. Expected steady-state shape:
   ```
   { "event": "csp_violation", "ip": "...", "ua": "...",
     "report": { "csp-report": { "violated-directive": "...",
                                  "blocked-uri": "...",
                                  "document-uri": "..." } } }
   ```
   Tally by `violated-directive`. Anything **outside** the directive
   list in `next.config.mjs` `CSP_DIRECTIVES` is a real candidate;
   anything inside is browser noise (extensions injecting scripts,
   crawlers ignoring CSP, etc.).
2. **Day 7 (review).** Aggregate the violation counts. Two checks:
   - Are any LEGITIMATE third-party resources getting blocked? If
     yes → add the domain to the matching `script-src` /
     `connect-src` / etc. directive in `next.config.mjs` and start
     the 7-day clock again. Common offenders: a new monitoring SDK,
     a new analytics endpoint, a new Stream.io region.
   - Are any reports clustering on a single `blocked-uri` that looks
     malicious (e.g. `data:` URI with base64 payload)? If yes →
     leave it blocked AND flip enforce; the report-only window
     surfaced an attack.
3. **Day 7 — flip.** Set `ENABLE_CSP_ENFORCE=true` in the production
   env. The header key changes from `Content-Security-Policy-Report-Only`
   to `Content-Security-Policy`. Same allow-list, same report
   destination — but browsers now BLOCK violations instead of
   allowing-but-flagging.
4. **Day 7 + 24h (smoke).** Curl-fetch `/`, `/auth/signin`,
   `/dashboard/organization/[orgId]/billing` for an active customer
   org and verify the dashboard still loads end-to-end. Razorpay
   checkout popup is the highest-risk path — a missing entry in
   `frame-src` or `script-src` here will break payments.
5. **Rollback path.** If enforce breaks anything, flip
   `ENABLE_CSP_ENFORCE` back to `false` (or unset). The header
   immediately reverts to report-only on the next request. No
   restart required; no other change needed.

**What NEVER goes in the directive list:** `*`, `'unsafe-eval'` in
`connect-src`, `data:` in `script-src`. Each of these defeats the
purpose. The current allow-list is documented in
`docs/enterprise/19-security-headers.md` with the rationale per
directive.

**Reporter URL note.** `/api/csp-report` is unauthenticated by
design — the browser is the originator, not the user. It's
rate-limited via `spamLimiter` on IP. Watch for the rate-limit
hitting (429s in the log) if a single client misconfigures + spams
violations; that's the signal to widen the spam budget.
