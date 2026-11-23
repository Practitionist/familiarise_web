---
title: Support decision records
type: explanation
band: domain
audience: sde2
status: live
last-reviewed: 2026-11-24
---

# Support decision records

These are short records of the owner decisions that shaped the support system: the context, what was decided, what it costs, and what was rejected. They explain why the code looks the way it does; the reference pages say what it does. Each record names the page where the decision lives today. Work that was decided but not built is labelled **planned (P2)**, using the priority scale in #2293.

## SD-1: One canonical case for every support conversation

- **Status:** Accepted, implemented.
- **Context.** Support was split between `SupportTicket` rows for platform help and `AppointmentSupportThread` rows for booking help, with mirrored statuses, two reference series and two queues. Production data was disposable mock data.
- **Decision.** Every request is one `SupportCase` that owns its transcript, clocks, reference and CSAT. Booking, payment, account and organization entry points all create or reuse a case through `createOrReuseSupportCase()`. The old tables, aliases and import paths were dropped rather than migrated.
- **Consequences.** One queue, one lifecycle, one reference series. Old names survive in identifiers and have to be read as "case". The drop broke deployed code that still queried the old tables until the end-phase fix.
- **Rejected.** A dual-read period with a cutover flag (banned by AGENTS.md §1.2 and unnecessary with disposable data).
- **See** [intake](01-intake-and-flows.md), [lifecycle](02-case-lifecycle.md).

## SD-2: The case deliberates, the owning domain executes

- **Status:** Accepted, implemented for refunds, holds, platform cancel and platform reschedule; typed remedies are planned (P2).
- **Context.** The first case system reached its side effects through three different door shapes, some of which skipped controls the admin money doors already had: budgets, maintenance gates, ops-log rows, second approval.
- **Decision.** A case gathers context, evidence and the decision. Anything that changes another domain goes through that domain's audited door, built with `withOpsAction()`: step-up, a reason, one ops-log row, the domain's own guards. The case never writes another domain's tables, and the result comes back onto the case timeline.
- **Consequences.** Support inherits every money guard for free, and an audit question is answered from one ops log. Remedies that have no door yet (make-up sessions, video pro-rata refunds, typed `booking.reschedule` remedies) are done with the normal booking tools.
- **Planned (P2).** A `CaseAction` registry and `SupportRemedy` rows with an execution intent.
- **See** [money remedies](05-money-remedies.md).

## SD-3: Staff execute bounded refunds; admins and a second admin above the bounds

