---
title: Intake, flows and deflection
type: explanation
band: domain
audience: sde2
status: live
last-reviewed: 2026-11-12
---

# Intake, flows and deflection

A person can ask for help in four ways: from a booking ("Get help" on an appointment), from the platform help hub, through the formal request form, or through the public grievance form. All four end in the same place, one `SupportCase`, created or reused by `createOrReuseSupportCase()` in `lib/support/case-service.ts`. Before a case reaches a person, a guided **flow** (a small decision tree) tries to answer the question. When the flow solves it, the turn is counted as **deflected** and no operator clock starts. When it cannot, the case is **handed off** to a person: the channel becomes HUMAN, the clocks start, and staff are notified.

## Intake routes

```mermaid
flowchart TD
    A["Booking: Get help"] --> AT["POST /api/appointments/[id]/support (one guided turn)"]
    P["Help hub: platform topics"] --> PT["POST /api/support/platform (stateless guided turn)"]
    F["Formal request form"] --> CF["POST /api/support/cases"]
    G["Public grievance form"] --> GR["POST /api/contact (category grievance)"]
    S["Staff: message a user"] --> ST["POST /api/support/tickets (staff only)"]
    R["Staff: moderation report"] --> RC["POST /api/staff/moderation/reports/[id]/case"]
    AT --> W{"Flow walk: solved?"}
    PT --> W
    W -- "yes" --> D["Deflected: SupportFlowOutcome RESOLVED, no clocks"]
    W -- "no, or human asked" --> H["Hand-off: HUMAN, clocks start, staff bell"]
    H --> C["createOrReuseSupportCase"]
    CF --> C
    GR --> C
    ST --> C
    RC --> C
    C --> K{"Same retry key, or an open case in the same scope?"}
    K -- "retry key" --> RE["Return the same case"]
    K -- "open scope" --> AP["Append as a turn (follow-up on RESOLVED)"]
    K -- "neither" --> NW["New case, FAM reference allocated"]
```

