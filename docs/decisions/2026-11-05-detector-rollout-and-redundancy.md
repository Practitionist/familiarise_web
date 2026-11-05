# ADR: Detector rollout, vendor redundancy and the secret and operations rules behind them

- **Status**: Accepted on 2026-11-05. It records the owner steps of the two 2026-11-02 records as carried out, plus the operating decisions taken while doing them. No code changes.
- **Date**: 2026-11-05
- **Author**: Platform engineering
- **Related**: [Job freshness is derived from the schedule](2026-11-02-job-freshness-from-schedule.md), [Reliable jobs: digest and release lag](2026-11-02-reliable-jobs-digest-and-release-lag.md), [How we know a job did not run](../start-here/08-how-we-know-a-job-did-not-run.md) (the explainer), [Better Stack setup guide](../maintenance/00-betterstack-setup.md) (the runbooks), [Observability system design](../observability/00-system-design.md), [Observability gaps and launch posture](2026-11-01-observability-gaps-and-launch-posture.md). Design issue: #2547. Incident: #2546.

## Context: the detectors were designed, then they had to be made real

The two 2026-11-02 records put the code in place: a probe that derives job freshness from the schedule, a daily digest, release lag, and a build-time coverage check. They left the vendor side as owner steps, because the code never creates vendor monitors. Production was released on 2026-11-04, and on 2026-11-05 the owner steps were carried out and checked against the live vendors and the live database. This record keeps three things that the earlier records could not: what exists now, the decisions taken while creating it, and the lessons from what went wrong on the way.

### What was found

- **A created-paused monitor looks configured and detects nothing.** The Better Stack heartbeat for the ticker had been created paused on 2026-10-30 and sat paused until it was unpaused on 2026-11-03. For about four days a dead ticker would have alerted nobody, although the monitor existed in the dashboard and the environment variable was set.
- **The Sentry uptime monitor duplicated Better Stack.** It had been created against the homepage, which Better Stack already watches, so it added no second opinion on the question that matters (did the jobs run).
- **The first slot of a windowed job can hold the probe red.** After the release, the probe answered 503 `JOB_OVERDUE` for exactly two jobs, `consent-retention-sweeper` and `tds-return-draft` (run-row name `tds-26q-draft-export`). Both are weekly or quarterly windows that had never run since runs were tagged with an environment, so there was no production-tagged evidence inside the budget.
- **Nobody could read `CRON_SECRET`.** It is a write-only Netlify secret. Every surface (the CLI, the API, the dashboard) shows `****`, and GitHub secrets are write-only too. The monitors needed its value as a bearer header.

## Decision

| #   | Decision                | Choice                                                                                                                                                                                                                 |
| --- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Redundancy shape        | The same probe is watched by two vendors, and the ticker is watched by two vendors. The digest is watched by one vendor, because the digest email is itself the human-facing signal.                                   |
| R2  | Sentry uptime monitor   | Repointed from the homepage to `/api/health/jobs` and renamed `familiarise job fleet probe (second watcher)`.                                                                                                          |
| R3  | Verify state, not shape | A monitor counts as done only when its status reads `up` (or healthy). Existence in a dashboard is not evidence.                                                                                                       |
| R4  | Running a job by hand   | From a terminal with `curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://familiarisenow.com/api/cleanup/<registry-key>`, which prints the job's JSON result.                                                 |
| R5  | `CRON_SECRET` handling  | Rotate, never retrieve. A new value was set for the production context only, effective from the 2026-11-04 release deploy, and one copy lives in the owner's password manager. One secret serves jobs and both probes. |
| R6  | Creating monitors       | With each vendor's API or CLI, with secrets piped on stdin, never typed into a dashboard or a shell line.                                                                                                              |
| R7  | Release-lag token       | Deferred. `GITHUB_RELEASE_LAG_TOKEN` stays unset; the digest shows "release lag unknown".                                                                                                                              |
| R8  | Upstash management keys | Skipped. The digest shows "Upstash usage unknown".                                                                                                                                                                     |
| R9  | Digest recipient        | `OBSERVABILITY_ALERT_EMAIL` stays unset, so `canaryAlertRecipient()` (`lib/observability/ingest-alert.ts`) falls back to `supportEmail()`. Revisit at launch.                                                          |

### Live evidence on 2026-11-05

