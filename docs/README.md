# Documentation Index

This documentation is organized into logical categories for easy navigation.

## File Naming Convention

All documentation files follow `NN-kebab-case.md` (e.g., `01-architecture.md`). `README.md` is the only uppercase exception.

---

## What belongs in this directory

`docs/` is the engineer's working set. Something belongs here when an engineer
needs it to build, verify, or operate the system. Four kinds of thing qualify,
and they have different shelf lives:

- **Reference** — how the system works now. Follows the code; gets rewritten.
- **Decisions** — why it works that way. Dated, and deliberately never deleted.
- **Runbooks** — what to do when it breaks. Time-sensitive; check the date.
- **Research** — what we learned before choosing. Has an expiry; re-verify.

Business and go-to-market material — hiring plans, sales playbooks, marketing
copy, outreach — is **not** a developer's working set and does not live here.
That content was removed from this repository; `git log -- docs/` retains it.

**Do not add a new top-level directory for a single document.** A directory is a
topic with several documents, not a filing cabinet. That is how this index grew
to 43 top-level entries with no stated boundary.

---

## Implemented Systems

Documentation for working, production-ready systems.

### Start Here (`start-here/`)

Platform-wide orientation and end-to-end cross-subsystem explainers.

- [README.md](./start-here/README.md) - Orientation index and subsystem reading map
- [01-booking-system-hld.md](./start-here/01-booking-system-hld.md) - Booking system high-level design: pipeline, allocation, concurrency layers, state machines, cron architecture
- [02-money-system-hld.md](./start-here/02-money-system-hld.md) - Money system high-level design: pricing, capture, legs, ledger, earnings, payouts, refunds and policy decisions
- [03-booking-and-money-machinery.md](./start-here/03-booking-and-money-machinery.md) - Canonical worked guide: the seeded cast, the entity model, numeric permutation walk-throughs and end-to-end examples, with pointers to the scoping matrices and the 20 ledger permutations

---

### Architecture

- [distributed-systems-explained.md](./architecture/distributed-systems-explained.md) - Redis distributed locking and caching implementation

---

### Dashboard

- [information-architecture.md](./dashboard/information-architecture.md) - The dashboard glossary, the current navigation trees for every role, and the planned regrouping phases
- [2026-11-08-dashboard-first-run-and-payment-legs.md](./decisions/2026-11-08-dashboard-first-run-and-payment-legs.md) - The expert first-run checklist, per-leg payment display with the legs as source of truth, the router-state header filter, the Reputation sidebar regroup and write-time audit descriptions

---

### Booking

Booking system, slot allocation, validation, and scheduling logic for all 5 event types.

