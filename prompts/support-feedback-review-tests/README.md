# support-feedback-review-tests — E2E suite for support, feedback, reviews, moderation and disputes

This directory holds a reusable, agent-run end-to-end test suite for the customer-trust subsystem: the per-appointment support bot and conversation, support tickets and their staff inbox, session ratings and public reviews, review moderation, platform feedback, and payment disputes. It is meant to be run against a Netlify deploy preview of one pull request (or against `dev` after a merge) by an orchestrator that launches the lanes one after another. Every run produces one report per lane, a synthesis, a pull-request comment and a set of bucketed issues.

The suite was distilled from a seven-lane campaign run on 2026-10-09. Each lane file keeps every case that campaign ran, adds a permanent regression case for every defect it found (phrased as the correct behaviour, never as the bug), and adds cases the campaign missed, drawn from real complaint patterns and from India's grievance-handling rules.

## What the suite covers

| Area | Surfaces |
| --- | --- |
| Customer support | Booking "Get help" entry, bot intents, escalation to a ticket, ticket create dialog with callback, ticket case page, replies, attachments, platform-support sheet, rate-limit copy |
| Staff operations | Two-factor enrolment, support inbox, filters, SLA clocks, case workspace, public replies and internal notes, status and assignment, engineering escalation, notifications |
| Reviews and feedback | Session star rating and private cause, public review composer, edit history, withdraw and revive, expert reply, public score gates, organisation feedback summary |
| Moderation | Reporting a review, the moderation queue, exclude from rating, remove, dismiss, audit trail, appeal and transparency to expert and reporter |
| Platform feedback | Submission, staff queue, status changes, submitter notification |
| Disputes | Staff and admin dispute reads, PII redaction, evidence form, deadline countdown, organisation disputes tab |
| Cross-cutting | Schema drift against the live database, rate-limit budgeting, accessibility, India regulatory clocks, Sentry observability, cleanup |

## Persona map

| Persona | Seed account | Used for |
| --- | --- | --- |
| Customer (consultee) A | Picked by query in lane 01: role CONSULTEE, onboarding completed, a rateable held occurrence | Main support journey, ratings, reviews |
| Customer B and C | Two more consultees picked the same way | Separate per-route rate-limit budgets, callback and tag cases |
| Race customer | One more consultee with an eligible session, found in lane 01 | Concurrent first-save races |
| Expert (consultant) | A consultant below the publish gate and one with at least five rated clients, found in lane 01 | Receiving reviews, reply, report, score gate |
| Organisation owner | The owner of an organisation that has appointments, found in lane 01 | Organisation triage, feedback summary, disputes tab |
| Staff | A staff operator from the roster | Inbox, replies, moderation queue |
| Admin | An admin operator from the roster | Admin-only gates, dispute reads, removals |

The authoritative roster is `docs/team/mock-credentials.md` at the repository root; all seeded accounts share the seed password documented there. Some roster accounts are not onboarded and some have a role that differs from their surname group, so personas are picked by query, never by name. Fixture ids are never stored in this suite; lane 01 discovers them at run time.

## How to run

1. The orchestrator reads [`00-orchestrator.md`](./00-orchestrator.md) and fills the run parameters in [`_shared/shared-setup.md`](./_shared/shared-setup.md) section 1.
2. The orchestrator launches the lanes strictly one after another, because they share a database, rate-limit budgets and fixture rows. Lane 01 must pass its preflight before any other lane starts.
3. Each lane agent reads the shared setup, the complaint catalogue and its own lane file, executes every case, and writes its report using the report format in the shared setup.
4. After each lane the orchestrator re-checks every FAIL at the pull-request head before accepting it, then launches the next lane.
5. After lane 06 the orchestrator publishes the report, comments on the pull request, files bucketed issues and passes the cleanup gate.

Lanes never edit repository files, never spawn sub-agents, and never run `next dev`, `next build`, `prisma db push` or `npm run db:*`.

## Files

| File | Purpose |
| --- | --- |
| [`00-orchestrator.md`](./00-orchestrator.md) | Orchestrator playbook: model tiers, sequencing, verification, decisions, reporting, cleanup gate |
| [`_shared/shared-setup.md`](./_shared/shared-setup.md) | Run parameters, hard rules, sign-in and 2FA recipes, rate-limit budget, fixture discipline, report format |
| [`_shared/complaint-catalogue.md`](./_shared/complaint-catalogue.md) | Customer, expert and staff complaint patterns, psychology heuristics and India regulatory expectations, as test heuristics |
| [`01-preflight-drift-and-fixtures.md`](./01-preflight-drift-and-fixtures.md) | 14 cases: schema drift check, health, sign-in, 2FA status, seed gaps, fixture discovery |
| [`02-customer-support-journey.md`](./02-customer-support-journey.md) | 33 cases: the customer side of support, from bot to ticket to reply |
| [`03-staff-support-operations.md`](./03-staff-support-operations.md) | 30 cases: the staff side: inbox, case workspace, replies, status, races, escalation |
| [`04-reviews-and-session-feedback.md`](./04-reviews-and-session-feedback.md) | 29 cases: session ratings, public reviews, replies, scores, organisation feedback summary |
| [`05-moderation-platform-feedback-disputes.md`](./05-moderation-platform-feedback-disputes.md) | 30 cases: moderation queue and actions, platform feedback, disputes |
| [`06-cleanup-and-sentry.md`](./06-cleanup-and-sentry.md) | 13 cases: fixture removal, global tag sweep, restore verification, Sentry check |

The suite holds 149 cases in total. Reports are named `0N-report.md` after the lane number.

## Case ID scheme and tags

Case IDs look like `SFR-02-07`, meaning lane 02, case 07. Each case carries one or more tags. `[PR-specific]` marks behaviour introduced or changed by the pull request under test and is only meaningful when a PR is under test. `[SUBSYSTEM]` marks standing behaviour that must hold on every run. `[CX-A]`, `[CX-B]` and `[CX-C]` followed by a number point to an entry in the complaint catalogue.
