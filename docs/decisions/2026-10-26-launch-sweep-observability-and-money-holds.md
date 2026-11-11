# ADR: Launch sweep decisions — money holds, tax identity, abuse controls and operational visibility

- **Status**: Accepted. Thirteen decisions are recorded in full below, and the implementation of most is in pull requests that are still open, labelled on each decision. ADR-12 is a pointer: its rules live in the workflow skill.
- **Date**: 2026-10-26
- **Author**: teetangh
- **Related**: [Job machinery catalog and dashboard spec](../maintenance/11-job-machinery-catalog.md), [Session outcomes](2026-09-25-session-outcomes.md), [Ingest canary and the 2026-09-22 quota outage](../observability/sentry/06-ingest-canary.md), [Cron, sidecars and reconciliation reference](../maintenance/10-cron-and-reconciliation-reference.md)

The owner took these decisions on 2026-10-26 while sweeping the launch-blocking infrastructure issues. They fall into four groups: what the platform does with money when it cannot tell what happened (decisions 1 to 3), who the platform is on a tax document and how it defends its sign-up and sign-in (4 and 5), how an operator learns what the platform did and did not do (6 to 9, plus 13, which the owner added on 2026-10-27), and how the code reaches production safely (10 to 12). Each decision has its own Status, Context, Decision, Alternatives and Consequences. Where the code is not on `dev` yet, the Status says which open pull request carries it, and the Decision describes the accepted behaviour, not the behaviour of `dev` today. Each claim about a pull request was checked against its diff at the head commit named in the References.

## Decisions

### ADR-01. A paid session nobody joined is held for a human

- **Status:** Accepted — implementation in PR #2421 (open).
- **Context:** `AWAITING_HUMAN` in `lib/booking/misses.ts` matched only sessions with an `INCONCLUSIVE` or `HOST_ABSENT` outcome, or a maintenance cut. A session whose outcome was `NOBODY_JOINED` or `OFFLINE` was written as `UNVERIFIED`, so `auto-complete-appointments` completed the booking and `release-earnings` released its earnings when the hold expired. The doctrine in the session-outcomes record says a doubtful verdict never moves money automatically. A consultation where nobody joined also raised a support ticket from the no-show detector (`detectBothAbsent`), which gave the same case a second human path.
- **Decision:**
  - A session with a `SUCCEEDED` payment on any rail, including card, credits and organisation wallet, invoice or licence funding, whose outcome is `NOBODY_JOINED` or `OFFLINE` is held in the needs-human queue. It is never auto-completed, auto-released or auto-refunded.
  - A free session, such as an unpaid trial, still completes, because there is no money to protect.
  - `detectBothAbsent` is removed, so there is no automatic both-absent support ticket.
  - The one predicate in `AWAITING_HUMAN` controls auto-complete for all five products, the earnings hold, the subscription void-settle guard and the ops "Sessions that need a decision" card. The existing **Set outcome** door (`session.set-outcome`) is the way out: an attended outcome completes the session and lets earnings release, and a void outcome hands it to `settle-cancelled-sessions` for a make-up or refund.
- **Alternatives considered:**
  - Auto-refund the consultee when nobody joined: a connectivity failure and a no-show look identical to a script, so the platform would refund the wrong party. Rejected by the owner.
  - Keep the support-ticket pass as well: two human paths for one case. Rejected.
- **Consequences:**
  - One undecided paid session holds its whole subscription or class until ops decides.
  - A human must work the queue. The existing alert for needs-human items older than 72 hours stays the backstop.
  - The result of `detect-consultant-no-shows` loses `bothAbsentTickets`.

### ADR-02. Consumer tax invoices are healed by a bounded job