- [README.md](./booking/README.md) - System overview, source code map, recommended reading order
- [01-architecture.md](./booking/01-architecture.md) - Services, data model, data flows, tentative lifecycle
- [02-event-types-and-validation.md](./booking/02-event-types-and-validation.md) - 5 event types, rules, 3 validation layers
- [03-interval-math-and-calculations.md](./booking/03-interval-math-and-calculations.md) - 30-min slots, week counting, consecutive validation
- [04-api-reference.md](./booking/04-api-reference.md) - 8 endpoints, Zod schemas, error codes
- [05-troubleshooting-and-changelog.md](./booking/05-troubleshooting-and-changelog.md) - Common errors, debugging, recent fixes
- [06-booking-lifecycle.md](./booking/06-booking-lifecycle.md) - End-to-end booking journey, per-event flows, status transitions
- [07-rescheduling-flow.md](./booking/07-rescheduling-flow.md) - Reschedule API, slot lifecycle, known issues
- [08-cancellation-flow.md](./booking/08-cancellation-flow.md) - Cancel API, cascading effects, refund triggers
- [09-trials.md](./booking/09-trials.md) - Trial session system, status lifecycle, conversion
- [10-checkout-payment-integration.md](./booking/10-checkout-payment-integration.md) - How bookings connect to payments
- [12-concurrency-and-locking.md](./booking/12-concurrency-and-locking.md) - Distributed locks, Prisma transactions, race condition prevention
- [13-cron-jobs-and-background-tasks.md](./booking/13-cron-jobs-and-background-tasks.md) - 6+ background jobs for lifecycle management
- [14-local-development-and-testing.md](./booking/14-local-development-and-testing.md) - Dev setup, mock payments, test scenarios, debugging
- [research/README.md](./booking/research/README.md) - The 2026-11-03 V2A booking review (with appendices A to D) and V2B retention review, as dated research snapshots
- [2026-11-03-booking-v2-direction.md](./decisions/2026-11-03-booking-v2-direction.md) - Booking v2 direction: the correctness fixes and multi-week Phase 0, fixed plan weeks plus Regular time, retention phase 1 and the attendance policy
- [2026-11-04-booking-v2-train-b.md](./decisions/2026-11-04-booking-v2-train-b.md) - Booking v2 train B: Regular time, the rolling 4-week horizon, the plan-end choice, frozen plan terms, and earnings that wait for owed refunds
- [2026-11-07-attendee-comms.md](./decisions/2026-11-07-attendee-comms.md) - Attendee comms: calendar links instead of attachments, a 15-minute reminder window, reminders to paid seats only, "host is live" after the host's call join, and event-lock contention kept a 409
- [2026-11-07-event-seat-waitlist.md](./decisions/2026-11-07-event-seat-waitlist.md) - A notify-only list for sold-out webinars and classes: no reservation, a 12-hour re-notice cooldown, quiet hours not applied, the notice linking straight to checkout, the release paths that stage it, a best-effort email after commit, and erasure plus a 30-day purge
- [2026-11-12-bug-hunt-booking.md](./decisions/2026-11-12-bug-hunt-booking.md) - The agreed price kept at request for 1:1s and trials, the booked session's length, published hours checked only at the request door, and a 1:1 that may cross midnight, with the options not chosen
- [01-booking-system-hld.md](./start-here/01-booking-system-hld.md) - Booking system high-level design: pipeline, allocation, concurrency layers, state machines, cron architecture
- [02-money-system-hld.md](./start-here/02-money-system-hld.md) - Money system high-level design: pricing, capture, legs, ledger, earnings, payouts, refunds and policy decisions
- [03-booking-and-money-machinery.md](./start-here/03-booking-and-money-machinery.md) - Worked guide with the seeded cast, entity model and end-to-end ledger examples

---

### Growth

- [2026-11-08-growth-waitlist-newsletter-referrals.md](./decisions/2026-11-08-growth-waitlist-newsletter-referrals.md) - One vocabulary (newsletter, appointment waitlist, slot backup interest); notify-all kept, capacity normalised on the server, host demand counts, two tables with a shared interest module; the newsletter rename with no aliases, the table rename at release, link keys derived from the auth secret, one consent ledger, segmented broadcasts on Resend Pro; referral launch scope, fraud controls and chargeback voids; confidential figures kept in Notion

---

### Growth docs

The subsystem documentation for the newsletter, announcements, the appointment waitlist, slot backup interest and referrals. The decision record is listed above under "Growth".

- [README.md](./growth/README.md) - Index, the pull requests that carry the code, and the repository-versus-Notion rule
- [00-overview.md](./growth/00-overview.md) - Growth as one subsystem: the three parts, what they share, the vocabulary, a context diagram and where things live
- [01-appointment-waitlist-and-backup-interest.md](./growth/01-appointment-waitlist-and-backup-interest.md) - Why every waiter is told at once, the lifecycle, release paths, caps, capacity normalisation, host counts, My alerts, the `demand` view and a worked example
- [02-newsletter-and-announcements.md](./growth/02-newsletter-and-announcements.md) - Double opt-in, the consent ledger, signed links, broadcast modes and segments, unsubscribe, the sending subdomains and announcements versus the newsletter
- [03-referrals.md](./growth/03-referrals.md) - The three programmes and the launch scope, fraud controls, the review hold and the chargeback void
- [04-market-research-india-first.md](./growth/04-market-research-india-first.md) - Cited findings that shaped the design, with an Unverified list
- [05-roadmap.md](./growth/05-roadmap.md) - Shipped, owner go-live, post-launch, retention and handed-off items

---

### Calendar

Calendar display, synchronization, and UI components.

- [display-analysis.md](./calendar/display-analysis.md) - Calendar display analysis
- [synchronization-refactor.md](./calendar/synchronization-refactor.md) - Calendar sync refactoring
- [responsive-appointments-system.md](./calendar/responsive-appointments-system.md) - Responsive design
- [visual-changes-summary.md](./calendar/visual-changes-summary.md) - Visual changes overview

---

