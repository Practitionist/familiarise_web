---
title: Operational runbooks
band: 50-operations
audience: sde4
status: partial
last-reviewed: 2026-10-23
---

# Operational runbooks

This document holds the step-by-step procedures for enterprise incidents and scheduled operational tasks that are **not** about money: consent withdrawal, organisation onboarding, the content security policy, SSO key rotation, staff off-boarding and authenticator recovery. Pair it with the alerting playbook in `monitoring`.

Every money procedure (a stuck top-up, refund or payout, an overdue invoice, an overage that will not clear, a ledger finding, a frozen wallet, rotating Razorpay credentials, going live) lives in the finance documentation: [money runbooks](../../finance/70-operations/05-money-runbooks.md), [ledger drift runbook](../../finance/70-operations/06-ledger-drift-runbook.md), [webhook recovery](../../finance/70-operations/04-webhook-recovery.md) and [the go-live checklist](../../finance/70-operations/07-go-live-checklist.md). The money job schedule is listed in [scheduled money jobs](../../finance/70-operations/01-scheduled-jobs.md). Scheduling is the Netlify five-minute ticker, not GitHub Actions; to run any registered job by hand, `POST /api/cleanup/<slug>` with `Authorization: Bearer $CRON_SECRET`.

> Legend
>
> - 🚨 — incident response (reactive)
> - 🗓️ — scheduled operational task (proactive)

## 🗓️ Scheduled work and ownership

Use the [cron reference](../../maintenance/04-cron-jobs-reference.md) and
[SRE orientation](../../start-here/10-infra-and-maintenance-sre-orientation.md)
for the current job inventory and operational boundaries. Source registry
entries determine the implementation; the ticker determines its due slots.
A workflow declaration or old per-job docstring is not evidence of execution.

The five-minute Netlify ticker owns recovery sweeps, email/notification
relays, session outcomes, money jobs and statutory exports. Money batch jobs
run in bounded calendar-window slices. Actions still declares non-money
batch jobs pending their bounded migration; it is not an automatic backstop
for ticker targets. Preserve one automatic scheduling owner during handoff.

A cleanup call authenticates with CRON_SECRET, checks maintenance admission
and enters its canonical leased core. Postgres mutual exclusion applies to
the same job name; domain CAS and external idempotency must protect repeated
or cross-job operations. A timed-out caller does not establish that the
worker stopped. Persistent 409s require finding the owner and progress, not
deleting the lease.

Inspect the core result, execution history, failed/held dispatcher buckets
and committed domain effects. A ticker 200 or an Actions workflow marked
active is insufficient. The current shared heartbeat can remain green while
one required capability has stopped. See the independent completion probe
and alert-delivery operating gates in the linked maintenance runbooks before declaring health.

For a manual recovery, use the authenticated canonical cleanup or admin
door with a bounded limit and operator reason where supported. Do not run
an old GITHUB_OUTPUT wrapper or an unbounded fleet script against the shared
development/production database. Data exports use processDataExports via
the ticker; no separate Actions data-export workflow is present.

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

## Content Security Policy (CSP)

Launch ships `Content-Security-Policy-Report-Only`. `next.config.mjs` reads
`ENABLE_CSP_ENFORCE` **at build time**; only `true` switches the header to
`Content-Security-Policy`. Only an enforced build sends violations, straight to Sentry's security
endpoint (derived from `NEXT_PUBLIC_SENTRY_DSN`) via `report-uri` and
`report-to csp-endpoint`; there is no app-side report route. A report-only build,
or a build without a DSN, sends no reports.

> ⚠️ **Every change here is a redeploy, not a config push.** The value is baked
> into the `headers()` output when the config is evaluated.

**Switching enforcement on:**

1. **Observe.** Report-only builds send nothing to Sentry, so open a deploy
   preview with the browser console open and walk `/`, `/auth/signin`, an org
   billing page, a Razorpay checkout and a Stream call. Each `[Report Only]`
   console line names the violated directive and blocked URI. A blocked URI that
   is a real dependency (new SDK, new Stream region, a payment origin) is a
   candidate; browser extensions are noise.
