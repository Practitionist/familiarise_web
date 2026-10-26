---
name: support
description: Guardrails for the support case system — one SupportCase per request, guided flows and hand-off, the CASE_TRANSITIONS table, explicit reopen only, immutable decisions with admin supersede and independent appeals, evidence requests, private attachments, money remedies through audited doors (support refund door, staff caps ₹5,000 per payment and ₹50,000 per rolling 24 h, second admin above ₹25,000, payout holds as EarningsHold SUPPORT_CASE), case-linked chat access and Familiarise Support intervention, the support-sla-sweep arms (notices, auto-close, problem cascade, 180-day purge, chat backstop, dispute alerts), DPDP export, erasure, legal hold, org ownership scopes, and the durable notification outbox. Load when working on anything under lib/support/, app/api/support/, app/api/appointments/[appointmentId]/support, app/api/staff/appointments/*/cancel|reschedule, lib/stream/support-*, lib/moderation/report-case.ts, components/support/, components/dashboard/backoffice/support/, the SupportCase* or SupportFinancialRecommendation models, or support sidecars in prisma/sql/check-constraints.sql; or when asked about tickets, cases, appeals, refunds from a complaint, payout holds, chat transcripts, grievances or the SLA sweep.
---

# Support

Terse rules for agents. The human explanation is in `docs/support/` (start at `docs/support/README.md`); the one-page design is `docs/start-here/05-support-system-design.md`. Every rule below names its enforcer. Grep before you assert any name.

| Reference                       | Read it when                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `references/doors-and-money.md` | Touching refunds, recommendations, holds, platform cancel or reschedule, or any `withOpsAction` door in support. |
| `references/invariants.md`      | Adding a writer, a column, a status move or a sidecar object; deciding DB versus app enforcement.                |
| `references/verification.md`    | Before claiming a support change works; choosing tests; the DB race tier.                                        |

## Where things live

- Intake and flows: `lib/support/service.ts` (`runSupportTurn`), `lib/support/flows.ts`, `lib/support/platform-flows.ts`, `lib/support/flow-walk.ts`, `lib/support/escalation.ts`, `lib/support/priority.ts`.
- Case service: `lib/support/case-service.ts` (`createOrReuseSupportCase`, `appendSupportCaseTurn`, `executePatchLifecycleTx`), `lib/support/case-transitions.ts` (`CASE_TRANSITIONS`).
- Actions (evidence, decisions, recommendations, holds): `lib/support/case-actions.ts` (`performCaseAction`, `performCaseActionTx`). Doors: `lib/support/refund-door.ts`, `lib/support/case-doors.ts`. Caps: `lib/support/money-policy.ts`. Holds: `lib/support/case-holds.ts`.
- Access: `lib/support/case-access.ts` (`canCorrespondOnCase`, `caseCorrespondentIds`, `visibleCaseAccess`, `projectCaseForViewer`).
- Sweep: `lib/support/sla-sweep.ts` (`runSupportSlaSweep`), `lib/support/problem-cascade.ts`, `lib/support/evidence-retention.ts`; registered once as `support-sla-sweep` in `lib/cron/cleanup-registry.ts`.
- Privacy: `lib/support/privacy-export.ts`, `lib/support/erasure.ts`.
- Chat access: `lib/support/chat-access.ts`, `lib/support/chat-doors.ts`, `lib/support/chat-access-end.ts`, `lib/support/chat-sweep.ts`, `lib/support/chat-transcript.ts`, `lib/stream/support-intervention.ts`.
- Sidecar: `prisma/sql/check-constraints.sql` (search `support_`, `earnings_hold_`, `ops_action_proposal_one_open_key`).

## Do

- Create or reuse cases only through `createOrReuseSupportCase()` (directly or via `createSupportTicket()` / `runSupportTurn()`). It owns dedupe, the FAM reference and intake notifications.
- Move status only through code that calls `assertCaseTransition()` with the right actor, plus your own compare-and-set (`updateMany` with the expected prior state). PATCH status goes through `executePatchLifecycleTx()`.
- Route every money or hold action through its door: `REVIEW_REFUND` → `reviewSupportRefundDoor`, `VOID_RECOMMENDATION` → `voidSupportRecommendationDoor`, `APPLY_HOLD`/`RELEASE_HOLD` → `applySupportHoldDoor`/`releaseSupportHoldDoor`. Non-party booking cancels go through `app/api/staff/appointments/[appointmentId]/cancel/route.ts`.
- Pass `tx` to every helper inside `$transaction` (`PG_POOL_MAX=1`, AGENTS.md §2.1). `evidenceRecipientsByAppointment()` and friends take a db argument for this reason.
- Stage notifications inside the business transaction with `stageBell()` / `deliver()` and a stable `entityRef`; flush with `flushNotificationsAfter()`.
- Give every action a `clientActionId` and every turn a `clientTurnId`; replays must compare stored columns (`replayCaseActionTx()`), never trust the key alone.
- Return expected refusals as plain `{ error, code, ...detail }` (`CaseConflictError`, `CaseActionError`, `OpsRefusal`); use `supportError()` only for unexpected failures.
- Add any new CHECK, partial unique or trigger to `prisma/sql/check-constraints.sql`, and keep the open-scope tuple out of `@@index`/`@@unique` on `SupportCase`.
- When code changes a rule here, update this skill and the matching `docs/support/` page in the same PR.

## Never

- Never write another domain's tables from support code (refunds, earnings, bookings, payouts). Call the domain's door or service.
- Never reopen a decided case, and never reopen on a plain reply. A customer reopens only with `reopen: true` from the requester or submitter, undecided, within `REOPEN_WINDOW_MS` (14 days). Staff reopen an undecided RESOLVED or CLOSED case through PATCH (`CASE_TRANSITIONS` in `lib/support/case-transitions.ts`), with no 14-day window.
- Never set `activeChannel` to anything but HUMAN after creation.
- Never update or delete a `SupportCaseDecision` (trigger `support_case_decision_immutable`). Corrections are a new row with `supersedesDecisionId`, admin-only, before `appealUntil`, with no appeal filed.
- Never decide a PROBLEM case, and never link an incident to a RESOLVED or CLOSED problem.
- Never resolve incidents inside the problem's transaction. The cascade is the bounded sweep arm.
- Never add a support payment-hold table or write `EarningStatus.HELD` directly. Use `holdPaymentForCase()` / `releaseCaseHoldRows()` (which call `placeEarningsHolds()` / `releaseEarningsHolds()`).
- Never release holds without the gate in `holdReleaseRefusalTx()` (no open recommendation, fresh session, money doors open).
- Never write a channel's `config_overrides` outside `syncSupportBoundary()` (`lib/stream/support-boundary.ts`). It revokes member changes and owner truncation for `user` and `channel_moderator` while an INTERVENE grant is live and clears them when the last one ends; call it after commit wherever a grant starts or ends. A READ must change nothing in Stream.
- Never mint a Stream token for another user, give operators Stream `admin`, or read a chat with a client `watch()`. Staff reach chats only through the case chat routes, which audit every page.
- Never let an organization tag grant access to a personal case, and never return message bodies from organization feeds.
- Never write a JS reconciler for a rule the sidecar already enforces (AGENTS.md §1.3); never add a second scheduler, Redis cron lock or `jobs/` wrapper for the sweep (AGENTS.md §1.1, §1.4).
- Never capture to Sentry per row in a sweep arm; collect into `errors` and report once.
- Never run `prisma db push`, `npm run db:*` or the DB race tier against the shared database.

## Gotchas

- Attachment finalisation and orphan removal compete on the pending row. Claim
  the tombstone before deleting, reread live references per 100-path batch, and
  never revive a tombstoned upload. Completed live evidence retains its replay
  policy; pending evidence does not bypass closure. See
  [attachment ownership](../../../docs/support/04-evidence-and-attachments.md#finalisation-and-cleanup-ownership)
  for retry, verification and rollback limits.

- `SupportTicket`, `supportTicketId`, `SupportThreadCategory`, `/support-threads`, `support-ticket-update` and the export key `supportTickets` all mean `SupportCase` now. `app/api/support/tickets/route.ts` is a staff-only outbound intake, not a legacy reader.
- No caller passes actor `SYSTEM` to the transition table; the sweep's auto-close and the cascade write their own compare-and-set. Both release holds and end chat grants in their transaction. Auto-close (`releaseAutoClosedCaseTx()`) releases as the system without step-up, but skips a held case while a recommendation is open or money doors are closed (`autoCloseRefusalTx()`); keep that gate if you touch it.
- The hold and void doors run at default isolation inside `withOpsAction`; `performCaseAction()` (decisions, evidence, recommendations, review) runs Serializable with `withSerializableRetry()`.
- `applyHoldTx()` has no case-status check; a hold applied after resolution is released by the auto-close.
- `support-sla-sweep` is not in `/api/admin/system-jobs/run`; re-run via `POST /api/cleanup/support-sla-sweep` with `CRON_SECRET`.
- The platform cancel door has no `secondApprover`; support refunds do.
- `familiarise-support` is a Stream-only user (no `User` row); keep it in `getExcludedUserIds()` in `scripts/stream/stream-sync.ts`.
- `releaseSeat` only marks the funded participant `REFUNDED` (no session, recording or document access; group seats resell). It never cancels the booking; that is the platform cancel door. The credits rail always releases the seat.
- Customer copy must never promise that a reply reopens a case.
- Host organizations are booking parties only through captured payments (`CAPTURED_PAYMENT_WHERE` in `lib/support/evidence-parties.ts`).
- The DPDP export shows a chat grant's basis and case reference only to the person who filed the case.