- **Status:** Accepted, implemented.
- **Context.** Admin-only execution made every small goodwill refund a queue for admins, while the ₹25,000 second-admin rule could be split across recommendations and the author could approve their own.
- **Decision.** STAFF may send up to ₹5,000 per payment, counted across every live refund and approved remedy on it, and up to ₹50,000 in any rolling 24 hours, summed from their own ops-log rows and serialized by a per-staff lock. ADMIN goes above that. Above ₹25,000 per payment, priced cumulatively, a second admin approves when two or more admins exist. The author of a recommendation cannot approve it. Platform cancels by staff count toward the same caps.
- **Consequences.** Most refunds need no admin. The caps are app-enforced; a gateway door whose ops-log write fails after money moved is reported to Sentry but not counted. The platform cancel door has no second approver. Since 2026-11-12 a credit restoration counts at its credit value and the refund door keeps the staff lock on an unknown outcome; see [the money doors decision record](../decisions/2026-11-12-bug-hunt-money-doors.md).
- **See** [money remedies](05-money-remedies.md#staff-caps-across-every-refund-door).

## SD-4: Payout holds use the shared `EarningsHold`, not a support table

- **Status:** Accepted, implemented.
- **Context.** `SupportPaymentHold` duplicated `EarningsHold`, the single writer of the HELD earning status, with no ops log, no budget and no release. Payouts stayed stuck while dashboards showed the money as ready.
- **Decision.** A support hold is `EarningsHold` rows with reason `SUPPORT_CASE` and the case id as source, placed and released through ops doors behind step-up and the maintenance gate, and released automatically when the case resolves or closes. A staff resolve or close needs step-up and open money doors; the 28-day auto-close releases as the system with no step-up, and still waits for open money doors and no open recommendation.
- **Consequences.** Payout batching ignores held earnings with no support-specific code. Releasing a support hold never releases a chargeback hold. A hold applied after resolution is released by the 28-day auto-close, as the system.
- **See** [money remedies](05-money-remedies.md#payout-holds).

## SD-5: Decisions are terminal; corrections supersede; appeals are independent

- **Status:** Accepted, implemented (owner decision, 2026-10-22).
- **Context.** Decided cases reopened on any reply, which bypassed the appeal; repeating DECIDE reset the seven-day appeal clock.
- **Decision.** The first decision resolves the case and opens a seven-day appeal window. A second plain decision is refused. An admin may supersede the decision in force only before its deadline and before anyone appeals; the new row keeps the original deadline. An appeal is a separate case reviewed by someone other than the original decider. Staff cannot reopen a decided case.
- **Consequences.** The database guards it: decisions are immutable and a case has one original decision. After the window, the only correction is an internal note.
- **See** [decisions](03-decisions-appeals-and-supersede.md).

## SD-6: Replies never reopen; only an explicit "This didn't fix it" does

- **Status:** Accepted, implemented.
- **Context.** Implicit reopen on any reply produced surprise reopens and unhandled collisions with the open-case index.
- **Decision.** A reply to a RESOLVED case is a follow-up. The requester or submitter may reopen an undecided case within 14 days with an explicit request. A matching intake on a RESOLVED case appends a follow-up. A new topic on a resolved human case starts a new case.
- **Consequences.** Customer copy (the RESOLVED email and the resolve saved replies) says a reply won't reopen the request and points to "This didn't fix it" or an appeal.
- **See** [lifecycle](02-case-lifecycle.md#resolve-reopen-and-close).

## SD-7: The channel never downgrades

- **Status:** Accepted, implemented.
- **Decision.** Once a case reaches a person it stays HUMAN. Every hand-off writes CHANNEL_CHANGED and, when the status moves, STATUS_CHANGED. No database trigger was added; no writer sets any other value.
- **Rejected.** Letting a resolved human case drop back to self-service, which removed it from queues and from the monthly compliance report.
- **See** [lifecycle](02-case-lifecycle.md).

## SD-8: The problem cascade is a bounded sweep arm

- **Status:** Accepted, implemented.
- **Context.** Resolving a problem resolved every incident in one long transaction, with notices staged after commit, and deciding a problem broadcast its explanation to other customers.
- **Decision.** Resolving a problem touches only the problem. A sweep arm resolves up to 10 incidents per run, each in its own transaction with its notices staged inside it. Problems cannot be decided, and incidents cannot be linked to a resolved problem.
- **See** [SLA sweep](07-sla-sweep.md#3-problem-to-incident-cascade).

## SD-9: Retries replay only when the details match

- **Status:** Accepted, implemented.
- **Decision.** A retried evidence request, recommendation or decision with the same `clientActionId` replays the stored row only if the stored columns match; otherwise 409 `IDEMPOTENCY_KEY_REUSED`. No fingerprint column was added.
- **See** [decisions](03-decisions-appeals-and-supersede.md).

## SD-10: Tax issue types and organization billing routing

- **Status:** Accepted, implemented.
- **Decision.** `TAX_GST`, `TDS_CERTIFICATE` and `PAN_CARD_MISMATCH` land in the payments topic; experts get an expert-tax flow. An organization billing dispute escalates to ORG_BILLING when the filer manages billing, and otherwise stays with operations as a billing question, instead of dead-ending at the chargeback page.
- **See** [intake](01-intake-and-flows.md#guided-flows).

## SD-11: A 180-day evidence purge with legal and derived holds

- **Status:** Accepted, implemented.
- **Context.** The privacy copy promised deletion that no job performed.
- **Decision.** A sweep arm deletes files and scrubs free text 180 days after the latest close of a case and its appeals, one transaction per case under a row lock with verified deletes. It keeps the case skeleton, decisions and money links. An admin legal hold blocks it, as do a live chargeback on a linked payment and an open or recent appeal.
- **Consequences.** This deviates from the recorded plan to purge in storage reconciliation; the owner approved the change. The kept-records split and the period carry counsel sign-off notes.
- **See** [privacy and retention](08-privacy-and-retention.md).

## SD-12: A database race tier that can only run against a disposable database

- **Status:** Accepted, implemented.
- **Decision.** `*.db.test.ts` files run under `jest.db.config.ts` in the CI `db-guards` job only, behind a guard that refuses anything but a local `/ci` database with `CI=true`. The broken raw-SQL concurrency script was retired.
- **See** [schema and invariants](11-schema-and-invariants.md#how-to-verify).

## SD-13: Expected refusals are plain 409s with no Sentry event

- **Status:** Accepted, implemented.
- **Decision.** Lifecycle refusals return `{ error, code, ...detail }` with their status and never reach Sentry; unexpected failures go through `supportError()`.
- **See** [lifecycle](02-case-lifecycle.md#errors-and-sentry).

## SD-14: Staff read chats only through case-linked, audited, time-boxed grants

- **Status:** Accepted, implemented (#2343).
- **Context.** Operators held Stream global admin and could mint tokens for any user, so chat reads were silent and contradicted the privacy copy. That was fixed first; staff still needed a sanctioned way to read a chat for a case.
- **Decision.** Only open human cases with a linked booking qualify. A READ grant lasts 24 hours; an INTERVENE grant lasts 24, 72 or 168 hours (default 72) and needs an overdue-evidence, safety or fraud basis, either verified or asserted with a reason. DM grants cover both members from seven days before the booking; group grants cover the reporter and picked targets. Every grant is an append-only access-log row with an ops-log reason, organization audit rows without content, and a `SystemEvent` per transcript page. Familiarise Support joins visibly, posts through an audited route, and leaves at resolution; parties are told after the decision unless telling would create risk. A moderation report never unlocks a chat; staff open a case from it first.
- **Planned (P2).** Privileged-access approval tiers and recording dual control.
- **See** [chat access](06-chat-access-and-intervention.md).

## SD-15: Organization access follows current membership, never a tag

- **Status:** Accepted, implemented.
- **Decision.** Personal cases are private to their submitter and operators, however the booking is tagged. Organization cases belong to whoever currently holds the matching organization permission. Organization views show metadata and withhold sensitive personal complaints as counts.
- **See** [scopes and visibility](09-org-scopes-and-visibility.md).

## SD-16: A no-show report is a typed case on its session

- **Status:** Accepted 2026-11-24, implemented (steps 1 to 3 of the report-window build).
- **Context.** A negative session verdict (`HOST_ABSENT`, `CUT_SHORT`, `LEARNER_ABSENT`) waits 48 hours for strong evidence before it is confirmed, and a participant's report may speed it up or block it. That needs a report a job can read, not a conversation.
- **Decision.** The no-show turn files its own `SupportCase` on the scope `OCCURRENCE:<id>`, stores the flow terminal's reason in `SupportCase.flowReason` (a counted reason is never replaced), offers "I was there" to both sides, and counts a report from the session's booked end to 48 hours after the verdict. No second report table.
- **Cost.** One nullable column and one index, and a no-show conversation no longer shares the booking's open thread. A report changes only whether a verdict is confirmed; it cannot create one.
- **See** [intake and flows](01-intake-and-flows.md#a-no-show-report) and [the report-window record](../decisions/2026-11-23-session-outcome-report-window.md).

## Planned work (P2)

Recorded in #2270 and not built: the `CaseAction` registry and `SupportRemedy`; privileged-access tiers and recording dual control; in-chat resolution offers; Stream moderation v2; video pro-rata refunds, make-up sessions and call-quality stats; `ServiceDisruption` and `PlatformIncident` linkage to problem cases; a customer-health panel and repeat-contact detection; audio and video evidence; full renames (ticket to case, "dispute" to service complaint); console ergonomics and a money overview. Referrals and trials have no support integration yet; adding them is proposed for P2.

## Deprecated & Superseded Approaches

These records replace the decision log kept outside the repository during the support build-out. Earlier proposals that were not adopted: participants-only chat excerpts with no staff reading (replaced by SD-14), purging inside storage reconciliation (replaced by SD-11), and a separate support hold table (replaced by SD-4).