### Finance

The money subsystem: checkout and pricing, capture and webhooks, the double-entry ledger, refunds and chargebacks, payouts and TDS, organisation funding, tax, and operations. See [finance/README.md](./finance/README.md) for the full index and reading paths.

- [02-money-system-hld.md](./start-here/02-money-system-hld.md) - Money system high-level design: the 20-30 minute explainer
- [03-booking-and-money-machinery.md](./start-here/03-booking-and-money-machinery.md) - Worked guide with the seeded cast, entity model and worked numeric examples
- [01-booking-system-hld.md](./start-here/01-booking-system-hld.md) - Booking system high-level design: pipeline, allocation, concurrency layers, state machines, cron architecture
- [finance/00-overview/01-money-map.md](./finance/00-overview/01-money-map.md) - Diagram-first system map
- [finance/70-operations/05-money-runbooks.md](./finance/70-operations/05-money-runbooks.md) - Symptom-first money runbooks
- [finance/90-decisions/README.md](./finance/90-decisions/README.md) - The money ADRs and the gateway decision
- [finance/60-tax/05-gst-registration-and-tax-regime.md](./finance/60-tax/05-gst-registration-and-tax-regime.md) - The registered and unregistered GST regimes, the `Payment.gstRegime` stamp, the ₹15 lakh turnover alarm and the switch-over runbook
- [2026-11-09-tax-compliance-and-pricing-levers.md](./decisions/2026-11-09-tax-compliance-and-pricing-levers.md) - Launch unregistered under the s.22 threshold with the regime from `PLATFORM_GSTIN`; one order pipeline; the profitability floor on every platform-funded lever; the roadmap and cited sources
- [2026-11-09-payment-gateways-one-rail.md](./decisions/2026-11-09-payment-gateways-one-rail.md) - Why only Razorpay and RazorpayX are integrated: Stripe removed, the US-entity route and the merchant-of-record platforms rejected, Cashfree, Tazapay and Xflow deferred with revisit triggers

---

### Pricing

How the pricing levers combine on one order: the list price, discount codes, the welcome discount, referral credits, GST display and the platform fee. See [pricing/README.md](./pricing/README.md).

- [pricing/00-overview.md](./pricing/00-overview.md) - Every lever as it exists today, with the code that implements it
- [pricing/01-one-order-pipeline.md](./pricing/01-one-order-pipeline.md) - The five slots, the "never" rules and the worked ₹1,000 example
- [pricing/02-coupons-and-early-bird.md](./pricing/02-coupons-and-early-bird.md) - Target design for host-funded coupons and the early-bird price
- [pricing/03-roadmap.md](./pricing/03-roadmap.md) - Pricing items with priority and phase

---

### Digital Products

Standalone file sales: upload and verification, purchase and free claim, downloads, refunds and the R2 bucket setup.

- [01-architecture.md](./digital-products/01-architecture.md) - Data model, sequence diagrams, verification rules, background jobs and the R2 setup runbook

---

### Errors

How a modelled outcome travels from a route or a server action to a toast without becoming a Sentry fault.

- [01-refusals.md](./errors/01-refusals.md) - The `Refusal` class, its two messages, `ActionResult`, and the client helpers

---

### Stream (Chat & Video)

Stream.io integration for messaging and video calls. This is the implemented messaging system.

- [01-architecture.md](./stream/01-architecture.md) - Stream architecture
- [02-setup-configuration.md](./stream/02-setup-configuration.md) - Setup and configuration
- [03-provider-authentication.md](./stream/03-provider-authentication.md) - Provider authentication
- [04-chat-implementation.md](./stream/04-chat-implementation.md) - Chat implementation
- [05-video-implementation.md](./stream/05-video-implementation.md) - Video implementation
- [06-channel-management.md](./stream/06-channel-management.md) - Channel management
- [07-user-management.md](./stream/07-user-management.md) - User management
- [08-token-management.md](./stream/08-token-management.md) - Token management
- [09-background-sync.md](./stream/09-background-sync.md) - Background sync
- [10-api-endpoints.md](./stream/10-api-endpoints.md) - API endpoints
- [11-hooks-utilities.md](./stream/11-hooks-utilities.md) - Hooks and utilities
- [12-error-handling.md](./stream/12-error-handling.md) - Error handling
- [13-recording-webhooks.md](./stream/13-recording-webhooks.md) - Recording webhooks
- [19-recordings-lifecycle-and-access.md](./stream/19-recordings-lifecycle-and-access.md) - Recording lifecycle, retention and shared-run access
- [troubleshooting.md](./stream/troubleshooting.md) - Troubleshooting

