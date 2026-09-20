# Sentry conventions

These are the rules that make the Sentry issue list readable. They are conventions of the code, not of the Sentry UI, so a change to them is a code change with a pin.

## A modelled outcome is never a fault

The finance doctrine says that a refusal the code anticipated must never surface as a 500, and Sentry follows the same line. A business refusal — a full webinar, a credit shortfall, a consent gate, an organisation that cannot sponsor — is reported through `reportSentryError` or `reportSentryMessage` with `expected: true`, which `beforeSend` turns into a warning-level event tagged `expected:true`. An unexpected exception is reported without the flag and stays an error. The practical test for any new `throw` on a request path is whether it carries a registered code in `BUSINESS_ERROR_CODES` (`lib/errors/classification/payment-error-classification.ts`); if it does, the route's catch already reports it as expected, and if it does not, the buyer gets a 500 and Sentry gets a fault. The 2026-09-19 finance train registered ten such codes that had been leaking (`ORG_MEMBERSHIP_REQUIRED`, `EVENT_FULL`, `CREDIT_SHORTFALL` among them); the pattern to copy is the `Object.assign(new Error(msg), { httpStatus, code })` shape used for `CONSENT_REQUIRED` in `lib/payments/operations/checkout.ts`.

Sweeps and reconcilers report findings as messages, not exceptions. A reconciler that finds a `LEDGER_DUAL_WRITE_GAP` sends one `reportSentryMessage` per run with the count and the ids in `extra`, tagged expected, and the HTTP twin answers 207. A reconciler that crashes sends an exception. The difference matters because the ticker and the Actions notifier read only the status, so a finding reported as a failure buys retries and noise instead of visibility.

## Tags that carry meaning

Every event carries `subsystem` (`payments`, `checkout`, `booking`, `cron`, `stream`, `email`, `dashboard`, `admin` and so on) and, where the helper is used, `op` naming the operation. Production and preview events share one project and are told apart by `environment` (`production` or `preview`), `release` (the commit SHA of the build under test) and `branch` (`pull/<n>/head` for a deploy preview). A QA run against a deploy preview therefore leaves a trail that can be attributed to that preview's commit, which is how the finance train's QA reports separated their own fixture noise from real regressions. Events from GitHub Actions carry `logger: github-actions`, `subsystem: cron` and `job: <workflow>`; they arrive with no environment tag because the runner has none.

## SystemEvent is the audit row, Sentry is the pager

`recordSystemEvent` and `recordSystemError` (`lib/enterprise/system-events.ts`) write a `SystemEvent` row that survives in the database as evidence; Sentry receives the same fact as an event that someone is expected to look at. Money code writes both, and since PR #1753 the in-transaction call sites pass the transaction client so the row is not lost to the single-connection pool. When the two disagree, the row is the truth and the Sentry event is the notification of it.

## Transient platform failures are breadcrumbs, not captures

A cross-region cold-connect timeout, a Netlify instance-boot stall, a pooler `Connection terminated` inside a reconcile chunk: these are platform-ceiling events with a known cause (#1124, ADR 31) and a fixed set of issue ids that are ignored until they escalate. Routes that can degrade gracefully use `lib/data/fail-open` (`isTransientDbError`, `reportTransient`) so the failure becomes a breadcrumb on the next real event rather than a fresh capture. Re-escalation of one of those ids is the signal that the platform problem has changed shape, not a bug to fix in the route.

## What an issue's status means here

An issue is resolved when the fix is on production and the reason is written in a comment on the issue (the PR number, the commit, or the seed row that was retired). It is ignored until escalating when the cause is known, tracked on a GitHub issue and outside the code's control for now; the comment names the tracking issue. It is left unresolved only while someone owns it. A green Sentry list is not the goal; a list where every unresolved issue has an owner is.