- **Status:** Accepted — implementation in PR #2421 (open).
- **Context:** A consumer tax invoice is minted after capture on a best-effort basis. A capture that happened while `PLATFORM_GSTIN` was unset, or a crash after the commit, left a paid payment with no invoice, and the only healer was the monthly GST register export, which looks only at the previous month. Invoice numbers come from a gapless series (Rule 46), so a second runner or a crash mid-mint must not burn a number. Dev and prod share one database today (tracked in the cutover and environment-separation issues), so a healer that mints real-series invoices for test payments would pollute the statutory series.
- **Decision:**
  - A new job `heal-consumer-invoices` mints the invoice for `SUCCEEDED` consumer payments that have none, created in the last 90 days and not updated in the last 15 minutes.
  - It runs every 6 hours at 01:50, 07:50, 13:50 and 19:50 UTC, with 25 payments per run, reading from a random id pivot that wraps around so a payment the mint keeps declining cannot starve the rest.
  - Its lease is fail-closed. Each payment is minted in its own transaction, and a loser of the race with the capture path hits the `paymentId` unique and rolls back with its counter, so the series keeps no gap.
  - A payment with a `PENDING` or `SUCCEEDED` refund is excluded and left to ops, because a refunded supply needs its invoice and credit note together.
  - A missing `PLATFORM_GSTIN` is a config skip that warns once per UTC day.
  - `PLATFORM_GSTIN` must be set only after the pre-cutover database reset, so that the healer cannot mint real-series invoices for test payments.
  - The 14 consumer invoices and the 5 non-draft organisation invoices minted under the old supplier identity are test data and are removed by that reset.
- **Alternatives considered:**
  - Leave the register export as the only healer: a failure stays invisible for up to a month. Rejected.
  - Mint on a short cadence without a bound: a 15-minute cadence does not fit the ticker's ten-target cap on its busiest ticks.
- **Consequences:**
  - The target joins `FINANCIAL_JOB_NAMES`, so the DEGRADED maintenance phase also holds it.
  - Refunded payments without an invoice stay a manual job until ops mints them.
  - The cutover checklist gains a hard ordering: reset the database, then set `PLATFORM_GSTIN`.

### ADR-03. A wallet freeze from ledger drift releases itself, and only that freeze

- **Status:** Accepted — implementation in PR #2421 (open).
- **Context:** `reconcile-ledgers` freezes the spend of a billing account whose wallet cache disagrees with the journal. The freeze could only be lifted from the admin door, and the drift page was keyed by report id, so the same single account paged fatally on 22 and 23 October.
- **Decision:**
  - Only a freeze tagged `context.source = "reconcile-drift"` is released automatically, and only when the reconcile snapshot that found the cache equal to the journal pinned that exact latest freeze event. The release is the existing compare-and-set `unfreezeWalletSpend`, in a Serializable transaction, with the actor `SYSTEM`.
  - Ops freezes (such as a refund-remaining freeze) and untagged legacy freezes are never released automatically.
  - The drift page is keyed by billing account, with the existing weekly reminder, so an ongoing drift pages once.
- **Alternatives considered:**
  - Release every freeze once the cache matches: it would lift a freeze an operator placed on purpose.
  - Keep the manual-only release: a transient mismatch blocks an organisation's checkout until someone notices.
- **Consequences:**
  - A concurrent re-freeze wins: the compare-and-set sees a different latest event and releases nothing.
  - The freeze source is a new key inside the existing event context, so no schema change is needed.
  - The fatal page itself still lives in the scheduled door's registry entry and not in the audit core; moving it is left for later.

### ADR-04. One legal identity on every tax document

- **Status:** Accepted — implementation in PR #2423 (open).
- **Context:** GST invoices, credit notes and e-invoice (IRP) payloads named "Familiarise Technologies Private Limited" at a Bangalore address with Karnataka as the supplier state, while the public pages named Practitionist (OPC) Private Limited in Haryana. The supplier state also came from a separate `SUPPLIER_STATE_CODE` setting that could disagree with the GSTIN.
- **Decision:**
  - Every GST invoice, credit note and IRP payload carries Practitionist (OPC) Private Limited, registered in Haryana, from `lib/company.ts`.
  - The supplier state is the first two digits of `PLATFORM_GSTIN`, and it must be `06`. Until a GSTIN is set it falls back to the registered office's state. A GSTIN from another state fails closed: no consumer invoice is minted, organisation invoices answer 503 and the IRP uploader skips its run.
  - `SUPPLIER_STATE_CODE` is removed.