This is dated evidence, not permanent truth. Re-run the reproduction steps in the [explainer](../start-here/08-how-we-know-a-job-did-not-run.md#7-how-to-reproduce-the-verification-yourself) before relying on any of it.

**Monitors that existed**

| Vendor and kind           | Name (id)                                                | Watches                                 | Settings                                                                                                                                                |
| ------------------------- | -------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Better Stack HTTP monitor | `familiarisenow.com` (4093821)                           | The homepage                            | Existing; 3-minute check on the free plan.                                                                                                              |
| Better Stack HTTP monitor | `familiarisenow.com/api/health` (4093822)                | Database, Redis and Stream reachability | Existing; 60 s timeout and 1 minute confirmation.                                                                                                       |
| Better Stack HTTP monitor | `familiarise job fleet probe (prod)` (5189236)           | `/api/health/jobs`                      | New. Status-type monitor, GET, bearer `CRON_SECRET` header, every 5 minutes, 60 s timeout, 1 minute confirmation. E-mail only until the responder seat. |
| Better Stack heartbeat    | `familiarise cron-tick (prod)` (521597)                  | The ticker                              | Period 300 s, grace 600 s. Created paused 2026-10-30, unpaused 2026-11-03.                                                                              |
| Better Stack heartbeat    | `familiarise ops digest (prod)` (523773)                 | The daily digest                        | Period 86400 s, grace 10800 s. Created paused on purpose; unpaused 2026-11-05 after the first digest ran.                                               |
| Sentry cron monitor       | `cron-tick`                                              | The ticker                              | Schedule `*/5 * * * *`, margin 3 minutes, production environment, healthy.                                                                              |
| Sentry uptime monitor     | `familiarise job fleet probe (second watcher)` (7689936) | `/api/health/jobs`                      | GET, every 300 s, 60 s timeout, bearer header, response capture off. Repointed on 2026-11-05 from the homepage.                                         |

**Production state**

- The daily jobs ran on the ticker on 11-03, 11-04 and 11-05; the 2026-11-04 release added the digest, release lag and the build-time coverage check. For example `cleanup-auth-tokens` cleared 164 rows on 11-03, then 6 and then 2.
- The first `ops-digest` ran on 2026-11-05 at 03:50 UTC (09:20 IST). Its headline read "0 new, 13 standing" and its heartbeat was pinged.
- Before two manual runs the probe answered 503 `JOB_OVERDUE` for `consent-retention-sweeper` and `tds-return-draft`. Both were run once at 2026-11-05 08:24 UTC and answered HTTP 200: the consent sweep found 0 expired consent rows, and the TDS job produced an empty FY 2026-27 Q2 draft with the expected "no TDSRecord rows" warning. The probe then answered 200 with `healthy: true`.

### R1. Which overlap is deliberate

| Alternative                                                    | Verdict   | Why                                                                                                                                                                                                               |
| -------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One vendor for everything (Better Stack only)                  | Lost      | A Better Stack outage, a paused monitor or a bad setting would then hide a stalled fleet. The 2026-11-02 record already chose a second company for the probe.                                                     |
| Two vendors on every question                                  | Lost      | The free plans cap monitors (Better Stack 10 monitors and heartbeats in total, Sentry one cron and one uptime monitor), and the digest email is already the human-facing signal for its own question.             |
| **Two vendors on the probe and the ticker, one on the digest** | **Taken** | The probe and the ticker answer "did anything run", the question whose silence caused the incident. The digest watching itself through one heartbeat is enough, because a missing email is noticed by the reader. |

The deliberate overlaps are the probe (Better Stack monitor 5189236 and Sentry uptime monitor 7689936) and the ticker (Better Stack heartbeat 521597 and Sentry cron monitor `cron-tick`). The accidental overlap was the old Sentry homepage check, which duplicated Better Stack's homepage monitor; R2 repurposed it rather than deleting it, because the free plan includes exactly one uptime monitor.

The honest limit: until the responder seat exists, both vendors' e-mails land in the same inbox. Vendor redundancy protects against a vendor failure or misconfiguration. It does not protect against the single human who reads that inbox.

### R3. Why state, not shape, is the acceptance test

The heartbeat incident shows that a monitor can exist, carry the right URL and be fed by correctly set environment variables, and still do nothing because it is paused. The rule is: after creating or changing a monitor, read it back from the vendor API and confirm `paused` is false and the status is `up`. For a heartbeat, also confirm that a ping has arrived. The [explainer](../start-here/08-how-we-know-a-job-did-not-run.md#7-how-to-reproduce-the-verification-yourself) lists the read-only calls.

| Alternative                                                  | Verdict   | Why                                                                                                                                |
| ------------------------------------------------------------ | --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Trust that creating the monitor is enough                    | Lost      | It is exactly what failed between 2026-10-30 and 2026-11-03.                                                                       |
| A code check that every monitor is unpaused                  | Lost      | The digest already lists paused and muted monitors, but only for monitors it can read, and the code never creates vendor monitors. |
| **Read each monitor back after any change and require `up`** | **Taken** | It costs one read-only call and tests the thing that matters. The digest's paused-monitor section remains the standing backstop.   |

### R4. Running a job by hand

| Alternative                                                                    | Verdict   | Why                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Let the ticker run it                                                          | Lost      | A weekly or quarterly window would keep the probe red for days or months. The probe has no production-tagged evidence for a window that never ran.                                                  |
| System Jobs "Run now" in the admin UI                                          | Lost      | It records the admin user as the trigger and takes the same code path in-process, which is good, but it shows less detail than the raw JSON result.                                                 |
| **A terminal `curl -X POST` with the bearer to `/api/cleanup/<registry-key>`** | **Taken** | It prints the job's full JSON result. The route (`app/api/cleanup/[job]/route.ts`) is the HTTP twin of every registry job, and the run is tagged with the production environment like a ticker run. |

The registry key and the run-row name can differ. The registry key `tds-return-draft` writes run rows named `tds-26q-draft-export`; `jobNameFor` in `lib/cron/schedule.ts` maps one to the other (also `reconcile-refunds` to `reconcile-pending-refunds`, `auth-tokens` to `cleanup-auth-tokens`, and others). Use the registry key in the URL and the run-row name when querying `SystemJobExecution`.

### R5. `CRON_SECRET`

| Alternative                                                    | Verdict    | Why                                                                                                                                                                                                                                                             |
| -------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep the old value and re-enter it into the monitors           | Impossible | Nobody could read it back. Netlify and GitHub secrets are write-only.                                                                                                                                                                                           |
| A separate read-only secret for the probe                      | Lost       | Offered and declined by the owner on 2026-11-02. One secret is simpler to rotate, and jobs are idempotent and CAS-guarded. Accepted risk: Sentry and Better Stack store the header value, so a leak from either vendor's settings means rotating `CRON_SECRET`. |
| **Rotate at the release, keep one copy in a password manager** | **Taken**  | The new value was set for the production context only and took effect with the 2026-11-04 release deploy. Only the owner's password manager holds a readable copy.                                                                                              |

Rules that follow: never paste the value into a document, a ticket, a chat or a command line that lands in shell history, and never write down where a local copy lives. The `CRON_SECRET` GitHub Actions secret is unused (no workflow reads it) and can be deleted.

### R6. Creating monitors

| Alternative                                   | Verdict   | Why                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Click through vendor dashboards               | Lost      | Not reproducible and leaves no review trail.                                                                                                                                                                                                                                                                 |
| Terraform or similar                          | Lost      | Five monitors do not justify a new tool and state file (AGENTS.md §1.2, no speculative abstractions).                                                                                                                                                                                                        |
| The application creates its own monitors      | Lost      | The code never creates vendor monitors (already stated in the Better Stack setup guide).                                                                                                                                                                                                                     |
| **Each vendor's API or CLI, secret on stdin** | **Taken** | Better Stack: `https://uptime.betterstack.com/api/v2/monitors` and `/heartbeats` with `BETTERSTACK_API_KEY`. Sentry: `sentry api /organizations/<org>/detectors/<id>/ -X PUT --input -`, body piped on stdin so a secret never appears in a command line. Keep browser-driven work for the product's own UI. |

### R7 to R9. The three deferred or skipped settings

| #   | Setting                                                                                             | Taken                                                                                                                                                                                                       | Alternatives and why they lost                                                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R7  | `GITHUB_RELEASE_LAG_TOKEN`                                                                          | **Defer.** With no token the digest says "release lag unknown" and nothing pages. Production was within 3 commits of `dev` on 2026-11-05.                                                                   | A fine-grained read-only token now (a dashboard-only step, because GitHub has no API for it, and not valuable until a release is held for days). A personal access token (broader than needed). Polling GitHub from the probe (a probe poll must not make a network call). |
| R8  | `UPSTASH_MANAGEMENT_API_KEY`, `UPSTASH_EMAIL`, `UPSTASH_DATABASE_ID`, `UPSTASH_MONTHLY_COMMAND_CAP` | **Skip.** They never existed in GitHub secrets, and Upstash is pay-as-you-go at about $0.75 a month, so "Upstash usage unknown" is acceptable.                                                              | Provision them to restore the usage alarm that used to live in the Actions heartbeat. Rejected because the spend is trivial and the usage alarm is not worth three more secrets to maintain.                                                                               |
| R9  | `OBSERVABILITY_ALERT_EMAIL`                                                                         | **Leave unset.** The digest goes to `supportEmail()` (`connect@practitionist.com`), which is on the production `EMAIL_ALLOWLIST`, so the pre-launch guard (`lib/email/delivery-guard.ts`) does not hold it. | An own-domain address (`familiarisenow.com` is always allowed). Not needed today. **Revisit at launch**, when `EMAIL_DELIVERY_MODE=live` changes what the guard does.                                                                                                      |

## Consequences

- **Open gaps, not decisions.**
  - `SENTRY_STATS_TOKEN` is unset, so the Sentry ingest canary skips daily. This is a standing paging-tier configuration skip. Before launch it needs a Sentry internal integration with Organization: Read, set with `netlify env:set ... --secret`. Until then, Sentry could be blind and nothing would say so.
  - `PLATFORM_GSTIN` is unset, so three jobs skip. At launch set it before the Razorpay live keys, or the probe pages `STANDING_CONFIG_SKIP`.
  - Better Stack Telemetry SQL alerts are created muted, and the digest cannot read their mute state.
  - The responder seat and phone paging arrive at launch. Until then the monitors alert by e-mail only.
  - Secret rotations before launch for other credentials, including the three-place `CRON_SECRET` change, are in the [secret rotation runbook](../maintenance/19-secret-rotation-runbook.md).
- **A windowed job's first-ever slot can hold the probe red.** A weekly or quarterly job that has never run under a production-tagged row makes `/api/health/jobs` answer 503 until it runs. The runbook is to run it once by hand (R4), then confirm the probe answers 200.
- **Netlify environment changes apply at the next deploy.** A rotated `CRON_SECRET` is not in force until a deploy completes; update the monitors' headers after that, not before.
- **Two vendors store the header.** A leak from either vendor's monitor settings means rotating `CRON_SECRET` and updating three places: the Netlify production value, the Better Stack monitor and the Sentry uptime monitor.
- **The earlier records' owner-step lists are now closed**, except the release-lag token and the Upstash settings (deferred and skipped above) and the recipient decision (R9).

## Deprecated & Superseded Approaches

- **A Sentry uptime monitor on the homepage.** It duplicated Better Stack's homepage monitor. Repointed to `/api/health/jobs`; do not create another homepage check on Sentry.
- **A paused-on-creation monitor left paused.** Creating a monitor paused is legitimate for a monitor that would fire before its data source exists (the digest heartbeat), but the unpause is part of the step, not a later chore.
- **Recovering the old `CRON_SECRET`.** It cannot be read from any surface. Rotate instead.
- **Reading the digest heartbeat and release-lag steps of the 2026-11-02 record as pending.** The heartbeat is created and unpaused; the release-lag token is deliberately deferred.
- **The Upstash usage alarm in `cron-heartbeat.yml`.** The 2026-11-02 record moved it into the digest; R8 leaves its settings unset, so the digest shows "Upstash usage unknown". Do not restore the Actions alarm.
- **The `CRON_SECRET` GitHub Actions secret.** No workflow reads it. Delete it rather than updating it.
- **The runbook's 30-second Sentry uptime timeout.** It was the dashboard's documented maximum; the repointed monitor uses 60 s for the cold-start stall.
- **Running a never-run windowed job by waiting for its slot.** A weekly or quarterly window would hold the probe red for days or months; run it once by hand (R4).
