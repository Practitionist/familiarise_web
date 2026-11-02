# ADR: CI stays on GitHub-hosted runners, with workflow cuts and a hard spend cap

- **Status**: Accepted (owner decision, 2026-10-30)
- **Date**: 2026-10-31
- **Author**: Platform engineering
- **Related**: issue #2466 (the full CI cost study is a comment on it), the workflow `.github/workflows/ci.yaml`, [Architecture at scale review](2026-10-30-architecture-at-scale-review.md), [Deployment and pooling](../deployment/README.md)

## Decision

1. **Runner.** CI runs on GitHub-hosted `ubuntu-latest` runners. The GitHub organisation stays on the Free plan until there are full-time employees. The repository is already private on that plan, so launch does not change billing: the included 2,000 minutes a month is the limit that ran out on 2026-10-17.
2. **Spend cap.** The owner sets an Actions budget of about $15 a month with "Stop usage when budget limit is reached" turned on. This is a GitHub UI step the owner performs (Billing & Licensing, Budgets and alerts, New budget, product-level Actions, organisation scope). Nothing in the repository enforces it.
3. **Cuts.** The workflow changes below are applied, ranked by estimated minutes saved per month at today's volume.
4. **Target.** At launch pace (5 to 15 PRs a week) CI should use about 2,000 to 2,500 minutes a month, which is within the free 2,000 or about $0 to $3.
5. **Fallback.** If the cap is still exceeded after the cuts, change `runs-on` to Ubicloud or Blacksmith. It is a one-line change per job and keeps the same GitHub checks and secrets.
6. **Crons.** The hourly, daily and weekly GitHub Actions cron workflows move onto the Netlify ticker in #2474, which deletes those workflows. That removes about 1,450 minutes a month, of which the hourly job is about 1,200. This ADR does not change those workflows.

## The cuts applied

| Cut                                                                                                                            | Estimated saving (minutes a month, today's volume) |
| ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| No full jest suite and no Build on pushes to dev                                                                               | about 2,900                                        |
| Lint, TypeScript and guards, changed-file jest and the sidecar guard merged into one `checks` job, so setup is paid once       | about 3,000                                        |
| Sidecar guard and database tier run only when `prisma/**`, `scripts/ci/check-db*`, the database jest files or `ci.yaml` change | about 1,500                                        |
| ESLint (`--max-warnings=0`) and Prettier on changed files for non-release runs                                                 | about 1,600                                        |
| Draft PRs skipped                                                                                                              | about 1,000                                        |
| Prisma engine cache and `tsconfig.tsbuildinfo` cache (not on release runs)                                                     | about 1,000                                        |
| Dependabot weekly and grouped                                                                                                  | about 100                                          |

The savings overlap, so they do not add up. The study projects today's 18,000 minutes falling to about 8,000 to 9,000, and launch pace from about 5,000 to about 2,000 to 2,500.

## How the shape works now

- A **release run** is a PR into `prod`, a push to `staging` or `prod`, or a manual run. It keeps the cold `tsc`, a full `eslint .`, the 2-shard full jest suite and the Build.
- Every other run (PRs into `dev`, `staging` or `feat/**`, pushes to `dev`) is a changed-files run: ESLint and Prettier on changed files, and changed-file jest on pull requests only.
- The required check is `TypeScript, Tests & Build`, which passes only when every job that applies to the run passed. Draft PRs run nothing.
- A cold `tsc` stays on release runs because a warm incremental `tsc` can mask errors.

## Numbers behind it

- About 74 PRs opened a week and about 4.1 CI runs per PR over the study window.
- About 18,000 billable minutes a month on the shape current before these cuts (about 37,000 to 39,000 on the older shape), at $0.006 a minute for a 2-core Linux runner.
- Cron workflows about 1,450 minutes a month, knip 100 to 450, Dependabot about 150.

## Consequences

- A merge interaction between two dev PRs is first tested by the release PR into `prod`, not by a dev push. The accepted cost is a later failure signal.
- On changed-files runs a pre-existing warning in a touched file fails the PR because of `--max-warnings=0`.
- Wall time of the merged job is longer than any single old job but shorter than the old pipeline in total minutes.

## Deprecated & Superseded Approaches

- The separate `Lint`, `TypeScript & guards`, `Unit tests (changed files)` and `Database sidecar guard` jobs were merged into `checks`; only `TypeScript, Tests & Build` remains as the required name.
- The full suite and Build on every dev push were removed.
- Hourly, daily and weekly GitHub Actions crons are superseded by the Netlify ticker (#2474).