---

### Supabase

Supabase configuration and policies.

- [setup-guide.md](./supabase/setup-guide.md) - Supabase setup guide

#### RLS Policies & Triggers

- [rls-policies-triggers/readme.md](./supabase/rls-policies-triggers/readme.md) - RLS overview
- [rls-policies-triggers/quick-reference.md](./supabase/rls-policies-triggers/quick-reference.md) - Quick reference
- [rls-policies-triggers/changelog.md](./supabase/rls-policies-triggers/changelog.md) - Changelog
- [rls-policies-triggers/troubleshooting.md](./supabase/rls-policies-triggers/troubleshooting.md) - Troubleshooting

---

### Upstash

Redis distributed locking.

- [redis/locking/00_README.md](./upstash/redis/locking/00_README.md) - Locking overview
- [redis/locking/01_MIGRATION_GUIDE.md](./upstash/redis/locking/01_MIGRATION_GUIDE.md) - Migration guide
- [redis/locking/02_API_REFERENCE.md](./upstash/redis/locking/02_API_REFERENCE.md) - API reference
- [redis/locking/03_DISTRIBUTED_LOCKING_DEEP_DIVE.md](./upstash/redis/locking/03_DISTRIBUTED_LOCKING_DEEP_DIVE.md) - Deep dive

---

### Notifications

Notification system: Resend (transactional email) + Novu (multi-channel orchestration).

- [README.md](./notifications/README.md) - System overview, source code map, navigation hub
- [01-architecture.md](./notifications/01-architecture.md) - Dual-layer architecture, subscriber management, preferences, fire-and-forget pattern
- [02-workflows-and-api.md](./notifications/02-workflows-and-api.md) - 27 Novu workflows, 10 Resend email functions, API endpoints

---

### Support

The support case system: one `SupportCase` per request, guided self-service and
intake, the transition table, immutable decisions and appeals, evidence, money
remedies through the owning domain's doors, staff chat access, the SLA sweep,
privacy and retention.

- [README.md](./support/README.md) - Index, module map, status vocabulary and reading order
- [01-intake-and-flows.md](./support/01-intake-and-flows.md) - Intake doors, guided flows, deflection, dedupe and references
- [02-case-lifecycle.md](./support/02-case-lifecycle.md) - The case service, the status transition table, messages, clocks and CSAT
- [03-decisions-appeals-and-supersede.md](./support/03-decisions-appeals-and-supersede.md) - Immutable decisions, the appeal window, independent appeals and supersede
- [04-evidence-and-attachments.md](./support/04-evidence-and-attachments.md) - Evidence requests to the other party, private attachments and their limits
- [05-money-remedies.md](./support/05-money-remedies.md) - Refund recommendations, the refund doors, staff caps, second-admin approval and payout holds
- [06-chat-access-and-intervention.md](./support/06-chat-access-and-intervention.md) - Case-linked chat read grants, transcripts and visible Familiarise Support intervention
- [07-sla-sweep.md](./support/07-sla-sweep.md) - The leased sweep and its arms: notices, auto-close, cascade, purge and the chat backstop
- [08-privacy-and-retention.md](./support/08-privacy-and-retention.md) - Export, erasure, the 180-day evidence purge and legal hold
- [09-org-scopes-and-visibility.md](./support/09-org-scopes-and-visibility.md) - Ownership scopes, who can see which record, and support beside feedback and reviews
- [10-notifications.md](./support/10-notifications.md) - The durable outbox, recipients and guarded delivery
- [11-schema-and-invariants.md](./support/11-schema-and-invariants.md) - Every support table, each invariant and the enforcer behind it
- [12-runbooks.md](./support/12-runbooks.md) - Stuck refund, failed purge, stuck intervention seat, legal hold, DDL end-phase checklist
- [13-decision-records.md](./support/13-decision-records.md) - Short records of the owner decisions that shaped the system

---

### Feedback

The private per-call CSAT rail (`AppointmentFeedback`): one rating per person per session, and the organisation's floored aggregate over it.

