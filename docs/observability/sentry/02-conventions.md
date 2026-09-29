# Sentry conventions

These are the rules that make the Sentry issue list readable. They are conventions of the code, not of the Sentry UI, so a change to them is a code change with a pin.

## A modelled outcome is never a fault

The finance doctrine says that a refusal the code anticipated must never surface as a 500, and Sentry follows the same line. A business refusal — a full webinar, a credit shortfall, a consent gate, an organisation that cannot sponsor — is reported through `reportSentryError` or `reportSentryMessage` with `expected: true`, which `beforeSend` turns into a warning-level event tagged `expected:true`. An unexpected exception is reported without the flag and stays an error. The practical test for any new `throw` on a request path is whether it carries a registered code in `BUSINESS_ERROR_CODES` (`lib/errors/classification/payment-error-classification.ts`); if it does, the route's catch already reports it as expected, and if it does not, the buyer gets a 500 and Sentry gets a fault. The 2026-09-19 finance train registered ten such codes that had been leaking (`ORG_MEMBERSHIP_REQUIRED`, `EVENT_FULL`, `CREDIT_SHORTFALL` among them); the pattern to copy is the `Object.assign(new Error(msg), { httpStatus, code })` shape used for `CONSENT_REQUIRED` in `lib/payments/operations/checkout.ts`.

Sweeps and reconcilers report findings as messages, not exceptions. A reconciler that finds a `LEDGER_DUAL_WRITE_GAP` sends one `reportSentryMessage` per run with the count and the ids in `extra`, tagged expected, and the HTTP twin answers 207. A reconciler that crashes sends an exception. The difference matters because the ticker and the Actions notifier read only the status, so a finding reported as a failure buys retries and noise instead of visibility.

## A repetition is throttled; a set is aggregated

These are two different shapes of mass event and they take two different mechanisms. Getting them backwards is how a reporting mechanism becomes the outage, so the rule is stated rather than left to be re-derived.

**A repetition** is one failure happening again and again: `UpstashError` on every request while the cache is walled off. The fact is "it is happening", and the evidence is a real stack trace from one of them. Handle it by **throttling** — `INFRA_THROTTLE_MS` in `sentry.shared.config.ts` keeps the first event of each class per ten-minute window and drops the rest by returning `null` from `beforeSend`, before the event ever reaches the transport. One event, a genuine trace, zero marginal quota. The issue's event count is a deliberate under-count, and that is the correct shape: it says "at least one per window", not "3,000".

**A set** is one run finding many distinct things: a reconcile pass that walks 400 bookings and finds 12 missing ledger transactions. The fact _is_ a set — there is no single error that occurred 12 times — so handle it by **aggregating** into one event carrying the count and the ids in `extra`, which is what the reconciler pattern above already does. The count is the signal and the ids are the evidence, and nothing is thrown away, so nothing needs inventing.

**Never aggregate a repetition.** It sounds like the cheaper option and it is strictly worse. The count would be one the code computed by discarding events, so it is a lower bound that under-reports precisely during the incident you are trying to size; the instances that die mid-window, straddle a window boundary, or land on a deploy contribute nothing and are invisible; and the one stack trace worth reading is replaced by a number. The throttle already gives the thing being asked for — one real event with a real trace, at one event's cost — in about twenty lines of `beforeSend` with no flush window, no buffer to lose, and no count to trust.

One distinction worth being precise about, because it is easy to assume otherwise: **grouping into one Sentry issue is not grouping into one event.** A shared `fingerprint` gives many events one issue with a count, which is what the canary does — and every one of those events still counts against the allowance. Only fewer _events_ saves budget.

When the allowance is genuinely too small, no amount of event-shaping substitutes for the plan's included volume. 5,000 errors a month is smaller than a single 24-hour dependency outage, and the throttles here bound a _known_ pattern while a diverse flood scales with the number of distinct classes.

## Tags that carry meaning

Every event carries `subsystem` (`payments`, `checkout`, `booking`, `cron`, `stream`, `email`, `dashboard`, `admin` and so on) and, where the helper is used, `op` naming the operation. Production and preview events share one project and are told apart by `environment` (`production` or `preview`), `release` (the commit SHA of the build under test) and `branch` (`pull/<n>/head` for a deploy preview). A QA run against a deploy preview therefore leaves a trail that can be attributed to that preview's commit, which is how the finance train's QA reports separated their own fixture noise from real regressions. Events from GitHub Actions carry `logger: github-actions`, `subsystem: cron` and `job: <workflow>`; they arrive with no environment tag because the runner has none.

## SystemEvent is the audit row, Sentry is the pager

`recordSystemEvent` and `recordSystemError` (`lib/enterprise/system-events.ts`) write a `SystemEvent` row that survives in the database as evidence; Sentry receives the same fact as an event that someone is expected to look at. Money code writes both, and since PR #1753 the in-transaction call sites pass the transaction client so the row is not lost to the single-connection pool. When the two disagree, the row is the truth and the Sentry event is the notification of it.

## Transient platform failures are breadcrumbs, not captures

A cross-region cold-connect timeout, a Netlify instance-boot stall, a pooler `Connection terminated` inside a reconcile chunk: these are platform-ceiling events with a known cause (#1124, ADR 31) and a fixed set of issue ids that are ignored until they escalate. Routes that can degrade gracefully use `lib/data/fail-open` (`isTransientDbError`, `reportTransient`) so the failure becomes a breadcrumb on the next real event rather than a fresh capture. Re-escalation of one of those ids is the signal that the platform problem has changed shape, not a bug to fix in the route.

## What an issue's status means here

An issue is resolved when the fix is on production and the reason is written in a comment on the issue (the PR number, the commit, or the seed row that was retired). It is ignored until escalating when the cause is known, tracked on a GitHub issue and outside the code's control for now; the comment names the tracking issue. It is left unresolved only while someone owns it. A green Sentry list is not the goal; a list where every unresolved issue has an owner is.
