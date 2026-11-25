# GitHub Actions

## 1. Plan and limits

The repository is `Practitionist/familiarise_web`, a private repository owned by an organisation. The organisation plan is not recorded in the repo (unknown; confirm in the organisation billing page). Reference figures, VERIFIED 2026-10-17 from [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions): included minutes per month are 2,000 on Free and 3,000 on Pro and Team; Linux 2-core x64 costs $0.006 a minute; artifact storage is 500 MB on Free, 1 GB on Pro and 2 GB on Team; cache is 10 GB per repository. Alerts at 90 and 100 percent of included usage exist regardless of budgets ([budgets and alerts](https://docs.github.com/en/billing/concepts/budgets-and-alerts), VERIFIED).

## 2. What causes surprise bills or outages

- Included minutes exhausted with no payment method or a zero budget: usage is blocked, so every workflow, including required CI checks, stops. This happened on 2026-10-17 (INFERRED from the owner report). The docs page says blocking applies when there is no valid payment method; it does not state what a $0 budget does, so treat a $0 budget as blocking.
- Runner multipliers: macOS and Windows minutes count at higher multiples than Linux and larger runners bill per minute from the first minute. Every workflow here uses `ubuntu-latest`, which is the cheapest class.
- Artifact and cache storage count against the same shared quota as Packages.
- Scheduled workflows run on the default branch and bill like any other run, including runs that fail in seconds; GitHub may delay or skip schedules under load, so a schedule is never a latency guarantee.
- Superseded runs keep billing unless a `concurrency` group cancels them.

## 3. Exposure in this repo

- `.github/workflows/ci.yaml` runs on push to `dev`, `staging` and `prod`, and on pull requests to those and `feat/**`, with `labeled` and `unlabeled` re-runs. Its `concurrency` group cancels superseded pull-request runs (`cancel-in-progress` is true only for pull requests). Jobs have `timeout-minutes` of 5 to 45.
- **Observed 2026-11-13:** `CI` was `active` and running on pull requests into `dev` (`gh api repos/Practitionist/familiarise_web/actions/workflows`), which contradicts the next bullet; one run's `checks` job took 34 minutes, 27 of them in the changed-files Jest step. Docs-only pull requests are excluded by the workflow's path filter. Check the live state before relying on either bullet (#2752).
- Repository CI is off: the workflows `CI`, `Race Condition Tests` and `Knip` are `disabled_manually` in the Actions settings (`gh workflow list --all`), so dev pull requests are gated by the Netlify preview build and local checks. The one slim gate is `.github/workflows/release-checks.yml` (pull requests into `prod` and manual dispatch; about 8 minutes, 40 to 100 runs a month). Plan and launch steps: [the CI decision](../../../../docs/decisions/2026-11-07-ci-before-and-at-launch.md).
- Scheduled workflows: `.github/workflows/cron-heartbeat.yml`, `.github/workflows/db-live-drift.yml`, and `.github/workflows/security-audit.yml`. `cron-heartbeat.yml` watches only the other Actions-scheduled workflows (`scripts/ci/check-cron-heartbeat.ts`); it is not a runtime watchdog, so it stops with Actions and must never be the only watcher of a runtime job. Runtime jobs are watched from outside Actions by `/api/health/jobs`, the ticker heartbeat and the daily `ops-digest`, and the scheduling invariants run in `npm run build` (`checkJobCoverage`, `lib/cron/job-coverage.ts`), so none of them needs Actions minutes. No workflow schedules a registry job: the former fleet workflows (`cron-intra-day.yml`, `cron-daily.yml`, `cron-weekly.yml`) are deleted and every job runs on `netlify/functions/cron-tick.mts`.
- Several scheduled jobs currently fail every run because the `CRON_SECRET` Actions secret is missing (issue #2145); a failing scheduled run still spends minutes.
- Artifacts: `.github/workflows/load-gate.yml` and `.github/workflows/race-condition-tests.yml` keep artifacts 7 days (`retention-days: 7`); keep any new upload at 7 or fewer, because storage is shared with Packages and sat at 90 percent of the Free 0.5 GB.
- `.github/workflows/load-gate.yml` and `.github/workflows/load-test.yml` are `workflow_dispatch` only; keep them manual. `.github/workflows/race-condition-tests.yml` is manual plus automatic on pushes to `prod`.

## 4. Guardrails to set

- Organisation settings, Billing and licensing, Budgets and alerts: create an Actions budget with a non-zero amount and stop-usage on, so a runaway loop costs a known maximum instead of blocking CI at zero. Alerts fire at 75, 90 and 100 percent of a budget.
- Add a payment method (an INR card works; see the mandate note in `SKILL.md`).
- Every new workflow needs `timeout-minutes` and a `concurrency` group; scheduled workflows need `cancel-in-progress: false` only when overlapping runs are unsafe.
- Do not add a schedule for work the Netlify ticker already does.

## 5. Monitor

```bash
gh api /organizations/Practitionist/settings/billing/usage --jq '.usageItems[] | select((.product|ascii_downcase)=="actions") | {sku, quantity, netAmount}'
gh run list --limit 50 --json workflowName,conclusion,createdAt,updatedAt
```

If the billing endpoint returns 404 for your token, use Settings, Billing and licensing, Usage in the web console. GitHub API rate limit is shared across tools (5,000 an hour); check `gh api rate_limit` before loops.
