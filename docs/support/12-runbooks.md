---
title: Support runbooks
type: how-to
band: domain
audience: sde2
status: live
last-reviewed: 2026-11-04
---

# Support runbooks

Each runbook follows the same shape: the symptom, how to confirm it, the impact, the fix, how to verify the fix, and what prevents it. The SQL is read-only. Never write to the shared database by hand: every fix below goes through an audited door or the sweep, so the ops log and case timeline stay true (AGENTS.md §2.3).

## Stuck or failed support refund

**Symptom.** A recommendation shows Approved, but the customer has no refund, or the refund shows FAILED.

**Confirm.**

```sql
SELECT r.id, r."caseId", r."paymentId", r."amountPaise", r."decidedAt", r."decidedById",
       r."voidedAt", f.id AS refund_id, f.status AS refund_status
FROM "SupportFinancialRecommendation" r
LEFT JOIN "Refund" f ON f.id = r."refundId"
WHERE r.approved = true AND (f.id IS NULL OR f.status IN ('FAILED', 'CANCELLED'))
ORDER BY r."decidedAt";
```

Also look for a refund keyed to the recommendation that is not yet linked: `SELECT id, status FROM "Refund" WHERE "dedupeKey" = 'case-recommendation:<recommendationId>';`. The `support.refund.review` ops-log row for the approval records `refundId`, `rail` and `refundStatus`.

**Impact.** The case cannot be decided `REFUND_APPROVED` (409 `REFUND_NOT_LIVE`), and the money committed by the approval still counts against the payment's staff cap.

**Fix.**

1. If a keyed refund exists and is PENDING, wait: the webhook or the reconcile sweep will settle it. Do not void.
2. If the refund is FAILED or CANCELLED, or none exists and the approval is older than 15 minutes, the **decider** retries from the case's resolution panel (`REVIEW_REFUND` again with the same verdict and a fresh preview). The retry re-runs every check and writes `RECOMMENDATION_DECIDED` with note `RETRIED`.
3. If the refund should not be sent (for example a chargeback opened), an **admin** voids it (`VOID_RECOMMENDATION`, step-up, reason required). A void inside 15 minutes of the approval or of a retry is refused with 409 `NOT_VOIDABLE`.
4. A chargeback that is live blocks every support refund (409 `REFUND_BLOCKED_BY_DISPUTE`); handle the dispute in the disputes console instead.

**Verify.** The query returns no row for the recommendation, the case timeline shows `RECOMMENDATION_VOIDED` or a live refund, and the decision can be recorded.

**Prevention.** [Money remedies](05-money-remedies.md#recommendation-to-refund).

## A refund held by another door's owed refund

**Symptom.** The Refunds tab lists "Payment … (…): Another refund is still owed on this payment; refund the remaining ₹X by hand, then release the hold." (or, with nothing left to freeze, without the hold clause), and the expert's earnings on that payment may show HELD. A later row "the top-up is settled; release the hold on its earnings" means only the hold is left.

**Confirm.**

```sql
SELECT e."correlationId", e.context->>'owedPaise' AS owed_paise, e."createdAt",
       p."refundOwedKey", p."refundOwedPaise"
FROM system_events e
JOIN "Payment" p ON p.id = e.context->>'paymentId'
WHERE e.category = 'PAYMENT' AND e."correlationId" LIKE 'owed-already-held:%'
  AND e."createdAt" >= now() - interval '180 days'
ORDER BY e."createdAt";

SELECT "consultantEarningsId", "organizationEarningsId", "releasedAt"
FROM "EarningsHold"
WHERE reason = 'OPERATOR' AND "sourceRef" = '<correlationId>';
```

**Impact.** A door (a rejection, a moderation cancel, a no-show, a maintenance freeze or an overage credit-back) ended the booking while another door's partial refund already held the payment, so its own refund of ₹X was never stamped. A full-balance holding refund already covers the door, so it records nothing. The buyer is short ₹X until someone refunds it, and the payment's unpaid earnings stay held. A class-wide cancel never gets here: it refuses (next runbook).

**How the row closes.** It reads money, not the hold: it is open while the refunds that landed on the payment after the event cover less than ₹X and the payment still has a refundable balance. The holding refund's own refund never counts, nor does the share of a hand refund that settled the holding refund first. When two doors lost on one payment, later refunds pay the oldest row first. Any other later refund on the payment counts, whatever its reason. Releasing an earning from the Earnings tab leaves a top-up's hold alone (it answers "A refund top-up on this payment holds this earning…"); once the money is covered the row offers **Release hold**, which releases only that top-up's hold, and waits while another top-up on the same payment is unpaid. While the older refund's marker is still on the payment, the row says so and presets **Issue refund** to the older refund plus ₹X, because a hand refund settles the older one first. The list reads the last 180 days oldest first, skipping settled top-ups, until it has 500 open rows, then says more are waiting; a row whose hold is still active is listed at any age. Events written before this rule recorded an amount, or older than the window with no hold, are not listed: run the triage query below once after deploy.

**Fix.**

1. Check the payment's refunds: if the first door's refund and any later refunds already cover what the buyer is owed, skip to step 3.
2. Refund through **Issue refund** on the row: the amount is preset to ₹X, or to the older refund plus ₹X while the older refund's marker is still on the payment (a hand refund settles it first). If the older refund is still being sent, wait for it: a hand refund is refused while it is in flight.
3. Press **Release hold** on the row, with a reason. It releases only this top-up's hold; it is refused while another top-up on the payment is still owed or a refund or dispute is open.

**Verify.** The row leaves the Refunds tab, and the earnings return to their prior status.

**Triage of events from before the rule (read-only, once).**

```sql
SELECT e."correlationId", e."createdAt", e.context
FROM system_events e
WHERE e."correlationId" LIKE 'owed-already-held:%'
  AND (e.context->>'owedPaise' IS NULL OR e."createdAt" < now() - interval '180 days')
ORDER BY e."createdAt";
```

For each, compare the payment's refunds with what the door owed (the event's message names the holding refund); refund any shortfall through **Issue refund**.