- [README.md](./feedback/README.md) - System overview, source code map, recommended reading order
- [01-architecture.md](./feedback/01-architecture.md) - One rating per call, `raterRole` and fail-closed provenance, the API, edit semantics, soft-delete
- [02-org-quality-signal.md](./feedback/02-org-quality-signal.md) - The per-consultant rollup, `quality.read`, the k-anonymity floors and three suppression rules
- [03-schema-reference.md](./feedback/03-schema-reference.md) - Every column and index of `AppointmentFeedback`

---

### Reviews

The public reputation rail (`ConsultantReview`, `ConsultantReviewRevision`, the score columns on `ConsultantProfile`, and the `ModerationAction` audit row).

- [README.md](./reviews/README.md) - System overview, source code map, recommended reading order
- [01-architecture.md](./reviews/01-architecture.md) - One review per relationship, anonymity, the right of reply, attributed removal, the public read allowlist
- [02-two-track-scoring.md](./reviews/02-two-track-scoring.md) - The 1:1 and group tracks, the plain-mean formula and its gates, the constants, the recompute
- [03-edit-trail-and-disclosure.md](./reviews/03-edit-trail-and-disclosure.md) - The revision trail, `editedAt` versus `updatedAt`, and why every edit is marked
- [04-rating-cause-and-aggregate-exclusion.md](./reviews/04-rating-cause-and-aggregate-exclusion.md) - Ratings protection: the shared cause taxonomy, claim versus adjudication, excluded versus deleted
- [05-moderation-and-reports.md](./reviews/05-moderation-and-reports.md) - Reporting a review, soft-delete on `CONTENT_REMOVED`, the staff queue
- [06-schema-reference.md](./reviews/06-schema-reference.md) - Every column and index of the four models, with the index rationale
- [07-deployment-and-deferred-work.md](./reviews/07-deployment-and-deferred-work.md) - Why the schema is additive-only, `db:preflight`, the push-then-recompute order, and the deferred issues

---

### Storage

Storage management and document review system.

- [management-strategy.md](./storage/management-strategy.md) - Storage management strategy

---

### Session documents

Session documents, plan materials and their relationship to recordings: the thread and version model, the 30-day upload window, removal requests, 90-day retention, the per-role pages and the typed error model.

- [documents/README.md](./documents/README.md) - Session documents and plan materials architecture
- [01-architecture.md](./documents/01-architecture.md) - Threading model, CAS transitions, 2-phase direct upload
- [2026-10-12-session-documents-and-recordings.md](./decisions/2026-10-12-session-documents-and-recordings.md) - ADR-01 to ADR-19

---

### Performance

Implemented performance optimizations. The numbering runs from the broad
strategy documents to the individual slow-query investigations.

