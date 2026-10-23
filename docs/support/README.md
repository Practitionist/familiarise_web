---
title: Support system
type: reference
band: index
audience: sde2
status: live
last-reviewed: 2026-10-23
---

# Support system

Support is how a person gets help with a booking, a payment, their account or their organization, and how the platform investigates, decides and puts things right. Every request is one `SupportCase`. A guided flow tries to answer first; when it cannot, a person takes over. The case **deliberates** (it gathers context, asks the other party for evidence, and records an immutable decision that can be appealed) and the **owning domain executes** (refunds, payout holds and booking changes go through that domain's audited doors).

Start with the one-page design in [`docs/start-here/05-support-system-design.md`](../start-here/05-support-system-design.md) for the big picture, the cross-domain integration map and worked examples. The pages below are the detailed reference for engineers changing one part.

## Pages

| #   | Page                                                                      | Type        | Answers                                                                                       |
| --- | ------------------------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------- |
| 01  | [Intake, flows and deflection](01-intake-and-flows.md)                    | explanation | How does a request become a case, and when does a person take over?                           |
| 02  | [Case lifecycle and the transition table](02-case-lifecycle.md)           | reference   | Which status moves are allowed, by whom, and how are messages written safely?                 |
| 03  | [Decisions, appeals and supersede](03-decisions-appeals-and-supersede.md) | reference   | What does a decision do, how is it corrected, and how does an appeal work?                    |
| 04  | [Evidence requests and attachments](04-evidence-and-attachments.md)       | reference   | How do staff ask the other party, and how are files checked and served?                       |
| 05  | [Money remedies](05-money-remedies.md)                                    | reference   | How do recommendations become refunds, what are the staff caps, and how do payout holds work? |
| 06  | [Chat access and intervention](06-chat-access-and-intervention.md)        | reference   | When may staff read a booking chat or join it as Familiarise Support?                         |
| 07  | [The SLA sweep and its arms](07-sla-sweep.md)                             | reference   | What does the background job do every 30 minutes?                                             |
| 08  | [Privacy and retention](08-privacy-and-retention.md)                      | reference   | What do export, erasure, the 180-day purge and legal hold guarantee?                          |
| 09  | [Organization scopes and visibility](09-org-scopes-and-visibility.md)     | reference   | Who can see which case, and how does support sit beside feedback and reviews?                 |
| 10  | [Notifications](10-notifications.md)                                      | reference   | What is sent, to whom, and how is it kept exactly-once?                                       |
| 11  | [Schema and invariants](11-schema-and-invariants.md)                      | reference   | Every table and every invariant, with the enforcer behind it.                                 |
| 12  | [Runbooks](12-runbooks.md)                                                | how-to      | Stuck refund, failed purge, stuck intervention seat, legal hold, sweep re-run, DDL end-phase. |
| 13  | [Decision records](13-decision-records.md)                                | explanation | Why is it built this way?                                                                     |

Agents should read [`.claude/skills/support/SKILL.md`](../../.claude/skills/support/SKILL.md) for the terse rules.

## Module map

| Concern                    | Main code                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Intake and guided flows    | `lib/support/service.ts`, `lib/support/flows.ts`, `lib/support/platform-flows.ts`, `lib/support/flow-walk.ts`, `lib/support/escalation.ts`                                             |
| Case service and lifecycle | `lib/support/case-service.ts`, `lib/support/case-transitions.ts`, `lib/support/sla.ts`, `lib/support/deadline-policy.ts`                                                               |
| Decisions, evidence, money | `lib/support/case-actions.ts`, `lib/support/refund-door.ts`, `lib/support/case-doors.ts`, `lib/support/money-policy.ts`, `lib/support/case-holds.ts`, `lib/support/appeal-reversal.ts` |
| Access and visibility      | `lib/support/case-access.ts`, `lib/support/evidence-scope.ts`                                                                                                                          |
| Attachments                | `lib/support/attachment-policy.ts`, `lib/support/case-attachments.ts`                                                                                                                  |
| Background job             | `lib/support/sla-sweep.ts`, `lib/support/problem-cascade.ts`, `lib/support/evidence-retention.ts`                                                                                      |
| Privacy                    | `lib/support/privacy-export.ts`, `lib/support/erasure.ts`                                                                                                                              |
| Chat access                | `lib/support/chat-access.ts`, `lib/support/chat-doors.ts`, `lib/support/chat-sweep.ts`, `lib/stream/support-intervention.ts` (intervention branch)                                     |
| Routes                     | `app/api/support/**`, `app/api/appointments/[appointmentId]/support/route.ts`, `app/api/staff/appointments/[appointmentId]/cancel/route.ts`                                            |
| Schema                     | `prisma/schema.prisma` (`SupportCase*`, `SupportFinancialRecommendation`, `SupportFlowOutcome`), `prisma/sql/check-constraints.sql`                                                    |
| Tests                      | `__tests__/support/`, `__tests__/db/support/`, `__tests__/backoffice/support-*`, `__tests__/compliance/support-*`                                                                      |

## Status vocabulary

Pages mark behaviour that is not on `dev` as **planned** with a priority from the support tracker (#2293): **P0** live breakage, a security hole or data loss now; **P1** a launch blocker; **P2** within about 30 days after launch (#2270); **P3** backlog; **P4** deferred by decision. Content from the `feat/support-chat-intervention` and `fix/platform-reschedule-door` branches is described as current because both merge before these docs.

## Deprecated & Superseded Approaches

The previous `docs/support/` set described separate tickets and appointment threads, a single production-architecture page and a short schema page. Those pages were replaced by this set, and links elsewhere in the docs were repointed to the new pages. Separate ticket and thread tables, import aliases and legacy API stubs were removed in the pre-MVP cleanup, and canonical cases are seeded directly.