- **Alternatives considered:**
  - Keep "Familiarise Technologies, Bangalore" as the supplier: it is not the registered entity. Rejected by the owner.
- **Consequences:**
  - The supplier state moves from Karnataka (29) to Haryana (06), which flips CGST plus SGST against IGST for every document issued after the deploy.
  - Organisation invoices store no supplier snapshot, so already-issued ones re-render under the new identity; consumer invoices snapshot the supplier and keep theirs. The five non-draft organisation invoices and 14 consumer invoices on the shared database are test data and are removed by the cutover reset (ADR-02).
  - The owner must confirm that the GSTIN's principal place of business is the registered office, and delete `SUPPLIER_STATE_CODE` from Netlify and the GitHub secret store.

### ADR-05. Bot and abuse controls on the mail-sending auth endpoints

- **Status:** Accepted — implementation in PR #2423 (open).
- **Context:** Sign-up, password-reset request and verification resend send mail to an address the caller types. They had per-IP limits and undocumented hourly caps only, so a distributed attacker could use the platform to mail strangers or lock an owner out of sign-in.
- **Decision:**
  - **Captcha.** Cloudflare Turnstile through Better Auth's captcha plugin guards sign-up, password-reset request and verification resend only. Sign-in is not captcha-gated. If the keys are missing, the plugin is not installed and the runtime logs one loud warning per cold start instead of failing to boot. A Cloudflare outage fails those three endpoints closed, and sign-in keeps working.
  - **Mail cap.** At most 5 mails per recipient per auth-mail type per rolling day, for email verification, password reset and the existing-account notice. The key is a hash of the lower-cased address, the cap fails open, and staff invitations are exempt.
  - **Sign-in throttle.** Failed sign-ins are counted per submitted address. Ten failures cost a 30-second wait and twenty a 2-minute wait, for that address from anywhere. A 15-minute wait applies only to the address together with the caller's network prefix (/24 for IPv4, /48 for IPv6), so a stranger can never hold an owner out for longer than two minutes.
- **Alternatives considered:**
  - A mail cap and rate limits only, with no captcha: they do not stop a distributed sender.
  - Defer the work until after launch: the sign-up and reset endpoints are the cheapest abuse surface.
- **Consequences:**
  - A Turnstile outage stops sign-up, reset and resend until it recovers.
  - A missing key in production disables the captcha rather than the site; the per-IP budgets, the mail cap and the pre-launch email delivery guard still bound abuse.
  - Preview deployments need Cloudflare's test keys, and the production hostname must be the `BETTER_AUTH_URL` host.

### ADR-06. Observability has three layers, and the third is built from our own tables

- **Status:** Accepted — implementation in PR #2422 (open).
- **Context:** Sentry cannot say what happened to one customer's refund when nothing threw, and cannot say a job never ran. The free plan also caps errors at 5,000 a month, so it cannot hold a record of every row a sweep touched.
- **Decision:**
  - Sentry answers "what failed".
  - Better Stack, through its heartbeats on `/api/health/jobs` and the ticker's per-tick summary, answers "what did not run".
  - The back-office entity trace and the per-job run metrics answer "what happened to this payment". They are built from the platform's own Postgres audit tables, as a read-only run tree for business entities in the style of an LLM trace viewer.
- **Alternatives considered:** Using Sentry for all three: the quota and the missing per-row detail rule it out.
- **Consequences:**
  - The entity trace merges about fifteen tables with one bounded query per source, read in sequence because of the single-connection pool.
  - A traced row does not record which job run wrote it, so the trace cannot yet link to a run (gap 6 of the machinery catalog).

### ADR-07. The operations dashboard extends the back-office

