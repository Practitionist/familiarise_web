---
name: support
description: Work on support intake, case transitions, decisions and appeals, private evidence, audited money remedies, case-linked chat access, SLA recovery, privacy and organization scopes. Use for lib/support/, app/api/support/, support-linked appointment and staff routes, components/support/, moderation case creation or support-sla-sweep. Domain docs and linked references define the active permissions, limits and verification procedures.
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
- A class-wide cancel (ADMIN, `classSeries.money`, `app/api/admin/class-series/[classId]/cancel-series`) refunds every attendee's unheld sessions through the normal rails, with no second admin. It refuses with 409 `REFUND_IN_PROGRESS` or `REFUND_NEEDS_SUPPORT` while any seat's payment still owes another refund; settle that refund first (wait, or refund it by hand from the Refunds tab), then cancel again.
- A learner's class exit right opens at 3 host misses inside any rolling 30 days, or max(3, 15% of N) misses in all (`exitRightFor`), and the learner keeps it once it trips, unless an ops correction (an un-void or a relabel to a non-host outcome) withdraws it before they use it; an exit already taken is final; the class-series card in the money console states both thresholds.
- A Refunds-tab row "Another refund is still owed on this payment; refund the remaining ₹X by hand, then release the hold" means a door ended a booking while another door's refund held the payment: refund ₹X through the issue door, then release the `OPERATOR` hold on the payment's earnings.
- When code changes a rule here, update this skill and the matching `docs/support/` page in the same PR.

## Never

- Never write another domain's tables from support code (refunds, earnings, bookings, payouts). Call the domain's door or service.
- Never reopen a decided case, and never reopen on a plain reply. A customer reopens only with `reopen: true` from the requester or submitter, undecided, within `REOPEN_WINDOW_MS` (14 days). Staff reopen an undecided RESOLVED or CLOSED case through PATCH (`CASE_TRANSITIONS` in `lib/support/case-transitions.ts`), with no 14-day window.
- Never leave a reopened case on its old resolution deadline: every reopen path calls `reopenedClockPatch()` (`lib/support/sla.ts`), which sets a new `resolutionDueAt` from the reopen time at the current priority, capped at a `statutoryDueAt` still ahead, zeroes `pausedSeconds` and stamps `reopenedAt`. `effectiveResolutionDueAt()` caps every clock at the statutory date except a case whose `reopenedAt` is after it. Every clock built for `slaStateOf()` must carry `reopenedAt` (the `SlaClock` type requires it). Never touch `ackDueAt` or `statutoryDueAt` on a reopen.
- Never read `statutoryDueAt` as a working deadline without the reopened rule: a case whose `reopenedAt` is later than its `statutoryDueAt` works to `resolutionDueAt` only. `effectiveResolutionDueAt()` (`lib/support/sla.ts`), the inbox's "SLA at risk" filter (`inboxWhere()` in `lib/support/case-read.ts`) and `compareCasesBySla()` (`lib/support/inbox-query.ts`) all apply it; a new reader must too.
- Never key a resolution SLA notice without its deadline (`slaNoticeKey()` in `lib/support/sla-sweep.ts`); acknowledgement keys carry none. Never add `id notIn` exclusion lists to `slaNoticeCaseWhere()`; the sweep pages by id (`stageSlaNotices()`, at most 10 pages of 200 rows per run, always from the lowest id) and skips noticed rows in memory. A case awaiting the user is not a resolution candidate; the statutory arm never pauses.
- Never set `activeChannel` to anything but HUMAN after creation.
- Never update or delete a `SupportCaseDecision` (trigger `support_case_decision_immutable`). Corrections are a new row with `supersedesDecisionId`, admin-only, before `appealUntil`, with no appeal filed.
- Never decide a PROBLEM case, and never link an incident to a RESOLVED or CLOSED problem.
- Never resolve incidents inside the problem's transaction. The cascade is the bounded sweep arm.
- Never add a support payment-hold table or write `EarningStatus.HELD` directly. Use `holdPaymentForCase()` / `releaseCaseHoldRows()` (which call `placeEarningsHolds()` / `releaseEarningsHolds()`).
- Never release holds without the gate in `holdReleaseRefusalTx()` (no open recommendation, fresh session, money doors open).
- Never write a channel's `config_overrides` outside `syncSupportBoundary()` (`lib/stream/support-boundary.ts`). It revokes member changes and owner truncation for `user` and `channel_moderator` while an INTERVENE grant is live and clears them when the last one ends; call it after commit wherever a grant starts or ends. A READ must change nothing in Stream.
- Never mint a Stream token for another user, give operators Stream `admin`, or read a chat with a client `watch()`. Staff reach chats only through the case chat routes, which audit every page.
- Never let an organization tag grant access to a personal case, and never return message bodies from organization feeds.
- Recheck presenter grants after case selection. Revoked presenters get no detail; requester-only access gets a summary. Payment and CSAT require a current correspondence grant.
- Never write a JS reconciler for a rule the sidecar already enforces (AGENTS.md §1.3); never add a second scheduler, Redis cron lock or `jobs/` wrapper for the sweep (AGENTS.md §1.1, §1.4).
- Never capture to Sentry per row in a sweep arm; collect into `errors` and report once.
- Never run `prisma db push`, `npm run db:*` or the DB race tier against the shared database.

## Planned (owner decisions 2026-11-04, not built yet)

The code still has the rules described above until these land; don't build against them early.

- Auto-cases only for customer-impacting events that need a human: half a class missed, a refund still failing after 72 h, a disputed plan-end choice. Internal signals stay on the ops list (#2563).
- A no-money make-up remedy from a case ("add N sessions" / "add up to 4 weeks"), logged and visible to both sides (#2563, #2561).
- A half-missed class holds only that class's unpaid host earnings (`SUPPORT_CASE` hold) until the case closes (#2563).
- Lean team (#2572): second-admin proposals, `assertNotOwnRemedy` and the payout maker-checker go; STAFF caps become ₹5,000 per payment and ₹30,000 per rolling 24 h. Multi-admin design: #2573.

## Gotchas

- The back-office inbox responds to its container, not the viewport: list/reader split at 60rem; Details docks only when the case workspace reaches 64rem. Keep admin health and monthly reports stacked in the expandable Support reports section; preserve URL filters on All cases and drafts across resizing. See [inbox layout](../../../docs/support/README.md#back-office-inbox-layout).

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

Auto-close polling uses Prisma `updateMany` on `autoCloseLastAttemptAt`, committed with eligibility and prior-attempt CAS before the closing transaction. Preserve `resolvedAt` and `updatedAt`; classify intentional recommendation/maintenance holds separately from genuine failures. The 16-second admission budget bounds this arm only, and `autoCloseHasMore` is conservative. Apply the reviewed column/index rollout before deploying readers; see [sweep contracts](../../../docs/support/07-sla-sweep.md#2-auto-close).

## Deprecated & Superseded Approaches

- The class-wide cancel listed as planned: it exists (`classSeries.money`) and now refuses while a seat's payment owes another refund.
- A losing refund door's `owed-already-held:` event read by nobody: it now holds the earnings and shows on the Refunds tab.
