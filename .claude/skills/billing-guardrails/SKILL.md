---
name: billing-guardrails
description: The single source for avoiding surprise or runaway infrastructure bills and quota outages across GitHub Actions, Netlify, Vercel, Cloudflare (R2, Workers, DNS), Supabase, Upstash Redis, Sentry, Novu, Resend, Stream.io and Razorpay fees. Use when the user says "surprise bill", "billing", "quota", "spending limit", "free tier", "overage", "budget", "minutes exhausted", "usage cap", "hard cap", "cost", or when adding a cron job, a polling endpoint, a Sentry capture, a Redis call, an email or notification send, a Stream call, an Actions workflow, a preview deploy or any new vendor dependency.
user-invocable: true
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

# Billing Guardrails

This skill is the one place that says how this repo avoids paying for, or being blocked by, a vendor meter. Each vendor has a reference with five parts: the plan and limits we are on, the behaviours that bite, where this repo is exposed, the console guardrail to set, and a command that shows current usage. Vendor figures are dated and marked VERIFIED (read from the vendor page on 2026-10-17) or INFERRED (derived or from repo notes).

Owner context: the owner is India-based, so cards are INR-billed and a vendor charge is subject to RBI recurring-payment rules (e-mandate for auto-debit is capped at INR 15,000 per transaction without extra authentication, and an international card may be declined at renewal). A declined renewal looks like an outage, so keep a second funded card on every paid vendor. INFERRED from RBI circulars; confirm with the card issuer.

## Vendor references

| Vendor                                      | Read                                           | Hard-stop behaviour when the meter runs out                                    |
| ------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| GitHub Actions                              | [github-actions](references/github-actions.md) | Jobs are blocked, CI cannot run, merges stall.                                 |
| Netlify (Pro, legacy plan)                  | [netlify](references/netlify.md)               | Overage is billed; builds and functions keep running.                          |
| Vercel (standby only, not deployed)         | [vercel](references/vercel.md)                 | Not applicable today; read before a cutover.                                   |
| Cloudflare (R2 recordings, DNS)             | [cloudflare](references/cloudflare.md)         | R2 bills per operation; no hard stop.                                          |
| Supabase                                    | [supabase](references/supabase.md)             | With the spend cap on, the item is blocked; compute and PITR are not capped.   |
| Upstash Redis                               | [upstash](references/upstash.md)               | Rate limited at the budget; interactive guards vary; cron leases use Postgres. |
| Sentry                                      | [sentry](references/sentry.md)                 | Errors are silently dropped (HTTP 429 on the error item only).                 |
| Novu                                        | [novu](references/novu.md)                     | Workflow runs beyond the plan are refused or billed.                           |
| Resend                                      | [resend](references/resend.md)                 | Free plan blocks at 100 per day and 3,000 per month.                           |
| Stream (chat and video)                     | [stream](references/stream.md)                 | Paid cliff at the MAU and minute caps.                                         |
| Razorpay (fees as a cost line, not a quota) | [razorpay](references/razorpay.md)             | No quota; every transaction and refund has a fee.                              |

## Cross-vendor rules

1. A meter you cannot see is a meter that will surprise you. Every vendor above has a monitoring command in its reference; run it before a launch, a load test and the first day of each month.
2. Prefer a hard cap over an alert where the vendor offers one, except where the cap would take down production. Money paths (checkout, webhooks, payouts) must never sit behind a cap that fails closed without an alert.
3. A scheduled job costs money on every vendor it touches. The ticker (`netlify/functions/cron-tick.mts`) has a tested planned-wave ceiling of `MAX_TARGETS_PER_TICK=10` in the shared schedule catalog (cadence and offsets; not runtime truncation); adding a target means choosing its cadence and offset deliberately.
4. Report to Sentry at most once per run and once per standing finding. Grouping inside Sentry does not reduce quota; only sending fewer events does. Enforcer: `applyErrorBudget` in `sentry.shared.config.ts` (per process only) `lib/observability/throttled-capture.ts`, `lib/observability/run-failures.ts` (per run) and `lib/observability/standing-finding.ts` (across runs).
5. Never let preview or branch deploys share production's Upstash, Novu or Stream credentials (see `docs/deployment/netlify.md`). A preview QA run otherwise spends production quota.
6. Fail-open versus fail-closed is a billing decision: when a metered dependency is capped, say which way the caller fails and make the failure report once, not once per request.
7. Route every outbound email, notification and webhook through idempotency keys and the Postgres outbox (`NotificationOutbox`, `FailedEmail`, `OutboundWebhookDelivery`) drained under `withCronLock` (`SystemJobExecution` lease), so a vendor failure never becomes an infinite retry loop.
8. Every guardrail here names its enforcer. If you cannot name the file, test or console setting that makes a rule true, the rule is a hope, not a guardrail.