| Route                                                | Who                                                   | What it does                                                                                                                                | Limits                                   |
| ---------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `POST /api/appointments/[appointmentId]/support`     | Booking participants, organization parties, operators | Advances the caller's appointment case by one turn through `runSupportTurn()` (`lib/support/service.ts`).                                   | 60 turns per hour (`supportTurnLimiter`) |
| `POST /api/support/platform`                         | Signed-in users                                       | Walks a platform flow without storing anything until a hand-off.                                                                            | 5 escalations per hour (`spamLimiter`)   |
| `POST /api/support/cases`                            | Signed-in users; staff with a wider schema            | The formal form. Validates ownership, membership, booking and payment links server-side.                                                    | 5 per hour for non-staff                 |
| `POST /api/contact` (grievance)                      | Anyone                                                | Creates a grievance case, owned by the account if signed in, otherwise by a system intake user with the stated name and email.              | 5 per hour per IP, a honeypot field      |
| `POST /api/support/tickets`                          | Staff (`tickets.manage`)                              | Opens an outbound case to a user (found by id or email) as a staff message.                                                                 | none                                     |
| `POST /api/staff/moderation/reports/[reportId]/case` | Staff (`tickets.manage`)                              | Opens a case for the reporter from a chat report (see [chat access](06-chat-access-and-intervention.md#opening-a-case-from-a-chat-report)). | none                                     |

There is no CAPTCHA on the public form. Intake keeps working in DEGRADED maintenance and stops only in OFFLINE maintenance, when the middleware answers every non-exempt API call with 503; money doors close separately ([money remedies](05-money-remedies.md)).

## Create or reuse

`createOrReuseSupportCase()` runs one transaction (default isolation, 8 s wait, 30 s timeout) and decides in this order:

1. **Retry.** A case with the same `(submitterUserId, clientIntakeId)` is returned as is (`dedupeReason: "client_intake_id"`). The database enforces it with `@@unique([submitterUserId, clientIntakeId])`.
2. **Open scope.** An open case (not closed, not deleted) with the same ownership scope, organization, scope key, requester, submitter and category receives the new description as a turn instead of creating a second case (`dedupeReason: "open_scope"`, or `"resolved_case"` when the matched case is RESOLVED). The scope key is `OCCURRENCE:<id>`, else `APPOINTMENT:<id>`, else the primary subject, else `ACCOUNT`. The database backstop is the partial unique index `support_case_open_scope_key`.
3. **Hand-off on reuse.** If the incoming intake asks for a person and the matched case is still self-service and not decided, the case is handed off (see below).
4. **New case.** Otherwise a FAM reference is allocated and the case, its first message and a CREATED event are inserted. Only a HUMAN intake gets clocks.

If two intakes race and one loses on a unique index, the loser re-reads the winner: a retry winner is returned, an open-scope winner gets the turn appended. A collision while re-scoping a case to another queue is 409 `OPEN_CASE_EXISTS`, naming the open case. The intake route answers 201 for a new case and 200 for a reused one, with `{ data, reused, dedupeReason }`.

## Guided flows

A flow is a tree of PROMPT and TERMINAL nodes. `walkFlow()` (`lib/support/flow-walk.ts`) is a pure function: it takes the cursor and the choice and returns the next node, any action to offer (for example "cancel with refund" or "reschedule"), and whether the terminal resolves or escalates. An unknown cursor fails safe to a hand-off.

**Appointment flows** (`lib/support/flows.ts`, keyed by `SupportThreadCategory`) are offered according to the booking's stage and the caller's role (`buildSupportContext()` in `lib/support/context.ts`): no-show (separate attendee and provider trees), cancel and refund, reschedule, payment status, recording access, quality complaint, technical, documents, sponsorship billing (organization context) and organization admin dispute (organization operators). **Safety concern** is offered to both sides at any stage; every branch escalates with an URGENT reason, and the copy tells a person in danger to call 112.

**Platform flows** (`lib/support/platform-flows.ts`) are stateless: payments and billing, account access, platform technical, organization operator billing, expert tax, and general. Expert tax is offered only to experts and covers TDS certificates and PAN mismatches; GST invoice problems arrive through payments and billing as `TAX_GST`. All three tax issue types land in the payments topic. A platform hand-off within 30 minutes of a matching open case appends to it instead of opening another.

**When a turn escalates.** In order (`decideEscalation()` in `lib/support/escalation.ts`, plus `runSupportTurn()`):

- the flow reaches an escalating terminal;
- the person types a human keyword (`human`, `agent`, `representative`, `complaint`, `legal`, `chargeback`, `fraud`, or "speak to someone") or picks "Talk to a person";
- the refund at stake (payment × the cancellation refund percentage) is at least ₹500 (50,000 paise), reason `high_value_refund`;
- the category has no flow (`no_flow`);
- a recording request for a session that ended more than 48 hours ago (`recording_missing`);
- two unrecognized replies in a row (`repeated_unrecognized`).

**Hand-off.** The escalation transaction checks the [transition table](02-case-lifecycle.md) as the customer, moves the case to ESCALATED and HUMAN, writes a brief for staff (the customer's ask, topic, flow path, what the bot said and promised, and the reason), sets the priority and issue type from the reason, starts the clocks, writes STATUS_CHANGED and CHANNEL_CHANGED, and stages the intake notifications. A guided turn never changes the channel, and nothing ever moves a case back from HUMAN.

**Priority and issue type.** `provider_no_show`, `double_charge` and `high_value_refund` are HIGH; the three safety reasons are URGENT; everything else is MEDIUM. A customer who marks the hand-off urgent gets at least HIGH, and the flag never lowers URGENT (`escalationPriority()` in `lib/support/priority.ts`). `issueTypeForReason()` maps each reason to a `SupportIssueType`; safety reasons map to `GENERAL_INQUIRY`, because the category carries the meaning.

**Organization billing.** When an organization operator's appointment escalation has reason `org_billing_dispute`, the case moves to the ORG_BILLING queue only if the filer holds `supportCases.billing.manage`; otherwise it stays with operations as a billing question (`escalationOwnershipTx()`). A platform operator-billing escalation files as ORG_BILLING for a billing manager and as PERSONAL otherwise.

## References and clocks

Every case gets a reference such as `FAM-2026-000123`: the IST year and a six-digit sequence, allocated by an upsert on `SupportCaseCounter` inside the case's transaction, so a rollback leaves no gap (`allocateTicketReference()` in `lib/support/reference.ts`).

Clocks start at the first hand-off to a person (`receivedAt`), never at a bot turn:

| Clock                  | Rule                                                                                                                                                                                                   | Where                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Acknowledgement target | URGENT 2 h, HIGH 8 h, MEDIUM and LOW 24 h. Never pauses.                                                                                                                                               | `slaDeadlinesFor()` in `lib/support/sla.ts`             |
| Resolution target      | URGENT 1 day, HIGH 3 days, MEDIUM and LOW 7 days. Pauses while waiting on the customer, but never past the statutory deadline. A reopen restarts it (see below).                                       | `effectiveResolutionDueAt()`                            |
| Statutory deadline     | Captured at receipt and never paused: 7 days for general and grievance cases (policy `IN-2026-02:GENERAL` or `:GRIEVANCE`); the content-removal policies (36 h, 2 h, 3 h) apply to moderation reports. | `supportDeadline()` in `lib/support/deadline-policy.ts` |

**A reopen restarts the resolution clock.** When a resolved human case is reopened, whether by the customer's explicit request or by staff moving it back to an active status, the resolution target is set again from the reopen time at the case's current priority (`reopenedClockPatch()` in `lib/support/sla.ts`, applied by `advanceUserTurnState()` and `buildLifecycleUpdateData()` in `lib/support/case-service.ts`). The customer-wait time banked against the old target (`pausedSeconds`) is reset to zero. The acknowledgement target is left alone, because acknowledgement means the first public agent reply and the case already has one. The statutory deadline keeps its original date, because it is a promise made at receipt. Example: Priya's HIGH case `FAM-2026-000123` is resolved on Thu 12 Nov 2026 at 10:00 IST and she reopens it on Fri 20 Nov 2026 at 09:00 IST. The new resolution target is Mon 23 Nov 2026 at 09:00 IST (3 days later), whatever the old target was. A statutory deadline of Thu 19 Nov 2026 stays as it was and is already breached.

Raising the priority tightens the internal targets and never extends them. An automated receipt does not count as a human acknowledgement. Breach state is computed on read, never stored. The monthly compliance report counts human cases by IST month of receipt, acknowledgement within 24 hours and resolution by the statutory deadline (`supportMonthlyComplianceReport()`).

## Public grievances

A grievance from someone without an account is owned by the system user `system-public-grievance-intake` and keeps the stated name and email in `externalRequesterName` and `externalRequesterEmail`. It is HIGH priority, has the 7-day grievance deadline, and its scope key is unique per case, so grievances are never merged. The receipt email carries only the reference and a confirmation link. `GET /api/support/external-verify` renders a form and only its `POST` confirms the address, so a mail scanner's prefetch cannot confirm it. The link lasts 7 days. Until the address is confirmed, staff emails carry only the reference; on confirmation, confirmation stages both a copy of the complaint as recorded and a digest of the withheld replies and decisions, in no promised delivery order (`lib/support/external-requester.ts`). The copy is never sent before confirmation, so the form cannot be used to mail text to an address nobody has confirmed.

## Deflection and helpfulness

Each terminal turn writes one `SupportFlowOutcome` row (scope APPOINTMENT or PLATFORM, flow key, terminal, reason, RESOLVED or ESCALATED), after commit and never inside the turn, so a failed analytics write cannot roll back help (`recordFlowOutcome()` in `lib/support/deflection.ts`). The deflection rate is resolved ÷ (resolved + escalated); the seven-day re-contact rate shows whether "resolved" people came back. `supportHealthMetrics()` adds CSAT, acknowledgement within 24 hours, resolution within deadline and median first reply, served at `app/api/admin/support/health/route.ts`.

After a self-service answer, the person may rate it 1–5 once (`POST /api/support/flow-outcomes/[id]/rating`, a compare-and-set on `helpfulRating IS NULL`). Nothing aggregates `helpfulRating` yet, and the route does not restrict ratings to RESOLVED outcomes.

## Worked example

Priya Anderson opens "Get help" on Hannah Anderson's consultation, booked for Mon 10:00 IST and paid ₹1,180 (118,000 paise), at Mon 10:20 IST.

1. **10:20.** Priya picks "No-show". The service creates her appointment case (SELF_SERVE, reference `FAM-2026-000123`, no clocks) and presents the no-show tree.
2. **10:21.** She picks "The expert didn't join". The terminal `provider_no_show` escalates. The case becomes ESCALATED and HUMAN, priority HIGH, issue type `CONSULTANT_NO_SHOW`. `receivedAt` is 10:21, the acknowledgement target is 18:21 IST (8 h), the resolution target Thu 10:21 IST (3 days), and the statutory deadline next Mon 10:21 IST (7 days). Staff get a bell; Priya gets "Request received".
3. **10:24.** Priya's browser retries the same turn. The `clientTurnId` matches, so the stored turn is replayed and nothing is written twice.
4. **10:30.** Priya also fills in the formal form about the same booking. Same scope, same category: her text is appended to `FAM-2026-000123` and the form answers 200 with `dedupeReason: "open_scope"`.

What if the bot had answered and she had not needed a person? The case would stay SELF_SERVE with no clocks, a RESOLVED outcome row would count toward deflection, and she could rate the answer.

## Where in code

- `lib/support/service.ts` (`runSupportTurn()`, the escalation transaction, `escalationOwnershipTx()`), `lib/support/flows.ts`, `lib/support/platform-flows.ts`, `lib/support/flow-walk.ts`, `lib/support/escalation.ts`, `lib/support/priority.ts`, `lib/support/context.ts`.
- `lib/support/case-service.ts` (`createOrReuseSupportCase()`, `appendOpenScopeTurn()`), `lib/support/create-ticket.ts`, `lib/support/reference.ts`, `lib/support/sla.ts`, `lib/support/deadline-policy.ts`, `lib/support/external-requester.ts`, `lib/support/deflection.ts`.
- `app/api/appointments/[appointmentId]/support/route.ts`, `app/api/support/platform/route.ts`, `app/api/support/cases/route.ts`, `app/api/contact/route.ts`, `app/api/support/external-verify/route.ts`, `app/api/support/flow-outcomes/[id]/rating/route.ts`.

The appointment thread GET retains the guided prompt metadata (`nodeId` and
`options`) when restoring a conversation. It returns presenter attribution
separately and strips other message metadata from this projection.

## Deprecated & Superseded Approaches

- **Separate tickets and appointment threads.** Platform requests were `SupportTicket` rows and booking help was an `AppointmentSupportThread`, each with its own reference series and status. Both now create or reuse one `SupportCase`. The old words survive in identifiers (`createSupportTicket()`, `supportTicketId` in responses, `SupportThreadCategory`).
- **Channel downgrade on a new intent.** Starting a new guided topic on a resolved human case used to drop it back to SELF_SERVE. A new topic now starts a new case, and the channel never leaves HUMAN.
- **A universal 15-day clock with customer-wait extensions.** Replaced by fixed category deadlines captured at receipt and internal targets that can pause but never pass them.
- **Callback markers in text.** Callback requests were once written into the description as `[Callback Requested: …]`. They are structured columns (`callbackPhone`, `callbackWindow`); code only strips or reads old markers.
- **Session-scoped issue types on the platform form.** `SESSION_SCOPED_ISSUE_TYPES` in `lib/support/create-ticket.ts` once kept booking-only types off the platform form. No route enforces it now; it is referenced only by tests.
- **Intake closed during maintenance while money stayed open.** Appointment-help intake was once blocked by the maintenance freeze while case refunds and holds were not, the reverse of what is safe. Intake now stays open in DEGRADED maintenance, and the money doors check maintenance themselves.
- **Grievances mailed to an unverified address and owned by a staff account.** A public grievance used to email staff replies to whatever address was typed, even for signed-in users, and anonymous grievances were owned by the oldest staff user. Signed-in grievances now belong to the account, anonymous ones to a dedicated system user, and staff text waits for address confirmation.