**Prevention.** None needed: the door records and holds automatically. See [refunds](../finance/30-refunds-disputes/01-refunds.md#5-when-a-refund-does-not-finish).

## A class or webinar won't cancel: a seat's refund is still owed

**Symptom.** The class-wide cancel (money console, `cancel-series`), the admin whole-event refund, or the host's cancel answers 409. An operator reads "Seat payment … has a refund still owed from another action (…); settle it from Refunds → Needs human, then cancel the class again." (`REFUND_NEEDS_SUPPORT`; the admin whole-event refund says "then run this again") or "Seat payment … has a refund from another action (…) still being sent; wait for it to finish, then cancel the class again. If it fails, settle it by hand from Refunds → Needs human." (`REFUND_IN_PROGRESS`). A host reads "This class couldn't be cancelled yet: a refund on one of its seats …". A moderation ban lists the class under `failures` with the operator line ending "then re-run the ban's bulk cancel".

**Impact.** Nothing was committed: the class, its sessions, its seats and every other seat's payment are as they were, and the class stays live. A whole-event cancel must own every seat's refund marker, so it waits for the older refund rather than leaving one seat's refund owned by nobody.

**Fix.**

1. `REFUND_NEEDS_SUPPORT`: the older refund spent its retries or a dispute holds it. Settle it from the Refunds tab's stuck owed refund row (**Issue refund**), or resolve the dispute first.
2. `REFUND_IN_PROGRESS`: the older refund is still being sent or retrying (up to about 5 hours). Wait for it; a hand refund is refused while its refund is in flight (`OWED_REFUND_IN_FLIGHT`). If it fails for good, it appears under Refunds → Needs human: settle it there.
3. Cancel the class again from the same door. For a moderation ban, re-run the ban's bulk cancel from the moderation console once the refund settles: a refused class is not retried automatically, and each step of the sweep is idempotent.

**Verify.** The cancel answers 200 and every seat's refund carries the event's own key (`event-cancel:<eventId>:pay:<paymentId>`).

## Failed evidence purge

**Symptom.** The sweep returns HTTP 500 with `evidence-purge case <id>: N file(s) not confirmed deleted`, or `evidence-purge: 2000+ live disputes; purge skipped this run`.

**Confirm.**

```sql
-- Broad candidates: closed 180+ days, not purged, not on legal hold, no recent appeal.
-- purgeEligibleWhere() also skips cases linked to a live dispute (next query) and
-- appeal cases whose appealed case closed under 180 days ago, so a row here is not
-- by itself a purge failure.
SELECT c.id, c."referenceNumber", c."closedAt", c."legalHoldAt"
FROM "SupportCase" c
WHERE c."closedAt" <= now() - interval '180 days'
  AND c."legalHoldAt" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "SupportCaseEvent" e WHERE e."caseId" = c.id AND e.kind = 'EVIDENCE_PURGED')
  AND NOT EXISTS (
    SELECT 1 FROM "SupportCaseDecision" d JOIN "SupportCase" a ON a."appealOfDecisionId" = d.id
    WHERE d."caseId" = c.id AND (a."closedAt" IS NULL OR a."closedAt" > now() - interval '180 days'))
ORDER BY c."closedAt";

-- Live disputes (each holds its linked cases; 2,000 or more skips the whole arm)
SELECT "paymentId", status FROM "Dispute"
WHERE status NOT IN ('WON', 'LOST', 'CHARGE_REFUNDED', 'CLOSED', 'WARNING_CLOSED');

-- Broad: attachment rows still live on a case closed 180+ days. Rows on a case that is
-- on legal hold, recently appealed or linked to a live dispute are retained, not failed.
SELECT a.id, a."caseId", a."storagePath" FROM "SupportCaseAttachment" a
JOIN "SupportCase" c ON c.id = a."caseId"
WHERE a."deletedAt" IS NULL AND c."closedAt" <= now() - interval '180 days';
```

**Impact.** Personal content stays past the period the privacy policy promises. The failing case does not block other cases, but it fails the run every 30 minutes.

**Fix.**

1. For "not confirmed deleted": check each path in the private `support-attachments` bucket. A storage outage or permission error is the usual cause; once storage answers, the next run retries the case from the start (nothing was written).
2. If the case must be kept (a dispute or legal claim), an admin places a [legal hold](#placing-or-lifting-a-legal-hold); the purge then skips it.
3. For "2000+ live disputes": the arm stays off until fewer disputes are live; there is no override.

**Verify.** The case has an `EVIDENCE_PURGED` event whose `toValue` is the file count, its attachment rows are tombstoned, and it no longer appears in the candidate query. A 500 from the next run is a separate run-level failure if its `errors` name another case or arm.

**Prevention.** [Privacy and retention](08-privacy-and-retention.md#the-180-day-evidence-purge).

## Intervention seat stuck

**Symptom.** Posting as Familiarise Support returns 409 `NOT_JOINED` on a live intervention; or the grant has ended and Familiarise Support is still a member of the booking chat; or the sweep's `errors` list `chat-access join <grantId>`, `chat-access leave <grantId>` or `chat-access boundary <channelType>:<channelId>`.

**Confirm.**

```sql
-- Live interventions not seated (the sweep retries these once they are 2+ minutes old)
SELECT id, "caseId", "channelType", "channelId", "createdAt", "expiresAt"
FROM "SupportCaseChatAccess"
WHERE kind = 'INTERVENE' AND "endedAt" IS NULL AND "streamJoinedAt" IS NULL
ORDER BY "createdAt";

-- Ended interventions whose seat was never cleared (the sweep retries the leave)
SELECT id, "caseId", "channelType", "channelId", "endedAt", "endReason"
FROM "SupportCaseChatAccess"
WHERE kind = 'INTERVENE' AND "endedAt" IS NOT NULL
  AND "streamJoinedAt" IS NOT NULL AND "streamLeftAt" IS NULL
ORDER BY "endedAt";
```

**Impact.** An unseated grant means staff cannot post, although the parties may already have the "Support joined" bell. A seat left after the grant ended keeps a visible Familiarise Support member, and possibly the channel lock, in a chat staff no longer have a basis to be in.

**Fix.**

1. **Not seated.** `retryJoins()` in `lib/support/chat-sweep.ts` calls `joinIntervention()` (`lib/stream/support-intervention.ts`) on every run for live, unexpired grants older than 2 minutes. A channel that no longer exists ends the grant as `CHANNEL_GONE`. A frozen channel is left alone and retried, because it may thaw. Any other error, such as an open Stream circuit breaker, is listed in `errors` and retried next run. If the case no longer needs the seat, end the intervention (`END_INTERVENTION` on `POST /api/support/cases/[caseId]/chat`).
2. **Not cleared.** `leaveEndedInterventions()` calls `leaveIntervention()`. That sends `fs-leave-<grantId>`, removes `familiarise-support` and stamps `streamLeftAt`. If another live, seated intervention holds the same channel, it only stamps (`handed-over`) and the seat stays. A missing channel counts as left, and a duplicate leave message is ignored, so re-running is safe ([re-run the sweep](#re-running-the-support-sweep)).
3. **Member present, no row matches.** If `addMembers` succeeded but the `streamJoinedAt` stamp failed, and the grant then ended, neither query finds it and nothing reconciles it. First check that no other intervention holds the seat, the same successor check `leaveIntervention()` makes:

   ```sql
   SELECT id, "caseId" FROM "SupportCaseChatAccess"
   WHERE kind = 'INTERVENE' AND "channelType" = '<channelType>' AND "channelId" = '<channelId>'
     AND "endedAt" IS NULL AND "streamJoinedAt" IS NOT NULL AND "expiresAt" > now();
   ```

   Only if it returns no row, remove `familiarise-support` from the channel by hand in Stream. If it returns a row, that grant owns the seat; leave the member in place.

4. **Boundary.** `syncRecentBoundaries()` re-applies or lifts the channel lock (`syncSupportBoundary()`) only for channels whose interventions started or ended in the last hour. After that window nothing re-syncs it until an intervention on the channel starts or ends again.

**Verify.** The first query no longer returns the grant: `streamJoinedAt` is set and the chat shows the `fs-join-<grantId>` line, or the grant ended as `CHANNEL_GONE`. For a stuck leave, the second query no longer returns the grant: `streamLeftAt` is set and Familiarise Support is not a member, unless a successor grant holds the seat. The next sweep has no `chat-access` errors for these ids.

**Prevention.** [Chat access and intervention](06-chat-access-and-intervention.md#intervention-join-post-leave).

**Symptom.** Staff cannot post as Familiarise Support (409 `NOT_JOINED`), or Familiarise Support is still in a chat after the case was resolved.

**Confirm.**

```sql
-- Ended but still seated: the leave never completed (the sweep retries)
SELECT id, "caseId", "channelType", "channelId", "endedAt", "endReason", "streamJoinedAt"
FROM "SupportCaseChatAccess"
WHERE kind = 'INTERVENE' AND "endedAt" IS NOT NULL
  AND "streamJoinedAt" IS NOT NULL AND "streamLeftAt" IS NULL
ORDER BY "endedAt";

-- Live but never seated more than 2 minutes after the grant (join failed or channel frozen)
SELECT id, "caseId", "channelType", "channelId", "createdAt", "expiresAt"
FROM "SupportCaseChatAccess"
WHERE kind = 'INTERVENE' AND "endedAt" IS NULL AND "streamJoinedAt" IS NULL
  AND "expiresAt" > now() AND "createdAt" < now() - interval '2 minutes';

-- Due to end but not yet ended (sweep lag or errors)
SELECT a.id, a.kind, a."expiresAt", c.status, c."deletedAt"
FROM "SupportCaseChatAccess" a JOIN "SupportCase" c ON c.id = a."caseId"
WHERE a."endedAt" IS NULL
  AND (a."expiresAt" <= now() OR c.status IN ('RESOLVED', 'CLOSED') OR c."deletedAt" IS NOT NULL);
```

Sweep errors carry the prefixes `chat-access join`, `chat-access leave` and `chat-access end`.

**Impact.** A stuck join means staff cannot speak in the chat; parties may already have received the "joined" bell. A stuck leave means the banner keeps showing Familiarise Support after the case ended.

**Fix.**

1. Let the sweep retry: it retries joins every run after 2 minutes and leaves every run, 10 rows per step. A frozen channel keeps failing until it is unfrozen; a deleted channel ends the grant as `CHANNEL_GONE`.
2. To stop a stuck join, end the intervention (`END_INTERVENTION`); the grant ends and no seat is taken.
3. If Familiarise Support is a member with no seated grant (the add succeeded but the stamp did not, and the grant ended), remove the `familiarise-support` member from that channel in the Stream dashboard. No job reconciles this case.
4. If the support user itself is missing in Stream, the next join recreates it (`ensureSupportUser()`). The daily Stream user sync never deletes it: `familiarise-support` is in its default exclusion set (`getExcludedUserIds()` in `scripts/stream/stream-sync.ts`).

**Verify.** The queries return no rows for the grant; the channel's members no longer include `familiarise-support` (or include it under exactly one live grant).

**Prevention.** [Chat access](06-chat-access-and-intervention.md#failure-modes).

## Placing or lifting a legal hold

**When.** Counsel or the grievance officer asks to preserve a case's evidence beyond the 180-day period, for a dispute, a complaint to an authority or litigation.

**Steps.**

1. An **admin** opens the case in the back office and sets the legal hold with a note naming the request (the note is stored on the `LEGAL_HOLD_CHANGED` event and survives the purge). The API is `PATCH /api/support/cases/[caseId]` with `legalHold: true` and the case's `expectedUpdatedAt`. STAFF get 403 `FORBIDDEN`.
2. The hold works on a CLOSED case without reopening it.
3. To lift it, the admin sends `legalHold: false` with a note. If the case is already past 180 days, the next sweep run purges it.

**Confirm.**

```sql
SELECT c.id, c."referenceNumber", c."closedAt", c."legalHoldAt", e."createdAt", e."toValue", e.note
FROM "SupportCase" c
JOIN "SupportCaseEvent" e ON e."caseId" = c.id AND e.kind = 'LEGAL_HOLD_CHANGED'
WHERE c.id = '<caseId>' ORDER BY e."createdAt";
```

Derived holds need no action: a live chargeback on a linked payment or an open or recent appeal already blocks the purge.

**Prevention.** [Privacy and retention](08-privacy-and-retention.md#legal-hold).

## Re-running the support sweep

The admin "run job" route does not list `support-sla-sweep`. Re-run it through the cleanup route with the cron secret:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" "https://<host>/api/cleanup/support-sla-sweep?limit=20"
```

Expect 200 when clean, 500 when a row failed (the body lists `errors`), 409 when a run is in flight, and 503 in OFFLINE maintenance. Re-running is safe: every arm is idempotent per row and bounded. Recent runs:

```sql
SELECT id, status, "startedAt", "endedAt", "durationMs", "triggeredBy", left("errorLog", 300)
FROM "SystemJobExecution" WHERE "jobName" = 'support-sla-sweep'
ORDER BY "startedAt" DESC LIMIT 50;
```

`startedAt` is the lease heartbeat: a live run renews it every 5 minutes (`startLeaseRenewal()` in `lib/cron/with-cron-lock.ts`). A RUNNING row whose `startedAt` is older than 15 minutes has an expired lease (lost heartbeat or ownership, not proof of a crash); the next run marks it FAILED with "Lease expired (stale RUNNING row swept)".

## DDL end-phase checklist

The support PRs left schema and sidecar changes for the owner to apply at the end, in one controlled window. This checklist is for that window. Do not run it from an agent. The legacy support tables were dropped by ad-hoc DDL through the Supabase MCP while production still read them, which broke the SLA sweep, the privacy export and the staff support metrics (#2271). Schema changes go through `prisma/schema.prisma`, the human-run `db:push` preflight and the sidecars ([`docs/prisma/README.md`](../prisma/README.md)); MCP DDL is only for an owner-approved emergency, and the `.claude/hooks/supabase-sql-gate.ts` hook stops every MCP write for the owner's approval.

1. **Stop the bleeding first.** Confirm production no longer queries the dropped legacy support tables (the stop-gap or promotion tracked in #2271). A failing `support-sla-sweep` with "table SupportTicket does not exist" means this step is not done.
2. **Drift check, read-only.** `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`. Review every statement; nothing should drop a sidecar index.
3. **Apply the schema** for the support columns and tables: recommendation `releaseSeat`, `voidedAt`, `voidedById`; `EarningsHoldReason.SUPPORT_CASE`; `SupportCase.legalHoldAt`; `SupportCaseDecision.supersedesDecisionId`; the event kinds `CHANNEL_CHANGED`, `LEGAL_HOLD_CHANGED`, `EVIDENCE_PURGED`; the tax issue types; and, from #2343, `SupportCaseChatAccess`, its enums, the four chat event kinds, `SAFETY_CONCERN` and `SupportCase.moderationReportId`. Use the exact SQL listed in each PR body.
4. **Apply the sidecar** (`npm run db:sidecars`, which runs `scripts/db/apply-sidecars.ts --all` over `prisma/sql/*.sql`): the support constraints, indexes and triggers in [the schema reference](11-schema-and-invariants.md#sidecar-objects).
5. **Verify the sidecar.** `npx tsx scripts/ci/check-db-sidecars.ts` with `DATABASE_URL` pointing at the target (it checks that every named sidecar object is in the live catalog), then rerun the drift check and expect no support statements.
6. **Bucket check.** The private `support-attachments` bucket exists with the 20 MiB limit and the allowed types (`ensureSupportEvidenceBucket()` in `lib/support/case-attachments.ts` re-applies them).
7. **Smoke on preview.** A Razorpay test-mode support refund at or below ₹5,000 as STAFF; one above ₹25,000 with a second admin; a payout hold that blocks a payout and releases at resolution; one sweep run returning 200.
8. **Stream.** Re-upsert existing operator Stream users so none keeps the old global `admin` role.

Steps 7 and 8 are owner launch gates; the scorecard lives in #2293.
