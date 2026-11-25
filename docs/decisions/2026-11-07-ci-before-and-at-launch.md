# ADR: CI before and at launch

- **Status**: Accepted (owner decision, 2026-11-07)
- **Date**: 2026-11-07
- **Author**: Platform engineering
- **Related**: [CI on GitHub-hosted runners with cuts](2026-10-31-ci-on-github-hosted-with-cuts.md), the workflows `.github/workflows/release-checks.yml` and `.github/workflows/ci.yaml`, [GitHub Actions billing reference](../../.claude/skills/billing-guardrails/references/github-actions.md)

## Context

Full CI on every pull request costs about 8,500 Actions minutes a month at the pre-launch pace of about 330 merged pull requests a month, against 2,000 free. The workflow `CI` (`ci.yaml`) has been disabled in the repository's Actions settings (state `disabled_manually`) since the minutes ran out on 2026-10-17, as have `Race Condition Tests` and `Knip`. The pace is a pre-launch burst. At the launch pace of 5 to 15 pull requests a week, even full CI is about 1,200 minutes. Organisation Actions storage sits at 90 percent of the Free plan's 0.5 GB.

**Observed 2026-11-13.** `CI` was `active` in the Actions settings and ran on pull requests into `dev`, so decision 1 below was not in force on that day. Whether it was re-enabled on purpose is not recorded; issue #2752 tracks it and the runner question.

## Decision

### Before launch

1. Repository CI stays off for pull requests into `dev`. The merge gate is the Netlify deploy-preview build plus the checks run locally.
2. A new workflow, `release-checks.yml`, runs one job on pull requests into `prod` and on manual dispatch: `npm ci`, `prisma generate`, `tsc --noEmit`, `npm run lint`, `npm run cron:coverage` and `jest --changedSince=origin/prod`. It takes about 8 minutes and runs 40 to 100 times a month, which is 320 to 800 minutes. It is a separate file because `ci.yaml` can only be enabled or disabled as a whole, and enabling it would also restart the dev-PR runs.
3. Artifact retention is 7 days in `load-gate.yml` (was 90) and `race-condition-tests.yml` (was 30). No artifact here is needed longer than a week.
4. `db-live-drift` (daily, and on every pull request into `prod`) and `security-audit` (weekly) stay on, about 170 minutes a month together.

### At launch

1. Move the `Practitionist` organisation to GitHub Team with one seat: $4 a month, 3,000 included minutes, 2 GB of storage, and branch protection on private repositories.
2. Cancel the personal GitHub Pro on `teetangh` ($4 a month). Actions usage is charged to the repository owner, so a personal plan never covers an organisation repository. Cancel only when nothing personal depends on it.
3. Pay with an eligible Indian credit card that has a GitHub RBI e-mandate. The recurring mandate accepts credit cards only; a debit card works for the one-time "Pay now" payment after a failed charge, so keep a funded one as the fallback.
4. Set the Actions budget to about $15 with stop-usage on.
5. Make `Release checks` a required status check in branch protection for `prod`.
6. If monthly usage passes 3,000 minutes, change `runs-on` to Ubicloud or Blacksmith, and only then.

## Alternatives considered

| Alternative                                   | Why it lost                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Make the repository public                    | Public repositories run standard hosted runners free, but this is a commercial product: pricing, booking, money and security logic, `docs/` and `.claude/` would become readable and forkable, and the change is irreversible in practice. A billing workaround is not worth that.            |
| Self-hosted VMs ($44 to $48 a month)          | A flat 8 GB VM beats hosted minutes only above about 7,300 minutes a month ($44 at $0.006 a minute), and slim CI uses far less. A persistent runner on a private repository also exposes the secrets that `ci.yaml` writes to `.env`, and the $0.002 a minute platform fee is only postponed. |
| Other managed runners                         | Ubicloud ($0.0012 a minute, 1,250 free), Blacksmith ($0.004, 3,000 free), WarpBuild, Depot, Namespace and Tenki save little or nothing at our volume, none states Indian card or RBI handling, and two vendors (BuildJet, Cirrus CI) shut down in 2026. They are overflow only.               |
| Full CI on GitHub-hosted runners, every PR    | About 8,500 minutes a month during the pre-launch burst, about $39 on Free and $37 on Team, to catch what the Netlify preview build and local checks already catch before merge.                                                                                                              |
| Re-enable `ci.yaml` for release pull requests | It runs `checks`, two jest shards and `next build` for about 26 minutes, needs the whole `.env` from `ENV_FILE`, and cannot be enabled for prod alone.                                                                                                                                        |

## Consequences

- A type or test regression introduced on a dev pull request is first caught by the release pull request into `prod`, not at merge. The Netlify preview build still catches build failures on every dev pull request.
- `Release checks` runs jest without the `.env` that `ci.yaml` writes, so no production secret is exposed to it; `jest.setup.ts` supplies the test defaults.
- On the Free plan, branch protection may not be enforceable on a private repository, so the required check becomes real only after the move to Team at launch.
- A new workflow file is active as soon as it is on the default branch; no `gh workflow enable` is needed for it.
- **Superseded in part (2026-11-11).** The number of GitHub Team seats equals the number of active contributors, not one. The count and the cost are kept in Notion (Familiarise / Finance and Pricing / Vendors & Spend). See [the 2026-11-11 levers record](2026-11-11-cfo-csmo-levers.md).

## Sources

Read on 2026-11-07:

- GitHub Actions billing: https://docs.github.com/en/billing/concepts/product-billing/github-actions and runner prices at https://docs.github.com/en/billing/reference/actions-runner-pricing
- Plan prices: https://github.com/pricing
- Self-hosted fee postponement: https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/
- Indian recurring payments: https://github.blog/changelog/2026-08-10-github-billing-in-india-now-supports-automatic-recurring-payments/ and https://docs.github.com/en/billing/reference/payment-methods
- Self-hosted runner security: https://docs.github.com/en/actions/reference/security/secure-use
- Lightsail: https://aws.amazon.com/lightsail/pricing/ ; DigitalOcean: https://www.digitalocean.com/pricing/droplets
- Ubicloud: https://www.ubicloud.com/use-cases/github-actions ; Blacksmith: https://www.blacksmith.sh/pricing ; WarpBuild: https://www.warpbuild.com/pricing ; Depot: https://depot.dev/pricing ; Namespace: https://namespace.so/pricing ; Tenki: https://www.tenki.cloud/pricing

## Deprecated & Superseded Approaches

- Full CI on every pull request (up to 37,000 minutes a month in its oldest shape, about 8,500 in the cut shape of the 2026-10-31 decision) was turned off in the repository's Actions settings after the included minutes ran out on 2026-10-17. `ci.yaml` remains in the tree, disabled, and is not the release gate.
- Artifact retention of 90 days (`load-gate.yml`) and 30 days (`race-condition-tests.yml`) is superseded by 7 days.
