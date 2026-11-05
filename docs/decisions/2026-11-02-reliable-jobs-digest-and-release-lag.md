# ADR: Reliable background jobs: a daily ops digest, release lag and build-time job coverage

- **Status**: Accepted on 2026-11-02 (all nine decisions of issue #2547, each on the recommended option). Ships in the pull request that adds this record. Creating the digest heartbeat, the GitHub token and the Sentry uptime monitor were owner steps; their 2026-11-05 outcome is in the follow-up record.
- **Date**: 2026-11-02
- **Author**: Platform engineering
- **Related**: [Job freshness is derived from the schedule](2026-11-02-job-freshness-from-schedule.md) (phase 1), [Better Stack setup guide](../maintenance/00-betterstack-setup.md#daily-ops-digest-and-its-heartbeat) (the runbooks), [Money go-live checklist](../finance/70-operations/07-go-live-checklist.md), [Observability gaps and launch posture](2026-11-01-observability-gaps-and-launch-posture.md), [Sentry is escalations only](2026-10-31-sentry-escalations-only.md)
- **Follow-up**: [2026-11-05-detector-rollout-and-redundancy.md](2026-11-05-detector-rollout-and-redundancy.md) (the owner steps as carried out, with the live monitor inventory)

## Context: every alert fired on a failed run, none on a missing one

In October 2026 fourteen scheduled jobs stopped for two to six weeks and nothing alerted. The schedule-derived freshness probe (phase 1) closed the largest gap: a ticker job that stops running now turns `/api/health/jobs` to 503. Four kinds of silent failure were still open:

- **Parked and forgotten.** A job that skips because a setting is missing (`PLATFORM_GSTIN not configured`) counts as reached, so the probe stays green for as long as the setting stays missing. Mail held by `EMAIL_DELIVERY_MODE`, a muted Better Stack alert and an idle-only job leave no signal anyone reads.
- **Merged but not live.** A fix can sit on `dev` for days. A freshness probe that reads the deployed schedule cannot see a job that exists only in undeployed code.
- **Checks that need Actions.** The registry-to-schedule drift test runs only when GitHub Actions runs, and Actions refused every job while its budget was spent. The Actions watchdog (`cron-heartbeat.yml`) was refused with the jobs it watched.
- **Row-less targets.** `sentry-ingest-canary` and `stream-control-plane-drift` wrote no run row, so no freshness check could see them.

## Decision

| #   | Decision              | Choice                                                                                                                                                                    |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Paging tiers          | Keep phase 1's split: every target pages except the eleven `WATCHED_TARGETS` housekeeping jobs. New targets page by default.                                              |
| D2  | Second watcher        | Sentry's included free uptime monitor on `/api/health/jobs`.                                                                                                              |
| D3  | Digest                | Daily at 09:00 IST (03:30 UTC), **always sent**, to `OBSERVABILITY_ALERT_EMAIL`. A Better Stack daily heartbeat is pinged only after a successful send.                   |
| D4  | Release-lag source    | The GitHub compare API (`BUILD_SHA...dev`) with a fine-grained, read-only token.                                                                                          |
| D5  | Release-lag paging    | Page when an unreleased schedule or registry change is more than 3 days old, or any unreleased merge is more than 7 days old. Below that it is a digest line.             |
| D6  | `cron-heartbeat.yml`  | Narrowed to the Actions-scheduled workflows (`db-live-drift`, `security-audit`). The Upstash usage alarm moves into the digest.                                           |
| D7  | Standing config skips | A digest line with first-seen age now; the go-live checklist requires zero. Once Razorpay keys are live, a paging-tier skip older than 7 days makes the probe answer 503. |
| D8  | Muted alerts          | The digest lists paused and muted Better Stack monitors with their age; the go-live checklist gets an unmute line for each.                                               |
| D9  | Build-time check      | The pure schedule and requirement invariant check runs inside `npm run build`, so it still guards when Actions is refused.                                                |

Why each choice:

- **D1.** A page must be actionable. A late prune only delays cleanup; a late refund, payout, invoice or reminder harms money, compliance or a customer.
- **D2.** It is free, adds no vendor and puts a second company between the platform and a Better Stack outage.
- **D3.** "Always sent" makes the digest itself a dead-man's switch: a missing email is an incident after the heartbeat's grace, not a quiet day.
- **D4.** Build age alone cannot tell "nothing to release" from "release held". The token is scoped to Contents: read on one repository.
- **D5.** A held release pages within days instead of weeks, and a normal release cadence never trips it.
- **D6.** A watcher must not share the failure domain of what it watches. Actions still schedules two workflows, so a watcher for those is fair, but it must not claim to watch runtime jobs.
- **D7.** `PLATFORM_GSTIN` is legitimately unset before GST registration. After launch a missing GSTIN means no statutory invoices, so it must page.
- **D8.** A muted alert that is never unmuted is exactly the silent failure being designed out.
- **D9.** The check costs well under a second and needs no database, environment or network.

### How it is built

1. **Run rows for the two row-less targets.** Both now take a fail-open `withCronLock` lease, so each run writes a row and gets a paging freshness requirement under its own name. `jobNameFor` no longer returns `null`. An unhealthy canary verdict answers 207 and records an `attention` run, which counts as having run (owner decision, 2026-11-02). The Sentry outage itself stays on the canary's own email and Better Stack line; the probe pages only when the canary stops running. The alternative, a `FAILED` run, would page a second time for the same outage and hold the probe at 503, hiding any other overdue job until it cleared.
2. **One coverage function.** `checkJobCoverage` (`lib/cron/job-coverage.ts`) holds the invariants: every `@cleanup-twin` registry slug is a ticker target or has a `MANUAL_ONLY` reason, every `MANUAL_ONLY` entry is a real, unscheduled job, every target has exactly one freshness requirement under its live `jobNameFor` name with a valid tier, and no requirement names a dead target or job. `npm run build` runs it first through `scripts/maintenance/check-job-coverage.ts`, and the jest suites call the same function.
3. **The digest is one registry job.** `ops-digest` is a ticker target at 03:50 UTC (09:20 IST) with a 24-second timeout. Its core, `runOpsDigest` in `lib/observability/ops-digest.ts`, reads every section one bounded statement at a time (`PG_POOL_MAX=1`), with the vendor reads (Better Stack, Upstash, GitHub) running beside the database reads. A section whose read fails is shown as unavailable; the email still goes. It sends through `deliver()` and only then pings `BETTERSTACK_DIGEST_HEARTBEAT_URL`, or its `/fail` endpoint after a failed send. It never reports to Sentry and never repairs anything.
4. **Release lag is computed by the digest and read from its run row.** The digest calls GitHub once a day and stores `releaseLag` in the summary on its run row (`opsDigestSummarySchema` in `lib/observability/ops-digest-summary.ts`). `/api/health/jobs` reads the newest completed production `ops-digest` row (one indexed read on `jobName, startedAt`) and answers 503 with reason `RELEASE_LAG_OVERDUE` when `releaseLag.overdue` is true. A probe poll never calls GitHub.
5. **"After launch" means live Razorpay keys.** `collectionsAreLive()` (`lib/payments/core/razorpay-key-mode.ts`) is true when `RAZORPAY_KEY_ID` starts with `rzp_live_`. There is no new flag. Only then does a paging-tier standing skip older than 7 days, read from the digest's `standingSkips`, make the probe answer 503 with reason `STANDING_CONFIG_SKIP`.

### Release-lag details

- `BUILD_SHA` is Netlify's build-time `COMMIT_REF`, or `VERCEL_GIT_COMMIT_SHA` on Vercel, inlined by `next.config.mjs` like `NETLIFY`; `/api/health/jobs` shows it as `buildSha`. The Vercel fallback keeps release lag working through a possible host move (owner decision, 2026-11-02). A host with neither variable, such as a Docker build, shows release lag as unknown, which is a digest line and never a page.
- The compare API lists at most 250 commits without pagination and at most 300 files. The choices are conservative, so a truncation can page early but never hides a lag:
  - **Commit list cut short** (`ahead_by` above the commits listed): the lag is overdue. More than 250 unreleased commits is a held release by any measure.
  - **File list at its 300-file limit:** every watched area (`lib/cron/schedule.ts`, `lib/cron/cleanup-registry.ts`, `netlify/functions/**`, `prisma/**`) is reported as touched, and the schedule check runs.
  - **The schedule check reads per file.** The compare API's file list is not per commit, so the digest asks GitHub for the commits on `dev` that touch `lib/cron/schedule.ts` or `lib/cron/cleanup-registry.ts` and keeps the unreleased ones. If that read fails, the oldest unreleased commit stands in for the schedule change.
- A missing `BUILD_SHA`, a missing token or a failed read gives `releaseLag: { status: "unknown", reason }`. It is a digest line, never a page.

## Consequences

- **Owner steps (historical; outcome on 2026-11-05: the digest heartbeat and the Sentry uptime monitor are done, `GITHUB_RELEASE_LAG_TOKEN` is deferred and the Upstash settings are skipped, per the follow-up record).** Create the Better Stack heartbeat "ops digest" (24-hour period, 3-hour grace) and put its URL in production as `BETTERSTACK_DIGEST_HEARTBEAT_URL`. Create a fine-grained GitHub token (Contents: read, this repository only) and put it in production as `GITHUB_RELEASE_LAG_TOKEN`. Copy the four Upstash management settings (`UPSTASH_MANAGEMENT_API_KEY`, `UPSTASH_EMAIL`, `UPSTASH_DATABASE_ID`, `UPSTASH_MONTHLY_COMMAND_CAP`) from the GitHub secrets into production. Create the Sentry uptime monitor on `/api/health/jobs`. Each runbook is in the [Better Stack setup guide](../maintenance/00-betterstack-setup.md#daily-ops-digest-and-its-heartbeat).
- **The digest slot is 03:50 UTC (09:20 IST), not the decided 03:30.** On a month start the 03:30 tick already holds 11 targets, the tested ceiling that keeps one slot free under `MAX_TARGETS_PER_TICK`. 03:50 is the nearest later tick with room.
- **The digest's recipient must be an own-domain address.** `OBSERVABILITY_ALERT_EMAIL` falls back to the support mailbox. If the pre-launch guard holds the digest, the send fails, the heartbeat gets `/fail` and Better Stack raises an incident.
- **Clearing a standing-skip or release-lag page.** Both verdicts come from the newest digest row. After fixing the setting or shipping the release, run `ops-digest` once from the System Jobs page to clear the 503 instead of waiting for the next day.
- **Muted Better Stack Telemetry alerts are not read.** The digest reads Uptime monitors and heartbeats through `BETTERSTACK_API_KEY`. The SQL backlog alerts live in Better Stack Telemetry, whose mute state that key cannot read, so the go-live checklist keeps an explicit unmute line for them.
- **Idle-only jobs are standing items before launch.** Most probe-gated jobs find no work on mock data, so the digest lists them collapsed in one line with their last real run. The headline is not "All clear" until real traffic, or until each is accepted as idle by design.
- **The probe keeps `CRON_SECRET` (owner decision, 2026-11-02).** Sentry stores uptime-monitor headers unmasked, and the same secret can run every job through `/api/cleanup/[job]`. A dedicated read-only probe secret was offered and declined: jobs are idempotent and CAS-guarded, and one secret is simpler to rotate. Rotate `CRON_SECRET` if either vendor's monitor settings leak.
- **Costs.** One email a day, one Better Stack heartbeat (6 of the 10 free monitors), three GitHub API calls a day and about 25 bounded database statements a day.

## Deprecated & Superseded Approaches

- **`cron-heartbeat.yml` as the fleet's dead-man's switch.** It ran on Actions, so it stopped with the jobs it watched when the Actions budget was spent. It now watches only the Actions-scheduled workflows. Its Upstash usage alarm moved into the digest, and its write of the Redis `cron:heartbeat:last` key was removed; `withCronLock` refreshes that key on every completed run.
- **`jobNameFor` returning `null` for row-less targets.** Every target now writes a run row. Do not reintroduce a target whose healthy run leaves no evidence.
- **The scheduler-drift test's text scan of `cron-*.yml` workflows.** No registry job is scheduled by a workflow any more; the coverage function checks ticker targets and `MANUAL_ONLY` only.