Use the provider billing meter, not job execution rows, for costs. Recheck the linked account and dated plan capabilities before quoting an allowance. Deduplicated job/minute counts remain estimates. Netlify background feature grants and successful packaging need deployed verification; an asynchronous 202 is acceptance, not completion.

## Console spend controls checklist

Netlify usage notifications; Sentry spike protection (and Team plan for a spend threshold); Supabase Spend Cap ON; Upstash Max Monthly Budget; GitHub Actions budget above zero with stop-usage; Resend, Stream and Novu usage alerts; Vercel and Cloudflare billing alerts if adopted. Click-paths are in each reference.

## Before you add X, price it

1. Which vendor meters does X touch? List requests, commands, events, minutes, GB-seconds and storage.
2. How often does X run? Multiply by 30 days: a five-minute cadence is 8,640 runs a month; a six-hour cadence is 120.
3. What does one run cost on each meter, and what share of the free allowance is that? Write the number in the PR body.
4. What happens at the cap: blocked, billed, or silently dropped? Silent drops are the dangerous kind.
5. Does X work in a deploy preview, and which database, Redis, Novu or Stream tenant does it spend there?
6. How does X report failure? If it can report once per row, it will exhaust the Sentry budget; collect and report once per run.
7. Which command in the reference will show the new usage, and who looks at it?

## Billing incident runbook

Start here when the symptom matches; the detail is in the vendor reference.

| Symptom                                                                         | Vendor         | Confirm                                                                                           | Immediate mitigation                                                                                         | Follow-up                                                                                                  |
| ------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Rate limiters deny or interactive Redis guards fail                             | Upstash        | `redis_get_stats` shows commands at the cap; error text `ERR max requests limit exceeded`         | Move the database to pay-as-you-go with a budget in the Upstash console                                      | Check request limiter/interactive mutex usage; investigate cron lease failures against Postgres separately |
| Sentry shows no new errors, issues say "last seen days ago", deploys are green  | Sentry         | `find_dropped_events`; the canary email; 429 with `error_usage_exceeded` on the error item        | Wait for the period to renew or raise the on-demand budget (Team plan); stop the flooding source             | Report once per run; keep the 70 percent quota alert (`lib/observability/quota-alert.ts`)                  |
| PR checks never start, or jobs fail with "billing" or "spending limit" messages | GitHub Actions | `gh api /organizations/Practitionist/settings/billing/usage` shows minutes at the included amount | Set the Actions budget above zero or add a payment method; cancel superseded runs                            | Trim triggers and matrices; see the Actions reference                                                      |
| Error storm: one outage produced thousands of events                            | Sentry         | Issue event counts by day                                                                         | Disable the source or deploy a throttle; the budget breaker caps non-fatal events at 10 per hour per process | Add a budget family for the failure class                                                                  |
| Email sends refused or held after 100 in a day                                  | Resend         | `get-usage`, dashboard sending log                                                                | Hold broadcast sends; rely on the outbox retry                                                               | Upgrade to Pro before launch                                                                               |

The three real 2026 incidents, in order:

1. **Upstash cap, 2026-09-21, then the Sentry flood on 2026-09-22.** The five-minute ticker, with cron locks then held in Redis, spent roughly 430,000 of the 500,000 free monthly commands. At the cap every cron job failed closed and reported to Sentry on every run: about 2,653 `UpstashError` events and 1,350 `CronLockUnavailableError` events burned the 5,000-error allowance in a day. Fixes: pay-as-you-go from 2026-09-25 with a monthly budget, cron locks moved to a Postgres lease (`withCronLock` in `lib/cron/with-cron-lock.ts`), and the error budget in `sentry.shared.config.ts`.
2. **Sentry blind from 2026-09-22 until the period renews on 2026-10-19.** Sentry answered 429 to the error item and 200 to sessions and transactions, so dashboards looked alive. Fixes: the ingest canary (`lib/observability/ingest-canary.ts`, every six hours) and the 70 percent quota alert. Tracking issue: #2145.
3. **GitHub Actions minutes exhausted, 2026-10-17, blocking all CI.** Included minutes ran out and, with no budget above zero, jobs were blocked. INFERRED from the owner report; not reproducible from the repo. Mitigation: budget or payment method, then trim the triggers listed in the Actions reference.

## Verification

```bash
npx jest __tests__/performance/lighthouse-cwv-guardrails.test.ts __tests__/lib/next-config-preload.test.ts
```

Related: `docs/performance/05-lighthouse-audit-and-cwv-playbook.md` (section 5), `docs/deployment/netlify.md`, `docs/observability/sentry/06-ingest-canary.md`, `docs/upstash/00-pricing-overview.md`. Umbrella issue: #2137.