2. **Fix.** Add legitimate origins to the matching directive in
   `CSP_DIRECTIVES` (`next.config.mjs`), deploy, and keep observing until only
   noise remains. A cluster on one suspicious `blocked-uri` (for example a
   `data:` payload) is an attack the window surfaced: leave it out.
3. **Enforce.** Set `ENABLE_CSP_ENFORCE=true` in the production build
   environment and redeploy. `curl -sI` the site and confirm the header key is
   `content-security-policy`. Violation reports to Sentry start with this build,
   so watch the error quota for the first day.
4. **Smoke.** Load `/`, `/auth/signin`, an org billing page and a Razorpay
   checkout end to end. Checkout is the highest-risk path: a missing
   `frame-src` or `script-src` entry breaks payments for everyone.

**Rollback.** Remove `ENABLE_CSP_ENFORCE` (or set it to anything but `true`)
and redeploy. Re-enable in the same change that fixes the allow-list.

**Never add** `*`, `data:` in `script-src`, or wildcard schemes. The allow-list
and per-directive rationale:
[`04-security-headers.md`](../20-iam-and-security/04-security-headers.md).

## SSO secret key rotation

`AUTH_CONFIG_ENCRYPTION_KEY` encrypts each OIDC provider's client secret at
rest. To rotate it:

1. Set `AUTH_CONFIG_ENCRYPTION_KEY` to the new key and
   `AUTH_CONFIG_ENCRYPTION_KEY_PREVIOUS` to the old one. Redeploy. Reads accept
   either key; writes use the new one.
2. Re-encrypt every stored secret with the new key:

   ```bash
   npx tsx -r dotenv/config scripts/rotate-sso-secret-key.ts
   ```

3. Continue only when it prints `Re-encrypted N of N` and exits 0. Otherwise
   fix the failing provider and run it again (it is safe to re-run).
4. Remove `AUTH_CONFIG_ENCRYPTION_KEY_PREVIOUS` and redeploy.

`BETTER_AUTH_SECRET` is a different secret: it signs session cookies and
encrypts TOTP secrets and backup codes. Replacing it outright signs everyone out
and breaks every operator's 2FA. Rotate it with BetterAuth's versioned
`BETTER_AUTH_SECRETS` (`2:new,1:old`) so old values still decrypt. Detail:
[`sso.md`](../../authentication/sso.md).

## Staff off-boarding

There is no permanent removal or role demotion in the app yet. To cut an
operator off:

1. An ADMIN opens **Team**, picks the operator and chooses **Suspend**, with a
   reason (at least 5 characters) and a duration of 1–365 days.
2. Suspend bans the account and deletes every session in one step, so access
   ends on the operator's next request. It refuses to suspend yourself or the
   last ADMIN, and writes an `OpsActionLog` row.
3. The ban lapses at the first sign-in after its expiry. Put a calendar
   reminder on the end date and suspend again, or change the role in the
   database, until a permanent off-boarding action ships.

**Reactivate** on the same page lifts a suspension early. Detail:
[`staff-onboarding.md`](../../authentication/staff-onboarding.md).

## Lost authenticator (admin 2FA reset)

1. The operator can still sign in with a **backup code** (each works once)
   and generate fresh codes in their 2FA settings. Operators cannot turn 2FA
   off, so moving to a new authenticator needs the reset below.
2. If no backup code is left, confirm their identity **out of band** (video
   call, manager confirmation). Whoever holds the password when 2FA is reset
   enrols the new authenticator.
3. An ADMIN opens **Team** and chooses **Reset 2FA** with a reason. This deletes
   the stored TOTP secret and backup codes, clears `twoFactorEnabled` and ends
   every session for that operator. It is audited as `team.member.reset-2fa`.
4. The operator signs in with their password and is sent straight to
   `/auth/two-factor/setup`; nothing else is reachable until they enrol.

If the **only** ADMIN loses their authenticator, nobody can open Team. Recovery
needs direct database access (delete their `TwoFactor` row and set
`twoFactorEnabled = false`, then delete their sessions). `scripts/bootstrap-admin.ts`
cannot help: it refuses once any ADMIN exists. Keep at least two ADMINs.