- [00-optimization-checklist.md](./performance/00-optimization-checklist.md) - The React Query migration and the broader dashboard optimization history
- [01-navigation-performance.md](./performance/01-navigation-performance.md) - Canonical record of the navigation and bundle round (PR #887)
- [02-dashboard-prefetching.md](./performance/02-dashboard-prefetching.md) - Hover-based route prefetching strategy
- [03-dashboard-appointments-perf.md](./performance/03-dashboard-appointments-perf.md) - Investigation: slow `/api/appointments` query
- [04-availability-allocation-perf.md](./performance/04-availability-allocation-perf.md) - Investigation: slow wide-window availability-with-allocation query
- [05-lighthouse-audit-and-cwv-playbook.md](./performance/05-lighthouse-audit-and-cwv-playbook.md) - Lighthouse audits and the Core Web Vitals playbook
- [06-database-round-trips-and-join-loading.md](./performance/06-database-round-trips-and-join-loading.md) - Why statement count dominates dashboard latency, and when readers use join loading

---

### Observability (`observability/`)

How errors, findings and job failures reach a human. The Sentry set records the one project and its DSNs, the reporting conventions that keep modelled refusals out of the fault list, the GitHub Actions failure sink and the day it started delivering, and the triage runbook that turns a sweep into decisions.

- [observability/README.md](./observability/README.md) - The index of this folder, with a reading order by question
- [00-system-design.md](./observability/00-system-design.md) - The whole subsystem: signal sources and sinks, the three questions and their layers, quota rules, ticker failure escalation, and the planned operations console
- [01-ownership-sentry-betterstack.md](./observability/01-ownership-sentry-betterstack.md) - Which tool answers which question (Better Stack, Sentry, Postgres, the console), the planned per-item history and backlog alerts, and every option considered
- [02-research-per-item-history-and-vendors.md](./observability/02-research-per-item-history-and-vendors.md) - The vendor comparison, the warehouse triggers and the log-table inventory behind the ownership decisions
- [three-layers.md](./observability/three-layers.md) - Sentry for failures, Better Stack for jobs that did not run, and the entity trace and job run metrics for what happened to one payment, with a worked missing-refund trace
- [sentry/01-setup-and-configuration.md](./observability/sentry/01-setup-and-configuration.md) - The project, the two DSN variables and who reads each, the SDK files and knobs, the source-map token history
- [sentry/02-conventions.md](./observability/sentry/02-conventions.md) - `expected:true` for modelled outcomes, findings as messages, the tags that carry meaning, SystemEvent versus Sentry, what an issue status means
- [sentry/03-actions-failure-sink.md](./observability/sentry/03-actions-failure-sink.md) - `notify-ops-failure.sh`, the envelope endpoint, the dead DSN that silenced it for three weeks, how to tell it is working
- [sentry/04-triage-runbook.md](./observability/sentry/04-triage-runbook.md) - Scope by release, attribute every issue to one of three causes, decide with a written reason, the chronic ids, the tools
- [sentry/05-identity-and-triage.md](./observability/sentry/05-identity-and-triage.md) - Request-scoped user and organisation stamping, the back-office lookup, and the data-protection gate
- [sentry/06-ingest-canary.md](./observability/sentry/06-ingest-canary.md) - The 2026-09-22 quota outage, the six canary verdicts and why the canary emails instead of reporting
- [sentry/07-verifying-end-to-end.md](./observability/sentry/07-verifying-end-to-end.md) - The evidence ladder and the deploy-preview probe procedure
- [sentry/08-error-telemetry-privacy-reference.md](./observability/sentry/08-error-telemetry-privacy-reference.md) - The privacy and lawful-basis reasoning for sending error data to a hosted vendor
- [maintenance/11-job-machinery-catalog.md](./maintenance/11-job-machinery-catalog.md) - How every scheduled job runs, what each run records and reports, the observability gaps, and the operations dashboard spec
- [infrastructure/README.md](./infrastructure/README.md) - Index of the infrastructure roadmap and the 2026-10-31 hosting and job-runtime research, numbered in reading order
- [infrastructure/01-scale-path-research.md](./infrastructure/01-scale-path-research.md) - Research summary for the jobs and web-tier scale path, the main finding and the recorded owner decisions
- [infrastructure/03-background-jobs-and-cron-options.md](./infrastructure/03-background-jobs-and-cron-options.md) - Background jobs and cron: 25 options, what startups do, the cheapest path per stage
- [infrastructure/05-mumbai-vm-provider-research.md](./infrastructure/05-mumbai-vm-provider-research.md) - Mumbai VM provider research: Lightsail recommended, EC2 and GCP runners-up, latency figures are estimates until the probe runs
- [infrastructure/04-mumbai-hosting-comparison.md](./infrastructure/04-mumbai-hosting-comparison.md) - Costed comparison of hosting in Mumbai
- [infrastructure/06-queue-prototype-owed-refunds.md](./infrastructure/06-queue-prototype-owed-refunds.md) - pg-boss against a hand-written Prisma Job table on the owed-refund job
- [infrastructure/02-runtime-strategy-review.md](./infrastructure/02-runtime-strategy-review.md) - Unbiased review of job and runtime strategy (a dissenting analysis, not the plan)
- [infrastructure/07-job-runtime-system-designs.md](./infrastructure/07-job-runtime-system-designs.md) - Mermaid system designs for each candidate runtime
- [maintenance/14-background-job-runtime-options.md](./maintenance/14-background-job-runtime-options.md) - Comparison matrix, request-flow and state diagrams, worked example, official sources and the owner's Q&A for Netlify, Inngest, QStash, Upstash Workflow, Trigger.dev, pg-boss, DBOS and Vercel `bom1`
- [maintenance/15-job-runtime-layer-matrix.md](./maintenance/15-job-runtime-layer-matrix.md) - The eight layers of the jobs subsystem, the five compatibility rules and the eleven coherent stacks, with an HLD and a decision flowchart
- [maintenance/18-monitoring-and-tracing-failures.md](./maintenance/18-monitoring-and-tracing-failures.md) - The four monitoring layers, the one-user-or-a-group flowchart, how each failure mode is handled and the filed gaps
- [maintenance/19-secret-rotation-runbook.md](./maintenance/19-secret-rotation-runbook.md) - Secret inventory, the pre-launch rotation plan and ordered rotation procedures for the database password, API keys, `CRON_SECRET` and the seeded operators
- [maintenance/17-target-architecture-and-roadmap.md](./maintenance/17-target-architecture-and-roadmap.md) - Executive summary, the greenfield target design (a proposal), the path from today and the Netlify billing status
- [maintenance/16-job-machinery-and-portability.md](./maintenance/16-job-machinery-and-portability.md) - Job machinery line counts, what a host move removes, the Netlify-specific surface and portability as ports and adapters
- [maintenance/experiments/2026-10-31-job-runtime/README.md](./maintenance/experiments/2026-10-31-job-runtime/README.md) - Index of the raw experiment reports, the method, the honesty labels, the dashboards to browse and the cleanup log
- [2026-10-31-job-runtime-experiments.md](./decisions/2026-10-31-job-runtime-experiments.md) - Evidence and the launch runtime decision (ticker plus Background Functions, then a choice between Vercel `bom1` and a Mumbai VM)
- [2026-11-01-dunning-atomic-notices.md](./decisions/2026-11-01-dunning-atomic-notices.md) - Every dunning stage stages its overdue bell and email inside the winning claim transaction; a roster failure rolls the claim back and counts as a failed run item (a render failure no longer does, see the notification preference record, decision 15)
- [2026-10-31-gpt-issue-triage.md](./decisions/2026-10-31-gpt-issue-triage.md) - Triage of the GPT-6.1 durable-jobs issues: org invoice rail off at launch, no second-scheduler pilot, fix order for the owner
- [2026-10-26-launch-sweep-observability-and-money-holds.md](./decisions/2026-10-26-launch-sweep-observability-and-money-holds.md) - ADR-01 to ADR-12: money holds, invoice healing, tax identity, auth abuse controls, the three observability layers, ticker escalation and the Sentry quota posture
- [2026-10-31-ci-on-github-hosted-with-cuts.md](./decisions/2026-10-31-ci-on-github-hosted-with-cuts.md) - CI stays on GitHub-hosted runners: the cuts applied, the roughly $15 a month hard-stop budget, the launch-pace target and the runner fallback

---

### Deployment & Hosting Architecture (`deployment/`)

Live hosting operations on Netlify Pro, multi-platform Mumbai compute evaluation, and zero-downtime hot-standby rollback runbooks.

- [README.md](./deployment/README.md) - Deployment index & Dual-Boot multi-host portability invariants
- [multi-platform-evaluation.md](./deployment/multi-platform-evaluation.md) - Ranked 10-platform evaluation scorecard (`Cloud Run asia-south1`, `Vercel Pro bom1`, `Fly.io bom`, `Netlify Pro sin`, etc.)
- [emergency-failback-runbook.md](./deployment/emergency-failback-runbook.md) - `< 90s` hot-standby failback runbook (`Platform X -> Netlify` with zero code reverts)
- [netlify.md](./deployment/netlify.md) - Full operating handbook for live Netlify Pro (`sin`) deployments, env contexts, and build/cold-start controls
- [netlify-vs-vercel-product-map.md](./deployment/netlify-vs-vercel-product-map.md) - Netlify, Vercel and Cloudflare products by layer, how they map onto each other, and the measured 2026-10-31 facts
- [google-cloud.md](./deployment/google-cloud.md) - GCP project `familiarise` (`384845845365`), Google OAuth setup, and `gcloud` CLI guide

## Guides & Developer Resources

### Guides

Setup guides and how-to documentation.

- [cleanup-setup.md](./guides/cleanup-setup.md) - Cleanup configuration
- [cron-setup.md](./guides/cron-setup.md) - Cron job setup
- [using-fallback-image.md](./guides/using-fallback-image.md) - Fallback image usage

#### Frontend

How to write UI in this codebase — the write-path validation boundary, theming
and CSS scope, forms, and server actions vs routes. See
[guides/frontend/00-README.md](./guides/frontend/00-README.md) for reading order.

- [01-server-data-and-validation.md](./guides/frontend/01-server-data-and-validation.md) - The write path is the only boundary that counts
- [02-theming-and-css-scope.md](./guides/frontend/02-theming-and-css-scope.md) - Dark tokens, `:has()` scoping, never mutate `<html>` from a route
- [03-forms.md](./guides/frontend/03-forms.md) - Validation timing, wizard transitions, typed refusals
- [04-server-actions-vs-routes.md](./guides/frontend/04-server-actions-vs-routes.md) - Which to use, and what it means for the UI

---

### API

Mobile API integration documentation.

> The Familiarise mobile app uses a separate Dart Frog backend. These docs describe web API contracts.

- [cancellation-api-mobile.md](./api/cancellation-api-mobile.md) - Cancellation API for mobile
- [support-tickets-mobile.md](./api/support-tickets-mobile.md) - Support tickets API for mobile

---

### Prisma

Prisma operations and migration documentation.

- [prisma/README.md](./prisma/README.md) - **Full index**, and which document applies to the current posture
- [00-schema-map.md](./prisma/00-schema-map.md) - Domain diagrams of the Prisma schema
- [01-migrations-guide.md](./prisma/01-migrations-guide.md) - General-purpose Prisma Migrate reference
- [02-schema-freeze-and-migration-cutover.md](./prisma/02-schema-freeze-and-migration-cutover.md) - Pre-launch shape freeze and the `db push` to versioned-migrations cutover plan
- [2026-11-07-supabase-mcp-sql-approval-hook.md](./decisions/2026-11-07-supabase-mcp-sql-approval-hook.md) - Supabase MCP reads run freely; a PreToolUse hook stops every write for the owner's approval
- [2026-11-02-agent-instruction-layout.md](./decisions/2026-11-02-agent-instruction-layout.md) - One shared root `AGENTS.md`, nested per-directory files, and the deterministic checks that replace prose bans
- [2026-11-11-fable-5-2-advisor-tier.md](./decisions/2026-11-11-fable-5-2-advisor-tier.md) - Fable 5.2 becomes the advisor tier, audit days run at `xhigh` and orchestration at `high`, executor pins stay on Opus and Sonnet, and the Fable 5.2 briefing rules
- [2026-11-09-repo-notion-split.md](./decisions/2026-11-09-repo-notion-split.md) - The six Notion sections, one canonical pricing page, the delete-versus-archive rule, competitor screenshots kept out of git, and legal facts written into the compliance docs
- [2026-11-11-notion-workspace-consolidation.md](./decisions/2026-11-11-notion-workspace-consolidation.md) - Notion page titles carry outline numbers, repository pointers name the section and page without them, and the canonical page names after the consolidation

---

### Education

Generic software architecture patterns and learning material (not Familiarise-specific).

- [education/README.md](./education/README.md) - **Full index**

---

## Business & Research

### Team

Internal team documentation — onboarding, testing guides, and contributor resources.

- [platform-testing-playbook.md](./team/platform-testing-playbook.md) - Comprehensive platform feature walkthrough and testing checklists

---

## Roadmap — Planned & Future Work

Planned work is tracked in GitHub issues, not in this directory. `docs/roadmap/`
was retired in #1535 because it had become a second backlog running alongside
the issue tracker: the same work was recorded in both places and retired in only
one, so the directory ended up asserting that Sentry, Upstash Redis, rate
limiting and the BetterAuth migration were all unimplemented long after they
shipped.

The rule now is that anything actionable is an issue. This directory holds
architecture, decisions, runbooks and reference — what the system **is**, rather
than what it might become.

- [Open issues](https://github.com/Practitionist/familiarise_web/issues) — the backlog, banded by the `launch: pre-mvp`, `launch: post-mvp` and `launch: scale` labels
- [#1535](https://github.com/Practitionist/familiarise_web/issues/1535) — the retirement record, with a verdict for each of the 45 deleted files
- [#1532](https://github.com/Practitionist/familiarise_web/issues/1532) — ten unbuilt product features
- [#1533](https://github.com/Practitionist/familiarise_web/issues/1533) — SMS and WhatsApp notification channels
- [#1534](https://github.com/Practitionist/familiarise_web/issues/1534) — mega-menu, blog and community surfaces
- [Enterprise Subsystem](enterprise/00-foundations/01-overview.md) - SSO, org management, billing, payouts (canonical implementation docs)
