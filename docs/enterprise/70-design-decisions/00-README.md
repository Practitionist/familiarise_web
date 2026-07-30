---
title: Design decisions (ADRs) — band index
band: 70-design-decisions
audience: sde3
status: live
last-reviewed: 2026-06-15
---

# Design decisions (ADRs) — band index

This band collects the architecture decision records for the enterprise layer. Where the other bands document *what* the system does and *how* it does it, each ADR here records *why* one design was chosen over its alternatives, at the moment the choice was made. Read these before proposing a structural change: most "why don't we just…" questions are answered by an ADR, and a change that reverses one should say so explicitly in its PR description.

## Format

Every ADR follows the same four-part shape, written in full sentences:

1. **Context** — the forces in play when the decision was made, including the constraint or incident that prompted it.
2. **Decision** — the choice, stated in one or two sentences, with the code or schema that embodies it.
3. **Alternatives considered** — what was rejected and the concrete reason each alternative lost.
4. **Consequences** — what we gained, what we pay for it, and the conditions under which the decision should be revisited.

## Index

All twenty-two ADRs below are written and live (#793 wrote the first twelve; #872 added 15–17; #971 added 18; the dashboard consolidation added 19–20; and the money-productionization pass added 21–22); this index is the authoritative list. Each row links to its record.

| # | ADR | Decision in one line |
|---|---|---|
| 01 | [Double-entry journal over three logs](01-double-entry-over-three-logs.md) | One balanced `LedgerTransaction`/`LedgerEntry` journal replaced `FundingLedgerEntry`, `WalletEntry`, and `SettlementLedgerEntry` (#772). |
| 02 | [Integer paise and basis points](02-integer-paise-and-basis-points.md) | All money is integer paise and all splits are integer basis points, so no float ever touches a balance. |
| 03 | [Deterministic ledger-account IDs](03-deterministic-ledger-account-ids.md) | Ledger accounts use deterministic composite IDs (<code>kind&#124;org&#124;consultant&#124;currency</code>) instead of UUIDs (#783). |
| 04 | [Batch payouts over streaming](04-batch-payouts-over-streaming.md) | Earnings settle in periodic idempotent batches rather than per-earning transfers. |
| 05 | [GitHub Actions crons](05-github-actions-crons.md) | Scheduled jobs run as GitHub Actions invoking `npx tsx jobs/**` directly (with `CRON_SECRET`-gated routes as a manual fallback) rather than Netlify scheduled functions. |
| 06 | [Typed Membership over BetterAuth Member](06-typed-membership-over-betterauth-member.md) | Every permission gate reads the typed `Membership` row, never BetterAuth's own member table. |
| 07 | [Upstash rate limiting](07-upstash-rate-limiting.md) | BetterAuth's built-in limiter stays off; Upstash sliding windows gate the sensitive routes. |
| 08 | [Gapless invoice counters](08-gapless-invoice-counters.md) | Invoice and credit-note numbers come from per-org, per-fiscal-year atomic counters to satisfy CGST Rules 46/53. |
| 09 | [Webhook secret-rotation grace](09-webhook-rotation-grace.md) | Outbound webhook secret rotation dual-signs for 24 hours so receivers can cut over without a hard break. |
| 10 | [Session-generation clock](10-session-generation-clock.md) | Role changes bump `User.sessionGeneration` to force a membership refetch instead of revoking sessions. |
| 11 | [Live-payout submission freeze](11-live-payout-submission-freeze.md) | `ENABLE_LIVE_PAYOUTS` freezes only the gateway submission step; the whole pipeline upstream of it runs for real. |
| 12 | [PENDING_TRUST earnings parking](12-pending-trust-earnings-parking.md) | Earnings for unverified INVOICE-funded orgs park in `PENDING_TRUST` until the org verifies or pays, closing the ghost-org fraud hole (#687). |
| 13 | [Postgres-native concurrency](13-postgres-native-concurrency.md) | State transitions are guarded by CAS WHERE clauses, Serializable retries, version columns, and Redis cron locks — no Kafka, RabbitMQ, Temporal, or Inngest at this stage. |
| 14 | [Async and queue posture](14-async-queue-posture.md) | Background work stays queue-less for launch (GH Actions crons + `after()` + sweeper re-drives); Upstash QStash is the pre-approved escalation, gated on two named telemetry triggers. |
| 15 | [Currency as enum with display fields](15-currency-as-enum-with-display-fields.md) | Settlement currency stays the `Currency` enum; gateway and buyer codes live in free-text display fields, and the ledger is keyed INR-only (#783). |
| 16 | [Slot freshness without realtime](16-slot-freshness-without-realtime.md) | Slot freshness comes from server-authoritative 409 conflicts plus focused refetch and invalidate-on-mutation, not Supabase Realtime. |
| 17 | [Timezone pinned to IST for launch](17-timezone-pinned-to-ist-for-launch.md) | The platform pins to IST and removes the speculative DST materialization layer; the full IANA-TZID implementation is deferred to #872. |
| 18 | [Open B2B/B2C boundary](18-open-b2b-b2c-boundary.md) | Sponsors fund any marketplace consultant and collaborations stay org-blind by design; `ProgramConsultantAllowlist` and `Membership.exclusiveEngagement` began as schema stubs and have both been enforced at checkout since 2026-07-11. |
| 19 | [Personal-vs-org dashboard split](19-personal-vs-org-dashboard-split.md) | Dashboards split by the org-ness of the underlying session, plan or payment — views split, instruments do not; a nav entry must be a distinct destination, so scope variants become on-page toggles and filters become tabs; admin and staff keep two URL trees over one implementation, with access decided by a permission matrix rather than by which tree you landed in. |
| 20 | [Org visibility into member sessions](20-org-visibility-into-member-sessions.md) | An organization sees that a session happened — member, counterpart, plan title, time, status, cost — and never what happened in it; notes, feedback, recordings, document contents and chat stay with the two participants, enforced by select allowlists that branch on whether the scope constrains the caller to be one of them. |
| 21 | [Single writer for payment confirmation](21-single-writer-for-payment-confirmation.md) | `Payment.paymentStatus` is written by the confirmation pipeline and by nothing else; the webhook, the client's signature return, the on-demand sync and the reconcile cron all call `routeCapturedPayment` rather than recording the conclusion themselves, because a second writer turns `handlePaymentSuccess`'s already-SUCCEEDED guard from "this work is done" into "this work will never be done". |
| 22 | [Queue posture, revisited with measurements](22-queue-posture-revisited-with-measurements.md) | Measured cadence shows sub-hourly GitHub Actions schedules deliver roughly one tick per 100 minutes while nothing overlaps, so the defect is missed ticks rather than contention; the QStash escalation in ADR 14 is now authorised, Temporal stays out on cost and fit rather than on the architectural objection its 2026 Lambda workers retired, and Inngest is recorded with concrete adoption triggers. |
| 23 | [Notification scope](23-notification-scope.md) | A notification inherits the org-ness of the record that triggered it: dual-context payloads carry a required `NotificationScope`, deep links resolve to the owning dashboard rather than bouncing everyone to their personal tree, the Inbox filters the shared feed back apart by scope, and three org categories make the previously unmutable `ORG_*` family configurable. |