- **Status:** Accepted — design in issue #2424; the build happens in a later session.
- **Context:** The platform needs a tick-level and run-level view for admins, an operations health summary for staff, and later an organisation money timeline. Roles and tenant scoping already exist in the back-office.
- **Decision:** Build the dashboard inside the existing back-office, with the job machinery catalog as its specification. Panels, their data sources and the fields that must be recorded first are in section 5 of [the catalog](../maintenance/11-job-machinery-catalog.md) and in [issue #2424](https://github.com/Practitionist/familiarise_web/issues/2424).
- **Alternatives considered:**
  - Grafana Cloud on a read-only Postgres role: another vendor would hold database credentials, it adds load on the shared database, and it has no access model matching staff, admin and organisation roles.
  - Better Stack dashboards: the free tier keeps data briefly and offers no per-entity drill-down.
  - Self-hosted Prometheus: it needs a long-running scraper that the serverless deployment does not have.
- **Consequences:**
  - The dashboard is pull, not push. Alerting stays in Sentry and Better Stack.
  - Panels that need run content wait for the run's summary to be stored (gap 1 of the catalog).

### ADR-08. A ticker target failure escalates only on repeats

- **Status:** Accepted — implemented and merged to `dev` in PR #2420.
- **Context:** The ticker reported every failing target as a Sentry error, at most once an hour. A one-off failure is often Netlify's own 500 page with a Request ID, not a bug, and each new error issue sends an email and spends free-plan quota. The ticker keeps no state between ticks.
- **Decision:**
  - A one-off target failure is written to the Better Stack per-tick summary line and to one grouped Sentry warning with fingerprint `cron-tick` / `target-failed-once`, the target in its `target` tag, marked `class: platform` when the body is Netlify's own error page.
  - A target becomes a Sentry error, fingerprinted per target, only when it has had no `COMPLETED` run for three times its own cadence. The ticker reads that history from the new bearer-protected, read-only `GET /api/health/jobs/streaks`, which returns each requested job's last `COMPLETED` start time from `SystemJobExecution`. An unreachable endpoint, or a job with no recent rows, counts as a one-off. Reports stay limited to one per target per hour.
  - The `cron-tick` Sentry monitor (5-minute schedule, 3-minute margin, failure threshold 3, recovery threshold 1, approved by the owner and drill-verified) still catches the ticker going silent. Its configuration is unchanged.
- **Alternatives considered:**
  - An error on every failure: noise, and an email per new issue.
  - Dropping per-target captures altogether: a persistently broken target would be invisible except in logs.
  - Counting consecutive failing ticks in Redis: a failure counter is outside the allowed uses of Redis, and the ticker keeps no state.
- **Consequences:**
  - A platform 5xx leaves no `SystemJobExecution` row, so the test is the absence of a recent `COMPLETED` run and not a run of `FAILED` rows.
  - The escalation reads `COMPLETED` rows, so a job whose row says `COMPLETED` while its HTTP answer fails (gap 7 of the catalog) is never escalated. Fixing the verdict divergence is a prerequisite for the escalation to be complete.

### ADR-09. Sentry quota posture on the free plan

- **Status:** Accepted — on `dev` already, except the boot-warning rule, whose first user is in PR #2423 (open). The preview rule merged in PR #2420.
- **Context:** On 2026-09-22 the plan's 5,000-error monthly allowance was spent and error ingestion stopped for six days (see the ingest-canary page). The owner's accounting of the causes is approximate: the Upstash request-cap reports in `dispatch-outbound-webhooks` (about 2,650), per-run reconciler warnings (about 1,150), `CronLockUnavailableError` (about 1,350), the ingest canary every 30 minutes (about 1,440 a month) and report-only CSP reports. The fixes shipped as #1938, #2129, #2130, #1935 and #2321. The owner reports usage on 2026-10-26 of about 225 errors in 7 days.
- **Decision:**
  - Errors are sent once per run with fixed fingerprints.
  - Expected conditions go to logs, not issues.
  - Config-skip warnings are deduplicated to about one a day, by warning only on the first slot of a job's window.
  - The ingest canary runs every 6 hours, and its issue is archived forever and never resolved.
  - Previews send errors only, never warnings, and boot-time configuration warnings report only in production.
- **Alternatives considered:** Upgrading to the Team plan: it removes the pressure without removing the noise, and the owner rejected it.
- **Consequences:**
  - A job that must be seen cannot rely on a Sentry warning; it needs a durable row or an alert on another channel.
  - The seven jobs that reported once per row now collect failures and report once per run (section 4.2 of the catalog).
  - **Superseded in part (2026-11-11).** The rejection of the Team plan no longer stands. The owner decided on 2026-11-11 to buy Sentry Team at launch or on a quota trigger; the trigger is kept in Notion (Familiarise / Finance and Pricing / Vendors & Spend). The reporting rules above stay in force whatever the plan, because they also keep the noise down. See [the 2026-11-11 levers record](2026-11-11-cfo-csmo-levers.md).

### ADR-10. The apex `netlify.app` host redirects to `familiarisenow.com`

- **Status:** Accepted — implemented and merged to `dev` in PR #2420.
- **Context:** The apex `familiarise.netlify.app` host is not a trusted authentication origin, so Better Auth answers `Invalid origin` there.
- **Decision:**
  - `netlify.toml` redirects that single host to `https://familiarisenow.com` with a forced 301. Deploy-preview and branch-deploy hosts are different hostnames and are unaffected.
  - Webhook URLs must use `familiarisenow.com`, because a 301 drops a POST body.
  - Branch deploys need `BETTER_AUTH_TRUSTED_ORIGINS` set in the branch-deploy context to sign in.
- **Alternatives considered:** Adding the apex host to the trusted origins: it keeps a second public origin alive.
- **Consequences:** No vendor webhook may target the apex host. An existing webhook configured there loses its body silently, so the vendor configurations must be checked once.

### ADR-11. Code must not reach production before its DDL

- **Status:** Accepted — the promotion gate is tracked in issue #2405 (open).
- **Context:** One Postgres database serves every environment, and schema changes are applied by hand. Sentry `FAMILIARISE_WEB-7A` was a preview deployment reading `maintenance_windows.betterstackIncidentId` before that column existed in the shared database. `FAMILIARISE_WEB-7B` was the production ticker target `support-sla-sweep` answering 500 from 20 to 23 October; the owner attributes it to the same cause.
- **Decision:** A release promotion to production must be blocked while the live schema drifts from `prisma/schema.prisma` and the sidecar SQL. The gate is tracked in #2405. Until it exists, the person promoting a release runs the read-only drift check first and applies the SQL before the code.
- **Alternatives considered:** Rely on the human-run `db:push` preflight alone: it has already been skipped once.
- **Consequences:** A release can be held by a schema difference nobody caused in that release. The additive-only, nullable-column posture stays the rule so that the old code keeps working against the new schema.

### ADR-12. The merge protocol for parallel agent trains

- **Status:** Accepted — recorded as agent-facing doctrine in [the workflow skill](../../.claude/skills/workflow/references/merge-protocol.md) rather than here.
- **Context:** Several agents work safety pull requests in parallel, and uncontrolled merges produced stale approvals and a flood of pull requests.
- **Decision:** See the reference for the rules: a safety pull request merges only on a matching `READY TO LAND` comment, in the agreed order; the reviewing agent verifies, reviews at medium depth and squash-merges; issues are closed by hand only for four named reasons, always with an evidence comment; and pull requests are bucketed by theme.
- **Alternatives considered:** An ADR was considered, but the rule is operating procedure for agents and belongs next to the other process references.
- **Consequences:** The procedure is edited in one place.

### ADR-13. The operations console: a needs-attention inbox, audited controls, an integrity panel and a per-item run log

- **Status:** Accepted on 2026-10-27. The design is recorded in #2424. **Status note, 2026-10-27:** Phase 1 ("record the truth") is implemented. It covers the real outcome vocabulary (`completed`, `attention`, `partial`, `failed`, `held`, `skipped`, `refused`, `paused`), the stored summary, `itemsProcessed` and `errorCount`, zero-duration rows for held, refused and skipped runs, the per-run counters, the run id and tick id (`job_run_id` Sentry tag, `context.jobRunId` on system events, `x-tick-id`), a watched tier of 16 money SLOs, the registry-driven in-process admin Run door (which repeats a windowed job's latest due window, audits by the recorded outcome and keeps maker-checker on both payout rails), and the retention jobs moved to the ticker. Phases 2 and 3 remain to be built: Pause/Resume and Retry failed items, the needs-attention inbox and job health table, the per-item table and the Run detail page.
- **Context:** Today's System Jobs page is a grid of Run Now buttons plus the last ten runs, and every run there reads "Completed". The job machinery catalog (document 11 in `docs/maintenance`) shows why: a run row records only a narrow result. Partial runs, failed runs and config skips can still be stored as COMPLETED. Held runs and skipped runs leave no row at all. Nothing links a run to the payments, refunds or payouts it touched. Operators therefore cannot answer the root-cause questions that support needs answered, such as which run tried a given refund, what the gateway said, and whether the refund is stuck.
- **Decision:**
  - **Four levels in the back-office:**
    - an Overview, with ticker liveness, capability tiles, a Needs attention list and the Integrity panel;
    - a Jobs table, which replaces the card grid;
    - a Job detail page;
    - a GitHub-Actions-style Run detail page.
  - **Admin-only, audited controls:**
    - Run now, which runs one bounded slice;
    - Drain, which repeats slices until nothing is left, inside a time budget;
    - Pause and Resume, a database flag the ticker checks before it dispatches, with a reason and an optional auto-resume time;
    - Retry failed items, which requeues specific owed items and is not a blind re-run.
    - There is no hard Stop, because a running serverless invocation cannot be killed from outside.
  - **Integrity panel:** it shows the reconcilers' latest findings. Each run also records counters for lost compare-and-swap claims, serialization retries, deadlock and lock timeouts, pool timeouts and lease takeovers, and a spike appears in Needs attention. Postgres constraints and CAS transitions keep preventing bad states; the panel only shows evidence.
  - **Per-item run log (superseded 2026-11-01, not built):** a new `SystemJobRunItem` table holds one row for each entity whose state a run changed or that a run failed on, with the outcome, a reason code, the attempt number and a short error. Rows are kept for 90 days.
    - An entity becomes STUCK, a computed state that is not stored, after it fails in consecutive runs or after its owed marker ages out.
    - Raw log lines stay in Better Stack, tagged with the run id.
  - **Delivery order:**
    1. Record the truth first: real outcomes, the stored summary, held and skipped runs, and the counters. No DDL is needed for this step.
    2. Build the controls and the Overview.
    3. Add the per-item table and the detail pages.
- **Alternatives considered:**
  - Prometheus with Grafana: there is no long-running process to scrape, and it has no per-entity drill-down.
  - Grafana Cloud reading Postgres: it adds a second tool and another vendor holding database credentials.
  - A simpler single table: it cannot answer per-entity root-cause questions.
  - Grouped analytics only: rejected for the same reason.
- **Consequences:**
  - One schema change.
  - Roughly a few thousand item rows a day, under a retention job.
  - Every money and recovery job must report its touched items through one `createMany` per run.
  - The Entity trace gains a "touched by run" row for each attempt.
- **Amendment 2026-10-28 (owner decision, re-scoping Phases 2 and 3 around "which item failed and why"):**
  - **Principle.** Sentry and Better Stack fix the system: one grouped issue per failure class, with a sample of ids. The console fixes the customer: for one user's stuck refund, payout or dispute, an operator sees the specific item, why it failed and what was tried, then remediates through the audited money doors and the linked support case. Both are needed. The console is therefore a failed-items list plus a run log, not a metrics dashboard.
  - **Why Sentry cannot do this job.** A cron failure in Sentry is one grouped issue per failing step (the fingerprint is the subsystem and the operation, from `createRunFailureReporter`), and `extra.sample` holds at most ten failed ids. It carries no user identity, because identity is stamped only on request-scoped events. Better Stack receives one aggregate line per tick. The per-item truth lives in Postgres: domain columns now, `SystemJobRunItem` later. The run id (the `job_run_id` Sentry tag and `SystemEvent.context.jobRunId`) links the three.
  - **Phase 2 (no DDL)** is a "Needs attention" inbox of failed or stuck items, not of counters: refunds owed and retired, payouts `PROCESSING` or `FAILED`, unpaid invoice captures, dead-lettered emails and recording copies. It is built from existing domain columns (owed markers, attempt counts, `failureReason`, statuses and ages). Each row shows the reason, the attempts, the age, a Retry door where one is allowed (payouts are covered by #2433) and a link to the Entity trace.
  - **The inbox is registry-driven (planned).** An "owed-work source" registry declares, per source, its stuck-item query, its reason field, its age limit and its remediation door, in the same way `lib/cron/cleanup-registry.ts` drives jobs. Adding a source is one registry entry, never a hand-coded panel per job.
  - **Job health table.** Each job shows its last real outcome, its age, its backlog, its SLO tier, Run and Pause. **Drain is dropped**: Run now plus Pause and Resume cover the need. The p50 and p95 durations move to a collapsed Performance tab.
  - **Sub-tabs.** The console uses sub-tabs, in the same pattern as the support inbox: Overview (the inbox), Jobs, Runs, Integrity and Performance. This replaces the "four levels" navigation above for Phase 2; the Run detail page arrives in Phase 3.
  - **Phase 3 (DDL)** (superseded 2026-11-01, not built) was unchanged here: `SystemJobRunItem` and Run detail give the attempt history for each item. Phase 1 already records the outcomes, summaries, item counts and run ids that these views read.
- **Superseded 2026-11-01:** the per-item run log (`SystemJobRunItem`) and Phase 3 DDL are rejected. Per-item history goes to batched Better Stack events instead; see the [2026-11-01 observability ownership decision](2026-11-01-observability-ownership.md). Until traction it is `SystemJobExecution.result.failures`, and the Stuck work inbox is built read-only ([2026-11-01 gaps decision](2026-11-01-observability-gaps-and-launch-posture.md)).

## References

- Pull requests, checked at these head commits: #2420 `dde4fab5e`, #2421 `4bb921760`, #2422 `3aefee918`, #2423 `22a889b24`. Re-verify a decision against the merged diff before relying on it.
- Issues: #2171 (ADR-01), #2161 (ADR-02), #2169 (ADR-03), #2331 (ADR-04), #2065 (ADR-05), #2424 (ADR-07, ADR-13), #2165 and #2163 (ADR-08), #2405 (ADR-11), #2092 and #1873 (the cutover and the database split).
- Evidence for ADR-11: Sentry issues `FAMILIARISE_WEB-7A` and `FAMILIARISE_WEB-7B`.

## Deprecated & Superseded Approaches

| Superseded approach                                           | Why it was superseded                                                      | What to do with residue                                                                  |
| ------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `detectBothAbsent` and the both-absent support ticket         | A second human path for a case the needs-human queue already owns (ADR-01) | Delete the function, `bothAbsentTickets` and the test cases once the pull request merges |
| The register export as the only consumer-invoice healer       | It looks only at the previous month (ADR-02)                               | Keep its healer call; it becomes a backstop                                              |
| Wallet-drift page keyed by report id                          | The same account paged on consecutive days (ADR-03)                        | Replace with the per-account key                                                         |
| `SUPPLIER_STATE_CODE`                                         | The supplier state is now derived from the GSTIN (ADR-04)                  | Remove it from the environment, the GitHub secrets, the sample file and any workflow     |
| Hardcoded "Familiarise Technologies, Bangalore" supplier text | Not the registered entity (ADR-04)                                         | Read the identity from `lib/company.ts` only                                             |
| Undocumented hourly `rl:mail` caps in `lib/auth.ts`           | One per-recipient daily check now applies to every auth send (ADR-05)      | Delete the old limiters when the pull request merges                                     |
| A Sentry error for every failing ticker target                | Noise and email per new issue (ADR-08)                                     | Use the grouped warning and the streak test                                              |
| A Drain control and a percentile-first Overview (ADR-13)      | The console answers "which item failed", not "how fast" (amendment)        | Do not build Drain; keep p50 and p95 on the Performance tab                              |
| The `SystemJobRunItem` per-item run log (ADR-13 Phase 3)      | Rejected by the 2026-11-01 observability ownership decision                | Do not create it; per-item history goes to batched Better Stack events                   |
