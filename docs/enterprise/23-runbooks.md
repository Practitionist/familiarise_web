# 23 — Operational runbooks

This document captures the step-by-step procedures for responding to the
most common enterprise incidents and scheduled operational tasks. Pair it
with the alerting playbook in `24-monitoring.md`.

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
to the user because the downstream `WalletEntry`/`OrganizationInvoice`
updates are gated on the webhook. Subscriptions keep billing but the
local `BillingSubscription` state lags.

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

**Impact:** The three-ledger invariants (see `18-three-ledger-discipline.md`)
are not holding. Spent credit may not reconcile with funding; wallet
balances may drift from `WalletEntry` sums.

**Response:**

1. Pull the latest report:
   ```bash
   curl -s https://app.familiarise.com/api/admin/reconcile-ledgers?onlyDirty=true \
     -H "Authorization: Bearer $PRIVILEGED_TOKEN" | jq .
   ```
2. Each `finding.kind` maps to a known invariant:
   - `WALLET_BALANCE_DRIFT` — `BillingAccount.walletBalance` disagrees
     with `Σ WalletEntry.deltaPaise` for the same org.
   - `INVOICE_UNPAID_SETTLEMENT` — `SettlementLedgerEntry.amountPaise`
     exists for an invoice that is still `DRAFT`/`ISSUED`.
   - `FUNDING_UNREFERENCED` — a `FundingLedgerEntry` has no matching
     `WalletEntry` or `OrganizationInvoice` credit.
3. For each finding, identify the root cause — nearly always a
   half-applied transaction caused by a webhook that died before
   commit. Manually re-run the affected webhook replay (see above).
4. Once reconciled, trigger a fresh audit via `POST` to the admin
   endpoint with `{ organizationId }` scoped to the affected org and
   confirm `ok=true`.

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

1. Verify creator role: `user.role = ORG_ADMIN` (or platform `ADMIN`).
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
